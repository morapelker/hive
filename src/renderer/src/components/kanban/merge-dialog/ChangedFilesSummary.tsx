import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { changedFilesTotals, type ChangedFile, type ChangedFilesTotals } from './changed-files'

export function SummaryChip({
  children,
  className,
  testId
}: {
  children: ReactNode
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-md bg-muted/60 px-2 text-xs text-muted-foreground',
        className
      )}
      data-testid={testId}
    >
      {children}
    </span>
  )
}

interface ChangedFilesSummaryProps {
  files: ChangedFile[] | null
  /** Totals to show until the list has loaded (e.g. from branchDiffShortStat) */
  fallback?: ChangedFilesTotals | null
  fileLabel: (count: number) => string
  /** Extra chips rendered first */
  children?: ReactNode
}

/**
 * One line of chips summarising the change set. Totals come from the file
 * list once it has loaded so the header can never disagree with the rows.
 */
export function ChangedFilesSummary({
  files,
  fallback,
  fileLabel,
  children
}: ChangedFilesSummaryProps): React.JSX.Element {
  const totals = files ? changedFilesTotals(files) : (fallback ?? null)
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="merge-dialog-summary">
      {children}
      {totals ? (
        <>
          <SummaryChip testId="merge-summary-files">{fileLabel(totals.files)}</SummaryChip>
          <SummaryChip className="font-mono" testId="merge-summary-stats">
            <span className="text-emerald-500">+{totals.additions}</span>
            <span className="text-rose-500">-{totals.deletions}</span>
          </SummaryChip>
        </>
      ) : (
        <SummaryChip testId="merge-summary-loading">
          <Loader2 className="h-3 w-3 animate-spin" />
          Counting changes...
        </SummaryChip>
      )}
    </div>
  )
}
