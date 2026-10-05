import { useEffect, useState } from 'react'
import { Copy, FlagTriangleRight, GitBranch, Loader2, Pause, Play, Trash2, X } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { summarizeItems } from '@shared/document-flow/planning'
import type { DocumentRunDetail } from '@shared/types/document-flow'
import { TonePill } from './DocumentFlowBadges'
import { NeedsYouSection, RunItemsTable } from './DocumentRunItems'
import { RunActivityLog, RunReportSection } from './DocumentRunReport'
import { openWorktree } from './document-flow-navigation'
import {
  describeRunDeletion,
  documentNameFromPath,
  isActiveRunStatus,
  isLaunchedRunStatus,
  isRunDeletable,
  progressSegments,
  runStatusDisplay,
  shortSha
} from './document-flow-ui'

type ConfirmKind = 'finish' | 'cancel' | 'delete'

const CONFIRM_COPY: Record<
  ConfirmKind,
  { title: string; description: string; action: string; destructive: boolean }
> = {
  finish: {
    title: 'Finish the run now?',
    description:
      'Every ticket that is not merged yet is skipped, and the report is built from what is merged so far. Sessions, branches and worktrees are kept.',
    action: 'Finish now',
    destructive: false
  },
  cancel: {
    title: 'Cancel the run?',
    description:
      'The run stops launching and merging tickets. Sessions, branches and worktrees are kept, and so is everything already merged into the integration branch.',
    action: 'Cancel run',
    destructive: true
  },
  delete: {
    title: 'Delete this run?',
    // Followed by describeRunDeletion(items): what happens to the files depends on the run.
    description: 'The run and its report are removed from the list.',
    action: 'Delete',
    destructive: true
  }
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * The dashboard of a launched run: a projection of the store's copy of the run, which the
 * server's pushes keep current. Nothing here drives the run; the buttons only write the
 * user's decisions.
 */
export function DocumentRunDashboard(): React.JSX.Element {
  const runId = useDocumentFlowStore((s) => s.dashboardRunId)
  const detail = useDocumentFlowStore((s) =>
    s.dashboardRunId ? s.runsById[s.dashboardRunId] : undefined
  )
  const closeDashboard = useDocumentFlowStore((s) => s.closeDashboard)
  const refreshRun = useDocumentFlowStore((s) => s.refreshRun)

  // Opened on a run this client has not loaded: close again if the server does not know it.
  const missing = runId !== null && !detail
  useEffect(() => {
    if (!runId || !missing) return
    let cancelled = false
    void refreshRun(runId).then((loaded) => {
      if (!cancelled && !loaded) closeDashboard()
    })
    return () => {
      cancelled = true
    }
  }, [runId, missing, refreshRun, closeDashboard])

  return (
    <Dialog
      open={runId !== null}
      onOpenChange={(next) => {
        if (!next) closeDashboard()
      }}
    >
      <DialogContent
        data-testid="docflow-dashboard"
        data-docflow-dialog=""
        className="flex h-[80vh] max-w-5xl flex-col gap-0 overflow-hidden p-0"
      >
        {detail ? (
          <DashboardBody detail={detail} />
        ) : (
          <>
            <DialogHeader className="px-5 pt-4">
              <DialogTitle className="text-[15px]">Document run</DialogTitle>
              <DialogDescription className="sr-only">Loading the run</DialogDescription>
            </DialogHeader>
            <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading the run…
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DashboardBody({ detail }: { detail: DocumentRunDetail }): React.JSX.Element {
  const { run, items, events } = detail
  const pauseRun = useDocumentFlowStore((s) => s.pauseRun)
  const resumeRun = useDocumentFlowStore((s) => s.resumeRun)
  const finishRunNow = useDocumentFlowStore((s) => s.finishRunNow)
  const cancelRun = useDocumentFlowStore((s) => s.cancelRun)
  const deleteRun = useDocumentFlowStore((s) => s.deleteRun)
  const closeDashboard = useDocumentFlowStore((s) => s.closeDashboard)
  const openWizard = useDocumentFlowStore((s) => s.openWizard)
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null)
  const [busy, setBusy] = useState<ConfirmKind | 'pause' | null>(null)

  const status = runStatusDisplay(run, items)
  const summary = summarizeItems(items)
  const segments = progressSegments(summary)
  const active = isActiveRunStatus(run.status)

  const perform = (kind: ConfirmKind | 'pause', action: Promise<void>, failure: string): void => {
    setBusy(kind)
    action
      .catch((cause: unknown) => toast.error(`${failure}: ${errorMessage(cause)}`))
      .finally(() => setBusy(null))
  }

  const confirmed = (kind: ConfirmKind): void => {
    if (kind === 'finish') perform(kind, finishRunNow(run.id), 'Could not finish the run')
    else if (kind === 'cancel') perform(kind, cancelRun(run.id), 'Could not cancel the run')
    else perform(kind, deleteRun(run.id), 'Could not delete the run')
  }

  const copyBranch = async (): Promise<void> => {
    if (!run.integration_branch) return
    if (await copyTextToClipboard(run.integration_branch)) toast.success('Branch name copied')
    else toast.error('Could not copy the branch name')
  }

  return (
    <>
      <DialogHeader className="shrink-0 space-y-2 border-b border-border px-5 pb-3 pr-12 pt-4">
        <div className="flex items-center gap-2">
          <DialogTitle className="truncate text-[15px]" title={run.title}>
            {run.title || documentNameFromPath(run.source_path)}
          </DialogTitle>
          <TonePill tone={status.tone} className="shrink-0" testId="docflow-dashboard-status">
            {status.label}
          </TonePill>
        </div>
        <DialogDescription className="sr-only">
          Progress of the document run {run.title}
        </DialogDescription>

        {run.integration_branch && (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted-foreground">
            <GitBranch className="h-3 w-3 shrink-0" />
            <span
              className="max-w-[320px] truncate font-mono text-foreground"
              title={run.integration_branch}
              data-testid="docflow-integration-branch"
            >
              {run.integration_branch}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="Copy branch name"
              aria-label="Copy branch name"
              data-testid="docflow-copy-branch"
              onClick={() => void copyBranch()}
            >
              <Copy />
            </Button>
            {run.integration_worktree_id && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                data-testid="docflow-open-worktree"
                onClick={() => {
                  if (!run.integration_worktree_id) return
                  openWorktree(run.project_id, run.integration_worktree_id)
                  closeDashboard()
                }}
              >
                Open worktree
              </Button>
            )}
            {run.base_branch && (
              <span data-testid="docflow-base-branch-line">
                from <span className="font-mono text-foreground">{run.base_branch}</span>
                {run.base_sha && <span className="font-mono"> @ {shortSha(run.base_sha)}</span>}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <span
            className="shrink-0 text-[12px] tabular-nums text-foreground"
            data-testid="docflow-progress-label"
          >
            {summary.merged} / {summary.total} merged
          </span>
          <div
            className="flex h-1.5 min-w-0 flex-1 gap-px overflow-hidden rounded-full bg-muted"
            data-testid="docflow-progress-bar"
          >
            {segments.map((segment) => (
              <div
                key={segment.key}
                className={segment.className}
                style={{ flexGrow: segment.count }}
                title={`${segment.count} ${segment.label}`}
                data-testid={`docflow-progress-${segment.key}`}
              />
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {run.status === 'running' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="docflow-pause-btn"
                disabled={busy !== null}
                onClick={() => perform('pause', pauseRun(run.id), 'Could not pause the run')}
              >
                <Pause className="h-3.5 w-3.5" />
                Pause
              </Button>
            )}
            {run.status === 'paused' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="docflow-resume-btn"
                disabled={busy !== null}
                onClick={() => perform('pause', resumeRun(run.id), 'Could not resume the run')}
              >
                <Play className="h-3.5 w-3.5" />
                Resume
              </Button>
            )}
            {active && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="docflow-finish-btn"
                  disabled={busy !== null}
                  onClick={() => setConfirm('finish')}
                >
                  {busy === 'finish' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FlagTriangleRight className="h-3.5 w-3.5" />
                  )}
                  Finish now
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  data-testid="docflow-cancel-run-btn"
                  disabled={busy !== null}
                  onClick={() => setConfirm('cancel')}
                >
                  <X className="h-3.5 w-3.5" />
                  Cancel run
                </Button>
              </>
            )}
            {isRunDeletable(run.status) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                data-testid="docflow-delete-run-btn"
                disabled={busy !== null}
                onClick={() => setConfirm('delete')}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            )}
          </div>
        </div>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {!isLaunchedRunStatus(run.status) && (
          <div
            className="flex items-center justify-between gap-3 rounded-[8px] border border-border px-3 py-2.5"
            data-testid="docflow-dashboard-not-launched"
          >
            <p className="text-[13px] text-muted-foreground">This run has not been launched yet.</p>
            <Button
              type="button"
              size="sm"
              data-testid="docflow-dashboard-open-wizard"
              onClick={() => {
                openWizard(run.project_id, run.id)
                closeDashboard()
              }}
            >
              Review tickets
            </Button>
          </div>
        )}
        <NeedsYouSection run={run} items={items} />
        {run.report && <RunReportSection report={run.report} />}
        <RunItemsTable run={run} items={items} />
        <RunActivityLog events={events} items={items} />
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null)
        }}
      >
        <AlertDialogContent data-docflow-dialog="">
          {confirm && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{CONFIRM_COPY[confirm].title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {confirm === 'delete'
                    ? `${CONFIRM_COPY.delete.description} ${describeRunDeletion(items)}`
                    : CONFIRM_COPY[confirm].description}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="docflow-confirm-cancel">
                  {confirm === 'cancel' ? 'Keep running' : 'Cancel'}
                </AlertDialogCancel>
                <AlertDialogAction
                  variant={CONFIRM_COPY[confirm].destructive ? 'destructive' : 'default'}
                  data-testid="docflow-confirm-action"
                  onClick={() => confirmed(confirm)}
                >
                  {CONFIRM_COPY[confirm].action}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
