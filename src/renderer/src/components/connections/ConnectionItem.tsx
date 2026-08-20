import { useCallback, useEffect, useState, useRef } from 'react'
import { revealLabel } from '@/lib/platform'
import {
  Archive,
  Code,
  Copy,
  ExternalLink,
  FolderPlus,
  Link,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Settings2,
  Terminal,
  Trash2
} from 'lucide-react'
import { cn, parseColorQuad } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  useConnectionStore,
  usePinnedStore,
  useHintStore,
  useVimModeStore,
  useSettingsStore,
  useProjectStore,
  useWorktreeStore
} from '@/stores'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { HintBadge } from '@/components/ui/HintBadge'
import {
  AGENT_LIST,
  AGENT_LIST_AFTER_TITLE,
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
  CARD_TITLE_BASE,
  CARD_TITLE_DIM,
  CARD_TITLE_EDITING_INPUT,
  CARD_TITLE_ROW,
  CARD_TITLE_ROW_LEFT,
  CARD_TITLE_UNREAD,
  MICRO_BADGE_PRIMARY,
  SidebarAgentRow,
  WorkspaceCardSurface,
  getFlushWorktreeCardPaddingLeft,
  type AgentDotState
} from '@/components/sidebar'
import { baseInstanceLabel, isBaseInstance } from '@/lib/connection-project'
import { ArchiveConfirmDialog } from '@/components/worktrees/ArchiveConfirmDialog'
import type { DiffStatFile } from '@/components/worktrees/DirtyFilesConfirmDialog'
import { toast, clipboardToast } from '@/lib/toast'
import { connectionApi } from '@/api/connection-api'
import { projectApi } from '@/api/project-api'
import { gitApi } from '@/api/git-api'

interface ConnectionMemberEnriched {
  id: string
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
  added_at: string
  worktree_name: string
  worktree_branch: string
  worktree_path: string
  project_name: string
}

interface Connection {
  id: string
  name: string
  custom_name: string | null
  status: 'active' | 'archived'
  path: string
  color: string | null
  /** Saved-connection project this connection is an instance of (null/absent = ad-hoc). */
  saved_project_id?: string | null
  /** 1 = base instance of a connection project (members = each member project's default worktree). */
  is_base?: number
  created_at: string
  updated_at: string
  members: ConnectionMemberEnriched[]
}

interface ConnectionItemProps {
  connection: Connection
  onManageWorktrees?: (connectionId: string) => void
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

export function ConnectionItem({
  connection,
  onManageWorktrees
}: ConnectionItemProps): React.JSX.Element {
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectConnection = useConnectionStore((s) => s.selectConnection)
  const deleteConnection = useConnectionStore((s) => s.deleteConnection)
  const renameConnection = useConnectionStore((s) => s.renameConnection)
  const saveConnectionAsProject = useConnectionStore((s) => s.saveConnectionAsProject)

  // "Save as Project" needs >=2 distinct member projects and an unsaved connection
  const distinctMemberProjectCount = new Set(
    (connection.members || []).map((m) => m.project_id)
  ).size
  const canSaveAsProject = !connection.saved_project_id && distinctMemberProjectCount >= 2
  const [isSavingAsProject, setIsSavingAsProject] = useState(false)
  const handleSaveAsProject = useCallback(async (): Promise<void> => {
    if (isSavingAsProject) return
    setIsSavingAsProject(true)
    try {
      await saveConnectionAsProject(connection.id)
    } finally {
      setIsSavingAsProject(false)
    }
  }, [isSavingAsProject, saveConnectionAsProject, connection.id])

  // Pinned state
  const isPinned = usePinnedStore((s) => s.pinnedConnectionIds.has(connection.id))
  const pinConnection = usePinnedStore((s) => s.pinConnection)
  const unpinConnection = usePinnedStore((s) => s.unpinConnection)

  const handleTogglePin = useCallback(async (): Promise<void> => {
    if (isPinned) {
      await unpinConnection(connection.id)
    } else {
      await pinConnection(connection.id)
    }
  }, [isPinned, connection.id, pinConnection, unpinConnection])

  const connectionStatus = useWorktreeStatusStore((state) =>
    state.getConnectionStatus(connection.id)
  )

  // Hint overlay state
  const hint = useHintStore((s) => s.hintMap.get(`conn:${connection.id}`))
  const hintMode = useHintStore((s) => s.mode)
  const hintPendingChar = useHintStore((s) => s.pendingChar)
  const hintActionMode = useHintStore((s) => s.actionMode)
  const vimMode = useVimModeStore((s) => s.mode)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)

  const isSelected = selectedConnectionId === connection.id

  // Base instance of a connection project — the twin of a default worktree:
  // fixed members, never archived/deleted/renamed, labelled by its branches.
  const isBase = isBaseInstance(connection)

  // Derive display status text (state colour lives in the orca AgentStateDot glyphs)
  const displayStatus =
    connectionStatus === 'answering'
      ? 'Answer questions'
      : connectionStatus === 'command_approval'
        ? 'Approve command'
        : connectionStatus === 'permission'
          ? 'Permission'
          : connectionStatus === 'planning'
            ? 'Planning'
            : connectionStatus === 'working'
              ? 'Working'
              : connectionStatus === 'plan_ready'
                ? 'Plan ready'
                : 'Ready'
  const isUnread = connectionStatus === 'unread'

  // Marquee animation state for overflowing display name
  const containerRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [isAnimating, setIsAnimating] = useState(false)
  const [scrollDistance, setScrollDistance] = useState(0)
  const [animationDuration, setAnimationDuration] = useState(3)

  // Inline rename state
  const [isRenaming, setIsRenaming] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalCloseRef = useRef(false)
  const renameStartTimeRef = useRef<number>(0)

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
    intentionalCloseRef.current = false
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current) // Clear any pending blur timer
    renameStartTimeRef.current = Date.now() // Record time before setting state
    setNameInput(connection.custom_name || '')
    setIsRenaming(true)
  }, [connection.custom_name])

  const handleSaveRename = useCallback(async (): Promise<void> => {
    intentionalCloseRef.current = true
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    try {
      const trimmed = nameInput.trim()
      // Empty string clears the custom name (revert to default)
      const newCustomName = trimmed || null
      // Only save if the value actually changed
      if (newCustomName !== (connection.custom_name || null)) {
        await renameConnection(connection.id, newCustomName)
      }
    } finally {
      setIsRenaming(false)
    }
  }, [nameInput, connection.id, connection.custom_name, renameConnection])

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

  const handleMouseEnter = useCallback((): void => {
    if (!containerRef.current || !textRef.current) return
    const containerWidth = containerRef.current.clientWidth
    const textWidth = textRef.current.scrollWidth
    if (textWidth > containerWidth) {
      const distance = -(textWidth - containerWidth)
      setScrollDistance(distance)
      // Speed: ~30px per second feels readable
      setAnimationDuration(Math.max(2, Math.abs(distance) / 30))
      setIsAnimating(true)
    }
  }, [])

  const handleMouseLeave = useCallback((): void => {
    setIsAnimating(false)
  }, [])

  const handleClick = (): void => {
    selectConnection(connection.id)
  }

  const handleOpenInTerminal = useCallback(async (): Promise<void> => {
    const result = await connectionApi.openInTerminal(connection.path)
    if (result.success) {
      toast.success('Opened in Terminal')
    } else {
      toast.error(result.error || 'Failed to open in terminal')
    }
  }, [connection.path])

  const handleOpenInEditor = useCallback(async (): Promise<void> => {
    const result = await connectionApi.openInEditor(connection.path)
    if (result.success) {
      toast.success('Opened in Editor')
    } else {
      toast.error(result.error || 'Failed to open in editor')
    }
  }, [connection.path])

  const handleOpenInFinder = async (): Promise<void> => {
    await projectApi.showInFolder(connection.path)
  }

  const handleCopyPath = async (): Promise<void> => {
    await projectApi.copyToClipboard(connection.path)
    clipboardToast.copied('Path')
  }

  const handleDelete = useCallback(async (): Promise<void> => {
    await deleteConnection(connection.id)
  }, [deleteConnection, connection.id])

  const handleManageWorktrees = useCallback((): void => {
    onManageWorktrees?.(connection.id)
  }, [onManageWorktrees, connection.id])

  // Archive All confirmation state
  const [archiveAllConfirmOpen, setArchiveAllConfirmOpen] = useState(false)
  const [archiveAllConfirmFiles, setArchiveAllConfirmFiles] = useState<DiffStatFile[]>([])
  const [isArchivingAll, setIsArchivingAll] = useState(false)

  // Members whose worktrees can actually be archived (default worktrees never are)
  const getArchivableMembers = useCallback((): ConnectionMemberEnriched[] => {
    const allWorktrees = Array.from(useWorktreeStore.getState().worktreesByProject.values()).flat()
    return (connection.members || []).filter(
      (m) => !allWorktrees.find((w) => w.id === m.worktree_id)?.is_default
    )
  }, [connection.members])

  const doArchiveAll = useCallback(async (): Promise<void> => {
    setIsArchivingAll(true)
    try {
      const projects = useProjectStore.getState().projects
      const archiveWorktree = useWorktreeStore.getState().archiveWorktree
      let failures = 0
      for (const member of getArchivableMembers()) {
        const project = projects.find((p) => p.id === member.project_id)
        if (!project) {
          failures++
          continue
        }
        const result = await archiveWorktree(
          member.worktree_id,
          member.worktree_path,
          member.worktree_branch,
          project.path
        )
        if (!result.success) failures++
      }

      if (failures > 0) {
        toast.error(`Failed to archive ${failures} ${failures === 1 ? 'worktree' : 'worktrees'}`)
        return
      }

      // Archiving the last member cascade-deletes the connection server-side; delete
      // explicitly if it survived (e.g. only default worktrees remained as members).
      const connectionStore = useConnectionStore.getState()
      if (connectionStore.connections.some((c) => c.id === connection.id)) {
        await connectionStore.deleteConnection(connection.id)
      } else {
        if (connectionStore.selectedConnectionId === connection.id) {
          connectionStore.selectConnection(null)
        }
        toast.success('Connection worktrees archived')
      }
    } finally {
      setIsArchivingAll(false)
    }
  }, [connection.id, getArchivableMembers])

  const handleArchiveAll = useCallback(async (): Promise<void> => {
    if (isArchivingAll) return
    const dirtyFiles: DiffStatFile[] = []
    for (const member of getArchivableMembers()) {
      try {
        const result = await gitApi.getDiffStat(member.worktree_path)
        if (result.success && result.files && result.files.length > 0) {
          dirtyFiles.push(
            ...result.files.map((f) => ({ ...f, path: `${member.worktree_name}/${f.path}` }))
          )
        }
      } catch {
        // If we can't check, proceed without confirmation
      }
    }
    if (dirtyFiles.length > 0) {
      setArchiveAllConfirmFiles(dirtyFiles)
      setArchiveAllConfirmOpen(true)
      return
    }
    doArchiveAll()
  }, [isArchivingAll, getArchivableMembers, doArchiveAll])

  const handleArchiveAllConfirm = useCallback((): void => {
    setArchiveAllConfirmOpen(false)
    setArchiveAllConfirmFiles([])
    doArchiveAll()
  }, [doArchiveAll])

  const handleArchiveAllCancel = useCallback((): void => {
    setArchiveAllConfirmOpen(false)
    setArchiveAllConfirmFiles([])
  }, [])

  // Build the project names string from unique project names
  const projectNames = [...new Set(connection.members?.map((m) => m.project_name) || [])].join(
    ' + '
  )

  // Build detailed project info for tooltip (project name + branch)
  const projectDetails =
    connection.members?.map((m) => ({
      project: m.project_name,
      branch: m.worktree_branch
    })) || []

  // Display logic: the base instance shows its member branches ("main"), else
  // custom name takes priority over project names
  const hasCustomName = !!connection.custom_name
  const displayName = isBase
    ? baseInstanceLabel(connection.members)
    : hasCustomName
      ? connection.custom_name!
      : projectNames || connection.name || 'Connection'

  const menuItems = (
    <>
      {!isBase && (
        <>
          <ContextMenuItem onClick={handleManageWorktrees}>
            <Settings2 className="h-4 w-4 mr-2" />
            Connection Worktrees
          </ContextMenuItem>
          <ContextMenuItem onClick={handleStartRename}>
            <Pencil className="h-4 w-4 mr-2" />
            Rename
          </ContextMenuItem>
        </>
      )}
      <ContextMenuItem onClick={handleTogglePin}>
        {isPinned ? <PinOff className="h-4 w-4 mr-2" /> : <Pin className="h-4 w-4 mr-2" />}
        {isPinned ? 'Unpin' : 'Pin'}
      </ContextMenuItem>
      {canSaveAsProject && (
        <ContextMenuItem onClick={handleSaveAsProject} disabled={isSavingAsProject}>
          <FolderPlus className="h-4 w-4 mr-2" />
          Save as Project
        </ContextMenuItem>
      )}
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
        {revealLabel(true)}
      </ContextMenuItem>
      <ContextMenuItem onClick={handleCopyPath}>
        <Copy className="h-4 w-4 mr-2" />
        Copy Path
      </ContextMenuItem>
      {!isBase && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={handleArchiveAll}
            disabled={isArchivingAll}
            className="text-destructive focus:text-destructive focus:bg-destructive/10"
          >
            <Archive className="h-4 w-4 mr-2" />
            Archive All
          </ContextMenuItem>
          <ContextMenuItem
            onClick={handleDelete}
            className="text-destructive focus:text-destructive focus:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </ContextMenuItem>
        </>
      )}
    </>
  )

  const mainContent = (
    <WorkspaceCardSurface
      active={isSelected ? 'primary' : false}
      renaming={isRenaming}
      className="group/worktree-card"
      style={{ paddingLeft: getFlushWorktreeCardPaddingLeft(0) }}
      onClick={handleClick}
      data-testid={`connection-item-${connection.id}`}
      data-connection-base={isBase ? '' : undefined}
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
                <div
                  className="min-w-0 flex-1 overflow-hidden"
                  ref={containerRef}
                  onMouseEnter={handleMouseEnter}
                  onMouseLeave={handleMouseLeave}
                >
                  <span
                    ref={textRef}
                    className={cn(
                      CARD_TITLE_BASE,
                      isUnread ? CARD_TITLE_UNREAD : CARD_TITLE_DIM,
                      'whitespace-nowrap',
                      isAnimating && 'overflow-visible text-clip'
                    )}
                    style={
                      isAnimating
                        ? ({
                            '--scroll-distance': `${scrollDistance}px`,
                            animation: `marquee-scroll ${animationDuration}s linear infinite`
                          } as React.CSSProperties)
                        : undefined
                    }
                    title={displayName}
                  >
                    {displayName}
                  </span>
                </div>
              )}

              {/* Base-instance micro badge — the connection-project twin of the
                  default worktree's "primary" badge */}
              {isBase && !isRenaming && (
                <span
                  className={MICRO_BADGE_PRIMARY}
                  title="Base connection (default worktree of every member project)"
                  data-connection-base-badge=""
                >
                  primary
                </span>
              )}

              <div className={CARD_TITLE_ACTIONS}>
                {/* Hint badge */}
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
                    {!isBase && (
                      <>
                        <DropdownMenuItem onClick={handleManageWorktrees}>
                          <Settings2 className="h-4 w-4 mr-2" />
                          Connection Worktrees
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={handleStartRename}>
                          <Pencil className="h-4 w-4 mr-2" />
                          Rename
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuItem onClick={handleTogglePin}>
                      {isPinned ? (
                        <PinOff className="h-4 w-4 mr-2" />
                      ) : (
                        <Pin className="h-4 w-4 mr-2" />
                      )}
                      {isPinned ? 'Unpin' : 'Pin'}
                    </DropdownMenuItem>
                    {canSaveAsProject && (
                      <DropdownMenuItem onClick={handleSaveAsProject} disabled={isSavingAsProject}>
                        <FolderPlus className="h-4 w-4 mr-2" />
                        Save as Project
                      </DropdownMenuItem>
                    )}
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
                    {!isBase && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={handleArchiveAll}
                          disabled={isArchivingAll}
                          className="text-destructive focus:text-destructive focus:bg-destructive/10"
                        >
                          <Archive className="h-4 w-4 mr-2" />
                          Archive All
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={handleDelete}
                          className="text-destructive focus:text-destructive focus:bg-destructive/10"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>

          {/* Inline agent row (orca compact agent row): state dot · status — hidden while renaming */}
          {!isRenaming && (
            <div className={cn(AGENT_LIST, AGENT_LIST_AFTER_TITLE)} data-compact-agent-list="true">
              <SidebarAgentRow
                leading={<AgentStateDot state={statusToDotState(connectionStatus)} size="sm" />}
                label={<span data-testid="connection-status-text">{displayStatus}</span>}
              />
            </div>
          )}
        </div>
      </div>
    </WorkspaceCardSurface>
  )

  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>{mainContent}</TooltipTrigger>
        </ContextMenuTrigger>
        {(hasCustomName || isBase) && projectDetails.length > 0 && (
          <TooltipContent side="right" sideOffset={8} className="max-w-xs">
            <div className="space-y-1">
              {projectDetails.map((detail, idx) => (
                <div key={idx} className="text-[11px] font-mono">
                  <div className="font-medium">{detail.project}</div>
                  <div className="text-background/70 text-[10px]">→ {detail.branch}</div>
                </div>
              ))}
            </div>
          </TooltipContent>
        )}
      </Tooltip>

      <ArchiveConfirmDialog
        open={archiveAllConfirmOpen}
        worktreeName={displayName}
        files={archiveAllConfirmFiles}
        onCancel={handleArchiveAllCancel}
        onConfirm={handleArchiveAllConfirm}
      />

      {/* Context Menu (right-click) */}
      <ContextMenuContent className="w-52">{menuItems}</ContextMenuContent>
    </ContextMenu>
  )
}
