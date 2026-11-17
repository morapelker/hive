// "Move projects": bringing the projects that still sit in a folder used before over to the dev
// folder, one project per call.
//
// One rule decides which projects are offered, and the count on the Settings row, the plan the
// dialog shows and the move itself all apply it. A plan can be minutes old by the time one of
// its projects is moved, so the move reads everything again.
//
// Pure orchestration over the ports in ./types: nothing here touches the filesystem, git or the
// database itself, so the order of the steps can be pinned down with in-memory fakes. The order
// is the feature. A folder, its database rows, git's worktree links and the state other tools
// key by path have to change place without a moment in which one of them is read pointing at
// the wrong place, and without a failure half way leaving the person's work somewhere the app
// does not know about.
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type {
  DevFolderMoveCandidate,
  DevFolderMovePlan,
  DevFolderMoveResult,
  DevFolderMoveSkipReason,
  MoveProjectToDevFolderParams
} from '../../../shared/types/dev-folder'
import type { Project, Worktree } from '../../db/types'
import type {
  BusyProbe,
  LeftoverSource,
  LinkedWorktree,
  MovedProject,
  MoveProjectsDeps,
  PathMove,
  PendingDevFolderMove,
  PreparedMove,
  RelocateProjectResult,
  RelocationMove
} from './types'

/** How many `git worktree list` calls a plan has running at once. */
const PLAN_GIT_CONCURRENCY = 8

/** A path made only of these characters means the same to a shell with or without quotes. */
const SHELL_SAFE_PATH = /^[A-Za-z0-9_./~+:@%,=-]+$/

// ── Small helpers ───────────────────────────────────────────────────────────────────────

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/** The spelling the database holds first, then the real path when that is another spelling. */
const spellingsOf = (path: string, realPath: string | null): string[] =>
  realPath !== null && realPath !== path ? [path, realPath] : [path]

/** The part of `path` below `folder` when it is strictly inside it (by spelling), else null. */
const pathBelow = (folder: string, path: string): string | null => {
  const prefix = folder.endsWith(sep) ? folder : folder + sep
  return path.length > prefix.length && path.startsWith(prefix) ? path.slice(prefix.length) : null
}

const isAtOrBelow = (folders: readonly string[], path: string): boolean =>
  folders.some((folder) => path === folder || pathBelow(folder, path) !== null)

/** What went wrong, worded to sit in the middle of a sentence: no full stop at the end. */
const reasonOf = (error: unknown): string => {
  let text = ''
  try {
    text = (error instanceof Error ? error.message : String(error)).trim().replace(/\.+$/, '')
  } catch {
    // A thrown value that cannot even be printed.
  }
  return text.length > 0 ? text : 'an unknown error'
}

const shellQuote = (value: string): string =>
  SHELL_SAFE_PATH.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** A log that fails must not change what a move reports. */
const note = (
  deps: Pick<MoveProjectsDeps, 'log'>,
  message: string,
  detail?: Record<string, unknown>
): void => {
  try {
    deps.log?.(message, detail)
  } catch {
    // Nothing to do about a logger that throws.
  }
}

/** Compute once, on first use; a computation that throws is tried again on the next use. */
const once = <T>(compute: () => T): (() => T) => {
  let held: { readonly value: T } | null = null
  return () => {
    if (held === null) held = { value: compute() }
    return held.value
  }
}

/** Run `task` over `items`, at most `limit` at a time. `task` must not reject. */
const forEachLimited = async <T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> => {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

// ── What the dialog says ────────────────────────────────────────────────────────────────
// Every sentence here is read by the person who pressed "Move projects": what is the case, and
// what they can do about it. "Check again" is the dialog's button that makes a fresh plan.

interface Skip {
  readonly reason: DevFolderMoveSkipReason
  readonly detail: string
}

const unsupported = (detail: string): Skip => ({ reason: 'unsupported', detail })

const PROJECT_GONE: Skip = {
  reason: 'not-in-source',
  detail: 'This project is no longer in the app. Check again.'
}
const NOT_IN_SOURCE: Skip = {
  reason: 'not-in-source',
  detail: 'This project is no longer in a folder that projects are moved from. Check again.'
}
const DEV_FOLDER_CHANGED: Skip = {
  reason: 'not-in-source',
  detail: 'The dev folder changed since this list was made. Check again.'
}
const PROJECT_CHANGED: Skip = {
  reason: 'not-in-source',
  detail: 'This project changed while its move was being prepared. Check again.'
}
const GIT_LIST_FAILED = unsupported(
  "Git could not list this repository's worktrees, so moving it is not safe. Run git worktree list in the project to see what is wrong, then check again."
)
const BUSY_UNKNOWN = 'Could not check whether something is running in this project. Check again.'

const uncheckable = (error: unknown): Skip =>
  unsupported(`This project could not be checked: ${reasonOf(error)}. Check again.`)

const folderExists = (toPath: string): Skip => ({
  reason: 'exists',
  detail: `The dev folder already has a folder named ${basename(toPath)}. Rename or move one of the two, then check again.`
})

const projectExists = (toPath: string): Skip => ({
  reason: 'exists',
  detail: `Another project is already registered at ${toPath}. Remove that project first, then check again.`
})

const gitBusy = (operation: string): string =>
  `${capitalise(operation)} is in progress in this project. Finish it or wait for it to end, then check again.`

/** Every failure before the database is repointed ends with the folder where it was. */
const notMoved = (error: unknown): string =>
  `This project was not moved: ${reasonOf(error)}. It is still in its old folder.`

const notMovedAndStuck = (error: unknown, stuck: readonly string[]): string =>
  `This project was not moved: ${reasonOf(error)}, and the folder could not be put back: ${stuck.join('; ')}.`

const linksNotRepaired = (toPath: string, paths: readonly string[], why: string | null): string => {
  const one = paths.length === 1
  return (
    `Git could not re-link ${one ? 'this worktree' : 'these worktrees'} to the project's new folder` +
    `${why === null ? '' : ` (${why})`}: ${paths.join(', ')}. ` +
    `Run this in a terminal to fix ${one ? 'it' : 'them'}: ` +
    `git -C ${shellQuote(toPath)} worktree repair ${paths.map(shellQuote).join(' ')}`
  )
}

/** A worktree git keeps although its folder is away (it is locked): nothing could be written into it. */
const worktreeAway = (toPath: string, path: string): string =>
  `The worktree at ${path} was not on disk, so its link to the project was not updated. ` +
  `When it is back, run: git -C ${shellQuote(toPath)} worktree repair ${shellQuote(path)}`

const linksUnknown = (toPath: string): string =>
  `Git could not list the worktrees of the project in its new folder, so their links were not checked. ` +
  `Run this in a terminal to fix them: git -C ${shellQuote(toPath)} worktree repair`

const syncFailed = (why: string | undefined): string =>
  `The project's worktree list could not be brought up to date after the move` +
  `${why ? `: ${why.trim().replace(/\.+$/, '')}` : ''}. Restart the app to try again.`

const relocatedFailed = (error: unknown): string =>
  `Connection folders, the board or the port of this project may still point at the old folder: ${reasonOf(error)}. Restart the app if one of them looks wrong.`

/** What the filesystem says about an old copy it kept, to sit in brackets inside a sentence. */
const leftoverDetail = (left: LeftoverSource): string => {
  const detail = left.detail ? left.detail.trim().replace(/\.+$/, '') : ''
  return detail.length > 0 ? ` (${detail})` : ''
}

const leftoverSentence = (left: LeftoverSource): string => {
  if (left.reason === 'failed') {
    return `The old copy is still at ${left.path}: it could not be removed${leftoverDetail(left)}. Delete it yourself.`
  }
  // The filesystem says either where the old copy changed, or why the two could not be compared.
  const detail = left.detail ? left.detail.trim().replace(/\.+$/, '') : ''
  if (detail.length > 0 && !detail.startsWith('what changed')) {
    return `The old copy is still at ${left.path}: it was kept because ${detail}. Compare it with the new one before deleting it.`
  }
  return `The old copy is still at ${left.path}: it changed while the project was being moved${leftoverDetail(left)}, compare it with the new one before deleting it.`
}

const owedUnreachable = (name: string, toPath: string): Skip => ({
  reason: 'busy',
  detail: `The move of ${name} was interrupted and its folder ${toPath} cannot be reached now. Reconnect the disk that holds it, or remove ${name} from Hive, then check again.`
})

const owedUnfinished = (name: string): Skip => ({
  reason: 'busy',
  detail: `The move of ${name} was interrupted and could not be finished yet. Restart Hive, then check again.`
})

/** `nowAt` is where the folder that was copied is now: the project, or a worktree that sat next to it. */
const oldCopyLeft = (name: string, path: string, nowAt: string, isCheckout: boolean): string =>
  isCheckout
    ? `An old copy of ${name} is still at ${path}: Hive quit before it was removed. The project is at ${nowAt} now. Compare the two, then delete the old copy yourself.`
    : `An old copy of the worktree ${basename(nowAt)} of ${name} is still at ${path}: Hive quit before it was removed. The worktree is at ${nowAt} now. Compare the two, then delete the old copy yourself.`

// ── Which projects are offered (the plan, the count and the move share this) ─────────────

/** One reading of the folders, shared by every project looked at in a plan, a count or a move. */
interface MoveContext {
  readonly db: MoveProjectsDeps['db']
  readonly fs: MoveProjectsDeps['fs']
  readonly devFolder: string
  readonly previousFolders: readonly string[]
  /**
   * The dev folder as paths under it are stored: its real path, or its resolved spelling while
   * it is not on disk.
   */
  readonly devRoot: () => string
  /** Every spelling the dev folder is known by, to tell whether it lies inside a project. */
  readonly devSpellings: () => readonly string[]
  /**
   * Parent folder of a project → the folder used before that it is (null: none, or the dev
   * folder itself). Hundreds of projects share a handful of parents.
   */
  readonly sourceByParent: Map<string, string | null>
}

/**
 * The real path of a folder that may not exist yet: the real path of its nearest ancestor that
 * does, plus the rest. A dev folder still to be created can lie inside a project through a
 * symlink above it.
 */
const nearestRealPath = (fs: MoveProjectsDeps['fs'], path: string): string => {
  const rest: string[] = []
  let current = path
  for (;;) {
    const real = fs.canonical(current)
    if (real !== null) return join(real, ...rest)
    const parent = dirname(current)
    if (parent === current) return path
    rest.unshift(basename(current))
    current = parent
  }
}

const moveContext = (deps: Pick<MoveProjectsDeps, 'db' | 'fs' | 'folders'>): MoveContext => {
  const { devFolder, previousFolders } = deps.folders()
  const resolved = resolve(devFolder)
  const devRoot = once(() => deps.fs.canonical(devFolder) ?? resolved)
  return {
    db: deps.db,
    fs: deps.fs,
    devFolder,
    previousFolders,
    devRoot,
    devSpellings: once(() => unique([resolved, devRoot(), nearestRealPath(deps.fs, resolved)])),
    sourceByParent: new Map()
  }
}

/** The folder used before that `parent` is, or null when it is none of them or the dev folder. */
const sourceOf = (parent: string, context: MoveContext): string | null => {
  const known = context.sourceByParent.get(parent)
  if (known !== undefined) return known
  const { fs } = context
  const source = fs.sameFolder(parent, context.devFolder)
    ? null
    : (context.previousFolders.find((previous) => fs.sameFolder(parent, previous)) ?? null)
  context.sourceByParent.set(parent, source)
  return source
}

/** Where a project that is offered sits, and where it would go. */
interface Located {
  readonly source: string
  readonly toPath: string
}

/**
 * A project is offered when its folder is a direct child of a folder used before. Rows decide,
 * never a directory listing: a folder in the old place that is not a project is not ours to move.
 */
const locate = (project: Project, context: MoveContext): Located | null => {
  if (project.kind === 'connection') return null
  const path = project.path
  if (!isAbsolute(path)) return null
  const name = basename(path)
  const parent = dirname(path)
  if (name.length === 0 || parent === path) return null
  const source = sourceOf(parent, context)
  if (source === null) return null
  return { source, toPath: join(context.devRoot(), name) }
}

/** Why an offered project stays where it is, from what is on disk and in the database alone. */
const staticSkip = (project: Project, toPath: string, context: MoveContext): Skip | null => {
  const { db, fs } = context
  const path = project.path

  const kind = fs.kind(path)
  if (kind === null) {
    return { reason: 'missing', detail: 'Its folder is not on disk, so there is nothing to move.' }
  }
  if (kind === 'symlink') {
    // Renaming it would move the link, and the project would end up outside both folders.
    return unsupported('It is registered through a symbolic link. Move the real folder yourself.')
  }
  if (kind !== 'dir') return unsupported('Its path is not a folder, so it cannot be moved.')

  // A `.git` file means the repository lives elsewhere (a linked worktree, a submodule): git's
  // links to it would need the other repository's repair, which this move does not run.
  const gitKind = fs.kind(join(path, '.git'))
  if (gitKind === 'file') {
    return unsupported(
      'Its folder is a linked worktree or a submodule of another repository, which cannot be moved on its own. Move it yourself with git.'
    )
  }
  if (gitKind !== null && gitKind !== 'dir') {
    return unsupported(
      'Its .git is not a plain folder, so git may keep its data somewhere else. Move it yourself.'
    )
  }

  const spellings = spellingsOf(path, fs.canonical(path))
  if (
    fs.sameFolder(context.devFolder, path) ||
    context.devSpellings().some((dev) => isAtOrBelow(spellings, dev))
  ) {
    return unsupported(
      "The dev folder is this project's folder or inside it. Choose a dev folder outside the project."
    )
  }

  const inside = db.namesRegisteredInside(spellings, project.id)
  if (inside.length > 0) {
    return unsupported(
      `Something else is registered inside its folder: ${inside.join(', ')}. Move that out of the folder first, then check again.`
    )
  }

  if (fs.kind(toPath) !== null) return folderExists(toPath)
  if (db.getProjectByPath(toPath) !== null) return projectExists(toPath)
  return null
}

// ── What moves with a project ───────────────────────────────────────────────────────────

/**
 * What a project's move takes along, worked out before anything changes: afterwards the old
 * paths can no longer be resolved.
 */
interface Layout {
  /** Real path of the checkout (null when it could not be resolved). */
  readonly fromRealPath: string | null
  /** Every spelling of the checkout: as stored, then its real path when that differs. */
  readonly checkout: readonly string[]
  /** Linked worktrees next to the checkout that go to the dev folder with it. */
  readonly siblings: readonly { readonly name: string; readonly from: readonly string[] }[]
  /** One sentence per linked worktree next to the checkout that stays where it is. */
  readonly staying: readonly string[]
  /** Every linked worktree of the repository, as git records it and by real path. */
  readonly linked: readonly {
    readonly path: string
    readonly realPath: string | null
    readonly locked: boolean
  }[]
}

/**
 * Split the repository's linked worktrees: those inside the checkout move with it by
 * themselves, those next to it in the same folder (Teleport creates `<folder>/<repo>-<branch>`)
 * move to the dev folder as well when their name is free there, the rest stay.
 */
const layoutOf = (
  project: Project,
  toPath: string,
  linkedWorktrees: readonly LinkedWorktree[],
  context: MoveContext
): Layout => {
  const { db, fs } = context
  const fromPath = project.path
  const fromRealPath = fs.canonical(fromPath)
  const checkout = spellingsOf(fromPath, fromRealPath)
  const parent = dirname(fromPath)
  const linked = linkedWorktrees.map((worktree) => ({
    path: worktree.path,
    realPath: fs.canonical(worktree.path),
    locked: worktree.locked
  }))

  const siblings: { name: string; from: string[] }[] = []
  const staying: string[] = []
  const namesTaken = new Set([basename(toPath)])
  for (const worktree of linked) {
    // git records real paths; the database may hold the checkout under another spelling.
    if (isAtOrBelow(checkout, worktree.path)) continue
    if (worktree.realPath !== null && isAtOrBelow(checkout, worktree.realPath)) continue
    if (fs.kind(worktree.path) !== 'dir' || !fs.sameFolder(dirname(worktree.path), parent)) continue

    const name = basename(worktree.path)
    const from = spellingsOf(join(parent, name), worktree.path)
    const to = join(dirname(toPath), name)
    if (namesTaken.has(name) || fs.kind(to) !== null || db.getProjectByPath(to) !== null) {
      staying.push(
        `The worktree ${name} stayed in ${parent}: the dev folder already has a folder named ${name}. It keeps working from where it is.`
      )
      continue
    }
    // Moving a folder that is (or holds) a project of its own would leave that project's row
    // pointing at nothing: only this project's rows are rewritten.
    const registeredApart =
      from.some((spelling) => db.getProjectByPath(spelling) !== null) ||
      db.namesRegisteredInside(from, project.id).length > 0
    if (registeredApart) {
      staying.push(
        `The worktree ${name} stayed in ${parent}: it is also registered as a project of its own, or holds one. It keeps working from where it is.`
      )
      continue
    }
    namesTaken.add(name)
    siblings.push({ name, from })
  }
  return { fromRealPath, checkout, siblings, staying, linked }
}

/** Every directory that would move, in every spelling: what the busy probe is asked about. */
const movingPathsOf = (layout: Layout): string[] => [
  ...layout.checkout,
  ...layout.siblings.flatMap((sibling) => sibling.from)
]

/** The checkout first, then the worktrees that sat next to it. */
const relocationsOf = (layout: Layout, toPath: string): RelocationMove[] => [
  { from: layout.checkout, to: toPath },
  ...layout.siblings.map((sibling) => ({
    from: sibling.from,
    to: join(dirname(toPath), sibling.name)
  }))
]

/** Where `path` is once `relocations` are placed; null when it is not in a folder that moves. */
const placeAfter = (relocations: readonly RelocationMove[], path: string): string | null => {
  for (const relocation of relocations) {
    for (const from of relocation.from) {
      if (path === from) return relocation.to
      const rest = pathBelow(from, path)
      if (rest !== null) return join(relocation.to, rest)
    }
  }
  return null
}

/** A linked worktree where it is now, and whether git holds on to it while its folder is away. */
interface LinkedPlace {
  readonly path: string
  readonly locked: boolean
}

/** One entry per path, in the order first seen. */
const uniquePlaces = (places: readonly LinkedPlace[]): LinkedPlace[] => {
  const lockedByPath = new Map<string, boolean>()
  for (const place of places) {
    lockedByPath.set(place.path, (lockedByPath.get(place.path) ?? false) || place.locked)
  }
  return [...lockedByPath].map(([path, locked]) => ({ path, locked }))
}

/** Where each linked worktree is once the relocations are placed (its old place when it stays). */
const linkedPlacesAfter = (layout: Layout, relocations: readonly RelocationMove[]): LinkedPlace[] =>
  uniquePlaces(
    layout.linked.map((worktree) => ({
      path:
        placeAfter(relocations, worktree.path) ??
        (worktree.realPath === null ? null : placeAfter(relocations, worktree.realPath)) ??
        worktree.path,
      locked: worktree.locked
    }))
  )

/**
 * `MovedProject.moves`: every directory that something keys by its exact path, old → new. Each
 * spelling of each folder that moved, and each linked worktree inside one of them under each
 * of those spellings (git records the real path, the database may hold the other one).
 * `linkedPaths` may name a worktree by its old or by its new place.
 */
const movesOf = (
  relocations: readonly RelocationMove[],
  linkedPaths: readonly string[]
): PathMove[] => {
  const moves: PathMove[] = []
  const seen = new Set<string>()
  const add = (from: string, to: string): void => {
    if (from === to || seen.has(from)) return
    seen.add(from)
    moves.push({ from, to })
  }
  for (const relocation of relocations) {
    for (const from of relocation.from) add(from, relocation.to)
  }
  for (const path of linkedPaths) {
    for (const relocation of relocations) {
      const rest = [...relocation.from, relocation.to]
        .map((folder) => pathBelow(folder, path))
        .find((below) => below !== null)
      if (rest === undefined || rest === null) continue
      for (const from of relocation.from) add(join(from, rest), join(relocation.to, rest))
      break
    }
  }
  return moves
}

/** Whether the folder holds a git repository of its own: without one git has nothing to say. */
const holdsRepository = (path: string, fs: MoveProjectsDeps['fs']): boolean =>
  fs.kind(join(path, '.git')) === 'dir'

/**
 * The linked worktrees of the repository in `repoPath`: none when the folder holds no
 * repository, null when git cannot say (a rejection counts as that).
 */
const linkedWorktreesOf = async (
  repoPath: string,
  isRepository: boolean,
  deps: Pick<MoveProjectsDeps, 'git' | 'log'>
): Promise<readonly LinkedWorktree[] | null> => {
  if (!isRepository) return []
  try {
    return await deps.git.listLinkedWorktrees(repoPath)
  } catch (error) {
    note(deps, 'dev folder: listing worktrees failed', { repoPath, error: reasonOf(error) })
    return null
  }
}

/**
 * Whether putting these folders in place copies one of them to another volume instead of
 * renaming it. A filesystem port that cannot tell is taken to rename.
 */
const wouldCopy = (relocations: readonly RelocationMove[], fs: MoveProjectsDeps['fs']): boolean =>
  relocations.some((relocation) => fs.copies?.(relocation.from[0], relocation.to) ?? false)

/**
 * What is running in the project according to one reading, or git itself; null when nothing.
 * `copies` says that the old folders are copied and then removed: what merely sits in one of
 * them is left in a folder that no longer exists, so the reading counts that too.
 */
const busyReason = (
  probe: BusyProbe,
  project: Project,
  worktrees: readonly Worktree[],
  layout: Layout,
  deps: Pick<MoveProjectsDeps, 'git'>,
  copies: boolean
): string | null => {
  const running = probe(project, worktrees, movingPathsOf(layout), { copies })
  if (running) return running
  const operation = deps.git.operationInProgress(project.path)
  return operation ? gitBusy(operation) : null
}

// ── A move whose follow-up steps are still owed ─────────────────────────────────────────
// One settings row says which move still owes them (`PendingDevFolderMove`), and the next move
// writes over it. So while that row stands for steps that have not run, no other project moves.

interface OwedMove {
  readonly pending: PendingDevFolderMove
  /** The project the note is about, where the note says it is. */
  readonly project: Project
  /** Whether its folder is on disk now. The steps can only run on a folder that is. */
  readonly reachable: boolean
}

/**
 * The move that still owes its follow-up steps, or null. A note about a project that is gone
 * or somewhere else by now stands for nothing: the next resume drops it.
 */
const owedMove = (deps: Pick<MoveProjectsDeps, 'db' | 'fs'>): OwedMove | null => {
  const pending = deps.db.readPendingMove()
  if (pending === null) return null
  const project = deps.db.getProject(pending.projectId)
  if (project === null || project.path !== pending.toPath) return null
  return { pending, project, reachable: deps.fs.kind(pending.toPath) === 'dir' }
}

// ── The count and the plan ──────────────────────────────────────────────────────────────

/**
 * How many projects "Move projects" would move right now, and from which folders: the offered
 * projects that nothing on disk or in the database holds back. Cheap enough for the Settings
 * row: no git, no look at what is running. A project that cannot be checked is not counted.
 */
export const countLeftBehind = (
  deps: Pick<MoveProjectsDeps, 'db' | 'fs' | 'folders'>
): { count: number; folders: string[] } => {
  const context = moveContext(deps)
  if (context.previousFolders.length === 0) return { count: 0, folders: [] }
  let count = 0
  const sources = new Set<string>()
  for (const project of deps.db.getAllProjects()) {
    try {
      const located = locate(project, context)
      if (located === null || staticSkip(project, located.toPath, context) !== null) continue
      count += 1
      sources.add(located.source)
    } catch {
      // Not known to be movable: left out of the count, the plan says why.
    }
  }
  return { count, folders: context.previousFolders.filter((folder) => sources.has(folder)) }
}

interface PlanRow {
  readonly project: Project
  readonly source: string
  readonly toPath: string
  skip: Skip | null
  layout: Layout | null
}

/**
 * What "Move projects" would do right now: every offered project, in sidebar order, with the
 * reason it would stay when there is one. Read-only. Rejects only when the folders or the
 * project rows cannot be read at all; a project that cannot be checked is listed as such.
 */
export const planDevFolderMove = async (deps: MoveProjectsDeps): Promise<DevFolderMovePlan> => {
  const context = moveContext(deps)
  // An interrupted move whose folder is out of reach holds every other project back, as it
  // does in the move itself. Only that case is judged here: a plan is not kept waiting by a
  // move that is running, and the note of that one differs in nothing but its folder being
  // in place.
  let heldBack: Skip | null = null
  let heldBackBy: string | null = null
  try {
    const owed = owedMove(deps)
    if (owed !== null && !owed.reachable) {
      heldBack = owedUnreachable(owed.project.name, owed.pending.toPath)
      heldBackBy = owed.project.id
    }
  } catch (error) {
    note(deps, 'dev folder: reading the note of an interrupted move failed', {
      error: reasonOf(error)
    })
  }
  const rows: PlanRow[] = []
  for (const project of deps.db.getAllProjects()) {
    let located: Located | null
    try {
      located = locate(project, context)
    } catch (error) {
      note(deps, 'dev folder: a project could not be placed in a folder', {
        projectId: project.id,
        error: reasonOf(error)
      })
      continue
    }
    if (located === null) continue
    let skip: Skip | null
    try {
      skip = staticSkip(project, located.toPath, context)
    } catch (error) {
      skip = uncheckable(error)
    }
    if (skip === null && heldBack !== null && project.id !== heldBackBy) skip = heldBack
    rows.push({ project, source: located.source, toPath: located.toPath, skip, layout: null })
  }

  // git is asked only about the projects that would move, a few at a time: a plan over hundreds
  // of projects must not start hundreds of git processes at once.
  await forEachLimited(
    rows.filter((row) => row.skip === null),
    PLAN_GIT_CONCURRENCY,
    async (row) => {
      try {
        const path = row.project.path
        const linked = await linkedWorktreesOf(path, holdsRepository(path, deps.fs), deps)
        if (linked === null) row.skip = GIT_LIST_FAILED
        else row.layout = layoutOf(row.project, row.toPath, linked, context)
      } catch (error) {
        row.skip = uncheckable(error)
      }
    }
  )

  // One reading of what is running for the whole plan, taken last so it is as fresh as it can
  // be, and not at all when nothing would move.
  const movable = rows.filter((row) => row.skip === null && row.layout !== null)
  if (movable.length > 0) {
    let probe: BusyProbe | null = null
    try {
      probe = await deps.busy()
    } catch (error) {
      note(deps, 'dev folder: reading what is running failed', { error: reasonOf(error) })
    }
    for (const row of movable) {
      let busy: string | null = BUSY_UNKNOWN
      try {
        if (probe !== null && row.layout !== null) {
          const worktrees = deps.db.getWorktreesByProject(row.project.id)
          // The dev folder may not be on disk yet: the port answers from the nearest folder
          // above it that is.
          const copies = wouldCopy(relocationsOf(row.layout, row.toPath), deps.fs)
          busy = busyReason(probe, row.project, worktrees, row.layout, deps, copies)
        }
      } catch (error) {
        note(deps, 'dev folder: checking what is running failed', {
          projectId: row.project.id,
          error: reasonOf(error)
        })
      }
      if (busy !== null) row.skip = { reason: 'busy', detail: busy }
    }
  }

  const sources = new Set(rows.map((row) => row.source))
  return {
    devFolder: context.devFolder,
    sources: context.previousFolders.filter((folder) => sources.has(folder)),
    candidates: rows.map((row): DevFolderMoveCandidate => ({
      projectId: row.project.id,
      projectName: row.project.name,
      source: row.source,
      fromPath: row.project.path,
      toPath: row.toPath,
      skipReason: row.skip?.reason ?? null,
      detail: row.skip?.detail ?? null
    }))
  }
}

// ── Moving one project ──────────────────────────────────────────────────────────────────

/** What a move knows so far, for the answer it gives wherever it stops. */
interface Progress {
  readonly projectId: string
  projectName: string
  fromPath: string
  toPath: string | null
  /**
   * Set in the tick the database is repointed. From then on the project HAS moved and the
   * answer is 'moved', whatever a later step does: the window must reload it either way.
   */
  moved: {
    movedPaths: { from: string; to: string }[]
    readonly warnings: string[]
    /** The projects that had a ticket rewritten; absent when the database did not say. */
    readonly boardProjectIds?: readonly string[]
  } | null
}

const answer = (
  progress: Progress,
  action: DevFolderMoveResult['action'],
  skipReason: DevFolderMoveSkipReason | null,
  detail: string | null
): DevFolderMoveResult => ({
  projectId: progress.projectId,
  projectName: progress.projectName,
  action,
  fromPath: progress.fromPath,
  toPath: progress.toPath,
  skipReason,
  detail,
  warnings: progress.moved?.warnings ?? [],
  movedPaths: progress.moved?.movedPaths ?? [],
  // Absent stays absent: the window reloads every board it holds when it is not told which.
  ...(progress.moved?.boardProjectIds === undefined
    ? {}
    : { boardProjectIds: [...progress.moved.boardProjectIds] })
})

const skipped = (progress: Progress, skip: Skip): DevFolderMoveResult =>
  answer(progress, 'skipped', skip.reason, skip.detail)

const failed = (progress: Progress, detail: string): DevFolderMoveResult =>
  answer(progress, 'failed', null, detail)

/**
 * Thrown inside a move for a reason to leave the project where it is. Anything else that is
 * thrown is a failure.
 */
class MoveRefused extends Error {
  readonly skip: Skip

  constructor(skip: Skip) {
    super(skip.detail)
    this.skip = skip
  }
}

/** The first destination that something already occupies, as the reason to stop. */
const takenDestination = (
  relocations: readonly RelocationMove[],
  deps: Pick<MoveProjectsDeps, 'db' | 'fs'>
): Skip | null => {
  for (const relocation of relocations) {
    if (deps.fs.kind(relocation.to) !== null) return folderExists(relocation.to)
  }
  const toPath = relocations[0].to
  return deps.db.getProjectByPath(toPath) === null ? null : projectExists(toPath)
}

/**
 * `{ from, to }` of the project and of each worktree row that changed, in the spellings the
 * database held and holds: what the window re-keys its own state with.
 */
const movedPathsOf = (
  fromPath: string,
  toPath: string,
  worktrees: RelocateProjectResult['worktrees']
): { from: string; to: string }[] => {
  const paths: { from: string; to: string }[] = []
  const seen = new Set<string>()
  for (const { from, to } of [{ from: fromPath, to: toPath }, ...worktrees]) {
    const key = JSON.stringify([from, to])
    if (seen.has(key)) continue
    seen.add(key)
    paths.push({ from, to })
  }
  return paths
}

/**
 * Take back every folder that was placed, last one first. An undo that fails does not stop
 * the others; what could not go back is returned in words, so the answer can say where the
 * folder is.
 */
const putBack = (placed: readonly PreparedMove[]): string[] => {
  const stuck: string[] = []
  for (const move of [...placed].reverse()) {
    try {
      move.undo()
    } catch (error) {
      stuck.push(
        move.copied
          ? `the copy at ${move.to} was not removed (${reasonOf(error)}); delete it yourself, the project is still at ${move.from}`
          : `${move.to} was not moved back to ${move.from} (${reasonOf(error)}); move it back yourself`
      )
    }
  }
  return stuck
}

type Outcome =
  | {
      readonly committed: true
      readonly moved: MovedProject
      readonly result: RelocateProjectResult
      /** The warnings of the answer: every later step adds to this same list. */
      readonly warnings: string[]
    }
  | { readonly committed: false; readonly answer: DevFolderMoveResult }

/**
 * The tick in which the project changes place. NOT async, on purpose, and nothing in it waits:
 * between the last look at git and at the row, the folders going into place, the database
 * being repointed and the caches that must never be read stale (`deps.onRelocated`), no other
 * request, watcher callback or timer of this process gets to run. That is what makes a move
 * that fails here undoable (nobody saw the folders in their new place) and a move that succeeds
 * seamless (nobody sees the database and the disk disagree).
 *
 * `db.relocateProject` calls `place` inside its transaction, once it holds the write lock and
 * has computed every new value. When it throws, or anything before it does, the folders that
 * were already placed go back, last one first, before this function returns: still the same
 * tick. Once it has returned, the move stands and nothing here undoes a folder any more; what
 * fails after that is a warning. Never throws.
 */
const placeAndRelocate = (input: {
  readonly project: Project
  readonly layout: Layout
  readonly relocations: readonly RelocationMove[]
  readonly prepared: readonly PreparedMove[]
  readonly worktreesBefore: readonly Worktree[]
  readonly progress: Progress
  readonly deps: MoveProjectsDeps
}): Outcome => {
  const { project, layout, relocations, prepared, progress, deps } = input
  const { db, git } = deps
  const fromPath = project.path
  const toPath = relocations[0].to

  const placed: PreparedMove[] = []
  let result: RelocateProjectResult
  try {
    // A git command that holds a lock now would release it through its old path: the lock file
    // would stay behind in the new place and block every later git write.
    const operation = git.operationInProgress(fromPath)
    if (operation) throw new MoveRefused({ reason: 'busy', detail: gitBusy(operation) })
    if (db.getProject(project.id)?.path !== fromPath) throw new MoveRefused(PROJECT_CHANGED)
    const taken = takenDestination(relocations, deps)
    if (taken !== null) throw new MoveRefused(taken)

    // The old folders of a move to another volume stay on disk until the very last step. The
    // note names them, so a start after a quit can say where they are.
    const copiedFrom = prepared.filter((move) => move.copied).map((move) => move.from)
    result = db.relocateProject({
      projectId: project.id,
      expectedPath: fromPath,
      relocations,
      homeDir: deps.homeDir,
      pending: {
        projectId: project.id,
        fromPath,
        fromRealPath: layout.fromRealPath,
        toPath,
        relocations,
        ...(copiedFrom.length > 0 ? { copiedFrom } : {})
      },
      place: () => {
        for (const move of prepared) {
          move.place()
          placed.push(move)
        }
      }
    })
  } catch (error) {
    const stuck = putBack(placed)
    if (stuck.length > 0) {
      return { committed: false, answer: failed(progress, notMovedAndStuck(error, stuck)) }
    }
    return {
      committed: false,
      answer:
        error instanceof MoveRefused
          ? skipped(progress, error.skip)
          : failed(progress, notMoved(error))
    }
  }

  // Committed. The answer is 'moved' from the next statement on, whatever happens after it: the
  // folder stays where it is now.
  const warnings: string[] = []
  const reported = {
    movedPaths: [{ from: fromPath, to: toPath }],
    warnings,
    ...(result.ticketProjectIds === undefined ? {} : { boardProjectIds: result.ticketProjectIds })
  }
  progress.moved = reported
  reported.movedPaths = movedPathsOf(fromPath, toPath, result.worktrees)

  let allWorktrees: readonly Worktree[]
  try {
    allWorktrees = db.getWorktreesByProject(project.id)
  } catch (error) {
    // The rows as they were, with the paths the transaction reported: the same thing.
    const changed = new Map(result.worktrees.map((worktree) => [worktree.id, worktree.to]))
    allWorktrees = input.worktreesBefore.map((row) => ({
      ...row,
      path: changed.get(row.id) ?? row.path
    }))
    note(deps, 'dev folder: reading the moved worktree rows failed', { error: reasonOf(error) })
  }
  const moved: MovedProject = {
    project: result.project,
    fromPath,
    fromRealPath: layout.fromRealPath,
    toPath,
    relocations,
    moves: movesOf(
      relocations,
      layout.linked.flatMap((worktree) => spellingsOf(worktree.path, worktree.realPath))
    ),
    worktrees: result.worktrees,
    allWorktrees,
    ticketsRewritten: result.ticketsRewritten,
    runsRewritten: result.runsRewritten,
    otherProjectIds: result.otherProjectIds,
    dataProjectIds: result.dataProjectIds,
    // Absent stays absent: "not reported" is not the same as "none".
    ...(result.ticketProjectIds === undefined ? {} : { ticketProjectIds: result.ticketProjectIds }),
    ...(result.runIds === undefined ? {} : { runIds: result.runIds })
  }
  try {
    warnings.push(...deps.onRelocated(moved))
  } catch (error) {
    warnings.push(relocatedFailed(error))
  }
  return { committed: true, moved, result, warnings }
}

/**
 * Re-link git's worktrees to the checkout's new place and check that it worked. What git
 * answers to the repair says little either way: it exits 0 without having fixed everything, and
 * it reports an error over one broken worktree after having fixed all the others. So the
 * worktrees are listed again whatever it answered, and each one is judged by itself: linked
 * when git lists it where it is now, finds it there, and the worktree's own `.git` file leads
 * back to this repository. Resolves false, with a warning that names the worktrees still not
 * linked and the command to run by hand, when it cannot be shown that every worktree on disk
 * is linked again.
 */
const repairLinks = async (
  toPath: string,
  linkedPlaces: readonly LinkedPlace[],
  deps: Pick<MoveProjectsDeps, 'fs' | 'git' | 'log'>,
  warnings: string[]
): Promise<boolean> => {
  const { fs, git } = deps
  let onDisk: readonly string[] = linkedPlaces.map((place) => place.path)
  let refusal: string | null = null
  try {
    // git refuses the whole repair when it is handed a path that is not there.
    const present = new Set(linkedPlaces.filter((place) => fs.kind(place.path) === 'dir'))
    onDisk = linkedPlaces.filter((place) => present.has(place)).map((place) => place.path)
    // A locked worktree is one git holds on to while its folder is away (a disk that is not
    // connected): nothing can be written into it now, and it stays registered through the sync
    // below. One that is away and not locked is dropped by that sync, as it is without a move.
    for (const place of linkedPlaces) {
      if (place.locked && !present.has(place)) warnings.push(worktreeAway(toPath, place.path))
    }
    if (onDisk.length === 0) return true

    try {
      await git.repairWorktrees(toPath, onDisk)
    } catch (error) {
      refusal = reasonOf(error)
    }
    const after = await git.listLinkedWorktrees(toPath)
    if (after === null) {
      // Nothing can be shown about any of them.
      warnings.push(linksNotRepaired(toPath, onDisk, refusal))
      return false
    }
    const found = after.filter((worktree) => !worktree.prunable)
    const broken = onDisk.filter(
      (path) =>
        !found.some((worktree) => worktree.path === path || fs.sameFolder(worktree.path, path)) ||
        // git's listing shows the repository's side of a link only.
        !(git.linksBack?.(toPath, path) ?? true)
    )
    if (broken.length === 0) {
      if (refusal !== null) {
        note(
          deps,
          'dev folder: git reported an error while re-linking, and every worktree is linked',
          {
            toPath,
            error: refusal
          }
        )
      }
      return true
    }
    warnings.push(linksNotRepaired(toPath, broken, refusal))
    return false
  } catch (error) {
    warnings.push(linksNotRepaired(toPath, onDisk, refusal ?? reasonOf(error)))
    return false
  }
}

/** Forget that follow-up steps are owed. */
const clearNote = (deps: Pick<MoveProjectsDeps, 'db' | 'log'>): void => {
  try {
    deps.db.clearPendingMove()
  } catch (error) {
    // Harmless: the steps are run once more, by the next start or before the next move, and
    // the note is cleared then.
    note(deps, 'dev folder: clearing the pending move failed', { error: reasonOf(error) })
  }
}

/**
 * What follows the commit: git's links, the worktree rows, everything outside the database and
 * the events. The note that these steps are owed is the caller's to clear, once nothing else
 * of the move is left to do. Each step is safe to run twice (a start after a quit runs them
 * again from that note), and none of them can stop the others: a step that fails adds a
 * sentence to `warnings`. Never rejects.
 */
const finishMove = async (input: {
  readonly moved: MovedProject
  /** Where each linked worktree of the project is now; null when git could not say. */
  readonly linkedPlaces: readonly LinkedPlace[] | null
  /** Whether the moved folder holds a git repository: without one there is nothing for git to do. */
  readonly isRepository: boolean
  readonly deps: MoveProjectsDeps
  readonly warnings: string[]
}): Promise<void> => {
  const { moved, linkedPlaces, deps, warnings } = input
  const { toPath } = moved

  if (input.isRepository) {
    let linksVerified = true
    if (linkedPlaces === null) {
      linksVerified = false
      warnings.push(linksUnknown(toPath))
    } else if (linkedPlaces.length > 0) {
      linksVerified = await repairLinks(toPath, linkedPlaces, deps, warnings)
    }

    try {
      warnings.push(
        ...(await deps.git.repairLinkedSubmodules(toPath, moved.fromRealPath ?? moved.fromPath))
      )
    } catch (error) {
      warnings.push(
        `The submodules in this project's worktrees could not be checked: ${reasonOf(error)}. Run git status in a worktree that has submodules to see whether it still works.`
      )
    }

    // Reconciling the rows ends with `git worktree prune`, which deletes the registration of
    // every worktree git cannot find. After a repair that did not take, that is the very
    // worktrees the repair was for, and nothing brings them back. So: only once verified.
    // A repository with no linked worktree has nothing the move could have put out of step:
    // its one row was repointed with the project. Most projects are like that, and the
    // reconciling is the slowest step of a move, so they go without it.
    if (linksVerified && linkedPlaces !== null && linkedPlaces.length > 0) {
      try {
        const synced = await deps.syncWorktrees({
          projectId: moved.project.id,
          projectPath: toPath
        })
        if (!synced.success) warnings.push(syncFailed(synced.error))
      } catch (error) {
        warnings.push(syncFailed(reasonOf(error)))
      }
    }
  }

  try {
    warnings.push(...(await deps.afterMove(moved)))
  } catch (error) {
    warnings.push(
      `Some of the tidying up after the move did not finish: ${reasonOf(error)}. Session history or connection folders of this project may still point at the old folder.`
    )
  }

  // Only now: nobody is told to reload, and so to read the new path, before git is repaired.
  try {
    deps.publishChanged(moved)
  } catch (error) {
    warnings.push(
      `Other windows were not told about the move: ${reasonOf(error)}. Reload them to see the project in its new folder.`
    )
  }
}

const moveProject = async (
  params: MoveProjectToDevFolderParams,
  deps: MoveProjectsDeps,
  progress: Progress
): Promise<DevFolderMoveResult> => {
  const { db, fs } = deps

  // The plan's rule again, on what is true now.
  const project = db.getProject(params.projectId)
  if (project === null) return skipped(progress, PROJECT_GONE)
  progress.projectName = project.name
  progress.fromPath = project.path
  // Moves run one at a time, so a note found here was left by a move that did not get to its
  // end (a quit, an error after its commit). It is finished before this one begins.
  const noteFound = db.readPendingMove() !== null
  if (noteFound) await resumePendingDevFolderMove(deps)
  const context = moveContext(deps)
  const located = locate(project, context)
  if (located === null) return skipped(progress, NOT_IN_SOURCE)
  progress.toPath = located.toPath
  // The person confirmed a destination. When the dev folder was changed since (another
  // window), the project would go somewhere they never saw. A plan spells a dev folder
  // that is not on disk yet the way it is set; the first move of that plan creates it, and from
  // then on it is spelled by its real path. Both spellings are the folder the person confirmed.
  const asPlanned = join(resolve(context.devFolder), basename(project.path))
  if (params.expectedToPath !== located.toPath && params.expectedToPath !== asPlanned) {
    return skipped(progress, DEV_FOLDER_CHANGED)
  }
  const skip = staticSkip(project, located.toPath, context)
  if (skip !== null) return skipped(progress, skip)
  // A note that is still there stands for steps that could not be run. This move would write
  // its own note over it, and those steps would never run.
  const owed = noteFound ? owedMove(deps) : null
  if (owed !== null) {
    if (owed.reachable) return skipped(progress, owedUnfinished(owed.project.name))
    if (owed.project.id !== project.id) {
      return skipped(progress, owedUnreachable(owed.project.name, owed.pending.toPath))
    }
  }

  const fromPath = project.path
  const isRepository = holdsRepository(fromPath, fs)
  const linked = await linkedWorktreesOf(fromPath, isRepository, deps)
  if (linked === null) return skipped(progress, GIT_LIST_FAILED)
  const layout = layoutOf(project, located.toPath, linked, context)

  const copies = wouldCopy(relocationsOf(layout, located.toPath), fs)
  const probe = await deps.busy()
  const worktreesBefore = db.getWorktreesByProject(project.id)
  const busy = busyReason(probe, project, worktreesBefore, layout, deps, copies)
  if (busy !== null) return skipped(progress, { reason: 'busy', detail: busy })

  // From `beforeMove` on, every way out that is not a move puts back what was stopped and
  // removes what preparing left behind.
  const prepared: PreparedMove[] = []
  let relocations: readonly RelocationMove[] = []
  let outcome: Outcome
  try {
    await deps.beforeMove(project)
    await fs.mkdirp(context.devFolder)
    // The dev folder may exist only since the line above. Its real path is the spelling git
    // and the tools that key their state by folder will use for everything under it.
    const toPath = join(
      fs.canonical(context.devFolder) ?? resolve(context.devFolder),
      basename(fromPath)
    )
    progress.toPath = toPath
    relocations = relocationsOf(layout, toPath)
    const taken = takenDestination(relocations, deps)
    if (taken !== null) throw new MoveRefused(taken)

    for (const relocation of relocations) {
      prepared.push(await fs.prepareMove(relocation.from[0], relocation.to))
    }
    // Stopping the watchers and preparing took time (minutes, for a copy to another volume),
    // and the old folder stayed usable all the while: what was read before says nothing about
    // now. So one more reading, on every move, and nothing is waited for between it and the
    // folders going into place.
    const probeNow = await deps.busy()
    const worktreesNow = db.getWorktreesByProject(project.id)
    const copied = prepared.some((move) => move.copied)
    const busyNow = busyReason(probeNow, project, worktreesNow, layout, deps, copied)
    if (busyNow !== null) throw new MoveRefused({ reason: 'busy', detail: busyNow })

    // No `await` from here to the end of placeAndRelocate.
    outcome = placeAndRelocate({
      project,
      layout,
      relocations,
      prepared,
      worktreesBefore,
      progress,
      deps
    })
  } catch (error) {
    if (progress.moved !== null) throw error
    outcome = {
      committed: false,
      answer:
        error instanceof MoveRefused
          ? skipped(progress, error.skip)
          : failed(progress, notMoved(error))
    }
  }

  if (!outcome.committed) {
    for (const move of prepared) {
      try {
        await move.abort()
      } catch (error) {
        note(deps, 'dev folder: removing a prepared move failed', {
          to: move.to,
          error: reasonOf(error)
        })
      }
    }
    try {
      await deps.afterAbort(project)
    } catch (error) {
      note(deps, 'dev folder: restoring after an aborted move failed', { error: reasonOf(error) })
    }
    return outcome.answer
  }

  const { moved, result, warnings } = outcome
  warnings.push(...layout.staying)

  await finishMove({
    moved,
    linkedPlaces: linkedPlacesAfter(layout, relocations),
    isRepository,
    deps,
    warnings
  })

  // Last: the old copy of a move to another volume goes only once everything points at the
  // new one, and stays when it was written to since it was copied.
  for (const move of prepared) {
    try {
      const left = await move.discardSource()
      if (left !== null) warnings.push(leftoverSentence(left))
    } catch (error) {
      warnings.push(
        `The old copy at ${move.from} may still be there: ${reasonOf(error)}. Compare it with the new one, then delete it yourself.`
      )
    }
  }

  // Only now is nothing owed any more. A quit while an old copy was being removed leaves the
  // note, and the next start says where what is left of that copy is.
  clearNote(deps)

  if (result.scriptsRewritten && !SHELL_SAFE_PATH.test(moved.toPath)) {
    warnings.push(
      `Scripts of ${project.name} mention its folder, and the new path has characters a shell treats specially: check them.`
    )
  }
  // A path a shell has to quote or escape can be written in more ways than the rewrite knows.
  const oldPaths = relocations.flatMap((relocation) => relocation.from)
  if (result.scriptsRewritten && oldPaths.some((path) => !SHELL_SAFE_PATH.test(path))) {
    warnings.push(
      `Scripts of ${project.name} mention its folder, and the old path has characters a shell treats specially: a script may still name the old folder in an escaped or quoted spelling. Check them.`
    )
  }

  return answer(progress, 'moved', null, null)
}

/**
 * Move one project from a folder used before into the dev folder: its checkout, the linked
 * worktrees inside it and those that sit next to it, and everything that names their paths.
 * `expectedToPath` is the destination the person confirmed in the plan. Never rejects: what
 * goes wrong before the project has moved is a 'failed' or 'skipped' answer with the folder
 * back where it was, what goes wrong after is a warning on a 'moved' answer.
 *
 * One call at a time, and never while `resumePendingDevFolderMove` runs: the caller queues
 * them. A move that an earlier call or an earlier run of the app left unfinished is finished
 * first.
 */
export const moveProjectToDevFolder = async (
  params: MoveProjectToDevFolderParams,
  deps: MoveProjectsDeps
): Promise<DevFolderMoveResult> => {
  const progress: Progress = {
    projectId: params.projectId,
    projectName: '',
    fromPath: '',
    toPath: null,
    moved: null
  }
  try {
    return await moveProject(params, deps, progress)
  } catch (error) {
    note(deps, 'dev folder: moving a project stopped on an error', {
      projectId: params.projectId,
      moved: progress.moved !== null,
      error: reasonOf(error)
    })
    if (progress.moved === null) return failed(progress, notMoved(error))
    // The note for an interrupted move is still there: the next start runs what is owed (and
    // so does the next move, before it begins).
    progress.moved.warnings.push(
      `A step after the move did not finish: ${reasonOf(error)}. Restart the app to finish it.`
    )
    return answer(progress, 'moved', null, null)
  }
}

// ── Finishing a move that a quit interrupted ────────────────────────────────────────────

/**
 * The moved project as far as it can be told after the fact, from the note the move left and
 * the rows as they are now. What the transaction counted is gone with the process that ran it;
 * nobody was connected then, so nothing is waiting for those numbers.
 */
const movedFromPending = (
  pending: PendingDevFolderMove,
  project: Project,
  linked: readonly LinkedWorktree[],
  deps: Pick<MoveProjectsDeps, 'db'>
): MovedProject => {
  const relocations: readonly RelocationMove[] =
    pending.relocations.length > 0
      ? pending.relocations
      : [{ from: spellingsOf(pending.fromPath, pending.fromRealPath), to: pending.toPath }]
  const allWorktrees = deps.db.getWorktreesByProject(project.id)
  const worktrees: { id: string; from: string; to: string }[] = []
  for (const row of allWorktrees) {
    for (const relocation of relocations) {
      // A row at the folder itself was stored like the project; one inside it came from git's
      // listing, which is the real path (the last spelling).
      const rest = pathBelow(relocation.to, row.path)
      const from =
        row.path === relocation.to
          ? relocation.from[0]
          : rest === null
            ? null
            : join(relocation.from[relocation.from.length - 1], rest)
      if (from === null) continue
      worktrees.push({ id: row.id, from, to: row.path })
      break
    }
  }
  return {
    project,
    fromPath: pending.fromPath,
    fromRealPath: pending.fromRealPath,
    toPath: pending.toPath,
    relocations,
    moves: movesOf(
      relocations,
      linked.map((worktree) => worktree.path)
    ),
    worktrees,
    allWorktrees,
    ticketsRewritten: 0,
    runsRewritten: 0,
    otherProjectIds: [],
    dataProjectIds: []
  }
}

/**
 * One sentence per old folder of a move to another volume that is still on disk: the quit came
 * before the move's last step had removed it. Nothing is removed here. What was checked
 * against the new copy before it went into place is gone with the process that checked it.
 */
const oldCopiesLeft = (
  pending: PendingDevFolderMove,
  project: Project,
  relocations: readonly RelocationMove[],
  deps: Pick<MoveProjectsDeps, 'fs' | 'log'>
): string[] => {
  const sentences: string[] = []
  const copiedFrom: readonly unknown[] = Array.isArray(pending.copiedFrom) ? pending.copiedFrom : []
  for (const path of copiedFrom) {
    if (typeof path !== 'string') continue
    try {
      if (deps.fs.kind(path) === null) continue
    } catch (error) {
      note(deps, 'dev folder: looking for an old copy failed', { path, error: reasonOf(error) })
      continue
    }
    const nowAt = placeAfter(relocations, path) ?? pending.toPath
    note(deps, 'dev folder: an interrupted move left an old copy on disk', {
      projectId: project.id,
      path,
      nowAt
    })
    sentences.push(oldCopyLeft(project.name, path, nowAt, nowAt === pending.toPath))
  }
  return sentences
}

/**
 * Finish the follow-up steps of a move whose process quit after the database was repointed:
 * until git's links are repaired every linked worktree of the project fails. Run at start,
 * before anything else syncs the project, and before a plan or a move while a note is there.
 * Does nothing but read one settings row when no move is owed. Never rejects.
 *
 * The note stays when the moved folder cannot be reached and when the steps stop on an error;
 * otherwise the steps get one attempt and the note is cleared. It is not kept for a repair
 * that could not be verified: a note that stays makes every start run all the steps again, and
 * some of them (the port, Claude's state) move what is at the old path to the new one.
 */
export const resumePendingDevFolderMove = async (deps: MoveProjectsDeps): Promise<void> => {
  try {
    const { db, fs } = deps
    const pending = db.readPendingMove()
    if (pending === null) return
    const project = db.getProject(pending.projectId)
    if (project === null || project.path !== pending.toPath) {
      // Deleted or moved again since: the note is about a place the project no longer has.
      db.clearPendingMove()
      return
    }
    // The disk that holds the folder is not connected, or the folder is out of reach some
    // other way. Run now, every step would find nothing to work on and the note would be
    // cleared with git's links still broken. So nothing runs and the note waits.
    if (fs.kind(pending.toPath) !== 'dir') {
      note(
        deps,
        'dev folder: the folder of an interrupted move cannot be reached, its steps stay owed',
        {
          projectId: project.id,
          toPath: pending.toPath
        }
      )
      return
    }

    const isRepository = holdsRepository(pending.toPath, fs)
    const linked = await linkedWorktreesOf(pending.toPath, isRepository, deps)
    const moved = movedFromPending(pending, project, linked ?? [], deps)
    const warnings: string[] = []
    try {
      warnings.push(...deps.onRelocated(moved))
    } catch (error) {
      warnings.push(relocatedFailed(error))
    }
    // Before the repair git still lists a worktree that moved by its old path; after it, by
    // the new one. Either way: where it is now.
    const linkedPlaces =
      linked === null
        ? null
        : uniquePlaces(
            linked.map((worktree) => ({
              path: placeAfter(moved.relocations, worktree.path) ?? worktree.path,
              locked: worktree.locked
            }))
          )
    await finishMove({ moved, linkedPlaces, isRepository, deps, warnings })
    warnings.push(...oldCopiesLeft(pending, project, moved.relocations, deps))
    clearNote(deps)
    note(deps, 'dev folder: finished the steps of an interrupted move', {
      projectId: project.id,
      toPath: pending.toPath,
      warnings
    })
  } catch (error) {
    note(deps, 'dev folder: finishing an interrupted move failed', { error: reasonOf(error) })
  }
}
