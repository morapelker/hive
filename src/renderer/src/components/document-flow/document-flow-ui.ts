import { ticketPillBaseClass } from '@/components/kanban/pill'
import type { AgentDotState } from '@/components/sidebar/agent-state'
import {
  countRunningAgents,
  isItemWaitingOnUser,
  isRunWaitingOnUser,
  isTerminalItemStatus,
  summarizeItems,
  unmetDependencies,
  type DocumentRunItemSummary
} from '@shared/document-flow/planning'
import { isActiveRunStatus } from '@shared/document-flow/run-ticket'
import {
  DOCUMENT_RUN_ITEM_MERGE_STATUSES,
  type DocumentRun,
  type DocumentRunConfig,
  type DocumentRunDetail,
  type DocumentRunGeneration,
  type DocumentRunItem,
  type DocumentRunItemStatus,
  type DocumentRunStatus
} from '@shared/types/document-flow'

// Labels, tones and small pure rules shared by the wizard, the run dashboard and the runs
// indicator. No React and no stores, so every mapping here can be tested exhaustively.

// ── Tones ──────────────────────────────────────────────────────────────────

export type DocumentFlowTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const TONE_PILL_CLASSES: Record<DocumentFlowTone, string> = {
  neutral: 'border-border bg-transparent text-muted-foreground',
  info: 'border-blue-500/30 bg-blue-500/10 text-blue-500',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'border-red-500/30 bg-red-500/10 text-red-500'
}

export function tonePillClass(tone: DocumentFlowTone): string {
  return `${ticketPillBaseClass} ${TONE_PILL_CLASSES[tone]}`
}

// ── Run status ─────────────────────────────────────────────────────────────

export const DOCUMENT_RUN_STATUS_LABELS: Record<DocumentRunStatus, string> = {
  extracting: 'Extracting',
  extract_failed: 'Extraction failed',
  preview: 'Ready to review',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  completed_with_issues: 'Completed with issues',
  cancelled: 'Cancelled'
}

export const DOCUMENT_RUN_STATUS_TONES: Record<DocumentRunStatus, DocumentFlowTone> = {
  extracting: 'info',
  extract_failed: 'danger',
  preview: 'neutral',
  running: 'info',
  paused: 'neutral',
  completed: 'success',
  completed_with_issues: 'warning',
  cancelled: 'neutral'
}

export interface StatusDisplay {
  label: string
  tone: DocumentFlowTone
}

/** A running run that cannot advance without the user reads as "Waiting for you". */
export function runStatusDisplay(
  run: Pick<DocumentRun, 'status' | 'config'>,
  items: readonly DocumentRunItem[]
): StatusDisplay {
  if (run.status === 'running' && isRunWaitingOnUser(items, run.config.maxParallel)) {
    return { label: 'Waiting for you', tone: 'warning' }
  }
  return {
    label: DOCUMENT_RUN_STATUS_LABELS[run.status],
    tone: DOCUMENT_RUN_STATUS_TONES[run.status]
  }
}

/** Launched runs live in the dashboard; everything before that belongs to the wizard. */
export function isLaunchedRunStatus(status: DocumentRunStatus): boolean {
  return (
    status === 'running' ||
    status === 'paused' ||
    status === 'completed' ||
    status === 'completed_with_issues' ||
    status === 'cancelled'
  )
}

/** The orchestrator still owns the run: item actions make sense, deleting does not. */
export { isActiveRunStatus }

export function isRunDeletable(status: DocumentRunStatus): boolean {
  return !isActiveRunStatus(status)
}

/**
 * What deleting a run does to its tickets and files. The run's own ticket goes with it. The
 * server keeps the run directory (the spec text and the figures the task tickets attach by
 * path) as long as any of those exists; a run that never launched has no tickets, so its
 * files go with it.
 */
export function describeRunDeletion(items: readonly DocumentRunItem[]): string {
  return items.some((item) => item.ticket_id)
    ? "The run's own ticket is removed from the board. Branches, worktrees and the tickets of its tasks are not touched, and the spec text and figures those tickets attach stay on disk."
    : 'Its spec text and figures are removed from disk as well.'
}

// ── Item status ────────────────────────────────────────────────────────────

export const DOCUMENT_RUN_ITEM_STATUS_LABELS: Record<DocumentRunItemStatus, string> = {
  pending: 'Queued',
  launching: 'Launching',
  running: 'Working',
  needs_input: 'Needs you',
  checking: 'Checking result',
  ready: 'Ready to merge',
  merging: 'Merging',
  resolving_conflicts: 'Resolving conflicts',
  verifying: 'Verifying',
  fixing: 'Fixing checks',
  merged: 'Merged',
  needs_attention: 'Needs attention',
  skipped: 'Skipped',
  cancelled: 'Cancelled'
}

export const DOCUMENT_RUN_ITEM_STATUS_TONES: Record<DocumentRunItemStatus, DocumentFlowTone> = {
  pending: 'neutral',
  launching: 'info',
  running: 'info',
  needs_input: 'warning',
  checking: 'info',
  ready: 'info',
  merging: 'info',
  resolving_conflicts: 'warning',
  verifying: 'info',
  fixing: 'warning',
  merged: 'success',
  needs_attention: 'danger',
  skipped: 'neutral',
  cancelled: 'neutral'
}

export const DOCUMENT_RUN_ITEM_STATUS_DOTS: Record<DocumentRunItemStatus, AgentDotState> = {
  pending: 'idle',
  launching: 'working',
  running: 'working',
  needs_input: 'question',
  checking: 'working',
  ready: 'idle',
  merging: 'working',
  resolving_conflicts: 'working',
  verifying: 'working',
  fixing: 'working',
  merged: 'done',
  needs_attention: 'blocked',
  skipped: 'idle',
  cancelled: 'idle'
}

export interface ItemStatusDisplay extends StatusDisplay {
  dot: AgentDotState
}

/** What a dashboard row says: a pending item names the dependencies it is waiting for. */
export function itemStatusDisplay(
  item: DocumentRunItem,
  items: readonly DocumentRunItem[]
): ItemStatusDisplay {
  if (!item.selected) return { label: 'Not included', tone: 'neutral', dot: 'idle' }
  // A fix or conflict session that stopped to ask reads as a question, not as work in progress.
  const asking = needsUser(item) && item.status !== 'needs_attention'
  const base: ItemStatusDisplay = {
    label: DOCUMENT_RUN_ITEM_STATUS_LABELS[item.status],
    tone: DOCUMENT_RUN_ITEM_STATUS_TONES[item.status],
    dot: asking ? 'question' : DOCUMENT_RUN_ITEM_STATUS_DOTS[item.status]
  }
  if (item.status !== 'pending') return base
  const unmet = unmetDependencies(item, items)
  return unmet.length > 0 ? { ...base, label: `Waiting for ${unmet.join(', ')}` } : base
}

/** The item cannot move on until the user looks at it. */
export function needsUser(item: DocumentRunItem): boolean {
  return item.selected && isItemWaitingOnUser(item)
}

/** The question or reason to show next to an item that needs the user. */
export function needsUserMessage(item: DocumentRunItem): string {
  return (
    item.status_detail?.trim() ||
    item.verdict?.question?.trim() ||
    item.verdict?.reason?.trim() ||
    DOCUMENT_RUN_ITEM_STATUS_LABELS[item.status]
  )
}

// While an item is being merged, verified or fixed, its merge sits in the integration worktree
// and only the orchestrator knows how to take it out again; a status change from here would
// leave the branch and the run disagreeing about what is merged. An item resolving conflicts
// is different: that merge was aborted and its session works on the ticket's own branch, so
// retrying (judge the session again) or skipping it touches nothing on the integration branch.
const holdsIntegrationWorktree = (item: DocumentRunItem): boolean =>
  DOCUMENT_RUN_ITEM_MERGE_STATUSES.includes(item.status)

/** Retry / "mark done" apply to items that are waiting on the user and are not mid-merge. */
export function isRequeueableItem(item: DocumentRunItem): boolean {
  return needsUser(item) && !holdsIntegrationWorktree(item)
}

export function isSkippableItem(item: DocumentRunItem): boolean {
  return item.selected && !isTerminalItemStatus(item.status) && !holdsIntegrationWorktree(item)
}

export interface ItemSessionTarget {
  sessionId: string
  worktreeId: string | null
}

/**
 * The session to open for an item: while a failed verify is being fixed that is the fix
 * session in the integration worktree, otherwise the ticket's own session.
 */
export function itemSessionTarget(
  run: Pick<DocumentRun, 'integration_worktree_id'>,
  item: DocumentRunItem
): ItemSessionTarget | null {
  if (item.status === 'fixing' && item.fix_session_id) {
    return { sessionId: item.fix_session_id, worktreeId: run.integration_worktree_id }
  }
  if (item.session_id) return { sessionId: item.session_id, worktreeId: item.worktree_id }
  return null
}

// ── Progress ───────────────────────────────────────────────────────────────

export interface ProgressSegment {
  key: 'merged' | 'inProgress' | 'attention' | 'pending' | 'skipped'
  label: string
  count: number
  className: string
}

/** Segments of the progress bar, in reading order; empty groups are left out. */
export function progressSegments(summary: DocumentRunItemSummary): ProgressSegment[] {
  const segments: ProgressSegment[] = [
    { key: 'merged', label: 'merged', count: summary.merged, className: 'bg-emerald-500' },
    { key: 'inProgress', label: 'working', count: summary.inProgress, className: 'bg-blue-500' },
    { key: 'attention', label: 'need you', count: summary.attention, className: 'bg-amber-500' },
    {
      key: 'pending',
      label: 'queued',
      count: summary.pending,
      className: 'bg-muted-foreground/30'
    },
    {
      key: 'skipped',
      label: 'skipped',
      count: summary.skipped,
      className: 'bg-muted-foreground/60'
    }
  ]
  return segments.filter((segment) => segment.count > 0)
}

/** "5/16 merged · 2 working" — the one-line state of a launched run. */
export function formatRunProgress(summary: DocumentRunItemSummary): string {
  return `${summary.merged}/${summary.total} merged · ${summary.inProgress} working`
}

/** The counts shown next to a run in the "Previous runs" list. */
export function runCountsLabel(detail: Pick<DocumentRunDetail, 'run' | 'items'>): string {
  const { run, items } = detail
  if (run.status === 'extracting') return 'Extracting tickets…'
  if (run.status === 'extract_failed') return 'No tickets'
  if (run.status === 'preview') {
    const selected = items.filter((item) => item.selected).length
    return `${pluralize(items.length, 'ticket')} · ${selected} selected`
  }
  const summary = summarizeItems(items)
  const attention = summary.attention > 0 ? ` · ${summary.attention} need you` : ''
  return `${summary.merged}/${summary.total} merged${attention}`
}

/** Where a launched run stands, as its ticket on the board tells it apart. */
export type RunBoardCardPhase = 'running' | 'paused' | 'completed' | 'issues' | 'cancelled'

export interface RunBoardCardState {
  title: string
  phase: RunBoardCardPhase
  segments: ProgressSegment[]
  merged: number
  total: number
  /** Agent sessions at work right now; checking, merging and verifying are not counted. */
  running: number
  /** While the run is on: a ticket waits on the user (a question, a permission, flagged). */
  waitingOnUser: boolean
  paused: boolean
  /**
   * "3 running", "Paused", "Paused · 1 running" while sessions finish their turn; once the
   * run ended, what is left to do: "Ready to merge into main", "2 not merged", "Cancelled".
   */
  label: string
}

const RUN_BOARD_CARD_PHASES: Partial<Record<DocumentRunStatus, RunBoardCardPhase>> = {
  paused: 'paused',
  completed: 'completed',
  completed_with_issues: 'issues',
  cancelled: 'cancelled'
}

/**
 * What a run's ticket on the board shows; the same notions as the dashboard and the
 * indicator. `column` is where the ticket sits: once it left Review for Merged or Done there
 * is nothing left to announce.
 */
export function runBoardCardState(
  detail: Pick<DocumentRunDetail, 'run' | 'items'>,
  column?: string
): RunBoardCardState {
  const { run, items } = detail
  const summary = summarizeItems(items)
  const running = countRunningAgents(items)
  const phase = RUN_BOARD_CARD_PHASES[run.status] ?? 'running'
  const runningLabel = `${running} running`
  const moved = column === 'merged' || column === 'done'
  const notMerged = summary.total - summary.merged
  const labels: Record<RunBoardCardPhase, string> = {
    running: runningLabel,
    paused: running > 0 ? `Paused · ${runningLabel}` : 'Paused',
    completed: moved ? 'Finished' : `Ready to merge into ${run.base_branch ?? 'the base branch'}`,
    issues: `Finished · ${notMerged} not merged`,
    cancelled: 'Cancelled'
  }
  return {
    title: run.title || documentNameFromPath(run.source_path),
    phase,
    segments: progressSegments(summary),
    merged: summary.merged,
    total: summary.total,
    running,
    waitingOnUser: isActiveRunStatus(run.status) && items.some(needsUser),
    paused: phase === 'paused',
    label: labels[phase]
  }
}

/**
 * Why a run's ticket cannot be dropped on `column`, or null when it can. The ticket stays In
 * Progress while the run is on (the app moves it to Review when the run ends); from then on
 * it is the user's to move forward. `status` is null when the run's record is gone.
 */
export function documentRunTicketDropRefusal(
  status: DocumentRunStatus | null,
  column: string
): string | null {
  if (column === 'todo') return 'The ticket of a document run cannot go back to To Do.'
  const active = status !== null && isActiveRunStatus(status)
  if (column === 'in_progress') {
    return active ? null : 'This document run is over; its ticket cannot go back to In Progress.'
  }
  if (!active) return null
  return column === 'review'
    ? 'The document run is still going; its ticket moves to Review when the run ends.'
    : 'The document run is still going. Wait for it to end, or cancel it, before merging it.'
}

// ── Wizard steps ───────────────────────────────────────────────────────────

export type DocumentWizardStep =
  'unsupported' | 'pick' | 'loading' | 'extracting' | 'failed' | 'preview' | 'launched'

/** The wizard's step is a function of the run it points at, never separate state. */
export function wizardStep(
  isConnectionProject: boolean,
  runId: string | null,
  status: DocumentRunStatus | undefined
): DocumentWizardStep {
  if (isConnectionProject) return 'unsupported'
  if (!runId) return 'pick'
  if (!status) return 'loading'
  if (status === 'extracting') return 'extracting'
  if (status === 'extract_failed') return 'failed'
  if (status === 'preview') return 'preview'
  return 'launched'
}

// ── Base branch ────────────────────────────────────────────────────────────

interface BranchCheckout {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

/**
 * The branch checked out in the project's root checkout: what a run without a base branch
 * of its own starts from. Null while unknown (list not loaded, detached HEAD).
 */
export function currentRootBranch(
  branches: readonly BranchCheckout[],
  projectPath: string
): string | null {
  const root = branches.find(
    (branch) => !branch.isRemote && branch.isCheckedOut && branch.worktreePath === projectPath
  )
  return root?.name ?? null
}

/** Label of the base-branch option that follows the root checkout. */
export function defaultBaseBranchLabel(currentBranch: string | null): string {
  return currentBranch ? `Current branch (${currentBranch})` : 'Current branch'
}

/** The branch a run is cut from, named for the launch summary. */
export function describeBaseBranch(
  config: Pick<DocumentRunConfig, 'baseBranch'>,
  currentBranch: string | null
): string {
  return config.baseBranch ?? currentBranch ?? 'the current branch'
}

// ── Document path ──────────────────────────────────────────────────────────

export const DOCUMENT_FILE_EXTENSIONS = ['.html', '.htm', '.md', '.markdown', '.mdx', '.txt']

export const DOCUMENT_FILE_ACCEPT = DOCUMENT_FILE_EXTENSIONS.join(',')

export type DocumentPathResult = { path: string; error: null } | { path: null; error: string }

// `~`, `~/…` and `~\…` pass through: the server expands them against the home directory.
const ABSOLUTE_PATH_PATTERN = /^(\/|~(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\)/

function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    const pathname = decodeURIComponent(url.pathname)
    // file:///C:/docs/spec.html → C:/docs/spec.html
    return /^\/[A-Za-z]:[\\/]/.test(pathname) ? pathname.slice(1) : pathname
  } catch {
    return null
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

/**
 * Turn what the user typed, pasted or dropped into what the server reads: an absolute path, or
 * an http(s) link the server downloads into the project directory first.
 */
export function parseDocumentPath(input: string): DocumentPathResult {
  let value = input.trim()
  // Paths copied from a terminal or Finder often arrive quoted.
  if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1).trim()
  if (!value) return { path: null, error: 'Choose a document first.' }

  if (/^https?:/i.test(value)) {
    // What the link serves is only known once it is downloaded: no extension check here.
    if (!isHttpUrl(value)) return { path: null, error: 'That link is not a valid http(s) URL.' }
    return { path: value, error: null }
  }

  if (/^file:/i.test(value)) {
    const fromUrl = fileUrlToPath(value)
    if (!fromUrl) return { path: null, error: 'That file:// URL could not be read.' }
    value = fromUrl
  }

  if (!ABSOLUTE_PATH_PATTERN.test(value)) {
    return {
      path: null,
      error: 'Enter an absolute path (or ~/…), a file:// URL or an http(s) link.'
    }
  }
  const lower = value.toLowerCase()
  if (!DOCUMENT_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return {
      path: null,
      error: `Pick an HTML, Markdown or text file (${DOCUMENT_FILE_EXTENSIONS.join(', ')}).`
    }
  }
  return { path: value, error: null }
}

export function documentNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

// ── Generation model ───────────────────────────────────────────────────────

/** "claude-code · haiku", or the provider with a note that its own default model is used. */
export function formatGeneration(generation: DocumentRunGeneration | null): string {
  if (!generation) return "the default provider's default model"
  return generation.model
    ? `${generation.provider} · ${generation.model}`
    : `${generation.provider} · the provider's default model`
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

export function formatRunDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatEventTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}
