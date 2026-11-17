// The dev folder: where this Mac keeps the projects the app clones itself (a Teleport or
// launch-on-cloud receive, Discord /add-project), and what the clone dialogs start from.
// Settings › General sets it; "Move projects" brings the projects still in a folder used
// before over to it.
//
// Stored in its OWN settings row, never inside the `app_settings` blob: the window rewrites
// that blob as a whole, and a path that decides where clones land is only ever set through
// `settingsOps.setDevFolder`, which checks it. Pure, no Node imports: the renderer, the server
// child and the main process share it.

/** Settings row holding `StoredDevFolder` as JSON. */
export const DEV_FOLDER_SETTING_KEY = 'dev_folder'

/** The folder used while nothing is set. `~` is expanded by the process that reads it. */
export const DEFAULT_DEV_FOLDER = '~/hive-projects'

/**
 * Upper bound on the folders used before that are remembered. A sanity bound, not a policy:
 * the server forgets a folder once no project is left in it, so the list stays short.
 */
export const DEV_FOLDER_MAX_PREVIOUS = 20

/** What the settings row holds. */
export interface StoredDevFolder {
  /** Absolute path, or null while the default folder is in use. */
  path: string | null
  /**
   * Absolute paths of the folders used before, most recent first: where "Move projects" looks
   * for projects to bring over.
   */
  previousPaths: string[]
}

/** A POSIX absolute path, a Windows drive path or a UNC path. */
export const isAbsoluteFolderPath = (value: string): boolean =>
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')

const isBareRoot = (value: string): boolean =>
  /^[\\/]+$/.test(value) || /^[A-Za-z]:[\\/]*$/.test(value)

const cleanFolderPath = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return null
  if (!isAbsoluteFolderPath(value) || isBareRoot(value)) return null
  // A POSIX name may end in a backslash; only a Windows path loses trailing backslashes.
  const windows = !value.startsWith('/')
  const stripped = value.replace(windows ? /[\\/]+$/ : /\/+$/, '')
  return stripped.length === 0 || isBareRoot(stripped) ? null : stripped
}

/**
 * The stored value, whatever the row holds: a missing, hand-edited or pre-feature row reads as
 * the default folder with nothing before it. This guarantees shape only (strings that look
 * absolute, no bare root, no exact duplicates). The server applies the running platform's
 * rules on top: `resolveDevFolder` on every read, `setDevFolder` on every write, and both
 * compare folders by what they are on disk, not by spelling.
 */
export const parseStoredDevFolder = (raw: string | null | undefined): StoredDevFolder => {
  if (!raw) return { path: null, previousPaths: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { path: null, previousPaths: [] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { path: null, previousPaths: [] }
  }
  const record = parsed as { path?: unknown; previousPaths?: unknown }
  const path = cleanFolderPath(record.path)
  const previousPaths: string[] = []
  if (Array.isArray(record.previousPaths)) {
    for (const entry of record.previousPaths) {
      const previous = cleanFolderPath(entry)
      if (!previous || previous === path || previousPaths.includes(previous)) continue
      previousPaths.push(previous)
      if (previousPaths.length >= DEV_FOLDER_MAX_PREVIOUS) break
    }
  }
  return { path, previousPaths }
}

export const serializeStoredDevFolder = (stored: StoredDevFolder): string =>
  JSON.stringify({ path: stored.path, previousPaths: stored.previousPaths })

// ── RPC shapes (settingsOps.*) ─────────────────────────────────────────────────────────

/** `settingsOps.getDevFolder`. Every path is absolute, with `~` already expanded. */
export interface DevFolderState {
  /** The folder in effect. */
  path: string
  /** True while nothing is set and `path` is the default folder. */
  isDefault: boolean
  /** The default folder on this Mac (`~/hive-projects`, expanded). */
  defaultPath: string
  /** Whether `path` is a directory on disk right now. */
  exists: boolean
  /** Folders used before, most recent first; never the folder in effect. */
  previousPaths: string[]
  /**
   * Projects that still sit in a folder used before: how many, and in which folders. A cheap
   * count for the Settings row (no "is it busy" checks); the plan says what would happen to
   * each of them.
   */
  leftBehind: { count: number; folders: string[] }
}

/** `settingsOps.setDevFolder({ path })`: `path: null` goes back to the default folder. */
export type SetDevFolderResult =
  { success: true; state: DevFolderState } | { success: false; error: string }

/**
 * Why a project that sits in a folder used before is left there:
 * - `exists`: the dev folder already holds a folder (or a project) of that name
 * - `missing`: the project's folder is not on disk
 * - `busy`: something is running in the project (a session, a run, a script, a terminal, git)
 * - `unsupported`: it cannot be moved as one folder (registered through a symbolic link, a
 *   checkout that is itself a linked worktree, another project registered inside it, the dev
 *   folder inside it)
 * - `not-in-source`: only from `moveProjectToDevFolder`: the project is not (or no longer) in
 *   a folder used before, or the dev folder changed since the plan was made
 */
export type DevFolderMoveSkipReason =
  'exists' | 'missing' | 'busy' | 'unsupported' | 'not-in-source'

export interface DevFolderMoveCandidate {
  projectId: string
  projectName: string
  /** The folder used before that the project sits in (an entry of `DevFolderMovePlan.sources`). */
  source: string
  /** Where the project is now (`projects.path`). */
  fromPath: string
  /** Where it would go: `<dev folder>/<its folder name>`. */
  toPath: string
  /** null = it will be moved. */
  skipReason: DevFolderMoveSkipReason | null
  /** A sentence a person can act on when `skipReason` is set; null otherwise. */
  detail: string | null
}

/** `settingsOps.planDevFolderMove`: what "Move projects" would do right now. Read-only. */
export interface DevFolderMovePlan {
  /** The folder projects would move to. */
  devFolder: string
  /** The folders used before that still hold at least one project. */
  sources: string[]
  /** One entry per project in a source folder, in sidebar order. */
  candidates: DevFolderMoveCandidate[]
}

/** Params of `settingsOps.moveProjectToDevFolder`. */
export interface MoveProjectToDevFolderParams {
  projectId: string
  /** `toPath` of the plan row the person confirmed: the move is refused when it no longer holds. */
  expectedToPath: string
}

export type DevFolderMoveAction = 'moved' | 'skipped' | 'failed'

/** `settingsOps.moveProjectToDevFolder`: one project per call. Never rejects. */
export interface DevFolderMoveResult {
  projectId: string
  projectName: string
  action: DevFolderMoveAction
  fromPath: string
  /** The project's path after a move; where it would have gone otherwise (null if unknown). */
  toPath: string | null
  /** Set when `action` is 'skipped'. */
  skipReason: DevFolderMoveSkipReason | null
  /** Why it was skipped or what failed; null for a clean move. */
  detail: string | null
  /** Things that did not stop the move but need a look (worktree links, connection folders). */
  warnings: string[]
  /**
   * Every directory whose path changed, old → new, in the exact spellings the database held
   * before and holds now (`projects.path` / `worktrees.path`): the checkout, the linked
   * worktrees inside it, and the linked worktrees that sat next to it and moved with it.
   * Empty unless `action` is 'moved'. The window re-keys what it holds by path with these.
   */
  movedPaths: { from: string; to: string }[]
  /**
   * The projects whose tickets (or cards of a markdown board) the move rewrote because they
   * named a folder that moved: the project's own, and those of any other project. The window
   * reloads these boards right after the move; inside a run every other board waits for the
   * end of the run. Absent when the move did not report it: the window then reloads every
   * board it holds.
   */
  boardProjectIds?: string[]
}

/** RPC method names, shared by the server handlers and the renderer wrapper. */
export const DEV_FOLDER_RPC = {
  get: 'settingsOps.getDevFolder',
  set: 'settingsOps.setDevFolder',
  planMove: 'settingsOps.planDevFolderMove',
  moveProject: 'settingsOps.moveProjectToDevFolder'
} as const

// ── Shape guards ───────────────────────────────────────────────────────────────────────
// The window asks for these on mount, also where a test double answers something else. Check
// the shape, not truthiness.

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

export const isDevFolderState = (value: unknown): value is DevFolderState => {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Partial<DevFolderState>
  const leftBehind = state.leftBehind as Partial<DevFolderState['leftBehind']> | undefined
  return (
    typeof state.path === 'string' &&
    typeof state.isDefault === 'boolean' &&
    typeof state.defaultPath === 'string' &&
    typeof state.exists === 'boolean' &&
    isStringArray(state.previousPaths) &&
    typeof leftBehind === 'object' &&
    leftBehind !== null &&
    typeof leftBehind.count === 'number' &&
    isStringArray(leftBehind.folders)
  )
}

export const isDevFolderMovePlan = (value: unknown): value is DevFolderMovePlan => {
  if (typeof value !== 'object' || value === null) return false
  const plan = value as Partial<DevFolderMovePlan>
  return (
    typeof plan.devFolder === 'string' &&
    isStringArray(plan.sources) &&
    Array.isArray(plan.candidates) &&
    plan.candidates.every(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        typeof candidate.projectId === 'string' &&
        typeof candidate.fromPath === 'string' &&
        typeof candidate.toPath === 'string'
    )
  )
}

export const isDevFolderMoveResult = (value: unknown): value is DevFolderMoveResult => {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Partial<DevFolderMoveResult>
  return (
    typeof result.projectId === 'string' &&
    (result.action === 'moved' || result.action === 'skipped' || result.action === 'failed') &&
    Array.isArray(result.warnings) &&
    Array.isArray(result.movedPaths)
  )
}
