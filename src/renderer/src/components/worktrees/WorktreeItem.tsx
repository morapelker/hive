import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react'
import { revealLabel } from '@/lib/platform'
import {
  Link,
  Loader2,
  Map,
  MoreHorizontal,
  Terminal,
  Code,
  Archive,
  GitBranchPlus,
  Copy,
  ExternalLink,
  Pencil,
  Figma,
  Ticket,
  Plus,
  Pin,
  PinOff,
  Unlink,
  FileText,
  Zap,
  RadioTower
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu'
import {
  useWorktreeStore,
  useProjectStore,
  useConnectionStore,
  usePinnedStore,
  useHintStore,
  useVimModeStore,
  useSettingsStore
} from '@/stores'
import { HintBadge } from '@/components/ui/HintBadge'
import { Tip } from '@/components/ui/Tip'
import { useGitStore } from '@/stores/useGitStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { toast, gitToast, clipboardToast } from '@/lib/toast'
import { formatRelativeTime } from '@/lib/format-utils'
import { useGhosttySuppression, useSidebarHoverHighlight } from '@/hooks'
import { PulseAnimation } from './PulseAnimation'
import { ModelIcon } from './ModelIcon'
import { ArchiveConfirmDialog } from './ArchiveConfirmDialog'
import { AddAttachmentDialog } from './AddAttachmentDialog'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { systemApi } from '@/api/system-api'
import { dbApi } from '@/api/db-api'
import { worktreeApi } from '@/api/worktree-api'
import { projectApi } from '@/api/project-api'
import { gitApi } from '@/api/git-api'
import { mergeCustomCommands, replaceTemplateVariables } from '@/lib/custom-commands'
import type { CustomProjectCommand } from '@/lib/custom-commands'
import {
  AGENT_LIST,
  AGENT_LIST_AFTER_META,
  AGENT_LIST_AFTER_TITLE,
  AGENT_TIME,
  AgentStateDot,
  CARD_CONTENT_COLUMN,
  CARD_CONTENT_COLUMN_OVERFLOW_VISIBLE,
  CARD_HOVER_TRIGGER,
  CARD_LANE,
  CARD_LANE_SLOT,
  CARD_PARENT_ROW,
  CARD_PARENT_ROW_ALIGN,
  CARD_TITLE_ACTIONS,
  CARD_TITLE_EDITING_GHOST,
  CARD_TITLE_EDITING_INPUT,
  CARD_TITLE_EDITING_ROOT,
  CARD_TITLE_IS_DIM,
  CARD_TITLE_IS_UNREAD,
  CARD_TITLE_ROW,
  CARD_TITLE_ROW_LEFT,
  META_ROW,
  META_ROW_LEFT,
  META_TEXT_MONO,
  MICRO_BADGE_BASE,
  MICRO_BADGE_PRIMARY,
  STATUS_DOT,
  STATUS_GLYPH_BOX,
  STATUS_QUESTION_ICON,
  SidebarAgentRow,
  WorkspaceCardSurface,
  getFlushWorktreeCardPaddingLeft,
  getWorktreeCardContentIndent,
  type AgentDotState
} from '@/components/sidebar'

// Orca indent ladder for a worktree card directly under a project group header
// (indentation.ts: grouped depth 0 → content indent 20px, status-lane pullback
// 10px → surface padding-left 10px). The list owner supplies no extra inset.
const WORKTREE_CARD_CONTENT_INDENT = getWorktreeCardContentIndent({
  isGrouped: true,
  groupDepth: 0,
  lineageDepth: 0
})
const WORKTREE_CARD_PADDING_LEFT = getFlushWorktreeCardPaddingLeft(
  WORKTREE_CARD_CONTENT_INDENT,
  true
)

interface Worktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  last_message_at: number | null
  created_at: string
  last_accessed_at: string
  attachments: string // JSON array
  teleported_to?: string | null
}

interface WorktreeItemProps {
  worktree: Worktree
  projectPath: string
  index?: number
  isFirstItem?: boolean
  isDragging?: boolean
  isDragOver?: boolean
  onDragStart?: (e: React.DragEvent, worktreeId: string) => void
  onDragOver?: (e: React.DragEvent, worktreeId: string) => void
  onDrop?: (e: React.DragEvent, worktreeId: string) => void
  onDragEnd?: () => void
}

export const WorktreeItem = memo(function WorktreeItem({
  worktree,
  projectPath,
  isFirstItem,
  isDragging,
  isDragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: WorktreeItemProps): React.JSX.Element {
  const sidebarHover = useSidebarHoverHighlight('worktree', worktree.id)
  const selectWorktree = useWorktreeStore((s) => s.selectWorktree)
  const archiveWorktree = useWorktreeStore((s) => s.archiveWorktree)
  const unbranchWorktree = useWorktreeStore((s) => s.unbranchWorktree)
  const isSelected = useWorktreeStore((s) => s.selectedWorktreeId === worktree.id)
  const selectProject = useProjectStore((s) => s.selectProject)
  const project = useProjectStore((s) => s.projects.find((p) => p.id === worktree.project_id))

  const isArchiving = useWorktreeStore((s) => s.archivingWorktreeIds.has(worktree.id))
  const worktreeStatus = useWorktreeStatusStore((state) => state.getWorktreeStatus(worktree.id))
  const lastMessageTime = useWorktreeStatusStore(
    (state) => state.lastMessageTimeByWorktree[worktree.id] ?? null
  )
  const isRunProcessAlive = useScriptStore((s) => s.scriptStates[worktree.id]?.runRunning ?? false)
  const liveBranch = useGitStore((s) => s.branchInfoByWorktree.get(worktree.path))
  const displayName = liveBranch?.name ?? worktree.name
  const isTeleported = Boolean(worktree.teleported_to)

  // Connection mode state
  const connectionModeActive = useConnectionStore((s) => s.connectionModeActive)
  const connectionModeSourceId = useConnectionStore((s) => s.connectionModeSourceWorktreeId)
  const connectionModeSelectedIds = useConnectionStore((s) => s.connectionModeSelectedIds)
  const toggleConnectionModeWorktree = useConnectionStore((s) => s.toggleConnectionModeWorktree)
  const enterConnectionMode = useConnectionStore((s) => s.enterConnectionMode)

  // Pinned state
  const isPinned = usePinnedStore((s) => s.pinnedWorktreeIds.has(worktree.id))
  const pinWorktree = usePinnedStore((s) => s.pinWorktree)
  const unpinWorktree = usePinnedStore((s) => s.unpinWorktree)

  const hint = useHintStore((s) => s.hintMap.get(worktree.id))
  const hintMode = useHintStore((s) => s.mode)
  const hintPendingChar = useHintStore((s) => s.pendingChar)
  const hintActionMode = useHintStore((s) => s.actionMode)
  const inputFocused = useHintStore((s) => s.inputFocused)
  const vimMode = useVimModeStore((s) => s.mode)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const globalCommands = useSettingsStore((s) => s.customProjectCommands)
  const customCommands = useMemo(
    () => mergeCustomCommands(globalCommands, project?.custom_commands ?? []),
    [globalCommands, project?.custom_commands]
  )

  const handleTogglePin = useCallback(async (): Promise<void> => {
    if (isPinned) {
      await unpinWorktree(worktree.id)
    } else {
      await pinWorktree(worktree.id)
    }
  }, [isPinned, worktree.id, pinWorktree, unpinWorktree])

  const handleEditContext = useCallback(() => {
    useFileViewerStore.getState().openContextEditor(worktree.id)
  }, [worktree.id])

  const handleCustomCommand = useCallback(
    async (command: CustomProjectCommand): Promise<void> => {
      if (!project) {
        toast.error('Project not found')
        return
      }

      try {
        // Replace template variables using the utility function
        const renderedPrompt = replaceTemplateVariables(command.prompt, project)

        // Dispatch custom event with command execution details
        const event = new CustomEvent('hive:execute-custom-command', {
          detail: {
            projectId: project.id,
            worktreeId: worktree.id,
            commandId: command.id,
            commandName: command.name,
            renderedPrompt
          }
        })
        window.dispatchEvent(event)

        // Show info toast
        toast.info(`Executing: ${command.name}`)
      } catch {
        // Show error toast if anything goes wrong
        toast.error('Failed to execute command')
      }
    },
    [project, worktree.id]
  )

  const isInConnectionMode = connectionModeActive
  const isSource = connectionModeSourceId === worktree.id
  const isChecked = connectionModeSelectedIds.has(worktree.id)
  const hasNamedBranch = Boolean(worktree.branch_name)

  // Orca workspace-card title (kit CARD_TITLE_*): 13px/20px, normal weight dimmed
  // to 80% when read, semibold full-foreground when the worktree carries unread output.
  const renderWorktreeName = (): React.JSX.Element => (
    <span
      className={cn(
        worktreeStatus === 'unread' ? CARD_TITLE_IS_UNREAD : CARD_TITLE_IS_DIM,
        'cursor-default'
      )}
    >
      {displayName}
    </span>
  )

  // Auto-refresh relative time every 60 seconds
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!lastMessageTime) return
    const timer = setInterval(() => setTick((n) => n + 1), 60000)
    return () => clearInterval(timer)
  }, [lastMessageTime])

  // Derive display status text + color for second-line row (always shown)
  const { displayStatus, statusClass } = isArchiving
    ? { displayStatus: 'Archiving', statusClass: 'font-semibold text-muted-foreground' }
    : worktreeStatus === 'answering'
      ? { displayStatus: 'Answer questions', statusClass: 'font-semibold text-amber-500' }
      : worktreeStatus === 'command_approval'
        ? { displayStatus: 'Approve command', statusClass: 'font-semibold text-orange-500' }
        : worktreeStatus === 'permission'
          ? { displayStatus: 'Permission', statusClass: 'font-semibold text-amber-500' }
          : worktreeStatus === 'planning'
            ? { displayStatus: 'Planning', statusClass: 'font-semibold text-blue-400' }
            : worktreeStatus === 'working'
              ? { displayStatus: 'Working', statusClass: 'font-medium text-yellow-500' }
              : worktreeStatus === 'plan_ready'
                ? { displayStatus: 'Plan ready', statusClass: 'font-semibold text-blue-400' }
                : worktreeStatus === 'completed'
                  ? { displayStatus: 'Ready', statusClass: 'text-muted-foreground' }
                  : { displayStatus: 'Ready', statusClass: 'text-muted-foreground' }

  // Archive confirmation state
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [archiveConfirmFiles, setArchiveConfirmFiles] = useState<
    Array<{ path: string; additions: number; deletions: number; binary: boolean }>
  >([])

  // Attachment state
  const [addAttachmentOpen, setAddAttachmentOpen] = useState(false)
  const [attachments, setAttachments] = useState<
    Array<{ id: string; type: 'jira' | 'figma'; url: string; label: string; created_at: string }>
  >([])

  // Parse attachments from worktree data
  useEffect(() => {
    try {
      setAttachments(JSON.parse(worktree.attachments || '[]'))
    } catch {
      setAttachments([])
    }
  }, [worktree.attachments])

  const handleOpenAttachment = useCallback(async (url: string): Promise<void> => {
    await systemApi.openInChrome(url)
  }, [])

  const handleDetachAttachment = useCallback(
    async (attachmentId: string): Promise<void> => {
      const result = await dbApi.worktree.removeAttachment(worktree.id, attachmentId)
      if (result.success) {
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
        toast.success('Attachment removed')
      } else {
        toast.error(result.error || 'Failed to remove attachment')
      }
    },
    [worktree.id]
  )

  const handleAttachmentAdded = useCallback((): void => {
    // Reload worktree data to get fresh attachments
    dbApi.worktree.get<Worktree>(worktree.id).then((w) => {
      if (w) {
        try {
          setAttachments(JSON.parse(w.attachments || '[]'))
        } catch {
          // ignore
        }
      }
    })
  }, [worktree.id])

  // Branch rename state
  const [isRenamingBranch, setIsRenamingBranch] = useState(false)
  const [branchNameInput, setBranchNameInput] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalCloseRef = useRef(false)
  const renameStartTimeRef = useRef<number>(0)

  useGhosttySuppression(`worktree-branch-rename:${worktree.id}`, isRenamingBranch)

  // Auto-focus the rename input when it appears (deferred to run after menu closes)
  useEffect(() => {
    if (isRenamingBranch) {
      // Focus function
      const focusInput = () => {
        if (renameInputRef.current && document.activeElement !== renameInputRef.current) {
          renameInputRef.current.focus()
          renameInputRef.current.select()
        }
      }

      // Use requestAnimationFrame to focus after menu closes
      requestAnimationFrame(focusInput)
    }
  }, [isRenamingBranch])

  // Cleanup blur timer on unmount
  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    }
  }, [])

  const startBranchRename = useCallback((): void => {
    if (!hasNamedBranch) return

    intentionalCloseRef.current = false
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current) // Clear any pending blur timer
    renameStartTimeRef.current = Date.now() // Record time before setting state
    setBranchNameInput(worktree.branch_name)
    setIsRenamingBranch(true)
  }, [hasNamedBranch, worktree.branch_name])

  const handleBranchRename = useCallback(async (): Promise<void> => {
    intentionalCloseRef.current = true
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    const trimmed = branchNameInput.trim()
    if (!trimmed || trimmed === worktree.branch_name) {
      setIsRenamingBranch(false)
      return
    }

    // Canonicalize for safety
    const newBranch = trimmed
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9\-/.]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '')

    if (!newBranch) {
      toast.error('Invalid branch name')
      setIsRenamingBranch(false)
      return
    }

    const result = await worktreeApi.renameBranch({
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      oldBranch: worktree.branch_name,
      newBranch
    })

    if (result.success) {
      useWorktreeStore.getState().updateWorktreeBranch(worktree.id, newBranch)
      toast.success(`Branch renamed to ${newBranch}`)
    } else {
      toast.error(result.error || 'Failed to rename branch')
    }
    setIsRenamingBranch(false)
  }, [branchNameInput, worktree.id, worktree.path, worktree.branch_name])

  const handleClick = (): void => {
    if (isInConnectionMode) {
      toggleConnectionModeWorktree(worktree.id)
      return
    }
    selectWorktree(worktree.id)
    selectProject(worktree.project_id)
    useWorktreeStatusStore.getState().clearWorktreeUnread(worktree.id)
  }

  const handleOpenInTerminal = useCallback(async (): Promise<void> => {
    const result = await worktreeApi.openInTerminal(worktree.path)
    if (result.success) {
      toast.success('Opened in Terminal')
    } else {
      toast.error(result.error || 'Failed to open in terminal', {
        retry: handleOpenInTerminal,
        description: 'Make sure the worktree directory exists'
      })
    }
  }, [worktree.path])

  const handleOpenInEditor = useCallback(async (): Promise<void> => {
    const result = await worktreeApi.openInEditor(worktree.path)
    if (result.success) {
      toast.success('Opened in Editor')
    } else {
      toast.error(result.error || 'Failed to open in editor', {
        retry: handleOpenInEditor,
        description: 'Make sure VS Code is installed'
      })
    }
  }, [worktree.path])

  const handleOpenInFinder = async (): Promise<void> => {
    await projectApi.showInFolder(worktree.path)
  }

  const handleCopyPath = async (): Promise<void> => {
    await projectApi.copyToClipboard(worktree.path)
    clipboardToast.copied('Path')
  }

  const doArchive = useCallback(async (): Promise<void> => {
    const result = await archiveWorktree(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      projectPath
    )
    if (result.success) {
      gitToast.worktreeArchived(worktree.name)
    } else {
      gitToast.operationFailed('archive worktree', result.error, doArchive)
    }
  }, [archiveWorktree, worktree, projectPath])

  const handleArchive = useCallback(async (): Promise<void> => {
    try {
      const result = await gitApi.getDiffStat(worktree.path)
      if (result.success && result.files && result.files.length > 0) {
        setArchiveConfirmFiles(result.files)
        setArchiveConfirmOpen(true)
        return
      }
    } catch {
      // If we can't check, proceed without confirmation
    }
    doArchive()
  }, [worktree.path, doArchive])

  const handleArchiveConfirm = useCallback((): void => {
    setArchiveConfirmOpen(false)
    setArchiveConfirmFiles([])
    doArchive()
  }, [doArchive])

  const handleArchiveCancel = useCallback((): void => {
    setArchiveConfirmOpen(false)
    setArchiveConfirmFiles([])
  }, [])

  const handleUnbranch = useCallback(async (): Promise<void> => {
    const result = await unbranchWorktree(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      projectPath
    )
    if (result.success) {
      if (hasNamedBranch) {
        gitToast.worktreeUnbranched(worktree.name)
      } else {
        toast.success(`Worktree "${worktree.name}" removed`)
      }
    } else {
      gitToast.operationFailed('unbranch worktree', result.error, handleUnbranch)
    }
  }, [hasNamedBranch, unbranchWorktree, worktree, projectPath])

  const handleDuplicate = useCallback(async (): Promise<void> => {
    if (!hasNamedBranch) {
      toast.error('Detached HEAD worktrees cannot be duplicated')
      return
    }

    const project = useProjectStore.getState().projects.find((p) => p.id === worktree.project_id)
    if (!project) return
    const result = await useWorktreeStore
      .getState()
      .duplicateWorktree(
        project.id,
        project.path,
        project.name,
        worktree.branch_name,
        worktree.path
      )
    if (result.success) {
      toast.success(`Duplicated to ${result.worktree?.name || 'new branch'}`)
    } else {
      toast.error(result.error || 'Failed to duplicate worktree')
    }
  }, [hasNamedBranch, worktree])

  // --- Orca workspace-card building blocks (shared by both render modes) ---
  // Card shell/lane/title/agent-row geometry all come from the shared kit
  // (`@/components/sidebar`, ported verbatim from orca) so every sidebar row
  // shares one recipe. The 6px inter-row gap (kit ROW_GAP) is owned by the
  // list wrapper (WorktreeList), not by this card.

  // Status lane glyph — exactly one glyph per orca `StatusIndicator` (12px box,
  // 8px ring/dot) via the kit AgentStateDot: working = yellow ring, attention =
  // orange question glyph, ready/idle = emerald "done" dot. Hive-specific
  // extras: plan_ready = blue map, unread = blue dot, archiving = muted spinner.
  const agentDotState: AgentDotState | null =
    worktreeStatus === 'working' || worktreeStatus === 'planning'
      ? 'working'
      : worktreeStatus === 'answering' ||
          worktreeStatus === 'permission' ||
          worktreeStatus === 'command_approval'
        ? 'question'
        : worktreeStatus === 'plan_ready' || worktreeStatus === 'unread'
          ? null
          : 'done'
  const renderStatusGlyph = (): React.JSX.Element => {
    if (isArchiving) {
      return (
        <span className={STATUS_GLYPH_BOX}>
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        </span>
      )
    }
    if (worktreeStatus === 'plan_ready') {
      return (
        <span className={STATUS_GLYPH_BOX}>
          <Map className={cn(STATUS_QUESTION_ICON, 'text-blue-400')} aria-label="Plan ready" />
        </span>
      )
    }
    if (worktreeStatus === 'unread') {
      return (
        <span className={STATUS_GLYPH_BOX}>
          <span className={cn(STATUS_DOT, 'bg-blue-500')} data-worktree-unread-dot="" />
        </span>
      )
    }
    return <AgentStateDot state={agentDotState ?? 'done'} size="md" />
  }

  // Meta row (orca `WorktreeCardMetaRow`): only rendered when there is real
  // content — the teleport badge and the worktree directory name when it
  // differs from the live branch shown in the title (orca de-dupes identity).
  const showDirectoryName = !worktree.is_default && worktree.name !== displayName
  const hasMetaRow = isTeleported || showDirectoryName
  const renderMetaRow = (): React.JSX.Element | null =>
    hasMetaRow ? (
      <div className={META_ROW} data-worktree-card-meta-row="">
        <div className={META_ROW_LEFT}>
          {isTeleported && (
            <span
              className={cn(MICRO_BADGE_BASE, 'border-sky-500/30 bg-sky-500/5 text-sky-500')}
              data-testid="worktree-teleported-badge"
            >
              <RadioTower className="size-2.5" />
              Teleported
            </span>
          )}
          {showDirectoryName && (
            <span className={META_TEXT_MONO} title={worktree.path}>
              {worktree.name}
            </span>
          )}
        </div>
      </div>
    ) : null

  // Status line as an orca inline agent row (kit SidebarAgentRow: h-6, 11px
  // muted, model glyph 13px = orca AgentIcon size 13, status label, timestamp
  // in 10px tabular figures). The list wrapper carries orca's -0.5rem outdent.
  const renderAgentRow = (): React.JSX.Element => (
    <div
      className={cn(AGENT_LIST, hasMetaRow ? AGENT_LIST_AFTER_META : AGENT_LIST_AFTER_TITLE)}
      data-compact-agent-list="true"
    >
      <SidebarAgentRow
        data-worktree-agent-row=""
        leading={<ModelIcon worktreeId={worktree.id} className="size-[13px] shrink-0" />}
        label={
          <span className={statusClass} data-testid="worktree-status-text">
            {displayStatus}
          </span>
        }
        trailing={
          lastMessageTime ? (
            <span
              className={AGENT_TIME}
              title={new Date(lastMessageTime).toLocaleString()}
              data-testid="worktree-last-message-time"
            >
              {formatRelativeTime(lastMessageTime)}
            </span>
          ) : null
        }
      />
    </div>
  )

  // Title-row micro badge for the primary (default) worktree — orca `primary` Badge.
  const renderPrimaryBadge = (): React.JSX.Element | null =>
    worktree.is_default ? (
      <span
        className={MICRO_BADGE_PRIMARY}
        title="Primary worktree (original clone directory)"
        data-worktree-primary-badge=""
      >
        primary
      </span>
    ) : null

  // --- Connection mode rendering (simplified, no menus) ---
  if (isInConnectionMode) {
    return (
      <>
        <WorkspaceCardSurface
          multiSelected={isChecked}
          className={cn(
            isSource && isChecked && 'bg-worktree-sidebar-accent/40',
            isArchiving && 'opacity-50 pointer-events-none'
          )}
          style={{ paddingLeft: WORKTREE_CARD_PADDING_LEFT }}
          onClick={handleClick}
          onMouseEnter={sidebarHover.onMouseEnter}
          onMouseLeave={sidebarHover.onMouseLeave}
          data-testid={`worktree-item-${worktree.id}`}
        >
          <div className={cn(CARD_PARENT_ROW, CARD_PARENT_ROW_ALIGN)}>
            {/* Status lane: checkbox instead of the status glyph */}
            <div className={CARD_LANE} data-worktree-card-status-slot="">
              <span className={CARD_LANE_SLOT}>
                <Checkbox
                  checked={isChecked}
                  onCheckedChange={() => toggleConnectionModeWorktree(worktree.id)}
                  disabled={isSource}
                  className={cn('h-3.5 w-3.5 shrink-0', isSource && 'opacity-70')}
                  onClick={(e) => e.stopPropagation()}
                  data-testid={`connection-mode-checkbox-${worktree.id}`}
                />
              </span>
            </div>

            {/* Worktree Name + Meta + Status Line */}
            <div className={cn(CARD_CONTENT_COLUMN, CARD_CONTENT_COLUMN_OVERFLOW_VISIBLE)}>
              <div className={CARD_TITLE_ROW}>
                <div className={CARD_TITLE_ROW_LEFT}>
                  {renderWorktreeName()}
                  {renderPrimaryBadge()}
                </div>
              </div>
              {renderMetaRow()}
              {renderAgentRow()}
            </div>
          </div>
        </WorkspaceCardSurface>

        <ArchiveConfirmDialog
          open={archiveConfirmOpen}
          worktreeName={worktree.name}
          files={archiveConfirmFiles}
          onCancel={handleArchiveCancel}
          onConfirm={handleArchiveConfirm}
        />
      </>
    )
  }

  // --- Normal rendering (with menus, drag, etc.) ---
  const tree = (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <WorkspaceCardSurface
          active={isSelected ? 'primary' : false}
          renaming={isRenamingBranch}
          className={cn(
            isArchiving && 'opacity-50 pointer-events-none',
            isDragging && 'opacity-50',
            isDragOver && '!border-t-ring'
          )}
          style={{ paddingLeft: WORKTREE_CARD_PADDING_LEFT }}
          draggable={!worktree.is_default && !isRenamingBranch}
          onDragStart={onDragStart ? (e) => onDragStart(e, worktree.id) : undefined}
          onDragOver={onDragOver ? (e) => onDragOver(e, worktree.id) : undefined}
          onDrop={onDrop ? (e) => onDrop(e, worktree.id) : undefined}
          onDragEnd={onDragEnd}
          onClick={handleClick}
          onMouseEnter={sidebarHover.onMouseEnter}
          onMouseLeave={sidebarHover.onMouseLeave}
          data-testid={`worktree-item-${worktree.id}`}
        >
          <div className={CARD_HOVER_TRIGGER} data-worktree-card-hover-trigger="">
            <div className={cn(CARD_PARENT_ROW, CARD_PARENT_ROW_ALIGN)}>
              {/* Status lane — one glyph, 20px wide (orca status slot) */}
              <div className={CARD_LANE} data-worktree-card-status-slot="">
                <span className={CARD_LANE_SLOT}>{renderStatusGlyph()}</span>
              </div>

              {/* Content column: title row / meta row / agent row */}
              <div className={cn(CARD_CONTENT_COLUMN, CARD_CONTENT_COLUMN_OVERFLOW_VISIBLE)}>
                {/* Title row: name (or inline rename input) + micro badges + actions */}
                <div className={CARD_TITLE_ROW}>
                  <div className={CARD_TITLE_ROW_LEFT}>
                    {isRenamingBranch ? (
                      // orca WorktreeTitleInlineRename (text mode): grid root, invisible
                      // width ghost, borderless input sized to one line-height.
                      <span className={cn(CARD_TITLE_EDITING_ROOT, 'flex-1 text-[13px] leading-5')}>
                        <span className={CARD_TITLE_EDITING_GHOST} aria-hidden="true">
                          {branchNameInput || ' '}
                        </span>
                        <input
                          ref={renameInputRef}
                          autoFocus
                          value={branchNameInput}
                          onChange={(e) => setBranchNameInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleBranchRename()
                            }
                            if (e.key === 'Escape') {
                              intentionalCloseRef.current = true
                              if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
                              setIsRenamingBranch(false)
                            }
                          }}
                          onBlur={() => {
                            // Skip scheduling timer if we're intentionally closing via Escape/Enter
                            if (intentionalCloseRef.current) {
                              intentionalCloseRef.current = false
                              return
                            }

                            // Ignore blur events that happen too soon after starting rename (menu closing)
                            const timeSinceStart = Date.now() - renameStartTimeRef.current
                            if (timeSinceStart < 500) {
                              // Always refocus during the first 500ms (menu closing period)
                              // User can press Escape to cancel if needed
                              setTimeout(() => {
                                if (
                                  renameInputRef.current &&
                                  document.activeElement !== renameInputRef.current
                                ) {
                                  renameInputRef.current.focus()
                                  renameInputRef.current.select()
                                }
                              }, 0)
                              return
                            }

                            // Delay blur to allow for normal focus changes
                            if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
                            blurTimerRef.current = setTimeout(() => {
                              blurTimerRef.current = null
                              // Only close if the input is still not focused
                              if (document.activeElement !== renameInputRef.current) {
                                setIsRenamingBranch(false)
                              }
                            }, 100)
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className={cn(CARD_TITLE_EDITING_INPUT, 'w-full')}
                          data-testid="branch-rename-input"
                        />
                      </span>
                    ) : (
                      renderWorktreeName()
                    )}
                    {!isRenamingBranch && renderPrimaryBadge()}
                    {isRunProcessAlive && (
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        <PulseAnimation className="size-3.5 shrink-0 text-blue-500" />
                      </span>
                    )}
                  </div>

                  <div className={CARD_TITLE_ACTIONS}>
                    {/* Hint Badge (visible when filter is active and search field is focused) */}
                    {hint && (inputFocused || (vimModeEnabled && vimMode === 'normal')) && (
                      <HintBadge
                        code={hint}
                        mode={hintMode}
                        pendingChar={hintPendingChar}
                        actionMode={hintActionMode}
                      />
                    )}

                    {/* More Options Dropdown (visible on hover) */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            'size-5 p-0 opacity-0 transition-opacity',
                            'group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
                            'hover:bg-accent'
                          )}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-52" align="end">
                        {attachments.length > 0 && (
                          <>
                            {attachments.map((attachment) => (
                              <DropdownMenuSub key={attachment.id}>
                                <DropdownMenuSubTrigger>
                                  {attachment.type === 'jira' ? (
                                    <Ticket className="h-4 w-4 mr-2 text-blue-500" />
                                  ) : (
                                    <Figma className="h-4 w-4 mr-2 text-purple-500" />
                                  )}
                                  {attachment.label}
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="w-40">
                                  <DropdownMenuItem
                                    onClick={() => handleOpenAttachment(attachment.url)}
                                  >
                                    <ExternalLink className="h-4 w-4 mr-2" />
                                    Open
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleDetachAttachment(attachment.id)}
                                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                                  >
                                    <Unlink className="h-4 w-4 mr-2" />
                                    Detach
                                  </DropdownMenuItem>
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                            ))}
                            <DropdownMenuSeparator />
                          </>
                        )}
                        <DropdownMenuItem onClick={() => setAddAttachmentOpen(true)}>
                          <Plus className="h-4 w-4 mr-2" />
                          Add Attachment
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={handleEditContext}>
                          <FileText className="h-4 w-4 mr-2" />
                          Edit Context
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={handleOpenInTerminal}>
                          <Terminal className="h-4 w-4 mr-2" />
                          Open in Terminal
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={handleOpenInEditor}>
                          <Code className="h-4 w-4 mr-2" />
                          Open in Editor
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={handleOpenInFinder}>
                          <ExternalLink className="h-4 w-4 mr-2" />
                          {revealLabel(true)}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={handleCopyPath}>
                          <Copy className="h-4 w-4 mr-2" />
                          Copy Path
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={handleTogglePin}>
                          {isPinned ? (
                            <PinOff className="h-4 w-4 mr-2" />
                          ) : (
                            <Pin className="h-4 w-4 mr-2" />
                          )}
                          {isPinned ? 'Unpin' : 'Pin'}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => enterConnectionMode(worktree.id)}>
                          <Link className="h-4 w-4 mr-2" />
                          Connect to...
                        </DropdownMenuItem>
                        {!worktree.is_default && (
                          <>
                            {hasNamedBranch ? (
                              <>
                                <DropdownMenuItem onClick={startBranchRename}>
                                  <Pencil className="h-4 w-4 mr-2" />
                                  Rename Branch
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={handleDuplicate}>
                                  <GitBranchPlus className="h-4 w-4 mr-2" />
                                  Duplicate
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={handleUnbranch}>
                                  <GitBranchPlus className="h-4 w-4 mr-2" />
                                  Unbranch
                                  <span className="ml-auto text-xs text-muted-foreground">
                                    Keep branch
                                  </span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={handleArchive}
                                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                                >
                                  <Archive className="h-4 w-4 mr-2" />
                                  Archive
                                  <span className="ml-auto text-xs text-muted-foreground">
                                    Delete branch
                                  </span>
                                </DropdownMenuItem>
                              </>
                            ) : (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={handleUnbranch}
                                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                                >
                                  <Archive className="h-4 w-4 mr-2" />
                                  Remove Worktree
                                  <span className="ml-auto text-xs text-muted-foreground">
                                    Detached HEAD
                                  </span>
                                </DropdownMenuItem>
                              </>
                            )}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {renderMetaRow()}
                {renderAgentRow()}
              </div>
            </div>
          </div>
        </WorkspaceCardSurface>
      </ContextMenuTrigger>

      <ArchiveConfirmDialog
        open={archiveConfirmOpen}
        worktreeName={worktree.name}
        files={archiveConfirmFiles}
        onCancel={handleArchiveCancel}
        onConfirm={handleArchiveConfirm}
      />

      {/* Context Menu (right-click) */}
      <ContextMenuContent className="w-52">
        {attachments.length > 0 && (
          <>
            {attachments.map((attachment) => (
              <ContextMenuSub key={attachment.id}>
                <ContextMenuSubTrigger>
                  {attachment.type === 'jira' ? (
                    <Ticket className="h-4 w-4 mr-2 text-blue-500" />
                  ) : (
                    <Figma className="h-4 w-4 mr-2 text-purple-500" />
                  )}
                  {attachment.label}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-40">
                  <ContextMenuItem onClick={() => handleOpenAttachment(attachment.url)}>
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Open
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => handleDetachAttachment(attachment.id)}
                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                  >
                    <Unlink className="h-4 w-4 mr-2" />
                    Detach
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
            ))}
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onClick={() => setAddAttachmentOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Attachment
        </ContextMenuItem>
        <ContextMenuItem onClick={handleEditContext}>
          <FileText className="h-4 w-4 mr-2" />
          Edit Context
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleOpenInTerminal}>
          <Terminal className="h-4 w-4 mr-2" />
          Open in Terminal
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInEditor}>
          <Code className="h-4 w-4 mr-2" />
          Open in Editor
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInFinder}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Open in Finder
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyPath}>
          <Copy className="h-4 w-4 mr-2" />
          Copy Path
        </ContextMenuItem>
        <ContextMenuItem onClick={handleTogglePin}>
          {isPinned ? <PinOff className="h-4 w-4 mr-2" /> : <Pin className="h-4 w-4 mr-2" />}
          {isPinned ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => enterConnectionMode(worktree.id)}>
          <Link className="h-4 w-4 mr-2" />
          Connect to...
        </ContextMenuItem>
        {/* Custom Commands */}
        {customCommands.length > 0 && (
          <>
            <ContextMenuSeparator />
            {customCommands.map((cmd) => (
              <ContextMenuItem key={cmd.id} onClick={() => handleCustomCommand(cmd)}>
                <Zap className="h-4 w-4 mr-2" />
                {cmd.name}
              </ContextMenuItem>
            ))}
          </>
        )}
        {!worktree.is_default && (
          <>
            {hasNamedBranch ? (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={startBranchRename}>
                  <Pencil className="h-4 w-4 mr-2" />
                  Rename Branch
                </ContextMenuItem>
                <ContextMenuItem onClick={handleDuplicate}>
                  <GitBranchPlus className="h-4 w-4 mr-2" />
                  Duplicate
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleUnbranch}>
                  <GitBranchPlus className="h-4 w-4 mr-2" />
                  Unbranch
                  <span className="ml-auto text-xs text-muted-foreground">Keep branch</span>
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={handleArchive}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Archive className="h-4 w-4 mr-2" />
                  Archive
                  <span className="ml-auto text-xs text-muted-foreground">Delete branch</span>
                </ContextMenuItem>
              </>
            ) : (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={handleUnbranch}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Archive className="h-4 w-4 mr-2" />
                  Remove Worktree
                  <span className="ml-auto text-xs text-muted-foreground">Detached HEAD</span>
                </ContextMenuItem>
              </>
            )}
          </>
        )}
      </ContextMenuContent>

      <AddAttachmentDialog
        open={addAttachmentOpen}
        onOpenChange={setAddAttachmentOpen}
        worktreeId={worktree.id}
        onAttachmentAdded={handleAttachmentAdded}
      />
    </ContextMenu>
  )

  // Wrap first worktree item with tip for discoverability
  if (isFirstItem) {
    return (
      <Tip tipId="worktree-connect">
        <div>{tree}</div>
      </Tip>
    )
  }

  return tree
})
