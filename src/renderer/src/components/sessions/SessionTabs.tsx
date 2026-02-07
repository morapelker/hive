import { useEffect, useRef, useState, useCallback } from 'react'
import { Plus, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

interface SessionTabProps {
  sessionId: string
  name: string
  isActive: boolean
  onClick: () => void
  onClose: (e: React.MouseEvent) => void
  onMiddleClick: (e: React.MouseEvent) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  isDragging: boolean
  isDragOver: boolean
}

function SessionTab({
  sessionId,
  name,
  isActive,
  onClick,
  onClose,
  onMiddleClick,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
  isDragOver
}: SessionTabProps): React.JSX.Element {
  return (
    <div
      data-testid={`session-tab-${sessionId}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onClick}
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
      <span className="truncate flex-1">{name || 'Untitled'}</span>
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
      {isActive && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
      )}
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
    loadSessions,
    createSession,
    closeSession,
    setActiveSession,
    reorderTabs
  } = useSessionStore()

  const { selectedWorktreeId } = useWorktreeStore()
  const { projects } = useProjectStore()

  // Get the worktree and project info for the selected worktree
  const selectedWorktree = useWorktreeStore((state) => {
    if (!selectedWorktreeId) return null
    for (const worktrees of state.worktreesByProject.values()) {
      const found = worktrees.find(w => w.id === selectedWorktreeId)
      if (found) return found
    }
    return null
  })

  const project = selectedWorktree
    ? projects.find(p => p.id === selectedWorktree.project_id)
    : null

  // Sync active worktree with selected worktree
  useEffect(() => {
    if (selectedWorktreeId !== activeWorktreeId) {
      useSessionStore.getState().setActiveWorktree(selectedWorktreeId)
    }
  }, [selectedWorktreeId, activeWorktreeId])

  // Load sessions when worktree changes
  useEffect(() => {
    if (selectedWorktreeId && project) {
      loadSessions(selectedWorktreeId, project.id)
    }
  }, [selectedWorktreeId, project, loadSessions])

  // Check for tab overflow and update arrow visibility
  const checkOverflow = useCallback(() => {
    const container = tabsContainerRef.current
    if (!container) return

    setShowLeftArrow(container.scrollLeft > 0)
    setShowRightArrow(
      container.scrollLeft < container.scrollWidth - container.clientWidth - 1
    )
  }, [])

  useEffect(() => {
    checkOverflow()
    const container = tabsContainerRef.current
    if (container) {
      container.addEventListener('scroll', checkOverflow)
      window.addEventListener('resize', checkOverflow)
      return () => {
        container.removeEventListener('scroll', checkOverflow)
        window.removeEventListener('resize', checkOverflow)
      }
    }
  }, [checkOverflow, sessionsByWorktree, tabOrderByWorktree])

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
    if (!selectedWorktreeId || !project) return

    const result = await createSession(selectedWorktreeId, project.id)
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
    if (!draggedTabId || !selectedWorktreeId || draggedTabId === targetSessionId) {
      return
    }

    const tabOrder = tabOrderByWorktree.get(selectedWorktreeId) || []
    const fromIndex = tabOrder.indexOf(draggedTabId)
    const toIndex = tabOrder.indexOf(targetSessionId)

    if (fromIndex !== -1 && toIndex !== -1) {
      reorderTabs(selectedWorktreeId, fromIndex, toIndex)
    }

    setDraggedTabId(null)
    setDragOverTabId(null)
  }

  const handleDragEnd = () => {
    setDraggedTabId(null)
    setDragOverTabId(null)
  }

  // Don't render if no worktree is selected
  if (!selectedWorktreeId) {
    return null
  }

  const sessions = sessionsByWorktree.get(selectedWorktreeId) || []
  const tabOrder = tabOrderByWorktree.get(selectedWorktreeId) || []

  // Get sessions in tab order
  const orderedSessions = tabOrder
    .map(id => sessions.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)

  return (
    <div
      className="flex items-center border-b border-border bg-muted/30"
      data-testid="session-tabs"
    >
      {/* New session button - on the left */}
      <button
        onClick={handleCreateSession}
        className="p-1.5 hover:bg-accent transition-colors shrink-0 border-r border-border"
        data-testid="create-session"
        title="Create new session"
      >
        <Plus className="h-4 w-4" />
      </button>

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
        {orderedSessions.length === 0 ? (
          <div
            className="flex items-center px-3 py-1.5 text-sm text-muted-foreground"
            data-testid="no-sessions"
          >
            No sessions yet. Click + to create one.
          </div>
        ) : (
          orderedSessions.map((session) => (
            <SessionTab
              key={session.id}
              sessionId={session.id}
              name={session.name || 'Untitled'}
              isActive={session.id === activeSessionId}
              onClick={() => setActiveSession(session.id)}
              onClose={(e) => handleCloseSession(e, session.id)}
              onMiddleClick={(e) => handleCloseSession(e, session.id)}
              onDragStart={(e) => handleDragStart(e, session.id)}
              onDragOver={(e) => handleDragOver(e, session.id)}
              onDrop={(e) => handleDrop(e, session.id)}
              onDragEnd={handleDragEnd}
              isDragging={draggedTabId === session.id}
              isDragOver={dragOverTabId === session.id}
            />
          ))
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
