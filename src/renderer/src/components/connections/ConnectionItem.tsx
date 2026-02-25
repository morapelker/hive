import { useCallback, useEffect, useState, useRef } from 'react'
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
import { useConnectionStore, usePinnedStore } from '@/stores'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { toast, clipboardToast } from '@/lib/toast'

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

  const isSelected = selectedConnectionId === connection.id

  // Derive display status text + color
  const { displayStatus, statusClass } =
    connectionStatus === 'answering'
      ? { displayStatus: 'Answer questions', statusClass: 'font-semibold text-amber-500' }
      : connectionStatus === 'permission'
        ? { displayStatus: 'Permission', statusClass: 'font-semibold text-amber-500' }
        : connectionStatus === 'planning'
          ? { displayStatus: 'Planning', statusClass: 'font-semibold text-blue-400' }
          : connectionStatus === 'working'
            ? { displayStatus: 'Working', statusClass: 'font-semibold text-primary' }
            : connectionStatus === 'plan_ready'
              ? { displayStatus: 'Plan ready', statusClass: 'font-semibold text-blue-400' }
              : connectionStatus === 'completed'
                ? { displayStatus: 'Ready', statusClass: 'font-semibold text-green-400' }
                : { displayStatus: 'Ready', statusClass: 'text-muted-foreground' }

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

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

  const handleStartRename = useCallback((): void => {
    setNameInput(connection.custom_name || '')
    setIsRenaming(true)
  }, [connection.custom_name])

  const handleSaveRename = useCallback(async (): Promise<void> => {
    setIsRenaming(false)
    const trimmed = nameInput.trim()
    // Empty string clears the custom name (revert to default)
    const newCustomName = trimmed || null
    // Only save if the value actually changed
    if (newCustomName !== (connection.custom_name || null)) {
      await renameConnection(connection.id, newCustomName)
    }
  }, [nameInput, connection.id, connection.custom_name, renameConnection])

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSaveRename()
      } else if (e.key === 'Escape') {
        e.preventDefault()
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
      toast.success('Opened in Terminal')
    } else {
      toast.error(result.error || 'Failed to open in terminal')
    }
  }, [connection.path])

  const handleOpenInEditor = useCallback(async (): Promise<void> => {
    const result = await window.connectionOps.openInEditor(connection.path)
    if (result.success) {
      toast.success('Opened in Editor')
    } else {
      toast.error(result.error || 'Failed to open in editor')
    }
  }, [connection.path])

  const handleOpenInFinder = async (): Promise<void> => {
    await window.projectOps.showInFolder(connection.path)
  }

  const handleCopyPath = async (): Promise<void> => {
    await window.projectOps.copyToClipboard(connection.path)
    clipboardToast.copied('Path')
  }

  const handleDelete = useCallback(async (): Promise<void> => {
    await deleteConnection(connection.id)
  }, [deleteConnection, connection.id])

  const handleManageWorktrees = useCallback((): void => {
    onManageWorktrees?.(connection.id)
  }, [onManageWorktrees, connection.id])

  // Build the project names string from unique project names
  const projectNames =
    [...new Set(connection.members?.map((m) => m.project_name) || [])].join(' + ')

  // Display logic: custom name takes priority over project names
  const hasCustomName = !!connection.custom_name
  const displayName = hasCustomName
    ? connection.custom_name!
    : projectNames || connection.name || 'Connection'

  const menuItems = (
    <>
      <ContextMenuItem onClick={handleManageWorktrees}>
        <Settings2 className="h-4 w-4 mr-2" />
        Connection Worktrees
      </ContextMenuItem>
      <ContextMenuItem onClick={handleStartRename}>
        <Pencil className="h-4 w-4 mr-2" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onClick={handleTogglePin}>
        {isPinned ? (
          <PinOff className="h-4 w-4 mr-2" />
        ) : (
          <Pin className="h-4 w-4 mr-2" />
        )}
        {isPinned ? 'Unpin' : 'Pin'}
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
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={handleDelete}
        className="text-destructive focus:text-destructive focus:bg-destructive/10"
      >
        <Trash2 className="h-4 w-4 mr-2" />
        Delete
      </ContextMenuItem>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
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
          {(connectionStatus === 'answering' || connectionStatus === 'permission') && (
            <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          )}
          {connectionStatus === 'plan_ready' && (
            <Map className="h-3.5 w-3.5 text-blue-400 shrink-0" />
          )}

          {/* Name and status */}
          <div className="flex-1 min-w-0">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={handleRenameKeyDown}
                onBlur={() => setIsRenaming(false)}
                onClick={(e) => e.stopPropagation()}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-sm w-full focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder={projectNames || 'Connection name'}
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
                <span
                  className={cn('text-[11px]', statusClass)}
                  data-testid="connection-status-text"
                >
                  {displayStatus}
                  {hasCustomName && projectNames && (
                    <span className="text-muted-foreground font-normal"> · {projectNames}</span>
                  )}
                </span>
              </>
            )}
          </div>

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
                Connection Worktrees
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleStartRename}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename
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
                Open in Finder
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyPath}>
                <Copy className="h-4 w-4 mr-2" />
                Copy Path
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleDelete}
                className="text-destructive focus:text-destructive focus:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>

      {/* Context Menu (right-click) */}
      <ContextMenuContent className="w-52">{menuItems}</ContextMenuContent>
    </ContextMenu>
  )
}
