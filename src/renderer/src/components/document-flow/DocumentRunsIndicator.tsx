import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, FileText, Pause } from 'lucide-react'
import { PR_STACK_RIGHT_PX } from '@/components/pr/PRNotificationStack'
import { cn } from '@/lib/utils'
import { selectActiveRuns, useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { summarizeItems } from '@shared/document-flow/planning'
import { runKindLabel } from '@shared/document-flow/ticket-runs'
import { RunKindIcon, TicketRunIcon } from './RunKindIcon'
import { describeRunCount, formatRunProgress, needsUser, runDisplayTitle } from './document-flow-ui'

// Clears the Board Assistant launcher, which sits in the same corner of the board.
const INDICATOR_BOTTOM_PX = 56

/**
 * A small card in the bottom-right corner of the main pane listing the launched runs that are
 * not finished, so a run stays one click away while the user works elsewhere. Renders nothing
 * when no run is active. Runs made from a document and orchestrators made from board tickets
 * share it: the header names their kind ("2 document runs", "1 orchestrator", or "3 runs" for
 * a mix), and in a mix every row wears its own kind's icon.
 */
export function DocumentRunsIndicator(): React.JSX.Element | null {
  const runsById = useDocumentFlowStore((s) => s.runsById)
  const openDashboard = useDocumentFlowStore((s) => s.openDashboard)
  const [collapsed, setCollapsed] = useState(false)
  // Same horizontal anchor as the PR notification stack: left of the open agent panel. This
  // card is mounted at the layout root rather than inside the main pane, so the right sidebar
  // is added too.
  const rightSidebarWidth = useLayoutStore((s) =>
    s.rightSidebarCollapsed ? 0 : s.rightSidebarWidth
  )
  const runs = useMemo(() => selectActiveRuns(runsById), [runsById])

  if (runs.length === 0) return null

  // Marked as soon as one ticket waits on the user (a question, a permission, an interruption,
  // also mid-conflict or mid-fix), which covers a run that is stuck as a whole.
  const rows = runs.map((detail) => ({
    detail,
    summary: summarizeItems(detail.items),
    needsUser: detail.items.some(needsUser)
  }))
  const anyNeedsUser = rows.some((row) => row.needsUser)
  const count = describeRunCount(runs.map((detail) => detail.run))

  return (
    <div
      className={cn(
        'fixed z-30 w-[280px] overflow-hidden',
        'rounded-[11px] border border-black/14 dark:border-white/14',
        'bg-[rgba(255,255,255,0.82)] dark:bg-[rgba(0,0,0,0.72)] backdrop-blur-2xl',
        'shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.04)]'
      )}
      style={{
        right: PR_STACK_RIGHT_PX + rightSidebarWidth,
        bottom: INDICATOR_BOTTOM_PX
      }}
      data-testid="docflow-runs-indicator"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        data-testid="docflow-runs-indicator-toggle"
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setCollapsed((previous) => !previous)}
      >
        {count.kind === 'document' ? (
          <FileText className="h-3 w-3" />
        ) : (
          <TicketRunIcon className="h-3 w-3" />
        )}
        <span className="flex-1 text-left">{count.label}</span>
        {collapsed && anyNeedsUser && (
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="Needs you" />
        )}
        {collapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {!collapsed && (
        <div className="divide-y divide-border/60 border-t border-border/60">
          {rows.map(({ detail, summary, needsUser }) => (
            <button
              key={detail.run.id}
              type="button"
              data-testid={`docflow-indicator-run-${detail.run.id}`}
              className="block w-full px-3 py-2 text-left transition-colors hover:bg-accent/40"
              onClick={() => openDashboard(detail.run.id)}
            >
              <span className="flex items-center gap-1.5">
                {count.kind === 'mixed' && (
                  <RunKindIcon
                    run={detail.run}
                    className="h-3 w-3 shrink-0 text-muted-foreground"
                    aria-label={runKindLabel(detail.run)}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                  {runDisplayTitle(detail.run)}
                </span>
                {detail.run.status === 'paused' && (
                  <span
                    className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
                    data-testid={`docflow-indicator-paused-${detail.run.id}`}
                  >
                    <Pause className="h-2.5 w-2.5" />
                    paused
                  </span>
                )}
                {needsUser && (
                  <span
                    className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400"
                    data-testid={`docflow-indicator-needs-you-${detail.run.id}`}
                  >
                    needs you
                  </span>
                )}
              </span>
              <span
                className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground"
                data-testid={`docflow-indicator-progress-${detail.run.id}`}
              >
                {formatRunProgress(summary)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
