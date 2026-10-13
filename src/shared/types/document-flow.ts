/**
 * Shared types for the "Implement document" flow: a spec document is turned into
 * tickets by the default (PR content) model, previewed, then launched as a run.
 * The run launches every ticket in its own worktree, watches the sessions, and
 * merges finished tickets one by one into an integration branch cut from the
 * project's base branch — the base branch itself is never modified. On a
 * connection project the same happens in every member repository at once (see
 * "Connection projects" below).
 *
 * Process split:
 * - server child: persistence, document pre-processing, extraction, final-message
 *   classification, git (integration worktree, merge, verify, report) — RPC domain
 *   `documentFlow.*` (src/server/rpc/domains/document-flow.ts)
 * - renderer: the orchestrator loop (src/renderer/src/lib/document-flow/runner.ts),
 *   because ticket launch, session status and ticket column sync live there
 * - Electron main: records each CLI session's final assistant message
 *   (`session_final_messages`) from the Stop hook
 */

import type { HandoffAgentSdk } from './agent-sdk'

// ── Statuses ───────────────────────────────────────────────────────────────

export const DOCUMENT_RUN_STATUSES = [
  'extracting',
  'extract_failed',
  'preview',
  'running',
  'paused',
  'completed',
  'completed_with_issues',
  'cancelled'
] as const

/**
 * - `extracting`: the document is being pre-processed and tickets extracted
 * - `extract_failed`: extraction failed (`error` says why); can be retried
 * - `preview`: tickets extracted; the user reviews and edits them
 * - `running`: launched; the orchestrator drives it
 * - `paused`: launched, but the orchestrator takes no new action (sessions keep running)
 * - `completed`: every selected ticket is merged into the integration branch
 * - `completed_with_issues`: finished with skipped / cancelled tickets
 * - `cancelled`: stopped by the user; branches and worktrees are kept
 */
export type DocumentRunStatus = (typeof DOCUMENT_RUN_STATUSES)[number]

export const DOCUMENT_RUN_ITEM_STATUSES = [
  'pending',
  'launching',
  'running',
  'needs_input',
  'checking',
  'ready',
  'merging',
  'resolving_conflicts',
  'verifying',
  'fixing',
  'merged',
  'needs_attention',
  'skipped',
  'cancelled'
] as const

/**
 * - `pending`: waiting for its dependencies to merge, or for a free slot
 * - `launching`: worktree + session are being created
 * - `running`: the ticket's agent session is working
 * - `needs_input`: the agent is waiting for the user (question, permission, plan,
 *   or a final message that asks for something)
 * - `checking`: the turn ended; the final message is being classified
 * - `ready`: judged done; queued for the (serial) merge
 * - `merging`: being merged into the integration branch
 * - `resolving_conflicts`: the ticket's own session is merging the integration
 *   branch into its branch to resolve conflicts
 * - `verifying`: the verify command is running in the integration worktree
 * - `fixing`: a fix session in the integration worktree is repairing a failed verify
 * - `merged`: merged (and verified) into the integration branch
 * - `needs_attention`: the orchestrator gave up on this ticket; the user decides
 * - `skipped`: excluded by the user (dependents treat it as satisfied)
 * - `cancelled`: the run was cancelled before this ticket finished
 */
export type DocumentRunItemStatus = (typeof DOCUMENT_RUN_ITEM_STATUSES)[number]

/** Statuses after which the orchestrator never touches the item again. */
export const DOCUMENT_RUN_ITEM_TERMINAL_STATUSES: readonly DocumentRunItemStatus[] = [
  'merged',
  'skipped',
  'cancelled'
]

/** Statuses that occupy the integration worktree (only one item at a time). */
export const DOCUMENT_RUN_ITEM_MERGE_STATUSES: readonly DocumentRunItemStatus[] = [
  'merging',
  'verifying',
  'fixing'
]

/** Statuses that count against `maxParallel` (an agent session is, or may be, working). */
export const DOCUMENT_RUN_ITEM_ACTIVE_STATUSES: readonly DocumentRunItemStatus[] = [
  'launching',
  'running',
  'needs_input',
  'checking',
  'resolving_conflicts'
]

// ── Config ─────────────────────────────────────────────────────────────────

/** Same shape as the renderer's `LaunchModelConfig` (lib/ticket-launch.ts). */
export interface DocumentRunLaunchConfig {
  sdk: HandoffAgentSdk
  /** `variant` carries the effort level; `'ultracode'` (claude-code-cli) is ultracode. */
  model: { providerID: string; modelID: string; variant?: string } | null
  codexFastMode: boolean
  customProviderId?: string | null
}

/** The one-shot generation model: resolved exactly like the PR flow (`resolvePRContentGeneration`). */
export interface DocumentRunGeneration {
  provider: 'claude-code' | 'codex' | 'opencode'
  model?: string
  effort?: string
}

/** `full` asks the agent to research the spec with subagents first; `small` skips that. */
export type DocumentRunPromptStyle = 'full' | 'small'

export interface DocumentRunConfig {
  /** Tickets that may hold a slot at once (1 to DOCUMENT_RUN_MAX_PARALLEL_LIMIT); changeable mid-run. */
  maxParallel: number
  /** Shell command run in the integration worktree after each merge; null/empty = skip. */
  verifyCommand: string | null
  /** true: agents ask through their question tool; false: decide and say what they decided. */
  interactive: boolean
  /** Which launch prompt the ticket agents get. */
  promptStyle: DocumentRunPromptStyle
  /** Launch config for tickets without their own; null = the app's default at launch. */
  defaultLaunch: DocumentRunLaunchConfig | null
  /** Model used for extraction and final-message classification; null = provider default. */
  generation: DocumentRunGeneration | null
  /** Branch the integration branch is cut from; null = the project's default branch. */
  baseBranch: string | null
  /**
   * What the user wrote next to the document when picking it ("only tasks 7, 8 and 9"). Given
   * to the extraction model as instructions; set at creation and never changed. null = none.
   */
  notes: string | null
  /**
   * true: no ticket is asked to verify its work, whatever its own `verification` says; the
   * per-ticket choices are kept, so switching back restores them. Changeable mid-run: it
   * applies to tickets launched from then on.
   */
  verificationDisabled: boolean
  /**
   * Connection projects only: the branch each member project's integration branch is cut
   * from, by member project id; a missing or null entry = that member's default branch.
   * `baseBranch` is not read for a connection project.
   */
  memberBaseBranches: Record<string, string | null>
  /**
   * Connection projects only: the shell command run in each member's integration worktree
   * after every merge, by member project id; null/empty = skip that member. All must pass.
   * `verifyCommand` is not read for a connection project.
   */
  memberVerifyCommands: Record<string, string | null>
}

export const DOCUMENT_RUN_MAX_PARALLEL_LIMIT = 50
export const DOCUMENT_RUN_NOTES_LIMIT = 4000

export const DEFAULT_DOCUMENT_RUN_CONFIG: DocumentRunConfig = {
  maxParallel: 4,
  verifyCommand: null,
  interactive: true,
  promptStyle: 'full',
  defaultLaunch: null,
  generation: null,
  baseBranch: null,
  notes: null,
  verificationDisabled: false,
  memberBaseBranches: {},
  memberVerifyCommands: {}
}

/** The verify commands a run has: one for a git project, one per member for a connection project. */
export function runVerifyCommands(
  run: Pick<DocumentRun, 'config' | 'members'>
): { project_id: string | null; command: string }[] {
  if (run.members && run.members.length > 0) {
    return run.members.flatMap((member) => {
      const command = run.config.memberVerifyCommands[member.project_id]?.trim()
      return command ? [{ project_id: member.project_id, command }] : []
    })
  }
  const command = run.config.verifyCommand?.trim()
  return command ? [{ project_id: null, command }] : []
}

/** Whether the run verifies merges at all (the orchestrator skips the verify step otherwise). */
export function hasVerifyCommand(run: Pick<DocumentRun, 'config' | 'members'>): boolean {
  return runVerifyCommands(run).length > 0
}

// ── Extraction ─────────────────────────────────────────────────────────────

export type DocumentTicketKind = 'fix' | 'change' | 'feature' | 'data' | 'chore'
export type DocumentTicketSize = 'S' | 'M' | 'L' | 'XL'
export type DocumentTicketConflictRisk = 'low' | 'medium' | 'high'
/** What the document itself says about the task ("✓ DONE" badges and the like). */
export type DocumentTicketDocStatus = 'open' | 'done' | 'partial' | 'unknown'

/**
 * How a ticket's agent is asked to check its own work before calling it done:
 * - `tcu`: computer use — drive the running desktop app through the `tcu` CLI
 * - `playwright`: drive the app in a browser with playwright-cli over CDP (port 9222)
 * - `tests`: write and run unit / integration / e2e tests
 * Suggested per ticket at extraction, chosen in the preview, appended to the agent's brief.
 */
export const DOCUMENT_VERIFICATION_METHODS = ['tcu', 'playwright', 'tests'] as const

/** One of DOCUMENT_VERIFICATION_METHODS, which lists them in the order the UI and the brief use. */
export type DocumentVerificationMethod = (typeof DOCUMENT_VERIFICATION_METHODS)[number]

export function isDocumentVerificationMethod(value: unknown): value is DocumentVerificationMethod {
  return (DOCUMENT_VERIFICATION_METHODS as readonly unknown[]).includes(value)
}

/** The known methods of `values`, deduplicated, in canonical order. */
export function normalizeVerificationMethods(
  values: readonly unknown[] | null | undefined
): DocumentVerificationMethod[] {
  if (!values) return []
  return DOCUMENT_VERIFICATION_METHODS.filter((method) => values.includes(method))
}

export interface DocumentRunFigure {
  /** Stable id inside the document text, e.g. `fig-03`. */
  id: string
  /** Absolute path of the extracted image file. */
  path: string
  label: string
}

/** An extracted ticket before it is stored: what extraction hands to persistence. */
export interface DocumentRunItemDraft {
  key: string
  title: string
  summary: string
  description: string
  kind: DocumentTicketKind
  depends_on: string[]
  has_migration: boolean
  size: DocumentTicketSize | null
  conflict_risk: DocumentTicketConflictRisk | null
  doc_status: DocumentTicketDocStatus
  selected: boolean
  figures: DocumentRunFigure[]
  open_questions: string[]
  /** What extraction suggested the agent verifies with; never edited. */
  verification_suggested: DocumentVerificationMethod[]
  /** What the agent is asked to verify with; starts as the suggestion. Empty = nothing. */
  verification: DocumentVerificationMethod[]
  /** One line on why extraction suggested what it did; '' when it said nothing. */
  verification_reason: string
  launch_config?: DocumentRunLaunchConfig | null
}

/** Document-level facts the extraction produced; shown in the preview. */
export interface DocumentRunExtractionMeta {
  documentTitle: string
  /** How the document numbers its tasks ("A1…G1", "1…14"), if it does. */
  numbering: string | null
  /** Questions / missing inputs the document leaves open (for the user, not the agents). */
  openQuestions: string[]
  /** Problems the extractor repaired or could not resolve (dropped deps, cycles, …). */
  warnings: string[]
  /** Provider/model that produced the extraction, for display. */
  generatedBy: string | null
  /** Size of the pre-processed text in characters. */
  textLength: number
  figureCount: number
}

// ── Classification ─────────────────────────────────────────────────────────

/**
 * `waiting`: the agent stopped to wait for background work it started itself (checks, a build,
 * a Monitor) and says it will pick the task up when the results come back.
 */
export type DocumentRunVerdictStatus =
  'done' | 'needs_input' | 'blocked' | 'failed' | 'partial' | 'waiting'

/** The default model's judgement of a session's final message. */
export interface DocumentRunVerdict {
  status: DocumentRunVerdictStatus
  /** One or two sentences: why this status. */
  reason: string
  /** The exact question / request when the agent waits for the user. */
  question: string | null
  /** What the agent says it did. */
  summary: string | null
  /** Migrations the agent reports having added (paths or descriptions). */
  migrations: string[]
  /** Manual / post-production steps the agent says remain for a human. */
  manualSteps: string[]
  confidence: 'low' | 'medium' | 'high'
  /**
   * `model`: the classifier; `footer`: parsed from the STATUS footer after a classifier
   * failure; `fallback`: the classifier failed and there was no footer, so it is judged from
   * the message text and the branch's git facts (done, needs_input or blocked).
   */
  source: 'model' | 'footer' | 'fallback'
  classifiedAt: string
}

// ── Connection projects ────────────────────────────────────────────────────
//
// A run on a connection project (projects.kind = 'connection') is the same flow over N member
// repositories: the integration "worktree" is an integration INSTANCE (a connection over one
// integration worktree per member project, each cut from that member's base branch), every
// ticket launches as a new instance (a worktree per member cut from the members' integration
// branches), and a ticket is merged member by member — all or nothing: a conflict in one
// member rolls back what the others merged. Items that touch only some members merge nothing
// in the rest. The run's base/integration columns hold labels; the per-member facts are here.

/** One member repository of a run on a connection project, with its integration worktree. */
export interface DocumentRunMember {
  project_id: string
  project_name: string
  /** Root checkout of the member project. */
  project_path: string
  /** Directory name of the member inside the run's integration connection directory. */
  symlink_name: string
  base_branch: string
  /** Commit the member's integration branch was cut from. */
  base_sha: string
  integration_branch: string
  integration_worktree_id: string
  integration_worktree_path: string
}

/** A member worktree of a ticket's connection instance, with the item's merge in that member. */
export interface DocumentRunItemMember {
  project_id: string
  worktree_id: string
  branch_name: string
  /** Member integration HEAD before this item's merge (rollback target); null until merged. */
  pre_merge_sha: string | null
  /** Merge commit on the member's integration branch; null when the member had nothing new. */
  merge_sha: string | null
}

/** A run launched on a connection project (its members are known from the launch on). */
export function isConnectionRun(
  run: Pick<DocumentRun, 'members'>
): run is Pick<DocumentRun, 'members'> & { members: DocumentRunMember[] } {
  return Array.isArray(run.members) && run.members.length > 0
}

/** Whether the run has its integration checkout(s): a worktree, or a connection instance. */
export function hasIntegration(
  run: Pick<DocumentRun, 'integration_worktree_id' | 'integration_connection_id'>
): boolean {
  return run.integration_worktree_id !== null || run.integration_connection_id !== null
}

// ── Rows ───────────────────────────────────────────────────────────────────

export interface DocumentRun {
  id: string
  project_id: string
  title: string
  /** The document the user picked. */
  source_path: string
  /** App-owned directory holding the pre-processed text and extracted figures. */
  run_dir: string
  /** Pre-processed text of the document (`<run_dir>/document.md`); null until pre-processing ran. */
  document_path: string | null
  status: DocumentRunStatus
  error: string | null
  config: DocumentRunConfig
  extraction: DocumentRunExtractionMeta | null
  /**
   * Git project: the branch the integration branch was cut from. Connection project: a label
   * of the members' base branches ("main", "main + master"); the branches are in `members`.
   */
  base_branch: string | null
  /** Commit the integration branch was cut from (git projects; null for a connection project). */
  base_sha: string | null
  /**
   * Git project: the integration branch. Connection project: the name shared by the members'
   * integration branches (the first member's when they differ); see `members`.
   */
  integration_branch: string | null
  /** Git projects only: null for a connection project, whose checkouts are in `members`. */
  integration_worktree_id: string | null
  integration_worktree_path: string | null
  /**
   * Connection projects only: the run's integration INSTANCE — a connection over one
   * integration worktree per member project — and its directory (member symlinks inside).
   * The twin of `integration_worktree_id` / `integration_worktree_path`.
   */
  integration_connection_id: string | null
  integration_connection_path: string | null
  /** Connection projects only: one entry per member project, set when the run is launched. */
  members: DocumentRunMember[] | null
  /** The run's own ticket on the board, created at launch; moving it to Done merges the run. */
  ticket_id: string | null
  report: DocumentRunReport | null
  /**
   * The session executing the run's migrations in the integration worktree, started from the
   * report of a finished run; null when none is. While it is set the run's ticket is back In
   * Progress.
   */
  migration_session_id: string | null
  /** When that session was started. */
  migration_started_at: string | null
  /** Process id of the app instance that session runs in (several can share one database). */
  migration_owner_pid: number | null
  /** Client currently driving the run, and its last heartbeat (single-owner lease). */
  runner_client_id: string | null
  runner_heartbeat_at: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

export interface DocumentRunItem {
  id: string
  run_id: string
  /** The document's own identifier for the task ("A2", "14"), unique within the run. */
  key: string
  position: number
  title: string
  summary: string
  /**
   * The task as extracted: its verbatim spec text plus pointers. Kept on the item; the board
   * ticket (and so the agent's brief) is the short launch prompt, see `buildLaunchPrompt`.
   */
  description: string
  kind: DocumentTicketKind
  /** Keys of items that must be merged before this one launches. */
  depends_on: string[]
  has_migration: boolean
  size: DocumentTicketSize | null
  conflict_risk: DocumentTicketConflictRisk | null
  doc_status: DocumentTicketDocStatus
  /** Included in the run. Deselected items are never launched. */
  selected: boolean
  figures: DocumentRunFigure[]
  open_questions: string[]
  /** What extraction suggested the agent verifies with; never edited. */
  verification_suggested: DocumentVerificationMethod[]
  /**
   * What the agent is asked to verify with (see `DocumentVerificationMethod`); the user's
   * choice, starting as the suggestion. Empty = nothing. Editable until the ticket launches.
   * Ignored while the run's `verificationDisabled` is on.
   */
  verification: DocumentVerificationMethod[]
  /** One line on why extraction suggested what it did; '' when it said nothing. */
  verification_reason: string
  /** null = the run's `defaultLaunch`. */
  launch_config: DocumentRunLaunchConfig | null
  status: DocumentRunItemStatus
  /** Human-readable reason for the current status (question, error, what it waits for). */
  status_detail: string | null
  ticket_id: string | null
  /** Git projects only: the ticket's worktree. Null for a connection project (see `members`). */
  worktree_id: string | null
  /**
   * Connection projects only: the ticket's connection instance (one worktree per member
   * project, see `members`); the twin of `worktree_id`.
   */
  connection_id: string | null
  /** Connection projects only: the member worktrees of the ticket's instance, with their merges. */
  members: DocumentRunItemMember[] | null
  /** The ticket's agent session. */
  session_id: string | null
  /** Ticket of the fix session started in the integration worktree after a failed verify. */
  fix_ticket_id: string | null
  /** The fix session itself. */
  fix_session_id: string | null
  /**
   * Git project: the ticket's branch. Connection project: the name shared by the member
   * worktrees' branches (the first member's when they differ); see `members`.
   */
  branch_name: string | null
  verdict: DocumentRunVerdict | null
  /** "Finish it" nudges sent after a final message that did not read as done. */
  nudge_count: number
  /** Times the ticket session was asked to merge the same integration commit in. */
  conflict_attempts: number
  /** The integration commit the session was last asked to merge in. */
  conflict_head: string | null
  /** Fix sessions started after a failed verify. */
  fix_attempts: number
  /** "continue" prompts sent after an API error or an interrupted turn. */
  continue_attempts: number
  /** Integration HEAD before this item's merge (rollback target). Per member in `members`. */
  pre_merge_sha: string | null
  /** Git project: the merge commit. Connection project: set once every member is merged. */
  merge_sha: string | null
  /** When a prompt was last sent to the session this item is waiting on. */
  last_prompt_at: string | null
  /** End time of the turn that was last classified (never classify the same turn twice). */
  last_checked_at: string | null
  /** Earliest time for the next automatic "continue" after an API error. */
  retry_at: string | null
  /**
   * Deadline of a wait for background work the agent said it was waiting on (a `waiting`
   * verdict): past it, with no new turn, the agent is told to check on that work and finish.
   */
  wait_until: string | null
  /** Waits for background work that ran out without the agent being woken. */
  wait_timeouts: number
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

/** Append-only audit log entry. */
export interface DocumentRunEvent {
  id: number
  run_id: string
  item_id: string | null
  at: string
  /** Machine-readable kind, e.g. `launched`, `verdict`, `merged`, `conflict`, `verify_failed`. */
  type: string
  message: string
  data: unknown | null
}

export interface DocumentRunDetail {
  run: DocumentRun
  items: DocumentRunItem[]
  /** Newest last. Empty in list results. */
  events: DocumentRunEvent[]
}

// ── Report ─────────────────────────────────────────────────────────────────

/** The git summary of one member of a connection run. */
export interface DocumentRunReportMember {
  project_id: string
  project_name: string
  symlink_name: string
  integrationBranch: string
  integrationWorktreePath: string
  baseBranch: string
  baseSha: string
  headSha: string
  baseMoved: boolean
  stats: { filesChanged: number; insertions: number; deletions: number; commits: number }
}

export interface DocumentRunReport {
  generatedAt: string
  /** Connection project: the shared name of the members' integration branches (see `members`). */
  integrationBranch: string
  /** Connection project: the integration connection directory. */
  integrationWorktreePath: string | null
  baseBranch: string
  /** '' for a connection project (per member in `members`). */
  baseSha: string
  /** Integration branch HEAD. */
  headSha: string
  /** The base branch moved since the run started (by the user; the run never touches it). */
  baseMoved: boolean
  merged: { key: string; title: string; mergeSha: string | null; summary: string | null }[]
  unmerged: { key: string; title: string; status: DocumentRunItemStatus; reason: string | null }[]
  /** Migration-looking files added or changed between base and head — for the user to run. */
  migrations: string[]
  /** Manual / post-production steps collected from the agents' final messages. */
  manualSteps: string[]
  /** Summed over the members for a connection project. */
  stats: { filesChanged: number; insertions: number; deletions: number; commits: number }
  /**
   * Last verify result on the integration branch; null when no verify command is set. For a
   * connection project `command` lists the members' commands ("web: pnpm check; api: make").
   */
  verify: { command: string; ok: boolean; output: string } | null
  /** Connection projects only: the git summary of every member. */
  members?: DocumentRunReportMember[]
}

// ── RPC payloads ───────────────────────────────────────────────────────────

/** The document a run was made from, and whether that file is still on disk. */
export interface DocumentSourceFile {
  path: string
  exists: boolean
}

/** Fields of a run the renderer may change. `status` only toggles `running` ⇄ `paused`. */
export interface DocumentRunPatch {
  title?: string
  config?: Partial<DocumentRunConfig>
  status?: 'running' | 'paused'
}

/** Fields of an item the renderer may change (preview edits and orchestrator transitions). */
export interface DocumentRunItemPatch {
  title?: string
  summary?: string
  description?: string
  depends_on?: string[]
  selected?: boolean
  /** Editable in preview, and for a ticket still waiting to launch while the run is going. */
  verification?: DocumentVerificationMethod[]
  launch_config?: DocumentRunLaunchConfig | null
  status?: DocumentRunItemStatus
  status_detail?: string | null
  ticket_id?: string | null
  worktree_id?: string | null
  connection_id?: string | null
  members?: DocumentRunItemMember[] | null
  session_id?: string | null
  fix_ticket_id?: string | null
  fix_session_id?: string | null
  branch_name?: string | null
  verdict?: DocumentRunVerdict | null
  nudge_count?: number
  conflict_attempts?: number
  conflict_head?: string | null
  fix_attempts?: number
  continue_attempts?: number
  last_prompt_at?: string | null
  last_checked_at?: string | null
  retry_at?: string | null
  wait_until?: string | null
  wait_timeouts?: number
  started_at?: string | null
  finished_at?: string | null
}

/** How a migration session ended: its turn finished, or the user stopped it. */
export type DocumentMigrationOutcome = 'finished' | 'stopped'

export interface DocumentRunnerClaim {
  /** This client drives the run. */
  owned: boolean
  ownerClientId: string | null
  /** When the server process started — a session prompted before this died with the app. */
  serverStartedAt: string
}

export const SESSION_TURN_STATES = ['ended', 'blocked', 'working'] as const

/**
 * - `ended`: the main agent's turn ended (a Stop / StopFailure hook, an SDK stream going idle)
 * - `blocked`: the agent is waiting for the user (a question, a permission, a plan to approve)
 * - `working`: the agent is busy again
 */
export type SessionTurnState = (typeof SESSION_TURN_STATES)[number]

/**
 * The last thing a session's agent was seen doing, recorded by the main process so a run that
 * was not watching (its window reloaded or closed) still learns what happened. Renderer-side
 * turn status is never persisted; this row is the only durable copy.
 */
export interface SessionFinalMessage {
  session_id: string
  state: SessionTurnState
  /** Last assistant message of the turn end that last recorded one; '' when none was captured. */
  text: string
  /** `completed` | `waiting` | `unknown` for a Claude Stop; null for StopFailure / SDK / codex. */
  completion: string | null
  /** API error classification when the turn ended as StopFailure. */
  api_error: string | null
  /**
   * What recorded the row: `Stop`, `StopFailure`, `Interrupt` (the user stopped the turn),
   * `SdkIdle`, `SdkBusy`, or the blocking status (`answering`, `permission`, `plan_ready`,
   * `command_approval`).
   */
  hook_event: string
  /** For `blocked`: the question text or tool name when known. */
  detail: string | null
  /**
   * Background shells, monitors and subagents the agent had running at the Stop that recorded
   * the row (a Claude CLI session); null when the turn end could not report them.
   */
  background_work: number | null
  updated_at: string
}

export type DocumentMergeCheckState = 'clean' | 'conflict' | 'no_changes' | 'error'

/** The dry run of one member of a connection run. */
export interface DocumentMergeCheckMember {
  project_id: string
  project_name: string
  symlink_name: string
  integrationBranch: string
  /** The member integration branch's commit the dry run was made against. */
  integrationHead: string | null
  state: DocumentMergeCheckState
  /** Paths relative to the member repository (the top-level list prefixes the symlink name). */
  conflictedFiles: string[]
  commitsAhead: number
  error?: string
}

export interface DocumentMergeCheckResult {
  state: DocumentMergeCheckState
  /** Connection project: prefixed with the member's directory name (`web/src/app.ts`). */
  conflictedFiles: string[]
  /**
   * The integration branch's commit the dry run was made against (a verified tip). For a
   * connection project a composite of the members' commits, stable for equality checks only.
   */
  integrationHead?: string
  /** Connection projects only: the dry run per member. */
  members?: DocumentMergeCheckMember[]
  /** Uncommitted work in the ticket worktree was committed by the orchestrator. */
  committed: boolean
  /** Commits on the ticket branch that the integration branch does not have. */
  commitsAhead: number
  /** The ticket branch's tip is already merged into the integration branch (resume after a crash). */
  alreadyMerged?: boolean
  error?: string
}

export interface DocumentMergeResult {
  success: boolean
  mergeSha?: string
  /** The branch was already an ancestor of the integration branch. */
  alreadyMerged?: boolean
  conflictedFiles?: string[]
  error?: string
}

export interface DocumentVerifyResult {
  /** No verify command configured. */
  skipped: boolean
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  /** Tail of the combined stdout/stderr (connection project: of the failed member, or the last). */
  output: string
  /** Summed over the members for a connection project. */
  durationMs: number
  /** Connection projects only: the member whose command failed (null when all passed). */
  failedMember?: {
    project_id: string
    project_name: string
    symlink_name: string
    command: string
  } | null
}

export interface DocumentSimpleResult {
  success: boolean
  error?: string
}

export interface DocumentCommitResult extends DocumentSimpleResult {
  /** A commit was created (false: nothing to commit). */
  committed: boolean
}
