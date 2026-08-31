import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Paperclip,
  AlertCircle,
  AlertTriangle,
  Trash2,
  Archive,
  Copy,
  ArchiveRestore,
  GitBranch,
  ExternalLink,
  X,
  FileText,
  Pin,
  PinOff,
  RefreshCw,
  Link as LinkIcon,
  GitPullRequest,
  Loader2,
  Sparkles,
  Lock,
  Link2,
  Plus,
  StickyNote,
  Send,
  Check,
  Pause,
  Play,
  ChevronDown,
  Hammer,
  Map as MapIcon,
  MessageCircleQuestion,
  FolderInput,
  FastForward,
  RadioTower,
  Unplug,
  SquareTerminal,
  Radar,
  Bot,
  Star
} from 'lucide-react'
import { CheckeredFlagIcon } from './CheckeredFlagIcon'
import { HighlightedText } from './HighlightedText'
import { ticketPillBaseClass, ticketPillClass } from './pill'
import { TicketModelBadge } from './TicketModelBadge'
import { UpdateStatusModal } from './UpdateStatusModal'
import { RemoteTerminalDialog } from './RemoteTerminalDialog'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { NoteEditorModal } from './NoteEditorModal'
import { MoveToProjectModal } from './MoveToProjectModal'
import { cn, parseColorQuad } from '@/lib/utils'
import { isTicketLinkedToSidebarTarget } from '@/lib/sidebar-hover-highlight'
import { extractSnippet, normalizeSearchText, stripMarkdown } from '@/lib/board-search'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'
import { remoteLaunchApi } from '@/api/remote-launch-api'
import { useRemoteLaunchStore } from '@/stores/useRemoteLaunchStore'
import { systemApi } from '@/api/system-api'
import { ProviderIcon, getProviderLabel } from '@/components/ui/provider-icon'
import { toast } from '@/lib/toast'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel
} from '@/components/ui/alert-dialog'
import {
  WorktreePickerModal,
  quickLaunchTicket,
  quickLaunchTicketOnConnection
} from '@/components/kanban/WorktreePickerModal'
import { useRightButtonDrag } from '@/components/kanban/useRightButtonDrag'
import { buildQuickLaunchGhostChip } from '@/components/kanban/quickLaunchGhostChip'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { AttachPRPopover } from '@/components/kanban/AttachPRPopover'
import { useGitStore } from '@/stores/useGitStore'
import { IndeterminateProgressBar } from '@/components/sessions/IndeterminateProgressBar'
import { PulseAnimation } from '@/components/worktrees/PulseAnimation'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { parseTicketKey, setKanbanDragData, ticketKey, ticketTransitionTime, useKanbanStore } from '@/stores/useKanbanStore'
import type { TicketKey } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { isBlockerSatisfied } from '@/lib/blocker-utils'
import { findBaseInstanceConnection } from '@/lib/connection-project'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useProjectIconUrl } from '@/components/projects/LanguageIcon'
import { useScriptStore } from '@/stores/useScriptStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useFavoriteTicketsStore } from '@/stores/useFavoriteTicketsStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useTelegramStore } from '@/stores/useTelegramStore'
import { useSessionTimer } from '@/hooks/useSessionTimer'
import { useSessionTokenDelta } from '@/hooks/useSessionTokenDelta'
import { useConflictFixFlow } from '@/hooks/useConflictFixFlow'
import { useTicketRemoteLaunch } from '@/hooks/useTicketRemoteLaunch'
import { formatTokenCount, formatTransitionAge } from '@/lib/format-utils'
import { useTimerTickStore } from '@/stores/useTimerTickStore'
import { canToggleAutoApprovePlan } from '@/lib/plan-auto-approve'
import { isClaudeCli } from '@shared/types/agent-sdk'
import { terminalApi } from '@/api/terminal-api'
import type { KanbanTicket, TicketMark } from '../../../../main/db/types'

// ── Project tag color palette ──────────────────────────────────────
// Desaturated identity hues (orca mockup) — no violet/indigo so brand-ish
// purple never appears as chrome next to the plan-mode violet pills.
const PROJECT_TAG_COLORS = [
  '#6ea8dc', // blue
  '#d4b962', // gold
  '#c98ba8', // rose
  '#e08a5e', // orange
  '#7cc4a0', // sage
  '#6ec4c4', // teal
  '#d49a7c', // clay
  '#9a9a9a', // neutral
]

/** Deterministic color for a project within a connection's project list. */
function getProjectColor(projectId: string, connectionProjectIds: string[]): string {
  const idx = connectionProjectIds.indexOf(projectId)
  if (idx === -1) return PROJECT_TAG_COLORS[0]
  return PROJECT_TAG_COLORS[idx % PROJECT_TAG_COLORS.length]
}

const EMPTY_ARRAY: readonly never[] = []

interface KanbanTicketCardProps {
  ticket: KanbanTicket
  /** Position index within the column (used for drag transfer data) */
  index?: number
  /** Whether this ticket is archived (shown in archived section) */
  isArchived?: boolean
  /** When viewing a connection board, the connection ID for project tag + jump-to-session */
  connectionId?: string
  /** When viewing the pinned board (multi-project), show project tags */
  isPinnedMode?: boolean
  /** Renderer-only identity for duplicate markdown card occurrences. */
  cardIdentityKey?: TicketKey
}

function decorateRightDragGhost(ghost: HTMLElement): void {
  ghost.appendChild(buildQuickLaunchGhostChip())
}

export const KanbanTicketCard = memo(function KanbanTicketCard({
  ticket,
  index = 0,
  isArchived = false,
  connectionId,
  isPinnedMode,
  cardIdentityKey
}: KanbanTicketCardProps) {
  const isMultiProjectMode = !!connectionId || !!isPinnedMode

  const [isDragging, setIsDragging] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showWorktreePicker, setShowWorktreePicker] = useState(false)
  const [showPreAssignPicker, setShowPreAssignPicker] = useState(false)
  const [showStatusUpdate, setShowStatusUpdate] = useState(false)
  const [showPRPicker, setShowPRPicker] = useState(false)
  const [showNoteEditor, setShowNoteEditor] = useState(false)
  const [showMoveToProject, setShowMoveToProject] = useState(false)
  const [remoteTerminalOpen, setRemoteTerminalOpen] = useState(false)
  const [showStopRemoteConfirm, setShowStopRemoteConfirm] = useState(false)
  const remoteLaunchInfo = useTicketRemoteLaunch(ticket)
  // The card only surfaces ACTIVE remote launches (badge, attach, stop) —
  // a stopped one renders like a plain ticket here.
  const activeRemoteLaunch =
    remoteLaunchInfo && !remoteLaunchInfo.stoppedAt ? remoteLaunchInfo : null
  const hasNote = !!ticket.note && ticket.note.trim().length > 0
  const isExternalTicket = !!ticket.external_provider

  // Board search (Cmd+F): highlight title matches; when only the description
  // matched (toggle on), surface a one-line snippet under the title
  const searchOpen = useKanbanStore((s) => s.boardSearch.open)
  const searchQuery = useKanbanStore((s) => s.boardSearch.query)
  const searchDescriptions = useKanbanStore((s) => s.boardSearch.searchDescriptions)
  const normQuery = searchOpen ? normalizeSearchText(searchQuery.trim()) : ''
  const titleMatched = normQuery.length > 0 && normalizeSearchText(ticket.title).includes(normQuery)
  const descriptionSnippet =
    normQuery.length > 0 && searchDescriptions && !titleMatched && ticket.description
      ? extractSnippet(stripMarkdown(ticket.description), normQuery)
      : null
  const dragCloneRef = useRef<HTMLElement | null>(null)
  const dragActiveRef = useRef(false)
  const currentTicketKey = ticketKey(ticket.project_id, ticket.id)
  const domTicketKey = cardIdentityKey ?? currentTicketKey

  // ── Dependency selectors ────────────────────────────────────────
  // useShallow prevents infinite re-render loops by doing shallow equality
  // comparison on the returned array instead of Object.is reference check.
  const blockerTickets = useKanbanStore(
    useShallow((state) => {
      const blockerKeys = state.dependencyMap.get(currentTicketKey)
      if (!blockerKeys?.size) return EMPTY_ARRAY as unknown as KanbanTicket[]
      const result: KanbanTicket[] = []
      for (const blockerKey of blockerKeys) {
        const blockerRef = parseTicketKey(blockerKey)
        const blocker = state.tickets
          .get(blockerRef.projectId)
          ?.find((t) => t.id === blockerRef.ticketId)
        if (blocker) result.push(blocker)
      }
      return result
    })
  )

  const followUpTriggerColumn = useSettingsStore(s => s.followUpTriggerColumn)

  const unresolvedBlockerCount = useKanbanStore(
    useCallback((state) => {
      const blockers = state.dependencyMap.get(currentTicketKey)
      if (!blockers?.size) return 0
      let count = 0
      for (const blockerKey of blockers) {
        const blockerRef = parseTicketKey(blockerKey)
        const blocker = state.tickets
          .get(blockerRef.projectId)
          ?.find((t) => t.id === blockerRef.ticketId)
        if (blocker && !isBlockerSatisfied(blocker.column, blocker.mode, followUpTriggerColumn)) count++
      }
      return count
    }, [currentTicketKey, followUpTriggerColumn])
  )

  const isSimpleMode = useKanbanStore(
    useCallback((state) => state.simpleModeByProject[ticket.project_id] ?? false, [ticket.project_id])
  )
  const blockingDiagnostic = useKanbanStore(
    useCallback(
      (state) =>
        (state.markdownDiagnostics.get(ticket.project_id) ?? []).find(
          (diagnostic) => diagnostic.ticketId === ticket.id && diagnostic.blocking
        ) ?? null,
      [ticket.project_id, ticket.id]
    )
  )

  // True when another blocked ticket is hovered and THIS ticket is one of its blockers
  const isHighlightedAsBlocker = useKanbanStore(
    useCallback((state) => {
      const hoveredKey = state.hoveredBlockedTicketKey
      if (!hoveredKey) return false
      const blockers = state.dependencyMap.get(hoveredKey)
      return blockers?.has(currentTicketKey) ?? false
    }, [currentTicketKey])
  )

  // ── Sidebar hover → board highlight ─────────────────────────────
  // True while a sidebar project/worktree card is hovered and this ticket
  // belongs to that project / runs (or is queued to run) on that worktree.
  const isLinkedToHoveredSidebarProjectOrWorktree = useKanbanStore(
    useCallback(
      (state) =>
        isTicketLinkedToSidebarTarget(
          {
            project_id: ticket.project_id,
            worktree_id: ticket.worktree_id,
            pending_launch_config: ticket.pending_launch_config
          },
          state.hoveredSidebarTarget
        ),
      [ticket.project_id, ticket.worktree_id, ticket.pending_launch_config]
    )
  )
  const hoveredSidebarConnectionId = useKanbanStore((state) =>
    state.hoveredSidebarTarget?.kind === 'connection' ? state.hoveredSidebarTarget.id : null
  )
  // A hovered connection links tickets whose session runs inside it …
  const isLinkedToHoveredSidebarConnectionSession = useSessionStore(
    useCallback(
      (state) => {
        if (!hoveredSidebarConnectionId || !ticket.current_session_id) return false
        return (
          state.sessionsByConnection
            .get(hoveredSidebarConnectionId)
            ?.some((s) => s.id === ticket.current_session_id) ?? false
        )
      },
      [hoveredSidebarConnectionId, ticket.current_session_id]
    )
  )
  // … and tickets running on one of its member worktrees
  const isLinkedToHoveredSidebarConnectionMember = useConnectionStore(
    useCallback(
      (state) => {
        if (!hoveredSidebarConnectionId || !ticket.worktree_id) return false
        const connection = state.connections.find((c) => c.id === hoveredSidebarConnectionId)
        return connection?.members.some((m) => m.worktree_id === ticket.worktree_id) ?? false
      },
      [hoveredSidebarConnectionId, ticket.worktree_id]
    )
  )
  const isSidebarHoverHighlighted =
    isLinkedToHoveredSidebarProjectOrWorktree ||
    isLinkedToHoveredSidebarConnectionSession ||
    isLinkedToHoveredSidebarConnectionMember
  // Either hover highlight owns the perimeter; other border cues yield to it
  const hasHoverHighlight = isHighlightedAsBlocker || isSidebarHoverHighlighted

  const isBlocked = !isSimpleMode && unresolvedBlockerCount > 0

  // ── Queued launch target (branch it will run on, or new worktree) ──
  const queuedWorktree = useMemo(() => {
    if (!ticket.pending_launch_config) return null
    try {
      const config = JSON.parse(ticket.pending_launch_config) as {
        worktree?: { type: 'new'; sourceBranch: string } | { type: 'existing'; worktreeId: string }
      }
      return config.worktree ?? null
    } catch {
      return null
    }
  }, [ticket.pending_launch_config])

  const queuedBranchLabel = useWorktreeStore(
    useCallback(
      (state) => {
        if (!queuedWorktree) return null
        if (queuedWorktree.type === 'new') return '(new-worktree)'
        for (const worktrees of state.worktreesByProject.values()) {
          const found = worktrees.find((w) => w.id === queuedWorktree.worktreeId)
          if (found) return found.branch_name || found.name
        }
        return null
      },
      [queuedWorktree]
    )
  )

  // ── Lookup worktree name ────────────────────────────────────────
  const worktreeName = useWorktreeStore(
    useCallback(
      (state) => {
        if (!ticket.worktree_id) return null
        for (const worktrees of state.worktreesByProject.values()) {
          const found = worktrees.find((w) => w.id === ticket.worktree_id)
          if (found) return found.name
        }
        return null
      },
      [ticket.worktree_id]
    )
  )

  const conflictTargetWorktreeId = useWorktreeStatusStore(
    useCallback(
      // Check the per-ticket map first — connection tickets have no
      // worktree_id but still record a conflict target on failed merges
      (state) =>
        state.mergeConflictWorktreeByTicket[ticketKey(ticket.project_id, ticket.id)] ??
        ticket.worktree_id ??
        null,
      [ticket.id, ticket.project_id, ticket.worktree_id]
    )
  )

  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => {
        if (!conflictTargetWorktreeId) return null
        for (const worktrees of state.worktreesByProject.values()) {
          const found = worktrees.find((w) => w.id === conflictTargetWorktreeId)
          if (found) return found.path
        }
        return null
      },
      [conflictTargetWorktreeId]
    )
  )

  const hasConflicts = useGitStore(
    useCallback(
      (state) => (worktreePath ? (state.conflictsByWorktree[worktreePath] ?? false) : false),
      [worktreePath]
    )
  )

  const conflictFlow = useWorktreeStatusStore(
    useCallback(
      (state) =>
        conflictTargetWorktreeId
          ? state.mergeConflictFlowByWorktree[conflictTargetWorktreeId]
          : undefined,
      [conflictTargetWorktreeId]
    )
  )

  const mergeConflictMode = useSettingsStore((s) => s.mergeConflictMode)
  const { startFixFlow, openAttachedSession } = useConflictFixFlow(conflictTargetWorktreeId)

  // ── Lookup project name + color for connection board ─────────────
  // Selector returns a primitive (string | null) to avoid Zustand infinite
  // re-render loops caused by new object references on every evaluation.
  const projectName = useProjectStore(
    useCallback(
      (state) => {
        if (!isMultiProjectMode) return null
        return state.projects.find((p) => p.id === ticket.project_id)?.name ?? null
      },
      [isMultiProjectMode, ticket.project_id]
    )
  )

  // Pinned board only (not connection boards): when the project's icon was
  // customized, the tag shows that icon instead of the generated color dot.
  const projectCustomIcon = useProjectStore(
    useCallback(
      (state) => {
        if (!isPinnedMode || connectionId) return null
        return state.projects.find((p) => p.id === ticket.project_id)?.custom_icon ?? null
      },
      [isPinnedMode, connectionId, ticket.project_id]
    )
  )
  const projectCustomIconUrl = useProjectIconUrl(projectCustomIcon)

  const projectTag = useMemo(() => {
    if (!projectName) return null
    if (connectionId) {
      const connectionProjectIds = useKanbanStore.getState().getConnectionProjectIds(connectionId)
      return {
        name: projectName,
        color: getProjectColor(ticket.project_id, connectionProjectIds),
        iconUrl: null as string | null
      }
    }
    if (isPinnedMode) {
      const pinnedProjectIds = useKanbanStore.getState().getPinnedProjectIdsArray()
      return {
        name: projectName,
        color: getProjectColor(ticket.project_id, pinnedProjectIds),
        iconUrl: projectCustomIconUrl
      }
    }
    return null
  }, [connectionId, isPinnedMode, projectName, projectCustomIconUrl, ticket.project_id])

  // ── Detect connection session on project board ──────────────────
  // Selector returns a primitive (string | null) to avoid Zustand infinite
  // re-render loops caused by new object references on every evaluation.
  const connectionSessionId = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id || connectionId) return null
        for (const [connId, sessions] of state.sessionsByConnection.entries()) {
          if (sessions.some((s) => s.id === ticket.current_session_id)) return connId
        }
        return null
      },
      [ticket.current_session_id, connectionId]
    )
  )

  const connectionSession = useMemo(
    () => connectionSessionId ? { connectionId: connectionSessionId } : null,
    [connectionSessionId]
  )

  // ── Lookup connection name for project board badge ─────────────
  const connectionName = useConnectionStore(
    useCallback(
      (state) => {
        if (!connectionSession) return null
        const conn = state.connections.find((c) => c.id === connectionSession.connectionId)
        return conn?.custom_name || conn?.name || null
      },
      [connectionSession]
    )
  )

  const connectionColor = useConnectionStore(
    useCallback(
      (state) => {
        if (!connectionSession) return null
        const conn = state.connections.find((c) => c.id === connectionSession.connectionId)
        return conn?.color ?? null
      },
      [connectionSession]
    )
  )

  // ── Lookup linked session status ────────────────────────────────
  const sessionStatus = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.status
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.status
        }
        return null
      },
      [ticket.current_session_id]
    )
  )

  const goalStatus = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        return state.codexGoalsBySession.get(ticket.current_session_id)?.status ?? null
      },
      [ticket.current_session_id]
    )
  )

  const linkedSessionAgentSdk = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.agent_sdk
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.agent_sdk
        }
        return null
      },
      [ticket.current_session_id]
    )
  )

  // ── Real-time "agent is busy" from worktree status store ────────
  const isBusy = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return false
        const entry = state.sessionStatuses[ticket.current_session_id]
        return entry?.status === 'working' || entry?.status === 'planning'
      },
      [ticket.current_session_id]
    )
  )

  // ── API-error classification from the linked session's last turn ──
  // Cleared by the store when the session is relaunched; a fresh launch
  // rewrites current_session_id, which re-keys this selector.
  const sessionApiError = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        return state.sessionApiErrors[ticket.current_session_id] ?? null
      },
      [ticket.current_session_id]
    )
  )

  // ── Live background shells/monitors in the linked claude-cli session ──
  const backgroundWork = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        return state.backgroundWorkBySession[ticket.current_session_id] ?? null
      },
      [ticket.current_session_id]
    )
  )

  // ── Review session active on this ticket's worktree ────────────
  const isBeingReviewed = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (!ticket.worktree_id || ticket.column !== 'review') return false
        return ticket.worktree_id in state.reviewSessionByWorktree
      },
      [ticket.worktree_id, ticket.column]
    )
  )

  const completedReviewSessionId = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (!ticket.worktree_id) return null
        return state.completedReviewSessionByWorktree[ticket.worktree_id] ?? null
      },
      [ticket.worktree_id]
    )
  )

  // ── Detect pending questions for this ticket's session ─────────
  const isAskingFromQuestionStore = useQuestionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return false
        const questions = state.pendingBySession.get(ticket.current_session_id)
        return (questions?.length ?? 0) > 0
      },
      [ticket.current_session_id]
    )
  )
  const isAskingFromStatus = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return false
        return state.sessionStatuses[ticket.current_session_id]?.status === 'answering'
      },
      [ticket.current_session_id]
    )
  )
  const isAsking = isAskingFromQuestionStore || isAskingFromStatus

  const rightAlignedSlot: 'conflicts' | 'busy' | 'reviewing' | 'completed-review' | null =
    useMemo(() => {
      if (!isArchived && hasConflicts && conflictTargetWorktreeId) return 'conflicts'
      if ((isBusy || isAsking) && ticket.mode && !isBlocked) return 'busy'
      if (isBeingReviewed) return 'reviewing'
      if (completedReviewSessionId) return 'completed-review'
      return null
    }, [
      completedReviewSessionId,
      conflictTargetWorktreeId,
      hasConflicts,
      isArchived,
      isAsking,
      isBeingReviewed,
      isBlocked,
      isBusy,
      ticket.mode
    ])
  const hasRightAlignedStatus = rightAlignedSlot !== null

  const timerText = useSessionTimer(
    ticket.current_session_id,
    (isBusy || isAsking) && ticket.column === 'in_progress'
  )

  // Accumulated total for done/merged columns
  const doneTokenText =
    (ticket.column === 'done' || ticket.column === 'merged') && ticket.total_tokens > 0
      ? formatTokenCount(ticket.total_tokens)
      : null

  // Per-turn delta for active columns (unchanged)
  const turnTokenText = useSessionTokenDelta(
    ticket.current_session_id,
    (isBusy || isAsking) && ticket.column === 'in_progress'
  )

  // Done column shows accumulated total; everything else shows per-turn delta
  const tokenText = doneTokenText ?? turnTokenText

  // Time since the last column transition (created_at counts as the first one).
  // Selector derives the label from the global 1s tick — re-renders only when
  // the label itself changes (Now → 1m → 2m …).
  const transitionAgeText = useTimerTickStore(
    useCallback(() => formatTransitionAge(Date.parse(ticketTransitionTime(ticket))), [ticket])
  )

  // ── Detect if the linked worktree has a live run process ──────
  const isRunProcessAlive = useScriptStore(
    useCallback(
      (s) => {
        if (!ticket.worktree_id) return false
        return s.scriptStates[ticket.worktree_id]?.runRunning ?? false
      },
      [ticket.worktree_id]
    )
  )

  // ── Pin state for the assigned worktree ─────────────────────────
  const isPinned = usePinnedStore(
    useCallback(
      (s) => (ticket.worktree_id ? s.pinnedWorktreeIds.has(ticket.worktree_id) : false),
      [ticket.worktree_id]
    )
  )

  // Reads worktree list snapshot — reactive only to remoteInfo changes, not worktree additions.
  const hasGitRemote = useGitStore(
    useCallback(
      (state) => {
        const worktrees = useWorktreeStore.getState().worktreesByProject.get(ticket.project_id)
        if (!worktrees) return false
        return worktrees.some((wt) => {
          const info = state.remoteInfo.get(wt.id)
          return info?.hasRemote === true && info.supportsPR === true
        })
      },
      [ticket.project_id]
    )
  )

  const isCreatingPR = useGitStore(
    useCallback(
      (s) => ticket.worktree_id ? s.creatingPRByWorktreeId.get(ticket.worktree_id) === true : false,
      [ticket.worktree_id]
    )
  )

  const isError = sessionStatus === 'error' || sessionApiError !== null
  const hasAttachments = ticket.attachments.length > 0
  // Surface the model on cards that are part of a multi-model duplicate
  // group — for single-model launches the name is noise, unless the user
  // opted in via the "show model icons" setting.
  const showModelIcons = useSettingsStore((s) => s.showModelIcons)
  const showModelBadge = !!ticket.model_id && (showModelIcons || !!ticket.variant_group_id)
  const isForwardedToTelegram = useTelegramStore(
    useCallback(
      (state) => !!ticket.current_session_id && state.activeForwardingSessionId === ticket.current_session_id,
      [ticket.current_session_id]
    )
  )

  // ── Border state computation ────────────────────────────────────
  const borderState = useMemo(() => {
    if (ticket.column !== 'in_progress') return 'default'
    if (ticket.plan_ready) return 'violet'
    if (ticket.current_session_id && ticket.mode === 'build') return 'blue'
    if (ticket.current_session_id && ticket.mode === 'plan') return 'violet'
    if (ticket.current_session_id && ticket.mode === 'super-plan') return 'violet'
    if (ticket.current_session_id && ticket.mode === 'super-build') return 'blue'
    return 'default'
  }, [ticket.column, ticket.mode, ticket.plan_ready, ticket.current_session_id])

  // ── Drag handlers ──────────────────────────────────────────────
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      // Store drag data
      setKanbanDragData({
        projectId: ticket.project_id,
        ticketId: ticket.id,
        sourceColumn: ticket.column,
        sourceIndex: index
      })
      e.dataTransfer.setData('text/plain', ticket.id)
      e.dataTransfer.effectAllowed = 'move'

      // Create rotated clone for drag image
      const el = e.currentTarget as HTMLElement
      const clone = el.cloneNode(true) as HTMLElement
      clone.style.width = `${el.offsetWidth}px`
      clone.style.transform = 'rotate(3deg)'
      clone.style.position = 'fixed'
      clone.style.top = '-9999px'
      clone.style.left = '-9999px'
      clone.style.pointerEvents = 'none'
      clone.style.zIndex = '9999'
      document.body.appendChild(clone)
      e.dataTransfer.setDragImage(clone, el.offsetWidth / 2, el.offsetHeight / 2)
      dragCloneRef.current = clone

      // Clean up clone after browser captures it — double-rAF ensures
      // Chromium/Electron has finished reading the drag image before removal
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (dragCloneRef.current) {
            dragCloneRef.current.remove()
            dragCloneRef.current = null
          }
        })
      })

      // Hide the source only after Chromium has begun the OS drag session:
      // making it visibility:hidden synchronously inside dragstart aborts the
      // drag (dragstart→dragend, no drop). Deferring by a macrotask lets the
      // browser capture the drag image and start the session first.
      dragActiveRef.current = true
      setTimeout(() => {
        if (dragActiveRef.current) setIsDragging(true)
      }, 0)
    },
    [ticket.project_id, ticket.id, ticket.column, index]
  )

  const handleDragEnd = useCallback(() => {
    // Safety cleanup
    dragActiveRef.current = false
    if (dragCloneRef.current) {
      dragCloneRef.current.remove()
      dragCloneRef.current = null
    }
    setKanbanDragData(null)
    setIsDragging(false)
  }, [])

  const recordBoardTelegramTarget = useCallback(() => {
    if (!ticket.current_session_id || !ticket.worktree_id) return
    useKanbanStore.getState().setBoardTelegramTarget({
      ticketId: ticket.id,
      projectId: ticket.project_id,
      worktreeId: ticket.worktree_id,
      sessionId: ticket.current_session_id
    })
  }, [ticket.current_session_id, ticket.id, ticket.project_id, ticket.worktree_id])

  // ── Click handler — open ticket detail modal ───────────────────
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // In dependency mode, don't open the modal — let click bubble
      // to the board's handleBoardClick which toggles the dependency
      if (useKanbanStore.getState().dependencyMode?.active) return

      if (blockingDiagnostic) {
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // Any tap on the card marks it read (cmd+click paths open the session,
      // the plain path opens the detail modal)
      useKanbanStore.getState().markTicketRead(ticket.id, ticket.project_id)

      // Cmd+click (Mac) / Ctrl+click (Win/Linux) — select attached worktree;
      // cmd+shift+click — select the project's base worktree instead. Tickets
      // without a live worktree (never assigned, or the worktree was archived,
      // which detaches the ticket) fall back to the base worktree too.
      if (e.metaKey || e.ctrlKey) {
        const selectTicketWorktree = (): boolean => {
          const state = useWorktreeStore.getState()
          const attached =
            !e.shiftKey && ticket.worktree_id
              ? (state.worktreesByProject
                  .get(ticket.project_id)
                  ?.find((w) => w.id === ticket.worktree_id) ?? null)
              : null
          const target = attached ?? state.getDefaultWorktree(ticket.project_id)
          if (!target) return false
          if (attached) recordBoardTelegramTarget()
          const selectionOptions = isPinnedMode ? { preservePinnedBoard: true } : undefined
          state.selectWorktree(target.id, selectionOptions)
          useProjectStore.getState().selectProject(ticket.project_id, selectionOptions)
          useWorktreeStatusStore.getState().clearWorktreeUnread(target.id)
          return true
        }

        if (selectTicketWorktree()) {
          e.preventDefault()
          return
        }

        // Cmd+click on a connection ticket — select the connection in the
        // sidebar (same as ConnectionItem.handleClick), don't open the session;
        // cmd+shift+click on a connection project ticket — select the project's
        // base instance (each member project's default worktree) instead, the
        // twin of the base-worktree behavior above. Tickets whose instance is
        // gone (archived) fall back to the base instance too.
        const liveConnectionId = e.shiftKey
          ? null
          : (connectionId ?? connectionSession?.connectionId)
        const ticketConnectionId =
          liveConnectionId ?? findBaseInstanceConnection(ticket.project_id)?.id
        if (ticketConnectionId) {
          e.preventDefault()
          useConnectionStore.getState().selectConnection(ticketConnectionId)
          return
        }

        const project = useProjectStore.getState().projects.find((p) => p.id === ticket.project_id)

        // Connection project whose connections aren't in the store — they may
        // just not be loaded yet (e.g. a pinned board before any connection UI)
        if (project?.kind === 'connection') {
          e.preventDefault()
          void useConnectionStore
            .getState()
            .loadConnections()
            .then(() => {
              const base = findBaseInstanceConnection(ticket.project_id)
              if (base) useConnectionStore.getState().selectConnection(base.id)
            })
          return
        }

        // Git project with no worktrees in the store — they may just not be
        // loaded yet (e.g. a pinned board for a never-selected project)
        if (project) {
          e.preventDefault()
          void useWorktreeStore
            .getState()
            .loadWorktrees(ticket.project_id)
            .then(() => {
              selectTicketWorktree()
            })
          return
        }
      }

      useKanbanStore.getState().setSelectedTicketRef({
        projectId: ticket.project_id,
        ticketId: ticket.id
      })
    },
    [ticket.id, ticket.worktree_id, ticket.project_id, isPinnedMode, connectionId, connectionSession, recordBoardTelegramTarget, blockingDiagnostic]
  )

  // ── Right-button drag into In Progress — start immediately with the
  // picker's defaults (new worktree, build mode, default SDK/model), no modal
  const handleRightDrop = useCallback(
    (column: string | null) => {
      if (column !== 'in_progress' || ticket.column === 'in_progress') return
      if (isBlocked) {
        toast.warning('Ticket is blocked — resolve its dependencies first')
        return
      }
      // Connection boards have no worktree to create — start a connection
      // session instead (same defaults, mirrors the picker's connection path)
      if (connectionId) void quickLaunchTicketOnConnection(ticket, connectionId)
      else void quickLaunchTicket(ticket)
    },
    [ticket, isBlocked, connectionId]
  )
  const { onMouseDown: rightDragMouseDown, onContextMenuCapture: rightDragContextMenuCapture } =
    useRightButtonDrag({
      enabled: !isArchived && !blockingDiagnostic,
      onDrop: handleRightDrop,
      // Show the default model + effort the drop will launch with, riding
      // along under the ghost so it's clear before release
      decorateGhost: decorateRightDragGhost
    })

  // ── Middle-click — select attached worktree (same as sidebar) ─
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      rightDragMouseDown(e)
      if (e.button !== 1) return            // only middle-click
      if (!ticket.worktree_id) return        // no-op for unassigned tickets
      if (isArchived) return                 // no-op for archived tickets
      e.preventDefault()                     // suppress browser auto-scroll

      // Select worktree — same as sidebar's WorktreeItem.handleClick
      recordBoardTelegramTarget()
      const selectionOptions = isPinnedMode ? { preservePinnedBoard: true } : undefined
      useWorktreeStore.getState().selectWorktree(ticket.worktree_id, selectionOptions)
      useProjectStore.getState().selectProject(ticket.project_id, selectionOptions)
      useWorktreeStatusStore.getState().clearWorktreeUnread(ticket.worktree_id)
      useKanbanStore.getState().markTicketRead(ticket.id, ticket.project_id)
    },
    [
      ticket.id,
      ticket.worktree_id,
      ticket.project_id,
      isArchived,
      isPinnedMode,
      recordBoardTelegramTarget,
      rightDragMouseDown
    ]
  )

  const handleMouseEnter = useCallback(() => {
    if (isBlocked) {
      useKanbanStore.getState().setHoveredBlockedTicketRef({
        projectId: ticket.project_id,
        ticketId: ticket.id
      })
    }
  }, [isBlocked, ticket.id, ticket.project_id])

  const handleMouseLeave = useCallback(() => {
    useKanbanStore.getState().setHoveredBlockedTicketRef(null)
  }, [])

  // Merged behaves like Done for archive/delete affordances — merged tickets
  // are archivable and surface in Done's archived section
  const isDone = ticket.column === 'done' || ticket.column === 'merged'

  // ── Context menu handlers ─────────────────────────────────────
  const handleDelete = useCallback(async () => {
    try {
      await useKanbanStore.getState().deleteTicket(ticket.id, ticket.project_id)
      toast.success('Ticket deleted')
    } catch {
      toast.error('Failed to delete ticket')
    }
    setShowDeleteConfirm(false)
  }, [ticket.id, ticket.project_id])

  const handleStopRemoteSession = useCallback(async () => {
    const sessionId = ticket.current_session_id
    setShowStopRemoteConfirm(false)
    if (!sessionId) return
    try {
      const result = await remoteLaunchApi.stop({ sessionId })
      if (result.killed || result.alreadyDead) {
        useRemoteLaunchStore.getState().markStopped(sessionId)
        toast.success(
          result.killed ? 'Remote session stopped' : 'Remote session was already stopped'
        )
      }
    } catch (err) {
      toast.error(
        `Failed to stop remote session: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }, [ticket.current_session_id])

  const handleArchive = useCallback(async () => {
    try {
      await useKanbanStore.getState().archiveTicket(ticket.id, ticket.project_id)
      toast.success('Ticket archived')
    } catch {
      toast.error('Failed to archive ticket')
    }
  }, [ticket.id, ticket.project_id])

  const handleDuplicate = useCallback(async () => {
    try {
      const store = useKanbanStore.getState()
      const created = await store.createTicket(ticket.project_id, {
        project_id: ticket.project_id,
        title: ticket.title,
        description: ticket.description,
        column: 'todo'
      })
      // Goal fields aren't part of the create payload — mirror them after creation
      if (ticket.goal_mode || ticket.goal_success_criteria) {
        await store.updateTicket(created.id, ticket.project_id, {
          goal_mode: ticket.goal_mode,
          goal_success_criteria: ticket.goal_success_criteria
        })
      }
      toast.success('Ticket duplicated')
    } catch {
      toast.error('Failed to duplicate ticket')
    }
  }, [
    ticket.project_id,
    ticket.title,
    ticket.description,
    ticket.goal_mode,
    ticket.goal_success_criteria
  ])

  const handleAddToFavorites = useCallback(async () => {
    try {
      await useFavoriteTicketsStore.getState().createFavorite({
        title: ticket.title,
        description: ticket.description,
        goal_mode: ticket.goal_mode,
        goal_success_criteria: ticket.goal_success_criteria
      })
      toast.success('Added to favorites')
    } catch {
      toast.error('Failed to add to favorites')
    }
  }, [ticket.title, ticket.description, ticket.goal_mode, ticket.goal_success_criteria])

  const handleMoveToProject = useCallback(
    async (project: { id: string; name: string }) => {
      setShowMoveToProject(false)
      const sourceProjectId = ticket.project_id
      try {
        await useKanbanStore
          .getState()
          .moveTicketToProject(ticket.id, sourceProjectId, project.id)
        toast.success(`Moved to ${project.name}`, {
          action: {
            label: 'Undo',
            onClick: () => {
              useKanbanStore
                .getState()
                .moveTicketToProject(ticket.id, project.id, sourceProjectId)
                .catch(() => toast.error('Failed to undo move'))
            }
          }
        })
      } catch {
        toast.error('Failed to move ticket')
      }
    },
    [ticket.id, ticket.project_id]
  )

  const handleUnarchive = useCallback(async () => {
    try {
      await useKanbanStore.getState().unarchiveTicket(ticket.id, ticket.project_id)
      toast.success('Ticket unarchived')
    } catch {
      toast.error('Failed to unarchive ticket')
    }
  }, [ticket.id, ticket.project_id])

  const handleJumpToSession = useCallback(() => {
    if (!ticket.current_session_id) return
    const kanbanStore = useKanbanStore.getState()
    kanbanStore.markTicketRead(ticket.id, ticket.project_id)
    if (kanbanStore.isBoardViewActive) kanbanStore.toggleBoardView()
    if (kanbanStore.isPinnedBoardActive) kanbanStore.togglePinnedBoard()
    if (connectionId) {
      // Connection mode: navigate to the connection and set session
      useConnectionStore.getState().selectConnection(connectionId)
      useSessionStore.getState().setActiveConnection(connectionId)
      useSessionStore.getState().setActiveSession(ticket.current_session_id)
    } else {
      // Project mode: navigate to the worktree/connection and set session
      if (connectionSession) {
        // Ticket has a connection session — navigate to connection context
        useConnectionStore.getState().selectConnection(connectionSession.connectionId)
        useSessionStore.getState().setActiveConnection(connectionSession.connectionId)
        useSessionStore.getState().setActiveSession(ticket.current_session_id)
      } else if (ticket.worktree_id) {
        useWorktreeStore.getState().selectWorktree(ticket.worktree_id)
        useSessionStore.getState().setActiveWorktree(ticket.worktree_id)
        useSessionStore.getState().setActiveSession(ticket.current_session_id)
      } else {
        // In pinned mode the current project context may not match the ticket's project;
        // navigate to it so the user lands in the right project.
        if (isPinnedMode && ticket.project_id) {
          useProjectStore.getState().selectProject(ticket.project_id)
        }
        useSessionStore.getState().setActiveSession(ticket.current_session_id)
      }
    }
  }, [ticket.current_session_id, ticket.id, ticket.worktree_id, ticket.project_id, connectionId, connectionSession, isPinnedMode])

  const handleGoToReview = useCallback(() => {
    if (!completedReviewSessionId) return
    const kanbanStore = useKanbanStore.getState()
    kanbanStore.markTicketRead(ticket.id, ticket.project_id)
    if (kanbanStore.isBoardViewActive) kanbanStore.toggleBoardView()
    if (kanbanStore.isPinnedBoardActive) kanbanStore.togglePinnedBoard()
    if (ticket.worktree_id) {
      useWorktreeStore.getState().selectWorktree(ticket.worktree_id)
      useSessionStore.getState().setActiveWorktree(ticket.worktree_id)
    }
    useSessionStore.getState().setActiveSession(completedReviewSessionId)
  }, [completedReviewSessionId, ticket.worktree_id, ticket.id, ticket.project_id])

  const isSimpleTicket = ticket.current_session_id === null
  const isFlowTicket = ticket.current_session_id !== null
  const isTodo = ticket.column === 'todo'
  // Connection-project tickets have no single worktree — the assign/pre-assign
  // worktree flows don't apply to them.
  const isConnectionProjectTicket = useProjectStore(
    useCallback(
      (state) => state.projects.find((p) => p.id === ticket.project_id)?.kind === 'connection',
      [ticket.project_id]
    )
  )

  const handleUnassignWorktree = useCallback(async () => {
    try {
      await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, {
        worktree_id: null
      })
      toast.success('Worktree unassigned')
    } catch {
      toast.error('Failed to unassign worktree')
    }
  }, [ticket.id, ticket.project_id])

  const handleTogglePin = useCallback(async () => {
    if (!ticket.worktree_id) return
    if (isPinned) {
      await usePinnedStore.getState().unpinWorktree(ticket.worktree_id)
    } else {
      await usePinnedStore.getState().pinWorktree(ticket.worktree_id)
    }
  }, [isPinned, ticket.worktree_id])

  const handleEditContext = useCallback(() => {
    if (!ticket.worktree_id) return
    useFileViewerStore.getState().openContextEditor(ticket.worktree_id)
  }, [ticket.worktree_id])

  const handleResumeGoal = useCallback(async () => {
    if (!ticket.current_session_id) return
    if (!ticket.worktree_id) {
      toast.error('No worktree assigned to this ticket')
      return
    }

    const worktrees = Array.from(useWorktreeStore.getState().worktreesByProject.values()).flat()
    const worktree = worktrees.find((w) => w.id === ticket.worktree_id)
    if (!worktree) {
      toast.error('Worktree not found')
      return
    }

    try {
      const result = unwrapEnvelope(
        await opencodeApi.command(
          worktree.path,
          ticket.current_session_id,
          'goal',
          'resume'
        )
      )
      if (!result.success) {
        toast.error(result.error ?? 'Failed to resume goal')
      }
    } catch (err) {
      console.error('Failed to resume goal:', err)
      toast.error('Failed to resume goal')
    }
  }, [ticket.current_session_id, ticket.worktree_id])

  const handleMarkChange = useCallback(async (value: string) => {
    try {
      await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, {
        mark: value === 'none' ? null : value as TicketMark
      })
    } catch {
      toast.error('Failed to update ticket mark')
    }
  }, [ticket.id, ticket.project_id])

  const canToggleAutoApprove =
    !isArchived && !blockingDiagnostic && canToggleAutoApprovePlan(ticket, linkedSessionAgentSdk)

  const handleToggleAutoApprove = useCallback(async () => {
    const next = !ticket.auto_approve_plan
    try {
      await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, {
        auto_approve_plan: next
      })
      // Mirror the durable flag into the hook server's in-memory armed registry
      // when a claude-cli session is already live; sessions armed before they
      // exist are registered by the status listener on their first planning turn.
      if (ticket.current_session_id && isClaudeCli(linkedSessionAgentSdk)) {
        await terminalApi.setClaudeCliPlanAutoApprove(ticket.current_session_id, next)
      }
    } catch {
      toast.error('Failed to toggle auto approve')
    }
  }, [
    ticket.id,
    ticket.project_id,
    ticket.auto_approve_plan,
    ticket.current_session_id,
    linkedSessionAgentSdk
  ])

  const handleSaveNote = useCallback(async (note: string | null) => {
    try {
      await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, { note })
    } catch (err) {
      toast.error(`Failed to save note: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [ticket.id, ticket.project_id])

  return (
    <>
      <Popover open={showPRPicker} onOpenChange={setShowPRPicker}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <PopoverAnchor asChild>
              <div
                data-testid={`kanban-ticket-${ticket.id}`}
                data-ticket-id={ticket.id}
                data-project-id={ticket.project_id}
                data-ticket-key={domTicketKey}
                data-sidebar-hover-highlight={isSidebarHoverHighlighted ? '' : undefined}
                draggable={!isArchived && !blockingDiagnostic}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onClick={handleClick}
                onMouseDown={handleMouseDown}
                onContextMenuCapture={rightDragContextMenuCapture}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                className={cn(
                  'group cursor-pointer rounded-md border bg-card px-2.5 pt-2.5 pb-2 transition-[border-color,background-color] duration-150',
                  'hover:border-muted-foreground/35',
                  isDragging && 'invisible',
                  isArchived && 'opacity-50 cursor-default',
                  (isBlocked || blockingDiagnostic) && 'opacity-60',
                  // Highlighted as a blocker of the currently hovered ticket
                  isHighlightedAsBlocker && 'border-dashed !border-amber-500/70 ring-1 ring-amber-500/30',
                  // Linked to the sidebar project/worktree/connection under the pointer
                  !isHighlightedAsBlocker &&
                    isSidebarHoverHighlighted &&
                    '!border-sky-400 ring-2 ring-sky-400/70 bg-sky-400/10',
                  // API-errored session: full red perimeter, overriding mode
                  // rails and mark stripes until the session is relaunched
                  !hasHoverHighlight && isError && '!border-red-500/70 ring-1 ring-red-500/25',
                  !hasHoverHighlight && !isError && borderState === 'default' && 'border-border',
                  // Mode cue lives in a 2px left rail; the perimeter stays neutral
                  !hasHoverHighlight && !isError && borderState === 'blue' && 'border-border border-l-2 !border-l-blue-500/60',
                  !hasHoverHighlight && !isError && borderState === 'violet' && 'border-border border-l-2 !border-l-violet-500/60',
                  // Left accent stripe for marks
                  !isError && !isSidebarHoverHighlighted && ticket.mark === 'common' && 'border-l-2 !border-l-green-500',
                  !isError && !isSidebarHoverHighlighted && ticket.mark === 'rare' && 'border-l-2 !border-l-blue-500',
                  !isError && !isSidebarHoverHighlighted && ticket.mark === 'epic' && 'border-l-2 !border-l-pink-500',
                  !isError && !isSidebarHoverHighlighted && ticket.mark === 'legendary' && 'border-l-2 !border-l-orange-500'
                )}
              >
            {/* Title + top-right indicators */}
            <div className="flex items-start justify-between gap-2">
              {ticket.unread && (
                <span
                  data-testid="ticket-unread-dot"
                  title="Unread — just moved to review"
                  className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/70"
                />
              )}
              <p
                className={cn(
                  'text-[13px] leading-[1.4] text-foreground min-w-0 flex-1 break-words',
                  // Unread (just landed in review): bold until opened
                  ticket.unread ? 'font-bold' : 'font-medium'
                )}
              >
                <HighlightedText text={ticket.title} normQuery={normQuery} />
              </p>
              <div className="flex items-center gap-1.5 shrink-0">
                <span
                  data-testid="ticket-transition-age"
                  title="Time since last column change"
                  className="text-[10px] tabular-nums text-muted-foreground/60"
                >
                  {transitionAgeText}
                </span>
                {tokenText && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {tokenText}
                  </span>
                )}
                {blockingDiagnostic && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8}>
                      {blockingDiagnostic.message}
                    </TooltipContent>
                  </Tooltip>
                )}
                {ticket.external_provider && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (ticket.external_url) {
                        systemApi.openInChrome(ticket.external_url)
                      }
                    }}
                    className="transition-opacity hover:opacity-80"
                    title={`${getProviderLabel(ticket.external_provider)} #${ticket.external_id}`}
                  >
                    <ProviderIcon provider={ticket.external_provider} />
                  </button>
                )}
              </div>
            </div>

            {/* Description match snippet (board search) */}
            {descriptionSnippet && (
              <p
                data-testid="board-search-snippet"
                className="mt-1.5 truncate border-l-2 border-border pl-2 text-[11px] leading-snug text-muted-foreground"
              >
                {descriptionSnippet.prefixEllipsis && '…'}
                {descriptionSnippet.before}
                <mark className="bg-foreground/12 text-foreground rounded-[3px] px-px">
                  {descriptionSnippet.match}
                </mark>
                {descriptionSnippet.after}
                {descriptionSnippet.suffixEllipsis && '…'}
              </p>
            )}

            {/* Badges + progress row */}
            {(hasAttachments || hasNote || worktreeName || queuedBranchLabel || projectTag || connectionName || ticket.plan_ready || isError || rightAlignedSlot || isArchived || isBlocked || blockingDiagnostic || isRunProcessAlive || ticket.github_pr_number || isCreatingPR || isForwardedToTelegram || ticket.goal_mode || ticket.auto_approve_plan || activeRemoteLaunch || showModelBadge || backgroundWork) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {/* Archived badge */}
                {isArchived && (
                  <span className={cn(ticketPillClass, 'italic')}>
                    <Archive className="h-2.5 w-2.5" />
                    Archived
                  </span>
                )}
                {/* Remote launch badge */}
                {activeRemoteLaunch && (
                  <span
                    data-testid="ticket-remote-badge"
                    className={cn(ticketPillBaseClass, 'border-sky-500/30 bg-sky-500/10 text-sky-500')}
                  >
                    <RadioTower className="h-2.5 w-2.5" />
                    Remote
                  </span>
                )}
                {isForwardedToTelegram && (
                  <span
                    title="Forwarding to Telegram"
                    className={cn(ticketPillBaseClass, 'border-[#229ED9]/30 bg-[#229ED9]/10 text-[#229ED9]')}
                  >
                    <Send className="h-2.5 w-2.5" />
                  </span>
                )}
                {blockingDiagnostic && (
                  <span className={cn(ticketPillBaseClass, 'border-destructive/30 bg-destructive/10 text-destructive')}>
                    <AlertTriangle className="h-2.5 w-2.5" />
                    Markdown
                  </span>
                )}
                {/* Blocked badge */}
                {isBlocked && (
                  <span className={cn(ticketPillBaseClass, 'border-amber-500/30 bg-amber-500/10 text-amber-500')}>
                    <Lock className="h-2.5 w-2.5" />
                    {unresolvedBlockerCount}
                  </span>
                )}
                {/* Queued launch target badge — branch the queued ticket will run on */}
                {queuedBranchLabel && (
                  <span
                    data-testid="ticket-queued-branch"
                    className={ticketPillClass}
                  >
                    <GitBranch className="h-2.5 w-2.5" />
                    {queuedBranchLabel}
                  </span>
                )}
                {/* Running subagents in the linked claude-cli session */}
                {backgroundWork && backgroundWork.runningSubagents > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        data-testid="kanban-ticket-running-subagents"
                        className={cn(ticketPillBaseClass, 'border-violet-500/30 bg-violet-500/10 text-violet-500 cursor-help')}
                      >
                        <Bot className="h-2.5 w-2.5" />
                        {backgroundWork.runningSubagents}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {backgroundWork.runningSubagents === 1
                        ? '1 subagent running'
                        : `${backgroundWork.runningSubagents} subagents running`}
                    </TooltipContent>
                  </Tooltip>
                )}
                {/* Running background shells in the linked claude-cli session */}
                {backgroundWork && backgroundWork.runningShells > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        data-testid="kanban-ticket-running-shells"
                        className={cn(ticketPillBaseClass, 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500 cursor-help')}
                      >
                        <SquareTerminal className="h-2.5 w-2.5" />
                        {backgroundWork.runningShells}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {backgroundWork.runningShells === 1
                        ? '1 background shell running'
                        : `${backgroundWork.runningShells} background shells running`}
                    </TooltipContent>
                  </Tooltip>
                )}
                {/* Running monitors in the linked claude-cli session */}
                {backgroundWork && backgroundWork.runningMonitors > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        data-testid="kanban-ticket-running-monitors"
                        className={cn(ticketPillBaseClass, 'border-cyan-500/30 bg-cyan-500/10 text-cyan-500 cursor-help')}
                      >
                        <Radar className="h-2.5 w-2.5" />
                        {backgroundWork.runningMonitors}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {backgroundWork.runningMonitors === 1
                        ? '1 monitor running'
                        : `${backgroundWork.runningMonitors} monitors running`}
                    </TooltipContent>
                  </Tooltip>
                )}
                {/* Attachment badge */}
                {hasAttachments && (
                  <span
                    data-testid="kanban-ticket-attachments"
                    className={ticketPillClass}
                  >
                    <Paperclip className="h-2.5 w-2.5" />
                    {ticket.attachments.length}
                  </span>
                )}
                {/* Note badge */}
                {hasNote && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        data-testid="kanban-ticket-note"
                        className={cn(ticketPillClass, 'cursor-help')}
                      >
                        <StickyNote className="h-2.5 w-2.5" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs whitespace-pre-wrap break-words">
                      {ticket.note}
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Model badge — only for multi-model duplicate groups */}
                {showModelBadge && <TicketModelBadge ticket={ticket} />}

                {/* Project tag (connection mode) or worktree name badge */}
                {projectTag ? (
                  <span className={ticketPillClass}>
                    {projectTag.iconUrl ? (
                      <img
                        src={projectTag.iconUrl}
                        alt=""
                        aria-hidden="true"
                        data-testid="kanban-ticket-project-icon"
                        className="h-3 w-3 shrink-0 object-contain rounded-sm"
                      />
                    ) : (
                      <span
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{ backgroundColor: projectTag.color }}
                      />
                    )}
                    {projectTag.name}
                  </span>
                ) : worktreeName ? (
                  <span className={ticketPillClass}>
                    {worktreeName}
                  </span>
                ) : null}

                {/* Connection badge — shown on project board when ticket has connection session */}
                {!connectionId && connectionName && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        data-testid="kanban-ticket-connection"
                        className={cn(ticketPillClass, 'cursor-help')}
                      >
                        {connectionColor ? (
                          <span
                            className="h-2.5 w-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: parseColorQuad(connectionColor)[1] }}
                            aria-hidden="true"
                          />
                        ) : (
                          <LinkIcon className="h-2.5 w-2.5 text-muted-foreground" />
                        )}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{connectionName}</TooltipContent>
                  </Tooltip>
                )}

                {/* PR badge */}
                {ticket.github_pr_number && ticket.github_pr_url && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      systemApi.openInChrome(ticket.github_pr_url!)
                    }}
                    title={`Open PR #${ticket.github_pr_number} in browser`}
                    className={cn(ticketPillClass, 'hover:border-muted-foreground/35 hover:text-foreground transition-colors')}
                  >
                    <GitPullRequest className="h-2.5 w-2.5" />
                    #{ticket.github_pr_number}
                  </button>
                )}

                {/* Creating PR indicator */}
                {isCreatingPR && (
                  <span className={ticketPillClass}>
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    Creating PR...
                  </span>
                )}

                {/* Run process alive indicator */}
                {isRunProcessAlive && (
                  <PulseAnimation className="h-3 w-3 text-emerald-500 shrink-0" />
                )}

                {/* Plan ready badge */}
                {ticket.plan_ready && (
                  <span className={cn(ticketPillBaseClass, 'border-violet-500/30 bg-violet-500/10 text-violet-500')}>
                    Plan ready
                  </span>
                )}

                {/* Auto-approve plan badge */}
                {ticket.auto_approve_plan && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        data-testid="kanban-ticket-auto-approve"
                        className={cn(ticketPillBaseClass, 'border-violet-500/30 bg-violet-500/10 text-violet-500 cursor-help')}
                      >
                        <FastForward className="h-2.5 w-2.5" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Auto approve plan: implementation starts automatically when the plan is ready
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Error badge */}
                {isError && (
                  <span
                    data-testid="kanban-ticket-error-badge"
                    title={
                      sessionApiError
                        ? `Claude API error: ${sessionApiError.replace(/_/g, ' ')}`
                        : undefined
                    }
                    className={cn(ticketPillBaseClass, 'border-red-500/30 bg-red-500/10 text-red-500')}
                  >
                    <AlertCircle className="h-2.5 w-2.5" />
                    Error
                  </span>
                )}

                {(() => {
                  switch (rightAlignedSlot) {
                    case 'conflicts': {
                      const isConflictFlowActive =
                        conflictFlow?.phase === 'starting' ||
                        conflictFlow?.phase === 'running' ||
                        conflictFlow?.phase === 'refreshing'
                      if (isConflictFlowActive) {
                        return (
                          <span
                            data-testid="kanban-ticket-conflict-progress"
                            className="ml-auto flex items-center gap-1.5"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (conflictFlow?.phase !== 'starting') openAttachedSession()
                            }}
                          >
                            <IndeterminateProgressBar
                              mode={ticket.mode || 'build'}
                              isFixingConflicts
                              className="w-20"
                            />
                          </span>
                        )
                      }

                      if (mergeConflictMode === 'always-ask') {
                        return (
                          <span className="ml-auto" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  className="inline-flex items-center rounded-[5px] border border-destructive/30 bg-destructive/8 px-2 py-0.5 text-[11px] font-medium text-destructive hover:bg-destructive/15 transition-colors"
                                  data-testid="kanban-ticket-fix-conflicts"
                                >
                                  <AlertTriangle className="h-3 w-3 mr-1" />
                                  Fix conflicts
                                  <ChevronDown className="h-3 w-3 ml-1" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void startFixFlow('build')
                                  }}
                                >
                                  <Hammer className="h-4 w-4 mr-2" />
                                  Fix in Build mode
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void startFixFlow('plan')
                                  }}
                                >
                                  <MapIcon className="h-4 w-4 mr-2" />
                                  Fix in Plan mode
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </span>
                        )
                      }

                      return (
                        <button
                          className="ml-auto inline-flex items-center rounded-[5px] border border-destructive/30 bg-destructive/8 px-2 py-0.5 text-[11px] font-medium text-destructive hover:bg-destructive/15 transition-colors"
                          data-testid="kanban-ticket-fix-conflicts"
                          onClick={(e) => {
                            e.stopPropagation()
                            void startFixFlow()
                          }}
                        >
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          Fix conflicts
                        </button>
                      )
                    }
                    case 'busy':
                      return (
                        <span data-testid="kanban-ticket-progress" className="ml-auto flex items-center gap-1.5">
                          {timerText && (
                            <span className={cn(
                              'text-[10px] tabular-nums font-normal',
                              isAsking
                                ? 'text-orange-500'
                                : ticket.mode === 'build'
                                  ? 'text-blue-500'
                                  : 'text-violet-500'
                            )}>
                              {timerText}
                            </span>
                          )}
                          <IndeterminateProgressBar mode={ticket.mode!} isAsking={isAsking} className="w-20" />
                          {isAsking && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-orange-500">
                              <MessageCircleQuestion className="h-3 w-3" />
                              Question
                            </span>
                          )}
                        </span>
                      )
                    case 'reviewing':
                      return (
                        <span data-testid="kanban-ticket-reviewing" className="ml-auto flex items-center gap-1.5">
                          <IndeterminateProgressBar mode={ticket.mode || 'build'} isReviewing className="w-20" />
                        </span>
                      )
                    case 'completed-review':
                      return (
                        <button
                          data-testid="kanban-ticket-go-to-review"
                          onClick={(e) => { e.stopPropagation(); handleGoToReview() }}
                          className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-emerald-500 hover:underline cursor-pointer"
                        >
                          <Check className="h-3 w-3" />
                          Go to review
                        </button>
                      )
                    default:
                      return null
                  }
                })()}

                {/* Goal mode badge */}
                {ticket.goal_mode && (() => {
                  const isComplete = goalStatus === 'complete'
                  const isPaused = goalStatus === 'paused' || goalStatus === 'budgetLimited'
                  const tooltipText = isComplete ? 'Goal complete' : isPaused ? 'Goal paused' : 'Goal mode'

                  const badge = (
                    <span
                      data-testid="kanban-ticket-goal"
                      onContextMenu={isPaused ? (e) => e.stopPropagation() : undefined}
                      className={cn(
                        'inline-flex items-center rounded-full border border-border bg-secondary px-1.5 py-0.5 text-foreground',
                        isPaused ? 'cursor-context-menu' : 'cursor-help',
                        !hasRightAlignedStatus && 'ml-auto'
                      )}
                    >
                      <span className="relative inline-flex h-3 w-3 items-center justify-center">
                        <CheckeredFlagIcon className="h-3 w-3" />
                        {isComplete && (
                          <span className="absolute -right-1 -top-1 inline-flex h-2.5 w-2.5 items-center justify-center rounded-full bg-emerald-500 text-white ring-1 ring-background">
                            <Check className="h-2 w-2 stroke-[3]" />
                          </span>
                        )}
                        {isPaused && (
                          <span className="absolute -right-1 -top-1 inline-flex h-2.5 w-2.5 items-center justify-center rounded-full bg-amber-500 text-white ring-1 ring-background">
                            <Pause className="h-1.5 w-1.5 fill-current stroke-[3]" />
                          </span>
                        )}
                      </span>
                    </span>
                  )

                  return isPaused && !blockingDiagnostic ? (
                    <ContextMenu>
                      <Tooltip>
                        <ContextMenuTrigger asChild>
                          <TooltipTrigger asChild>{badge}</TooltipTrigger>
                        </ContextMenuTrigger>
                        <TooltipContent>{tooltipText}</TooltipContent>
                      </Tooltip>
                      <ContextMenuContent>
                        <ContextMenuItem
                          data-testid="ctx-resume-goal"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleResumeGoal()
                          }}
                          className="gap-2"
                        >
                          <Play className="h-3.5 w-3.5" />
                          Resume goal
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {badge}
                      </TooltipTrigger>
                      <TooltipContent>{tooltipText}</TooltipContent>
                    </Tooltip>
                  )
                })()}
              </div>
            )}
              </div>
            </PopoverAnchor>
          </ContextMenuTrigger>

          <ContextMenuContent>
          {blockingDiagnostic ? (
            <>
              {isFlowTicket && !(connectionSession && !connectionName) && (
                <ContextMenuItem
                  data-testid="ctx-jump-to-session"
                  onClick={handleJumpToSession}
                  className="gap-2"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Jump to session
                </ContextMenuItem>
              )}

              {ticket.worktree_id && (
                <>
                  <ContextMenuItem
                    data-testid="ctx-edit-context"
                    onClick={handleEditContext}
                    className="gap-2"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Edit Context
                  </ContextMenuItem>
                  <ContextMenuItem
                    data-testid="ctx-toggle-pin"
                    onClick={handleTogglePin}
                    className="gap-2"
                  >
                    {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    {isPinned ? 'Unpin worktree' : 'Pin worktree'}
                  </ContextMenuItem>
                </>
              )}

              {!isFlowTicket && !ticket.worktree_id && (
                <ContextMenuItem disabled className="text-muted-foreground text-xs">
                  Resolve markdown diagnostic before editing
                </ContextMenuItem>
              )}
            </>
          ) : (
            <>
          {/* Todo tickets without worktree: pre-assign */}
          {isSimpleTicket && isTodo && !ticket.worktree_id && !isConnectionProjectTicket && (
            <ContextMenuItem
              data-testid="ctx-assign-worktree"
              onClick={() => setShowPreAssignPicker(true)}
              className="gap-2"
            >
              <GitBranch className="h-3.5 w-3.5" />
              Assign worktree
            </ContextMenuItem>
          )}

          {/* Todo tickets WITH pre-assigned worktree: change or unassign */}
          {isSimpleTicket && isTodo && ticket.worktree_id && (
            <>
              <ContextMenuItem
                data-testid="ctx-change-worktree"
                onClick={() => setShowPreAssignPicker(true)}
                className="gap-2"
              >
                <GitBranch className="h-3.5 w-3.5" />
                Change worktree
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="ctx-unassign-worktree"
                onClick={handleUnassignWorktree}
                className="gap-2"
              >
                <X className="h-3.5 w-3.5" />
                Unassign worktree
              </ContextMenuItem>
            </>
          )}

          {/* Non-todo simple tickets: full assign flow (existing behavior) */}
          {isSimpleTicket && !isTodo && !isConnectionProjectTicket && (
            <ContextMenuItem
              data-testid="ctx-assign-worktree"
              onClick={() => setShowWorktreePicker(true)}
              className="gap-2"
            >
              <GitBranch className="h-3.5 w-3.5" />
              Assign to worktree
            </ContextMenuItem>
          )}

          {/* Jump to session — only for flow tickets with reachable session */}
          {isFlowTicket && !(connectionSession && !connectionName) && (
            <ContextMenuItem
              data-testid="ctx-jump-to-session"
              onClick={handleJumpToSession}
              className="gap-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Jump to session
            </ContextMenuItem>
          )}

          {/* Remote launch actions — only when the current session is a remote (client-role) launch */}
          {activeRemoteLaunch && (
            <>
              <ContextMenuItem
                data-testid="ctx-open-remote-terminal"
                onClick={() => setRemoteTerminalOpen(true)}
                className="gap-2"
              >
                <RadioTower className="h-3.5 w-3.5" />
                Open remote terminal
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="ctx-stop-remote-session"
                onClick={() => setShowStopRemoteConfirm(true)}
                className="gap-2 text-destructive focus:text-destructive"
              >
                <Unplug className="h-3.5 w-3.5" />
                Stop remote session
              </ContextMenuItem>
            </>
          )}

          {/* Worktree actions: edit context & pin/unpin (when worktree assigned) */}
          {ticket.worktree_id && (
            <>
              <ContextMenuItem
                data-testid="ctx-edit-context"
                onClick={handleEditContext}
                className="gap-2"
              >
                <FileText className="h-3.5 w-3.5" />
                Edit Context
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="ctx-toggle-pin"
                onClick={handleTogglePin}
                className="gap-2"
              >
                {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                {isPinned ? 'Unpin worktree' : 'Pin worktree'}
              </ContextMenuItem>
            </>
          )}

          {/* Update status on remote platform */}
          {isExternalTicket && (
            <ContextMenuItem
              data-testid="ctx-update-remote-status"
              onClick={() => setShowStatusUpdate(true)}
              className="gap-2"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Update on {getProviderLabel(ticket.external_provider!)}
            </ContextMenuItem>
          )}

          {/* Attach PR */}
          {hasGitRemote && (
            <ContextMenuItem
              data-testid="ctx-attach-pr"
              onClick={() => setShowPRPicker(true)}
              className="gap-2"
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              Attach PR
            </ContextMenuItem>
          )}

          <ContextMenuItem onClick={() => setShowNoteEditor(true)} className="gap-2">
            <StickyNote className="h-3.5 w-3.5" />
            {hasNote ? 'Edit note' : 'Add note'}
          </ContextMenuItem>
          {hasNote && (
            <ContextMenuItem onClick={() => handleSaveNote(null)} className="gap-2">
              <X className="h-3.5 w-3.5" />
              Remove note
            </ContextMenuItem>
          )}

          {canToggleAutoApprove && (
            <ContextMenuItem
              data-testid="ctx-toggle-auto-approve"
              onClick={() => void handleToggleAutoApprove()}
              className="gap-2"
            >
              <FastForward className="h-3.5 w-3.5" />
              {ticket.auto_approve_plan ? 'Disable auto approve' : 'Auto approve'}
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="ctx-mark-submenu" className="gap-2">
              <Sparkles className="h-3.5 w-3.5" />
              Mark
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup value={ticket.mark ?? 'none'} onValueChange={handleMarkChange}>
                <ContextMenuRadioItem value="none">No Mark</ContextMenuRadioItem>
                <ContextMenuRadioItem value="common">
                  <span className="h-2 w-2 rounded-full bg-green-500 inline-block mr-2" />
                  Common
                </ContextMenuRadioItem>
                <ContextMenuRadioItem value="rare">
                  <span className="h-2 w-2 rounded-full bg-blue-500 inline-block mr-2" />
                  Rare
                </ContextMenuRadioItem>
                <ContextMenuRadioItem value="epic">
                  <span className="h-2 w-2 rounded-full bg-pink-500 inline-block mr-2" />
                  Epic
                </ContextMenuRadioItem>
                <ContextMenuRadioItem value="legendary">
                  <span className="h-2 w-2 rounded-full bg-orange-500 inline-block mr-2" />
                  Legendary
                </ContextMenuRadioItem>
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="ctx-dependencies-submenu" className="gap-2">
              <Link2 className="h-3.5 w-3.5" />
              Dependencies
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                data-testid="ctx-add-dependency"
                onClick={() => useKanbanStore.getState().enterDependencyMode(ticket.id, ticket.project_id)}
                className="gap-2"
              >
                <Plus className="h-3.5 w-3.5" />
                Add dependency...
              </ContextMenuItem>
              {blockerTickets.length > 0 && <ContextMenuSeparator />}
              {blockerTickets.map(blocker => (
                <ContextMenuItem
                  key={`${blocker.project_id}:${blocker.id}`}
                  className="gap-2 justify-between"
                  onSelect={(e) => {
                    e.preventDefault()
                    useKanbanStore.getState().removeDependency(
                      { projectId: ticket.project_id, ticketId: ticket.id },
                      { projectId: blocker.project_id, ticketId: blocker.id }
                    )
                  }}
                >
                  <span className="truncate max-w-[180px]">{blocker.title}</span>
                  <X className="h-3 w-3 shrink-0 text-muted-foreground hover:text-foreground" />
                </ContextMenuItem>
              ))}
              {blockerTickets.length === 0 && (
                <ContextMenuItem disabled className="text-muted-foreground text-xs">
                  (No dependencies)
                </ContextMenuItem>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuItem
            data-testid="ctx-duplicate-ticket"
            onClick={() => void handleDuplicate()}
            className="gap-2"
          >
            <Copy className="h-3.5 w-3.5" />
            Duplicate
          </ContextMenuItem>

          <ContextMenuItem
            data-testid="ctx-add-to-favorites"
            onClick={() => void handleAddToFavorites()}
            className="gap-2"
          >
            <Star className="h-3.5 w-3.5" />
            Add to favorites
          </ContextMenuItem>

          {!isExternalTicket && (
            <ContextMenuItem
              data-testid="ctx-move-to-project"
              onClick={() => setShowMoveToProject(true)}
              className="gap-2"
            >
              <FolderInput className="h-3.5 w-3.5" />
              Move to project…
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />

          {/* Archive/Unarchive (done tickets) or Delete (all others) */}
          {isDone ? (
            isArchived ? (
              <ContextMenuItem
                data-testid="ctx-unarchive-ticket"
                onClick={handleUnarchive}
                className="gap-2"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                Unarchive
              </ContextMenuItem>
            ) : (
              <ContextMenuItem
                data-testid="ctx-archive-ticket"
                onClick={handleArchive}
                className="gap-2"
              >
                <Archive className="h-3.5 w-3.5" />
                Archive
              </ContextMenuItem>
            )
          ) : (
            <ContextMenuItem
              data-testid="ctx-delete-ticket"
              onClick={() => setShowDeleteConfirm(true)}
              className="gap-2 text-destructive focus:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </ContextMenuItem>
          )}
            </>
          )}
          </ContextMenuContent>
        </ContextMenu>
        <AttachPRPopover ticket={ticket} open={showPRPicker} onOpenChange={setShowPRPicker} />
      </Popover>

      {/* Delete confirmation dialog (not used for done/archive tickets) */}
      {!isDone && (
        <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <AlertDialogContent data-testid="ctx-delete-confirm-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete ticket</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete &ldquo;{ticket.title}&rdquo;? This action cannot be
                undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="ctx-delete-cancel-btn">Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-testid="ctx-delete-confirm-btn"
                variant="destructive"
                onClick={handleDelete}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Stop remote session confirmation */}
      {activeRemoteLaunch && (
        <AlertDialog open={showStopRemoteConfirm} onOpenChange={setShowStopRemoteConfirm}>
          <AlertDialogContent data-testid="ctx-stop-remote-confirm-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Stop remote session</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to stop the remote session for &ldquo;{ticket.title}&rdquo;?
                This kills the remote tmux session and can&rsquo;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="ctx-stop-remote-cancel-btn">Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-testid="ctx-stop-remote-confirm-btn"
                variant="destructive"
                onClick={handleStopRemoteSession}
              >
                Stop
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Remote terminal attach dialog */}
      {activeRemoteLaunch && (
        <RemoteTerminalDialog
          open={remoteTerminalOpen}
          onOpenChange={setRemoteTerminalOpen}
          remoteLaunch={activeRemoteLaunch}
        />
      )}

      {/* Worktree picker modal for full assign (non-todo) */}
      <WorktreePickerModal
        ticket={ticket}
        projectId={ticket.project_id}
        open={showWorktreePicker}
        onOpenChange={setShowWorktreePicker}
      />

      {/* Pre-assign worktree picker (todo column) */}
      <WorktreePickerModal
        ticket={ticket}
        projectId={ticket.project_id}
        open={showPreAssignPicker}
        onOpenChange={setShowPreAssignPicker}
        preAssignOnly
      />

      {isExternalTicket && ticket.external_id && ticket.external_url && (
        <UpdateStatusModal
          open={showStatusUpdate}
          onOpenChange={setShowStatusUpdate}
          externalProvider={ticket.external_provider!}
          externalId={ticket.external_id}
          externalUrl={ticket.external_url}
          ticketTitle={ticket.title}
        />
      )}

      <NoteEditorModal
        open={showNoteEditor}
        onOpenChange={setShowNoteEditor}
        ticketTitle={ticket.title}
        initialNote={ticket.note}
        onSave={handleSaveNote}
      />

      {!isExternalTicket && (
        <MoveToProjectModal
          currentProjectId={ticket.project_id}
          ticketTitle={ticket.title}
          open={showMoveToProject}
          onOpenChange={setShowMoveToProject}
          onSelect={handleMoveToProject}
        />
      )}
    </>
  )
})
