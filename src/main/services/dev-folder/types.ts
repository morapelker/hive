// Ports of the "move projects to the dev folder" service (move-projects.ts). The service is
// pure orchestration over these: tests hand it fakes or temp directories, the server child
// hands it the live ones (live-deps.ts). Runs in the server child: no `electron` import here
// or in anything these ports are bound to.
import type { Project, Worktree } from '../../db/types'

/** One directory whose absolute path changed. */
export interface PathMove {
  readonly from: string
  readonly to: string
}

/**
 * One directory that is moved on disk, with every spelling its old path is known by. The
 * database, git and Claude do not agree on spelling: a cloned project is stored as it was
 * joined (lexically), git reports worktrees by real path.
 */
export interface RelocationMove {
  /** The old path: as the database stores it first, then its real path when that differs. */
  readonly from: readonly string[]
  /** The new path (one spelling: the real path). */
  readonly to: string
}

/** Settings row holding `PendingDevFolderMove` while a move's follow-up steps are owed. */
export const DEV_FOLDER_PENDING_MOVE_KEY = 'dev_folder_pending_move'

/**
 * Written in the same transaction that repoints the project, removed once the follow-up steps
 * (worktree repair, Claude state, connection folders) have run. If the app quits in between,
 * the next start finishes them from this.
 */
export interface PendingDevFolderMove {
  readonly projectId: string
  /** `projects.path` before the move, as it was stored. */
  readonly fromPath: string
  /** Real path of `fromPath` before the move (null when it could not be resolved). */
  readonly fromRealPath: string | null
  /** `projects.path` now. */
  readonly toPath: string
  /** The directories that were moved on disk: the checkout first, then worktrees next to it. */
  readonly relocations: readonly RelocationMove[]
  /**
   * Moves to another volume only: the old folders that were copied and are still on disk until
   * the last step removes them. A start that finds one of them says so; it removes nothing.
   */
  readonly copiedFrom?: readonly string[]
}

export interface RelocateProjectInput {
  readonly projectId: string
  /** `projects.path` as read before the move: the transaction refuses when the row differs. */
  readonly expectedPath: string
  /** `relocations[0]` is the checkout; the rest are linked worktrees that move with it. */
  readonly relocations: readonly RelocationMove[]
  /** For the `~/…`, `$HOME/…` and `${HOME}/…` spellings of a path in scripts and commands. */
  readonly homeDir: string
  /** Stored as the `DEV_FOLDER_PENDING_MOVE_KEY` settings row inside the same transaction. */
  readonly pending: PendingDevFolderMove
  /**
   * Puts the folders in place. Called inside the transaction once every new value has been
   * computed and the write lock is held, before the first UPDATE. Synchronous. When it throws,
   * or anything after it throws, the transaction rolls back and the error is rethrown: the
   * caller then puts the folders back.
   */
  readonly place: () => void
}

/** What `DatabaseService.relocateProject` reports once its transaction has committed. */
export interface RelocateProjectResult {
  /** The project row as it is now (path = the new path). */
  readonly project: Project
  /** Every worktree row of the project whose path changed: the default one, nested and moved ones. */
  readonly worktrees: readonly { readonly id: string; readonly from: string; readonly to: string }[]
  /** How many ticket rows had a path rewritten (attachments, links, text). */
  readonly ticketsRewritten: number
  /** How many document run rows changed (the project's own, or one that names it). */
  readonly runsRewritten: number
  /** Whether a script or command (of this or another project) had the folder rewritten in it. */
  readonly scriptsRewritten: boolean
  /** Other projects whose row changed (a connection project's board config, a sibling's scripts). */
  readonly otherProjectIds: readonly string[]
  /** Data projects whose connection config pointed into the folder and was rewritten. */
  readonly dataProjectIds: readonly string[]
  /**
   * Every project that had a ticket rewritten: the moved one, its connection projects, and any
   * other project whose ticket named the folder. Absent means "not reported".
   */
  readonly ticketProjectIds?: readonly string[]
  /** The document runs that changed (of any project). Absent means "not reported". */
  readonly runIds?: readonly string[]
}

export interface MoveProjectsDb {
  readonly getProject: (id: string) => Project | null
  /** In sidebar order. */
  readonly getAllProjects: () => Project[]
  readonly getProjectByPath: (path: string) => Project | null
  /** Every row of the project, archived ones included. */
  readonly getWorktreesByProject: (projectId: string) => Worktree[]
  /**
   * Names of what else is registered inside the given folder (any of its spellings), strictly
   * below it: other projects, and worktrees of other projects. Empty when nothing is.
   */
  readonly namesRegisteredInside: (
    folderSpellings: readonly string[],
    exceptProjectId: string
  ) => string[]
  /**
   * Point the project (and everything in the database that names a path inside what moved) at
   * its new place. Synchronous, one transaction, publishes no `db:changed` event: the caller
   * publishes once the folder is usable again. Throws when the project is gone, is not where
   * `expectedPath` says, or the new path belongs to another project; nothing is changed then.
   */
  readonly relocateProject: (input: RelocateProjectInput) => RelocateProjectResult
  readonly readPendingMove: () => PendingDevFolderMove | null
  readonly clearPendingMove: () => void
}

/** What `lstat` finds at a path: null when nothing is there (a dangling symlink is a 'symlink'). */
export type PathKind = 'dir' | 'symlink' | 'file' | 'other'

/** Why an old copy is still on disk after a move to another volume. */
export interface LeftoverSource {
  readonly path: string
  /** 'changed': it was written to after it was copied, so it was kept. 'failed': removing it failed. */
  readonly reason: 'changed' | 'failed'
  readonly detail: string | null
}

/**
 * A directory move that has done everything slow and can now be placed in one synchronous
 * step. Same volume: nothing was done yet, `place` is one rename. Another volume: the folder
 * has been copied in full to a hidden folder next to `to` and checked against the source;
 * `place` renames that copy into place and the source stays until `discardSource`.
 */
export interface PreparedMove {
  readonly from: string
  readonly to: string
  /** True when the folder went to another volume (the source is still in place). */
  readonly copied: boolean
  /**
   * Put `to` in place. Synchronous. Throws, changing nothing, when something is at `to`, when
   * the rename fails, or (copied) when the source's git state changed since it was copied.
   */
  readonly place: () => void
  /** Take back a `place()` that succeeded. Synchronous; throws when the folder cannot be put back. */
  readonly undo: () => void
  /** Not placed (or undone): remove what preparing left behind. Never rejects. */
  readonly abort: () => Promise<void>
  /**
   * Placed and everything after it done: remove the old copy (copied moves only; null at once
   * otherwise). The old copy is compared with what was copied first and is kept when it
   * changed. Never rejects.
   */
  readonly discardSource: () => Promise<LeftoverSource | null>
}

export interface MoveProjectsFs {
  /** `lstat`, as a kind; null when nothing is at the path. */
  readonly kind: (path: string) => PathKind | null
  /** Real path in its on-disk spelling (`realpathSync.native`), or null when it cannot be resolved. */
  readonly canonical: (path: string) => string | null
  /**
   * Whether two paths are the same directory: by device and inode when both exist (so a
   * symlink, or another letter case on a case-insensitive volume, is the same folder), by
   * resolved spelling otherwise.
   */
  readonly sameFolder: (a: string, b: string) => boolean
  readonly mkdirp: (dir: string) => Promise<void>
  /**
   * Get ready to move the directory `from` to `to` (`to` must not exist, its parent must).
   * Rejects, leaving nothing behind, when the folder cannot be copied in full.
   */
  readonly prepareMove: (from: string, to: string) => Promise<PreparedMove>
  /**
   * Whether `prepareMove(from, to)` would copy (another volume) instead of rename. `to` and its
   * parent need not exist yet: the nearest folder above `to` that exists decides. Synchronous,
   * never throws (false when it cannot tell). A port without it is taken to rename.
   */
  readonly copies?: (from: string, to: string) => boolean
}

export interface LinkedWorktree {
  /** As git records it (a real path). */
  readonly path: string
  /** git cannot find it where it is recorded: `git worktree prune` would drop it. */
  readonly prunable: boolean
  readonly locked: boolean
}

export interface MoveProjectsGit {
  /**
   * The linked worktrees registered in the repository at `repoPath` (the main checkout itself
   * is not listed). Null when git cannot say.
   */
  readonly listLinkedWorktrees: (repoPath: string) => Promise<LinkedWorktree[] | null>
  /**
   * `git worktree repair` run in the moved main checkout, naming every linked worktree that is
   * on disk at `worktreePaths` (their paths NOW): re-links each of them to the checkout's new
   * place and the checkout to those that moved. Rejects when git refuses. git also exits 0
   * without having fixed everything, so the caller lists the worktrees again afterwards.
   */
  readonly repairWorktrees: (repoPath: string, worktreePaths: readonly string[]) => Promise<void>
  /**
   * Submodules checked out in linked worktrees keep relative links through the main checkout's
   * old place, which `git worktree repair` does not rewrite. Rewrites them; resolves with one
   * sentence per worktree it could not fix. Never rejects.
   */
  readonly repairLinkedSubmodules: (repoPath: string, oldRepoPath: string) => Promise<string[]>
  /**
   * What git is in the middle of in the checkout ("a merge", "a rebase", "another git
   * command"), or null. Synchronous: read from the files git leaves in `.git`.
   */
  readonly operationInProgress: (repoPath: string) => string | null
  /**
   * Whether the worktree folder at `worktreePath` points back at the repository at `repoPath`:
   * its `.git` file names a folder inside `<repoPath>/.git/worktrees` that exists. Synchronous,
   * never throws. `git worktree list` only shows the other direction (repository to worktree),
   * so a worktree that still points at an old copy of the repository is not `prunable` there.
   * A port without it is taken to answer true.
   */
  readonly linksBack?: (repoPath: string, worktreePath: string) => boolean
}

/** A project that has moved: what the follow-up steps and the events need. */
export interface MovedProject {
  /** The project row after the move. */
  readonly project: Project
  /** `projects.path` before the move, exactly as it was stored. */
  readonly fromPath: string
  /** Real path of `fromPath` taken before the move (null when it could not be resolved). */
  readonly fromRealPath: string | null
  /** `projects.path` now. */
  readonly toPath: string
  /** The directories moved on disk: the checkout first, then the worktrees that sat next to it. */
  readonly relocations: readonly RelocationMove[]
  /**
   * Every directory that is keyed by its exact path somewhere, old → new: each spelling of the
   * checkout and of each moved worktree, and each linked worktree inside one of them. For
   * Claude's transcript folders and config entries, the port registry, per-path settings.
   */
  readonly moves: readonly PathMove[]
  /** The worktree rows whose path changed. */
  readonly worktrees: RelocateProjectResult['worktrees']
  /** The project's worktree rows as they are now (all of them). */
  readonly allWorktrees: readonly Worktree[]
  readonly ticketsRewritten: number
  readonly runsRewritten: number
  readonly otherProjectIds: readonly string[]
  readonly dataProjectIds: readonly string[]
  /** As in `RelocateProjectResult`. Absent (a move finished after a restart) means none. */
  readonly ticketProjectIds?: readonly string[]
  /** As in `RelocateProjectResult`. Absent (a move finished after a restart) means none. */
  readonly runIds?: readonly string[]
}

export interface BusyProbeOptions {
  /**
   * The move goes to another volume: the folders are copied and the old ones removed. What only
   * sits in a folder (a terminal at its prompt) survives a rename but not this, so it counts
   * as busy too.
   */
  readonly copies?: boolean
}

/**
 * One reading of everything that is running, asked about one project at a time. `movingPaths`
 * are the directories that would move (every spelling). Returns a sentence that names the cause
 * and what to do about it ("A terminal in this project is running a command. Stop it, then
 * check again."), or null.
 */
export type BusyProbe = (
  project: Project,
  worktrees: readonly Worktree[],
  movingPaths: readonly string[],
  options?: BusyProbeOptions
) => string | null

export interface MoveProjectsDeps {
  readonly db: MoveProjectsDb
  readonly fs: MoveProjectsFs
  readonly git: MoveProjectsGit
  /** The dev folder in effect and the folders used before it (absolute, `~` expanded). */
  readonly folders: () => {
    readonly devFolder: string
    readonly previousFolders: readonly string[]
  }
  readonly homeDir: string
  /**
   * Take one reading of what is running (sessions, runs, scripts, terminals, agent CLIs). A
   * check that could not be made counts as busy when moving would be unsafe without it, and
   * says so. Never rejects.
   */
  readonly busy: () => Promise<BusyProbe>
  /**
   * Just before the folder moves: stop what would misread the moment the folder is gone (the
   * markdown board watch). Never rejects.
   */
  readonly beforeMove: (project: Project) => Promise<void>
  /** The move did not happen after `beforeMove` ran: put back what it stopped. Never rejects. */
  readonly afterAbort: (project: Project) => Promise<void>
  /**
   * Synchronous, in the same tick as the commit that repointed the project: what must not be
   * seen pointing at the old place even for a moment (the board index, connection symlinks,
   * the port registry). Returns one sentence per step that failed; never throws.
   */
  readonly onRelocated: (moved: MovedProject) => string[]
  /** Reconcile the project's worktree rows with git, in its new place (`syncWorktreesOp`). */
  readonly syncWorktrees: (params: {
    projectId: string
    projectPath: string
  }) => Promise<{ readonly success: boolean; readonly error?: string }>
  /**
   * Everything else outside the database and git that named the old folder: Claude's
   * transcript folders and per-folder config entries, connection instruction files, board and
   * git watchers. Best effort: resolves with one sentence per step that failed, never rejects.
   * Safe to run twice.
   */
  readonly afterMove: (moved: MovedProject) => Promise<string[]>
  /** Publish the `db:changed` events of the move, so every window reloads. */
  readonly publishChanged: (moved: MovedProject) => void
  readonly log?: (message: string, detail?: Record<string, unknown>) => void
}
