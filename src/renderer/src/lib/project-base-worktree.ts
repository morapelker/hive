/**
 * Opens a project on its base: a git project's default "(no-worktree)" worktree, or a
 * connection project's base instance (its members' default worktrees connected together). The
 * base is selected the way a click on its own row in the sidebar selects it (WorktreeItem,
 * ConnectionItem), so the main pane and the Changes / Files / Diff panels follow the project.
 *
 * For the ways of opening a project that do not start from one of its worktrees: the one-line
 * rows of the sidebar's Recent and Active elsewhere sections, and the "Go to project" switcher.
 */
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { findBaseInstanceConnection } from '@/lib/connection-project'

export interface BaseOpenableProject {
  id: string
  /** 'git' when absent. */
  kind?: 'git' | 'connection'
}

/**
 * Selects the project and its base. Returns whether the base was selected.
 *
 * A project that was never expanded may not have its worktrees in the store yet (nor a
 * connection project its instances): they are read first, with no git. When the user selects
 * something else while that read is in flight, their selection stands.
 *
 * While a connection is being put together only the project is selected, like the worktree rows
 * that then only tick a checkbox. A connection project whose base instance cannot be found
 * shows its own board, with no worktree or connection selected.
 */
export async function openProjectOnBase(project: BaseOpenableProject): Promise<boolean> {
  useProjectStore.getState().selectProject(project.id)
  const buildingConnection = useConnectionStore.getState().connectionModeActive
  if (project.kind === 'connection') return openOnBaseInstance(project.id, buildingConnection)
  if (buildingConnection) return false
  return openOnDefaultWorktree(project.id)
}

async function openOnDefaultWorktree(projectId: string): Promise<boolean> {
  let base = useWorktreeStore.getState().getDefaultWorktree(projectId)
  if (!base) {
    const worktreeBefore = useWorktreeStore.getState().selectedWorktreeId
    const connectionBefore = useConnectionStore.getState().selectedConnectionId
    await useWorktreeStore.getState().loadWorktrees(projectId, { force: true })
    if (useProjectStore.getState().selectedProjectId !== projectId) return false
    if (useWorktreeStore.getState().selectedWorktreeId !== worktreeBefore) return false
    if (useConnectionStore.getState().selectedConnectionId !== connectionBefore) return false
    base = useWorktreeStore.getState().getDefaultWorktree(projectId)
  }
  if (!base) return false

  useWorktreeStore.getState().selectWorktree(base.id)
  useWorktreeStatusStore.getState().clearWorktreeUnread(base.id)
  return true
}

async function openOnBaseInstance(
  projectId: string,
  buildingConnection: boolean
): Promise<boolean> {
  let base = buildingConnection ? null : findBaseInstanceConnection(projectId)
  if (!base) {
    // The project's own board holds the main pane meanwhile, and when there is no base.
    useConnectionStore.getState().selectConnection(null)
    useWorktreeStore.getState().selectWorktreeOnly(null)
    if (buildingConnection) return false
    // Not loaded yet, or only just created by the backend (listing heals a missing base).
    await useConnectionStore.getState().loadConnections()
    if (useProjectStore.getState().selectedProjectId !== projectId) return false
    if (useWorktreeStore.getState().selectedWorktreeId) return false
    if (useConnectionStore.getState().selectedConnectionId) return false
    base = findBaseInstanceConnection(projectId)
  }
  if (!base) return false

  useConnectionStore.getState().selectConnection(base.id)
  return true
}
