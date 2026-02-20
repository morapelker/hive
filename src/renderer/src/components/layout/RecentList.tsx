import { useEffect, useMemo } from 'react'
import {
  AlertCircle,
  GitBranch,
  Link,
  Loader2,
  Map as MapIcon,
  Zap
} from 'lucide-react'
import { cn, parseColorQuad } from '@/lib/utils'
import {
  useProjectStore,
  useWorktreeStore,
  useConnectionStore,
  useWorktreeStatusStore,
  useSessionStore
} from '@/stores'
import { useRecentStore } from '@/stores/useRecentStore'
import { useGitStore } from '@/stores/useGitStore'
import { ModelIcon } from '@/components/worktrees/ModelIcon'

type RecentItem =
  | { kind: 'worktree'; id: string; timestamp: number }
  | { kind: 'connection'; id: string; timestamp: number }

export function RecentList(): React.JSX.Element | null {
  const recentVisible = useRecentStore((s) => s.recentVisible)
  const recentWorktreeIds = useRecentStore((s) => s.recentWorktreeIds)
  const recentConnectionIds = useRecentStore((s) => s.recentConnectionIds)

  // Subscribe reactively so useMemo re-computes when timestamps change (Fix #1)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const sessionsByConnection = useSessionStore((s) => s.sessionsByConnection)

  // Auto-populate on mount when visible (replaces module-level setTimeout) (Fix #4)
  useEffect(() => {
    if (recentVisible) {
      useRecentStore.getState().populateRecent()
    }
  }, [recentVisible])

  // Build a sorted list of recent items
  const items = useMemo<RecentItem[]>(() => {
    const result: RecentItem[] = []

    // Build flat id->timestamp map for O(1) lookup (Fix #5)
    const timestampById = new Map<string, number>()
    for (const worktrees of worktreesByProject.values()) {
      for (const wt of worktrees) {
        if (wt.last_message_at) timestampById.set(wt.id, wt.last_message_at)
      }
    }

    for (const id of recentWorktreeIds) {
      result.push({ kind: 'worktree', id, timestamp: timestampById.get(id) ?? 0 })
    }

    for (const id of recentConnectionIds) {
      let timestamp = 0
      const sessions = sessionsByConnection.get(id)
      if (sessions) {
        for (const session of sessions) {
          if (session.updated_at) {
            const t = new Date(session.updated_at).getTime()
            if (t > timestamp) timestamp = t
          }
        }
      }
      result.push({ kind: 'connection', id, timestamp })
    }

    // Sort by most recent first
    result.sort((a, b) => b.timestamp - a.timestamp)
    return result
  }, [recentWorktreeIds, recentConnectionIds, worktreesByProject, sessionsByConnection])

  if (!recentVisible || items.length === 0) {
    return null
  }

  return (
    <div className="mb-1" data-testid="recent-list">
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
        <Zap className="h-3 w-3" />
        <span>Recent</span>
      </div>
      {items.map((item) =>
        item.kind === 'worktree' ? (
          <RecentWorktreeItem key={`wt-${item.id}`} worktreeId={item.id} />
        ) : (
          <RecentConnectionItem key={`conn-${item.id}`} connectionId={item.id} />
        )
      )}
      <div className="border-b border-border/50 mx-2 mt-1 mb-1" />
    </div>
  )
}

// ── Worktree item ──────────────────────────────────────────────

function RecentWorktreeItem({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const selectWorktree = useWorktreeStore((s) => s.selectWorktree)
  const selectProject = useProjectStore((s) => s.selectProject)

  const worktreeStatus = useWorktreeStatusStore((s) => s.getWorktreeStatus(worktreeId))
  const isSelected = selectedWorktreeId === worktreeId

  // Look up worktree and project
  const worktree = useWorktreeStore((s) => {
    for (const worktrees of s.worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === worktreeId)
      if (wt) return wt
    }
    return null
  })

  const project = useProjectStore((s) =>
    worktree ? s.projects.find((p) => p.id === worktree.project_id) : null
  )

  // Live branch name from git store
  const liveBranch = useGitStore((s) =>
    worktree ? s.branchInfoByWorktree.get(worktree.path) : undefined
  )

  if (!worktree || !project) return null

  const displayBranch = liveBranch?.name ?? worktree.name

  const handleClick = (): void => {
    selectWorktree(worktreeId)
    selectProject(project.id)
    // Expand the parent project so it's visible in the tree below
    const expanded = useProjectStore.getState().expandedProjectIds
    if (!expanded.has(project.id)) {
      useProjectStore.getState().toggleProjectExpanded(project.id)
    }
    useWorktreeStatusStore.getState().clearWorktreeUnread(worktreeId)
  }

  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-colors mx-1',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
      )}
      onClick={handleClick}
      data-testid={`recent-worktree-${worktreeId}`}
    >
      {/* Status icon */}
      <StatusIcon status={worktreeStatus} fallback={<GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />} />

      {/* Name and status line */}
      <div className="flex-1 min-w-0">
        <span className="text-sm truncate block" title={worktree.path}>
          {project.name} <span className="text-muted-foreground">›</span> {displayBranch}
        </span>
        <div className="flex items-center">
          <ModelIcon worktreeId={worktreeId} className="h-2.5 w-2.5 mr-1 shrink-0" />
          <StatusText status={worktreeStatus} />
        </div>
      </div>

      {/* Unread dot */}
      {worktreeStatus === 'unread' && (
        <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
      )}
    </div>
  )
}

// ── Connection item ────────────────────────────────────────────

function RecentConnectionItem({ connectionId }: { connectionId: string }): React.JSX.Element | null {
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectConnection = useConnectionStore((s) => s.selectConnection)

  const connectionStatus = useWorktreeStatusStore((s) => s.getConnectionStatus(connectionId))
  const isSelected = selectedConnectionId === connectionId

  // The store holds connection objects with members and custom_name
  const connection = useConnectionStore((s) =>
    s.connections.find((c) => c.id === connectionId)
  )

  if (!connection) return null

  // Access members and custom_name from the store's enriched Connection type (Fix #3)
  const projectNames =
    [...new Set(connection.members?.map((m: { project_name: string }) => m.project_name) || [])].join(' + ')

  const displayName = connection.custom_name
    || projectNames
    || connection.name
    || 'Connection'

  const handleClick = (): void => {
    selectConnection(connectionId)
  }

  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-colors mx-1',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
      )}
      onClick={handleClick}
      data-testid={`recent-connection-${connectionId}`}
    >
      {/* Connection color dot or link icon */}
      {connection.color ? (
        <span
          className="h-2.5 w-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: parseColorQuad(connection.color)[1] }}
          aria-hidden="true"
        />
      ) : (
        <Link className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      )}

      {/* Status icon (alongside color) */}
      {(connectionStatus === 'working' || connectionStatus === 'planning') && (
        <Loader2 className="h-3.5 w-3.5 text-primary shrink-0 animate-spin" />
      )}
      {(connectionStatus === 'answering' || connectionStatus === 'permission') && (
        <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
      )}
      {connectionStatus === 'plan_ready' && (
        <MapIcon className="h-3.5 w-3.5 text-blue-400 shrink-0" />
      )}

      {/* Name and status line */}
      <div className="flex-1 min-w-0">
        <span className="text-sm truncate block" title={displayName}>
          {displayName}
        </span>
        <StatusText status={connectionStatus} />
      </div>

      {/* Unread dot */}
      {connectionStatus === 'unread' && (
        <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
      )}
    </div>
  )
}

// ── Shared helpers ─────────────────────────────────────────────

type StatusType = string | null

function StatusIcon({
  status,
  fallback
}: {
  status: StatusType
  fallback: React.ReactNode
}): React.JSX.Element {
  if (status === 'working' || status === 'planning') {
    return <Loader2 className="h-3.5 w-3.5 text-primary shrink-0 animate-spin" />
  }
  if (status === 'answering' || status === 'permission') {
    return <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
  }
  if (status === 'plan_ready') {
    return <MapIcon className="h-3.5 w-3.5 text-blue-400 shrink-0" />
  }
  return <>{fallback}</>
}

function StatusText({ status }: { status: StatusType }): React.JSX.Element {
  const { text, className } =
    status === 'answering'
      ? { text: 'Answer questions', className: 'font-semibold text-amber-500' }
      : status === 'permission'
        ? { text: 'Permission', className: 'font-semibold text-amber-500' }
        : status === 'planning'
          ? { text: 'Planning', className: 'font-semibold text-blue-400' }
          : status === 'working'
            ? { text: 'Working', className: 'font-semibold text-primary' }
            : status === 'plan_ready'
              ? { text: 'Plan ready', className: 'font-semibold text-blue-400' }
              : status === 'completed'
                ? { text: 'Ready', className: 'font-semibold text-green-400' }
                : { text: 'Ready', className: 'text-muted-foreground' }

  return (
    <span className={cn('text-[11px]', className)} data-testid="recent-status-text">
      {text}
    </span>
  )
}
