import { useCallback, useEffect, useState, useRef } from 'react'
import { revealLabel } from '@/lib/platform'
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Code,
  Copy,
  ExternalLink,
  Figma,
  GitBranchPlus,
  Link,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Terminal,
  Ticket,
  Trash2,
  Unlink
} from 'lucide-react'
import { cn, parseColorQuad } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
  useProjectStore,
  useWorktreeStore,
  useConnectionStore,
  useWorktreeStatusStore,
  usePinnedStore,
  useHintStore,
  useVimModeStore,
  useSettingsStore
} from '@/stores'
import { HintBadge } from '@/components/ui/HintBadge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useScriptStore } from '@/stores/useScriptStore'
import { useGitStore } from '@/stores/useGitStore'
import { toast, gitToast, clipboardToast } from '@/lib/toast'
import { formatRelativeTime } from '@/lib/format-utils'
import { ModelIcon } from '@/components/worktrees/ModelIcon'
import { PulseAnimation } from '@/components/worktrees/PulseAnimation'
import { LanguageIcon } from '@/components/projects/LanguageIcon'
import {
  AGENT_LIST,
  AGENT_LIST_AFTER_TITLE,
  AGENT_ROW_ICON_WRAP,
  AGENT_TIME,
  AGENT_WORKING_SPINNER,
  AgentStateDot,
  CARD_CONTENT_COLUMN,
  CARD_CONTENT_COLUMN_OVERFLOW_VISIBLE,
  CARD_LANE,
  CARD_LANE_SLOT,
  CARD_LANE_UNREAD_DOT,
  CARD_LANE_UNREAD_WRAP,
  CARD_PARENT_ROW,
  CARD_PARENT_ROW_ALIGN,
  CARD_TITLE_ACTIONS,
  CARD_TITLE_EDITING_INPUT,
  CARD_TITLE_IS_DIM,
  CARD_TITLE_IS_UNREAD,
  CARD_TITLE_ROW,
  CARD_TITLE_ROW_LEFT,
  MICRO_BADGE_PRIMARY,
  SECTION_HEADER_ICON,
  SidebarAgentRow,
  SidebarSectionHeader,
  WorkspaceCardSurface,
  getFlushWorktreeCardPaddingLeft,
  type AgentDotState
} from '@/components/sidebar'
import { baseInstanceLabel, isBaseInstance } from '@/lib/connection-project'
import { ArchiveConfirmDialog } from '@/components/worktrees/ArchiveConfirmDialog'
import { AddAttachmentDialog } from '@/components/worktrees/AddAttachmentDialog'
import { ManageConnectionWorktreesDialog } from '@/components/connections/ManageConnectionWorktreesDialog'
import { useSiblingAggregate, type SiblingBucket } from '@/hooks/useSiblingAggregate'
import { useGhosttySuppression } from '@/hooks'
import { systemApi } from '@/api/system-api'
import { dbApi } from '@/api/db-api'
import { worktreeApi } from '@/api/worktree-api'
import { projectApi } from '@/api/project-api'
import { connectionApi } from '@/api/connection-api'
import { gitApi } from '@/api/git-api'

type PinnedItem = { kind: 'worktree'; id: string } | { kind: 'connection'; id: string }
type WorktreeAttachmentRow = { attachments?: string | null }

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
    // Orca virtual-row rhythm: ROW_GAP (6px) between header and every card; the
    // trailing pb-2.5 (= ROW_GAP + GROUP_HEADER_TOP_MARGIN) gives the next
    // section header its 6px gap + pt-1 spacer.
    <div className="flex flex-col gap-1.5 pb-2.5" data-testid="pinned-list">
      <SidebarSectionHeader
        sticky
        icon={<Pin className={SECTION_HEADER_ICON} />}
        label="Pinned"
        count={items.length}
      />
      {items.map((item) =>
        item.kind === 'worktree' ? (
          <PinnedWorktreeItem key={`wt-${item.id}`} worktreeId={item.id} />
        ) : (
          <PinnedConnectionItem key={`conn-${item.id}`} connectionId={item.id} />
        )
      )}
    </div>
  )
}

// ── Orca card helpers ──────────────────────────────────────────

/** Hover-revealed title-row action (orca worktree-card-header.tsx:294-297 geometry, neutral hover). */
const MORE_BUTTON_CLASS =
  'inline-flex size-4 items-center justify-center rounded bg-transparent p-0 opacity-0 transition-opacity group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 text-muted-foreground hover:bg-accent/70 hover:text-foreground'

/** Map Hive session status → orca AgentStateDot vocabulary. */
function statusToDotState(status: string | null): AgentDotState {
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

/** Human status label for the inline agent row. */
function statusLabel(status: string | null): string {
  switch (status) {
    case 'answering':
      return 'Answer questions'
    case 'permission':
      return 'Permission'
    case 'command_approval':
      return 'Approve command'
    case 'planning':
      return 'Planning'
    case 'working':
      return 'Working'
    case 'plan_ready':
      return 'Plan ready'
    default:
      return 'Ready'
  }
}

/** Orca status lane: 20px slot, 12px StatusIndicator glyph, amber unread overlay dot. */
function StatusLane({ status }: { status: string | null }): React.JSX.Element {
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

// ── Worktree item ──────────────────────────────────────────────

function PinnedWorktreeItem({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const selectWorktree = useWorktreeStore((s) => s.selectWorktree)
  const archiveWorktree = useWorktreeStore((s) => s.archiveWorktree)
  const unbranchWorktree = useWorktreeStore((s) => s.unbranchWorktree)
  const selectProject = useProjectStore((s) => s.selectProject)
  const enterConnectionMode = useConnectionStore((s) => s.enterConnectionMode)
  const unpinWorktree = usePinnedStore((s) => s.unpinWorktree)

  const worktreeStatus = useWorktreeStatusStore((s) => s.getWorktreeStatus(worktreeId))
  const lastMessageTime = useWorktreeStatusStore(
    (s) => s.lastMessageTimeByWorktree[worktreeId] ?? null
  )
  const isSelected = selectedWorktreeId === worktreeId
  const isRunProcessAlive = useScriptStore((s) => s.scriptStates[worktreeId]?.runRunning ?? false)

  const hint = useHintStore((s) => s.hintMap.get(`pinned-wt:${worktreeId}`))
  const hintMode = useHintStore((s) => s.mode)
  const hintPendingChar = useHintStore((s) => s.pendingChar)
  const hintActionMode = useHintStore((s) => s.actionMode)
  const vimMode = useVimModeStore((s) => s.mode)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)

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

  // Auto-refresh relative time every 60 seconds
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!lastMessageTime) return
    const timer = setInterval(() => setTick((n) => n + 1), 60000)
    return () => clearInterval(timer)
  }, [lastMessageTime])

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
  const worktreeAttachments = worktree?.attachments
  useEffect(() => {
    try {
      setAttachments(JSON.parse(worktreeAttachments || '[]'))
    } catch {
      setAttachments([])
    }
  }, [worktreeAttachments])

  // Branch rename state
  const [isRenamingBranch, setIsRenamingBranch] = useState(false)
  const [branchNameInput, setBranchNameInput] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalCloseRef = useRef(false)
  const renameStartTimeRef = useRef<number>(0)

  useGhosttySuppression(`pinned-worktree-branch-rename:${worktreeId}`, isRenamingBranch)

  // Focus rename input when it appears (deferred to run after menu closes)
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

  const handleOpenAttachment = useCallback(async (url: string): Promise<void> => {
    await systemApi.openInChrome(url)
  }, [])

  const handleDetachAttachment = useCallback(
    async (attachmentId: string): Promise<void> => {
      const result = await dbApi.worktree.removeAttachment(worktreeId, attachmentId)
      if (result.success) {
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
        toast.success('Attachment removed')
      } else {
        toast.error(result.error || 'Failed to remove attachment')
      }
    },
    [worktreeId]
  )

  const handleAttachmentAdded = useCallback((): void => {
    dbApi.worktree.get<WorktreeAttachmentRow>(worktreeId).then((w) => {
      if (w) {
        try {
          setAttachments(JSON.parse(w.attachments || '[]'))
        } catch {
          // ignore
        }
      }
    })
  }, [worktreeId])

  const startBranchRename = useCallback((): void => {
    if (!worktree) return
    if (!worktree.branch_name) return

    intentionalCloseRef.current = false
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current) // Clear any pending blur timer
    renameStartTimeRef.current = Date.now() // Record time before setting state
    setBranchNameInput(worktree.branch_name)
    setIsRenamingBranch(true)
  }, [worktree])

  const handleBranchRename = useCallback(async (): Promise<void> => {
    intentionalCloseRef.current = true
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    if (!worktree) {
      setIsRenamingBranch(false)
      return
    }
    const trimmed = branchNameInput.trim()
    if (!trimmed || trimmed === worktree.branch_name) {
      setIsRenamingBranch(false)
      return
    }

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
  }, [branchNameInput, worktree])

  const handleDuplicate = useCallback(async (): Promise<void> => {
    if (!project || !worktree) return
    if (!worktree.branch_name) {
      toast.error('Detached HEAD worktrees cannot be duplicated')
      return
    }

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
  }, [project, worktree])

  const doArchive = useCallback(async (): Promise<void> => {
    if (!project || !worktree) return
    const result = await archiveWorktree(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      project.path
    )
    if (result.success) {
      gitToast.worktreeArchived(worktree.name)
    } else {
      gitToast.operationFailed('archive worktree', result.error, doArchive)
    }
  }, [archiveWorktree, worktree, project])

  const handleArchive = useCallback(async (): Promise<void> => {
    if (!worktree) return
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
  }, [worktree, doArchive])

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
    if (!project || !worktree) return
    const result = await unbranchWorktree(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      project.path
    )
    if (result.success) {
      if (worktree.branch_name) {
        gitToast.worktreeUnbranched(worktree.name)
      } else {
        toast.success(`Worktree "${worktree.name}" removed`)
      }
    } else {
      gitToast.operationFailed('unbranch worktree', result.error, handleUnbranch)
    }
  }, [unbranchWorktree, worktree, project])

  if (!worktree || !project) return null

  const displayBranch = liveBranch?.name ?? worktree.name
  // Single-line identity "project › worktree"; the primary worktree shows its
  // real branch instead of the placeholder worktree name.
  const secondaryLabel = worktree.is_default
    ? (liveBranch?.name ?? worktree.branch_name ?? displayBranch)
    : displayBranch
  const hasNamedBranch = Boolean(worktree.branch_name)

  const displayStatus = statusLabel(worktreeStatus)
  const isUnread = worktreeStatus === 'unread'

  const handleClick = (): void => {
    selectWorktree(worktreeId)
    selectProject(project.id)
    const expanded = useProjectStore.getState().expandedProjectIds
    if (!expanded.has(project.id)) {
      useProjectStore.getState().toggleProjectExpanded(project.id)
    }
    useWorktreeStatusStore.getState().clearWorktreeUnread(worktreeId)
  }

  const handleOpenInTerminal = async (): Promise<void> => {
    const result = await worktreeApi.openInTerminal(worktree.path)
    if (result.success) {
      toast.success('Opened in Terminal')
    } else {
      toast.error(result.error || 'Failed to open in terminal', {
        description: 'Make sure the worktree directory exists'
      })
    }
  }

  const handleOpenInEditor = async (): Promise<void> => {
    const result = await worktreeApi.openInEditor(worktree.path)
    if (result.success) {
      toast.success('Opened in Editor')
    } else {
      toast.error(result.error || 'Failed to open in editor', {
        description: 'Make sure VS Code is installed'
      })
    }
  }

  const handleOpenInFinder = async (): Promise<void> => {
    await projectApi.showInFolder(worktree.path)
  }

  const handleCopyPath = async (): Promise<void> => {
    await projectApi.copyToClipboard(worktree.path)
    clipboardToast.copied('Path')
  }

  const handleUnpin = async (): Promise<void> => {
    await unpinWorktree(worktreeId)
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const worktreeMenuItems = (
    MenuItem: any,
    MenuSeparator: any,
    MenuSub: any,
    MenuSubTrigger: any,
    MenuSubContent: any
  ): React.JSX.Element => (
    <>
      {attachments.length > 0 && (
        <>
          {attachments.map((attachment) => (
            <MenuSub key={attachment.id}>
              <MenuSubTrigger>
                {attachment.type === 'jira' ? (
                  <Ticket className="h-4 w-4 mr-2 text-blue-500" />
                ) : (
                  <Figma className="h-4 w-4 mr-2 text-purple-500" />
                )}
                {attachment.label}
              </MenuSubTrigger>
              <MenuSubContent className="w-40">
                <MenuItem onClick={() => handleOpenAttachment(attachment.url)}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Open
                </MenuItem>
                <MenuItem
                  onClick={() => handleDetachAttachment(attachment.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Unlink className="h-4 w-4 mr-2" />
                  Detach
                </MenuItem>
              </MenuSubContent>
            </MenuSub>
          ))}
          <MenuSeparator />
        </>
      )}
      <MenuItem onClick={() => setAddAttachmentOpen(true)}>
        <Plus className="h-4 w-4 mr-2" />
        Add Attachment
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={handleOpenInTerminal}>
        <Terminal className="h-4 w-4 mr-2" />
        Open in Terminal
      </MenuItem>
      <MenuItem onClick={handleOpenInEditor}>
        <Code className="h-4 w-4 mr-2" />
        Open in Editor
      </MenuItem>
      <MenuItem onClick={handleOpenInFinder}>
        <ExternalLink className="h-4 w-4 mr-2" />
        {revealLabel(true)}
      </MenuItem>
      <MenuItem onClick={handleCopyPath}>
        <Copy className="h-4 w-4 mr-2" />
        Copy Path
      </MenuItem>
      <MenuItem onClick={handleUnpin}>
        <PinOff className="h-4 w-4 mr-2" />
        Unpin
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => enterConnectionMode(worktree.id)}>
        <Link className="h-4 w-4 mr-2" />
        Connect to...
      </MenuItem>
      {!worktree.is_default && (
        <>
          {hasNamedBranch ? (
            <>
              <MenuItem onClick={startBranchRename}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename Branch
              </MenuItem>
              <MenuItem onClick={handleDuplicate}>
                <GitBranchPlus className="h-4 w-4 mr-2" />
                Duplicate
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={handleUnbranch}>
                <GitBranchPlus className="h-4 w-4 mr-2" />
                Unbranch
                <span className="ml-auto text-xs text-muted-foreground">Keep branch</span>
              </MenuItem>
              <MenuItem
                onClick={handleArchive}
                className="text-destructive focus:text-destructive focus:bg-destructive/10"
              >
                <Archive className="h-4 w-4 mr-2" />
                Archive
                <span className="ml-auto text-xs text-muted-foreground">Delete branch</span>
              </MenuItem>
            </>
          ) : (
            <>
              <MenuSeparator />
              <MenuItem
                onClick={handleUnbranch}
                className="text-destructive focus:text-destructive focus:bg-destructive/10"
              >
                <Archive className="h-4 w-4 mr-2" />
                Remove Worktree
                <span className="ml-auto text-xs text-muted-foreground">Detached HEAD</span>
              </MenuItem>
            </>
          )}
        </>
      )}
    </>
  )
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <WorkspaceCardSurface
          active={isSelected ? 'primary' : false}
          renaming={isRenamingBranch}
          className="group/worktree-card"
          style={{ paddingLeft: getFlushWorktreeCardPaddingLeft(0) }}
          onClick={handleClick}
          data-testid={`pinned-worktree-${worktreeId}`}
        >
          <div className={cn(CARD_PARENT_ROW, CARD_PARENT_ROW_ALIGN)}>
            <StatusLane status={worktreeStatus} />

            <div className={cn(CARD_CONTENT_COLUMN, CARD_CONTENT_COLUMN_OVERFLOW_VISIBLE)}>
              {/* Title row: project icon + "project › worktree" (or inline rename) + hover actions */}
              <div className={CARD_TITLE_ROW}>
                <div className={CARD_TITLE_ROW_LEFT}>
                  <LanguageIcon
                    language={project.language}
                    customIcon={project.custom_icon}
                    detectedIcon={project.detected_icon}
                  />
                  {isRenamingBranch ? (
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
                      className={cn(
                        CARD_TITLE_EDITING_INPUT,
                        'w-full min-w-0 flex-1 text-[13px] leading-5'
                      )}
                      data-testid="branch-rename-input"
                    />
                  ) : (
                    <span
                      className={isUnread ? CARD_TITLE_IS_UNREAD : CARD_TITLE_IS_DIM}
                      title={worktree.path}
                    >
                      {project.name} <span className="text-muted-foreground">›</span>{' '}
                      {secondaryLabel}
                    </span>
                  )}
                </div>

                <div className={CARD_TITLE_ACTIONS}>
                  {hint && vimModeEnabled && vimMode === 'normal' && (
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
                        className={MORE_BUTTON_CLASS}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="w-52" align="end">
                      {worktreeMenuItems(
                        DropdownMenuItem,
                        DropdownMenuSeparator,
                        DropdownMenuSub,
                        DropdownMenuSubTrigger,
                        DropdownMenuSubContent
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Inline agent row (orca compact agent row): state dot · model · status · sibling chips · time */}
              <div
                className={cn(AGENT_LIST, AGENT_LIST_AFTER_TITLE)}
                data-compact-agent-list="true"
              >
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
                  label={<span data-testid="pinned-status-text">{displayStatus}</span>}
                  trailing={
                    <>
                      {worktree.is_default && (
                        <SiblingCountChips projectId={project.id} excludeId={worktree.id} />
                      )}
                      {lastMessageTime && (
                        <span
                          className={AGENT_TIME}
                          title={new Date(lastMessageTime).toLocaleString()}
                          data-testid="pinned-last-message-time"
                        >
                          {formatRelativeTime(lastMessageTime)}
                        </span>
                      )}
                    </>
                  }
                />
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
        {worktreeMenuItems(
          ContextMenuItem,
          ContextMenuSeparator,
          ContextMenuSub,
          ContextMenuSubTrigger,
          ContextMenuSubContent
        )}
      </ContextMenuContent>

      <AddAttachmentDialog
        open={addAttachmentOpen}
        onOpenChange={setAddAttachmentOpen}
        worktreeId={worktreeId}
        onAttachmentAdded={handleAttachmentAdded}
      />
    </ContextMenu>
  )
}

// ── Sibling count chips (pinned main row only) ─────────────────

function SiblingCountChips({
  projectId,
  excludeId
}: {
  projectId: string
  excludeId: string
}): React.JSX.Element | null {
  const { working, ready, waiting } = useSiblingAggregate(projectId, excludeId)

  if (working.count === 0 && ready.count === 0 && waiting.count === 0) return null

  return (
    <>
      {working.count > 0 && (
        <SiblingChip
          bucket={working}
          icon={<span className={cn(AGENT_WORKING_SPINNER, 'size-2.5 border-[1.5px]')} />}
          testId="pinned-sibling-working"
        />
      )}
      {ready.count > 0 && (
        <SiblingChip
          bucket={ready}
          icon={<CheckCircle2 className="h-2.5 w-2.5 text-emerald-500" />}
          testId="pinned-sibling-ready"
        />
      )}
      {waiting.count > 0 && (
        <SiblingChip
          bucket={waiting}
          icon={<AlertCircle className="h-2.5 w-2.5 text-amber-500" />}
          testId="pinned-sibling-waiting"
        />
      )}
    </>
  )
}

function SiblingChip({
  bucket,
  icon,
  testId
}: {
  bucket: SiblingBucket
  icon: React.ReactNode
  testId: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="ml-1 inline-flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground/70"
          data-testid={testId}
        >
          {icon}
          {bucket.count}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {bucket.names.map((n) => (
          <div key={n}>{n}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

// ── Connection item ────────────────────────────────────────────

function PinnedConnectionItem({
  connectionId
}: {
  connectionId: string
}): React.JSX.Element | null {
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectConnection = useConnectionStore((s) => s.selectConnection)
  const deleteConnection = useConnectionStore((s) => s.deleteConnection)
  const renameConnection = useConnectionStore((s) => s.renameConnection)
  const unpinConnection = usePinnedStore((s) => s.unpinConnection)

  const connectionStatus = useWorktreeStatusStore((s) => s.getConnectionStatus(connectionId))
  const isSelected = selectedConnectionId === connectionId

  const connection = useConnectionStore((s) => s.connections.find((c) => c.id === connectionId))

  const hint = useHintStore((s) => s.hintMap.get(`pinned-conn:${connectionId}`))
  const hintMode = useHintStore((s) => s.mode)
  const hintPendingChar = useHintStore((s) => s.pendingChar)
  const hintActionMode = useHintStore((s) => s.actionMode)
  const vimMode = useVimModeStore((s) => s.mode)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)

  // Inline rename state
  const [isRenaming, setIsRenaming] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalCloseRef = useRef(false)
  const renameStartTimeRef = useRef<number>(0)

  // Manage worktrees dialog state
  const [manageConnectionId, setManageConnectionId] = useState<string | null>(null)

  // Focus rename input when it appears (deferred to run after menu closes)
  useEffect(() => {
    if (isRenaming) {
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
  }, [isRenaming])

  // Cleanup blur timer on unmount
  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    }
  }, [])

  const handleStartRename = useCallback((): void => {
    if (!connection) return
    intentionalCloseRef.current = false
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current) // Clear any pending blur timer
    renameStartTimeRef.current = Date.now() // Record time before setting state
    setNameInput(connection.custom_name || '')
    setIsRenaming(true)
  }, [connection])

  const handleSaveRename = useCallback(async (): Promise<void> => {
    intentionalCloseRef.current = true
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    setIsRenaming(false)
    if (!connection) return
    const trimmed = nameInput.trim()
    const newCustomName = trimmed || null
    if (newCustomName !== (connection.custom_name || null)) {
      await renameConnection(connection.id, newCustomName)
    }
  }, [nameInput, connection, renameConnection])

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSaveRename()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        intentionalCloseRef.current = true
        if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
        setIsRenaming(false)
      }
    },
    [handleSaveRename]
  )

  const handleOpenInTerminal = useCallback(async (): Promise<void> => {
    if (!connection) return
    const result = await connectionApi.openInTerminal(connection.path)
    if (result.success) {
      toast.success('Opened in Terminal')
    } else {
      toast.error(result.error || 'Failed to open in terminal')
    }
  }, [connection])

  const handleOpenInEditor = useCallback(async (): Promise<void> => {
    if (!connection) return
    const result = await connectionApi.openInEditor(connection.path)
    if (result.success) {
      toast.success('Opened in Editor')
    } else {
      toast.error(result.error || 'Failed to open in editor')
    }
  }, [connection])

  const handleOpenInFinder = useCallback(async (): Promise<void> => {
    if (!connection) return
    await projectApi.showInFolder(connection.path)
  }, [connection])

  const handleCopyPath = useCallback(async (): Promise<void> => {
    if (!connection) return
    await projectApi.copyToClipboard(connection.path)
    clipboardToast.copied('Path')
  }, [connection])

  const handleUnpin = useCallback(async (): Promise<void> => {
    await unpinConnection(connectionId)
  }, [unpinConnection, connectionId])

  const handleDelete = useCallback(async (): Promise<void> => {
    await deleteConnection(connectionId)
  }, [deleteConnection, connectionId])

  const handleManageWorktrees = useCallback((): void => {
    setManageConnectionId(connectionId)
  }, [connectionId])

  if (!connection) return null

  // Build the project names string from unique project names
  const projectNames = [
    ...new Set(connection.members?.map((m: { project_name: string }) => m.project_name) || [])
  ].join(' + ')

  // Base instance of a connection project (twin of a default worktree): shows its
  // member branches, and is never renamed/reshaped/deleted from here.
  const isBase = isBaseInstance(connection)

  // Display logic: custom name takes priority over project names
  const hasCustomName = !!connection.custom_name
  const displayName = isBase
    ? baseInstanceLabel(connection.members)
    : hasCustomName
      ? connection.custom_name!
      : projectNames || connection.name || 'Connection'

  const displayStatus = statusLabel(connectionStatus)
  const isUnread = connectionStatus === 'unread'

  const handleClick = (): void => {
    selectConnection(connectionId)
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const connectionMenuItems = (MenuItem: any, MenuSeparator: any): React.JSX.Element => (
    <>
      {!isBase && (
        <>
          <MenuItem onClick={handleManageWorktrees}>
            <Settings2 className="h-4 w-4 mr-2" />
            Connection Worktrees
          </MenuItem>
          <MenuItem onClick={handleStartRename}>
            <Pencil className="h-4 w-4 mr-2" />
            Rename
          </MenuItem>
        </>
      )}
      <MenuItem onClick={handleUnpin}>
        <PinOff className="h-4 w-4 mr-2" />
        Unpin
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={handleOpenInTerminal}>
        <Terminal className="h-4 w-4 mr-2" />
        Open in Terminal
      </MenuItem>
      <MenuItem onClick={handleOpenInEditor}>
        <Code className="h-4 w-4 mr-2" />
        Open in Editor
      </MenuItem>
      <MenuItem onClick={handleOpenInFinder}>
        <ExternalLink className="h-4 w-4 mr-2" />
        {revealLabel(true)}
      </MenuItem>
      <MenuItem onClick={handleCopyPath}>
        <Copy className="h-4 w-4 mr-2" />
        Copy Path
      </MenuItem>
      {!isBase && (
        <>
          <MenuSeparator />
          <MenuItem
            onClick={handleDelete}
            className="text-destructive focus:text-destructive focus:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </MenuItem>
        </>
      )}
    </>
  )
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <WorkspaceCardSurface
          active={isSelected ? 'primary' : false}
          renaming={isRenaming}
          className="group/worktree-card"
          style={{ paddingLeft: getFlushWorktreeCardPaddingLeft(0) }}
          onClick={handleClick}
          data-testid={`pinned-connection-${connectionId}`}
        >
          <div className={cn(CARD_PARENT_ROW, CARD_PARENT_ROW_ALIGN)}>
            <StatusLane status={connectionStatus} />

            <div className={cn(CARD_CONTENT_COLUMN, CARD_CONTENT_COLUMN_OVERFLOW_VISIBLE)}>
              {/* Title row: connection color dot / link glyph + name (or inline rename) + hover actions */}
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
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      autoFocus
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
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
                            setIsRenaming(false)
                          }
                        }, 100)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        CARD_TITLE_EDITING_INPUT,
                        'w-full min-w-0 flex-1 text-[13px] leading-5'
                      )}
                      placeholder={projectNames || 'Connection name'}
                    />
                  ) : (
                    <span
                      className={isUnread ? CARD_TITLE_IS_UNREAD : CARD_TITLE_IS_DIM}
                      // Base rows all read "main" — qualify the hover with the member projects
                      title={isBase && projectNames ? `${projectNames} — ${displayName}` : displayName}
                    >
                      {displayName}
                    </span>
                  )}
                  {isBase && !isRenaming && (
                    <span
                      className={MICRO_BADGE_PRIMARY}
                      title="Base connection (default worktree of every member project)"
                      data-connection-base-badge=""
                    >
                      primary
                    </span>
                  )}
                </div>

                <div className={CARD_TITLE_ACTIONS}>
                  {hint && vimModeEnabled && vimMode === 'normal' && (
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
                        className={MORE_BUTTON_CLASS}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="w-52" align="end">
                      {connectionMenuItems(DropdownMenuItem, DropdownMenuSeparator)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Inline agent row: state dot · status (+ member projects) — hidden while renaming */}
              {!isRenaming && (
                <div
                  className={cn(AGENT_LIST, AGENT_LIST_AFTER_TITLE)}
                  data-compact-agent-list="true"
                >
                  <SidebarAgentRow
                    leading={<AgentStateDot state={statusToDotState(connectionStatus)} size="sm" />}
                    label={<span data-testid="pinned-status-text">{displayStatus}</span>}
                    secondary={(hasCustomName || isBase) && projectNames ? projectNames : undefined}
                  />
                </div>
              )}
            </div>
          </div>
        </WorkspaceCardSurface>
      </ContextMenuTrigger>

      {/* Context Menu (right-click) */}
      <ContextMenuContent className="w-52">
        {connectionMenuItems(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>

      {manageConnectionId && (
        <ManageConnectionWorktreesDialog
          connectionId={manageConnectionId}
          open={!!manageConnectionId}
          onOpenChange={(open) => {
            if (!open) setManageConnectionId(null)
          }}
        />
      )}
    </ContextMenu>
  )
}
