import { useState, useCallback } from 'react'
import { MessageSquare, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useI18n } from '@/i18n/useI18n'
import type { PRReviewComment } from '@shared/types/git'

/** Strip HTML tags and collapse whitespace to get a plain-text snippet. */
function snippetFromHtml(html: string, plain: string): string {
  const text = plain || html.replace(/<[^>]*>/g, '')
  return text.replace(/\s+/g, ' ').trim()
}

function Avatar({ user }: { user: PRReviewComment['user'] }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const login = user?.login ?? 'ghost'

  if (!failed && user?.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={login}
        className="h-4 w-4 rounded-full shrink-0 bg-white"
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <div className="h-4 w-4 rounded-full shrink-0 bg-muted flex items-center justify-center text-[9px] font-medium text-muted-foreground uppercase">
      {login[0]}
    </div>
  )
}

interface PrCommentCardProps {
  comment: PRReviewComment
  replies: PRReviewComment[]
  isSelected: boolean
  onToggleSelect: (commentId: number) => void
  onNavigate: (comment: PRReviewComment) => void
}

export function PrCommentCard({
  comment,
  replies,
  isSelected,
  onToggleSelect,
  onNavigate
}: PrCommentCardProps): React.JSX.Element {
  const { t } = useI18n()
  const isOutdated = comment.line === null && comment.originalLine !== null
  const snippet = snippetFromHtml(comment.bodyHTML, comment.body)
  const line = comment.line ?? comment.originalLine ?? '?'

  const handleCopyRaw = useCallback(() => {
    navigator.clipboard.writeText(comment.bodyHTML || comment.body).then(() => {
      toast.success(t('prReview.commentCard.copied'))
    })
  }, [comment.bodyHTML, comment.body, t])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors cursor-pointer group',
            isSelected ? 'bg-violet-500/10' : 'hover:bg-accent/40'
          )}
          onClick={() => onNavigate(comment)}
        >
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect(comment.id)}
            onClick={(e) => e.stopPropagation()}
            className="h-3 w-3 rounded border-border accent-violet-500 cursor-pointer shrink-0"
          />
          <Avatar user={comment.user} />
          <span className="text-[11px] font-medium text-foreground shrink-0">
            {comment.user?.login ?? 'ghost'}
          </span>
          <span className="text-[11px] text-muted-foreground font-mono shrink-0 group-hover:text-primary transition-colors">
            :{line}
          </span>
          {isOutdated && (
            <span className="px-1 py-px rounded text-[9px] font-medium bg-yellow-500/10 text-yellow-500 shrink-0">
              {t('prReview.commentCard.outdated')}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground truncate min-w-0 flex-1">
            {snippet}
          </span>
          {replies.length > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground shrink-0">
              <MessageSquare className="h-2.5 w-2.5" />
              {replies.length}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleCopyRaw}>
          <Copy className="h-3.5 w-3.5 mr-2" />
          {t('prReview.commentCard.copyRawHtml')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
