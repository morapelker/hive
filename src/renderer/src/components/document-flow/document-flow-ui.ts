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
  DOCUMENT_VERIFICATION_METHODS,
  type DocumentRun,
  type DocumentRunConfig,
  type DocumentRunDetail,
  type DocumentRunGeneration,
  type DocumentRunItem,
  type DocumentRunItemStatus,
  type DocumentRunStatus,
  type DocumentVerificationMethod
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

/** The label of a finished run while a session executes its migrations, here and on the board. */
export const RUNNING_MIGRATIONS_LABEL = 'Running migrations'
/** The same, once that session waits on the user (a question, a permission). */
export const MIGRATIONS_WAITING_LABEL = 'Migrations waiting for you'

/** A session is executing the run's migrations in its integration worktree. */
export function isRunMigrating(run: Pick<DocumentRun, 'migration_session_id'>): boolean {
  return Boolean(run.migration_session_id)
}

/**
 * A running run that cannot advance without the user reads as "Waiting for you", and a
 * finished one whose migrations are being executed as "Running migrations".
 */
export function runStatusDisplay(
  run: Pick<DocumentRun, 'status' | 'config'> & Partial<Pick<DocumentRun, 'migration_session_id'>>,
  items: readonly DocumentRunItem[]
): StatusDisplay {
  if (run.status === 'running' && isRunWaitingOnUser(items, run.config.maxParallel)) {
    return { label: 'Waiting for you', tone: 'warning' }
  }
  if (run.migration_session_id) return { label: RUNNING_MIGRATIONS_LABEL, tone: 'info' }
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

/** Not while the orchestrator owns the run, nor while a session executes its migrations. */
export function isRunDeletable(
  status: DocumentRunStatus,
  run?: Pick<DocumentRun, 'migration_session_id'>
): boolean {
  return !isActiveRunStatus(status) && !(run && isRunMigrating(run))
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

/**
 * Whether a run item's session was sent a conflict prompt and is resolving it: found by the
 * ticket the item was launched as, or by its session. The ticket's card and the session's view
 * wear the conflict colour meanwhile, whatever run the item belongs to.
 */
export function isResolvingRunConflicts(
  runsById: Record<string, DocumentRunDetail>,
  ref: { ticketId?: string | null; sessionId?: string | null }
): boolean {
  if (!ref.ticketId && !ref.sessionId) return false
  return Object.values(runsById).some((detail) =>
    detail.items.some(
      (item) =>
        item.status === 'resolving_conflicts' &&
        ((ref.ticketId !== null && ref.ticketId !== undefined && item.ticket_id === ref.ticketId) ||
          (ref.sessionId !== null &&
            ref.sessionId !== undefined &&
            item.session_id === ref.sessionId))
    )
  )
}

/** Retry / "mark done" apply to items that are waiting on the user and are not mid-merge. */
export function isRequeueableItem(item: DocumentRunItem): boolean {
  return needsUser(item) && !holdsIntegrationWorktree(item)
}

export function isSkippableItem(item: DocumentRunItem): boolean {
  return item.selected && !isTerminalItemStatus(item.status) && !holdsIntegrationWorktree(item)
}

export interface ItemSessionTarget {
  sessionId: string
  /** Git project: the worktree the session runs in. Null for a connection project. */
  worktreeId: string | null
  /** Connection project: the instance the session runs on. Null for a git project. */
  connectionId: string | null
}

/**
 * The session to open for an item: while a failed verify is being fixed that is the fix
 * session in the integration worktree (or instance), otherwise the ticket's own session.
 */
export function itemSessionTarget(
  run: Pick<DocumentRun, 'integration_worktree_id' | 'integration_connection_id'>,
  item: DocumentRunItem
): ItemSessionTarget | null {
  if (item.status === 'fixing' && item.fix_session_id) {
    return {
      sessionId: item.fix_session_id,
      worktreeId: run.integration_worktree_id,
      connectionId: run.integration_connection_id
    }
  }
  if (item.session_id) {
    return {
      sessionId: item.session_id,
      worktreeId: item.worktree_id,
      connectionId: item.connection_id
    }
  }
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

/**
 * Where a launched run stands, as its ticket on the board tells it apart. `migrating`: the run
 * is over and a session is executing its migrations, which puts the ticket back In Progress.
 */
export type RunBoardCardPhase =
  'running' | 'paused' | 'completed' | 'issues' | 'cancelled' | 'migrating'

export interface RunBoardCardState {
  title: string
  phase: RunBoardCardPhase
  merged: number
  total: number
  /** Agent sessions at work right now; checking, merging and verifying are not counted. */
  running: number
  /** While the run is on: tickets waiting on the user (a question, a permission, flagged). */
  waiting: number
  waitingOnUser: boolean
  paused: boolean
  /**
   * "3 working", "2 waiting for answer", "Paused", "Paused · 1 working" while sessions
   * finish their turn; once the
   * run ended, what is left to do: "Ready to merge into main", "2 not merged", "Cancelled";
   * and "Running migrations" while a session executes them.
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
  column?: string,
  /** The migration session waits on the user; only the session's live status can tell. */
  migrationWaiting = false
): RunBoardCardState {
  const { run, items } = detail
  const summary = summarizeItems(items)
  const running = countRunningAgents(items)
  // Only a run that is over has migrations to execute; the session outranks how it ended.
  const migrating = !isActiveRunStatus(run.status) && isRunMigrating(run)
  const phase = migrating ? 'migrating' : (RUN_BOARD_CARD_PHASES[run.status] ?? 'running')
  const workingLabel = `${running} working`
  const waiting = isActiveRunStatus(run.status)
    ? items.filter(needsUser).length
    : migrating && migrationWaiting
      ? 1
      : 0
  const moved = column === 'merged' || column === 'done'
  const notMerged = summary.total - summary.merged
  const labels: Record<RunBoardCardPhase, string> = {
    // One ticket waiting for an answer outweighs the count of those at work
    running: waiting > 0 ? `${waiting} waiting for answer` : workingLabel,
    paused: running > 0 ? `Paused · ${workingLabel}` : 'Paused',
    completed: moved ? 'Finished' : `Ready to merge into ${run.base_branch ?? 'the base branch'}`,
    issues: `Finished · ${notMerged} not merged`,
    cancelled: 'Cancelled',
    migrating: waiting > 0 ? MIGRATIONS_WAITING_LABEL : RUNNING_MIGRATIONS_LABEL
  }
  return {
    title: run.title || documentNameFromPath(run.source_path),
    phase,
    merged: summary.merged,
    total: summary.total,
    running,
    waiting,
    waitingOnUser: waiting > 0,
    paused: phase === 'paused',
    label: labels[phase]
  }
}

/**
 * Why a run's ticket cannot be dropped on `column`, or null when it can. The ticket stays In
 * Progress while the run is on (the app moves it to Review when the run ends); from then on
 * it is the user's to move forward. `status` is null when the run's record is gone. While a
 * session executes the run's migrations (`migrating`) the ticket is held In Progress again.
 */
export function documentRunTicketDropRefusal(
  status: DocumentRunStatus | null,
  column: string,
  migrating = false
): string | null {
  if (column === 'todo') return 'The ticket of a document run cannot go back to To Do.'
  const active = status !== null && isActiveRunStatus(status)
  if (migrating && !active) {
    return column === 'in_progress'
      ? null
      : 'The migrations of this document run are being executed. Wait for them to finish, or stop them, before moving its ticket.'
  }
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
  'pick' | 'loading' | 'extracting' | 'failed' | 'preview' | 'launched'

/** The wizard's step is a function of the run it points at, never separate state. */
export function wizardStep(
  runId: string | null,
  status: DocumentRunStatus | undefined
): DocumentWizardStep {
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

// ── Connection projects ────────────────────────────────────────────────────
//
// A run on a connection project has one base branch and one verify command per member
// project (`config.memberBaseBranches` / `config.memberVerifyCommands`, by member project id);
// the labels below name them member by member, in member order.

/** A member project of a connection project, as the settings and the launch summary name it. */
export interface RunMemberProject {
  id: string
  name: string
}

/** The base branch chosen for a member; null = that member's current (root checkout) branch. */
export function memberBaseBranch(
  config: Pick<DocumentRunConfig, 'memberBaseBranches'>,
  memberId: string
): string | null {
  return config.memberBaseBranches[memberId] ?? null
}

/**
 * "main (web) · master (api)": the branch each member's integration branch is cut from, with
 * `currentBranches` (by member id) standing in for members without a branch of their own.
 */
export function describeMemberBaseBranches(
  members: readonly RunMemberProject[],
  config: Pick<DocumentRunConfig, 'memberBaseBranches'>,
  currentBranches: Readonly<Record<string, string | null>>
): string {
  return members
    .map((member) => {
      const branch = memberBaseBranch(config, member.id) ?? currentBranches[member.id] ?? null
      return `${branch ?? 'the current branch'} (${member.name})`
    })
    .join(' · ')
}

/** The verify command chosen for a member, trimmed; '' when none. */
export function memberVerifyCommand(
  config: Pick<DocumentRunConfig, 'memberVerifyCommands'>,
  memberId: string
): string {
  return config.memberVerifyCommands[memberId]?.trim() ?? ''
}

/**
 * "web: pnpm check · api: none": the launch summary's verify line for a connection project;
 * "no verify command" when no member has one.
 */
export function describeMemberVerifyCommands(
  members: readonly RunMemberProject[],
  config: Pick<DocumentRunConfig, 'memberVerifyCommands'>
): string {
  if (members.every((member) => memberVerifyCommand(config, member.id) === '')) {
    return 'no verify command'
  }
  return members
    .map((member) => `${member.name}: ${memberVerifyCommand(config, member.id) || 'none'}`)
    .join(' · ')
}

/**
 * One line per member of a launched connection run — "web · doc-checkout (from main)" — for the
 * dashboard header. Empty for a git run.
 */
export function describeRunMembers(
  run: Pick<DocumentRun, 'members'>
): { projectId: string; label: string }[] {
  return (run.members ?? []).map((member) => ({
    projectId: member.project_id,
    label: `${member.project_name} · ${member.integration_branch} (from ${member.base_branch})`
  }))
}

/**
 * The branch of an item in each member — "web: a1-checkout" per line — as the branch column's
 * tooltip of a connection run. Members are named through the run's members; null when the item
 * has no member worktrees (a git run, or a ticket not launched yet).
 */
export function describeItemBranches(
  run: Pick<DocumentRun, 'members'>,
  item: Pick<DocumentRunItem, 'members'>
): string | null {
  if (!item.members || item.members.length === 0) return null
  const names = new Map(
    (run.members ?? []).map((member) => [member.project_id, member.project_name])
  )
  return item.members
    .map((member) => `${names.get(member.project_id) ?? member.project_id}: ${member.branch_name}`)
    .join('\n')
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

// ── Verification ───────────────────────────────────────────────────────────

/** Chip labels, in the user's own words for the three methods. */
export const DOCUMENT_VERIFICATION_LABELS: Record<DocumentVerificationMethod, string> = {
  tcu: 'tcu',
  playwright: 'playwright',
  tests: 'tests'
}

export const DOCUMENT_VERIFICATION_DESCRIPTIONS: Record<DocumentVerificationMethod, string> = {
  tcu: 'Computer use: drive the running desktop app with the tcu CLI',
  playwright: 'Browser: drive the app with playwright-cli over CDP (port 9222)',
  tests: 'Tests: write and run unit, integration or end-to-end tests'
}

export type VerificationChoice = Pick<
  DocumentRunItem,
  'verification' | 'verification_suggested' | 'verification_reason'
>

/** Tooltip of one verification chip: what it is, whether it is on, and what extraction said. */
export function describeVerificationChip(
  method: DocumentVerificationMethod,
  item: VerificationChoice,
  options: { disabled: boolean; readOnly: boolean }
): string {
  const on = item.verification.includes(method)
  const parts = [DOCUMENT_VERIFICATION_DESCRIPTIONS[method]]
  if (options.disabled) parts.push('verification is skipped for this run')
  else if (options.readOnly) parts.push(on ? 'on' : 'off')
  else parts.push(on ? 'on (click to turn off)' : 'off (click to turn on)')
  if (item.verification_suggested.includes(method)) {
    parts.push(
      item.verification_reason
        ? `suggested by the extraction: ${item.verification_reason}`
        : 'suggested by the extraction'
    )
  }
  return parts.join(' · ')
}

/** `current` with `method` flipped, in canonical order. */
export function toggleVerificationMethod(
  current: readonly DocumentVerificationMethod[],
  method: DocumentVerificationMethod
): DocumentVerificationMethod[] {
  return DOCUMENT_VERIFICATION_METHODS.filter((candidate) =>
    candidate === method ? !current.includes(candidate) : current.includes(candidate)
  )
}

/**
 * Whether a ticket's verification can still be changed: in the preview, and from the dashboard
 * while the run is going and the ticket waits its turn (the choice is sent with its launch).
 */
export function canEditVerification(
  run: Pick<DocumentRun, 'status'>,
  item: Pick<DocumentRunItem, 'status'>
): boolean {
  return run.status === 'preview' || (isActiveRunStatus(run.status) && item.status === 'pending')
}

/**
 * The verification line of the launch summary: "skipped for every ticket", "none", or how many
 * selected tickets use each method ("tests ×5 · playwright ×2").
 */
export function describeVerificationChoice(
  items: readonly Pick<DocumentRunItem, 'selected' | 'verification'>[],
  disabled: boolean
): string {
  if (disabled) return 'skipped for every ticket'
  const selected = items.filter((item) => item.selected)
  const parts = DOCUMENT_VERIFICATION_METHODS.flatMap((method) => {
    const count = selected.filter((item) => item.verification.includes(method)).length
    return count > 0 ? [`${DOCUMENT_VERIFICATION_LABELS[method]} ×${count}`] : []
  })
  return parts.length > 0 ? parts.join(' · ') : 'none'
}
