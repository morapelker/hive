import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import type {
  DocumentRunEvent,
  DocumentRunItem,
  DocumentRunReport
} from '@shared/types/document-flow'
import {
  DOCUMENT_RUN_ITEM_STATUS_LABELS,
  formatEventTime,
  pluralize,
  shortSha
} from './document-flow-ui'

const SECTION_LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

/** What a finished run hands back: what merged, what did not, and what is left for the user. */
export function RunReportSection({
  report,
  landed = false,
  migrationsAction
}: {
  report: DocumentRunReport
  /** The run's ticket already sits in Done or Merged, so the merge is not left to do. */
  landed?: boolean
  /** Shown next to the migrations list: the button that executes them, or stops that. */
  migrationsAction?: React.ReactNode
}): React.JSX.Element {
  const { stats, verify } = report
  return (
    <section className="space-y-3" data-testid="docflow-report">
      <p className={SECTION_LABEL_CLASS}>Report</p>

      {report.baseMoved && (
        <p
          className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-snug text-amber-600 dark:text-amber-400"
          data-testid="docflow-report-base-moved"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {report.baseBranch} has new commits since this run started — merge or rebase before
          landing
        </p>
      )}

      {landed ? (
        <p
          className="text-[13px] leading-relaxed text-foreground"
          data-testid="docflow-report-next"
        >
          The run&rsquo;s ticket is in Done.
          {report.migrations.length > 0 ? ' Run the migrations if you have not yet.' : ''}
        </p>
      ) : (
        <p
          className="text-[13px] leading-relaxed text-foreground"
          data-testid="docflow-report-next"
        >
          What is left for you: {report.migrations.length > 0 ? 'run the migrations, ' : ''}review,
          then move the run&rsquo;s ticket to Done on the board to merge{' '}
          <span className="font-mono text-[12px]">{report.integrationBranch}</span> into{' '}
          <span className="font-mono text-[12px]">{report.baseBranch}</span>.
        </p>
      )}

      <p className="text-[12px] text-muted-foreground" data-testid="docflow-report-stats">
        {pluralize(stats.commits, 'commit')} · {pluralize(stats.filesChanged, 'file')} changed ·{' '}
        <span className="text-emerald-500">+{stats.insertions}</span>{' '}
        <span className="text-red-500">−{stats.deletions}</span> ·{' '}
        <span className="font-mono">
          {shortSha(report.baseSha)}..{shortSha(report.headSha)}
        </span>
      </p>

      {verify && (
        <div className="space-y-1" data-testid="docflow-report-verify">
          <p className="flex items-center gap-1.5 text-[12px] text-foreground">
            {verify.ok ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <X className="h-3.5 w-3.5 text-red-500" />
            )}
            <span className="font-mono">{verify.command}</span>
            <span className="text-muted-foreground">{verify.ok ? 'passed' : 'failed'}</span>
          </p>
          {!verify.ok && verify.output.trim() && (
            <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-snug text-muted-foreground">
              {verify.output}
            </pre>
          )}
        </div>
      )}

      <ReportList
        title="Migrations to run"
        testId="docflow-report-migrations"
        entries={report.migrations}
        mono
        action={migrationsAction}
      />
      <ReportList
        title="Manual steps"
        testId="docflow-report-manual-steps"
        entries={report.manualSteps}
      />

      {report.merged.length > 0 && (
        <div className="space-y-1" data-testid="docflow-report-merged">
          <p className="text-[12px] font-medium text-foreground">Merged ({report.merged.length})</p>
          <ul className="space-y-1">
            {report.merged.map((entry) => (
              <li key={entry.key} className="text-[12px] leading-snug">
                <span className="font-mono text-[11px] text-muted-foreground">{entry.key}</span>{' '}
                <span className="text-foreground">{entry.title}</span>
                {entry.mergeSha && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {' '}
                    {shortSha(entry.mergeSha)}
                  </span>
                )}
                {entry.summary && (
                  <span className="block text-muted-foreground">{entry.summary}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.unmerged.length > 0 && (
        <div className="space-y-1" data-testid="docflow-report-unmerged">
          <p className="text-[12px] font-medium text-foreground">
            Not merged ({report.unmerged.length})
          </p>
          <ul className="space-y-1">
            {report.unmerged.map((entry) => (
              <li key={entry.key} className="text-[12px] leading-snug">
                <span className="font-mono text-[11px] text-muted-foreground">{entry.key}</span>{' '}
                <span className="text-foreground">{entry.title}</span>{' '}
                <span className="text-muted-foreground">
                  · {DOCUMENT_RUN_ITEM_STATUS_LABELS[entry.status]}
                </span>
                {entry.reason && (
                  <span className="block text-muted-foreground">{entry.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function ReportList({
  title,
  testId,
  entries,
  mono = false,
  action
}: {
  title: string
  testId: string
  entries: string[]
  mono?: boolean
  /** Sits at the end of the title row. */
  action?: React.ReactNode
}): React.JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="flex min-h-6 items-center justify-between gap-3">
        <p className="shrink-0 text-[12px] font-medium text-foreground">
          {title} ({entries.length})
        </p>
        {action && <div className="flex min-w-0 items-center justify-end gap-1.5">{action}</div>}
      </div>
      <ul
        className={
          mono
            ? 'space-y-0.5 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] text-foreground'
            : 'list-disc space-y-0.5 pl-5 text-[12px] leading-snug text-foreground'
        }
      >
        {entries.map((entry, index) => (
          <li key={index} className="break-words">
            {entry}
          </li>
        ))}
      </ul>
    </div>
  )
}

interface RunActivityLogProps {
  /** Oldest first, as the store keeps them. */
  events: readonly DocumentRunEvent[]
  items: readonly DocumentRunItem[]
}

/** The run's audit log, newest first, folded away until asked for. */
export function RunActivityLog({ events, items }: RunActivityLogProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (events.length === 0) return null
  const keyById = new Map(items.map((item) => [item.id, item.key]))

  return (
    <section data-testid="docflow-activity">
      <button
        type="button"
        aria-expanded={open}
        data-testid="docflow-activity-toggle"
        className={`${SECTION_LABEL_CLASS} flex items-center gap-1 transition-colors hover:text-foreground`}
        onClick={() => setOpen((previous) => !previous)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Activity ({events.length})
      </button>
      {open && (
        <ol
          className="mt-1.5 max-h-64 space-y-0.5 overflow-y-auto rounded-[8px] border border-border px-3 py-2"
          data-testid="docflow-activity-list"
        >
          {[...events].reverse().map((event) => (
            <li key={event.id} className="flex gap-2 text-[12px] leading-snug">
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {formatEventTime(event.at)}
              </span>
              {event.item_id && keyById.has(event.item_id) && (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {keyById.get(event.item_id)}
                </span>
              )}
              <span className="min-w-0 break-words text-foreground">{event.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
