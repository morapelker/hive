import { useEffect, useMemo, useCallback } from 'react'
import { Loader2, RefreshCw, MessageSquareCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePRReviewStore } from '@/stores/usePRReviewStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useGitStore } from '@/stores/useGitStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { PrReviewFileGroup } from './PrReviewFileGroup'
import { cn } from '@/lib/utils'
import type { PRReviewComment } from '@shared/types/git'

const EMPTY_COMMENTS: PRReviewComment[] = []

interface PrReviewViewerProps {
  worktreeId: string
}

export function PrReviewViewer({ worktreeId }: PrReviewViewerProps): React.JSX.Element {
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const projects = useProjectStore((s) => s.projects)
  const attachedPR = useGitStore((s) => s.attachedPR.get(worktreeId))

  const loading = usePRReviewStore((s) => s.loading.get(worktreeId) ?? false)
  const error = usePRReviewStore((s) => s.error.get(worktreeId) ?? null)
  const rawComments = usePRReviewStore((s) => s.comments.get(worktreeId) ?? EMPTY_COMMENTS)
  const selectedIds = usePRReviewStore((s) => s.selectedCommentIds)
  const hiddenReviewers = usePRReviewStore((s) => s.hiddenReviewers)
  const fetchComments = usePRReviewStore((s) => s.fetchComments)
  const toggleComment = usePRReviewStore((s) => s.toggleComment)
  const selectAll = usePRReviewStore((s) => s.selectAll)
  const deselectAll = usePRReviewStore((s) => s.deselectAll)
  const toggleReviewer = usePRReviewStore((s) => s.toggleReviewer)
  const attachSelectedToChat = usePRReviewStore((s) => s.attachSelectedToChat)

  // Find project path for the worktree
  const worktree = useMemo(() => {
    for (const wts of worktreesByProject.values()) {
      const wt = wts.find((w) => w.id === worktreeId)
      if (wt) return wt
    }
    return null
  }, [worktreesByProject, worktreeId])
  const project = projects.find((p) => p.id === worktree?.project_id)
  const projectPath = project?.path
  const prNumber = attachedPR?.number

  // Fetch comments on mount
  useEffect(() => {
    if (projectPath && prNumber) {
      fetchComments(worktreeId, projectPath, prNumber)
    }
  }, [worktreeId, projectPath, prNumber, fetchComments])

  const handleRefresh = (): void => {
    if (projectPath && prNumber) {
      fetchComments(worktreeId, projectPath, prNumber)
    }
  }

  // Navigate to a comment's file in the diff viewer
  const handleNavigate = useCallback(
    (comment: PRReviewComment) => {
      if (!worktree?.path || !comment.path) return
      const baseBranch = usePRReviewStore.getState().baseBranch.get(worktreeId)
      if (!baseBranch) return

      useFileViewerStore.getState().setActiveDiff({
        worktreePath: worktree.path,
        filePath: comment.path,
        fileName: comment.path.split('/').pop() || comment.path,
        staged: false,
        isUntracked: false,
        compareBranch: baseBranch,
        scrollToLine: comment.line ?? comment.originalLine ?? undefined,
        prReviewWorktreeId: worktreeId
      })
    },
    [worktreeId, worktree?.path]
  )

  // Derive filtered/grouped data — defensively wrapped so a malformed
  // comment never crashes the whole sidebar.
  const { grouped, threads, reviewers } = useMemo(() => {
    try {
      const state = usePRReviewStore.getState()
      const visible = state.getVisibleComments(worktreeId)
      return {
        grouped: state.getGroupedByFile(worktreeId),
        threads: state.getThreads(visible),
        reviewers: state.getUniqueReviewers(worktreeId)
      }
    } catch (err) {
      console.error('[PrReviewViewer] Error computing derived data:', err)
      return {
        grouped: new Map<string, PRReviewComment[]>(),
        threads: new Map<number, PRReviewComment[]>(),
        reviewers: [] as Array<{ login: string; count: number }>
      }
    }
  }, [worktreeId, rawComments, hiddenReviewers])

  const hasRawComments = rawComments.length > 0

  // Loading state — only when no comments loaded yet
  if (loading && !hasRawComments) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
        <span className="text-sm">Loading review comments...</span>
      </div>
    )
  }

  // Error state — only when no comments loaded yet
  if (error && !hasRawComments) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <MessageSquareCode className="h-8 w-8 text-destructive" />
        <span className="text-sm text-destructive">{error}</span>
        <Button size="sm" variant="outline" onClick={handleRefresh}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Retry
        </Button>
      </div>
    )
  }

  // True empty state — no comments exist at all
  if (!loading && !hasRawComments) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <MessageSquareCode className="h-8 w-8" />
        <span className="text-sm">No review comments on this PR</span>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar — always visible when comments exist */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-muted/30">
        {prNumber && (
          <span className="text-xs text-muted-foreground shrink-0">#{prNumber}</span>
        )}
        <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
          {reviewers.map(({ login, count }) => (
            <button
              key={login}
              onClick={() => toggleReviewer(login)}
              className={cn(
                'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] transition-colors',
                hiddenReviewers.has(login)
                  ? 'bg-muted/50 text-muted-foreground line-through opacity-50'
                  : 'bg-muted text-foreground'
              )}
              title={hiddenReviewers.has(login) ? `Show ${login}'s comments` : `Hide ${login}'s comments`}
            >
              @{login}
              <span className="text-[10px] text-muted-foreground">{count}</span>
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 shrink-0"
          onClick={handleRefresh}
          disabled={loading}
          title="Refresh comments"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </Button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {grouped.size === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
            <MessageSquareCode className="h-6 w-6" />
            <span className="text-xs">All comments hidden by filters</span>
          </div>
        ) : (
          Array.from(grouped.entries()).map(([filePath, fileComments]) => (
            <PrReviewFileGroup
              key={filePath}
              filePath={filePath}
              comments={fileComments}
              threads={threads}
              selectedIds={selectedIds}
              onToggleSelect={toggleComment}
              onNavigate={handleNavigate}
            />
          ))
        )}
      </div>

      {/* Sticky footer — only visible when comments are selected */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {selectedIds.size} selected
            </span>
            <button
              onClick={() => selectAll(worktreeId)}
              className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
            >
              Select all
            </button>
            <button
              onClick={deselectAll}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Deselect
            </button>
          </div>
          <Button
            size="sm"
            className="h-7 text-xs bg-violet-600 hover:bg-violet-700 text-white"
            onClick={() => attachSelectedToChat(worktreeId)}
          >
            Add to chat
          </Button>
        </div>
      )}
    </div>
  )
}
