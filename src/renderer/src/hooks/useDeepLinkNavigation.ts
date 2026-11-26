import { useEffect } from 'react'
import { systemApi } from '@/api/system-api'
import { leaveBoardViews } from '@/lib/board-navigation'
import { revealProjectInSidebar } from '@/lib/sidebar-reveal'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { leaveDataProjectThen } from '@/stores/useDataProjectStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
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

// A link that arrives at startup is published more than once; it connects only once.
const handledRequests = new Set<string>()

function navigate(data: DeepLinkNavigatePayload): void {
  if (data.kind === 'new-connection') {
    if (handledRequests.has(data.requestId)) return
    handledRequests.add(data.requestId)
    useProjectSwitcherStore.getState().openAndConnect({
      members: data.members.map((m) => ({ projectId: m.projectId, useBase: m.useBase })),
      pull: data.pull
    })
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
 * hive://connection/… link, and connects the projects of a hive://connection/new… link in
 * the "Go to project" switcher.
 */
export function useDeepLinkNavigation(): void {
  useEffect(() => systemApi.onDeepLinkNavigate(navigate), [])
}
