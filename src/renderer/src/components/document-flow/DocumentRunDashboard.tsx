import { useEffect, useState } from 'react'
import {
  CircleSlash,
  Copy,
  Database,
  ExternalLink,
  FileText,
  FlagTriangleRight,
  GitBranch,
  Loader2,
  MessageCircleQuestion,
  Pause,
  Play,
  Plus,
  Square,
  Trash2,
  X
} from 'lucide-react'
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
import { documentFlowApi } from '@/api/document-flow-api'
import { projectApi } from '@/api/project-api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { copyTextToClipboard } from '@/lib/clipboard'
import {
  applyQuestionMode,
  questionModeTargets,
  type QuestionModeResult
} from '@/lib/document-flow/question-mode'
import {
  migrationsRefusal,
  startRunMigrations,
  stopRunMigrations,
  activeConnectionIds
} from '@/lib/document-flow/migrations'
import { toast } from '@/lib/toast'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { summarizeItems } from '@shared/document-flow/planning'
import {
  isConnectionRun,
  type DocumentRun,
  type DocumentRunDetail,
  type DocumentSourceFile
} from '@shared/types/document-flow'
import { AddRunMemberDialog } from './AddRunMemberDialog'
import { TonePill } from './DocumentFlowBadges'
import { NeedsYouSection, RunItemsTable } from './DocumentRunItems'
import { RunActivityLog, RunReportSection } from './DocumentRunReport'
import { RunParallelControl } from './RunParallelControl'
import { RunProgressBar } from './RunProgressBar'
import { openConnection, openSession, openWorktree } from './document-flow-navigation'
import { useMigrationSessionWaiting } from './useDocumentRunTicket'
import {
  describeRunDeletion,
  describeRunMembers,
  documentNameFromPath,
  isActiveRunStatus,
  isLaunchedRunStatus,
  isRunDeletable,
  isRunMigrating,
  MIGRATIONS_WAITING_LABEL,
  RUNNING_MIGRATIONS_LABEL,
  progressSegments,
  runStatusDisplay,
  shortSha,
  type StatusDisplay
} from './document-flow-ui'

type ConfirmKind = 'finish' | 'cancel' | 'delete' | 'questionsOff' | 'questionsOn' | 'migrations'
type BusyKind = ConfirmKind | 'pause' | 'stopMigrations' | 'verification'

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
  },
  // Both are followed by describeQuestionModeReach(items): how many sessions get the message.
  questionsOff: {
    title: 'Are you sure? Agents will stop asking questions',
    description:
      'Tickets launched from now on are told not to ask you anything: they pick the recommended approach, and skip and document anything too pivotal to decide alone. A ticket whose agent still ends on a question or short of done is told to finish on its own, and after two reminders its branch is merged as it stands.',
    action: 'Stop asking',
    destructive: false
  },
  questionsOn: {
    title: 'Are you sure? Agents will ask questions again',
    description:
      'Tickets launched from now on are told to ask you through their question tool when they need a clarification.',
    action: 'Allow questions',
    destructive: false
  },
  // Followed by describeMigrationsLaunch(run): where the session runs.
  migrations: {
    title: 'Execute the migrations against production?',
    description:
      'A new agent session is asked to check which of the listed migrations production already has, and to run the ones it does not.',
    action: 'Execute migrations',
    destructive: false
  }
}

/** The part of the migrations confirmation that depends on the run. */
function describeMigrationsLaunch(run: DocumentRun): string {
  const where = isConnectionRun(run)
    ? `in the integration instance of ${run.integration_branch ?? 'the integration branches'}, the branches the run's tickets were merged into in every member repository`
    : `in the worktree of ${run.integration_branch ?? 'the integration branch'}, the branch the run's tickets were merged into`
  return `It runs ${where}. While it is at it the run's ticket is back In Progress, and Stop aborts the session.`
}

/** Said when "Open instance" finds the run's integration instance gone or archived. */
function instanceArchivedMessage(run: Pick<DocumentRun, 'integration_branch'>): string {
  return `The instance of ${run.integration_branch ?? 'the integration branches'} was archived.`
}

/**
 * The ids of the loaded, active connections, as the migrations gate wants them: undefined
 * while the list has not arrived, which refuses nothing. Only asked for a connection run.
 */
function useActiveConnectionIds(enabled: boolean): ReadonlySet<string> | undefined {
  const loaded = useConnectionStore((s) => s.loaded)
  const connections = useConnectionStore((s) => s.connections)
  if (!enabled) return undefined
  return activeConnectionIds({ loaded, connections })
}

/** The part of the question-mode confirmation that depends on what is running right now. */
function describeQuestionModeReach(count: number): string {
  if (count === 0) return 'No ticket of this run is in progress, so no session is messaged.'
  const tickets = count === 1 ? '1 ticket is' : `${count} tickets are`
  return `${tickets} in progress: each session that is working gets the same instruction as a queued message, which it reads when its current turn ends. A session at rest gets it with its next prompt, and a question that is already asked still waits for your answer.`
}

function describeQuestionModeResult(interactive: boolean, result: QuestionModeResult): string {
  const lead = interactive
    ? 'Agents may ask questions again.'
    : 'Agents are told not to ask questions.'
  const told = `Told ${result.told} running session${result.told === 1 ? '' : 's'}.`
  const parts = [lead, told]
  if (result.waiting > 0) {
    parts.push(`${result.waiting} will read it after you answer the question it asked.`)
  }
  if (result.skipped > 0) {
    parts.push(`${result.skipped} at rest ${result.skipped === 1 ? 'was' : 'were'} not messaged.`)
  }
  if (result.failed > 0) parts.push(`${result.failed} could not be reached.`)
  return parts.join(' ')
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** Next to a withheld "Open document": the file the run was made from is no longer on disk. */
export const DOCUMENT_DELETED_REASON = 'The document was deleted from disk.'

/**
 * Whether the run's source document is still on disk, asked of the server when the dashboard
 * opens. Null while the answer is pending; a failed check counts as missing.
 */
function useSourceFile(
  run: DocumentRun
): [DocumentSourceFile | null, (file: DocumentSourceFile) => void] {
  const [source, setSource] = useState<DocumentSourceFile | null>(null)
  useEffect(() => {
    let cancelled = false
    setSource(null)
    documentFlowApi
      .sourceFile(run.id)
      .then((file) => {
        if (!cancelled) setSource(file)
      })
      .catch(() => {
        if (!cancelled) setSource({ path: run.source_path, exists: false })
      })
    return () => {
      cancelled = true
    }
  }, [run.id, run.source_path])
  return [source, setSource]
}

/**
 * The dashboard of a launched run: a projection of the store's copy of the run, which the
 * server's pushes keep current. Nothing here drives the run; the buttons only write the
 * user's decisions (the parallel-tickets stepper too: the orchestrator reads the limit on its
 * next pass). The one that reaches further is the questions switch, which also messages the
 * run's working sessions, and so asks first.
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
  const landed = useKanbanStore((s) => {
    const column = s.tickets.get(run.project_id)?.find((t) => t.id === run.ticket_id)?.column
    return column === 'done' || column === 'merged'
  })
  const pauseRun = useDocumentFlowStore((s) => s.pauseRun)
  const resumeRun = useDocumentFlowStore((s) => s.resumeRun)
  const finishRunNow = useDocumentFlowStore((s) => s.finishRunNow)
  const cancelRun = useDocumentFlowStore((s) => s.cancelRun)
  const deleteRun = useDocumentFlowStore((s) => s.deleteRun)
  const updateRun = useDocumentFlowStore((s) => s.updateRun)
  const closeDashboard = useDocumentFlowStore((s) => s.closeDashboard)
  const openWizard = useDocumentFlowStore((s) => s.openWizard)
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null)
  const [busy, setBusy] = useState<BusyKind | null>(null)
  const [addingMember, setAddingMember] = useState(false)
  const [source, setSource] = useSourceFile(run)
  const documentMissing = source !== null && !source.exists
  // Archived with the merge of the run's ticket: no checkout is left to run a session in
  const worktreeIds = useWorktreeStore((s) => s.worktreesByProject.get(run.project_id))
  const connectionRun = isConnectionRun(run)
  const connectionIds = useActiveConnectionIds(connectionRun)
  const migrating = isRunMigrating(run)
  const migrationWaiting = useMigrationSessionWaiting(run.migration_session_id)
  const migrationsBlocked = migrating
    ? null
    : migrationsRefusal(
        run,
        worktreeIds && new Set(worktreeIds.map((worktree) => worktree.id)),
        connectionIds
      )
  const memberLines = describeRunMembers(run)

  const status: StatusDisplay =
    migrating && migrationWaiting
      ? { label: MIGRATIONS_WAITING_LABEL, tone: 'warning' }
      : runStatusDisplay(run, items)
  const summary = summarizeItems(items)
  const segments = progressSegments(summary)
  const active = isActiveRunStatus(run.status)

  const perform = (kind: BusyKind, action: Promise<void>, failure: string): void => {
    setBusy(kind)
    action
      .catch((cause: unknown) => toast.error(`${failure}: ${errorMessage(cause)}`))
      .finally(() => setBusy(null))
  }

  const confirmed = (kind: ConfirmKind): void => {
    if (kind === 'finish') perform(kind, finishRunNow(run.id), 'Could not finish the run')
    else if (kind === 'cancel') perform(kind, cancelRun(run.id), 'Could not cancel the run')
    else if (kind === 'delete') perform(kind, deleteRun(run.id), 'Could not delete the run')
    else if (kind === 'migrations') {
      perform(kind, startRunMigrations(run.id), 'Could not execute the migrations')
    } else {
      const interactive = kind === 'questionsOn'
      perform(
        kind,
        applyQuestionMode(run.id, interactive).then((result) => {
          const report = result.failed > 0 ? toast.warning : toast.success
          report(describeQuestionModeResult(interactive, result))
        }),
        'Could not change the questions setting'
      )
    }
  }

  const copyBranch = async (): Promise<void> => {
    if (!run.integration_branch) return
    if (await copyTextToClipboard(run.integration_branch)) toast.success('Branch name copied')
    else toast.error('Could not copy the branch name')
  }

  // Checked again on click: the file may have gone since the dashboard opened.
  const openDocument = async (): Promise<void> => {
    try {
      const file = await documentFlowApi.sourceFile(run.id)
      setSource(file)
      if (!file.exists) {
        toast.info(DOCUMENT_DELETED_REASON)
        return
      }
      const failure = await projectApi.openPath(file.path)
      if (failure) toast.error(`Could not open the document: ${failure}`)
    } catch (cause) {
      toast.error(`Could not open the document: ${errorMessage(cause)}`)
    }
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

        <div
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted-foreground"
          data-testid="docflow-source-line"
        >
          <FileText className="h-3 w-3 shrink-0" />
          <span
            className="max-w-[320px] truncate font-mono text-foreground"
            title={run.source_path}
            data-testid="docflow-source-path"
          >
            {documentNameFromPath(run.source_path)}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            data-testid="docflow-open-document-btn"
            disabled={source === null || documentMissing}
            title={documentMissing ? DOCUMENT_DELETED_REASON : run.source_path}
            onClick={() => void openDocument()}
          >
            <ExternalLink className="h-3 w-3" />
            Open document
          </Button>
          {/* Said in words: a disabled button shows no tooltip */}
          {documentMissing && (
            <span
              className="inline-flex items-center gap-1 text-[11px]"
              data-testid="docflow-document-missing"
            >
              <CircleSlash className="h-3 w-3" />
              {DOCUMENT_DELETED_REASON}
            </span>
          )}
        </div>

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
                  const worktreeId = run.integration_worktree_id
                  if (!worktreeId) return
                  // Archived with the merge of the run's ticket: there is nothing to select
                  const loaded = useWorktreeStore.getState().worktreesByProject.get(run.project_id)
                  if (loaded && !loaded.some((worktree) => worktree.id === worktreeId)) {
                    toast.info(`The worktree of ${run.integration_branch} was archived.`)
                    return
                  }
                  openWorktree(run.project_id, worktreeId)
                  closeDashboard()
                }}
              >
                Open worktree
              </Button>
            )}
            {run.integration_connection_id && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                data-testid="docflow-open-instance"
                onClick={() => {
                  const connectionId = run.integration_connection_id
                  if (!connectionId) return
                  // Archived with the merge of the run's ticket: there is nothing to select
                  const { loaded, connections } = useConnectionStore.getState()
                  const instance = connections.find((c) => c.id === connectionId)
                  if (loaded && (!instance || instance.status !== 'active')) {
                    toast.info(instanceArchivedMessage(run))
                    return
                  }
                  openConnection(run.project_id, connectionId)
                  closeDashboard()
                }}
              >
                Open instance
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

        {/* A connection run: the integration branch and its base in every member repository */}
        {memberLines.length > 0 && (
          <div className="pl-[18px]">
            <ul
              className="space-y-0.5 text-[11px] text-muted-foreground"
              data-testid="docflow-member-lines"
            >
              {memberLines.map((line) => (
                <li
                  key={line.projectId}
                  className="truncate font-mono"
                  title={line.label}
                  data-testid={`docflow-member-line-${line.projectId}`}
                >
                  {line.label}
                </li>
              ))}
            </ul>
            {/* A repository the project missed joins the run as if it had been there at launch */}
            {connectionRun && active && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 h-6 px-1.5 text-[11px] text-muted-foreground"
                data-testid="docflow-add-member-btn"
                disabled={busy !== null}
                title="Connect another repository to this run: it gets an integration branch and every ticket gets a worktree in it"
                onClick={() => setAddingMember(true)}
              >
                <Plus className="h-3 w-3" />
                Add repository
              </Button>
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
          <RunProgressBar segments={segments} className="flex-1" />
          <div className="flex shrink-0 items-center gap-1.5">
            {active && (
              <div className="mr-1.5 flex items-center gap-1.5">
                <label
                  htmlFor="docflow-dashboard-verification"
                  className="text-[12px] text-muted-foreground"
                  title="Off: tickets launched from now on are not asked to verify their work; each ticket's choice is kept."
                >
                  Verification
                </label>
                {/* Reaches only tickets launched after the change, so no confirmation. */}
                <Switch
                  id="docflow-dashboard-verification"
                  size="sm"
                  data-testid="docflow-dashboard-verification-switch"
                  checked={!run.config.verificationDisabled}
                  disabled={busy !== null}
                  onCheckedChange={(next) =>
                    perform(
                      'verification',
                      updateRun(run.id, { config: { verificationDisabled: !next } }).then(
                        () => undefined
                      ),
                      'Could not change the verification setting'
                    )
                  }
                />
                <label
                  htmlFor="docflow-dashboard-interactive"
                  className="ml-2 text-[12px] text-muted-foreground"
                >
                  Agents may ask me questions
                </label>
                {/* Controlled by the run: it moves only once the confirmed change is saved. */}
                <Switch
                  id="docflow-dashboard-interactive"
                  size="sm"
                  data-testid="docflow-dashboard-interactive-switch"
                  checked={run.config.interactive}
                  disabled={busy !== null}
                  onCheckedChange={(next) => setConfirm(next ? 'questionsOn' : 'questionsOff')}
                />
              </div>
            )}
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
            {isRunDeletable(run.status, run) && (
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

        {active && (
          <RunParallelControl key={run.id} run={run} items={items} disabled={busy !== null} />
        )}
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
        {run.report && (
          <RunReportSection
            report={run.report}
            landed={landed}
            migrationsAction={
              migrating ? (
                <>
                  {migrationWaiting ? (
                    <span
                      className="flex items-center gap-1.5 text-[12px] font-medium text-orange-500"
                      data-testid="docflow-migrations-waiting"
                    >
                      <MessageCircleQuestion className="h-3 w-3" />
                      {MIGRATIONS_WAITING_LABEL}
                    </span>
                  ) : (
                    <span
                      className="flex items-center gap-1.5 text-[12px] font-medium text-fuchsia-500"
                      data-testid="docflow-migrations-running"
                    >
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {RUNNING_MIGRATIONS_LABEL}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    data-testid="docflow-open-migration-session"
                    onClick={() => {
                      const sessionId = run.migration_session_id
                      if (!sessionId) return
                      openSession(
                        run.project_id,
                        run.integration_worktree_id,
                        sessionId,
                        run.integration_connection_id
                      )
                      closeDashboard()
                    }}
                  >
                    Open session
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs"
                    data-testid="docflow-stop-migrations-btn"
                    disabled={busy !== null}
                    onClick={() =>
                      perform(
                        'stopMigrations',
                        stopRunMigrations(run.id),
                        'Could not stop the migrations'
                      )
                    }
                  >
                    {busy === 'stopMigrations' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Square className="h-3 w-3" />
                    )}
                    Stop
                  </Button>
                </>
              ) : (
                <>
                  {/* Said in words: a disabled button shows no tooltip */}
                  {migrationsBlocked && (
                    <span
                      className="max-w-[420px] text-right text-[11px] leading-snug text-muted-foreground"
                      data-testid="docflow-migrations-blocked"
                    >
                      {migrationsBlocked}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs"
                    data-testid="docflow-execute-migrations-btn"
                    disabled={busy !== null || migrationsBlocked !== null}
                    title={migrationsBlocked ?? undefined}
                    onClick={() => setConfirm('migrations')}
                  >
                    {busy === 'migrations' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Database className="h-3 w-3" />
                    )}
                    Execute migrations
                  </Button>
                </>
              )
            }
          />
        )}
        <RunItemsTable run={run} items={items} />
        <RunActivityLog events={events} items={items} />
      </div>

      {isConnectionRun(run) && (
        <AddRunMemberDialog run={run} open={addingMember} onOpenChange={setAddingMember} />
      )}

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
                    : confirm === 'questionsOff' || confirm === 'questionsOn'
                      ? `${CONFIRM_COPY[confirm].description} ${describeQuestionModeReach(questionModeTargets(items).length)}`
                      : confirm === 'migrations'
                        ? `${CONFIRM_COPY.migrations.description} ${describeMigrationsLaunch(run)}`
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
