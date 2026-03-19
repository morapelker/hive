import { lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { usePRCommentStore } from '@/stores/usePRCommentStore'
import { PRCommentThreadView } from './PRCommentThread'
import type { ReviewTab } from '@/stores/useFileViewerStore'

const MonacoDiffView = lazy(() => import('@/components/diff/MonacoDiffView'))

interface ReviewTabViewProps {
  tab: ReviewTab
  onClose: () => void
}

export function ReviewTabView({ tab, onClose }: ReviewTabViewProps): React.JSX.Element {
  const threads = usePRCommentStore((s) => s.getThreadsForWorktree(tab.worktreeId))
  const thread = threads.find((t) => t.rootComment.id === tab.threadRootId)

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Top: Comment thread (~35%) */}
      <div className="h-[35%] min-h-0 overflow-y-auto border-b border-border bg-background">
        {thread ? (
          <PRCommentThreadView thread={thread} showCheckbox={false} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Comment thread not found
          </div>
        )}
      </div>

      {/* Bottom: Diff view (flex-1) */}
      <div className="flex-1 min-h-0 flex flex-col">
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <MonacoDiffView
            worktreePath={tab.worktreePath}
            filePath={tab.filePath}
            fileName={tab.fileName}
            staged={false}
            isUntracked={false}
            compareBranch={tab.compareBranch}
            onClose={onClose}
            scrollToLine={tab.line ?? undefined}
          />
        </Suspense>
      </div>
    </div>
  )
}
