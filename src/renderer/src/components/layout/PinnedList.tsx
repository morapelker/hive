import { useEffect } from 'react'
import {
  AlertCircle,
  Link,
  Loader2,
  Map as MapIcon,
  Pin
} from 'lucide-react'
import { cn, parseColorQuad } from '@/lib/utils'
import {
  useProjectStore,
  useWorktreeStore,
  useConnectionStore,
  useWorktreeStatusStore,
  usePinnedStore
} from '@/stores'
import { useScriptStore } from '@/stores/useScriptStore'
import { useGitStore } from '@/stores/useGitStore'
import { ModelIcon } from '@/components/worktrees/ModelIcon'
import { PulseAnimation } from '@/components/worktrees/PulseAnimation'
import { LanguageIcon } from '@/components/projects/LanguageIcon'

type PinnedItem =
  | { kind: 'worktree'; id: string }
  | { kind: 'connection'; id: string }

export function PinnedList(): React.JSX.Element | null {
  const pinnedWorktreeIds = usePinnedStore((s) => s.pinnedWorktreeIds)
  const pinnedConnectionIds = usePinnedStore((s) => s.pinnedConnectionIds)
  const loaded = usePinnedStore((s) => s.loaded)

  // Load pinned items on mount
  useEffect(() => {
    usePinnedStore.getState().loadPinned()
  }, [])

  const items: PinnedItem[] = []
  for (const id of pinnedWorktreeIds) {
    items.push({ kind: 'worktree', id })
  }
  for (const id of pinnedConnectionIds) {
    items.push({ kind: 'connection', id })
  }

  if (!loaded || items.length === 0) {
    return null
  }

  return (
    <div className="mb-1" data-testid="pinned-list">
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
        <Pin className="h-3 w-3" />
        <span>Pinned</span>
      </div>
      {items.map((item) =>
        item.kind === 'worktree' ? (
          <PinnedWorktreeItem key={`wt-${item.id}`} worktreeId={item.id} />
        ) : (
          <PinnedConnectionItem key={`conn-${item.id}`} connectionId={item.id} />
        )
      )}
      <div className="border-b border-border/50 mx-2 mt-1 mb-1" />
    </div>
  )
}

// ── Worktree item ──────────────────────────────────────────────

function PinnedWorktreeItem({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const selectWorktree = useWorktreeStore((s) => s.selectWorktree)
  const selectProject = useProjectStore((s) => s.selectProject)

  const worktreeStatus = useWorktreeStatusStore((s) => s.getWorktreeStatus(worktreeId))
  const isSelected = selectedWorktreeId === worktreeId
  const isRunProcessAlive = useScriptStore((s) => s.scriptStates[worktreeId]?.runRunning ?? false)

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

  const liveBranch = useGitStore((s) =>
    worktree ? s.branchInfoByWorktree.get(worktree.path) : undefined
  )

  if (!worktree || !project) return null

  const displayBranch = liveBranch?.name ?? worktree.name

  const handleClick = (): void => {
    selectWorktree(worktreeId)
    selectProject(project.id)
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
      data-testid={`pinned-worktree-${worktreeId}`}
    >
      <LanguageIcon language={project.language} customIcon={project.custom_icon} />

      {isRunProcessAlive && (
        <PulseAnimation className="h-3.5 w-3.5 text-green-500 shrink-0" />
      )}
      {(worktreeStatus === 'working' || worktreeStatus === 'planning') && (
        <Loader2 className="h-3.5 w-3.5 text-primary shrink-0 animate-spin" />
      )}
      {(worktreeStatus === 'answering' || worktreeStatus === 'permission') && (
        <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
      )}
      {worktreeStatus === 'plan_ready' && (
        <MapIcon className="h-3.5 w-3.5 text-blue-400 shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <span className="text-sm truncate block" title={worktree.path}>
          {project.name} <span className="text-muted-foreground">›</span> {displayBranch}
        </span>
        <div className="flex items-center">
          <ModelIcon worktreeId={worktreeId} className="h-2.5 w-2.5 mr-1 shrink-0" />
          <StatusText status={worktreeStatus} />
        </div>
      </div>

      {worktreeStatus === 'unread' && (
        <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
      )}
    </div>
  )
}

// ── Connection item ────────────────────────────────────────────

function PinnedConnectionItem({ connectionId }: { connectionId: string }): React.JSX.Element | null {
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectConnection = useConnectionStore((s) => s.selectConnection)

  const connectionStatus = useWorktreeStatusStore((s) => s.getConnectionStatus(connectionId))
  const isSelected = selectedConnectionId === connectionId

  const connection = useConnectionStore((s) =>
    s.connections.find((c) => c.id === connectionId)
  )

  if (!connection) return null

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
      data-testid={`pinned-connection-${connectionId}`}
    >
      {connection.color ? (
        <span
          className="h-2.5 w-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: parseColorQuad(connection.color)[1] }}
          aria-hidden="true"
        />
      ) : (
        <Link className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      )}

      {(connectionStatus === 'working' || connectionStatus === 'planning') && (
        <Loader2 className="h-3.5 w-3.5 text-primary shrink-0 animate-spin" />
      )}
      {(connectionStatus === 'answering' || connectionStatus === 'permission') && (
        <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
      )}
      {connectionStatus === 'plan_ready' && (
        <MapIcon className="h-3.5 w-3.5 text-blue-400 shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <span className="text-sm truncate block" title={displayName}>
          {displayName}
        </span>
        <StatusText status={connectionStatus} />
      </div>

      {connectionStatus === 'unread' && (
        <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
      )}
    </div>
  )
}

// ── Shared helpers ─────────────────────────────────────────────

type StatusType = string | null

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
    <span className={cn('text-[11px]', className)} data-testid="pinned-status-text">
      {text}
    </span>
  )
}
