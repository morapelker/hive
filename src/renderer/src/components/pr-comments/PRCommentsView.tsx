import { useState, useEffect, useMemo } from 'react'
import { RotateCw, ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePRCommentStore } from '@/stores/usePRCommentStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { AuthorFilterChips } from './AuthorFilterChips'
import { PRCommentThreadView } from './PRCommentThread'
import type { PRReviewThread } from '@shared/types/pr-comment'

interface PRCommentsViewProps {
  worktreeId: string
}

export function PRCommentsView({ worktreeId }: PRCommentsViewProps): React.JSX.Element {
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())

  // Get worktree data to find PR number and path
  const worktrees = useWorktreeStore((s) => s.worktreesByProject)
  const worktree = useMemo(() => {
    for (const wts of worktrees.values()) {
      const found = wts.find((w) => w.id === worktreeId)
      if (found) return found
    }
    return null
  }, [worktrees, worktreeId])

  const prNumber = worktree?.github_pr_number ?? null
  const worktreePath = worktree?.path ?? null

  const isLoading = usePRCommentStore((s) => s.isLoading)
  const lastFetchError = usePRCommentStore((s) => s.lastFetchError)
  const lastFetchErrorCode = usePRCommentStore((s) => s.lastFetchErrorCode)
  const fetchComments = usePRCommentStore((s) => s.fetchComments)
  const loadCachedComments = usePRCommentStore((s) => s.loadCachedComments)
  const visibleThreads = usePRCommentStore((s) => s.getVisibleThreads(worktreeId))
  const allThreads = usePRCommentStore((s) => s.getThreadsForWorktree(worktreeId))

  // Load cached comments on mount
  useEffect(() => {
    if (prNumber && worktreeId) {
      loadCachedComments(worktreeId, prNumber)
    }
  }, [worktreeId, prNumber, loadCachedComments])

  // Group visible threads by file
  const threadsByFile = useMemo(() => {
    const grouped = new Map<string, PRReviewThread[]>()
    for (const t of visibleThreads) {
      const path = t.rootComment.path
      const existing = grouped.get(path) || []
      existing.push(t)
      grouped.set(path, existing)
    }
    return grouped
  }, [visibleThreads])

  const toggleFile = (path: string): void => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const handleRefresh = (): void => {
    if (prNumber && worktreePath) {
      fetchComments(worktreeId, worktreePath, prNumber)
    }
  }

  // No PR attached
  if (!prNumber) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center">
        <p className="text-sm text-muted-foreground">No PR attached to this worktree</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Attach a pull request to see review comments
        </p>
      </div>
    )
  }

  // Error states
  if (lastFetchError && allThreads.length === 0) {
    if (lastFetchErrorCode === 'auth_failed') {
      return (
        <div className="flex flex-col items-center justify-center h-full px-4 text-center">
          <p className="text-sm text-muted-foreground">GitHub authentication required.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Run <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono">gh auth login</code> in your terminal.
          </p>
        </div>
      )
    }
    if (lastFetchErrorCode === 'gh_not_found') {
      return (
        <div className="flex flex-col items-center justify-center h-full px-4 text-center">
          <p className="text-sm text-muted-foreground">GitHub CLI not found.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Install from{' '}
            <a
              href="https://cli.github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:text-blue-400 underline"
            >
              https://cli.github.com
            </a>
          </p>
        </div>
      )
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className={cn(
            'p-1 rounded text-muted-foreground hover:text-foreground transition-colors',
            isLoading && 'animate-spin'
          )}
          aria-label="Refresh comments"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs text-muted-foreground">
          {allThreads.length > 0
            ? `${allThreads.length} comment${allThreads.length === 1 ? '' : 's'}`
            : 'Comments'}
        </span>
        {lastFetchError && allThreads.length > 0 && (
          <span className="text-xs text-amber-500 truncate ml-auto" title={lastFetchError}>
            Refresh failed
          </span>
        )}
      </div>

      {/* Author filter chips */}
      <AuthorFilterChips worktreeId={worktreeId} />

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {allThreads.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center">
            <p className="text-sm text-muted-foreground">
              No review comments on this PR yet
            </p>
          </div>
        ) : visibleThreads.length === 0 && allThreads.length > 0 ? (
          <div className="flex flex-col items-center justify-center h-32 px-4 text-center">
            <p className="text-sm text-muted-foreground">
              All comments are filtered out
            </p>
          </div>
        ) : (
          Array.from(threadsByFile.entries()).map(([filePath, threads]) => {
            const isCollapsed = collapsedFiles.has(filePath)
            return (
              <div key={filePath}>
                <button
                  onClick={() => toggleFile(filePath)}
                  className="flex items-center gap-1.5 w-full px-3 py-1.5 bg-muted/30 hover:bg-muted/50 text-xs font-medium transition-colors border-b border-border"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3 w-3 flex-shrink-0" />
                  ) : (
                    <ChevronDown className="h-3 w-3 flex-shrink-0" />
                  )}
                  <span className="truncate text-left">{filePath}</span>
                  <span className="text-muted-foreground ml-auto flex-shrink-0">
                    {threads.length}
                  </span>
                </button>
                {!isCollapsed &&
                  threads.map((thread) => (
                    <PRCommentThreadView key={thread.rootComment.id} thread={thread} worktreeId={worktreeId} />
                  ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
