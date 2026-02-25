import { useCallback, useEffect, useState, useRef } from 'react'
import {
  AlertCircle,
  Archive,
  Code,
  Copy,
  ExternalLink,
  Figma,
  GitBranchPlus,
  Link,
  Loader2,
  Map as MapIcon,
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
  usePinnedStore
} from '@/stores'
import { useScriptStore } from '@/stores/useScriptStore'
import { useGitStore } from '@/stores/useGitStore'
import { toast, gitToast, clipboardToast } from '@/lib/toast'
import { formatRelativeTime } from '@/lib/format-utils'
import { ModelIcon } from '@/components/worktrees/ModelIcon'
import { PulseAnimation } from '@/components/worktrees/PulseAnimation'
import { LanguageIcon } from '@/components/projects/LanguageIcon'
import { ArchiveConfirmDialog } from '@/components/worktrees/ArchiveConfirmDialog'
import { AddAttachmentDialog } from '@/components/worktrees/AddAttachmentDialog'
import { ManageConnectionWorktreesDialog } from '@/components/connections/ManageConnectionWorktreesDialog'

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

  useEffect(() => {
    if (isRenamingBranch && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenamingBranch])

  const handleOpenAttachment = useCallback(async (url: string): Promise<void> => {
    await window.systemOps.openInChrome(url)
  }, [])

  const handleDetachAttachment = useCallback(
    async (attachmentId: string): Promise<void> => {
      const result = await window.db.worktree.removeAttachment(worktreeId, attachmentId)
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
    window.db.worktree.get(worktreeId).then((w) => {
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
    setBranchNameInput(worktree.branch_name)
    setIsRenamingBranch(true)
  }, [worktree])

  const handleBranchRename = useCallback(async (): Promise<void> => {
    if (!worktree) return
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

    const result = await window.worktreeOps.renameBranch(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      newBranch
    )

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
      const result = await window.gitOps.getDiffStat(worktree.path)
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
      gitToast.worktreeUnbranched(worktree.name)
    } else {
      gitToast.operationFailed('unbranch worktree', result.error, handleUnbranch)
    }
  }, [unbranchWorktree, worktree, project])

  if (!worktree || !project) return null

  const displayBranch = liveBranch?.name ?? worktree.name

  // Derive display status text + color
  const { displayStatus, statusClass } =
    worktreeStatus === 'answering'
      ? { displayStatus: 'Answer questions', statusClass: 'font-semibold text-amber-500' }
      : worktreeStatus === 'permission'
        ? { displayStatus: 'Permission', statusClass: 'font-semibold text-amber-500' }
        : worktreeStatus === 'planning'
          ? { displayStatus: 'Planning', statusClass: 'font-semibold text-blue-400' }
          : worktreeStatus === 'working'
            ? { displayStatus: 'Working', statusClass: 'font-semibold text-primary' }
            : worktreeStatus === 'plan_ready'
              ? { displayStatus: 'Plan ready', statusClass: 'font-semibold text-blue-400' }
              : worktreeStatus === 'completed'
                ? { displayStatus: 'Ready', statusClass: 'font-semibold text-green-400' }
                : { displayStatus: 'Ready', statusClass: 'text-muted-foreground' }

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
    const result = await window.worktreeOps.openInTerminal(worktree.path)
    if (result.success) {
      toast.success('Opened in Terminal')
    } else {
      toast.error(result.error || 'Failed to open in terminal', {
        description: 'Make sure the worktree directory exists'
      })
    }
  }

  const handleOpenInEditor = async (): Promise<void> => {
    const result = await window.worktreeOps.openInEditor(worktree.path)
    if (result.success) {
      toast.success('Opened in Editor')
    } else {
      toast.error(result.error || 'Failed to open in editor', {
        description: 'Make sure VS Code is installed'
      })
    }
  }

  const handleOpenInFinder = async (): Promise<void> => {
    await window.projectOps.showInFolder(worktree.path)
  }

  const handleCopyPath = async (): Promise<void> => {
    await window.projectOps.copyToClipboard(worktree.path)
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
        Open in Finder
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
      )}
    </>
  )
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer',
            'transition-colors mx-1',
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
            {isRenamingBranch ? (
              <input
                ref={renameInputRef}
                value={branchNameInput}
                onChange={(e) => setBranchNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleBranchRename()
                  if (e.key === 'Escape') setIsRenamingBranch(false)
                }}
                onBlur={() => setIsRenamingBranch(false)}
                onClick={(e) => e.stopPropagation()}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full focus:outline-none focus:ring-1 focus:ring-ring"
                data-testid="branch-rename-input"
              />
            ) : (
              <span className="text-sm truncate block" title={worktree.path}>
                {project.name} <span className="text-muted-foreground">›</span> {displayBranch}
              </span>
            )}
            <div className="flex items-center pr-1">
              <ModelIcon worktreeId={worktreeId} className="h-2.5 w-2.5 mr-1 shrink-0" />
              <span
                className={cn('text-[11px]', statusClass)}
                data-testid="pinned-status-text"
              >
                {displayStatus}
              </span>
              <span className="flex-1" />
              {lastMessageTime && (
                <span
                  className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0"
                  title={new Date(lastMessageTime).toLocaleString()}
                  data-testid="pinned-last-message-time"
                >
                  {formatRelativeTime(lastMessageTime)}
                </span>
              )}
            </div>
          </div>

          {worktreeStatus === 'unread' && (
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

  const connection = useConnectionStore((s) =>
    s.connections.find((c) => c.id === connectionId)
  )

  // Inline rename state
  const [isRenaming, setIsRenaming] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Manage worktrees dialog state
  const [manageConnectionId, setManageConnectionId] = useState<string | null>(null)

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

  const handleStartRename = useCallback((): void => {
    if (!connection) return
    setNameInput(connection.custom_name || '')
    setIsRenaming(true)
  }, [connection])

  const handleSaveRename = useCallback(async (): Promise<void> => {
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
        setIsRenaming(false)
      }
    },
    [handleSaveRename]
  )

  const handleOpenInTerminal = useCallback(async (): Promise<void> => {
    if (!connection) return
    const result = await window.connectionOps.openInTerminal(connection.path)
    if (result.success) {
      toast.success('Opened in Terminal')
    } else {
      toast.error(result.error || 'Failed to open in terminal')
    }
  }, [connection])

  const handleOpenInEditor = useCallback(async (): Promise<void> => {
    if (!connection) return
    const result = await window.connectionOps.openInEditor(connection.path)
    if (result.success) {
      toast.success('Opened in Editor')
    } else {
      toast.error(result.error || 'Failed to open in editor')
    }
  }, [connection])

  const handleOpenInFinder = useCallback(async (): Promise<void> => {
    if (!connection) return
    await window.projectOps.showInFolder(connection.path)
  }, [connection])

  const handleCopyPath = useCallback(async (): Promise<void> => {
    if (!connection) return
    await window.projectOps.copyToClipboard(connection.path)
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
  const projectNames =
    [
      ...new Set(
        connection.members?.map((m: { project_name: string }) => m.project_name) || []
      )
    ].join(' + ')

  // Display logic: custom name takes priority over project names
  const hasCustomName = !!connection.custom_name
  const displayName = hasCustomName
    ? connection.custom_name!
    : projectNames || connection.name || 'Connection'

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

  const handleClick = (): void => {
    selectConnection(connectionId)
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const connectionMenuItems = (MenuItem: any, MenuSeparator: any): React.JSX.Element => (
    <>
      <MenuItem onClick={handleManageWorktrees}>
        <Settings2 className="h-4 w-4 mr-2" />
        Connection Worktrees
      </MenuItem>
      <MenuItem onClick={handleStartRename}>
        <Pencil className="h-4 w-4 mr-2" />
        Rename
      </MenuItem>
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
        Open in Finder
      </MenuItem>
      <MenuItem onClick={handleCopyPath}>
        <Copy className="h-4 w-4 mr-2" />
        Copy Path
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        onClick={handleDelete}
        className="text-destructive focus:text-destructive focus:bg-destructive/10"
      >
        <Trash2 className="h-4 w-4 mr-2" />
        Delete
      </MenuItem>
    </>
  )
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer',
            'transition-colors mx-1',
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
                <span className="text-sm truncate block" title={displayName}>
                  {displayName}
                </span>
                <span
                  className={cn('text-[11px]', statusClass)}
                  data-testid="pinned-status-text"
                >
                  {displayStatus}
                  {hasCustomName && projectNames && (
                    <span className="text-muted-foreground font-normal">
                      {' '}
                      · {projectNames}
                    </span>
                  )}
                </span>
              </>
            )}
          </div>

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
              {connectionMenuItems(DropdownMenuItem, DropdownMenuSeparator)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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
