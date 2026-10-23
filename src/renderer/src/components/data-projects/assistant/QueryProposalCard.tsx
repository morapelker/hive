// A query the assistant proposed: READ/WRITE badge from the shared classifier (never just the
// model's word), the read-only highlighted query, dangerous-statement warnings, the explanation,
// and Insert (replace the active tab) / Open in new tab / Copy. The query was already placed in
// the editor when it arrived; nothing here runs it.
import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Copy, FilePlus2, TextCursorInput } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDataAssistantStore, type AssistantProposal } from '@/stores/useDataAssistantStore'
import type { SqlDialect } from '@shared/data-projects/types'
import { classifyQuery, QUERY_TOKEN_CLASS, tokenizeQuery } from './query-insight'

interface QueryProposalCardProps {
  projectId: string
  messageId: string
  proposal: AssistantProposal
  dialect: SqlDialect | null
  /** Only the newest proposal shows where it was auto-inserted. */
  latest: boolean
}

const AUTO_INSERTED_NOTE: Record<'replace' | 'new-tab', string> = {
  replace: 'Placed in the editor',
  'new-tab': 'Opened in a new tab'
}

export function QueryProposalCard({
  projectId,
  messageId,
  proposal,
  dialect,
  latest
}: QueryProposalCardProps): React.JSX.Element {
  const insertProposal = useDataAssistantStore((s) => s.insertProposal)
  const [copied, setCopied] = useState(false)
  const tokens = useMemo(
    () => tokenizeQuery(proposal.query, proposal.language, dialect),
    [proposal.query, proposal.language, dialect]
  )
  const verdict = useMemo(
    () => classifyQuery(proposal.query, proposal.language, dialect, proposal.isWrite),
    [proposal.query, proposal.language, dialect, proposal.isWrite]
  )
  const isWrite = verdict.kind === 'write'

  const copy = async (): Promise<void> => {
    if (await copyTextToClipboard(proposal.query)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    } else {
      toast.error('Failed to copy to clipboard')
    }
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-[10px] border bg-card',
        isWrite ? 'border-amber-500/40' : 'border-border'
      )}
      data-testid="data-assistant-proposal"
      data-proposal-kind={verdict.kind}
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-border px-2.5">
        <span
          className={cn(
            'rounded-full px-[7px] text-[10px] font-semibold uppercase tracking-[0.05em]',
            isWrite
              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
              : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
          )}
          title={
            verdict.classes.length
              ? `Statements: ${verdict.classes.join(', ')}`
              : 'Classified from the assistant’s own claim'
          }
          data-testid="data-assistant-proposal-badge"
        >
          {isWrite ? 'Write' : 'Read'}
        </span>
        {proposal.database && (
          <span
            className="truncate rounded-full bg-secondary px-[7px] text-[10px] font-medium text-muted-foreground"
            title={`Written for database ${proposal.database}`}
          >
            {proposal.database}
          </span>
        )}
        <span className="ml-auto truncate text-[10px] text-muted-foreground">
          {latest && proposal.autoInserted
            ? `${AUTO_INSERTED_NOTE[proposal.autoInserted]} · not run`
            : 'Not run'}
        </span>
      </div>

      <pre
        className="max-h-64 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre scrollbar-sleek"
        data-testid="data-assistant-proposal-query"
      >
        <code>
          {tokens.map((token, i) => (
            <span key={i} className={QUERY_TOKEN_CLASS[token.kind] || undefined}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>

      {verdict.dangerous.length > 0 && (
        <div
          className="flex items-start gap-1.5 border-t border-border bg-red-500/5 px-3 py-1.5 text-[11px] text-red-700 dark:text-red-300"
          data-testid="data-assistant-proposal-dangerous"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{verdict.dangerous.join(' · ')}</span>
        </div>
      )}

      {proposal.explanation && (
        <div className="border-t border-border px-3 py-2 text-[12px] leading-[1.5] whitespace-pre-wrap break-words text-muted-foreground">
          {proposal.explanation}
        </div>
      )}

      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-[11px]"
          title="Replace the active query tab with this query"
          onClick={() => insertProposal(projectId, messageId, 'replace')}
          data-testid="data-assistant-proposal-insert"
        >
          <TextCursorInput className="h-3 w-3" />
          Insert
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => insertProposal(projectId, messageId, 'new-tab')}
          data-testid="data-assistant-proposal-new-tab"
        >
          <FilePlus2 className="h-3 w-3" />
          Open in new tab
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-2 text-[11px]"
          onClick={() => void copy()}
          data-testid="data-assistant-proposal-copy"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
