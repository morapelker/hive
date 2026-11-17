// The read-only half of the move service's live bindings: the database port, the filesystem
// port and the folders in effect. Enough to count the projects still in a folder used before
// (`countLeftBehind`), which Settings asks for every time it opens.
//
// Kept apart from `live-deps.ts` on purpose: this module pulls in nothing but the setting and
// the filesystem port, so asking for that count never loads git, the watchers, the terminals
// or the boards.
import type { DatabaseService } from '../../db'
import { previousDevFolders, resolveDevFolder } from './dev-folder-settings'
import { createMoveProjectsFs } from './fs-ports'
import type { MoveProjectsDb, MoveProjectsDeps } from './types'

/**
 * The move service's database port over a `DatabaseService`. The two pending-move methods
 * carry the feature's name on the service and a shorter one on the port; the rest are the
 * service's own methods.
 */
export const createMoveProjectsDbPort = (db: DatabaseService): MoveProjectsDb => ({
  getProject: (id) => db.getProject(id),
  getAllProjects: () => db.getAllProjects(),
  getProjectByPath: (path) => db.getProjectByPath(path),
  getWorktreesByProject: (projectId) => db.getWorktreesByProject(projectId),
  namesRegisteredInside: (folderSpellings, exceptProjectId) =>
    db.namesRegisteredInside(folderSpellings, exceptProjectId),
  relocateProject: (input) => db.relocateProject(input),
  readPendingMove: () => db.readPendingDevFolderMove(),
  clearPendingMove: () => db.clearPendingDevFolderMove()
})

export interface LiveMoveQueryOptions {
  /** Stands in for the home directory (the default dev folder is inside it). */
  readonly homeDir?: string
}

/**
 * What `countLeftBehind` needs, bound to the app. `folders` reads the setting on every call
 * and never throws: a setting that cannot be read is the default folder with none before it.
 */
export const createLiveMoveQueryDeps = (
  db: DatabaseService,
  options: LiveMoveQueryOptions = {}
): Pick<MoveProjectsDeps, 'db' | 'fs' | 'folders'> => ({
  db: createMoveProjectsDbPort(db),
  fs: createMoveProjectsFs(),
  folders: () => ({
    devFolder: resolveDevFolder(db, options.homeDir),
    previousFolders: previousDevFolders(db, options.homeDir)
  })
})
