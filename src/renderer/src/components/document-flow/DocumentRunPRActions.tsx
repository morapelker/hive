import { GitPullRequest, Loader2 } from 'lucide-react'
import { systemApi } from '@/api/system-api'
import { ticketPillClass } from '@/components/kanban/pill'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { DocumentRunPRLink, DocumentRunPRs } from './useDocumentRunPRs'

interface DocumentRunPRProps {
  runId: string
  prs: DocumentRunPRs
}

const linkTitle = (link: DocumentRunPRLink): string =>
  `Open PR #${link.number}${link.projectName ? ` of ${link.projectName}` : ''} in browser`

const linkLabel = (link: DocumentRunPRLink): string =>
  link.projectName ? `${link.projectName} #${link.number}` : `#${link.number}`

/**
 * The PR row of a run's ticket card: a pill per pull request the integration branches already
 * have, opening it in the browser. The button that makes them is in the run's dashboard.
 * Nothing until a PR exists.
 */
export function DocumentRunPRLinks({ runId, prs }: DocumentRunPRProps): React.JSX.Element | null {
  const { targets, links } = prs
  if (targets.length === 0 || links.length === 0) return null
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
          title={linkTitle(link)}
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
          {linkLabel(link)}
        </button>
      ))}
    </div>
  )
}

/**
 * The PR line of a run's dashboard: the pull requests the integration branches already have,
 * and the button that creates the missing ones or pushes updates to those that exist. Nothing
 * until the run is launched.
 */
export function DocumentRunPRRow({ runId, prs }: DocumentRunPRProps): React.JSX.Element | null {
  const { targets, links, creating, label, create } = prs
  if (targets.length === 0) return null
  return (
    <div
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted-foreground"
      data-testid={`docflow-run-prs-${runId}`}
    >
      <GitPullRequest className="h-3 w-3 shrink-0" />
      {links.length === 0 && <span>No pull request yet</span>}
      {links.map((link) => (
        <button
          key={link.worktreeId}
          type="button"
          data-testid={`docflow-run-pr-link-${runId}-${link.worktreeId}`}
          title={linkTitle(link)}
          onClick={() => void systemApi.openInChrome(link.url)}
          className="font-mono text-foreground underline-offset-2 hover:underline"
        >
          {linkLabel(link)}
        </button>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-6 text-xs"
        data-testid={`docflow-run-pr-button-${runId}`}
        disabled={creating}
        onClick={() => void create()}
      >
        {creating ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <GitPullRequest className="h-3 w-3" />
        )}
        {creating ? (targets.length > 1 ? 'Creating PRs…' : 'Creating PR…') : label}
      </Button>
    </div>
  )
}
