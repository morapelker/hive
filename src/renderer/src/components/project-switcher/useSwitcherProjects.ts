import { useMemo } from 'react'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { describeDataProjectTarget } from '@/components/data-projects/data-project-ui'
import { mergeSidebarEntries } from '@/lib/project-filter'
import {
  parseOpenedAt,
  pinnedSwitcherKeys,
  shortenHomePath,
  switcherAgentState,
  switcherKey,
  type SwitcherAgentState,
  type SwitcherProject
} from '@/lib/project-switcher'
import type { DataProject } from '@shared/data-projects/types'

type GitProject = ReturnType<typeof useProjectStore.getState>['projects'][number]

/** A switcher row's project, with the store record its icon is drawn from. */
export type SwitcherItem = SwitcherProject &
  ({ kind: 'git' | 'connection'; source: GitProject } | { kind: 'data'; source: DataProject })

export interface SwitcherData {
  /** Every project on this Mac, in sidebar order: no Space, no sidebar filter. */
  items: SwitcherItem[]
  /** Pinned projects' keys, in the Pinned section's order. */
  pinnedKeys: string[]
  /** Worktrees of a git project, instances of a connection project. */
  worktreeCounts: Map<string, number>
  /** Projects with a worktree that is working or waiting on the user. */
  agentStates: Map<string, SwitcherAgentState>
}

const LIVE_STATUSES = new Set([
  'working',
  'planning',
  'answering',
  'permission',
  'command_approval',
  'plan_ready'
])

/** What the switcher lists, read from the stores (they are loaded with the sidebar). */
export function useSwitcherProjects(): SwitcherData {
  const projects = useProjectStore((s) => s.projects)
  const dataProjects = useDataProjectStore((s) => s.projects)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const connections = useConnectionStore((s) => s.connections)
  const pinnedWorktreeIds = usePinnedStore((s) => s.pinnedWorktreeIds)
  const pinnedConnectionIds = usePinnedStore((s) => s.pinnedConnectionIds)
  const pinnedProjectIds = usePinnedStore((s) => s.pinnedProjectIds)
  const sessionStatuses = useWorktreeStatusStore((s) => s.sessionStatuses)
  const sessionsByWorktree = useSessionStore((s) => s.sessionsByWorktree)
  const sessionsByConnection = useSessionStore((s) => s.sessionsByConnection)

  const items = useMemo(
    () =>
      mergeSidebarEntries(projects, dataProjects).map((entry): SwitcherItem => {
        if (entry.kind === 'data') {
          const source = entry.item
          return {
            key: switcherKey('data', source.id),
            kind: 'data',
            id: source.id,
            name: source.name,
            path: shortenHomePath(describeDataProjectTarget(source)),
            lastOpenedAt: parseOpenedAt(source.lastAccessedAt),
            source
          }
        }
        const source = entry.item
        const kind = source.kind === 'connection' ? 'connection' : 'git'
        return {
          key: switcherKey(kind, source.id),
          kind,
          id: source.id,
          name: source.name,
          path: shortenHomePath(source.path),
          lastOpenedAt: parseOpenedAt(source.last_accessed_at),
          source
        }
      }),
    [projects, dataProjects]
  )

  const pinnedKeys = useMemo(
    () =>
      pinnedSwitcherKeys({
        pinnedWorktreeIds,
        pinnedConnectionIds,
        pinnedProjectIds,
        worktreesByProject,
        connections,
        dataProjects
      }),
    [
      pinnedWorktreeIds,
      pinnedConnectionIds,
      pinnedProjectIds,
      worktreesByProject,
      connections,
      dataProjects
    ]
  )

  const worktreeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const [projectId, worktrees] of worktreesByProject) {
      counts.set(switcherKey('git', projectId), worktrees.length)
    }
    for (const connection of connections) {
      if (!connection.saved_project_id) continue
      const key = switcherKey('connection', connection.saved_project_id)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [worktreesByProject, connections])

  const agentStates = useMemo(() => {
    const states = new Map<string, SwitcherAgentState>()
    // Almost always nothing is running: skip the walk over every worktree.
    const anyLive = Object.values(sessionStatuses).some(
      (entry) => entry && LIVE_STATUSES.has(entry.status)
    )
    if (!anyLive) return states
    const statusStore = useWorktreeStatusStore.getState()
    for (const item of items) {
      if (item.kind === 'data') continue
      const statuses =
        item.kind === 'git'
          ? (worktreesByProject.get(item.id) ?? []).map((w) => statusStore.getWorktreeStatus(w.id))
          : connections
              .filter((c) => c.saved_project_id === item.id)
              .map((c) => statusStore.getConnectionStatus(c.id))
      const state = switcherAgentState(statuses)
      if (state) states.set(item.key, state)
    }
    return states
    // The session maps are read inside the status getters: they are dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    items,
    worktreesByProject,
    connections,
    sessionStatuses,
    sessionsByWorktree,
    sessionsByConnection
  ])

  return { items, pinnedKeys, worktreeCounts, agentStates }
}
