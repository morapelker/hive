import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { PrCommentCard } from './PrCommentCard'
import type { PRReviewComment } from '@shared/types/git'

interface PrReviewFileGroupProps {
  filePath: string
  comments: PRReviewComment[]
  threads: Map<number, PRReviewComment[]>
  selectedIds: Set<number>
  onToggleSelect: (commentId: number) => void
  onNavigate: (comment: PRReviewComment) => void
}

export function PrReviewFileGroup({
  filePath,
  comments,
  threads,
  selectedIds,
  onToggleSelect,
  onNavigate
}: PrReviewFileGroupProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(true)

  // Get root comments for this file (not replies)
  const rootComments = comments.filter((c) => c.inReplyToId === null)

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        className="flex items-center justify-between w-full px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/50 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="flex items-center gap-1.5">
          {isOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <span className="font-mono text-foreground">{filePath}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted">
            {rootComments.length}
          </span>
        </span>
      </button>
      {isOpen && (
        <div className="px-1 pb-1.5 space-y-px">
          {rootComments.map((comment) => {
            const threadReplies = (threads.get(comment.id) ?? []).filter(
              (c) => c.id !== comment.id
            )
            return (
              <PrCommentCard
                key={comment.id}
                comment={comment}
                replies={threadReplies}
                isSelected={selectedIds.has(comment.id)}
                onToggleSelect={onToggleSelect}
                onNavigate={onNavigate}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
