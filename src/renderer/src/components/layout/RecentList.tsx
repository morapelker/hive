import { useEffect, useMemo } from 'react'
import { Link, Zap } from 'lucide-react'
import { cn, parseColorQuad } from '@/lib/utils'
import {
  useProjectStore,
  useWorktreeStore,
  useConnectionStore,
  useWorktreeStatusStore,
  useSessionStore
} from '@/stores'
import { useScriptStore } from '@/stores/useScriptStore'
import { useRecentStore } from '@/stores/useRecentStore'
import { useSidebarHoverHighlight } from '@/hooks'
import { useGitStore } from '@/stores/useGitStore'
import { ModelIcon } from '@/components/worktrees/ModelIcon'
import { PulseAnimation } from '@/components/worktrees/PulseAnimation'
import { LanguageIcon } from '@/components/projects/LanguageIcon'
import {
  AGENT_LIST,
  AGENT_LIST_AFTER_TITLE,
  AGENT_ROW_ICON_WRAP,
  AgentStateDot,
  CARD_CONTENT_COLUMN,
  CARD_CONTENT_COLUMN_OVERFLOW_VISIBLE,
  CARD_LANE,
  CARD_LANE_SLOT,
  CARD_LANE_UNREAD_DOT,
  CARD_LANE_UNREAD_WRAP,
  CARD_PARENT_ROW,
  CARD_PARENT_ROW_ALIGN,
  CARD_TITLE_IS_DIM,
  CARD_TITLE_IS_UNREAD,
  CARD_TITLE_ROW,
  CARD_TITLE_ROW_LEFT,
  SECTION_HEADER_ICON,
  SidebarAgentRow,
  SidebarSectionHeader,
  WorkspaceCardSurface,
  getFlushWorktreeCardPaddingLeft,
  type AgentDotState
} from '@/components/sidebar'

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
    // Orca virtual-row rhythm: ROW_GAP (6px) between header and every card; the
    // trailing pb-2.5 (= ROW_GAP + GROUP_HEADER_TOP_MARGIN) gives the next
    // section header its 6px gap + pt-1 spacer.
    <div className="flex flex-col gap-1.5 pb-2.5" data-testid="recent-list">
      <SidebarSectionHeader
        sticky
        icon={<Zap className={SECTION_HEADER_ICON} />}
        label="Recent"
        count={items.length}
      />
      {items.map((item) =>
        item.kind === 'worktree' ? (
          <RecentWorktreeItem key={`wt-${item.id}`} worktreeId={item.id} />
        ) : (
          <RecentConnectionItem key={`conn-${item.id}`} connectionId={item.id} />
        )
      )}
    </div>
  )
}

// ── Worktree item ──────────────────────────────────────────────

function RecentWorktreeItem({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const sidebarHover = useSidebarHoverHighlight('worktree', worktreeId)
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const selectWorktree = useWorktreeStore((s) => s.selectWorktree)
  const selectProject = useProjectStore((s) => s.selectProject)

  const worktreeStatus = useWorktreeStatusStore((s) => s.getWorktreeStatus(worktreeId))
  const isSelected = selectedWorktreeId === worktreeId
  const isRunProcessAlive = useScriptStore((s) => s.scriptStates[worktreeId]?.runRunning ?? false)

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
  // Single-line identity "project › worktree"; the primary worktree shows its
  // real branch instead of the placeholder worktree name.
  const secondaryLabel = worktree.is_default
    ? (liveBranch?.name ?? worktree.branch_name ?? displayBranch)
    : displayBranch
  const isUnread = worktreeStatus === 'unread'

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
    <WorkspaceCardSurface
      active={isSelected ? 'primary' : false}
      className="group/worktree-card"
      style={{ paddingLeft: getFlushWorktreeCardPaddingLeft(0) }}
      onClick={handleClick}
      onMouseEnter={sidebarHover.onMouseEnter}
      onMouseLeave={sidebarHover.onMouseLeave}
      data-testid={`recent-worktree-${worktreeId}`}
    >
      <div className={cn(CARD_PARENT_ROW, CARD_PARENT_ROW_ALIGN)}>
        <StatusLane status={worktreeStatus} />

        <div className={cn(CARD_CONTENT_COLUMN, CARD_CONTENT_COLUMN_OVERFLOW_VISIBLE)}>
          {/* Title row: project icon + "project › worktree" */}
          <div className={CARD_TITLE_ROW}>
            <div className={CARD_TITLE_ROW_LEFT}>
              <LanguageIcon
                language={project.language}
                customIcon={project.custom_icon}
                detectedIcon={project.detected_icon}
              />
              <span
                className={isUnread ? CARD_TITLE_IS_UNREAD : CARD_TITLE_IS_DIM}
                title={worktree.path}
              >
                {project.name} <span className="text-muted-foreground">›</span> {secondaryLabel}
              </span>
            </div>
          </div>

          {/* Inline agent row (orca compact agent row): state dot · model · status */}
          <div className={cn(AGENT_LIST, AGENT_LIST_AFTER_TITLE)} data-compact-agent-list="true">
            <SidebarAgentRow
              leading={
                <>
                  <AgentStateDot state={statusToDotState(worktreeStatus)} size="sm" />
                  {isRunProcessAlive && (
                    <PulseAnimation className="size-3 shrink-0 text-blue-500" />
                  )}
                  <span className={AGENT_ROW_ICON_WRAP}>
                    <ModelIcon worktreeId={worktreeId} className="size-[13px] shrink-0" />
                  </span>
                </>
              }
              label={<StatusText status={worktreeStatus} />}
            />
          </div>
        </div>
      </div>
    </WorkspaceCardSurface>
  )
}

// ── Connection item ────────────────────────────────────────────

function RecentConnectionItem({
  connectionId
}: {
  connectionId: string
}): React.JSX.Element | null {
  const sidebarHover = useSidebarHoverHighlight('connection', connectionId)
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectConnection = useConnectionStore((s) => s.selectConnection)

  const connectionStatus = useWorktreeStatusStore((s) => s.getConnectionStatus(connectionId))
  const isSelected = selectedConnectionId === connectionId

  // The store holds connection objects with members and custom_name
  const connection = useConnectionStore((s) => s.connections.find((c) => c.id === connectionId))

  if (!connection) return null

  // Access members and custom_name from the store's enriched Connection type (Fix #3)
  const projectNames = [
    ...new Set(connection.members?.map((m: { project_name: string }) => m.project_name) || [])
  ].join(' + ')

  const displayName = connection.custom_name || projectNames || connection.name || 'Connection'
  const isUnread = connectionStatus === 'unread'

  const handleClick = (): void => {
    selectConnection(connectionId)
  }

  return (
    <WorkspaceCardSurface
      active={isSelected ? 'primary' : false}
      className="group/worktree-card"
      style={{ paddingLeft: getFlushWorktreeCardPaddingLeft(0) }}
      onClick={handleClick}
      onMouseEnter={sidebarHover.onMouseEnter}
      onMouseLeave={sidebarHover.onMouseLeave}
      data-testid={`recent-connection-${connectionId}`}
    >
      <div className={cn(CARD_PARENT_ROW, CARD_PARENT_ROW_ALIGN)}>
        <StatusLane status={connectionStatus} />

        <div className={cn(CARD_CONTENT_COLUMN, CARD_CONTENT_COLUMN_OVERFLOW_VISIBLE)}>
          {/* Title row: connection color dot / link glyph + name */}
          <div className={CARD_TITLE_ROW}>
            <div className={CARD_TITLE_ROW_LEFT}>
              <span className="inline-flex size-4 shrink-0 items-center justify-center">
                {connection.color ? (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: parseColorQuad(connection.color)[1] }}
                    aria-hidden="true"
                  />
                ) : (
                  <Link className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </span>
              <span
                className={isUnread ? CARD_TITLE_IS_UNREAD : CARD_TITLE_IS_DIM}
                title={displayName}
              >
                {displayName}
              </span>
            </div>
          </div>

          {/* Inline agent row: state dot · status */}
          <div className={cn(AGENT_LIST, AGENT_LIST_AFTER_TITLE)} data-compact-agent-list="true">
            <SidebarAgentRow
              leading={<AgentStateDot state={statusToDotState(connectionStatus)} size="sm" />}
              label={<StatusText status={connectionStatus} />}
            />
          </div>
        </div>
      </div>
    </WorkspaceCardSurface>
  )
}

// ── Shared helpers ─────────────────────────────────────────────

type StatusType = string | null

/** Map Hive session status → orca AgentStateDot vocabulary. */
function statusToDotState(status: StatusType): AgentDotState {
  switch (status) {
    case 'working':
    case 'planning':
      return 'working'
    case 'answering':
    case 'permission':
    case 'command_approval':
    case 'plan_ready':
      return 'question'
    default:
      // completed / unread / idle all read as the emerald "ready" dot (orca StatusIndicator)
      return 'done'
  }
}

/** Orca status lane: 20px slot, 12px StatusIndicator glyph, amber unread overlay dot. */
function StatusLane({ status }: { status: StatusType }): React.JSX.Element {
  const unread = status === 'unread'
  return (
    <div className={CARD_LANE}>
      <span className={unread ? CARD_LANE_UNREAD_WRAP : CARD_LANE_SLOT}>
        <AgentStateDot state={statusToDotState(status)} size="md" />
        {unread && <span className={CARD_LANE_UNREAD_DOT} data-worktree-unread-dot="" />}
      </span>
    </div>
  )
}

function StatusText({ status }: { status: StatusType }): React.JSX.Element {
  const text =
    status === 'answering'
      ? 'Answer questions'
      : status === 'permission'
        ? 'Permission'
        : status === 'command_approval'
          ? 'Approve command'
          : status === 'planning'
            ? 'Planning'
            : status === 'working'
              ? 'Working'
              : status === 'plan_ready'
                ? 'Plan ready'
                : 'Ready'

  return <span data-testid="recent-status-text">{text}</span>
}
