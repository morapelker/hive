// Claude Code keeps what it knows about a folder outside the project, keyed by the folder's
// path: `<config dir>/projects/<name derived from the path>/` holds the transcript of every
// session started there (`<session id>.jsonl`, with `<session id>/` beside it for subagents
// and tool results) and, for the main checkout of a repository, `memory/`, which the linked
// worktrees of that repository share. `claude --resume` and the app's own transcript reader
// look only under the name derived from the folder's current path, so when a project moves
// its history has to move to the new name.
//
// The derived name is lossy (every character that is not a letter or a digit becomes '-'), so
// `my-app` and `my_app` next to each other share one folder. A folder is therefore renamed as
// a whole only when nothing else registered in the app derives the same name; otherwise the
// sessions are told apart by the working directory each transcript records.
//
// Runs in the server child: no `electron` import here.
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat
} from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { encodePath } from '../claude-transcript-reader'
import { isSameOrAncestorPath } from '../path-utils'
import { isSameFolder } from './folder-identity'
import type { PathMove } from './types'

/**
 * Past this length Claude cuts the derived name and appends a hash of its own, which differs
 * between the runtimes Claude ships on. `encodePath` appends a guess, and the app's reader
 * makes up for it by scanning for the cut name: good enough to read, not to rename by.
 */
const DERIVED_NAME_MAX = 200
const MEMORY_DIR = 'memory'
const TRANSCRIPT_EXTENSION = '.jsonl'
/** How much of a transcript is read to find the working directory it records. */
const CWD_PROBE_BYTES = 64 * 1024
const COMPARE_CHUNK_BYTES = 64 * 1024
/** Suffix of the hidden name an entry is copied under before it gets its real name. */
const COPY_IN_PROGRESS_SUFFIX = '.hive-moving'
const NAMES_PER_SENTENCE = 5

/** A whole-folder rename that failed with one of these is retried entry by entry. */
const MERGE_INSTEAD_CODES: ReadonlySet<string> = new Set(['EXDEV', 'ENOTEMPTY', 'EEXIST'])

export interface MoveClaudeTranscriptsInput {
  /** Every directory whose path changed, old → new, in every spelling the old path is known by. */
  readonly moves: readonly PathMove[]
  /** The `projects` directories to look in (`claudeProjectRoots`). There is no default. */
  readonly roots: readonly string[]
  /**
   * Every project and worktree path in the database that did NOT move: how a folder shared
   * with another project is recognised.
   */
  readonly otherRegisteredPaths: readonly string[]
}

/** The one file operation a test replaces, to stand in for a destination on another volume. */
export interface ClaudeStateFileOps {
  readonly rename: (from: string, to: string) => Promise<void>
}

/** `resolveProjectsDir` of claude-transcript-reader.ts, for a given variable and home. */
const projectsDirOf = (configDir: string | undefined, home: string): string => {
  const configRoot =
    typeof configDir === 'string' && configDir.trim().length > 0 ? configDir : join(home, '.claude')
  return resolve(join(configRoot.normalize('NFC'), 'projects'))
}

/**
 * The `projects` directories Claude may have written a folder's history to, each once: first
 * the one the app's own transcript reader uses (`resolveProjectsDir`: this process's
 * `CLAUDE_CONFIG_DIR`), then the one a spawned CLI uses (`env`: this process's environment
 * with the person's Settings variables on top, where `CLAUDE_CONFIG_DIR` may be set too).
 * `home` stands for the home directory in both: nothing here looks the real one up.
 */
export const claudeProjectRoots = (env: NodeJS.ProcessEnv, home: string): string[] => [
  ...new Set([
    projectsDirOf(process.env.CLAUDE_CONFIG_DIR, home),
    projectsDirOf(env.CLAUDE_CONFIG_DIR, home)
  ])
]

/** One history folder that has to go to another name. */
interface FolderMove {
  readonly fromName: string
  readonly toName: string
  /** The old and new path, for sentences. */
  readonly from: string
  readonly to: string
  /** Every old spelling of the directories whose history now belongs under `toName` (NFC). */
  readonly oldSpellings: ReadonlySet<string>
  /** Another directory of the same move shares `fromName` and went to another name. */
  readonly sharedWithAnotherMove: boolean
}

const planFolderMoves = (moves: readonly PathMove[]): FolderMove[] => {
  const named = moves
    .filter((move) => move.from !== move.to)
    .map((move) => ({ ...move, fromName: encodePath(move.from), toName: encodePath(move.to) }))
  const plans = new Map<string, FolderMove>()
  for (const move of named) {
    if (move.fromName === move.toName) continue
    // Derived names hold letters, digits and '-' only, so a space cannot be part of one.
    const key = `${move.fromName} ${move.toName}`
    if (plans.has(key)) continue
    plans.set(key, {
      fromName: move.fromName,
      toName: move.toName,
      from: move.from,
      to: move.to,
      oldSpellings: new Set(
        named
          .filter((other) => other.toName === move.toName)
          .map((other) => other.from.normalize('NFC'))
      ),
      sharedWithAnotherMove: named.some(
        (other) => sharesFolderName(other.fromName, move.fromName) && other.toName !== move.toName
      )
    })
  }
  return [...plans.values()]
}

/**
 * Whether two derived names can be one folder on disk. Letter case is ignored, as most Mac
 * volumes do: taking two folders for one only makes the move more careful (session by
 * session), taking one folder for two would carry another project's sessions away.
 */
const folderNameKey = (derivedName: string): string => derivedName.toLowerCase()

const sharesFolderName = (left: string, right: string): boolean =>
  folderNameKey(left) === folderNameKey(right)

const codeOf = (cause: unknown): string =>
  typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as NodeJS.ErrnoException).code)
    : ''

const detailOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const lstatOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

/** Follows a link: a link to a directory is a directory. */
const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

const listOf = (names: readonly string[]): string => {
  const shown = names.slice(0, NAMES_PER_SENTENCE).join(', ')
  const rest = names.length - NAMES_PER_SENTENCE
  return rest > 0 ? `${shown} and ${rest} more` : shown
}

/**
 * The folder names (`folderNameKey`) derived from the registered paths, in the spelling the
 * database holds and in the real one: Claude names a folder after the physical working
 * directory, while a cloned project is stored as its path was joined.
 */
const folderNamesOf = async (
  paths: readonly string[],
  moved: ReadonlySet<string>
): Promise<ReadonlySet<string>> => {
  const names = new Set<string>()
  for (const path of paths) {
    if (moved.has(path)) continue
    names.add(folderNameKey(encodePath(path)))
    try {
      names.add(folderNameKey(encodePath(await realpath(path))))
    } catch {
      // Not on disk: its stored spelling is all there is.
    }
  }
  return names
}

/**
 * The working directory a transcript records: the `cwd` of the first line that has one,
 * within the first 64 KB. Null when it records none there or cannot be read.
 */
const readRecordedCwd = async (transcriptPath: string): Promise<string | null> => {
  let text: string
  try {
    const handle = await open(transcriptPath, 'r')
    try {
      const buffer = Buffer.alloc(CWD_PROBE_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, CWD_PROBE_BYTES, 0)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"cwd"')) continue
    try {
      const entry: unknown = JSON.parse(line)
      const cwd = (entry as { cwd?: unknown } | null)?.cwd
      if (typeof cwd === 'string') return cwd
      // A whole line whose only `cwd` is nested (a tool's input): not the session's own.
      continue
    } catch {
      // The line is longer than what was read: take the value as it is spelled.
    }
    const spelled = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(line)
    if (!spelled) continue
    try {
      const cwd: unknown = JSON.parse(spelled[1])
      if (typeof cwd === 'string') return cwd
    } catch {
      // Cut in the middle of the value.
    }
  }
  return null
}

const haveSameBytes = async (left: string, right: string): Promise<boolean> => {
  const leftHandle = await open(left, 'r')
  try {
    const rightHandle = await open(right, 'r')
    try {
      const leftChunk = Buffer.alloc(COMPARE_CHUNK_BYTES)
      const rightChunk = Buffer.alloc(COMPARE_CHUNK_BYTES)
      for (let position = 0; ;) {
        const [leftRead, rightRead] = await Promise.all([
          leftHandle.read(leftChunk, 0, COMPARE_CHUNK_BYTES, position),
          rightHandle.read(rightChunk, 0, COMPARE_CHUNK_BYTES, position)
        ])
        if (leftRead.bytesRead !== rightRead.bytesRead) return false
        if (leftRead.bytesRead === 0) return true
        const length = leftRead.bytesRead
        if (!leftChunk.subarray(0, length).equals(rightChunk.subarray(0, length))) return false
        position += length
      }
    } finally {
      await rightHandle.close()
    }
  } finally {
    await leftHandle.close()
  }
}

/**
 * Whether two entries hold the same thing: files with the same bytes, links with the same
 * target, directories with the same names holding the same things. False when they cannot
 * be compared.
 */
const isSameContent = async (left: string, right: string): Promise<boolean> => {
  try {
    const [leftStat, rightStat] = await Promise.all([lstat(left), lstat(right)])
    if (leftStat.isFile() && rightStat.isFile()) {
      return leftStat.size === rightStat.size && (await haveSameBytes(left, right))
    }
    if (leftStat.isSymbolicLink() && rightStat.isSymbolicLink()) {
      return (await readlink(left)) === (await readlink(right))
    }
    if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false
    const [leftNames, rightNames] = await Promise.all([readdir(left), readdir(right)])
    if (leftNames.length !== rightNames.length) return false
    const inRight = new Set(rightNames)
    for (const name of leftNames) {
      if (!inRight.has(name)) return false
      if (!(await isSameContent(join(left, name), join(right, name)))) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Whether two paths of the same name are one directory entry, because their folders are one
 * folder (one is a link to the other, or they differ in letter case on a volume that ignores
 * it). False when that cannot be told.
 */
const isSameEntry = async (left: string, right: string): Promise<boolean> => {
  if (basename(left) !== basename(right)) return false
  try {
    const [leftFolder, rightFolder] = await Promise.all([
      realpath(dirname(left)),
      realpath(dirname(right))
    ])
    return leftFolder === rightFolder
  } catch {
    return false
  }
}

/**
 * Copy an entry (a file or a whole directory) to a name that is free. The copy is made under
 * a hidden name first and renamed when complete, so a copy that was interrupted never sits
 * under the real name looking like a finished one.
 */
const copyEntry = async (from: string, to: string): Promise<void> => {
  const partial = join(dirname(to), `.${basename(to)}${COPY_IN_PROGRESS_SUFFIX}`)
  await rm(partial, { recursive: true, force: true })
  try {
    await cp(from, partial, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true
    })
    if (await lstatOrNull(to)) throw new Error(`${to} appeared while it was being copied`)
    await rename(partial, to)
  } catch (cause) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined)
    throw cause
  }
}

/** Move an entry to a name that is free: a rename, or a copy and a removal across volumes. */
const moveEntry = async (from: string, to: string, ops: ClaudeStateFileOps): Promise<void> => {
  try {
    await ops.rename(from, to)
  } catch (cause) {
    if (codeOf(cause) !== 'EXDEV') throw cause
    await copyEntry(from, to)
    await rm(from, { recursive: true, force: true })
  }
}

/** What happened to the entries of one folder that could not simply be moved. */
interface MergeOutcome {
  /** Entries the destination already has under the same name, with other content. */
  readonly conflicts: string[]
  /** Entries that could not be moved or copied, each with the reason. */
  readonly failed: string[]
  /** Sessions of a shared folder that do not record where they were started. */
  readonly unattributed: Set<string>
}

interface MergeContext {
  readonly ops: ClaudeStateFileOps
  readonly outcome: MergeOutcome
  /** Creates the destination folder the first time something goes into it. */
  readonly ensureDestination: () => Promise<void>
}

/**
 * Bring one entry over to a destination that may already have it. `keepSource` leaves the
 * source in place (a copy): for what a project that did not move still reads.
 */
const transferEntry = async (
  from: string,
  to: string,
  label: string,
  keepSource: boolean,
  context: MergeContext
): Promise<void> => {
  try {
    if (await lstatOrNull(to)) {
      // One entry under two names: it is where it should be, and removing "the old one"
      // would remove it.
      if (await isSameEntry(from, to)) return
      // Never overwrite. The same content at both ends is an entry that already arrived (a
      // copy made earlier, a run that was interrupted): only the leftover is removed.
      if (!(await isSameContent(from, to))) context.outcome.conflicts.push(label)
      else if (!keepSource) await rm(from, { recursive: true, force: true })
      return
    }
    await context.ensureDestination()
    if (keepSource) await copyEntry(from, to)
    else await moveEntry(from, to, context.ops)
  } catch (cause) {
    context.outcome.failed.push(`${label} (${detailOf(cause)})`)
  }
}

/**
 * `memory/` is merged one level deep: what the destination lacks comes over, what it has
 * stays as it is. Copied, not moved, while another project still reads the old folder.
 */
const mergeMemory = async (
  from: string,
  to: string,
  keepSource: boolean,
  context: MergeContext
): Promise<void> => {
  const existing = await lstatOrNull(to)
  if (!existing) {
    await transferEntry(from, to, MEMORY_DIR, keepSource, context)
    return
  }
  if (!(await isDirectory(to))) {
    context.outcome.conflicts.push(MEMORY_DIR)
    return
  }
  let entries: Dirent[]
  try {
    entries = await readdir(from, { withFileTypes: true })
  } catch (cause) {
    context.outcome.failed.push(`${MEMORY_DIR} (${detailOf(cause)})`)
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    await transferEntry(
      join(from, entry.name),
      join(to, entry.name),
      `${MEMORY_DIR}/${entry.name}`,
      keepSource,
      context
    )
  }
  if (!keepSource) await rmdir(from).catch(() => undefined)
}

/**
 * Whether a recorded working directory is one of the old paths. A session that was resumed
 * records where the agent stood at that moment, which may be a folder inside the project.
 */
const startedIn = (oldSpellings: ReadonlySet<string>, recordedCwd: string): boolean => {
  const cwd = recordedCwd.normalize('NFC')
  for (const spelling of oldSpellings) {
    if (isSameOrAncestorPath(spelling, cwd)) return true
  }
  return false
}

/** The session an entry belongs to: `<id>.jsonl` and the directory `<id>` beside it. */
const sessionIdOf = (entry: Dirent): string | null => {
  if (entry.isDirectory()) return entry.name
  return entry.name.endsWith(TRANSCRIPT_EXTENSION)
    ? entry.name.slice(0, -TRANSCRIPT_EXTENSION.length)
    : null
}

const moveFolder = async (
  root: string,
  plan: FolderMove,
  isSharedWithRegistered: (derivedName: string) => Promise<boolean>,
  ops: ClaudeStateFileOps
): Promise<string[]> => {
  if (plan.fromName.length > DERIVED_NAME_MAX) {
    const cutName = plan.fromName.slice(0, DERIVED_NAME_MAX)
    const candidates = (await readdir(root)).filter((name) => name.startsWith(cutName))
    if (candidates.length === 0) return []
    return [
      `Claude's history for ${plan.from} was left where it is: the path is too long for the app to tell which folder under ${root} holds it. Sessions started there before the move will not resume in the new place.`
    ]
  }
  const source = join(root, plan.fromName)
  const sourceStat = await lstatOrNull(source)
  if (!sourceStat) return []
  if (!sourceStat.isDirectory()) {
    return [`Claude's history folder ${source} is not a plain folder, so it was left where it is.`]
  }
  if (plan.toName.length > DERIVED_NAME_MAX) {
    return [
      `Claude's history for ${plan.from} was left in ${source}: ${plan.to} is too long a path for the app to work out the folder name Claude will use for it. Sessions started before the move will not resume in the new place.`
    ]
  }
  const destination = join(root, plan.toName)
  // Two names that differ in letter case only are one folder on a volume that ignores case
  // (and a link can make them one anywhere): Claude finds it under the new name as it is,
  // and treating it as a second folder would compare every entry with itself.
  if (isSameFolder(source, destination)) return []
  const shared = plan.sharedWithAnotherMove || (await isSharedWithRegistered(plan.fromName))

  if (!shared && !(await lstatOrNull(destination))) {
    try {
      await ops.rename(source, destination)
      return []
    } catch (cause) {
      // Another volume, or Claude created the destination just now: entry by entry instead.
      if (!MERGE_INSTEAD_CODES.has(codeOf(cause))) throw cause
    }
  }
  if ((await lstatOrNull(destination)) && !(await isDirectory(destination))) {
    return [
      `Claude's history for ${plan.from} was left in ${source}: ${destination} is in the way and is not a folder.`
    ]
  }

  const outcome: MergeOutcome = { conflicts: [], failed: [], unattributed: new Set() }
  let destinationReady = false
  const context: MergeContext = {
    ops,
    outcome,
    ensureDestination: async () => {
      if (destinationReady) return
      await mkdir(destination, { recursive: true })
      destinationReady = true
    }
  }
  const recordedCwds = new Map<string, string | null>()
  const recordedCwdOf = async (sessionId: string): Promise<string | null> => {
    if (!recordedCwds.has(sessionId)) {
      const transcript = `${sessionId}${TRANSCRIPT_EXTENSION}`
      // A run that was interrupted may have brought the transcript over already and left
      // the session's directory behind: the transcript at the destination speaks for it.
      const cwd =
        (await readRecordedCwd(join(source, transcript))) ??
        (await readRecordedCwd(join(destination, transcript)))
      recordedCwds.set(sessionId, cwd)
    }
    return recordedCwds.get(sessionId) ?? null
  }

  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.name === MEMORY_DIR && entry.isDirectory()) {
      await mergeMemory(from, to, shared, context)
      continue
    }
    if (shared) {
      // Only what was started in the folder that moved goes with it; the rest belongs to
      // the project that stays, and so does anything that cannot be told apart.
      const sessionId = sessionIdOf(entry)
      if (sessionId === null) continue
      const cwd = await recordedCwdOf(sessionId)
      if (cwd === null) {
        outcome.unattributed.add(sessionId)
        continue
      }
      if (!startedIn(plan.oldSpellings, cwd)) continue
    }
    await transferEntry(from, to, entry.name, false, context)
  }
  // Succeeds only when nothing is left in it.
  await rmdir(source).catch(() => undefined)

  const sentences: string[] = []
  if (outcome.failed.length > 0) {
    sentences.push(
      `Some of Claude's history for ${plan.from} could not be moved to ${destination} and is still in ${source}: ${listOf(outcome.failed)}.`
    )
  }
  if (outcome.conflicts.length > 0) {
    sentences.push(
      `Claude already had ${listOf(outcome.conflicts)} in ${destination}, so the older ${outcome.conflicts.length === 1 ? 'copy is' : 'copies are'} still in ${source}. Compare them before deleting the older ones.`
    )
  }
  if (outcome.unattributed.size > 0) {
    const count = outcome.unattributed.size
    sentences.push(
      `${count} Claude ${count === 1 ? 'session' : 'sessions'} in ${source} could not be matched to ${plan.from} or to the other project that shares that folder, and stayed there.`
    )
  }
  return sentences
}

/**
 * Move Claude's history of every moved directory to the folder named after its new path, in
 * every root. Resolves with one sentence per thing a person should look at; never rejects.
 * Safe to run twice: what already arrived is left alone, and nothing at a destination is ever
 * overwritten.
 *
 * Per directory and root: when the destination folder does not exist and no other registered
 * path derives the same folder name, the folder is renamed. Otherwise its entries are moved
 * one by one when the destination lacks them: every entry when the folder is this directory's
 * alone, only the sessions whose transcript records the old path (or a folder inside it) as
 * working directory when another registered path shares it. `memory/` is merged one level
 * deep, and copied instead of moved while the folder is shared. An entry the destination
 * already holds with the same content counts as moved; one it holds with other content stays
 * where it is and is named in a sentence. The old folder is removed once it is empty. A path
 * too long for its folder name to be known is not guessed at: its history stays, with a
 * sentence saying so.
 */
export const moveClaudeTranscripts = async (
  input: MoveClaudeTranscriptsInput,
  ops: ClaudeStateFileOps = { rename }
): Promise<string[]> => {
  const warnings: string[] = []
  try {
    const plans = planFolderMoves(input.moves)
    if (plans.length === 0) return warnings
    const moved = new Set(input.moves.map((move) => move.from))
    // Worked out the first time a folder to move is found: most projects have none.
    let registeredNames: Promise<ReadonlySet<string>> | null = null
    const isSharedWithRegistered = async (derivedName: string): Promise<boolean> => {
      registeredNames ??= folderNamesOf(input.otherRegisteredPaths, moved)
      return (await registeredNames).has(folderNameKey(derivedName))
    }
    for (const root of new Set(input.roots.map((entry) => resolve(entry)))) {
      if (!(await isDirectory(root))) continue
      for (const plan of plans) {
        try {
          warnings.push(...(await moveFolder(root, plan, isSharedWithRegistered, ops)))
        } catch (cause) {
          warnings.push(
            `Claude's history for ${plan.from} could not be moved under ${root}: ${detailOf(cause)}`
          )
        }
      }
    }
  } catch (cause) {
    warnings.push(`Claude's session history could not be moved: ${detailOf(cause)}`)
  }
  return warnings
}
