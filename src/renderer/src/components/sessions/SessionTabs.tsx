import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type KeyboardEvent
} from 'react'
import {
  Plus,
  X,
  ChevronLeft,
  ChevronRight,
  FileCode,
  FileText,
  GitCompareArrows,
  Loader2,
  AlertCircle,
  Check,
  TerminalSquare
} from 'lucide-react'
import { useSessionStore } from '@/stores/useSessionStore'
import {
  useFileViewerStore,
  type FileViewerTab,
  type DiffTab,
  type ContextTab
} from '@/stores/useFileViewerStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { cn, parseColorQuad } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

interface SessionTabProps {
  sessionId: string
  name: string
  isActive: boolean
  agentSdk: 'opencode' | 'claude-code' | 'terminal'
  onClick: () => void
  onClose: (e: React.MouseEvent) => void
  onMiddleClick: (e: React.MouseEvent) => void
  onRename: (newName: string) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  isDragging: boolean
  isDragOver: boolean
  worktreeId: string
  onCloseOthers: () => void
  onCloseToRight: () => void
}

function SessionTab({
  sessionId,
  name,
  isActive,
  agentSdk,
  onClick,
  onClose,
  onMiddleClick,
  onRename,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
  isDragOver,
  worktreeId: _worktreeId,
  onCloseOthers,
  onCloseToRight
}: SessionTabProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  const sessionStatus = useWorktreeStatusStore(
    (state) => state.sessionStatuses[sessionId]?.status ?? null
  )

  // Focus and select input text when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditName(name)
    setIsEditing(true)
  }

  const handleSave = () => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== name) {
      onRename(trimmed)
    }
    setIsEditing(false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditName(name)
      setIsEditing(false)
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid={`session-tab-${sessionId}`}
          draggable={!isEditing}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
          onClick={isEditing ? undefined : onClick}
          onDoubleClick={handleDoubleClick}
          onMouseDown={(e) => {
            // Middle click to close
            if (e.button === 1) {
              onMiddleClick(e)
            }
          }}
          className={cn(
            'group relative flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer select-none',
            'border-r border-border transition-colors min-w-[100px] max-w-[200px]',
            isActive
              ? 'bg-background text-foreground'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
            isDragging && 'opacity-50',
            isDragOver && 'bg-accent/50'
          )}
        >
          {agentSdk === 'terminal' ? (
            <TerminalSquare
              className="h-3 w-3 text-emerald-500 flex-shrink-0"
              data-testid={`tab-terminal-${sessionId}`}
            />
          ) : (
            <>
              {(sessionStatus === 'working' || sessionStatus === 'planning') && (
                <Loader2
                  className={cn(
                    'h-3 w-3 animate-spin flex-shrink-0',
                    sessionStatus === 'planning' ? 'text-blue-400' : 'text-blue-500'
                  )}
                  data-testid={`tab-spinner-${sessionId}`}
                />
              )}
              {(sessionStatus === 'answering' || sessionStatus === 'permission') && (
                <AlertCircle
                  className="h-3 w-3 text-amber-500 flex-shrink-0"
                  data-testid={`tab-${sessionStatus === 'permission' ? 'permission' : 'answering'}-${sessionId}`}
                />
              )}
              {sessionStatus === 'completed' && (
                <Check
                  className="h-3 w-3 text-green-500 flex-shrink-0"
                  data-testid={`tab-completed-${sessionId}`}
                />
              )}
              {sessionStatus === 'unread' && !isActive && (
                <span
                  className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0"
                  data-testid={`tab-unread-${sessionId}`}
                />
              )}
            </>
          )}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              className="flex-1 min-w-0 bg-transparent border border-primary/50 rounded px-1 py-0 text-sm outline-none"
              data-testid={`rename-input-${sessionId}`}
            />
          ) : (
            <span className="truncate flex-1">{name || 'Untitled'}</span>
          )}
          <button
            onClick={onClose}
            className={cn(
              'p-0.5 rounded hover:bg-accent transition-opacity',
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
            data-testid={`close-tab-${sessionId}`}
          >
            <X className="h-3 w-3" />
          </button>
          {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={(e) => onClose(e as unknown as React.MouseEvent)}>
          Close
          <ContextMenuShortcut>&#8984;W</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCloseOthers}>Close Others</ContextMenuItem>
        <ContextMenuItem onSelect={onCloseToRight}>Close Others to the Right</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface FileTabProps {
  filePath: string
  name: string
  isActive: boolean
  onClick: () => void
  onClose: (e: React.MouseEvent) => void
  onCloseOthers: () => void
  onCloseToRight: () => void
  relativePath: string
}

function FileTab({
  filePath,
  name,
  isActive,
  onClick,
  onClose,
  onCloseOthers,
  onCloseToRight,
  relativePath
}: FileTabProps): React.JSX.Element {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid={`file-tab-${name}`}
          onClick={onClick}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(e)
            }
          }}
          className={cn(
            'group relative flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer select-none',
            'border-r border-border transition-colors min-w-[100px] max-w-[200px]',
            isActive
              ? 'bg-background text-foreground'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
          title={filePath}
        >
          <FileCode className="h-3.5 w-3.5 flex-shrink-0 text-blue-400" />
          <span className="truncate flex-1">{name}</span>
          <button
            onClick={onClose}
            className={cn(
              'p-0.5 rounded hover:bg-accent transition-opacity',
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
            data-testid={`close-file-tab-${name}`}
          >
            <X className="h-3 w-3" />
          </button>
          {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={(e) => onClose(e as unknown as React.MouseEvent)}>
          Close
          <ContextMenuShortcut>&#8984;W</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCloseOthers}>Close Others</ContextMenuItem>
        <ContextMenuItem onSelect={onCloseToRight}>Close Others to the Right</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copyToClipboard(relativePath)}>
          Copy Relative Path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copyToClipboard(filePath)}>
          Copy Absolute Path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text)
  toast.success('Copied to clipboard')
}

interface DiffTabItemProps {
  tabKey: string
  tab: DiffTab
  isActive: boolean
  onActivate: () => void
  onClose: (e: React.MouseEvent) => void
  onCloseOthers: () => void
  onCloseToRight: () => void
}

function DiffTabItem({
  tabKey,
  tab,
  isActive,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight
}: DiffTabItemProps): React.JSX.Element {
  const absolutePath = `${tab.worktreePath}/${tab.filePath}`

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid={`diff-tab-${tab.fileName}`}
          onClick={onActivate}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(e)
            }
          }}
          className={cn(
            'group relative flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer select-none',
            'border-r border-border transition-colors min-w-[100px] max-w-[200px]',
            isActive
              ? 'bg-background text-foreground'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
          title={`${tab.filePath} (${tab.staged ? 'staged' : 'unstaged'})`}
        >
          <GitCompareArrows className="h-3.5 w-3.5 flex-shrink-0 text-orange-400" />
          <span className="truncate flex-1">{tab.fileName}</span>
          {tab.staged && <span className="text-[10px] text-green-500 font-medium shrink-0">S</span>}
          <button
            onClick={onClose}
            className={cn(
              'p-0.5 rounded hover:bg-accent transition-opacity',
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
            data-testid={`close-diff-tab-${tabKey}`}
          >
            <X className="h-3 w-3" />
          </button>
          {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={(e) => onClose(e as unknown as React.MouseEvent)}>
          Close
          <ContextMenuShortcut>&#8984;W</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCloseOthers}>Close Others</ContextMenuItem>
        <ContextMenuItem onSelect={onCloseToRight}>Close Others to the Right</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copyToClipboard(tab.filePath)}>
          Copy Relative Path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copyToClipboard(absolutePath)}>
          Copy Absolute Path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// Sticky connection session tab — simplified, non-closable, non-draggable
interface ConnectionSessionTabProps {
  sessionId: string
  name: string
  isActive: boolean
  onClick: () => void
  connectionColor: string | null
  connectionName: string
}

function ConnectionSessionTab({
  sessionId,
  name,
  isActive,
  onClick,
  connectionColor,
  connectionName
}: ConnectionSessionTabProps): React.JSX.Element {
  const sessionStatus = useWorktreeStatusStore(
    (state) => state.sessionStatuses[sessionId]?.status ?? null
  )

  const [inactiveBg, activeBg, inactiveText, activeText] = parseColorQuad(connectionColor)

  return (
    <div
      data-testid={`connection-session-tab-${sessionId}`}
      role="tab"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
      title={`${connectionName} — ${name || 'Untitled'}`}
      className={cn(
        'group relative flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer select-none',
        'border-r border-border/50 transition-colors min-w-[100px] max-w-[200px]'
      )}
      style={{
        backgroundColor: isActive ? activeBg : inactiveBg,
        color: isActive ? activeText : inactiveText
      }}
    >
      {/* Status indicators */}
      {(sessionStatus === 'working' || sessionStatus === 'planning') && (
        <Loader2
          className="h-3 w-3 animate-spin flex-shrink-0"
          style={{ color: isActive ? activeText : undefined }}
        />
      )}
      {(sessionStatus === 'answering' || sessionStatus === 'permission') && (
        <AlertCircle
          className="h-3 w-3 flex-shrink-0"
          style={{ color: isActive ? activeText : undefined }}
        />
      )}
      {sessionStatus === 'completed' && (
        <Check
          className="h-3 w-3 flex-shrink-0"
          style={{ color: isActive ? activeText : undefined }}
        />
      )}
      {sessionStatus === 'unread' && !isActive && (
        <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
      )}

      <span className="truncate flex-1">{name || 'Untitled'}</span>
    </div>
  )
}

export function SessionTabs(): React.JSX.Element | null {
  const tabsContainerRef = useRef<HTMLDivElement>(null)
  const [showLeftArrow, setShowLeftArrow] = useState(false)
  const [showRightArrow, setShowRightArrow] = useState(false)
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null)

  const {
    activeWorktreeId,
    activeSessionId,
    sessionsByWorktree,
    tabOrderByWorktree,
    sessionsByConnection,
    tabOrderByConnection,
    loadSessions,
    createSession,
    closeSession,
    setActiveSession,
    reorderTabs,
    updateSessionName,
    closeOtherSessions,
    closeSessionsToRight,
    loadConnectionSessions,
    createConnectionSession,
    setActiveConnectionSession,
    reorderConnectionTabs,
    closeOtherConnectionSessions,
    closeConnectionSessionsToRight,
    inlineConnectionSessionId,
    setInlineConnectionSession,
    clearInlineConnectionSession,
    loadConnectionSessionsBackground
  } = useSessionStore()

  const {
    openFiles,
    activeFilePath,
    setActiveFile,
    closeFile,
    closeOtherFiles,
    closeFilesToRight
  } = useFileViewerStore()

  const { selectedWorktreeId } = useWorktreeStore()
  const { projects } = useProjectStore()
  const selectedConnectionId = useConnectionStore((state) => state.selectedConnectionId)
  const connections = useConnectionStore((state) => state.connections)
  const setGhosttyOverlaySuppressed = useLayoutStore((state) => state.setGhosttyOverlaySuppressed)

  // Determine whether we are in connection mode or worktree mode
  const isConnectionMode = !!selectedConnectionId && !selectedWorktreeId

  // Get the worktree and project info for the selected worktree
  const selectedWorktree = useWorktreeStore((state) => {
    if (!selectedWorktreeId) return null
    for (const worktrees of state.worktreesByProject.values()) {
      const found = worktrees.find((w) => w.id === selectedWorktreeId)
      if (found) return found
    }
    return null
  })

  const project = selectedWorktree
    ? projects.find((p) => p.id === selectedWorktree.project_id)
    : null

  // Sync active worktree with selected worktree (worktree mode only)
  useEffect(() => {
    if (isConnectionMode) return
    if (selectedWorktreeId !== activeWorktreeId) {
      useSessionStore.getState().setActiveWorktree(selectedWorktreeId)
    }
  }, [selectedWorktreeId, activeWorktreeId, isConnectionMode])

  // Sync active connection with selected connection (connection mode only)
  useEffect(() => {
    if (!isConnectionMode || !selectedConnectionId) return
    useSessionStore.getState().setActiveConnection(selectedConnectionId)
  }, [selectedConnectionId, isConnectionMode])

  // Load sessions when worktree changes, then auto-start if the worktree has 0 sessions.
  // Auto-start runs as a direct follow-up to loadSessions (not a separate effect) to
  // eliminate race conditions between the two async operations.
  const autoStartSession = useSettingsStore((state) => state.autoStartSession)
  const availableAgentSdks = useSettingsStore((state) => state.availableAgentSdks)
  const autoStartedRef = useRef<string | null>(null)

  useEffect(() => {
    if (isConnectionMode) return
    if (!selectedWorktreeId || !project) return

    let cancelled = false

    void (async () => {
      await loadSessions(selectedWorktreeId, project.id)
      if (cancelled) return

      // After sessions are loaded, check if auto-start is needed
      if (!autoStartSession) return
      if (autoStartedRef.current === selectedWorktreeId) return

      const sessions = useSessionStore.getState().sessionsByWorktree.get(selectedWorktreeId) || []
      if (sessions.length > 0) return

      autoStartedRef.current = selectedWorktreeId
      await createSession(selectedWorktreeId, project.id)
    })()

    return () => {
      cancelled = true
    }
  }, [selectedWorktreeId, project, loadSessions, autoStartSession, createSession, isConnectionMode])

  // Load sessions when connection changes (connection mode)
  useEffect(() => {
    if (!isConnectionMode || !selectedConnectionId) return

    let cancelled = false

    void (async () => {
      await loadConnectionSessions(selectedConnectionId)
      if (cancelled) return

      // Auto-start a session if auto-start is enabled and no sessions exist
      if (!autoStartSession) return
      if (autoStartedRef.current === selectedConnectionId) return

      const sessions =
        useSessionStore.getState().sessionsByConnection.get(selectedConnectionId) || []
      if (sessions.length > 0) return

      autoStartedRef.current = selectedConnectionId
      await createConnectionSession(selectedConnectionId)
    })()

    return () => {
      cancelled = true
    }
  }, [
    selectedConnectionId,
    isConnectionMode,
    loadConnectionSessions,
    autoStartSession,
    createConnectionSession
  ])

  // Connections that include the currently selected worktree (for sticky tabs)
  const connectionsForWorktree = useMemo(() => {
    if (!selectedWorktreeId || isConnectionMode) return []
    return connections.filter((c) => c.members.some((m) => m.worktree_id === selectedWorktreeId))
  }, [connections, selectedWorktreeId, isConnectionMode])

  // Track which connection IDs have already been background-loaded for the current worktree.
  const loadedConnectionsRef = useRef<Set<string>>(new Set())

  // Reset loaded set when the selected worktree changes
  useEffect(() => {
    loadedConnectionsRef.current.clear()
  }, [selectedWorktreeId])

  // Background-load sessions for all connections the selected worktree belongs to.
  // This is non-blocking and does not enter connection mode.
  useEffect(() => {
    if (isConnectionMode || !selectedWorktreeId || connectionsForWorktree.length === 0) return
    for (const connection of connectionsForWorktree) {
      if (!loadedConnectionsRef.current.has(connection.id)) {
        loadedConnectionsRef.current.add(connection.id)
        loadConnectionSessionsBackground(connection.id)
      }
    }
  }, [
    selectedWorktreeId,
    connectionsForWorktree,
    isConnectionMode,
    loadConnectionSessionsBackground
  ])

  // Check for tab overflow and update arrow visibility
  const checkOverflow = useCallback(() => {
    const container = tabsContainerRef.current
    if (!container) return

    setShowLeftArrow(container.scrollLeft > 0)
    setShowRightArrow(container.scrollLeft < container.scrollWidth - container.clientWidth - 1)
  }, [])

  useEffect(() => {
    checkOverflow()
    const container = tabsContainerRef.current
    if (!container) return

    container.addEventListener('scroll', checkOverflow)
    window.addEventListener('resize', checkOverflow)
    return () => {
      container.removeEventListener('scroll', checkOverflow)
      window.removeEventListener('resize', checkOverflow)
    }
  }, [
    checkOverflow,
    sessionsByWorktree,
    tabOrderByWorktree,
    sessionsByConnection,
    tabOrderByConnection,
    openFiles
  ])

  // Safety: never leave Ghostty overlays suppressed if this component unmounts.
  useEffect(() => {
    return () => {
      setGhosttyOverlaySuppressed(false)
    }
  }, [setGhosttyOverlaySuppressed])

  // Scroll functions
  const scrollLeft = () => {
    const container = tabsContainerRef.current
    if (container) {
      container.scrollBy({ left: -150, behavior: 'smooth' })
    }
  }

  const scrollRight = () => {
    const container = tabsContainerRef.current
    if (container) {
      container.scrollBy({ left: 150, behavior: 'smooth' })
    }
  }

  // Handle creating a new session
  const handleCreateSession = async () => {
    if (isConnectionMode && selectedConnectionId) {
      const result = await createConnectionSession(selectedConnectionId)
      if (!result.success) {
        toast.error(result.error || 'Failed to create session')
      }
      return
    }

    if (!selectedWorktreeId || !project) return

    const result = await createSession(selectedWorktreeId, project.id)
    if (!result.success) {
      toast.error(result.error || 'Failed to create session')
    }
  }

  // Handle creating a new session with a specific agent SDK (from context menu)
  const handleCreateSessionWithSdk = async (sdk: 'opencode' | 'claude-code' | 'terminal') => {
    if (isConnectionMode && selectedConnectionId) {
      const result = await createConnectionSession(selectedConnectionId, sdk)
      if (!result.success) {
        toast.error(result.error || 'Failed to create session')
      }
      return
    }

    if (!selectedWorktreeId || !project) return

    const result = await createSession(selectedWorktreeId, project.id, sdk)
    if (!result.success) {
      toast.error(result.error || 'Failed to create session')
    }
  }

  // Handle closing a session
  const handleCloseSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    const result = await closeSession(sessionId)
    if (!result.success) {
      toast.error(result.error || 'Failed to close session')
    }
  }

  // Handle renaming a session tab
  const handleRenameSession = async (sessionId: string, newName: string) => {
    const success = await updateSessionName(sessionId, newName)
    if (!success) {
      toast.error('Failed to rename session')
    }
  }

  // Handle clicking a session tab - deactivate file tab and clear unread status
  const handleSessionTabClick = (sessionId: string) => {
    setActiveFile(null)
    clearInlineConnectionSession()
    if (isConnectionMode) {
      setActiveConnectionSession(sessionId)
    } else {
      setActiveSession(sessionId)
    }
    useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
  }

  // Handle clicking a sticky connection session tab (inline viewing in worktree mode)
  const handleConnectionSessionTabClick = (sessionId: string) => {
    setActiveFile(null)
    setInlineConnectionSession(sessionId)
    useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
  }

  // Handle clicking a file tab - keep session but activate file view
  const handleFileTabClick = (filePath: string) => {
    setActiveFile(filePath)
  }

  // Handle closing a file tab
  const handleCloseFileTab = (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation()
    closeFile(filePath)
  }

  // Handle clicking a diff tab - restore activeDiff for the viewer
  const handleDiffTabClick = (tabKey: string) => {
    useFileViewerStore.getState().activateDiffTab(tabKey)
  }

  // Handle closing a diff tab
  const handleCloseDiffTab = (e: React.MouseEvent, tabKey: string) => {
    e.stopPropagation()
    useFileViewerStore.getState().closeDiffTab(tabKey)
  }

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    setDraggedTabId(sessionId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', sessionId)
  }

  const handleDragOver = (e: React.DragEvent, sessionId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (draggedTabId && draggedTabId !== sessionId) {
      setDragOverTabId(sessionId)
    }
  }

  const handleDrop = (e: React.DragEvent, targetSessionId: string) => {
    e.preventDefault()
    if (!draggedTabId || draggedTabId === targetSessionId) {
      return
    }

    if (isConnectionMode && selectedConnectionId) {
      const tabOrder = tabOrderByConnection.get(selectedConnectionId) || []
      const fromIndex = tabOrder.indexOf(draggedTabId)
      const toIndex = tabOrder.indexOf(targetSessionId)

      if (fromIndex !== -1 && toIndex !== -1) {
        reorderConnectionTabs(selectedConnectionId, fromIndex, toIndex)
      }
    } else if (selectedWorktreeId) {
      const tabOrder = tabOrderByWorktree.get(selectedWorktreeId) || []
      const fromIndex = tabOrder.indexOf(draggedTabId)
      const toIndex = tabOrder.indexOf(targetSessionId)

      if (fromIndex !== -1 && toIndex !== -1) {
        reorderTabs(selectedWorktreeId, fromIndex, toIndex)
      }
    }

    setDraggedTabId(null)
    setDragOverTabId(null)
  }

  const handleDragEnd = () => {
    setDraggedTabId(null)
    setDragOverTabId(null)
  }

  // Don't render if nothing is selected
  if (!selectedWorktreeId && !selectedConnectionId) {
    return null
  }

  // Resolve scope ID for the active context
  const scopeId = isConnectionMode ? selectedConnectionId! : selectedWorktreeId!

  const sessions = isConnectionMode
    ? sessionsByConnection.get(scopeId) || []
    : sessionsByWorktree.get(scopeId) || []
  const tabOrder = isConnectionMode
    ? tabOrderByConnection.get(scopeId) || []
    : tabOrderByWorktree.get(scopeId) || []

  // Get sessions in tab order
  const orderedSessions = tabOrder
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)

  // Get file tabs for the current worktree (only regular file tabs, not diff tabs)
  const fileTabs = Array.from(openFiles.values()).filter(
    (f): f is FileViewerTab => f.type === 'file' && f.worktreeId === selectedWorktreeId
  )

  // Get diff tabs from openFiles
  const diffTabs = Array.from(openFiles.entries()).filter(
    (entry): entry is [string, DiffTab] => entry[1].type === 'diff'
  )

  // Get context tabs from openFiles
  const contextTabs = Array.from(openFiles.entries()).filter(
    (entry): entry is [string, ContextTab] => entry[1].type === 'context'
  )

  // Determine if a file/diff tab is the active one
  const isFileTabActive = activeFilePath !== null

  return (
    <div
      className="flex items-center border-b border-border bg-muted/30"
      data-testid="session-tabs"
    >
      {/* New session button - on the left */}
      {/* Right-click shows provider menu with session type options */}
      <ContextMenu onOpenChange={setGhosttyOverlaySuppressed}>
        <ContextMenuTrigger asChild>
          <button
            onClick={handleCreateSession}
            className="p-1.5 hover:bg-accent transition-colors shrink-0 border-r border-border"
            data-testid="create-session"
            title="Create new session (right-click for options)"
          >
            <Plus className="h-4 w-4" />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="z-[2147483647]">
          {availableAgentSdks?.opencode && (
            <ContextMenuItem onSelect={() => handleCreateSessionWithSdk('opencode')}>
              New OpenCode Session
            </ContextMenuItem>
          )}
          {availableAgentSdks?.claude && (
            <ContextMenuItem onSelect={() => handleCreateSessionWithSdk('claude-code')}>
              New Claude Code Session
            </ContextMenuItem>
          )}
          {(availableAgentSdks?.opencode || availableAgentSdks?.claude) && <ContextMenuSeparator />}
          <ContextMenuItem onSelect={() => handleCreateSessionWithSdk('terminal')}>
            <TerminalSquare className="h-4 w-4 mr-2 text-emerald-500" />
            New Terminal
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Left scroll arrow */}
      {showLeftArrow && (
        <button
          onClick={scrollLeft}
          className="p-1 hover:bg-accent transition-colors shrink-0"
          data-testid="scroll-left"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}

      {/* Tabs container */}
      <div
        ref={tabsContainerRef}
        className="flex-1 flex overflow-x-auto scrollbar-hide"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {orderedSessions.length === 0 &&
        fileTabs.length === 0 &&
        diffTabs.length === 0 &&
        contextTabs.length === 0 &&
        !(
          !isConnectionMode &&
          connectionsForWorktree.some((c) => (sessionsByConnection.get(c.id) || []).length > 0)
        ) ? (
          <div
            className="flex items-center px-3 py-1.5 text-sm text-muted-foreground"
            data-testid="no-sessions"
          >
            No sessions yet. Click + to create one.
          </div>
        ) : (
          <>
            {/* Sticky connection session tabs (worktree mode only) */}
            {!isConnectionMode &&
              connectionsForWorktree.map((connection) => {
                const connectionSessions = sessionsByConnection.get(connection.id) || []
                const connectionTabOrder = tabOrderByConnection.get(connection.id) || []
                const orderedConnectionSessions = connectionTabOrder
                  .map((id) => connectionSessions.find((s) => s.id === id))
                  .filter((s): s is NonNullable<typeof s> => s !== undefined)

                if (orderedConnectionSessions.length === 0) return null

                return (
                  <Fragment key={connection.id}>
                    {/* Thin visual separator before each connection group */}
                    <div className="w-px bg-border/60 self-stretch my-1" aria-hidden="true" />
                    {orderedConnectionSessions.map((session) => (
                      <ConnectionSessionTab
                        key={session.id}
                        sessionId={session.id}
                        name={session.name || 'Untitled'}
                        isActive={session.id === inlineConnectionSessionId && !isFileTabActive}
                        onClick={() => handleConnectionSessionTabClick(session.id)}
                        connectionColor={connection.color}
                        connectionName={connection.name}
                      />
                    ))}
                  </Fragment>
                )
              })}

            {/* Session tabs */}
            {orderedSessions.map((session) => (
              <SessionTab
                key={session.id}
                sessionId={session.id}
                name={session.name || 'Untitled'}
                agentSdk={session.agent_sdk}
                isActive={
                  session.id === activeSessionId && !isFileTabActive && !inlineConnectionSessionId
                }
                onClick={() => handleSessionTabClick(session.id)}
                onClose={(e) => handleCloseSession(e, session.id)}
                onMiddleClick={(e) => handleCloseSession(e, session.id)}
                onRename={(newName) => handleRenameSession(session.id, newName)}
                onDragStart={(e) => handleDragStart(e, session.id)}
                onDragOver={(e) => handleDragOver(e, session.id)}
                onDrop={(e) => handleDrop(e, session.id)}
                onDragEnd={handleDragEnd}
                isDragging={draggedTabId === session.id}
                isDragOver={dragOverTabId === session.id}
                worktreeId={scopeId}
                onCloseOthers={() =>
                  isConnectionMode
                    ? closeOtherConnectionSessions(scopeId, session.id)
                    : closeOtherSessions(scopeId, session.id)
                }
                onCloseToRight={() =>
                  isConnectionMode
                    ? closeConnectionSessionsToRight(scopeId, session.id)
                    : closeSessionsToRight(scopeId, session.id)
                }
              />
            ))}
            {/* File viewer tabs */}
            {fileTabs.map((file) => {
              const worktreePath = selectedWorktree?.path || ''
              const relativePath =
                worktreePath && file.path.startsWith(worktreePath)
                  ? file.path.slice(worktreePath.length + 1)
                  : file.name
              return (
                <FileTab
                  key={file.path}
                  filePath={file.path}
                  name={file.name}
                  isActive={isFileTabActive && activeFilePath === file.path}
                  onClick={() => handleFileTabClick(file.path)}
                  onClose={(e) => handleCloseFileTab(e, file.path)}
                  onCloseOthers={() => closeOtherFiles(file.path)}
                  onCloseToRight={() => closeFilesToRight(file.path)}
                  relativePath={relativePath}
                />
              )
            })}
            {/* Diff viewer tabs */}
            {diffTabs.map(([key, tab]) => (
              <DiffTabItem
                key={key}
                tabKey={key}
                tab={tab}
                isActive={isFileTabActive && activeFilePath === key}
                onActivate={() => handleDiffTabClick(key)}
                onClose={(e) => handleCloseDiffTab(e, key)}
                onCloseOthers={() => closeOtherFiles(key)}
                onCloseToRight={() => closeFilesToRight(key)}
              />
            ))}
            {/* Context editor tabs */}
            {contextTabs.map(([key, tab]) => (
              <div
                key={key}
                data-testid={`context-tab-${tab.worktreeId}`}
                onClick={() => {
                  setActiveFile(key)
                  // Restore the context editor state
                  useFileViewerStore.getState().openContextEditor(tab.worktreeId)
                }}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    useFileViewerStore.getState().closeContextEditor()
                  }
                }}
                className={cn(
                  'group relative flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer select-none',
                  'border-r border-border transition-colors min-w-[100px] max-w-[200px]',
                  isFileTabActive && activeFilePath === key
                    ? 'bg-background text-foreground'
                    : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
                title="Worktree Context"
              >
                <FileText className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
                <span className="truncate flex-1">Context</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    useFileViewerStore.getState().closeContextEditor()
                  }}
                  className={cn(
                    'p-0.5 rounded hover:bg-accent transition-opacity',
                    isFileTabActive && activeFilePath === key
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100'
                  )}
                >
                  <X className="h-3 w-3" />
                </button>
                {isFileTabActive && activeFilePath === key && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {/* Right scroll arrow */}
      {showRightArrow && (
        <button
          onClick={scrollRight}
          className="p-1 hover:bg-accent transition-colors shrink-0"
          data-testid="scroll-right"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
