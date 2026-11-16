import { useProjectStore } from '@/stores/useProjectStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { leaveDataProjectThen, useDataProjectStore } from '@/stores/useDataProjectStore'
import { mergeSidebarEntries, moveSidebarEntryToTop } from '@/lib/project-filter'
import { revealProjectInSidebar } from '@/lib/sidebar-reveal'
import { openProjectOnBase } from '@/lib/project-base-worktree'
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
 * The project becomes the selected one, opened on its base as a click on its row in the
 * sidebar's Recent section opens it (`openProjectOnBase`): a git project on its "(no-worktree)"
 * worktree, a connection project on its base instance. One difference from that row: the
 * Pinned Board is always left, so the user ends up looking at the project (Cmd+P brings the
 * board back), and so is a connection that holds the main pane.
 *
 * The sidebar follows the project: it is expanded when it was collapsed (never collapsed), it
 * moves to the top of "All projects", it leads the Recent section (a pinned project stays in
 * Pinned instead), and the list scrolls to it.
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
    // Left at once: the base may still have to be read, or may not be there to select.
    if (useConnectionStore.getState().selectedConnectionId) {
      useConnectionStore.getState().selectConnection(null)
    }
    void openProjectOnBase({
      id: project.id,
      kind: project.kind === 'connection' ? 'connection' : 'git'
    })
    useKanbanStore.getState().closePinnedBoard()
    const projects = useProjectStore.getState()
    if (!projects.expandedProjectIds.has(project.id)) projects.toggleProjectExpanded(project.id)
    showInSidebar(project)
  })
}
