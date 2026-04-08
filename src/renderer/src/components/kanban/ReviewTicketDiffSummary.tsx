import type { JSX } from 'react'

export interface ReviewTicketDiffFile {
  relativePath: string
  status: string
  additions: number
  deletions: number
  binary: boolean
}

interface ReviewTicketDiffSummaryProps {
  baseBranch: string | null
  files: ReviewTicketDiffFile[]
  loading: boolean
  error: string | null
}

export function ReviewTicketDiffSummary({
  baseBranch,
  files,
  loading,
  error
}: ReviewTicketDiffSummaryProps): JSX.Element | null {
  if (!baseBranch && !loading && !error) return null

  return (
    <section
      className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2 min-h-0 flex flex-col"
      data-testid="review-diff-summary"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Changed Files
          </h3>
          {baseBranch && (
            <p className="text-[11px] text-muted-foreground">
              Against <span className="font-mono text-foreground">{baseBranch}</span>
            </p>
          )}
        </div>
        {!loading && !error && (
          <span
            className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground"
            data-testid="review-diff-summary-count"
          >
            {files.length}
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading changed files...</p>
      ) : error ? (
        <p className="text-xs text-destructive" data-testid="review-diff-summary-error">
          {error}
        </p>
      ) : files.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No changes against <span className="font-mono">{baseBranch ?? 'base branch'}</span>.
        </p>
      ) : (
        <div
          className="space-y-1 overflow-y-auto pr-1 min-h-0 max-h-64"
          data-testid="review-diff-summary-scroll"
        >
          {files.map((file) => (
            <div
              key={file.relativePath}
              className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent/30"
              data-testid="review-diff-summary-file"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                {file.relativePath}
              </span>
              {file.binary ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">binary</span>
              ) : (
                <span className="shrink-0 space-x-2 font-mono text-[11px]">
                  <span className="text-emerald-500">+{file.additions}</span>
                  <span className="text-rose-500">-{file.deletions}</span>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
