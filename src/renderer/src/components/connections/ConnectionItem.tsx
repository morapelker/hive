import { useCallback, useState, useRef, useEffect } from 'react'
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
  Plus,
  Terminal,
  Trash2
} from 'lucide-react'
import { cn } from '@/lib/utils'
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
import { useConnectionStore } from '@/stores'
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
  status: 'active' | 'archived'
  path: string
  created_at: string
  updated_at: string
  members: ConnectionMemberEnriched[]
}

interface ConnectionItemProps {
  connection: Connection
  onAddWorktree?: (connectionId: string) => void
}

export function ConnectionItem({
  connection,
  onAddWorktree
}: ConnectionItemProps): React.JSX.Element {
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectConnection = useConnectionStore((s) => s.selectConnection)
  const deleteConnection = useConnectionStore((s) => s.deleteConnection)
  const renameConnection = useConnectionStore((s) => s.renameConnection)

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
              : { displayStatus: 'Ready', statusClass: 'text-muted-foreground' }

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

  const startRename = useCallback((): void => {
    setNameInput(connection.name)
    setIsRenaming(true)
  }, [connection.name])

  const handleRename = useCallback(async (): Promise<void> => {
    const trimmed = nameInput.trim()
    if (!trimmed || trimmed === connection.name) {
      setIsRenaming(false)
      return
    }
    await renameConnection(connection.id, trimmed)
    setIsRenaming(false)
  }, [nameInput, connection.id, connection.name, renameConnection])

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

  const handleAddWorktree = useCallback((): void => {
    onAddWorktree?.(connection.id)
  }, [onAddWorktree, connection.id])

  // Build the subtitle from unique project names
  const projectSubtitle = [...new Set(connection.members?.map((m) => m.project_name) || [])].join(
    ' + '
  )

  const menuItems = (
    <>
      <ContextMenuItem onClick={startRename}>
        <Pencil className="h-4 w-4 mr-2" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onClick={handleAddWorktree}>
        <Plus className="h-4 w-4 mr-2" />
        Add Worktree
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
          {/* Status icon */}
          {(connectionStatus === 'working' || connectionStatus === 'planning') && (
            <Loader2 className="h-3.5 w-3.5 text-primary shrink-0 animate-spin" />
          )}
          {(connectionStatus === 'answering' || connectionStatus === 'permission') && (
            <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          )}
          {connectionStatus === 'plan_ready' && (
            <Map className="h-3.5 w-3.5 text-blue-400 shrink-0" />
          )}
          {connectionStatus !== 'working' &&
            connectionStatus !== 'planning' &&
            connectionStatus !== 'answering' &&
            connectionStatus !== 'permission' &&
            connectionStatus !== 'plan_ready' && (
              <Link className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}

          {/* Name and subtitle */}
          <div className="flex-1 min-w-0">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename()
                  if (e.key === 'Escape') setIsRenaming(false)
                }}
                onBlur={handleRename}
                onClick={(e) => e.stopPropagation()}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full focus:outline-none focus:ring-1 focus:ring-ring"
                data-testid="connection-rename-input"
              />
            ) : (
              <span className="text-sm truncate block" title={connection.path}>
                {connection.name}
              </span>
            )}
            <div className="flex items-center gap-1">
              <span className={cn('text-[11px]', statusClass)} data-testid="connection-status-text">
                {displayStatus}
              </span>
              {projectSubtitle && (
                <>
                  <span className="text-[10px] text-muted-foreground/40">|</span>
                  <span
                    className="text-[10px] text-muted-foreground/60 truncate"
                    title={projectSubtitle}
                  >
                    {projectSubtitle}
                  </span>
                </>
              )}
            </div>
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
              <DropdownMenuItem onClick={startRename}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleAddWorktree}>
                <Plus className="h-4 w-4 mr-2" />
                Add Worktree
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
