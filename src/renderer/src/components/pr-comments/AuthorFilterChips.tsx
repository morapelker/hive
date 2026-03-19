import { cn } from '@/lib/utils'
import { usePRCommentStore } from '@/stores/usePRCommentStore'

interface AuthorFilterChipsProps {
  worktreeId: string
}

export function AuthorFilterChips({
  worktreeId
}: AuthorFilterChipsProps): React.JSX.Element | null {
  const authors = usePRCommentStore((s) => s.getUniqueAuthors(worktreeId))
  const disabledAuthors = usePRCommentStore((s) => s.disabledAuthors)
  const toggleAuthorFilter = usePRCommentStore((s) => s.toggleAuthorFilter)

  if (authors.length <= 1) return null

  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-border">
      {authors.map((author) => {
        const isDisabled = disabledAuthors.has(author.login)
        return (
          <button
            key={author.login}
            onClick={() => toggleAuthorFilter(author.login)}
            className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs transition-colors',
              isDisabled
                ? 'bg-muted/50 text-muted-foreground/50 border border-border'
                : 'bg-primary/10 text-foreground border border-primary/30'
            )}
          >
            <img
              src={author.avatarUrl}
              alt={author.login}
              className={cn('w-4 h-4 rounded-full', isDisabled && 'opacity-40')}
            />
            <span className={cn(isDisabled && 'opacity-50')}>{author.login}</span>
          </button>
        )
      })}
    </div>
  )
}
