import { useEffect } from 'react'
import { systemApi } from '@/api/system-api'
import { leaveBoardViews } from '@/lib/board-navigation'
import { revealProjectInSidebar } from '@/lib/sidebar-reveal'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { leaveDataProjectThen } from '@/stores/useDataProjectStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { toast } from '@/lib/toast'
import type { DeepLinkNavigatePayload } from '@shared/deep-link-events'

async function openWorktree(projectId: string, worktreeId: string): Promise<void> {
  const worktrees = useWorktreeStore.getState()
  const loaded = worktrees.worktreesByProject.get(projectId)?.some((w) => w.id === worktreeId)
  if (!loaded) await worktrees.loadWorktrees(projectId, { force: true })

  leaveBoardViews()
  const projects = useProjectStore.getState()
  projects.selectProject(projectId)
  if (!projects.expandedProjectIds.has(projectId)) projects.toggleProjectExpanded(projectId)
  useWorktreeStore.getState().selectWorktree(worktreeId)
  revealProjectInSidebar({ kind: 'git', id: projectId })
}

async function openConnection(connectionId: string): Promise<void> {
  const connections = useConnectionStore.getState()
  if (!connections.connections.some((c) => c.id === connectionId)) {
    await connections.loadConnections()
  }
  leaveBoardViews()
  useConnectionStore.getState().selectConnection(connectionId)
}

/**
 * The switcher lists the git projects of the project store, which the sidebar's project list
 * loads. A link can arrive before that (at startup, or with that list never shown), so the
 * projects are loaded here first when any is missing.
 */
async function pickInSwitcher(
  data: Extract<DeepLinkNavigatePayload, { kind: 'new-connection' }>
): Promise<void> {
  const ids = data.members.map((m) => m.projectId)
  const allLoaded = (): boolean => {
    const loaded = new Set(useProjectStore.getState().projects.map((p) => p.id))
    return ids.every((id) => loaded.has(id))
  }
  if (!allLoaded()) await useProjectStore.getState().loadProjects()
  if (!allLoaded()) {
    toast.error('Cannot pick the projects: one was not found')
    return
  }
  useProjectSwitcherStore.getState().openWithPicks({
    members: data.members.map((m) => ({ projectId: m.projectId, useBase: m.useBase })),
    pull: data.pull
  })
}

// A link that arrives at startup is published more than once. Each is acted on once: a later
// copy must not undo what the user did after the first (another worktree selected, the
// connection's git view changed) nor pick the projects again.
const handledRequests = new Set<string>()

function navigate(data: DeepLinkNavigatePayload): void {
  if (handledRequests.has(data.requestId)) return
  handledRequests.add(data.requestId)
  if (data.kind === 'new-connection') {
    void pickInSwitcher(data)
    return
  }
  // Respects a database with unsaved table edits: on "Keep editing" nothing changes.
  leaveDataProjectThen(() => {
    void (data.kind === 'worktree'
      ? openWorktree(data.projectId, data.worktreeId)
      : openConnection(data.connectionId))
  })
}

/**
 * Acts on hive:// links: selects the worktree or connection of a hive://worktree/… or
 * hive://connection/… link, and picks the projects of a hive://connection/new… link in the
 * "Go to project" switcher, where Enter creates the connection.
 */
export function useDeepLinkNavigation(): void {
  useEffect(() => systemApi.onDeepLinkNavigate(navigate), [])
}
