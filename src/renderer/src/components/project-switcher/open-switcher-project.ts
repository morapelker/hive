import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { leaveDataProjectThen, useDataProjectStore } from '@/stores/useDataProjectStore'
import type { SwitcherProject } from '@/lib/project-switcher'

/**
 * Opens a project from the "Go to project" switcher.
 *
 * The project becomes the selected one and the main pane shows what it shows after a click on
 * the project's row in the sidebar (ProjectItem / DataProjectItem), with three differences:
 * - the row click toggles the project's worktree list; this never expands or collapses
 *   anything, so the sidebar stays as it is;
 * - the row click keeps the Pinned Board in front when the project is pinned; this always
 *   leaves it, so the user ends up looking at the project (Cmd+P brings the board back);
 * - a connection that holds the main pane is deselected, for the same reason.
 *
 * Selecting updates the project's last-opened time (the stores' own `touch`). A database opens
 * its client; `select` asks first when another database has unsaved table edits, and so does
 * `leaveDataProjectThen` when a git or connection project replaces one.
 */
export function openSwitcherProject(project: Pick<SwitcherProject, 'kind' | 'id'>): void {
  if (project.kind === 'data') {
    useDataProjectStore.getState().select(project.id)
    return
  }
  leaveDataProjectThen(() => {
    useProjectStore.getState().selectProject(project.id)
    if (useConnectionStore.getState().selectedConnectionId) {
      useConnectionStore.getState().selectConnection(null)
    }
    if (project.kind === 'connection') {
      // Board-first, like its row: with no worktree selected its own board is the main pane.
      useWorktreeStore.getState().selectWorktreeOnly(null)
    }
    useKanbanStore.getState().closePinnedBoard()
  })
}
