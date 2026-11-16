import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { leaveDataProjectThen, useDataProjectStore } from '@/stores/useDataProjectStore'
import { mergeSidebarEntries, moveSidebarEntryToTop } from '@/lib/project-filter'
import { revealProjectInSidebar } from '@/lib/sidebar-reveal'
import type { SwitcherProject } from '@/lib/project-switcher'

type SwitcherTarget = Pick<SwitcherProject, 'kind' | 'id'>

/**
 * The project leads the sidebar's "All projects" list: the first entry of the order git
 * projects and databases share, stored like a drag to the top. Nothing is written when it
 * leads the list already.
 */
function moveToTopOfSidebar(project: SwitcherTarget): void {
  const projectStore = useProjectStore.getState()
  const dataStore = useDataProjectStore.getState()
  // Without databases the order is the git projects' own (ProjectList's drag does the same).
  if (dataStore.projects.length === 0) {
    const from = projectStore.projects.findIndex((p) => p.id === project.id)
    if (from > 0) projectStore.reorderProjects(from, 0)
    return
  }
  const order = mergeSidebarEntries(projectStore.projects, dataStore.projects).map(
    ({ kind, id }) => ({ kind, id })
  )
  const next = moveSidebarEntryToTop(
    order,
    project.kind === 'data' ? 'data' : 'project',
    project.id
  )
  if (next) dataStore.applySidebarOrder(next)
}

/**
 * The stores record the opening when their own `touch` comes back from the server. The time
 * is set here at once as well, so the sidebar's Recent section has the project in the same
 * render as its new place in the list, and the scroll that follows measures the final layout.
 */
function markOpenedNow(project: SwitcherTarget): void {
  const now = new Date().toISOString()
  if (project.kind === 'data') {
    useDataProjectStore.setState((state) => ({
      projects: state.projects.map((p) => (p.id === project.id ? { ...p, lastAccessedAt: now } : p))
    }))
    return
  }
  useProjectStore.setState((state) => ({
    projects: state.projects.map((p) => (p.id === project.id ? { ...p, last_accessed_at: now } : p))
  }))
}

/** Where the sidebar shows a project that was just opened from the switcher. */
function showInSidebar(project: SwitcherTarget): void {
  markOpenedNow(project)
  moveToTopOfSidebar(project)
  revealProjectInSidebar(project)
}

/**
 * Opens a project from the "Go to project" switcher.
 *
 * The project becomes the selected one and the main pane shows what it shows after a click on
 * the project's row in the sidebar (ProjectItem / DataProjectItem), with three differences:
 * - the row click toggles the project's worktree list; this never expands or collapses
 *   anything;
 * - the row click keeps the Pinned Board in front when the project is pinned; this always
 *   leaves it, so the user ends up looking at the project (Cmd+P brings the board back);
 * - a connection that holds the main pane is deselected, for the same reason.
 *
 * The sidebar follows the project: it moves to the top of "All projects", it leads the Recent
 * section (a pinned project stays in Pinned instead), and the list scrolls to it.
 *
 * Selecting updates the project's last-opened time (the stores' own `touch`). A database opens
 * its client. When another database has unsaved table edits, `leaveDataProjectThen` asks
 * first: on "Keep editing" nothing is opened and the sidebar stays as it is.
 */
export function openSwitcherProject(project: SwitcherTarget): void {
  if (project.kind === 'data') {
    const open = (): void => {
      useDataProjectStore.getState().select(project.id)
      showInSidebar(project)
    }
    // Picked again while it is open: there is nothing to leave, so nothing to ask.
    if (useDataProjectStore.getState().selectedDataProjectId === project.id) open()
    else leaveDataProjectThen(open)
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
    showInSidebar(project)
  })
}
