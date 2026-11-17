// What this window reloads after "Move projects" moved a project, so the project shows up
// where it is now without a restart. Nothing tells the window what a move changed in the
// database: the window that ran the move has to reload what it holds, in an order that never
// leaves a view asking for a folder that is gone.
//
// The stores' loaders keep a failed load to themselves (they record it and resolve), so
// nothing here can tell a reload that failed from one that worked. Each step still runs in
// its own try: a step that does throw must not cost the steps after it.

import type { DevFolderMoveResult } from '@shared/types/dev-folder'
import type { DocumentRun } from '@shared/types/document-flow'
import { reloadBoard } from '@/lib/board-reload'
import { parseMemberProjectIds } from '@/lib/connection-project'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useFileTreeStore } from '@/stores/useFileTreeStore'
import { tabAbsolutePath, useFileViewerStore } from '@/stores/useFileViewerStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { isSameOrInsidePath, movedPathFor, type MovedPath } from './moved-paths'

export { isSameOrInsidePath, movedPathFor } from './moved-paths'
export type { MovedPath } from './moved-paths'

// The data-project store is reached through a glob, when it is needed, so this module does not
// carry the store and its RPC client along. What comes back is read as what it may be.
interface DataProjectStoreModule {
  useDataProjectStore?: {
    getState?: () => { loaded?: unknown; load?: unknown } | undefined
  }
}
const DATA_PROJECT_STORE_PATH = '../../stores/useDataProjectStore.ts'
// Typed locally: the web tsconfig has no vite/client types (Vite rewrites the call at build).
const DATA_PROJECT_STORE_MODULES = (
  import.meta as ImportMeta & {
    glob: <T>(pattern: string) => Record<string, (() => Promise<T>) | undefined>
  }
).glob<DataProjectStoreModule>('../../stores/useDataProjectStore.ts')

const attempt = async (what: string, run: () => unknown): Promise<void> => {
  try {
    await run()
  } catch (error) {
    console.error(`[dev-folder] could not refresh ${what} after a move`, error)
  }
}

// The answer of an RPC is typed, not checked: read the list as what it may be.
const movedPathsOf = (result: DevFolderMoveResult): MovedPath[] => {
  const paths: unknown = result.movedPaths
  if (!Array.isArray(paths)) return []
  return paths.filter(
    (entry): entry is MovedPath =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.from === 'string' &&
      typeof entry.to === 'string' &&
      entry.from.length > 0 &&
      entry.from !== entry.to
  )
}

const isInMovedFolder = (path: string | null | undefined, moves: readonly MovedPath[]): boolean =>
  !!path && moves.some((move) => isSameOrInsidePath(path, move.from))

// The project and the connection projects it is a member of. A move rewrites the tickets and
// the runs of all of them: those of a connection project name the folders of its members.
const projectsNaming = (projectId: string): string[] => {
  const ids = [projectId]
  for (const project of useProjectStore.getState().projects) {
    if (
      project.id !== projectId &&
      project.kind === 'connection' &&
      parseMemberProjectIds(project.member_project_ids).includes(projectId)
    ) {
      ids.push(project.id)
    }
  }
  return ids
}

const reloadWorktrees = async (projectId: string, moves: readonly MovedPath[]): Promise<void> => {
  const load = (): Promise<void> =>
    useWorktreeStore.getState().loadWorktrees(projectId, { force: true })
  await load()
  // loadWorktrees answers with a load that is already under way before it looks at `force`,
  // and that load may have read the rows before the move. Its rows then still show a folder
  // that moved: read them once more, now that nothing is under way.
  const rows = useWorktreeStore.getState().worktreesByProject.get(projectId) ?? []
  if (rows.some((row) => isInMovedFolder(row.path, moves))) await load()
}

// Where the rows say the project is: its own row and the rows of its worktrees, by id. Never
// throws: this is read before the first step, and a store that holds something else than rows
// only says nothing about where the project is.
const rowPathsOf = (projectId: string): Map<string, string> => {
  const paths = new Map<string, string>()
  try {
    const project = useProjectStore.getState().projects.find((row) => row.id === projectId)
    if (project?.path) paths.set(`project:${project.id}`, project.path)
    for (const row of useWorktreeStore.getState().worktreesByProject.get(projectId) ?? []) {
      if (row.path) paths.set(`worktree:${row.id}`, row.path)
    }
  } catch {
    // What was read so far stands.
  }
  return paths
}

// The folders the reloaded rows show at another place than before, and that `known` does not
// already take there. The answer of a move names what moved; a move whose call got no answer
// names nothing, and the rows are then the only account of it.
const movesSeenInRows = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  known: readonly MovedPath[]
): MovedPath[] => {
  const seen: MovedPath[] = []
  for (const [id, from] of before) {
    const to = after.get(id)
    if (!to || to === from) continue
    if (movedPathFor(from, [...known, ...seen]) === to) continue
    seen.push({ from, to })
  }
  return seen
}

// A tab of a moved folder shows a file that is no longer at that path, also when the tab
// belongs to another selection than the current one (a connection, a diff of another
// worktree). Those tabs are closed, and what was typed in them and not saved goes with them:
// the file they would be saved to is gone. Every other tab stays as it is, with its edits.
const closeTabsOfMovedFolders = (moves: readonly MovedPath[]): void => {
  if (moves.length === 0) return
  useFileViewerStore
    .getState()
    .closeTabsWhere(
      (_key, tab) =>
        isInMovedFolder(tabAbsolutePath(tab), moves) ||
        (tab.type === 'diff' && isInMovedFolder(tab.worktreePath, moves))
    )
  // A diff can be on screen without a tab of its own.
  const viewer = useFileViewerStore.getState()
  if (isInMovedFolder(viewer.activeDiff?.worktreePath, moves)) viewer.clearActiveDiff()
}

// Only boards that are loaded: the others load, with the new paths, when they are opened.
// `first` come first: the boards that name the project, and those the move said it rewrote
// a ticket of. A ticket of any project can name the folder that moved (the document a run
// was made from, a file it attaches) and the move repoints those too, so `all` reloads every
// other loaded board as well.
const reloadLoadedBoards = async (first: readonly string[], all: boolean): Promise<void> => {
  const ids = new Set([...first, ...(all ? useKanbanStore.getState().tickets.keys() : [])])
  for (const id of ids) {
    if (!useKanbanStore.getState().tickets.has(id)) continue
    await attempt('a board', () => reloadBoard(id))
  }
}

// The projects the move said it rewrote a ticket of; null when it did not say.
const rewrittenBoardsOf = (result: DevFolderMoveResult): string[] | null => {
  const ids: unknown = result.boardProjectIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : null
}

const runNamesMovedFolder = (run: DocumentRun, moves: readonly MovedPath[]): boolean =>
  isInMovedFolder(run.source_path, moves) ||
  isInMovedFolder(run.integration_worktree_path, moves) ||
  (run.members ?? []).some(
    (member) =>
      isInMovedFolder(member.project_path, moves) ||
      isInMovedFolder(member.integration_worktree_path, moves)
  )

// Only runs that are loaded: the lists that were fetched, then every run still in the store
// that names a moved folder (one opened on its own, or one of another project whose document
// sits in the folder that moved).
const reloadLoadedRuns = async (projectId: string, moves: readonly MovedPath[]): Promise<void> => {
  for (const id of projectsNaming(projectId)) {
    if (!useDocumentFlowStore.getState().loadedProjects[id]) continue
    await attempt('the document runs', () => useDocumentFlowStore.getState().loadRuns(id))
  }
  for (const detail of Object.values(useDocumentFlowStore.getState().runsById)) {
    if (!runNamesMovedFolder(detail.run, moves)) continue
    await attempt('a document run', () => useDocumentFlowStore.getState().refreshRun(detail.run.id))
  }
}

// Only when this window has listed the database connections: the list is read, with the new
// paths, when it is first shown. A move rewrites the file path of a SQLite connection whose
// file sits in the project, and an edit form filled from the old list would save the old path
// back.
const reloadLoadedDataProjects = async (): Promise<void> => {
  const loadModule = DATA_PROJECT_STORE_MODULES[DATA_PROJECT_STORE_PATH]
  if (!loadModule) return
  const state = (await loadModule()).useDataProjectStore?.getState?.()
  if (state?.loaded !== true || typeof state.load !== 'function') return
  await (state.load as () => Promise<unknown>)()
}

/**
 * Run right after each project that moved, before the next one starts: a move can take
 * minutes, and until this ran the window still watches, polls and prompts in the folder the
 * project left. Never rejects.
 *
 * The order matters. The file tree goes first and in the same tick as the call: what the
 * person had expanded is filed under the new path before any view asks for it there. Then
 * the rows that carry the paths (projects, the project's worktrees, connections), then the
 * things that held a path of their own (file tabs, the boards, document runs).
 *
 * With nothing in `movedPaths` the rows of the project are reloaded and compared with what
 * they said before: a folder they now show somewhere else is followed like one the answer
 * named, and the database connections are read again as at the end of a run. That is what a
 * caller wants after a call whose outcome it does not know.
 *
 * `inRun` is for the project that just moved while more are to follow. The boards that name
 * the project and the boards the move rewrote a ticket of are reloaded now: a launch that
 * starts from a board in the middle of a long run must not send the old folder. Every other
 * board is left to `refreshAfterDevFolderRun`, which the run always ends with: a run over
 * hundreds of projects would otherwise reload every open board once per project. A move that
 * does not say which boards it rewrote gets every board reloaded, in a run as well.
 */
export const refreshAfterProjectMove = async (
  result: DevFolderMoveResult,
  options: { readonly inRun?: boolean } = {}
): Promise<void> => {
  try {
    const projectId = result.projectId
    let moves = movedPathsOf(result)
    const before = rowPathsOf(projectId)
    let seenInRows = false

    await attempt('the file tree', () => useFileTreeStore.getState().rekeyWorktreePaths(moves))
    await attempt('the projects', () => useProjectStore.getState().loadProjects())
    await attempt('the worktrees', () => reloadWorktrees(projectId, moves))
    await attempt('the file tree', () => {
      const seen = movesSeenInRows(before, rowPathsOf(projectId), moves)
      if (seen.length === 0) return
      seenInRows = true
      moves = [...moves, ...seen]
      useFileTreeStore.getState().rekeyWorktreePaths(seen)
    })
    await attempt('the connections', () => useConnectionStore.getState().loadConnections())
    await attempt('the file tabs', () => closeTabsOfMovedFolders(moves))
    const rewritten = rewrittenBoardsOf(result)
    await attempt('the boards', () =>
      reloadLoadedBoards(
        [...projectsNaming(projectId), ...(rewritten ?? [])],
        options.inRun !== true || rewritten === null
      )
    )
    await attempt('the document runs', () => reloadLoadedRuns(projectId, moves))
    // A run reads the database connections once, when it is over. A move the window only
    // learned about from the rows may have ended after that, or with no run going at all.
    if (seenInRows) {
      await attempt('the database connections', () => reloadLoadedDataProjects())
    }
  } catch (error) {
    console.error('[dev-folder] could not refresh the window after a move', error)
  }
}

/**
 * Run once when "Move projects" is over, however it ended: the lists every part of the window
 * reads, one last time, so a project whose move was cut short still shows where it is. Never
 * rejects.
 */
export const refreshAfterDevFolderRun = async (): Promise<void> => {
  await attempt('the projects', () => useProjectStore.getState().loadProjects())
  await attempt('the connections', () => useConnectionStore.getState().loadConnections())
  await attempt('the pinned list', () => usePinnedStore.getState().loadPinned())
  // Each project that moved reloaded the boards that name it and those it rewrote a ticket
  // of. Once for all the others: nothing in them changed, as far as the moves said.
  await attempt('the boards', () => reloadLoadedBoards([], true))
  await attempt('the database connections', () => reloadLoadedDataProjects())
}
