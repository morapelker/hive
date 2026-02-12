import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  X,
  Clock,
  Calendar,
  FolderGit2,
  GitBranch,
  Loader2,
  ExternalLink,
  Filter,
  MessageSquare,
  AlertCircle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useSessionHistoryStore, type SessionWithWorktree } from '@/stores/useSessionHistoryStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'

// Debounce hook for search input
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debouncedValue
}

// Format date for display
function formatDate(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return `Today at ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  } else if (diffDays === 1) {
    return `Yesterday at ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  } else if (diffDays < 7) {
    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit'
    })
  } else {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }
}

// Session list item component
interface SessionItemProps {
  session: SessionWithWorktree
  isSelected: boolean
  isOrphaned: boolean
  onSelect: () => void
  onLoad: () => void
}

function SessionItem({
  session,
  isSelected,
  isOrphaned,
  onSelect,
  onLoad
}: SessionItemProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'p-3 border-b border-border cursor-pointer transition-colors',
        'hover:bg-muted/50',
        isSelected && 'bg-muted',
        isOrphaned && 'opacity-60'
      )}
      onClick={onSelect}
      data-testid={`session-item-${session.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {/* Session name */}
          <div className={cn('font-medium text-sm truncate', isOrphaned && 'italic')}>
            {session.name || 'Untitled Session'}
          </div>

          {/* Project and worktree info */}
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            {session.project_name && (
              <span className="flex items-center gap-1">
                <FolderGit2 className="h-3 w-3" />
                <span className="truncate max-w-[120px]">{session.project_name}</span>
              </span>
            )}
            {session.worktree_name && (
              <span className="flex items-center gap-1">
                <GitBranch className="h-3 w-3" />
                <span className="truncate max-w-[100px]">{session.worktree_name}</span>
              </span>
            )}
            {isOrphaned && (
              <span className="text-amber-500 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                Archived
              </span>
            )}
          </div>

          {/* Timestamp */}
          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatDate(session.updated_at)}
          </div>
        </div>

        {/* Load button - visible on hover/selection */}
        <Button
          variant="ghost"
          size="sm"
          className={cn('opacity-0 transition-opacity', isSelected && 'opacity-100')}
          onClick={(e) => {
            e.stopPropagation()
            onLoad()
          }}
          title="Load session in new tab"
          data-testid="load-session-button"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

// Session preview component
interface SessionPreviewProps {
  session: SessionWithWorktree
  onLoad: () => void
}

function SessionPreview({ session, onLoad }: SessionPreviewProps): React.JSX.Element {
  const getSessionPreviewMessages = useSessionHistoryStore(
    (state) => state.getSessionPreviewMessages
  )
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Load messages for preview
  useEffect(() => {
    let cancelled = false
    const loadMessages = async (): Promise<void> => {
      setIsLoading(true)
      try {
        const sessionMessages = await getSessionPreviewMessages(session)
        if (!cancelled) {
          setMessages(sessionMessages)
          setIsLoading(false)
        }
      } catch {
        if (!cancelled) {
          setMessages([])
          setIsLoading(false)
        }
      }
    }
    loadMessages()
    return () => {
      cancelled = true
    }
  }, [getSessionPreviewMessages, session])

  const isOrphaned = !session.worktree_id || session.worktree_name === undefined

  return (
    <div
      className="h-full flex flex-col bg-background border-l border-border"
      data-testid="session-preview"
    >
      {/* Header */}
      <div className="p-4 border-b border-border">
        <h3 className={cn('font-semibold text-lg', isOrphaned && 'italic opacity-80')}>
          {session.name || 'Untitled Session'}
        </h3>
        <div className="flex flex-col gap-1 mt-2 text-sm text-muted-foreground">
          {session.project_name && (
            <div className="flex items-center gap-2">
              <FolderGit2 className="h-4 w-4" />
              {session.project_name}
            </div>
          )}
          {session.worktree_name && (
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              {session.worktree_name} ({session.worktree_branch_name})
            </div>
          )}
          {isOrphaned && (
            <div className="flex items-center gap-2 text-amber-500">
              <AlertCircle className="h-4 w-4" />
              This session's worktree has been archived
            </div>
          )}
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Created {formatDate(session.created_at)}
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Updated {formatDate(session.updated_at)}
          </div>
        </div>
      </div>

      {/* Messages preview */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex items-center gap-2 mb-3 text-sm font-medium text-muted-foreground">
          <MessageSquare className="h-4 w-4" />
          Messages Preview
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No messages in this session
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={cn(
                  'p-2 rounded-lg text-sm',
                  msg.role === 'user' && 'bg-muted/50',
                  msg.role === 'assistant' && 'bg-primary/10',
                  msg.role === 'system' && 'bg-yellow-500/10'
                )}
              >
                <div className="text-xs font-medium text-muted-foreground mb-1 capitalize">
                  {msg.role}
                </div>
                <p className="line-clamp-3">{msg.content}</p>
              </div>
            ))}
            {messages.length >= 5 && (
              <p className="text-xs text-muted-foreground text-center">...and more messages</p>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-border">
        <Button onClick={onLoad} className="w-full" data-testid="load-session-preview-button">
          <ExternalLink className="h-4 w-4 mr-2" />
          Load Session
        </Button>
      </div>
    </div>
  )
}

// Empty state component
function EmptyState({ hasFilters }: { hasFilters: boolean }): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <Clock className="h-12 w-12 text-muted-foreground opacity-50 mb-4" />
      <h3 className="font-medium text-lg mb-2">No sessions found</h3>
      <p className="text-sm text-muted-foreground max-w-xs">
        {hasFilters
          ? 'Try adjusting your search filters to find more sessions.'
          : 'Start working in a worktree to create your first session.'}
      </p>
    </div>
  )
}

// Main SessionHistory component
export function SessionHistory(): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)

  // Stores
  const {
    isOpen,
    filters,
    searchResults,
    isSearching,
    error,
    selectedSessionId,
    closePanel,
    setKeyword,
    setProjectFilter,
    setWorktreeFilter,
    setDateFromFilter,
    setDateToFilter,
    setIncludeArchived,
    clearFilters,
    performSearch,
    selectSession
  } = useSessionHistoryStore()

  const { projects } = useProjectStore()
  const { worktreesByProject, loadWorktrees } = useWorktreeStore()
  const { reopenSession, setActiveSession } = useSessionStore()

  // Debounce the keyword filter
  const debouncedKeyword = useDebounce(filters.keyword, 300)

  // Trigger search when debounced keyword changes
  useEffect(() => {
    if (isOpen) {
      performSearch()
    }
  }, [debouncedKeyword, isOpen, performSearch])

  // Focus search input when panel opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Load worktrees for selected project
  useEffect(() => {
    if (filters.projectId) {
      loadWorktrees(filters.projectId)
    }
  }, [filters.projectId, loadWorktrees])

  // Get worktrees for filter dropdown
  const availableWorktrees = useMemo(() => {
    if (!filters.projectId) return []
    return worktreesByProject.get(filters.projectId) || []
  }, [filters.projectId, worktreesByProject])

  // Check if any filters are active
  const hasActiveFilters =
    filters.keyword !== '' ||
    filters.projectId !== null ||
    filters.worktreeId !== null ||
    filters.dateFrom !== null ||
    filters.dateTo !== null

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        closePanel()
      }
    },
    [closePanel]
  )

  // Handle loading a session
  const handleLoadSession = useCallback(
    async (session: SessionWithWorktree) => {
      // If session has a valid worktree, reopen it there
      if (session.worktree_id && session.worktree_name) {
        const result = await reopenSession(session.id, session.worktree_id)
        if (result.success) {
          closePanel()
          toast.success(`Loaded session "${session.name || 'Untitled'}"`)
        } else {
          toast.error(result.error || 'Failed to load session')
        }
      } else {
        // Session is orphaned - we can still view it but need to create a new session
        // to continue the conversation
        toast.info('This session is from an archived worktree. Opening in read-only mode.')
        setActiveSession(session.id)
        closePanel()
      }
    },
    [reopenSession, setActiveSession, closePanel]
  )

  // Get selected session
  const selectedSession = useMemo(() => {
    if (!selectedSessionId) return null
    return searchResults.find((s) => s.id === selectedSessionId) || null
  }, [searchResults, selectedSessionId])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm"
      onClick={closePanel}
      onKeyDown={handleKeyDown}
      data-testid="session-history-overlay"
    >
      <div
        className="fixed inset-y-0 right-0 w-full max-w-3xl bg-background shadow-xl flex"
        onClick={(e) => e.stopPropagation()}
        data-testid="session-history-panel"
      >
        {/* Left section - Search and results */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-border">
            <h2 className="text-lg font-semibold">Session History</h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={closePanel}
              data-testid="close-history-button"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Search and filters */}
          <div className="p-4 border-b border-border space-y-3">
            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                ref={inputRef}
                type="text"
                placeholder="Search title, project, or worktree..."
                value={filters.keyword}
                onChange={(e) => setKeyword(e.target.value)}
                className="pl-9"
                data-testid="session-search-input"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Keyword search matches session metadata (title, project, and worktree) only.
            </p>

            {/* Filter row */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Project filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    <FolderGit2 className="h-3.5 w-3.5 mr-1.5" />
                    {filters.projectId
                      ? projects.find((p) => p.id === filters.projectId)?.name || 'Project'
                      : 'All Projects'}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" data-testid="project-filter-dropdown">
                  <DropdownMenuItem onClick={() => setProjectFilter(null)}>
                    All Projects
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {projects.map((project) => (
                    <DropdownMenuItem key={project.id} onClick={() => setProjectFilter(project.id)}>
                      {project.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Worktree filter (only when project selected) */}
              {filters.projectId && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8">
                      <GitBranch className="h-3.5 w-3.5 mr-1.5" />
                      {filters.worktreeId
                        ? availableWorktrees.find((w) => w.id === filters.worktreeId)?.name ||
                          'Worktree'
                        : 'All Worktrees'}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" data-testid="worktree-filter-dropdown">
                    <DropdownMenuItem onClick={() => setWorktreeFilter(null)}>
                      All Worktrees
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {availableWorktrees.map((worktree) => (
                      <DropdownMenuItem
                        key={worktree.id}
                        onClick={() => setWorktreeFilter(worktree.id)}
                      >
                        {worktree.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {/* Date filters */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    <Calendar className="h-3.5 w-3.5 mr-1.5" />
                    {filters.dateFrom || filters.dateTo ? 'Date range' : 'Any time'}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-56"
                  data-testid="date-filter-dropdown"
                >
                  <div className="p-2 space-y-2">
                    <div>
                      <label className="text-xs text-muted-foreground">From</label>
                      <Input
                        type="date"
                        value={filters.dateFrom || ''}
                        onChange={(e) => setDateFromFilter(e.target.value || null)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">To</label>
                      <Input
                        type="date"
                        value={filters.dateTo || ''}
                        onChange={(e) => setDateToFilter(e.target.value || null)}
                        className="h-8 text-sm"
                      />
                    </div>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* More filters dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    <Filter className="h-3.5 w-3.5 mr-1.5" />
                    More
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" data-testid="more-filters-dropdown">
                  <DropdownMenuCheckboxItem
                    checked={filters.includeArchived}
                    onCheckedChange={setIncludeArchived}
                  >
                    Include archived worktrees
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Clear filters */}
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-muted-foreground"
                  onClick={clearFilters}
                  data-testid="clear-filters-button"
                >
                  Clear filters
                </Button>
              )}
            </div>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-y-auto" data-testid="session-results-list">
            {error && <div className="p-4 bg-destructive/10 text-destructive text-sm">{error}</div>}

            {isSearching ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : searchResults.length === 0 ? (
              <EmptyState hasFilters={hasActiveFilters} />
            ) : (
              <>
                <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border">
                  {searchResults.length} session{searchResults.length === 1 ? '' : 's'} found
                </div>
                {searchResults.map((session) => {
                  const isOrphaned = !session.worktree_id || session.worktree_name === undefined
                  return (
                    <SessionItem
                      key={session.id}
                      session={session}
                      isSelected={session.id === selectedSessionId}
                      isOrphaned={isOrphaned}
                      onSelect={() => selectSession(session.id)}
                      onLoad={() => handleLoadSession(session)}
                    />
                  )
                })}
              </>
            )}
          </div>
        </div>

        {/* Right section - Preview */}
        {selectedSession && (
          <div className="w-80 flex-shrink-0">
            <SessionPreview
              session={selectedSession}
              onLoad={() => handleLoadSession(selectedSession)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
