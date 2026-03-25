import { useCallback, useEffect, useState, useRef } from 'react'
import { fileManagerName } from '@/lib/platform'
import {
  AlertCircle,
  Code,
  Copy,
  ExternalLink,
  Link,
  Loader2,
  Map,
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
  useSettingsStore
} from '@/stores'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { HintBadge } from '@/components/ui/HintBadge'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'

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
  created_at: string
  updated_at: string
  members: ConnectionMemberEnriched[]
}

interface ConnectionItemProps {
  connection: Connection
  onManageWorktrees?: (connectionId: string) => void
}

export function ConnectionItem({
  connection,
  onManageWorktrees
}: ConnectionItemProps): React.JSX.Element {
  const { t } = useI18n()
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectConnection = useConnectionStore((s) => s.selectConnection)
  const deleteConnection = useConnectionStore((s) => s.deleteConnection)
  const renameConnection = useConnectionStore((s) => s.renameConnection)

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

  // Derive display status text + color
  const { displayStatus, statusClass } =
    connectionStatus === 'answering'
      ? { displayStatus: t('pinned.status.answering'), statusClass: 'font-semibold text-amber-500' }
      : connectionStatus === 'command_approval'
        ? {
            displayStatus: t('pinned.status.commandApproval'),
            statusClass: 'font-semibold text-orange-500'
          }
        : connectionStatus === 'permission'
          ? {
              displayStatus: t('pinned.status.permission'),
              statusClass: 'font-semibold text-amber-500'
            }
          : connectionStatus === 'planning'
            ? {
                displayStatus: t('pinned.status.planning'),
                statusClass: 'font-semibold text-blue-400'
              }
            : connectionStatus === 'working'
              ? {
                  displayStatus: t('pinned.status.working'),
                  statusClass: 'font-semibold text-primary'
                }
              : connectionStatus === 'plan_ready'
                ? {
                    displayStatus: t('pinned.status.planReady'),
                    statusClass: 'font-semibold text-blue-400'
                  }
                : connectionStatus === 'completed'
                  ? {
                      displayStatus: t('pinned.status.ready'),
                      statusClass: 'font-semibold text-green-400'
                    }
                  : {
                      displayStatus: t('pinned.status.ready'),
                      statusClass: 'text-muted-foreground'
                    }

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
    const result = await window.connectionOps.openInTerminal(connection.path)
    if (result.success) {
      toast.success(t('pinned.toasts.openedInTerminal'))
    } else {
      toast.error(result.error || t('pinned.toasts.openInTerminalError'))
    }
  }, [connection.path, t])

  const handleOpenInEditor = useCallback(async (): Promise<void> => {
    const result = await window.connectionOps.openInEditor(connection.path)
    if (result.success) {
      toast.success(t('pinned.toasts.openedInEditor'))
    } else {
      toast.error(result.error || t('pinned.toasts.openInEditorError'))
    }
  }, [connection.path, t])

  const handleOpenInFinder = async (): Promise<void> => {
    await window.projectOps.showInFolder(connection.path)
  }

  const handleCopyPath = async (): Promise<void> => {
    await window.projectOps.copyToClipboard(connection.path)
    toast.success(t('pinned.toasts.pathCopied'))
  }

  const handleDelete = useCallback(async (): Promise<void> => {
    await deleteConnection(connection.id)
  }, [deleteConnection, connection.id])

  const handleManageWorktrees = useCallback((): void => {
    onManageWorktrees?.(connection.id)
  }, [onManageWorktrees, connection.id])

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

  // Display logic: custom name takes priority over project names
  const hasCustomName = !!connection.custom_name
  const displayName = hasCustomName
    ? connection.custom_name!
    : projectNames || connection.name || t('pinned.connectionFallback')

  const menuItems = (
    <>
      <ContextMenuItem onClick={handleManageWorktrees}>
        <Settings2 className="h-4 w-4 mr-2" />
        {t('pinned.menu.connectionWorktrees')}
      </ContextMenuItem>
      <ContextMenuItem onClick={handleStartRename}>
        <Pencil className="h-4 w-4 mr-2" />
        {t('pinned.menu.rename')}
      </ContextMenuItem>
      <ContextMenuItem onClick={handleTogglePin}>
        {isPinned ? <PinOff className="h-4 w-4 mr-2" /> : <Pin className="h-4 w-4 mr-2" />}
        {isPinned ? t('pinned.menu.unpin') : t('pinned.menu.pin')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={handleOpenInTerminal}>
        <Terminal className="h-4 w-4 mr-2" />
        {t('pinned.menu.openInTerminal')}
      </ContextMenuItem>
      <ContextMenuItem onClick={handleOpenInEditor}>
        <Code className="h-4 w-4 mr-2" />
        {t('pinned.menu.openInEditor')}
      </ContextMenuItem>
      <ContextMenuItem onClick={handleOpenInFinder}>
        <ExternalLink className="h-4 w-4 mr-2" />
        {t('pinned.menu.openInFileManager', { manager: fileManagerName() })}
      </ContextMenuItem>
      <ContextMenuItem onClick={handleCopyPath}>
        <Copy className="h-4 w-4 mr-2" />
        {t('pinned.menu.copyPath')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={handleDelete}
        className="text-destructive focus:text-destructive focus:bg-destructive/10"
      >
        <Trash2 className="h-4 w-4 mr-2" />
        {t('pinned.menu.delete')}
      </ContextMenuItem>
    </>
  )

  const mainContent = (
    <div
      className={cn(
        'group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
      )}
      onClick={handleClick}
      data-testid={`connection-item-${connection.id}`}
    >
      {/* Connection color indicator — always visible */}
      {connection.color ? (
        <span
          className="h-2.5 w-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: parseColorQuad(connection.color)[1] }}
          aria-hidden="true"
        />
      ) : (
        <Link className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      )}

      {/* Status icon (shown alongside color) */}
      {(connectionStatus === 'working' || connectionStatus === 'planning') && (
        <Loader2 className="h-3.5 w-3.5 text-primary shrink-0 animate-spin" />
      )}
      {(connectionStatus === 'answering' ||
        connectionStatus === 'command_approval' ||
        connectionStatus === 'permission') && (
        <AlertCircle
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            connectionStatus === 'command_approval' ? 'text-orange-500' : 'text-amber-500'
          )}
        />
      )}
      {connectionStatus === 'plan_ready' && <Map className="h-3.5 w-3.5 text-blue-400 shrink-0" />}

      {/* Name and status */}
      <div className="flex-1 min-w-0">
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
                  if (renameInputRef.current && document.activeElement !== renameInputRef.current) {
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
            className="bg-background border border-border rounded px-1.5 py-0.5 text-sm w-full focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={projectNames || t('pinned.connectionNamePlaceholder')}
          />
        ) : (
          <>
            <div
              className="overflow-hidden"
              ref={containerRef}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              <span
                ref={textRef}
                className={cn('text-sm whitespace-nowrap block', !isAnimating && 'truncate')}
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
            <span className={cn('text-[11px]', statusClass)} data-testid="connection-status-text">
              {displayStatus}
            </span>
          </>
        )}
      </div>

      {/* Hint badge */}
      {hint && vimModeEnabled && vimMode === 'normal' && (
        <HintBadge
          code={hint}
          mode={hintMode}
          pendingChar={hintPendingChar}
          actionMode={hintActionMode}
        />
      )}

      {/* Unread dot badge */}
      {connectionStatus === 'unread' && (
        <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
      )}

      {/* More Options Dropdown (visible on hover) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity',
              'hover:bg-accent'
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52" align="end">
          <DropdownMenuItem onClick={handleManageWorktrees}>
            <Settings2 className="h-4 w-4 mr-2" />
            {t('pinned.menu.connectionWorktrees')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleStartRename}>
            <Pencil className="h-4 w-4 mr-2" />
            {t('pinned.menu.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleTogglePin}>
            {isPinned ? <PinOff className="h-4 w-4 mr-2" /> : <Pin className="h-4 w-4 mr-2" />}
            {isPinned ? t('pinned.menu.unpin') : t('pinned.menu.pin')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleOpenInTerminal}>
            <Terminal className="h-4 w-4 mr-2" />
            {t('pinned.menu.openInTerminal')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleOpenInEditor}>
            <Code className="h-4 w-4 mr-2" />
            {t('pinned.menu.openInEditor')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleOpenInFinder}>
            <ExternalLink className="h-4 w-4 mr-2" />
            {t('pinned.menu.openInFileManager', { manager: fileManagerName() })}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleCopyPath}>
            <Copy className="h-4 w-4 mr-2" />
            {t('pinned.menu.copyPath')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleDelete}
            className="text-destructive focus:text-destructive focus:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            {t('pinned.menu.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>{mainContent}</TooltipTrigger>
        </ContextMenuTrigger>
        {hasCustomName && projectDetails.length > 0 && (
          <TooltipContent side="right" sideOffset={8} className="max-w-xs">
            <div className="space-y-1">
              {projectDetails.map((detail, idx) => (
                <div key={idx} className="text-[11px] font-mono">
                  <div className="font-medium">{detail.project}</div>
                  <div className="text-muted-foreground text-[10px]">→ {detail.branch}</div>
                </div>
              ))}
            </div>
          </TooltipContent>
        )}
      </Tooltip>

      {/* Context Menu (right-click) */}
      <ContextMenuContent className="w-52">{menuItems}</ContextMenuContent>
    </ContextMenu>
  )
}
