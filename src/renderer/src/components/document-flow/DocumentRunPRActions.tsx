import { GitPullRequest, Loader2 } from 'lucide-react'
import { systemApi } from '@/api/system-api'
import { ticketPillClass } from '@/components/kanban/pill'
import { cn } from '@/lib/utils'
import type { DocumentRunPRs } from './useDocumentRunPRs'

interface DocumentRunPRActionsProps {
  runId: string
  prs: DocumentRunPRs
}

/**
 * The PR row of a run's ticket card: a pill per pull request the integration branches already
 * have (opening it in the browser), and the button that creates the missing ones or pushes
 * updates to those that exist. Nothing until the run is launched.
 */
export function DocumentRunPRActions({
  runId,
  prs
}: DocumentRunPRActionsProps): React.JSX.Element | null {
  const { targets, links, creating, label, create } = prs
  if (targets.length === 0) return null
  return (
    <div
      className="mt-[7px] flex flex-wrap items-center gap-1"
      data-testid={`kanban-docflow-run-prs-${runId}`}
    >
      {links.map((link) => (
        <button
          key={link.worktreeId}
          type="button"
          data-testid={`kanban-docflow-run-pr-link-${runId}-${link.worktreeId}`}
          title={`Open PR #${link.number}${link.projectName ? ` of ${link.projectName}` : ''} in browser`}
          onClick={(e) => {
            e.stopPropagation()
            void systemApi.openInChrome(link.url)
          }}
          className={cn(
            ticketPillClass,
            'transition-colors hover:border-muted-foreground/35 hover:text-foreground'
          )}
        >
          <GitPullRequest className="h-2.5 w-2.5 shrink-0" />
          {link.projectName ? `${link.projectName} #${link.number}` : `#${link.number}`}
        </button>
      ))}
      <button
        type="button"
        data-testid={`kanban-docflow-run-pr-button-${runId}`}
        disabled={creating}
        onClick={(e) => {
          e.stopPropagation()
          void create()
        }}
        className={cn(
          ticketPillClass,
          'ml-auto transition-colors hover:border-muted-foreground/35 hover:text-foreground',
          'disabled:cursor-default disabled:hover:border-border disabled:hover:text-muted-foreground'
        )}
      >
        {creating ? (
          <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />
        ) : (
          <GitPullRequest className="h-2.5 w-2.5 shrink-0" />
        )}
        {creating ? (targets.length > 1 ? 'Creating PRs…' : 'Creating PR…') : label}
      </button>
    </div>
  )
}
