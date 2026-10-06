/**
 * Shared types for the "Implement document" flow: a spec document is turned into
 * tickets by the default (PR content) model, previewed, then launched as a run.
 * The run launches every ticket in its own worktree, watches the sessions, and
 * merges finished tickets one by one into an integration branch cut from the
 * project's base branch — the base branch itself is never modified.
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
  notes: null
}

// ── Extraction ─────────────────────────────────────────────────────────────

export type DocumentTicketKind = 'fix' | 'change' | 'feature' | 'data' | 'chore'
export type DocumentTicketSize = 'S' | 'M' | 'L' | 'XL'
export type DocumentTicketConflictRisk = 'low' | 'medium' | 'high'
/** What the document itself says about the task ("✓ DONE" badges and the like). */
export type DocumentTicketDocStatus = 'open' | 'done' | 'partial' | 'unknown'

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

export type DocumentRunVerdictStatus = 'done' | 'needs_input' | 'blocked' | 'failed' | 'partial'

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
  base_branch: string | null
  /** Commit the integration branch was cut from. */
  base_sha: string | null
  integration_branch: string | null
  integration_worktree_id: string | null
  integration_worktree_path: string | null
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
  /** The ticket description (becomes the ticket's body, and so the agent's prompt). */
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
  /** null = the run's `defaultLaunch`. */
  launch_config: DocumentRunLaunchConfig | null
  status: DocumentRunItemStatus
  /** Human-readable reason for the current status (question, error, what it waits for). */
  status_detail: string | null
  ticket_id: string | null
  worktree_id: string | null
  /** The ticket's agent session. */
  session_id: string | null
  /** Ticket of the fix session started in the integration worktree after a failed verify. */
  fix_ticket_id: string | null
  /** The fix session itself. */
  fix_session_id: string | null
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
  /** Integration HEAD before this item's merge (rollback target). */
  pre_merge_sha: string | null
  merge_sha: string | null
  /** When a prompt was last sent to the session this item is waiting on. */
  last_prompt_at: string | null
  /** End time of the turn that was last classified (never classify the same turn twice). */
  last_checked_at: string | null
  /** Earliest time for the next automatic "continue" after an API error. */
  retry_at: string | null
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

export interface DocumentRunReport {
  generatedAt: string
  integrationBranch: string
  integrationWorktreePath: string | null
  baseBranch: string
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
  stats: { filesChanged: number; insertions: number; deletions: number; commits: number }
  /** Last verify result on the integration branch; null when no verify command is set. */
  verify: { command: string; ok: boolean; output: string } | null
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
  launch_config?: DocumentRunLaunchConfig | null
  status?: DocumentRunItemStatus
  status_detail?: string | null
  ticket_id?: string | null
  worktree_id?: string | null
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
  updated_at: string
}

export type DocumentMergeCheckState = 'clean' | 'conflict' | 'no_changes' | 'error'

export interface DocumentMergeCheckResult {
  state: DocumentMergeCheckState
  conflictedFiles: string[]
  /** The integration branch's commit the dry run was made against (a verified tip). */
  integrationHead?: string
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
  /** Tail of the combined stdout/stderr. */
  output: string
  durationMs: number
}

export interface DocumentSimpleResult {
  success: boolean
  error?: string
}

export interface DocumentCommitResult extends DocumentSimpleResult {
  /** A commit was created (false: nothing to commit). */
  committed: boolean
}
