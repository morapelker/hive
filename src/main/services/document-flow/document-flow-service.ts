/**
 * Server side of the "Implement document" flow (RPC domain `documentFlow.*`): turns a spec
 * document into previewable tickets with the generation model, launches a run (an integration
 * branch + worktree cut from the base branch, tickets on the board plus one ticket for the run
 * itself), judges sessions' final messages, and merges ticket branches into the integration
 * branch one at a time.
 *
 * On a connection project the integration worktree is an integration INSTANCE: one integration
 * worktree per member repository, connected into one directory. Every git step then runs per
 * member (`integrationCheckouts`), and a ticket's merge is all or nothing across the members.
 *
 * A run can also be made from tickets the user already has on the board (an "orchestrator",
 * `source_kind: 'tickets'`): nothing is extracted, each item points at its ticket from the
 * start, and the board's dependencies between the run's tickets are its graph — `depends_on` is
 * a cache this service keeps in step with them (`syncDependencies`, and the kanban hooks
 * `onBoardDependenciesChanged` / `onBoardTicketChanged`). Tickets can join, leave and be
 * re-linked before and while it runs; a finished one takes more and resumes. From the launch
 * on it is the same engine.
 *
 * Runs in the server child. The orchestrator loop that decides WHEN to call these lives in the
 * renderer; nothing here launches or prompts a session. The base branch is only ever read.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync, realpathSync } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { DocumentFlowUpdatedEvent } from '@shared/document-flow-events'
import {
  CLASSIFICATION_JSON_SCHEMA,
  CLASSIFICATION_SYSTEM_PROMPT,
  buildClassificationPrompt,
  fallbackVerdict,
  parseClassificationResponse,
  verdictForUnjudgedMessage
} from '@shared/document-flow/classification'
import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionMeta,
  buildExtractionPrompt,
  buildExtractionRepairPrompt,
  buildItemDrafts,
  parseExtractionResponse
} from '@shared/document-flow/extraction'
import {
  awaitsLaunch,
  integrationBranchHint,
  isTerminalItemStatus,
  sanitizeDependencies,
  ticketBranchHint
} from '@shared/document-flow/planning'
import {
  addingTicketsResumesRun,
  canAddTicketsToRun,
  defaultTicketRunTitle,
  dependsOnFromBoard,
  mintTicketRunKeys,
  runKindLabel,
  runOwnsItsTickets,
  ticketRunItemDraft,
  ticketRunRefusal,
  type TicketRunCandidate,
  type TicketRunOwner
} from '@shared/document-flow/ticket-runs'
import { ticketKeyOf } from '@shared/ticket-key'
import {
  DOCUMENT_TEXT_LIMIT,
  detectDocumentFormat,
  preprocessDocument
} from '@shared/document-flow/preprocess'
import { buildLaunchPrompt, workspaceOfMembers } from '@shared/document-flow/prompts'
import {
  renderRunStatusBlock,
  runStatusInput,
  upsertRunStatusBlock
} from '@shared/document-flow/document-status'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import type { ConnectionWithMembers } from '@shared/types/connection'
import {
  DOCUMENT_RUN_TICKET_PROVIDER,
  isActiveRunStatus,
  isEndedRunStatus
} from '@shared/document-flow/run-ticket'
import { RpcRouteError } from '@shared/rpc/errors'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  DOCUMENT_RUN_MAX_PARALLEL_LIMIT,
  normalizeVerificationMethods,
  DOCUMENT_RUN_NOTES_LIMIT,
  hasIntegration,
  hasVerifyCommand,
  isConnectionRun,
  isTicketRun,
  runVerifyCommands,
  type DocumentCommitResult,
  type DocumentMergeCheckMember,
  type DocumentMergeCheckResult,
  type DocumentMergeCheckState,
  type DocumentMergeResult,
  type DocumentMigrationOutcome,
  type DocumentRun,
  type DocumentRunAddTicketsParams,
  type DocumentRunConfig,
  type DocumentRunDetail,
  type DocumentRunGeneration,
  type DocumentRunItem,
  type DocumentRunItemDraft,
  type DocumentRunItemMember,
  type DocumentRunItemPatch,
  type DocumentRunMember,
  type DocumentRunPatch,
  type DocumentRunRemoveItemParams,
  type DocumentRunReport,
  type DocumentRunReportMember,
  type DocumentRunSetDependenciesParams,
  type DocumentRunVerdict,
  type DocumentRunnerClaim,
  type DocumentSimpleResult,
  type DocumentSourceFile,
  type DocumentSourceState,
  type DocumentTicketRunCreateParams,
  type DocumentUpdateStatus,
  type DocumentVerifyResult,
  type SessionFinalMessage
} from '@shared/types/document-flow'
import type {
  KanbanTicketBatchCreateItem,
  KanbanTicketColumn,
  KanbanTicketUpdate
} from '../../db/types'
import { createLogger } from '../logger'
import type { CreateFromBranchParams, WorktreeResult } from '../worktree-ops'
import type { DocumentFlowDb, DocumentRunItemRowPatch, DocumentRunRowPatch } from './db-port'
import { downloadDocument, isDocumentUrl, type DocumentFetch } from './document-download'
import {
  DocumentFileError,
  assertDocumentFile,
  copyRunDir,
  decodeDocument,
  documentFileExists,
  documentRunsRoot,
  normalizeDocumentPath,
  readDocumentSource,
  removeRunDir,
  replaceDocumentFile,
  writeRunFiles
} from './document-files'
import * as documentFlowGit from './document-flow-git'
import { resolveSessionFinalMessage } from './final-message'
import {
  rewriteBlocksJson,
  rewritePathsInText,
  rewriteRunPaths,
  type RunPathMap
} from './run-paths'
import { runVerifyCommand, type VerifyCommandResult } from './verify-command'

const log = createLogger({ component: 'DocumentFlow' })

/** Stands in for the app's own start time when it was not handed down (tests, server mode). */
const SERVER_STARTED_AT = new Date().toISOString()

/**
 * The main process's start time, in the environment it spawns the server child with. Sessions
 * are owned there, and several app instances share one database: the stamp is per instance.
 */
export const APP_STARTED_AT_ENV = 'HIVE_APP_STARTED_AT'
/** The same stamp as a setting, for a server child that was not handed the environment. */
export const APP_STARTED_AT_SETTING = 'app_started_at'

/** Process id of the app instance this server child belongs to, handed over by the main process. */
export const APP_PID_ENV = 'HIVE_APP_PID'

export function appPidFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const value = Number(env[APP_PID_ENV])
  return Number.isInteger(value) && value > 0 ? value : null
}

/** Whether a process with this id exists (also when it is not ours to signal). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The app's start time from `env`, when it carries one that is a date. */
export function appStartedAtFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[APP_STARTED_AT_ENV]?.trim()
  return value && Number.isFinite(Date.parse(value)) ? value : null
}

const EVENTS_IN_DETAIL = 200
/** Enough of one type of event to hold every rollback or verify run of a run. */
const EVENTS_BY_TYPE = 1000
const RUNNER_LEASE_STALE_MS = 45_000
/** A run still `extracting` this long after its last write, with no job here, lost its job. */
const STALE_EXTRACTION_MS = 15_000
const EXTRACTION_HEARTBEAT_MS = 5_000

/** How the run's event log names the column its ticket moved to. */
const RUN_TICKET_COLUMN_NAMES: Record<KanbanTicketColumn, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  merged: 'Merged',
  done: 'Done'
}
/** The model reads the repository while it extracts, so this is an agent's budget, not a reply's. */
const EXTRACTION_TIMEOUT_MS = 900_000
const CLASSIFICATION_TIMEOUT_MS = 90_000
/** Each classification spawns a CLI. */
const MAX_CONCURRENT_CLASSIFICATIONS = 3
/** Passing checks only need enough of the output to recognise them in the audit log. */
const PASSED_VERIFY_EVENT_OUTPUT_CHARS = 2000
const ERROR_MESSAGE_CHARS = 600
/** How far back the startup repair of run tickets looks; the list itself caps at this. */
const RECONCILED_RUNS = 200

export type DocumentFlowPublisher = (event: DocumentFlowUpdatedEvent) => void

export type DocumentFlowGenerate = (
  prompt: string,
  systemPrompt: string,
  provider: DocumentRunGeneration['provider'],
  options: {
    modelOverride?: string
    effort?: string
    outputSchema?: string
    cwd?: string
    /** The model may read (never change) the files under `cwd`: see GenerateTextOptions. */
    readRepository?: boolean
    timeoutMs?: number
    maxRetries?: number
  }
) => Promise<string | null>

export type DocumentFlowGit = typeof documentFlowGit

export interface DocumentFlowProject {
  id: string
  name: string
  path: string
  /** `git` (the default) or `connection`. */
  kind?: string | null
  /** Connection projects: JSON array of the member project ids. */
  member_project_ids?: string | null
}

/** A connection instance as far as a run cares: where it is, whether it is still there, who is in it. */
export interface DocumentFlowConnection {
  id: string
  path: string
  /** `active` or `archived`; a row without one counts as active. */
  status?: string
  members: { project_id: string; worktree_id: string; symlink_name: string }[]
}

/** What a run is made on: a git project, or a connection project and its member projects. */
export type DocumentFlowRunTarget =
  | { kind: 'git'; project: DocumentFlowProject }
  | { kind: 'connection'; project: DocumentFlowProject; members: DocumentFlowProject[] }

export interface DocumentFlowWorktree {
  id: string
  path: string
  branch_name: string
  /** `active` or `archived`; a row without one counts as active. */
  status?: string
  /** The branch the worktree's work is merged into from the board. */
  base_branch?: string | null
}

/**
 * A board ticket as far as a run cares: where it sits, and — for a run made from board tickets,
 * which adopts it — what decides whether it may join (see `TicketRunCandidate`) and what the
 * item copies from it. The live `getTicket` returns the whole `KanbanTicket`; a field that is
 * absent is one the board did not say.
 */
export interface DocumentFlowTicket {
  id: string
  column: KanbanTicketColumn
  project_id?: string
  title?: string
  description?: string | null
  archived_at?: string | null
  current_session_id?: string | null
  worktree_id?: string | null
  external_provider?: string | null
  external_id?: string | null
  ticket_prefix?: string | null
  ticket_number?: number | null
  pending_launch_config?: string | null
  parent_ticket_id?: string | null
}

/** A board edge: `dependent_id` waits for `blocker_id`. */
export interface DocumentFlowTicketDependency {
  dependent_id: string
  blocker_id: string
}

/**
 * What a run writes on a board ticket after creating it: the model badge and the parent link on
 * a task ticket; on the run's own ticket, its description, the title once extracted and the
 * integration worktree at launch. A ticket adopted by a run made from board tickets also loses
 * its queued launch (`pending_launch_config`): the run launches it, not the board. At launch it
 * also loses a link to a session that has closed (`current_session_id`).
 */
export type DocumentFlowTicketPatch = Pick<
  KanbanTicketUpdate,
  | 'model_provider_id'
  | 'model_id'
  | 'model_variant'
  | 'title'
  | 'description'
  | 'worktree_id'
  | 'parent_ticket_id'
  | 'pending_launch_config'
  | 'current_session_id'
>

export interface DocumentFlowServiceDeps {
  db: DocumentFlowDb
  /** Called after every write to a run, one of its items or its event log. */
  publish: DocumentFlowPublisher
  /** One-shot text generation with the run's generation model. */
  generate: DocumentFlowGenerate
  getProject: (projectId: string) => DocumentFlowProject | null
  getWorktree: (worktreeId: string) => DocumentFlowWorktree | null
  getDefaultBranch: (projectPath: string) => Promise<string>
  createWorktreeFromBranch: (params: CreateFromBranchParams) => Promise<WorktreeResult>
  /**
   * Connects `worktreeIds` (one per member project) into a new instance of the connection
   * project `savedProjectId`: the integration instance of a run on a connection project.
   */
  createConnection: (
    worktreeIds: string[],
    savedProjectId: string
  ) => Promise<{ success: boolean; connection?: DocumentFlowConnection; error?: string }>
  /** The connection instance; null when it is gone. */
  getConnection: (connectionId: string) => DocumentFlowConnection | null
  /**
   * Links one more worktree into an existing instance (a repository added to a launched run):
   * the instance's new member row, with the symlink name it got.
   */
  addConnectionMember: (
    connectionId: string,
    worktreeId: string
  ) => Promise<{
    success: boolean
    member?: { project_id: string; worktree_id: string; symlink_name: string }
    error?: string
  }>
  /**
   * Makes `memberProjectId` a member of the connection project `projectId` (idempotent), so
   * tickets launched from then on get a worktree in it. Not reachable over RPC.
   */
  addConnectionProjectMember?: (
    projectId: string,
    memberProjectId: string
  ) => Promise<{ success: boolean; error?: string }>
  /** Names an instance after the run that made it; cosmetic, so optional and never fatal. */
  renameConnection?: (connectionId: string, name: string) => Promise<unknown>
  /** Creates the tickets on the project's board; the result lists them in draft order. */
  createTickets: (
    projectId: string,
    drafts: KanbanTicketBatchCreateItem[]
  ) => Promise<{ tickets: readonly { id: string }[] }>
  /**
   * Both board backends answer `{ success, error? }`: a self-dependency, a cycle or a ticket of
   * another project is refused, not thrown.
   */
  addTicketDependency: (
    projectId: string,
    dependentTicketId: string,
    blockerTicketId: string
  ) => Promise<unknown>
  /** Drops one board edge (a no-op when there is none). */
  removeTicketDependency: (
    projectId: string,
    dependentTicketId: string,
    blockerTicketId: string
  ) => Promise<unknown>
  /** Every dependency edge on the project's board. */
  getTicketDependencies: (projectId: string) => Promise<DocumentFlowTicketDependency[]>
  /** The ticket on the project's board; null when it is gone, or when it cannot be read. */
  getTicket: (projectId: string, ticketId: string) => Promise<DocumentFlowTicket | null>
  /**
   * Whether the project's board holds cards it could not read (a markdown card with conflict
   * markers, a folder that is not there). `getTicket` answers null for those too, so on such a
   * board null is no proof that a ticket left. Unset for a board that cannot have any.
   */
  boardHasUnreadableCards?: (projectId: string) => Promise<boolean>
  /** Whether the session is still open; a ticket keeps its link to one that closed. */
  isSessionActive?: (sessionId: string) => boolean
  /** Moves the ticket to the top of `column`. */
  moveTicket: (projectId: string, ticketId: string, column: KanbanTicketColumn) => Promise<unknown>
  /** Re-stamps the model the board shows on a ticket; cosmetic, so never fatal. */
  updateTicket: (
    projectId: string,
    ticketId: string,
    patch: DocumentFlowTicketPatch
  ) => Promise<unknown>
  deleteTicket: (projectId: string, ticketId: string) => Promise<unknown>
  /**
   * A copy of the ticket in To Do, as the board's own Duplicate makes it: title, description,
   * labels, mark, note and its own copies of the attachment files; no session, worktree or
   * parent. Throws when the ticket cannot be copied.
   */
  duplicateTicket: (projectId: string, ticketId: string) => Promise<{ id: string }>
  /** Takes the ticket out of the archive, as the board's Unarchive does. */
  unarchiveTicket: (projectId: string, ticketId: string) => Promise<unknown>
  /** Records the branch a worktree's work is merged into. Not reachable over RPC. */
  setWorktreeBaseBranch: (worktreeId: string, baseBranch: string) => void
  resolveFinalMessage: (input: {
    sessionId: string
    worktreePath: string | null
  }) => Promise<string | null>
  runVerify?: (command: string, cwd: string) => Promise<VerifyCommandResult>
  /**
   * When the process that owns the sessions (Electron main) started. This service runs in the
   * server child, which can restart on its own while every session keeps running.
   */
  getAppStartedAt?: () => string | null
  /** Process id of the app instance that owns the sessions; null when it is not known. */
  getAppPid?: () => number | null
  /** Whether a process with this id is running; defaults to asking the OS. */
  isProcessAlive?: (pid: number) => boolean
  git?: DocumentFlowGit
  /**
   * Runs `task` outside the caller's RPC request context. Writes made under a request carry
   * that client's id on `db:changed`, and the client ignores its own events: the board and the
   * worktree list of whoever launched a run would never reload.
   */
  detach?: <T>(task: () => T) => T
  now?: () => Date
  /** Parent of the run directories; defaults to ~/.hive/document-runs. */
  runsRoot?: string
  homeDir?: string
  staleExtractionMs?: number
  /** Downloads a document given as a link; defaults to the global `fetch`. */
  fetch?: DocumentFetch
}

const notFound = (what: string): RpcRouteError =>
  new RpcRouteError('NOT_FOUND', `${what} was not found.`)
const invalidState = (message: string): RpcRouteError => new RpcRouteError('INVALID_STATE', message)
const invalidInput = (message: string): RpcRouteError => new RpcRouteError('INVALID_INPUT', message)

/** An error as one readable paragraph: no stack, bounded length. */
function describeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  const text = message.trim()
  if (!text) return 'Unknown error'
  return text.length > ERROR_MESSAGE_CHARS ? `${text.slice(0, ERROR_MESSAGE_CHARS)}…` : text
}

/**
 * One line that is safe inside the launcher's `<ticket title="…">` and in prompts: no double
 * quotes, angle brackets or line breaks. Same rule the extraction applies to model output.
 */
function sanitizeLine(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/["<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Most tickets one call adopts into a run made from board tickets (the RPC schema's cap too). */
export const TICKET_RUN_TICKETS_LIMIT = 200

/** "1 board ticket", "3 board tickets". */
const boardTicketCount = (count: number): string => `${count} board ticket${count === 1 ? '' : 's'}`

/** The board ticket as the eligibility rules read it; what the board did not say reads as unset. */
function ticketRunCandidate(ticket: DocumentFlowTicket, projectId: string): TicketRunCandidate {
  return {
    id: ticket.id,
    project_id: ticket.project_id ?? projectId,
    title: ticket.title ?? '',
    description: ticket.description ?? null,
    column: ticket.column,
    archived_at: ticket.archived_at ?? null,
    current_session_id: ticket.current_session_id ?? null,
    external_provider: ticket.external_provider ?? null,
    external_id: ticket.external_id ?? null,
    ticket_prefix: ticket.ticket_prefix ?? null,
    ticket_number: ticket.ticket_number ?? null,
    pending_launch_config: ticket.pending_launch_config ?? null
  }
}

/** How a message names a board ticket: its key (`TD-12`), else its title in quotes. */
function ticketLabel(ticket: TicketRunCandidate): string {
  return ticketKeyOf(ticket) ?? `“${sanitizeLine(ticket.title) || ticket.id}”`
}

/**
 * Why the board refused a dependency, from its `{ success, error }` answer; null when it took
 * it (or answered nothing, as an older backend would).
 */
function boardRefusal(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const { success, error } = result as { success?: unknown; error?: unknown }
  if (success !== false) return null
  return typeof error === 'string' && error.trim() ? error.trim() : 'The board refused it.'
}

/**
 * A cycle through `key` in `dependsOn` — `key`, then each key depending on the next, the last
 * on `key` — or null. The shortest one, found from what `key` depends on; a loop elsewhere in
 * the graph that `key` is not part of is not reported (`findDependencyCycle` would).
 */
function cycleThrough(
  key: string,
  dependsOn: Readonly<Record<string, readonly string[]>>
): string[] | null {
  const via = new Map<string, string>()
  const queue: string[] = [key]
  while (queue.length > 0) {
    const node = queue.shift() as string
    for (const next of dependsOn[node] ?? []) {
      if (via.has(next)) continue
      via.set(next, node)
      if (next === key) {
        const path: string[] = []
        for (let at = node; at !== key; at = via.get(at) as string) path.unshift(at)
        return [key, ...path]
      }
      queue.push(next)
    }
  }
  return null
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

const unique = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean))
]

function samePath(a: string, b: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return real(a) === real(b)
}

/** The member project ids a connection project row lists; anything that is not an id is dropped. */
function parseMemberProjectIds(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed)
      ? unique(parsed.filter((id): id is string => typeof id === 'string'))
      : []
  } catch {
    return []
  }
}

/**
 * One value for the N members of a connection run, where a git run has one sha: `web=<sha>,
 * api=<sha>` in member order. Compared for equality, split by `compositeParts`, never fed to git.
 */
function compositeSha(parts: readonly { symlink_name: string; sha: string | null }[]): string {
  return parts
    .filter((part): part is { symlink_name: string; sha: string } => part.sha !== null)
    .map((part) => `${part.symlink_name}=${part.sha}`)
    .join(',')
}

/** The members' base branches as one label: `main`, or `main + master` when they differ. */
function baseBranchLabel(branches: readonly string[]): string {
  return unique(branches).join(' + ')
}

/** The first member's name, which every member shares unless a hint collided somewhere. */
const sharedName = (names: readonly string[]): string | null => names[0] ?? null

/** The member a connection run's checkout belongs to; only called on connection runs' checkouts. */
function memberOf(checkout: { member: DocumentRunMember | null }): DocumentRunMember {
  if (!checkout.member) throw new Error('Not a checkout of a connection run.')
  return checkout.member
}

/** Runs tasks that share a key one after the other. */
/** What the duplicate of a run made from board tickets takes over from its original. */
interface TicketRunOrigin {
  title: string
  config: DocumentRunConfig
  /** By the id of the new ticket: what the user chose on the item its original belongs to. */
  choices: ReadonlyMap<string, Pick<DocumentRunItem, 'selected' | 'verification' | 'launch_config'>>
}

/** The item as a draft: what extraction and the user's edits made of it, nothing of what a run did. */
function draftOfItem(item: DocumentRunItem): DocumentRunItemDraft {
  return {
    key: item.key,
    title: item.title,
    summary: item.summary,
    description: item.description,
    kind: item.kind,
    depends_on: [...item.depends_on],
    has_migration: item.has_migration,
    size: item.size,
    conflict_risk: item.conflict_risk,
    doc_status: item.doc_status,
    selected: item.selected,
    figures: item.figures.map((figure) => ({ ...figure })),
    open_questions: [...item.open_questions],
    verification_suggested: [...item.verification_suggested],
    verification: [...item.verification],
    verification_reason: item.verification_reason,
    launch_config: item.launch_config ? structuredClone(item.launch_config) : null
  }
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}

class ConcurrencyLimiter {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++
    else await new Promise<void>((release) => this.waiting.push(release))
    try {
      return await task()
    } finally {
      // A waiter inherits the slot directly, so a newcomer cannot slip in between.
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

const PREVIEW_ITEM_FIELDS = [
  'title',
  'summary',
  'description',
  'depends_on',
  'selected'
] as const satisfies readonly (keyof DocumentRunItemPatch)[]

const ORCHESTRATION_ITEM_FIELDS = [
  'status',
  'status_detail',
  'ticket_id',
  'worktree_id',
  'connection_id',
  'members',
  'session_id',
  'fix_ticket_id',
  'fix_session_id',
  'branch_name',
  'verdict',
  'nudge_count',
  'conflict_attempts',
  'conflict_head',
  'fix_attempts',
  'continue_attempts',
  'last_prompt_at',
  'last_checked_at',
  'retry_at',
  'wait_until',
  'wait_timeouts',
  'document_update_status',
  'document_update_detail',
  'document_update_queued_at',
  'document_update_attempts',
  'document_update_hash',
  'document_update_report',
  'document_update_finished_at',
  'started_at',
  'finished_at'
] as const satisfies readonly (keyof DocumentRunItemPatch)[]

/** The audit event logged when an item's document update moves to each status. */
const DOCUMENT_UPDATE_EVENTS: Record<DocumentUpdateStatus, { type: string; message: string }> = {
  queued: { type: 'document_update_queued', message: 'waits to update the document' },
  updating: { type: 'document_update_started', message: 'is updating the document' },
  done: { type: 'document_updated', message: 'updated the document' },
  failed: { type: 'document_update_failed', message: 'could not update the document' },
  skipped: { type: 'document_update_skipped', message: 'did not update the document' }
}

/** How much of the source document is checked for NUL bytes before it is taken for text. */
const SOURCE_BINARY_SNIFF_BYTES = 8192
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
/**
 * Times the run status is rebuilt when the document changed between reading it and writing it
 * back (a session still editing it), before the write is given up.
 */
const RUN_STATUS_WRITE_ATTEMPTS = 3

/** `document_update_detail` of a document update the run's end left undone. */
const DOCUMENT_UPDATE_FINISHED_DETAIL = 'The run finished before this task updated the document.'
const DOCUMENT_UPDATE_CANCELLED_DETAIL =
  'The run was cancelled before this task updated the document.'

/** The patch that releases a run from its migration session. */
const NO_MIGRATION_SESSION = {
  migration_session_id: null,
  migration_started_at: null,
  migration_owner_pid: null
} as const satisfies DocumentRunRowPatch

const UNLAUNCHED_RUN_STATUSES: readonly DocumentRun['status'][] = [
  'extracting',
  'extract_failed',
  'preview'
]

/**
 * One integration checkout of a run: the integration worktree of a git project, or one
 * member's integration worktree of a connection project. Every git step of the merge phase
 * runs against one of these; a connection run has as many as members.
 */
interface IntegrationCheckout {
  /** The member this checkout belongs to; null for a git project. */
  member: DocumentRunMember | null
  path: string
  branch: string
  /** The commit the integration branch was cut from; null when the run has not recorded it. */
  baseSha: string | null
}

interface MergeContext extends IntegrationCheckout {
  ticketBranch: string
  /** null when the ticket's worktree row is gone (the branch may still exist). */
  ticketPath: string | null
  /** The ticket's worktree in this checkout's repository; null for a git project. */
  itemMember: DocumentRunItemMember | null
}

/** The dry run of a merge into one integration checkout. */
interface MergeCheck {
  state: DocumentMergeCheckState
  /** Paths relative to that checkout's repository. */
  conflictedFiles: string[]
  integrationHead: string
  commitsAhead: number
  alreadyMerged: boolean
}

/** What the merge of one member of a connection run did. */
interface MemberMerge {
  context: MergeContext
  preMergeSha: string
  /** The merge commit: the one made in this call, or one found from an earlier call. */
  mergeSha: string | null
  /** Made by this call, so a failure later in the same call resets it. */
  fresh: boolean
}

interface VerifyOutcome extends NonNullable<DocumentRunReport['verify']> {
  /** The integration commit the command ran on; null when it could not be read. */
  sha: string | null
}

export class DocumentFlowService {
  private readonly db: DocumentFlowDb
  private readonly git: DocumentFlowGit
  private readonly runVerify: (command: string, cwd: string) => Promise<VerifyCommandResult>
  private readonly detach: <T>(task: () => T) => T
  private readonly now: () => Date
  private readonly runsRoot: string
  private readonly staleExtractionMs: number

  /** One extraction per run at a time; also how a job lost to a restart is told apart. */
  private readonly extractionJobs = new Map<string, Promise<void>>()
  private readonly startsInFlight = new Map<string, Promise<DocumentRunDetail>>()
  /** Everything that writes to a run's integration worktree goes through here. */
  private readonly integrationLocks = new KeyedMutex()
  private readonly classifications = new ConcurrencyLimiter(MAX_CONCURRENT_CLASSIFICATIONS)
  /** Per run: the last verify result and the integration commit it ran on. */
  private readonly lastVerify = new Map<string, VerifyOutcome>()
  /** The merge under way per run, so that closing the run can wait for it to land or fail. */
  private readonly mergesInFlight = new Map<string, Promise<unknown>>()
  /** One writer at a time for a run's own board ticket: a launch and the startup repair. */
  private readonly runTicketLocks = new KeyedMutex()
  /** One repository joins a run at a time: two windows adding the same one must not both cut it a worktree. */
  private readonly memberLocks = new KeyedMutex()
  /**
   * A run made from board tickets: one change of its tickets or their graph at a time (adding,
   * removing, re-linking, a board change it follows, the checks and the end of its launch), so
   * two windows cannot mint the same key or adopt the same ticket twice.
   */
  private readonly ticketRunLocks = new KeyedMutex()
  /**
   * One adoption of board tickets per project at a time, from the check that a ticket is free
   * to the item that takes it: a ticket belongs to one run, and two orchestrators made at once
   * (a double click, two windows) or two runs adding the same ticket would otherwise both read
   * it as free. Taken inside a run's `ticketRunLocks`, never around one.
   */
  private readonly adoptionLocks = new KeyedMutex()

  constructor(private readonly deps: DocumentFlowServiceDeps) {
    this.db = deps.db
    this.git = deps.git ?? documentFlowGit
    this.runVerify = deps.runVerify ?? ((command, cwd) => runVerifyCommand(command, cwd))
    this.detach = deps.detach ?? ((task) => task())
    this.now = deps.now ?? (() => new Date())
    this.runsRoot = deps.runsRoot ?? documentRunsRoot(deps.homeDir)
    this.staleExtractionMs = deps.staleExtractionMs ?? STALE_EXTRACTION_MS
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  get(runId: string): DocumentRunDetail | null {
    const run = this.db.getDocumentRun(runId)
    return run ? this.detail(this.recoverInterruptedExtraction(run), true) : null
  }

  /**
   * The run's source document, and whether the file is still on disk (it is the user's file).
   * A run made from board tickets has none: '' that is not there, without asking the disk.
   */
  async sourceFile(runId: string): Promise<DocumentSourceFile> {
    const run = this.db.getDocumentRun(runId)
    if (!run) throw notFound('The run')
    if (isTicketRun(run)) return { path: '', exists: false }
    return { path: run.source_path, exists: await documentFileExists(run.source_path) }
  }

  /**
   * The run's source document as the post-merge document update sees it: whether it is there
   * and writable, its format and encoding, a hash of its bytes (to tell whether the agent
   * changed it), whether it sits in a git work tree, and where screenshots for it go. With
   * `backupKey` (the item's key) an existing file is first copied to
   * `<run_dir>/doc-backups/<KEY>-<timestamp>.<ext>`, so an edit gone wrong can be undone by
   * hand. Never throws for the file itself: a missing or unreadable one is `exists: false`.
   * A run made from board tickets has no document: nothing is read, written or backed up.
   */
  async inspectSource(runId: string, backupKey?: string | null): Promise<DocumentSourceState> {
    const run = this.requireRun(runId)
    if (isTicketRun(run)) {
      return {
        path: '',
        exists: false,
        writable: false,
        format: null,
        encoding: null,
        sha256: null,
        size: null,
        insideRepo: false,
        assetsDir: '',
        backupPath: null
      }
    }
    let path = run.source_path
    try {
      path = normalizeDocumentPath(run.source_path)
    } catch {
      // Stored by createRun, so already absolute; an odd value is reported as it is.
    }
    const extension = extname(path)
    const assetsDir = join(dirname(path), `${basename(path, extension)}.assets`)
    const state: DocumentSourceState = {
      path,
      exists: false,
      writable: false,
      format: null,
      encoding: null,
      sha256: null,
      size: null,
      insideRepo: false,
      assetsDir,
      backupPath: null
    }
    if (!(await documentFileExists(path))) return state
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch {
      return state
    }

    state.exists = true
    state.size = bytes.length
    state.sha256 = createHash('sha256').update(bytes).digest('hex')
    state.writable = await access(path, fsConstants.W_OK).then(
      () => true,
      () => false
    )
    // A binary file has no format the agent could edit as text: the step skips it.
    if (!bytes.subarray(0, SOURCE_BINARY_SNIFF_BYTES).includes(0)) {
      const { text, encoding } = decodeDocument(bytes)
      state.encoding = encoding.toLowerCase()
      state.format = detectDocumentFormat(basename(path), text.replace(/^\uFEFF/, ''))
    }
    state.insideRepo = await this.git.topLevel(dirname(path)).then(
      (root) => root !== '',
      () => false
    )

    if (backupKey) {
      const safeKey = backupKey.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'item'
      const stamp = this.now().toISOString().replace(/[:.]/g, '-')
      const backupPath = join(run.run_dir, 'doc-backups', `${safeKey}-${stamp}${extension}`)
      try {
        await mkdir(dirname(backupPath), { recursive: true })
        await writeFile(backupPath, bytes)
        state.backupPath = backupPath
      } catch (error) {
        log.warn('Could not back up the source document', {
          runId,
          backupPath,
          error: describeError(error)
        })
      }
    }
    return state
  }

  list(projectId?: string): DocumentRunDetail[] {
    return this.db
      .listDocumentRuns(projectId)
      .map((run) => this.detail(this.recoverInterruptedExtraction(run), false))
  }

  sessionTurn(sessionId: string): SessionFinalMessage | null {
    return this.db.getSessionFinalMessage(sessionId)
  }

  // ── Extraction ────────────────────────────────────────────────────────────

  async createRun(params: {
    projectId: string
    documentPath: string
    generation?: DocumentRunGeneration | null
    notes?: string | null
  }): Promise<DocumentRunDetail> {
    const project = this.deps.getProject(params.projectId)
    if (!project) throw notFound('The project')
    // A connection project without enough members has nowhere to run: said now, not at launch.
    this.resolveTarget(project)

    // A link is downloaded into the project directory first; the run then reads that file.
    // For a connection project that is the connection directory, which every member is linked
    // from; extraction reads the members through those links too.
    const link = isDocumentUrl(params.documentPath) ? params.documentPath.trim() : null
    let sourcePath: string
    try {
      sourcePath = link
        ? await downloadDocument({ url: link, targetDir: project.path, fetch: this.deps.fetch })
        : normalizeDocumentPath(params.documentPath, this.deps.homeDir)
      await assertDocumentFile(sourcePath)
    } catch (error) {
      throw invalidInput(describeError(error))
    }

    const id = randomUUID()
    let run = this.db.createDocumentRun({
      id,
      project_id: project.id,
      title: sanitizeLine(basename(sourcePath)) || 'Document',
      source_path: sourcePath,
      run_dir: join(this.runsRoot, id),
      document_path: null,
      status: 'extracting',
      config: {
        ...DEFAULT_DOCUMENT_RUN_CONFIG,
        generation: params.generation ?? null,
        notes: params.notes?.trim().slice(0, DOCUMENT_RUN_NOTES_LIMIT) || null
      }
    })
    this.publishRun(run)
    this.log(
      run,
      'created',
      link ? `Document downloaded from ${link} to ${sourcePath}` : `Document picked: ${sourcePath}`
    )
    // The run's ticket waits in To Do from the start: the board shows the extraction on it, and
    // opening it is how the run gets launched. A board that cannot be written does not stop the
    // run (the launch creates the ticket then, as it did before runs had one this early).
    run = await this.createRunTicketQuietly(run)
    this.startExtraction(run.id)
    return this.detail(run, true)
  }

  /**
   * The run's ticket in To Do, created outside the calling request so the board of whoever
   * picked the document reloads too. Never throws: the run goes on without its ticket.
   */
  private async createRunTicketQuietly(run: DocumentRun): Promise<DocumentRun> {
    try {
      return await this.detach(() => this.ensureRunTicket(run, 'todo'))
    } catch (error) {
      log.warn('Could not create the ticket of a document run', {
        runId: run.id,
        error: describeError(error)
      })
      return this.db.getDocumentRun(run.id) ?? run
    }
  }

  retryExtraction(params: {
    runId: string
    generation?: DocumentRunGeneration | null
  }): DocumentRunDetail {
    const run = this.recoverInterruptedExtraction(this.requireRun(params.runId))
    // Its items are the user's tickets: extracting would replace them with nothing.
    if (isTicketRun(run))
      throw invalidState('A run made from board tickets has nothing to extract.')
    if (run.status !== 'extract_failed' && run.status !== 'preview') {
      throw invalidState(
        run.status === 'extracting'
          ? 'The tickets are already being extracted.'
          : 'Tickets can only be extracted again before the run is launched.'
      )
    }
    const updated = this.saveRun(run, {
      status: 'extracting',
      error: null,
      ...(params.generation === undefined
        ? {}
        : { config: { ...run.config, generation: params.generation } })
    })
    this.log(updated, 'extraction_started', 'Extracting the tickets again')
    this.startExtraction(updated.id)
    return this.detail(updated, true)
  }

  /** Resolves when the run's extraction job (if any) has ended. For tests and shutdown. */
  whenExtractionSettled(runId: string): Promise<void> {
    return this.extractionJobs.get(runId) ?? Promise.resolve()
  }

  private startExtraction(runId: string): void {
    if (this.extractionJobs.has(runId)) return
    const job = this.detach(() => this.runExtraction(runId)).finally(() => {
      this.extractionJobs.delete(runId)
    })
    this.extractionJobs.set(runId, job)
  }

  private async runExtraction(runId: string): Promise<void> {
    // Several app instances share the database: the stamp tells the others, who cannot see
    // this job, that the run is still being worked on.
    const heartbeat = setInterval(() => {
      try {
        if (this.db.getDocumentRun(runId)?.status === 'extracting') {
          this.db.updateDocumentRun(runId, { status: 'extracting' })
        }
      } catch {
        // The next beat tries again.
      }
    }, EXTRACTION_HEARTBEAT_MS)
    heartbeat.unref()

    let runDir: string | null = null
    try {
      const run = this.db.getDocumentRun(runId)
      if (!run || run.status !== 'extracting') return
      runDir = run.run_dir

      const content = await readDocumentSource(run.source_path)
      const doc = preprocessDocument({ fileName: basename(run.source_path), content })
      if (doc.blocks.length === 0) {
        throw new DocumentFileError('The document has no readable text.')
      }
      if (doc.text.length > DOCUMENT_TEXT_LIMIT) {
        throw new DocumentFileError(
          `The document is too large to turn into tickets in one pass: ${doc.text.length.toLocaleString('en-US')} characters of text (the limit is ${DOCUMENT_TEXT_LIMIT.toLocaleString('en-US')}). Split it and run the parts separately.`
        )
      }

      const files = await writeRunFiles({ runDir: run.run_dir, sourcePath: run.source_path, doc })

      const generation = run.config.generation
      const provider = generation?.provider ?? 'claude-code'
      // The model works inside the project, with read-only file tools: it learns what kind of
      // app this is and how it is tested, which the document alone does not say.
      const projectPath = this.deps.getProject(run.project_id)?.path
      const options = {
        modelOverride: generation?.model,
        effort: generation?.effort,
        outputSchema: EXTRACTION_JSON_SCHEMA,
        cwd: projectPath ?? tmpdir(),
        readRepository: Boolean(projectPath),
        timeoutMs: EXTRACTION_TIMEOUT_MS,
        maxRetries: 1
      }
      let reply =
        (await this.deps.generate(
          buildExtractionPrompt(doc, run.config.notes),
          EXTRACTION_SYSTEM_PROMPT,
          provider,
          options
        )) ?? ''
      let parsed = parseExtractionResponse(reply, doc)
      if (!parsed.ok) {
        this.log(run, 'extraction_retry', `The model's reply could not be used: ${parsed.error}`)
        reply =
          (await this.deps.generate(
            buildExtractionRepairPrompt(doc, reply, parsed.error, run.config.notes),
            EXTRACTION_SYSTEM_PROMPT,
            provider,
            options
          )) ?? ''
        parsed = parseExtractionResponse(reply, doc)
        if (!parsed.ok) {
          throw new Error(`The model did not return a usable ticket list. ${parsed.error}`)
        }
      }

      // The model call takes minutes: the run may have been cancelled or deleted meanwhile.
      const current = this.db.getDocumentRun(runId)
      if (!current || current.status !== 'extracting') return

      const meta = buildExtractionMeta({
        result: parsed.result,
        doc,
        generatedBy: generation?.model
          ? `${provider} · ${generation.model}`
          : `${provider} (default model)`
      })
      const items = this.db.replaceDocumentRunItems(
        runId,
        buildItemDrafts({
          result: parsed.result,
          doc,
          sourcePath: run.source_path,
          documentPath: files.documentPath,
          figurePaths: files.figurePaths
        })
      )
      const updated = this.saveRun(current, {
        status: 'preview',
        title: sanitizeLine(meta.documentTitle) || current.title,
        document_path: files.documentPath,
        extraction: meta,
        error: null
      })
      this.log(updated, 'extracted', `${items.length} tickets extracted`, {
        data: { tickets: items.length, figures: meta.figureCount, generatedBy: meta.generatedBy }
      })
      // The ticket was named after the file; the document's own title is known only now.
      if (updated.title !== current.title) await this.stampRunTicketTitle(updated)
    } catch (error) {
      this.failExtraction(runId, describeError(error))
    } finally {
      clearInterval(heartbeat)
      // Deleted while its tickets were being extracted: the files written since would be orphans.
      if (runDir && !this.db.getDocumentRun(runId)) {
        await removeRunDir(runDir, this.runsRoot).catch(() => undefined)
      }
    }
  }

  private failExtraction(runId: string, message: string): void {
    try {
      const run = this.db.getDocumentRun(runId)
      if (!run || run.status !== 'extracting') return
      const updated = this.saveRun(run, { status: 'extract_failed', error: message })
      this.log(updated, 'extract_failed', message)
    } catch (error) {
      log.warn('Could not record a failed extraction', { runId, error: describeError(error) })
    }
  }

  /** A run left `extracting` by a server that restarted mid-job would otherwise spin forever. */
  private recoverInterruptedExtraction(run: DocumentRun): DocumentRun {
    if (run.status !== 'extracting' || this.extractionJobs.has(run.id)) return run
    const idleMs = this.now().getTime() - Date.parse(run.updated_at)
    if (!(idleMs > this.staleExtractionMs)) return run
    const message = 'Extraction was interrupted. Try again.'
    const updated = this.saveRun(run, { status: 'extract_failed', error: message })
    this.log(updated, 'extract_failed', message)
    return updated
  }

  // ── Runs made from board tickets ──────────────────────────────────────────

  /**
   * An orchestrator made from tickets the user already has on the board, straight into the
   * preview (there is nothing to extract): one item per ticket in the order given, linked to
   * its ticket from the start, keyed by the ticket's key, its title and description copied for
   * display only (the ticket itself is the brief, read when it launches), its model taken from
   * a queued launch. The board's dependencies between these tickets are its graph. Every ticket
   * is checked (`ticketRunRefusal`), and one that cannot join refuses the whole call, naming
   * each one and why. Adopted tickets lose their queued launch, since the run launches them,
   * and one that "Save & Queue" left In Progress without a session goes back to To Do. The
   * run's own ticket waits in To Do as the parent of the adopted ones, as a document run's does.
   */
  async createTicketRun(params: DocumentTicketRunCreateParams): Promise<DocumentRunDetail> {
    const project = this.deps.getProject(params.projectId)
    if (!project) throw notFound('The project')
    // A connection project without enough members has nowhere to run: said now, not at launch.
    this.resolveTarget(project, 'tickets')
    const ticketIds = this.requireTicketIds(params.ticketIds)

    // Detached, like the run's ticket of a document run: the board of whoever asked reloads
    // with the adopted tickets as they are now.
    return this.detach(() =>
      this.adoptionLocks.run(project.id, () => this.makeTicketRun(project, ticketIds, params))
    )
  }

  private async makeTicketRun(
    project: DocumentFlowProject,
    ticketIds: readonly string[],
    params: DocumentTicketRunCreateParams,
    // A duplicate (`duplicateRun`): the original's config, and its choices per ticket.
    origin: TicketRunOrigin | null = null
  ): Promise<DocumentRunDetail> {
    // Under the adoption lock of the project: see `adoptionLocks`.
    const tickets = await this.adoptableTickets(project.id, ticketIds, null)
    // Read before anything is written: a board that cannot be read makes no half a run.
    const edges = await this.deps.getTicketDependencies(project.id)
    const keys = mintTicketRunKeys(tickets)
    const id = randomUUID()
    let run = this.db.createDocumentRun({
      id,
      project_id: project.id,
      title:
        sanitizeLine(params.title ?? '') ||
        sanitizeLine(defaultTicketRunTitle(tickets)) ||
        runKindLabel({ source_kind: 'tickets' }),
      source_kind: 'tickets',
      source_path: '',
      // Named like every run's; nothing is ever written there (no document, no figures).
      run_dir: join(this.runsRoot, id),
      document_path: null,
      status: 'preview',
      config: origin
        ? structuredClone(origin.config)
        : { ...DEFAULT_DOCUMENT_RUN_CONFIG, generation: params.generation ?? null }
    })
    this.db.insertDocumentRunItems(
      run.id,
      this.ticketItemDrafts(tickets, keys).map((draft) => {
        const chosen = origin?.choices.get(draft.ticket_id)
        if (!chosen) return draft
        return {
          ...draft,
          selected: chosen.selected,
          verification: [...chosen.verification],
          launch_config: chosen.launch_config ? structuredClone(chosen.launch_config) : null
        }
      })
    )
    this.publishRun(run)
    this.log(
      run,
      'created',
      origin
        ? `Duplicated from “${origin.title}” with ${boardTicketCount(tickets.length)}: ${keys.join(', ')}`
        : `Orchestrator made from ${boardTicketCount(tickets.length)}: ${keys.join(', ')}`,
      { data: { ticketIds: tickets.map((ticket) => ticket.id) } }
    )
    this.writeDependencies(run, edges)
    // The parent link comes with the run's ticket (`linkChildTickets`).
    await this.releaseAdoptedTickets(run, tickets, null)
    run = await this.createRunTicketQuietly(run)
    return this.detail(run, true)
  }

  /**
   * More board tickets for a run made from them: before its launch, while it runs (each waits
   * for its dependencies and a free slot, like any ticket that has not launched), or once it
   * finished, which resumes it on its integration branch with its report cleared and its
   * ticket back In Progress. Tickets already in the run are left as they are; the others are
   * checked as at creation and come after the run's last ticket, with keys of their own.
   * Refused once the run is cancelled, while a session executes its migrations, and for a
   * finished run whose integration branch is gone.
   */
  async addTickets(params: DocumentRunAddTicketsParams): Promise<DocumentRunDetail> {
    const ticketIds = this.requireTicketIds(params.ticketIds)
    // Refused up front so the caller hears it at once; checked again under the run's lock.
    this.requireRunTakingTickets(params.runId)
    return this.detach(() =>
      this.ticketRunLocks.run(params.runId, () => this.adoptTickets(params.runId, ticketIds))
    )
  }

  /**
   * Takes a ticket out of a run made from board tickets while it has not launched: before the
   * launch, or while it waits its turn (or its launch failed and left it with no session). The
   * item goes; the ticket stays on the board, free again (its link to the run's ticket is
   * dropped), and nothing waits for it any more. A launched ticket is skipped instead.
   */
  async removeItem(params: DocumentRunRemoveItemParams): Promise<DocumentRunDetail> {
    const { run, item } = this.requireItem(params.runId, params.itemId)
    this.assertTicketOpenToChange(run, item, 'remove')
    this.assertRunKeepsATicket(run, item)
    return this.detach(() =>
      this.ticketRunLocks.run(run.id, () => this.dropItem(run.id, params.itemId))
    )
  }

  /**
   * What an item of a run made from board tickets starts after (keys of the run's other items;
   * the list replaces the current one). The board's dependencies are the graph, so this writes
   * them — between this ticket and the run's other tickets only: an edge to a ticket outside
   * the run is the board's own business and stays — and the items follow. Refused for a change
   * that would make a cycle (checked here, before the board is touched), and once the item has
   * launched: what a launched ticket waited for is history.
   */
  async setItemDependencies(params: DocumentRunSetDependenciesParams): Promise<DocumentRunDetail> {
    const { run, item } = this.requireItem(params.runId, params.itemId)
    this.assertTicketOpenToChange(run, item, 'relink')
    return this.detach(() =>
      this.ticketRunLocks.run(run.id, () =>
        this.relinkItem(run.id, params.itemId, params.dependsOn)
      )
    )
  }

  /**
   * Kanban hook: the board's dependencies changed around these tickets. Every run made from
   * board tickets that holds one of them re-derives its graph. Never throws: the board change
   * stands either way, and the next sync (a launch, an edit) catches up.
   */
  async onBoardDependenciesChanged(projectId: string, ticketIds: readonly string[]): Promise<void> {
    try {
      for (const runId of this.ticketRunsHolding(projectId, ticketIds)) {
        await this.followBoard(runId, async (run) => {
          await this.syncDependencies(run)
        })
      }
    } catch (error) {
      log.warn('Could not follow a dependency change on the board', {
        projectId,
        ticketIds,
        error: describeError(error)
      })
    }
  }

  /**
   * Kanban hook: a board ticket was edited, archived, deleted or moved to another project.
   * Every run made from board tickets that holds it refreshes its copy of the ticket's title
   * and description; one that left the board or was archived leaves the run while it has not
   * launched (a launched one stays, and the run reports its ticket gone), unless it is the last
   * ticket of a launched run or the board has cards it cannot read. Never throws.
   */
  async onBoardTicketChanged(projectId: string, ticketId: string): Promise<void> {
    try {
      for (const runId of this.ticketRunsHolding(projectId, [ticketId])) {
        await this.followBoard(runId, (run) => this.followBoardTickets(run, [ticketId]))
      }
    } catch (error) {
      log.warn('Could not follow a ticket change on the board', {
        projectId,
        ticketId,
        error: describeError(error)
      })
    }
  }

  /**
   * Startup: the runs made from board tickets catch up with what changed on the board while no
   * service was there to hear it (the kanban hooks only reach a live one). Nobody is watching
   * this one, and a board that cannot be read right now looks like one whose tickets left, so a
   * ticket that reads as missing stays for the user to see: the launch and the runner report it.
   * Safe to repeat; never throws.
   */
  async refreshTicketRuns(): Promise<void> {
    let runs: DocumentRun[]
    try {
      runs = this.db.listDocumentRuns(undefined, RECONCILED_RUNS)
    } catch (error) {
      log.warn('Could not list the orchestrators to refresh', { error: describeError(error) })
      return
    }
    for (const listed of runs) {
      if (!this.followsBoard(listed)) continue
      try {
        await this.followBoard(listed.id, (run) => this.followBoardTickets(run, null))
      } catch (error) {
        log.warn('Could not refresh an orchestrator from the board', {
          runId: listed.id,
          error: describeError(error)
        })
      }
    }
  }

  /** The ids, trimmed and deduplicated, of a call that adopts tickets: at least one, capped. */
  private requireTicketIds(ticketIds: readonly string[]): string[] {
    const ids = unique(ticketIds)
    if (ids.length === 0) throw invalidInput('Pick at least one ticket.')
    if (ids.length > TICKET_RUN_TICKETS_LIMIT) {
      throw invalidInput(`Pick at most ${TICKET_RUN_TICKETS_LIMIT} tickets at a time.`)
    }
    return ids
  }

  /**
   * The tickets, in the order asked for, as the board has them now — or a refusal naming every
   * one that cannot join (`ticketRunRefusal`): gone from this board, the ticket of a run, a
   * shell command, archived, held by another run, launched already, or past To Do. `runId` is
   * the run they would join, if it exists.
   */
  private async adoptableTickets(
    projectId: string,
    ticketIds: readonly string[],
    runId: string | null
  ): Promise<TicketRunCandidate[]> {
    const tickets: TicketRunCandidate[] = []
    const refusals: { label: string; reason: string }[] = []
    for (const ticketId of ticketIds) {
      const found = await this.deps.getTicket(projectId, ticketId)
      if (!found || (found.project_id !== undefined && found.project_id !== projectId)) {
        refusals.push({ label: 'A ticket', reason: "It is no longer on this project's board." })
        continue
      }
      const ticket = ticketRunCandidate(found, projectId)
      const reason = ticketRunRefusal(ticket, this.ticketOwner(ticket.id), runId)
      if (reason) refusals.push({ label: ticketLabel(ticket), reason })
      else tickets.push(ticket)
    }
    if (refusals.length === 1) {
      throw invalidInput(`${refusals[0].label} cannot be orchestrated: ${refusals[0].reason}`)
    }
    if (refusals.length > 1) {
      throw invalidInput(
        `${refusals.length} tickets cannot be orchestrated. ${refusals.map(({ label, reason }) => `${label}: ${reason}`).join(' ')}`
      )
    }
    return tickets
  }

  /** The run that holds the ticket now (one that still owns its tickets), if any. */
  private ticketOwner(ticketId: string): TicketRunOwner | null {
    for (const item of this.db.findDocumentRunItemsByTicketId(ticketId)) {
      const run = this.db.getDocumentRun(item.run_id)
      if (run && runOwnsItsTickets(run.status)) {
        return { runId: run.id, title: run.title, status: run.status }
      }
    }
    return null
  }

  /** The items of adopted tickets: no extraction, the ticket is the task; titles kept to one safe line. */
  private ticketItemDrafts(
    tickets: readonly TicketRunCandidate[],
    keys: readonly string[]
  ): ReturnType<typeof ticketRunItemDraft>[] {
    return tickets.map((ticket, index) => {
      const draft = ticketRunItemDraft(ticket, keys[index])
      return { ...draft, title: sanitizeLine(draft.title) || draft.key }
    })
  }

  /**
   * What adoption changes on the tickets themselves: a queued launch goes (the board would
   * otherwise launch the ticket on its own once its blockers are done), a ticket "Save &
   * Queue" left In Progress without a session goes back to To Do, and with `parentId` the
   * ticket points at the run's ticket. Never fatal: the run holds the ticket either way.
   */
  private async releaseAdoptedTickets(
    run: DocumentRun,
    tickets: readonly TicketRunCandidate[],
    parentId: string | null
  ): Promise<void> {
    for (const ticket of tickets) {
      const patch: DocumentFlowTicketPatch = {}
      if (ticket.pending_launch_config) patch.pending_launch_config = null
      if (parentId) patch.parent_ticket_id = parentId
      try {
        if (Object.keys(patch).length > 0) {
          await this.deps.updateTicket(run.project_id, ticket.id, patch)
        }
        if (ticket.column === 'in_progress' && !ticket.current_session_id) {
          // Read again: the run holds the ticket by now, and may have launched it meanwhile.
          const latest = await this.deps.getTicket(run.project_id, ticket.id)
          if (latest?.column === 'in_progress' && !latest.current_session_id) {
            await this.deps.moveTicket(run.project_id, ticket.id, 'todo')
          }
        }
      } catch (error) {
        log.warn('Could not hand a ticket over to its orchestrator', {
          runId: run.id,
          ticketId: ticket.id,
          error: describeError(error)
        })
      }
    }
  }

  /**
   * The run, if it takes tickets now: one made from board tickets, not cancelled, no session
   * executing its migrations, and — finished — still on its integration branch to resume on.
   */
  private requireRunTakingTickets(runId: string): DocumentRun {
    const run = this.requireRun(runId)
    if (!isTicketRun(run)) {
      throw invalidState('A document run gets its tickets from its document; it takes no others.')
    }
    if (!canAddTicketsToRun(run)) {
      throw invalidState(
        run.migration_session_id
          ? 'A session is executing the migrations of this orchestrator; add tickets once it is done.'
          : run.status === 'cancelled'
            ? 'This orchestrator was cancelled; it takes no more tickets.'
            : `This orchestrator takes no tickets while it is ${run.status.replace(/_/g, ' ')}.`
      )
    }
    if (addingTicketsResumesRun(run) && !(hasIntegration(run) && this.integrationIsActive(run))) {
      throw invalidState(
        'This orchestrator has finished and its integration branch is gone, so it cannot resume with more tickets.'
      )
    }
    return run
  }

  private async adoptTickets(
    runId: string,
    ticketIds: readonly string[]
  ): Promise<DocumentRunDetail> {
    let run = this.requireRunTakingTickets(runId)
    const inRun = new Set(
      this.db
        .getDocumentRunItems(run.id)
        .map((item) => item.ticket_id)
        .filter((id): id is string => !!id)
    )
    const fresh = ticketIds.filter((id) => !inRun.has(id))
    if (fresh.length === 0) return this.detail(run, true)
    const projectId = run.project_id
    const adopted = await this.adoptionLocks.run(projectId, async () => {
      const tickets = await this.adoptableTickets(projectId, fresh, runId)
      const edges = await this.deps.getTicketDependencies(projectId)
      const unreadable = await this.itemsWithUnreadableCards(run)
      // The board was read meanwhile: the run as it is now (the orchestrator may have finished
      // it).
      const current = this.requireRunTakingTickets(runId)
      const keys = mintTicketRunKeys(
        tickets,
        this.db.getDocumentRunItems(runId).map((item) => item.key)
      )
      // One synchronous block, so nothing reads the run half-way through it. A finished run
      // owns no tickets, so the status changes with the insert or another adoption would read
      // these as free. And a new item goes out with its graph: a tick that found it pending
      // with an empty `depends_on` would launch it ahead of what it waits for.
      const resumes = addingTicketsResumesRun(current)
      this.db.insertDocumentRunItems(runId, this.ticketItemDrafts(tickets, keys))
      this.log(
        current,
        'tickets_added',
        `${boardTicketCount(tickets.length)} joined the orchestrator: ${keys.join(', ')}`,
        { data: { ticketIds: tickets.map((ticket) => ticket.id) } }
      )
      this.writeDependencies(current, edges, unreadable)
      if (!resumes) {
        this.publishRun(current)
        return { current, tickets, resumes }
      }
      // A finished run goes on where it stopped: the next report covers every ticket.
      const resumed = this.saveRun(current, {
        status: 'running',
        finished_at: null,
        report: null,
        error: null
      })
      this.log(
        resumed,
        'resumed',
        `Resumed with ${tickets.length} more ticket${tickets.length === 1 ? '' : 's'}`
      )
      return { current: resumed, tickets, resumes }
    })
    run = adopted.current
    await this.releaseAdoptedTickets(run, adopted.tickets, run.ticket_id)

    if (!adopted.resumes) {
      await this.describeRunTicket(run)
      return this.detail(run, true)
    }
    await this.unarchiveRunTicket(run)
    try {
      run = await this.ensureRunTicket(run, 'in_progress')
    } catch (error) {
      log.warn('Could not move the ticket of a resumed orchestrator back to in progress', {
        runId: run.id,
        error: describeError(error)
      })
    }
    // The resumed run can be cancelled from the moment it is published, and its ticket has just
    // been moved for a run that goes on: one that ended meanwhile sends it on to Review.
    await this.settleRunTicket(run)
    return this.detail(run, true)
  }

  /**
   * A resumed run shows on the board through its ticket, and an archived ticket has no card
   * (nor a way back) outside the Done column. Never fatal: the run goes on either way.
   */
  private async unarchiveRunTicket(run: DocumentRun): Promise<void> {
    const ticketId = run.ticket_id
    if (!ticketId) return
    try {
      const ticket = await this.deps.getTicket(run.project_id, ticketId)
      if (!ticket?.archived_at) return
      await this.deps.unarchiveTicket(run.project_id, ticketId)
      this.log(run, 'run_ticket_unarchived', "The run's ticket came back from the archive")
    } catch (error) {
      log.warn('Could not unarchive the ticket of a resumed orchestrator', {
        runId: run.id,
        ticketId,
        error: describeError(error)
      })
    }
  }

  /**
   * Which tickets a run made from board tickets holds, and what each starts after, change only
   * while the ticket has not launched: before the launch, or while it waits its turn. A
   * launched one is history (skip it instead), and so is every ticket of a finished run.
   */
  private assertTicketOpenToChange(
    run: DocumentRun,
    item: DocumentRunItem,
    change: 'remove' | 'relink'
  ): void {
    if (!isTicketRun(run)) {
      throw invalidState(
        change === 'remove'
          ? 'A ticket of a document run is not removed; deselect it in the preview instead.'
          : 'What a ticket of a document run starts after is edited in its preview.'
      )
    }
    if (run.status === 'preview') return
    if (isActiveRunStatus(run.status)) {
      if (awaitsLaunch(item)) return
      throw invalidState(
        change === 'remove'
          ? `${item.key} has launched; skip it instead.`
          : `${item.key} has launched; what it starts after can no longer be changed.`
      )
    }
    throw invalidState(
      run.status === 'cancelled'
        ? 'This orchestrator was cancelled; its tickets can no longer change.'
        : 'This orchestrator has finished; its tickets can no longer change.'
    )
  }

  /**
   * A launched run keeps at least one selected ticket: the orchestrator settles a run once all of
   * its tickets are through, and one with none would never be (it would stay running with
   * nothing to do). Its last ticket is skipped, or the run cancelled, instead. Before the launch
   * the preview may be emptied; the launch then asks for a ticket.
   */
  private assertRunKeepsATicket(run: DocumentRun, item: DocumentRunItem): void {
    if (this.isLastTicketOfLaunchedRun(run, item)) {
      throw invalidState(
        `${item.key} is the last ticket of this orchestrator; skip it or cancel the run instead.`
      )
    }
  }

  /**
   * Whether the run would be left with no selected ticket without this one, once launched. A
   * launch under way counts: the status stays `preview` until it ends, and it has already
   * checked the tickets it is about to launch.
   */
  private isLastTicketOfLaunchedRun(run: DocumentRun, item: DocumentRunItem): boolean {
    if (!item.selected) return false
    if (run.status === 'preview' && !this.startsInFlight.has(run.id)) return false
    return !this.db
      .getDocumentRunItems(run.id)
      .some((other) => other.id !== item.id && other.selected)
  }

  private async dropItem(runId: string, itemId: string): Promise<DocumentRunDetail> {
    // Under the lock: the run and the item as they are after any change that was ahead.
    const { run, item } = this.requireItem(runId, itemId)
    this.assertTicketOpenToChange(run, item, 'remove')
    this.assertRunKeepsATicket(run, item)
    this.removeItemRow(
      run,
      item,
      `${item.key} left the orchestrator; its ticket stays on the board`
    )
    await this.releaseParentLink(run, item.ticket_id)
    await this.syncAfterRemoval(run, [item.key])
    await this.describeRunTicket(run)
    return this.detail(this.requireRun(run.id), true)
  }

  private removeItemRow(run: DocumentRun, item: DocumentRunItem, message: string): void {
    this.db.deleteDocumentRunItem(item.id)
    this.publishRun(run)
    this.log(run, 'ticket_removed', message, { data: { key: item.key, ticketId: item.ticket_id } })
  }

  /** The ticket no longer points at the run's ticket (when it still did). Never fatal. */
  private async releaseParentLink(run: DocumentRun, ticketId: string | null): Promise<void> {
    const parentId = run.ticket_id
    if (!ticketId || !parentId) return
    try {
      const ticket = await this.deps.getTicket(run.project_id, ticketId)
      if (ticket?.parent_ticket_id !== parentId) return
      await this.deps.updateTicket(run.project_id, ticketId, { parent_ticket_id: null })
    } catch (error) {
      log.warn('Could not unlink a ticket from the ticket of its orchestrator', {
        runId: run.id,
        ticketId,
        error: describeError(error)
      })
    }
  }

  /** The graph without the tickets that left; from the board, else at least without their keys. */
  private async syncAfterRemoval(run: DocumentRun, keys: readonly string[]): Promise<void> {
    try {
      await this.syncDependencies(run)
    } catch (error) {
      log.warn('Could not read the board dependencies of an orchestrator', {
        runId: run.id,
        error: describeError(error)
      })
      for (const other of this.db.getDocumentRunItems(run.id)) {
        const kept = other.depends_on.filter((candidate) => !keys.includes(candidate))
        if (kept.length < other.depends_on.length)
          this.saveItem(run, other.id, { depends_on: kept })
      }
    }
  }

  private async relinkItem(
    runId: string,
    itemId: string,
    dependsOn: readonly string[]
  ): Promise<DocumentRunDetail> {
    const { run, item } = this.requireItem(runId, itemId)
    this.assertTicketOpenToChange(run, item, 'relink')
    const dependentId = item.ticket_id
    if (!dependentId) throw invalidState(`${item.key} has no ticket on the board.`)
    const items = this.db.getDocumentRunItems(run.id)
    const known = new Set(items.map((other) => other.key))
    const asked = unique(dependsOn)
    for (const key of asked) {
      if (key === item.key) throw invalidInput(`${item.key} cannot start after itself.`)
      if (!known.has(key)) throw invalidInput(`${key} is not a ticket of this orchestrator.`)
    }
    // In the run's order, as the board-derived lists are.
    const wanted = items.filter((other) => asked.includes(other.key)).map((other) => other.key)

    const edges = await this.deps.getTicketDependencies(run.project_id)
    const graph = dependsOnFromBoard(items, edges)
    graph[item.key] = wanted
    // Through this ticket only: a loop elsewhere on the board is not this change's doing (the
    // sync already keeps the run from scheduling it).
    const cycle = cycleThrough(item.key, graph)
    if (cycle) {
      throw invalidInput(`That would make a cycle: ${[...cycle, cycle[0]].join(' → ')}`)
    }

    const ticketOfKey = new Map(
      items.flatMap((other) => (other.ticket_id ? [[other.key, other.ticket_id] as const] : []))
    )
    const runTickets = new Set(ticketOfKey.values())
    const current = new Set(
      edges
        .filter(
          (edge) =>
            edge.dependent_id === dependentId &&
            edge.blocker_id !== dependentId &&
            runTickets.has(edge.blocker_id)
        )
        .map((edge) => edge.blocker_id)
    )
    const blockers = wanted.flatMap((key) => {
      const ticketId = ticketOfKey.get(key)
      return ticketId ? [{ key, ticketId }] : []
    })
    let wrote = false
    let refused: { key: string; reason: string } | null = null
    try {
      // Dropped edges first: the board checks a new one for cycles against what is left.
      for (const blocker of current) {
        if (blockers.some((wantedBlocker) => wantedBlocker.ticketId === blocker)) continue
        await this.deps.removeTicketDependency(run.project_id, dependentId, blocker)
        wrote = true
      }
      for (const blocker of blockers) {
        if (current.has(blocker.ticketId)) continue
        const reason = boardRefusal(
          await this.deps.addTicketDependency(run.project_id, dependentId, blocker.ticketId)
        )
        if (reason) {
          refused = { key: blocker.key, reason }
          break
        }
        wrote = true
      }
    } finally {
      // Whatever reached the board is the graph now, also after a refusal half-way.
      await this.syncDependencies(run).catch((error: unknown) => {
        log.warn('Could not read the board dependencies of an orchestrator', {
          runId: run.id,
          error: describeError(error)
        })
      })
    }
    if (refused) {
      throw invalidInput(
        `The board refused “${item.key} starts after ${refused.key}”: ${refused.reason}`
      )
    }
    if (wrote) {
      this.log(
        run,
        'dependencies_changed',
        wanted.length > 0
          ? `${item.key} starts after ${wanted.join(', ')}`
          : `${item.key} no longer waits for another ticket`,
        { itemId: item.id, data: { from: item.depends_on, to: wanted } }
      )
    }
    return this.detail(this.requireRun(run.id), true)
  }

  /**
   * Writes the board's graph into the items' `depends_on`, for every item whose list differs (on
   * a launched item it is history, and harmless).
   * A cycle on the board (which the orchestrator could never schedule) is broken here, at the
   * edge that points forward in the run's order, as a document run's launch breaks one, and
   * logged once — when it first costs the run an edge. Returns whether any item changed.
   */
  private async syncDependencies(run: DocumentRun): Promise<boolean> {
    const unreadable = await this.itemsWithUnreadableCards(run)
    return this.writeDependencies(
      run,
      await this.deps.getTicketDependencies(run.project_id),
      unreadable
    )
  }

  /**
   * The items the board cannot speak for now. An edge lives on the card of the ticket that waits,
   * so an unreadable card reads as a ticket that waits for nothing, and it would launch early once
   * its card reads again. Only the cards themselves count: a stray file in the folder says nothing
   * about the run's tickets, which go on following the board.
   */
  private async itemsWithUnreadableCards(run: DocumentRun): Promise<ReadonlySet<string>> {
    const unreadable = new Set<string>()
    if (!(await this.deps.boardHasUnreadableCards?.(run.project_id))) return unreadable
    for (const item of this.db.getDocumentRunItems(run.id)) {
      if (!item.ticket_id) continue
      const ticket = await this.deps.getTicket(run.project_id, item.ticket_id)
      if (!ticket) unreadable.add(item.key)
    }
    return unreadable
  }

  /**
   * The writes of `syncDependencies`, for a caller that has just read the edges. Synchronous, so
   * that a caller can make them one step with the items they are about. `keepKeys` keep the list
   * they have (see `itemsWithUnreadableCards`).
   */
  private writeDependencies(
    run: DocumentRun,
    board: readonly DocumentFlowTicketDependency[],
    keepKeys: ReadonlySet<string> = new Set()
  ): boolean {
    const items = this.db.getDocumentRunItems(run.id)
    const fromBoard = dependsOnFromBoard(items, board)
    const { dependsOn, warnings } = sanitizeDependencies(
      items.map((item) => ({
        key: item.key,
        depends_on: keepKeys.has(item.key) ? item.depends_on : (fromBoard[item.key] ?? [])
      }))
    )
    let changed = false
    for (const item of items) {
      const next = dependsOn[item.key] ?? []
      if (sameList(next, item.depends_on)) continue
      this.saveItem(run, item.id, { depends_on: next })
      changed = true
    }
    if (changed) for (const warning of warnings) this.log(run, 'dependency_warning', warning)
    return changed
  }

  /** A run made from board tickets that still owns them follows the board. */
  private followsBoard(run: DocumentRun): boolean {
    return isTicketRun(run) && runOwnsItsTickets(run.status)
  }

  /** Runs made from board tickets, still owning them, that hold one of these tickets. */
  private ticketRunsHolding(projectId: string, ticketIds: readonly string[]): string[] {
    const runIds = new Set<string>()
    for (const ticketId of new Set(ticketIds)) {
      for (const item of this.db.findDocumentRunItemsByTicketId(ticketId)) {
        const run = this.db.getDocumentRun(item.run_id)
        if (run && run.project_id === projectId && this.followsBoard(run)) runIds.add(run.id)
      }
    }
    return [...runIds]
  }

  /**
   * One board change followed by one run: under the run's lock, on the row as it is then, and
   * detached, so that what it writes on the board reaches the board of whoever made the change.
   */
  private followBoard(runId: string, follow: (run: DocumentRun) => Promise<void>): Promise<void> {
    return this.detach(() =>
      this.ticketRunLocks.run(runId, async () => {
        const run = this.db.getDocumentRun(runId)
        if (run && this.followsBoard(run)) await follow(run)
      })
    )
  }

  /**
   * The run's copies of its tickets as the board has them now (`ticketIds` null = every one):
   * titles and descriptions refreshed; a ticket that left the board or was archived leaves the
   * run while it has not launched; then the graph is derived again. Null from the board is only
   * believed when a change to this very ticket was just reported (`ticketIds` given) on a board
   * that reads whole. A launched run keeps its last ticket in any case, as `removeItem` does: the
   * runner flags it, and the user can skip it.
   */
  private async followBoardTickets(
    run: DocumentRun,
    ticketIds: readonly string[] | null
  ): Promise<void> {
    const scope = ticketIds ? new Set(ticketIds) : null
    let removed = false
    for (const item of this.db.getDocumentRunItems(run.id)) {
      const ticketId = item.ticket_id
      if (!ticketId || (scope && !scope.has(ticketId))) continue
      const ticket = await this.deps.getTicket(run.project_id, ticketId)
      if (ticket && !ticket.archived_at) {
        this.refreshItemCopy(run, item, ticket)
        continue
      }
      const unlaunched =
        run.status === 'preview' || (isActiveRunStatus(run.status) && awaitsLaunch(item))
      if (!unlaunched) continue
      const context = { runId: run.id, item: item.key, ticketId }
      if (!ticket && !scope) {
        log.info('Kept a ticket of an orchestrator that reads as missing at startup', context)
        continue
      }
      if (!ticket && (await this.deps.boardHasUnreadableCards?.(run.project_id))) {
        log.warn('Kept a ticket of an orchestrator: its board has cards it cannot read', context)
        continue
      }
      if (this.isLastTicketOfLaunchedRun(run, item)) {
        log.warn('Kept the last ticket of an orchestrator that left the board', context)
        continue
      }
      this.removeItemRow(
        run,
        item,
        ticket
          ? `${item.key} was archived on the board, so it left the orchestrator`
          : `${item.key} left the board, so it left the orchestrator`
      )
      removed = true
      if (ticket) await this.releaseParentLink(run, ticketId)
    }
    if (removed) await this.describeRunTicket(run)
    await this.syncDependencies(run)
  }

  /** The item's copy of its ticket's title and description, where the board said them. */
  private refreshItemCopy(
    run: DocumentRun,
    item: DocumentRunItem,
    ticket: DocumentFlowTicket
  ): void {
    const patch: DocumentRunItemRowPatch = {}
    if (typeof ticket.title === 'string') {
      const title = sanitizeLine(ticket.title) || item.key
      if (title !== item.title) patch.title = title
    }
    if (ticket.description !== undefined) {
      const description = ticket.description ?? ''
      if (description !== item.description) patch.description = description
    }
    if (Object.keys(patch).length > 0) this.saveItem(run, item.id, patch)
  }

  /**
   * A run made from board tickets launches its tickets as the board has them now. They are all
   * checked before anything is written, so a refused launch leaves the preview as it was: a
   * ticket that left the board, was archived, still has the open session it was launched with
   * from the board, or was moved past In Progress stops the launch, since the run would launch
   * one that is gone, give it a second session or pull finished work back. Then the copies and
   * the graph are brought up to date, a launch the board queued on one since is dropped (the run
   * launches it), so is a link to a session that has closed, and the board shows the model each
   * will launch with. Tickets left unchecked go at the end of the launch (`dropLeftOutTickets`).
   */
  private async prepareTicketRunLaunch(run: DocumentRun): Promise<DocumentRun> {
    const problems: string[] = []
    const launching: { item: DocumentRunItem; ticketId: string; ticket: DocumentFlowTicket }[] = []
    for (const item of this.db.getDocumentRunItems(run.id)) {
      if (!item.selected || !awaitsLaunch(item)) continue
      const ticketId = item.ticket_id
      if (!ticketId) {
        problems.push(`${item.key} has no ticket on the board; remove it from the orchestrator.`)
        continue
      }
      const ticket = await this.deps.getTicket(run.project_id, ticketId)
      if (!ticket) {
        problems.push(`${item.key} is no longer on the board; remove it from the orchestrator.`)
        continue
      }
      if (ticket.archived_at) {
        problems.push(`${item.key} is archived; unarchive it or remove it from the orchestrator.`)
        continue
      }
      if (ticket.current_session_id && this.sessionIsActive(ticket.current_session_id)) {
        problems.push(
          `${item.key} was launched from the board; close its session or remove it from the orchestrator.`
        )
        continue
      }
      if (ticket.column === 'review' || ticket.column === 'done' || ticket.column === 'merged') {
        problems.push(
          `${item.key} was moved to ${RUN_TICKET_COLUMN_NAMES[ticket.column]} on the board; move it back or remove it from the orchestrator.`
        )
        continue
      }
      launching.push({ item, ticketId, ticket })
    }
    if (problems.length > 0) throw invalidState(problems.join(' '))
    for (const { item, ticketId, ticket } of launching) {
      this.refreshItemCopy(run, item, ticket)
      const patch: DocumentFlowTicketPatch = {}
      if (ticket.pending_launch_config) patch.pending_launch_config = null
      if (ticket.current_session_id) patch.current_session_id = null
      if (Object.keys(patch).length > 0) {
        await this.deps.updateTicket(run.project_id, ticketId, patch).catch((error: unknown) => {
          log.warn('Could not clear an orchestrated ticket for its launch', {
            runId: run.id,
            ticketId,
            error: describeError(error)
          })
        })
      }
      if ((item.launch_config ?? run.config.defaultLaunch)?.model) {
        this.stampTicketModel(run, item, ticketId)
      }
    }
    await this.syncDependencies(run)
    return this.db.getDocumentRun(run.id) ?? run
  }

  /** A session counts as open unless told otherwise: a second session is what the check prevents. */
  private sessionIsActive(sessionId: string): boolean {
    return this.deps.isSessionActive?.(sessionId) ?? true
  }

  /**
   * A ticket left unchecked in the preview is not part of what launches: it leaves the run here,
   * so its ticket is free again (to launch by hand, or to join another orchestrator) rather than
   * held by a run that will never launch it. Only once the integration exists: a launch that
   * stops earlier keeps the unchecked tickets in the preview, for the retry.
   */
  private async dropLeftOutTickets(run: DocumentRun): Promise<void> {
    const leftOut = this.db
      .getDocumentRunItems(run.id)
      .filter((item) => !item.selected && awaitsLaunch(item))
    if (leftOut.length === 0) return
    for (const item of leftOut) {
      this.removeItemRow(
        run,
        item,
        `${item.key} was left out at launch; its ticket stays on the board`
      )
      await this.releaseParentLink(run, item.ticket_id)
    }
    await this.describeRunTicket(run)
    await this.syncAfterRemoval(
      run,
      leftOut.map((item) => item.key)
    )
  }

  /** A launch needs a ticket; unchecking one takes no lock, so it can come at any moment. */
  private assertRunHasTicketToLaunch(run: DocumentRun): void {
    if (!this.db.getDocumentRunItems(run.id).some((item) => item.selected)) {
      throw invalidState('This orchestrator has no ticket left to launch; select or add one.')
    }
  }

  /** The run's ticket says how many tickets the run holds; cosmetic, so never fatal. */
  private async describeRunTicket(run: DocumentRun): Promise<void> {
    const ticketId = run.ticket_id
    if (!ticketId) return
    try {
      await this.deps.updateTicket(run.project_id, ticketId, {
        description: this.runTicketDescription(run)
      })
    } catch (error) {
      log.warn('Could not re-describe the ticket of an orchestrator', {
        runId: run.id,
        ticketId,
        error: describeError(error)
      })
    }
  }

  // ── Edits ─────────────────────────────────────────────────────────────────

  updateRun(runId: string, patch: DocumentRunPatch): DocumentRun {
    const run = this.requireRun(runId)
    const rowPatch: DocumentRunRowPatch = {}

    if (patch.title !== undefined) {
      const title = sanitizeLine(patch.title)
      if (!title) throw invalidInput('The run needs a title.')
      if (title !== run.title) rowPatch.title = title
    }
    if (patch.config !== undefined) rowPatch.config = this.mergeConfig(run, patch.config)
    if (patch.status !== undefined && patch.status !== run.status) {
      const toggles =
        (run.status === 'running' && patch.status === 'paused') ||
        (run.status === 'paused' && patch.status === 'running')
      if (!toggles) {
        throw invalidState(
          `Only a launched run can be paused or resumed (this one is ${run.status.replace(/_/g, ' ')}).`
        )
      }
      rowPatch.status = patch.status
    }

    if (Object.keys(rowPatch).length === 0) return run
    const updated = this.saveRun(run, rowPatch)
    // The run's ticket carries the run's title; a rename follows it to the board.
    if (rowPatch.title !== undefined) void this.stampRunTicketTitle(updated)
    if (rowPatch.status === 'paused') this.log(updated, 'paused', 'Run paused')
    if (rowPatch.status === 'running') this.log(updated, 'resumed', 'Run resumed')
    // The preview saves its settings as they are edited; only a launched run's change is history.
    const from = run.config.maxParallel
    const to = updated.config.maxParallel
    if (from !== to && isActiveRunStatus(run.status)) {
      this.log(updated, 'max_parallel_changed', `Parallel tickets changed from ${from} to ${to}`, {
        data: { from, to }
      })
    }
    return updated
  }

  private mergeConfig(run: DocumentRun, patch: Partial<DocumentRunConfig>): DocumentRunConfig {
    const config: DocumentRunConfig = { ...run.config }
    if (patch.maxParallel !== undefined && Number.isFinite(patch.maxParallel)) {
      config.maxParallel = Math.min(
        DOCUMENT_RUN_MAX_PARALLEL_LIMIT,
        Math.max(1, Math.round(patch.maxParallel))
      )
    }
    if (patch.verifyCommand !== undefined) {
      // '' is the user's explicit "no verification" and survives a reload; null means never chosen.
      config.verifyCommand = patch.verifyCommand === null ? null : patch.verifyCommand.trim()
    }
    if (patch.interactive !== undefined) config.interactive = patch.interactive
    if (patch.verificationDisabled !== undefined) {
      config.verificationDisabled = patch.verificationDisabled
    }
    if (patch.promptStyle !== undefined) config.promptStyle = patch.promptStyle
    if (patch.defaultLaunch !== undefined) config.defaultLaunch = patch.defaultLaunch
    if (patch.generation !== undefined) config.generation = patch.generation
    if (patch.baseBranch !== undefined) {
      const baseBranch = patch.baseBranch?.trim() || null
      if (baseBranch !== run.config.baseBranch) {
        // The integration branch is cut from it at launch; afterwards it is history.
        if (run.status !== 'preview') {
          throw invalidState('The base branch can only be changed while the run is in preview.')
        }
        config.baseBranch = baseBranch
      }
    }
    if (patch.memberVerifyCommands !== undefined) {
      // Per member, the same rule as `verifyCommand`: '' is an explicit "skip this member".
      config.memberVerifyCommands = { ...run.config.memberVerifyCommands }
      for (const [projectId, command] of Object.entries(patch.memberVerifyCommands)) {
        config.memberVerifyCommands[projectId] = command === null ? null : command.trim()
      }
    }
    if (patch.memberBaseBranches !== undefined) {
      const memberBaseBranches = { ...run.config.memberBaseBranches }
      for (const [projectId, branch] of Object.entries(patch.memberBaseBranches)) {
        memberBaseBranches[projectId] = branch?.trim() || null
      }
      const changed = Object.keys(memberBaseBranches).some(
        (projectId) =>
          (memberBaseBranches[projectId] ?? null) !==
          (run.config.memberBaseBranches[projectId] ?? null)
      )
      if (changed) {
        if (run.status !== 'preview') {
          throw invalidState('The base branch can only be changed while the run is in preview.')
        }
        config.memberBaseBranches = memberBaseBranches
      }
    }
    return config
  }

  updateItem(runId: string, itemId: string, patch: DocumentRunItemPatch): DocumentRunItem {
    const { run, item } = this.requireItem(runId, itemId)
    const launched = !UNLAUNCHED_RUN_STATUSES.includes(run.status)

    // A run made from board tickets keeps neither in the item: the ticket is the brief, and the
    // board's dependencies are the graph (`setItemDependencies`). What it launches with (the
    // model, the verification) and whether it is part of the run are its own, as below.
    if (isTicketRun(run)) {
      if (patch.depends_on !== undefined) {
        throw invalidState(
          'An orchestrator follows the board: change what a ticket starts after with setItemDependencies.'
        )
      }
      if (
        patch.title !== undefined ||
        patch.summary !== undefined ||
        patch.description !== undefined
      ) {
        throw invalidState(
          'The ticket is the brief of an orchestrator: edit the ticket on the board.'
        )
      }
    }
    if (
      PREVIEW_ITEM_FIELDS.some((field) => patch[field] !== undefined) &&
      run.status !== 'preview'
    ) {
      throw invalidState('Tickets can only be edited while the run is in preview.')
    }
    if (ORCHESTRATION_ITEM_FIELDS.some((field) => patch[field] !== undefined) && !launched) {
      throw invalidState('This run has not been launched yet.')
    }
    // The choice reaches the agent with its launch prompt, so it is open until then: in the
    // preview, and from the dashboard while the ticket still waits its turn.
    if (
      patch.verification !== undefined &&
      run.status !== 'preview' &&
      !(launched && item.status === 'pending')
    ) {
      throw invalidState(
        launched
          ? `${item.key} has launched; its verification can no longer be changed.`
          : 'Tickets can only be edited while the run is in preview.'
      )
    }
    // The model too, and also on a ticket whose launch failed: nothing runs for it, and Retry
    // launches it afresh with whatever is chosen by then.
    if (
      patch.launch_config !== undefined &&
      run.status !== 'preview' &&
      !(launched && awaitsLaunch(item))
    ) {
      throw invalidState(
        launched
          ? `${item.key} has launched; its model can no longer be changed.`
          : 'Tickets can only be edited while the run is in preview.'
      )
    }

    const rowPatch: DocumentRunItemPatch = {}
    if (patch.verification !== undefined) {
      rowPatch.verification = normalizeVerificationMethods(patch.verification)
    }
    if (patch.title !== undefined) {
      const title = sanitizeLine(patch.title)
      if (!title) throw invalidInput('A ticket needs a title.')
      rowPatch.title = title
    }
    if (patch.summary !== undefined) rowPatch.summary = patch.summary
    if (patch.description !== undefined) rowPatch.description = patch.description
    if (patch.depends_on !== undefined) {
      const otherKeys = new Set(
        this.db
          .getDocumentRunItems(run.id)
          .filter((other) => other.id !== item.id)
          .map((other) => other.key)
      )
      rowPatch.depends_on = unique(patch.depends_on).filter((key) => otherKeys.has(key))
    }
    if (patch.selected !== undefined) rowPatch.selected = patch.selected
    if (patch.launch_config !== undefined) rowPatch.launch_config = patch.launch_config
    for (const field of ORCHESTRATION_ITEM_FIELDS) {
      if (patch[field] !== undefined) Object.assign(rowPatch, { [field]: patch[field] })
    }

    if (Object.keys(rowPatch).length === 0) return item
    const updated = this.saveItem(run, item.id, rowPatch)
    if (rowPatch.launch_config !== undefined && launched && item.ticket_id) {
      this.stampTicketModel(run, updated, item.ticket_id)
    }
    if (rowPatch.status !== undefined && rowPatch.status !== item.status) {
      const detail = rowPatch.status_detail ? `: ${rowPatch.status_detail}` : ''
      this.log(
        run,
        rowPatch.status,
        `${item.key} → ${rowPatch.status.replace(/_/g, ' ')}${detail}`,
        {
          itemId: item.id,
          data: { from: item.status, to: rowPatch.status }
        }
      )
    }
    const documentUpdate = rowPatch.document_update_status
    if (
      documentUpdate !== undefined &&
      documentUpdate !== null &&
      documentUpdate !== item.document_update_status
    ) {
      const event = DOCUMENT_UPDATE_EVENTS[documentUpdate]
      const detail = rowPatch.document_update_detail ? `: ${rowPatch.document_update_detail}` : ''
      this.log(run, event.type, `${item.key} ${event.message}${detail}`, {
        itemId: item.id,
        data: { from: item.document_update_status, to: documentUpdate }
      })
    }
    return updated
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  /** `defaultSdk`: the app's default agent, for tickets the run gives no launch config. */
  async start(runId: string, defaultSdk?: HandoffAgentSdk): Promise<DocumentRunDetail> {
    const inFlight = this.startsInFlight.get(runId)
    if (inFlight) return inFlight

    const run = this.requireRun(runId)
    // `running` without an integration worktree (or instance) is a start that failed half-way.
    const halfStarted = run.status === 'running' && !hasIntegration(run)
    if (run.status !== 'preview' && !halfStarted) {
      throw invalidState(
        UNLAUNCHED_RUN_STATUSES.includes(run.status)
          ? 'The tickets are not ready yet.'
          : 'This run was already launched.'
      )
    }
    if (!this.db.getDocumentRunItems(runId).some((item) => item.selected)) {
      throw invalidInput('Select at least one ticket to launch.')
    }
    const target = this.requireTarget(run)

    const started = this.detach(() => this.launch(run, target, defaultSdk)).finally(() => {
      this.startsInFlight.delete(runId)
    })
    this.startsInFlight.set(runId, started)
    return started
  }

  /** Every step is idempotent, so starting again after a failure continues where it stopped. */
  private async launch(
    initialRun: DocumentRun,
    target: DocumentFlowRunTarget,
    defaultSdk: HandoffAgentSdk | undefined
  ): Promise<DocumentRunDetail> {
    let run = initialRun
    try {
      // Its tickets are already on the board, as the user left them: checked and read again.
      if (isTicketRun(run)) {
        const unprepared = run
        run = await this.ticketRunLocks.run(run.id, () => this.prepareTicketRunLaunch(unprepared))
      }
      this.cleanDependencies(run)
      if (!hasIntegration(run)) {
        run =
          target.kind === 'connection'
            ? await this.createIntegrationInstance(run, target)
            : await this.createIntegrationWorktree(run, target.project)
      }
      // The run's own ticket first: it gets the lower key (TD-12) and the task tickets are
      // created with it as their parent.
      run = await this.ensureRunTicket(run, 'in_progress')
      await this.createTickets(run, defaultSdk)
      const launched: DocumentRunRowPatch = {
        status: 'running',
        started_at: run.started_at ?? this.now().toISOString(),
        error: null
      }
      if (isTicketRun(run)) {
        const ready = run
        run = await this.ticketRunLocks.run(run.id, async () => {
          // Before anything leaves, or a refused launch would not leave the preview as it was.
          this.assertRunHasTicketToLaunch(ready)
          await this.dropLeftOutTickets(ready)
          // Again, with no gap before the write: the last ticket may have been unchecked since.
          this.assertRunHasTicketToLaunch(ready)
          return this.saveRun(ready, launched)
        })
      } else {
        run = this.saveRun(run, launched)
      }
      this.log(run, 'started', `Run launched on ${run.integration_branch}`)
      return this.detail(run, true)
    } catch (error) {
      const message = describeError(error)
      this.log(run, 'start_failed', `Launch failed: ${message}`)
      throw error instanceof RpcRouteError ? error : new RpcRouteError('START_FAILED', message)
    }
  }

  private cleanDependencies(run: DocumentRun): void {
    const items = this.db.getDocumentRunItems(run.id)
    const { dependsOn, warnings } = sanitizeDependencies(items)
    for (const item of items) {
      const cleaned = dependsOn[item.key] ?? []
      if (!sameList(cleaned, item.depends_on)) {
        this.saveItem(run, item.id, { depends_on: cleaned })
      }
    }
    for (const warning of warnings) this.log(run, 'dependency_warning', warning)
  }

  private async createIntegrationWorktree(
    run: DocumentRun,
    project: DocumentFlowProject
  ): Promise<DocumentRun> {
    const baseBranch = run.config.baseBranch ?? (await this.defaultBaseBranch(project))
    // Read-only: the local branch as it is now. No fetch and no pull, which would move it (or
    // touch the root checkout) behind the user's back.
    const baseSha = await this.branchSha(project.path, baseBranch)
    if (!baseSha) {
      throw invalidState(`Branch "${baseBranch}" was not found in ${project.name}.`)
    }
    let updated = this.saveRun(run, { base_branch: baseBranch, base_sha: baseSha })
    this.log(updated, 'base_resolved', `Base: ${baseBranch} at ${baseSha.slice(0, 8)}`)

    const result = await this.deps.createWorktreeFromBranch({
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      branchName: baseBranch,
      nameHint: integrationBranchHint(run.title, run.source_kind),
      // Both are load-bearing: auto-pull would run `git pull` in the root checkout, and
      // without a base ref a checked-out base branch is duplicated together with its
      // uncommitted files.
      autoPull: false,
      baseRef: baseSha
    })
    if (!result.success || !result.worktree) {
      throw new RpcRouteError(
        'START_FAILED',
        `The integration worktree could not be created: ${result.error ?? 'unknown error'}`
      )
    }
    const { worktree } = result
    updated = this.saveRun(updated, {
      integration_branch: worktree.branch_name,
      integration_worktree_id: worktree.id,
      integration_worktree_path: worktree.path
    })
    this.log(
      updated,
      'integration_created',
      `Integration branch ${worktree.branch_name} created at ${worktree.path}`
    )
    return updated
  }

  /**
   * The connection-project twin of `createIntegrationWorktree`: one integration worktree per
   * member, each cut from that member's base branch, connected into one instance of the
   * connection project. The run is marked in one write once the instance exists, so a failure
   * half-way leaves worktrees behind at worst, never a run that names an instance it has not got.
   */
  private async createIntegrationInstance(
    run: DocumentRun,
    target: Extract<DocumentFlowRunTarget, { kind: 'connection' }>
  ): Promise<DocumentRun> {
    const bases: { member: DocumentFlowProject; baseBranch: string; baseSha: string }[] = []
    for (const member of target.members) {
      const baseBranch =
        run.config.memberBaseBranches[member.id] ?? (await this.defaultBaseBranch(member))
      // Read-only, as for a git project: the local branch as it is now.
      const baseSha = await this.branchSha(member.path, baseBranch)
      if (!baseSha) throw invalidState(`Branch "${baseBranch}" was not found in ${member.name}.`)
      bases.push({ member, baseBranch, baseSha })
    }
    let updated = this.saveRun(run, {
      base_branch: baseBranchLabel(bases.map((base) => base.baseBranch))
    })
    this.log(
      updated,
      'base_resolved',
      `Base: ${bases.map((base) => `${base.member.name} ${base.baseBranch} at ${base.baseSha.slice(0, 8)}`).join(', ')}`
    )

    const nameHint = integrationBranchHint(run.title, run.source_kind)
    const worktrees: {
      base: (typeof bases)[number]
      worktree: NonNullable<WorktreeResult['worktree']>
    }[] = []
    for (const base of bases) {
      const result = await this.deps.createWorktreeFromBranch({
        projectId: base.member.id,
        projectPath: base.member.path,
        projectName: base.member.name,
        branchName: base.baseBranch,
        nameHint,
        // Same two load-bearing options as for a git project: see createIntegrationWorktree.
        autoPull: false,
        baseRef: base.baseSha
      })
      if (!result.success || !result.worktree) {
        throw new RpcRouteError(
          'START_FAILED',
          `The integration worktree of ${base.member.name} could not be created: ${result.error ?? 'unknown error'}`
        )
      }
      worktrees.push({ base, worktree: result.worktree })
    }

    const created = await this.deps.createConnection(
      worktrees.map(({ worktree }) => worktree.id),
      run.project_id
    )
    if (!created.success || !created.connection) {
      throw new RpcRouteError(
        'START_FAILED',
        `The integration instance could not be created: ${created.error ?? 'unknown error'}`
      )
    }
    const { connection } = created
    const members = worktrees.map(({ base, worktree }): DocumentRunMember => {
      const link = connection.members.find((member) => member.worktree_id === worktree.id)
      if (!link) {
        throw new RpcRouteError(
          'START_FAILED',
          `The integration instance has no entry for ${base.member.name}.`
        )
      }
      return {
        project_id: base.member.id,
        project_name: base.member.name,
        project_path: base.member.path,
        symlink_name: link.symlink_name,
        base_branch: base.baseBranch,
        base_sha: base.baseSha,
        integration_branch: worktree.branch_name,
        integration_worktree_id: worktree.id,
        integration_worktree_path: worktree.path
      }
    })
    updated = this.saveRun(updated, {
      integration_branch: sharedName(members.map((member) => member.integration_branch)),
      integration_connection_id: connection.id,
      integration_connection_path: connection.path,
      members
    })
    this.log(
      updated,
      'integration_created',
      `Integration instance created at ${connection.path}: ${members.map((member) => `${member.symlink_name} on ${member.integration_branch}`).join(', ')}`
    )
    // The instance shows up in the sidebar under the project: named after the run, like the
    // branches are.
    try {
      await this.deps.renameConnection?.(
        connection.id,
        sanitizeLine(run.title) || runKindLabel(run)
      )
    } catch (error) {
      log.warn('Could not name the integration instance of a document run', {
        runId: run.id,
        connectionId: connection.id,
        error: describeError(error)
      })
    }
    return updated
  }

  /**
   * "The project's default branch" is the branch the root checkout is on, as everywhere else
   * in the app; `main`/`master` only stand in for a detached HEAD. Never a guess among the
   * project's other branches: those are worktree branches and earlier runs' tickets.
   */
  // ── Members ───────────────────────────────────────────────────────────────

  /**
   * Connect one more repository to a launched connection run, as if it had been a member from
   * the start: the project joins the connection project (so tickets launched from now on get a
   * worktree in it), its integration worktree is cut from its base branch — the branch given,
   * else the one the run's config names for it, else its current branch — under the run's
   * branch name and linked into the integration instance, every ticket already on an instance
   * of its own gets a worktree there cut from that new integration branch, and the run's
   * ticket on the board is re-described. The run is marked in one write once the instance has
   * the member, so a failure half-way leaves a worktree behind at worst, never a run that
   * names a member its instance has not got.
   */
  async addMember(
    runId: string,
    params: { projectId: string; baseBranch?: string | null }
  ): Promise<DocumentRunDetail> {
    // Refused up front so the caller hears it at once; checked again under the run's member
    // lock, since another window may have added the same repository meanwhile.
    const { run, project } = this.validateNewMember(runId, params.projectId)
    // Detached, like a launch: the worktree and connection writes must reach the client that
    // asked for them, or its sidebar would never show the new worktree.
    return this.detach(() =>
      this.memberLocks.run(run.id, () =>
        this.connectMember(runId, project.id, params.baseBranch ?? null)
      )
    )
  }

  /** The run and the project as they are now, if the project can join the run. */
  private validateNewMember(
    runId: string,
    projectId: string
  ): { run: DocumentRun & { members: DocumentRunMember[] }; project: DocumentFlowProject } {
    const run = this.requireRun(runId)
    if (!isConnectionRun(run) || !run.integration_connection_id) {
      throw invalidState(
        hasIntegration(run)
          ? 'Only a run on a connection project can take another repository.'
          : 'The run has not been launched yet: add the repository to the connection project instead.'
      )
    }
    if (!isActiveRunStatus(run.status)) {
      throw invalidState('A finished run cannot take another repository.')
    }
    const project = this.deps.getProject(projectId)
    if (!project) throw notFound('The project')
    if (project.kind === 'connection' || project.id === run.project_id) {
      throw invalidInput('A connection project cannot be added as a repository.')
    }
    const taken = run.members.find(
      (member) => member.project_id === project.id || samePath(member.project_path, project.path)
    )
    if (taken) throw invalidInput(`${taken.project_name} is already a member of this run.`)
    return { run, project }
  }

  private async connectMember(
    runId: string,
    projectId: string,
    requestedBranch: string | null
  ): Promise<DocumentRunDetail> {
    // Under the lock: the run as it is after any addition that was ahead of this one.
    const { run, project } = this.validateNewMember(runId, projectId)
    const connectionId = run.integration_connection_id as string
    try {
      const baseBranch =
        requestedBranch?.trim() ||
        run.config.memberBaseBranches[project.id] ||
        (await this.defaultBaseBranch(project))
      // Read-only, as at launch: the local branch as it is now.
      const baseSha = await this.branchSha(project.path, baseBranch)
      if (!baseSha) throw invalidState(`Branch "${baseBranch}" was not found in ${project.name}.`)

      // The connection project first, idempotently: a ticket launched from now on builds its
      // instance from the project's member list, and a retry after a later failure is a no-op.
      if (this.deps.addConnectionProjectMember) {
        const joined = await this.deps.addConnectionProjectMember(run.project_id, project.id)
        if (!joined.success) {
          throw new RpcRouteError(
            'START_FAILED',
            `${project.name} could not be added to the connection project: ${joined.error ?? 'unknown error'}`
          )
        }
      }

      const created = await this.deps.createWorktreeFromBranch({
        projectId: project.id,
        projectPath: project.path,
        projectName: project.name,
        branchName: baseBranch,
        nameHint: integrationBranchHint(run.title, run.source_kind),
        // Same two load-bearing options as at launch: see createIntegrationWorktree.
        autoPull: false,
        baseRef: baseSha
      })
      if (!created.success || !created.worktree) {
        throw new RpcRouteError(
          'START_FAILED',
          `The integration worktree of ${project.name} could not be created: ${created.error ?? 'unknown error'}`
        )
      }
      const worktree = created.worktree
      const linked = await this.deps.addConnectionMember(connectionId, worktree.id)
      if (!linked.success || !linked.member) {
        throw new RpcRouteError(
          'START_FAILED',
          `The integration worktree of ${project.name} could not be linked into the instance: ${linked.error ?? 'unknown error'}`
        )
      }
      const member: DocumentRunMember = {
        project_id: project.id,
        project_name: project.name,
        project_path: project.path,
        symlink_name: linked.member.symlink_name,
        base_branch: baseBranch,
        base_sha: baseSha,
        integration_branch: worktree.branch_name,
        integration_worktree_id: worktree.id,
        integration_worktree_path: worktree.path
      }

      this.log(
        run,
        'member_added',
        `${project.name} joined the run: ${member.symlink_name} on ${member.integration_branch} (from ${baseBranch} at ${baseSha.slice(0, 8)})`,
        {
          data: {
            project_id: project.id,
            symlink_name: member.symlink_name,
            integration_branch: member.integration_branch,
            integration_worktree_id: worktree.id
          }
        }
      )
      // The tickets at work first, then the run: the orchestrator reads the run's members, so
      // it must never see the new one while a ticket's instance has yet to take it. (A ticket
      // merged in between merges nothing in the new member, which is what it touched there.)
      await this.extendItemInstances(run, member)

      // Several clients share one database: re-read, and append to what is there now.
      const current = this.requireRun(run.id)
      const members = [
        ...(current.members ?? []).filter((candidate) => candidate.project_id !== project.id),
        member
      ]
      const updated = this.saveRun(current, {
        members,
        base_branch: baseBranchLabel(members.map((candidate) => candidate.base_branch)),
        integration_branch: sharedName(members.map((candidate) => candidate.integration_branch)),
        config: {
          ...current.config,
          memberBaseBranches: { ...current.config.memberBaseBranches, [project.id]: baseBranch }
        }
      })

      // The run's ticket names every member's branches; cosmetic, so never fatal.
      if (updated.ticket_id) {
        const ticketId = updated.ticket_id
        try {
          await this.deps.updateTicket(updated.project_id, ticketId, {
            description: this.runTicketDescription(updated)
          })
        } catch (error) {
          log.warn('Could not re-describe the ticket of a document run', {
            runId: run.id,
            ticketId,
            error: describeError(error)
          })
        }
      }

      return this.detail(updated, true)
    } catch (error) {
      const message = describeError(error)
      this.log(run, 'member_add_failed', `${project.name} could not join the run: ${message}`, {
        data: { project_id: project.id }
      })
      throw error instanceof RpcRouteError ? error : new RpcRouteError('START_FAILED', message)
    }
  }

  /**
   * Give every ticket that is on an instance of its own (launched, not finished) a worktree in
   * the new member, cut from the member's integration branch and named after the ticket, as a
   * launch would have. Per ticket: a failure is logged on the ticket and the rest go on. A
   * ticket still launching finishes with the members its launch started from. Either way the
   * ticket merges nothing in the new member (`mergeContexts` skips a member it has no worktree
   * in), so no ticket is left unmergeable.
   */
  private async extendItemInstances(run: DocumentRun, member: DocumentRunMember): Promise<void> {
    const items = this.db
      .getDocumentRunItems(run.id)
      .filter(
        (item) =>
          item.selected &&
          item.connection_id &&
          item.members &&
          !isTerminalItemStatus(item.status) &&
          item.status !== 'launching' &&
          !item.members.some((own) => own.project_id === member.project_id)
      )
    for (const item of items) {
      const connectionId = item.connection_id as string
      try {
        const tip = await this.branchSha(member.project_path, member.integration_branch)
        if (!tip) {
          throw new Error(
            `Branch ${member.integration_branch} was not found in ${member.project_name}.`
          )
        }
        const created = await this.deps.createWorktreeFromBranch({
          projectId: member.project_id,
          projectPath: member.project_path,
          projectName: member.project_name,
          // Recorded against the member's base branch, as the runner records a launch.
          branchName: member.base_branch,
          nameHint: item.branch_name ?? ticketBranchHint(item.key, item.title),
          autoPull: false,
          baseRef: tip
        })
        if (!created.success || !created.worktree) {
          throw new Error(created.error ?? 'The worktree could not be created.')
        }
        const linked = await this.deps.addConnectionMember(connectionId, created.worktree.id)
        if (!linked.success || !linked.member) {
          throw new Error(linked.error ?? 'The worktree could not be linked into the instance.')
        }
        const own: DocumentRunItemMember = {
          project_id: member.project_id,
          worktree_id: created.worktree.id,
          branch_name: created.worktree.branch_name,
          pre_merge_sha: null,
          merge_sha: null
        }
        const fresh = this.db.getDocumentRunItem(item.id)
        const members = [...(fresh?.members ?? item.members ?? []), own]
        this.saveItem(run, item.id, { members })
        this.log(
          run,
          'member_added',
          `${item.key} got a worktree in ${member.project_name}: ${own.branch_name} (from ${member.integration_branch})`,
          { itemId: item.id, data: { project_id: member.project_id, worktree_id: own.worktree_id } }
        )
      } catch (error) {
        this.log(
          run,
          'member_add_failed',
          `${item.key} got no worktree in ${member.project_name}: ${describeError(error)}`,
          { itemId: item.id, data: { project_id: member.project_id } }
        )
      }
    }
  }

  private async defaultBaseBranch(project: DocumentFlowProject): Promise<string> {
    const current = await this.git.currentBranch(project.path)
    if (current) return current
    for (const name of ['main', 'master']) {
      if (await this.branchSha(project.path, name)) return name
    }
    const guess = await this.deps.getDefaultBranch(project.path).catch(() => null)
    if (guess && (await this.branchSha(project.path, guess))) return guess
    throw invalidInput(
      `Pick a base branch: ${project.name} has a detached HEAD and no main or master branch.`
    )
  }

  /** The local branch, else its origin-tracking ref. */
  private async branchSha(projectPath: string, branch: string): Promise<string | null> {
    return (
      (await this.git.revParse(projectPath, `refs/heads/${branch}`)) ??
      (await this.git.revParse(projectPath, `refs/remotes/origin/${branch}`))
    )
  }

  private async createTickets(
    run: DocumentRun,
    defaultSdk: HandoffAgentSdk | undefined
  ): Promise<void> {
    const selected = this.db.getDocumentRunItems(run.id).filter((item) => item.selected)
    const pending = selected.filter((item) => !item.ticket_id)
    if (pending.length === 0) return

    const selectedKeys = new Set(selected.map((item) => item.key))
    const pendingKeys = new Set(pending.map((item) => item.key))
    // On a connection project the brief says which directory is which repository.
    const workspace = isConnectionRun(run) ? workspaceOfMembers(run.members) : null
    const drafts = pending.map((item): KanbanTicketBatchCreateItem => {
      const launch = item.launch_config ?? run.config.defaultLaunch
      const model = launch?.model
      return {
        draft_key: item.key,
        project_id: run.project_id,
        title: sanitizeLine(`${item.key} · ${item.title}`),
        // The ticket is the brief its agent gets: the runner sends this description as the
        // prompt, so an edit on the board reaches the agent. The extracted description stays
        // on the run's item.
        description: buildLaunchPrompt({
          key: item.key,
          title: item.title,
          sourcePath: run.source_path,
          promptStyle: run.config.promptStyle,
          interactive: run.config.interactive,
          sdk: launch?.sdk ?? defaultSdk ?? 'claude-code',
          verification: run.config.verificationDisabled ? [] : item.verification,
          workspace
        }),
        column: 'todo',
        mode: 'build',
        attachments: [
          ...item.figures.map((figure) => ({
            type: 'image',
            url: figure.path,
            label: figure.label
          })),
          ...(run.document_path
            ? [{ type: 'file', url: run.document_path, label: 'Full spec (text)' }]
            : [])
        ],
        // A batch can only link its own drafts; the rest is linked below.
        depends_on: item.depends_on.filter((key) => pendingKeys.has(key)),
        parent_ticket_id: run.ticket_id,
        ...(model
          ? {
              model_provider_id: model.providerID,
              model_id: model.modelID,
              model_variant: model.variant ?? null
            }
          : {})
      }
    })

    const { tickets } = await this.deps.createTickets(run.project_id, drafts)
    // Both board backends return the created tickets in draft order.
    if (tickets.length !== drafts.length) {
      throw new Error(
        `The board created ${tickets.length} tickets for ${drafts.length} tasks; none were linked.`
      )
    }
    const ticketIdByKey = new Map<string, string>()
    for (const item of selected) {
      if (item.ticket_id) ticketIdByKey.set(item.key, item.ticket_id)
    }
    pending.forEach((item, index) => {
      this.saveItem(run, item.id, { ticket_id: tickets[index].id })
      ticketIdByKey.set(item.key, tickets[index].id)
    })

    // Only a retried start has selected dependencies that already had their ticket.
    for (const item of pending) {
      for (const key of item.depends_on) {
        if (!selectedKeys.has(key) || pendingKeys.has(key)) continue
        const dependent = ticketIdByKey.get(item.key)
        const blocker = ticketIdByKey.get(key)
        if (!dependent || !blocker) continue
        try {
          await this.deps.addTicketDependency(run.project_id, dependent, blocker)
        } catch (error) {
          log.warn('Could not link a ticket dependency', {
            runId: run.id,
            item: item.key,
            dependsOn: key,
            error: describeError(error)
          })
        }
      }
    }
    this.log(run, 'tickets_created', `${pending.length} tickets created on the board`)
  }

  // ── The run's own ticket ──────────────────────────────────────────────────

  /**
   * The run's ticket on the board, in `column`. Created with the run, in To Do, where it shows
   * the extraction and opens the preview; at launch it is placed In Progress on the integration
   * worktree, so moving it to Done merges the integration branch into the base branch like any
   * ticket's work. It has no session; the external-source fields mark it (both board backends
   * store those), and `external_url` carries the path of the document the run was made from, so
   * the ticket row itself says which file to open even once the run record is gone (a run made
   * from board tickets has no file: none, so the board offers no document to open).
   * On a connection project the ticket has no worktree: the board merges the run's integration
   * instance member by member from `integration_connection_id` instead.
   * Idempotent: a run that has its ticket gets it placed, not a second one; a ticket deleted
   * from the board (its run spared) is replaced.
   */
  private ensureRunTicket(run: DocumentRun, column: KanbanTicketColumn): Promise<DocumentRun> {
    return this.runTicketLocks.run(run.id, async () => {
      let current = this.db.getDocumentRun(run.id) ?? run
      if (current.ticket_id) {
        const placed = await this.placeRunTicket(current, current.ticket_id, column)
        if (placed) return current
        current = this.saveRun(current, { ticket_id: null })
      }
      const { tickets } = await this.deps.createTickets(current.project_id, [
        {
          draft_key: `run-${current.id}`,
          project_id: current.project_id,
          title: sanitizeLine(current.title) || runKindLabel(current),
          description: this.runTicketDescription(current),
          column,
          mode: null,
          worktree_id: current.integration_worktree_id,
          external_provider: DOCUMENT_RUN_TICKET_PROVIDER,
          external_id: current.id,
          external_url: isTicketRun(current) ? null : current.source_path
        }
      ])
      const ticket = tickets[0]
      if (!ticket) throw new Error('The board did not create the ticket of the run.')
      // Several app instances share one database: the instance that linked its ticket first
      // keeps it.
      const raced = this.db.getDocumentRun(current.id)
      if (!raced || raced.ticket_id) {
        await this.deps.deleteTicket(current.project_id, ticket.id).catch(() => undefined)
        if (!raced) throw notFound('The run')
        return raced
      }
      const updated = this.saveRun(raced, { ticket_id: ticket.id })
      this.log(updated, 'run_ticket_created', 'The run got its ticket on the board')
      // A new run's ticket goes to the top of To Do, where the user looks for what they just made.
      if (column === 'todo') {
        await this.deps
          .moveTicket(updated.project_id, ticket.id, column)
          .catch((error: unknown) => {
            log.warn('Could not move the ticket of a document run to the top of To Do', {
              runId: updated.id,
              error: describeError(error)
            })
          })
      }
      this.linkChildTickets(updated)
      return updated
    })
  }

  /**
   * The run's existing ticket, placed in `column`: at launch the ticket made with the run takes
   * the integration worktree and the launched description, then leaves To Do for In Progress.
   * False when the ticket is gone from the board.
   */
  private async placeRunTicket(
    run: DocumentRun,
    ticketId: string,
    column: KanbanTicketColumn
  ): Promise<boolean> {
    const ticket = await this.deps.getTicket(run.project_id, ticketId)
    if (!ticket) return false
    if (hasIntegration(run)) {
      await this.deps.updateTicket(run.project_id, ticketId, {
        worktree_id: run.integration_worktree_id,
        description: this.runTicketDescription(run)
      })
    }
    if (ticket.column !== column) {
      await this.deps.moveTicket(run.project_id, ticketId, column)
      this.log(
        run,
        'run_ticket_moved',
        `The run's ticket moved to ${RUN_TICKET_COLUMN_NAMES[column]}`
      )
    }
    return true
  }

  /** The run's title on its ticket; cosmetic, so never fatal. */
  private async stampRunTicketTitle(run: DocumentRun): Promise<void> {
    if (!run.ticket_id) return
    const ticketId = run.ticket_id
    try {
      await this.detach(() =>
        this.deps.updateTicket(run.project_id, ticketId, {
          title: sanitizeLine(run.title) || runKindLabel(run)
        })
      )
    } catch (error) {
      log.warn('Could not rename the ticket of a document run', {
        runId: run.id,
        ticketId,
        error: describeError(error)
      })
    }
  }

  /**
   * Points the run's existing task and fix tickets at the run's ticket (their parent key on
   * the board). A launch creates the parent before the children, so this only has work for a
   * run that got its ticket late (reconcile of a run from before run tickets existed).
   * Cosmetic, so detached and never fatal.
   */
  private linkChildTickets(run: DocumentRun): void {
    const parentId = run.ticket_id
    if (!parentId) return
    // An orchestrator's unchecked ticket is not part of the launch, and leaves the run at it.
    const children = this.db
      .getDocumentRunItems(run.id)
      .flatMap((item) =>
        isTicketRun(run) && !item.selected ? [] : [item.ticket_id, item.fix_ticket_id]
      )
      .filter((id): id is string => !!id && id !== parentId)
    for (const ticketId of children) {
      void this.detach(() =>
        this.deps.updateTicket(run.project_id, ticketId, { parent_ticket_id: parentId })
      ).catch((error: unknown) => {
        log.warn('Could not link a ticket to the run ticket', {
          runId: run.id,
          ticketId,
          error: describeError(error)
        })
      })
    }
  }

  private runTicketDescription(run: DocumentRun): string {
    // A run made from board tickets is named by what it holds: it has no document.
    const what = isTicketRun(run)
      ? `Orchestrator of ${boardTicketCount(this.db.getDocumentRunItems(run.id).length)}`
      : `Document run of ${run.source_path}`
    const whose = isTicketRun(run) ? 'its tickets' : "the run's tickets"
    if (!hasIntegration(run)) {
      return isTicketRun(run)
        ? `${what}; open this ticket to review them and launch the run.`
        : `${what}. Its tickets are extracted from the document; open this ticket to review them and launch the run.`
    }
    if (!isConnectionRun(run)) {
      return `${what}. Its branch ${run.integration_branch} collects the merged work of ${whose}; move this ticket to Done to merge it into ${run.base_branch}.`
    }
    const branches = run.members
      .map(
        (member) =>
          `${member.project_name}: ${member.integration_branch} (from ${member.base_branch})`
      )
      .join(', ')
    return `${what}. Its integration instance at ${run.integration_connection_path} collects the merged work of ${whose}, one branch per member repository — ${branches}; move this ticket to Done to merge each into its base branch.`
  }

  /**
   * A run that ended leaves In Progress for Review, once: from there its ticket is the user's
   * to move (to Done, which merges it). Never fails the operation that ended the run.
   */
  private settleRunTicket(run: DocumentRun): Promise<void> {
    // Decided from the current row, under the run's ticket lock: the startup reconcile holds
    // a snapshot from before a migration session the user just started.
    return this.runTicketLocks.run(run.id, async () => {
      const current = this.db.getDocumentRun(run.id) ?? run
      const ticketId = current.ticket_id
      // A session executing the run's migrations holds the ticket In Progress until it is done.
      if (!ticketId || !isEndedRunStatus(current.status) || current.migration_session_id) return
      try {
        const ticket = await this.deps.getTicket(current.project_id, ticketId)
        if (ticket?.column !== 'in_progress') return
        await this.detach(() => this.deps.moveTicket(current.project_id, ticketId, 'review'))
      } catch (error) {
        log.warn('Could not move the ticket of a finished document run to review', {
          runId: run.id,
          ticketId,
          error: describeError(error)
        })
      }
    })
  }

  /**
   * Ticket branches are cut from the integration branch but recorded against the run's base
   * branch, so the board merges a ticket (a follow-up after the run, say) straight into it.
   * Worktrees of runs launched before that still name the integration branch.
   */
  private repointTaskWorktrees(run: DocumentRun): void {
    const items = this.db.getDocumentRunItems(run.id)
    if (isConnectionRun(run)) {
      // Per member: a ticket's worktree in `web` follows web's branches.
      for (const member of run.members) {
        for (const item of items) {
          const own = item.members?.find((candidate) => candidate.project_id === member.project_id)
          if (own)
            this.repointWorktree(own.worktree_id, member.integration_branch, member.base_branch)
        }
      }
      return
    }
    const { base_branch: base, integration_branch: integration } = run
    if (!base || !integration) return
    for (const item of items) {
      if (item.worktree_id) this.repointWorktree(item.worktree_id, integration, base)
    }
  }

  private repointWorktree(worktreeId: string, integration: string, base: string): void {
    if (base === integration) return
    const worktree = this.deps.getWorktree(worktreeId)
    if (worktree?.base_branch !== integration) return
    this.deps.setWorktreeBaseBranch(worktree.id, base)
  }

  /** Whether the run's integration worktree, or integration instance, is still there and active. */
  private integrationIsActive(run: DocumentRun): boolean {
    if (run.integration_connection_id) {
      const connection = this.deps.getConnection(run.integration_connection_id)
      return connection !== null && (connection.status ?? 'active') === 'active'
    }
    if (!run.integration_worktree_id) return false
    const worktree = this.deps.getWorktree(run.integration_worktree_id)
    return worktree !== null && (worktree.status ?? 'active') === 'active'
  }

  /**
   * Startup repair, safe to repeat. Runs launched before runs had a ticket get one while their
   * integration worktree is still there, their ticket worktrees are re-pointed at the base
   * branch, and a run that ended while no one was looking leaves In Progress. So does one whose
   * migration session died with the app.
   */
  async reconcileRunTickets(): Promise<void> {
    let runs: DocumentRun[]
    try {
      runs = this.db.listDocumentRuns(undefined, RECONCILED_RUNS)
    } catch (error) {
      log.warn('Could not list the document runs to reconcile', { error: describeError(error) })
      return
    }
    for (const run of runs) {
      const active = isActiveRunStatus(run.status)
      if (!hasIntegration(run) || (!active && !isEndedRunStatus(run.status))) continue
      // A launch under way creates the ticket itself.
      if (this.startsInFlight.has(run.id)) continue
      try {
        this.detach(() => this.repointTaskWorktrees(run))
        if (run.ticket_id) {
          await this.settleRunTicket(this.dropDeadMigrationSession(run))
          continue
        }
        // A run cancelled before its launch finished never had a ticket.
        if (!run.started_at || !this.integrationIsActive(run)) continue
        await this.detach(() => this.ensureRunTicket(run, active ? 'in_progress' : 'review'))
      } catch (error) {
        log.warn('Could not reconcile the ticket of a document run', {
          runId: run.id,
          error: describeError(error)
        })
      }
    }
  }

  // ── Migrations of a finished run ──────────────────────────────────────────

  /**
   * Record the session that executes a finished run's migrations in the integration worktree.
   * The run's ticket goes back to In Progress for as long as that session is at it. Refused
   * while another session is: one worktree, one set of migrations.
   */
  async startMigrations(runId: string, sessionId: string): Promise<DocumentRunDetail> {
    const run = this.requireRun(runId)
    if (run.migration_session_id === sessionId) return this.detail(run, true)
    if (run.migration_session_id) {
      throw invalidState('The migrations of this run are already being executed.')
    }
    if (!isEndedRunStatus(run.status) || !run.report) {
      throw invalidState('Only a run that has finished has migrations to execute.')
    }
    const updated = this.saveRun(run, {
      migration_session_id: sessionId,
      migration_started_at: this.now().toISOString(),
      migration_owner_pid: this.deps.getAppPid?.() ?? null
    })
    this.log(updated, 'migrations_started', 'Started a session to execute the migrations', {
      data: { sessionId }
    })
    await this.holdRunTicket(updated)
    return this.detail(updated, true)
  }

  /**
   * The migration session is over: it finished, or the user stopped it. The run's ticket
   * returns to Review. A no-op unless `sessionId` is still the run's migration session, so a
   * late caller cannot end a session that was started since.
   */
  async endMigrations(
    runId: string,
    sessionId: string,
    outcome: DocumentMigrationOutcome
  ): Promise<DocumentRunDetail> {
    const run = this.requireRun(runId)
    if (run.migration_session_id !== sessionId) return this.detail(run, true)
    const updated = this.saveRun(run, NO_MIGRATION_SESSION)
    if (outcome === 'stopped') {
      this.log(updated, 'migrations_stopped', 'The migration session was stopped')
    } else {
      this.log(updated, 'migrations_finished', 'The migration session finished')
    }
    await this.settleRunTicket(updated)
    return this.detail(updated, true)
  }

  /**
   * A finished run whose migrations are being executed is at work again: its ticket returns
   * from Review to In Progress. A ticket the user already moved on (Done, Merged) stays put.
   * Never fails the operation that started the session.
   */
  private holdRunTicket(run: DocumentRun): Promise<void> {
    return this.runTicketLocks.run(run.id, async () => {
      const current = this.db.getDocumentRun(run.id) ?? run
      const ticketId = current.ticket_id
      // Ended already (stopped before the move got its turn): nothing to hold.
      if (!ticketId || !current.migration_session_id) return
      try {
        const ticket = await this.deps.getTicket(current.project_id, ticketId)
        if (ticket?.column !== 'review') return
        await this.detach(() => this.deps.moveTicket(current.project_id, ticketId, 'in_progress'))
      } catch (error) {
        log.warn('Could not move the ticket of a document run back to in progress', {
          runId: run.id,
          ticketId,
          error: describeError(error)
        })
      }
    })
  }

  /**
   * A migration session started before the app did died with it (sessions do not outlive the
   * app; this server child restarting on its own kills none). Nothing is left to stop. Several
   * app instances share one database: a session of another instance that is still running is
   * that instance's to end, and is left alone.
   */
  private dropDeadMigrationSession(snapshot: DocumentRun): DocumentRun {
    // The row as it is now: the reconcile's snapshot may predate a session started since.
    const run = this.db.getDocumentRun(snapshot.id) ?? snapshot
    if (!run.migration_session_id) return run
    const appStartedAt = this.deps.getAppStartedAt?.() ?? SERVER_STARTED_AT
    if (run.migration_started_at && run.migration_started_at >= appStartedAt) return run
    const owner = run.migration_owner_pid
    const alive = this.deps.isProcessAlive ?? isProcessAlive
    if (owner !== null && owner !== (this.deps.getAppPid?.() ?? null) && alive(owner)) return run
    const updated = this.saveRun(run, NO_MIGRATION_SESSION)
    this.log(updated, 'migrations_interrupted', 'The migration session ended with the app')
    return updated
  }

  /**
   * Deleting a run's own ticket deletes the run with it (a finished run has no other way in);
   * refused while the run is running or paused. Branches and worktrees are kept. A ticket
   * whose run is already gone is simply deleted.
   */
  async deleteRunTicket(projectId: string, ticketId: string, runId: string): Promise<boolean> {
    const run = this.db.getDocumentRun(runId)
    if (run && run.project_id === projectId && run.ticket_id === ticketId) {
      if (isActiveRunStatus(run.status)) {
        throw invalidState('Cancel the run before deleting its ticket.')
      }
      await this.delete(run.id)
      return true
    }
    await this.deps.deleteTicket(projectId, ticketId)
    return true
  }

  claimRunner(runId: string, clientId: string): DocumentRunnerClaim {
    const run = this.requireRun(runId)
    const now = this.now()
    const claim = this.db.claimDocumentRunRunner(
      runId,
      clientId,
      now.toISOString(),
      new Date(now.getTime() - RUNNER_LEASE_STALE_MS).toISOString()
    )
    // A renewed lease changes nothing anyone displays; a new owner does.
    if (claim.ownerClientId !== run.runner_client_id) this.publishRun(run)
    return { ...claim, serverStartedAt: this.deps.getAppStartedAt?.() ?? SERVER_STARTED_AT }
  }

  // ── Classification ────────────────────────────────────────────────────────

  async classify(params: {
    runId: string
    itemId: string
    finalMessage?: string | null
  }): Promise<DocumentRunVerdict> {
    const { run, item } = this.requireItem(params.runId, params.itemId)
    if (!item.session_id) throw invalidState(`${item.key} has no session to judge yet.`)
    const sessionId = item.session_id

    let message = params.finalMessage ?? ''
    if (message.trim() === '') {
      try {
        message =
          (await this.deps.resolveFinalMessage({
            sessionId,
            worktreePath: this.sessionDirectory(item)
          })) ?? ''
      } catch (error) {
        log.warn('Could not read a session final message', {
          runId: run.id,
          sessionId,
          error: describeError(error)
        })
      }
    }

    let verdict: DocumentRunVerdict
    if (message.trim() === '') {
      verdict = fallbackVerdict(
        "Could not read the session's final message.",
        this.now().toISOString()
      )
    } else {
      // What the session still had running at the turn end, as the hook that recorded it saw
      // (null for sessions that cannot say: SDK, Codex, an older claude).
      const background = this.deps.db.getSessionFinalMessage(sessionId)?.background_work ?? null
      verdict = await this.judge(run, item, message, background)
      // A wait holds only while something runs that can wake the agent: with nothing in the
      // background, "waiting" is work the agent stopped short of, and is treated as such.
      if (verdict.status === 'waiting' && background === 0) {
        verdict = {
          ...verdict,
          status: 'partial',
          reason: `${verdict.reason.replace(/[.!?]\s*$/, '')}, but no background work of its session is running, so nothing will wake it.`
        }
      }
    }

    this.saveItem(run, item.id, { verdict })
    this.log(
      run,
      'verdict',
      `${item.key}: ${verdict.status.replace(/_/g, ' ')} — ${verdict.reason}`,
      {
        itemId: item.id,
        data: { status: verdict.status, reason: verdict.reason, source: verdict.source }
      }
    )
    return verdict
  }

  /** Without a readable reply: the agent's own footer, then what the message and branch show. */
  private async judge(
    run: DocumentRun,
    item: DocumentRunItem,
    message: string,
    runningBackgroundWork: number | null
  ): Promise<DocumentRunVerdict> {
    const facts = await this.gitFacts(run, item)
    const generation = run.config.generation
    try {
      const reply = await this.classifications.run(() =>
        this.deps.generate(
          buildClassificationPrompt({
            ticketKey: item.key,
            ticketTitle: item.title,
            finalMessage: message,
            commitsAhead: facts.commitsAhead,
            hasUncommittedChanges: facts.dirty,
            runningBackgroundWork
          }),
          CLASSIFICATION_SYSTEM_PROMPT,
          generation?.provider ?? 'claude-code',
          {
            modelOverride: generation?.model,
            effort: generation?.effort,
            outputSchema: CLASSIFICATION_JSON_SCHEMA,
            cwd: tmpdir(),
            timeoutMs: CLASSIFICATION_TIMEOUT_MS,
            maxRetries: 1
          }
        )
      )
      const verdict = parseClassificationResponse(reply ?? '', this.now().toISOString())
      if (!verdict) throw new Error('its reply was not a verdict')
      return verdict
    } catch (error) {
      return verdictForUnjudgedMessage(
        {
          finalMessage: message,
          commitsAhead: facts.commitsAhead,
          hasUncommittedChanges: facts.dirty,
          failure: describeError(error)
        },
        this.now().toISOString()
      )
    }
  }

  /**
   * Where the ticket's session runs, for reading its transcript: the ticket worktree, or on a
   * connection project the ticket's connection directory.
   */
  private sessionDirectory(item: DocumentRunItem): string | null {
    if (item.connection_id) return this.deps.getConnection(item.connection_id)?.path ?? null
    return item.worktree_id ? (this.deps.getWorktree(item.worktree_id)?.path ?? null) : null
  }

  /**
   * What the branch says, for the classifier: commits the integration branch does not have and
   * whether work is uncommitted. Across the members of a connection run: the commits summed,
   * dirty when any member is. null when no worktree can be read.
   */
  private async gitFacts(
    run: DocumentRun,
    item: DocumentRunItem
  ): Promise<{ commitsAhead: number | null; dirty: boolean | null }> {
    const checkouts: {
      worktree: DocumentFlowWorktree
      branch: string | null
      into: string | null
    }[] = []
    if (isConnectionRun(run)) {
      for (const member of run.members) {
        const own = item.members?.find((candidate) => candidate.project_id === member.project_id)
        const worktree = own ? this.deps.getWorktree(own.worktree_id) : null
        if (worktree) {
          checkouts.push({
            worktree,
            branch: own?.branch_name || worktree.branch_name,
            into: member.integration_branch
          })
        }
      }
    } else {
      const worktree = item.worktree_id ? this.deps.getWorktree(item.worktree_id) : null
      if (worktree) {
        checkouts.push({
          worktree,
          branch: item.branch_name || worktree.branch_name,
          into: run.integration_branch
        })
      }
    }
    const readable = checkouts.filter(({ worktree }) => existsSync(worktree.path))
    if (readable.length === 0) return { commitsAhead: null, dirty: null }

    const facts = await Promise.all(
      readable.map(async ({ worktree, branch, into }) => {
        const [commitsAhead, dirty] = await Promise.all([
          into && branch
            ? this.git.commitsAhead(worktree.path, into, branch).catch(() => null)
            : null,
          this.git.isDirty(worktree.path).catch(() => null)
        ])
        return { commitsAhead, dirty }
      })
    )
    const counts = facts.map((fact) => fact.commitsAhead)
    const flags = facts.map((fact) => fact.dirty)
    return {
      commitsAhead: counts.every((count) => count === null)
        ? null
        : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0),
      dirty: flags.some((flag) => flag === true)
        ? true
        : flags.every((flag) => flag === null)
          ? null
          : false
    }
  }

  // ── Merge ─────────────────────────────────────────────────────────────────

  /**
   * Dry run of the ticket's merge into the integration branch — on a connection project into
   * every member's, all of them, so a conflict prompt can name each member's commit. Read-only
   * but for committing what the ticket's agent left uncommitted.
   */
  async prepareMerge(runId: string, itemId: string): Promise<DocumentMergeCheckResult> {
    const { run, item } = this.requireItem(runId, itemId)
    const progress = { committed: false }
    try {
      const contexts = this.mergeContexts(run, item)
      if (!isConnectionRun(run)) {
        const check = await this.checkMerge(run, item, contexts[0], progress)
        return {
          state: check.state,
          conflictedFiles: check.conflictedFiles,
          integrationHead: check.integrationHead,
          committed: progress.committed,
          commitsAhead: check.commitsAhead,
          ...(check.alreadyMerged ? { alreadyMerged: true } : {})
        }
      }

      const checks: { member: DocumentRunMember; check: MergeCheck }[] = []
      for (const context of contexts) {
        const member = memberOf(context)
        try {
          checks.push({ member, check: await this.checkMerge(run, item, context, progress) })
        } catch (error) {
          throw new Error(`${member.project_name}: ${describeError(error)}`)
        }
      }
      const members = checks.map(
        ({ member, check }): DocumentMergeCheckMember => ({
          project_id: member.project_id,
          project_name: member.project_name,
          symlink_name: member.symlink_name,
          integrationBranch: member.integration_branch,
          integrationHead: check.integrationHead,
          state: check.state,
          conflictedFiles: check.conflictedFiles,
          commitsAhead: check.commitsAhead
        })
      )
      const conflicted = checks.some(({ check }) => check.state === 'conflict')
      // Merged already as a whole: every member either has the merge or had nothing to merge.
      const alreadyMerged =
        !conflicted &&
        checks.some(({ check }) => check.alreadyMerged) &&
        checks.every(({ check }) => check.alreadyMerged || check.commitsAhead === 0)
      const state: DocumentMergeCheckState = conflicted
        ? 'conflict'
        : checks.every(({ check }) => check.state === 'no_changes')
          ? 'no_changes'
          : 'clean'
      return {
        state,
        conflictedFiles: members.flatMap((member) =>
          member.conflictedFiles.map((file) => `${member.symlink_name}/${file}`)
        ),
        integrationHead: compositeSha(
          members.map((member) => ({
            symlink_name: member.symlink_name,
            sha: member.integrationHead
          }))
        ),
        members,
        committed: progress.committed,
        commitsAhead: checks.reduce((sum, { check }) => sum + check.commitsAhead, 0),
        ...(alreadyMerged ? { alreadyMerged: true } : {})
      }
    } catch (error) {
      return {
        state: 'error',
        conflictedFiles: [],
        committed: progress.committed,
        commitsAhead: 0,
        error: describeError(error)
      }
    }
  }

  /** The dry run against one integration checkout. `progress.committed` is set as soon as it happens. */
  private async checkMerge(
    run: DocumentRun,
    item: DocumentRunItem,
    context: MergeContext,
    progress: { committed: boolean }
  ): Promise<MergeCheck> {
    const { path: integrationPath, branch: integrationBranch, ticketBranch, ticketPath } = context
    const where = context.member ? ` in ${context.member.project_name}` : ''
    if (!ticketPath) throw new Error(`The worktree of ${item.key} no longer exists.`)
    if (!existsSync(ticketPath)) {
      throw new Error(`The worktree of ${item.key} is missing: ${ticketPath}`)
    }
    const checkedOut = await this.git.currentBranch(ticketPath)
    if (checkedOut !== ticketBranch) {
      throw new Error(
        `The worktree of ${item.key} has ${checkedOut ? `branch ${checkedOut}` : 'a detached HEAD'} checked out, not ${ticketBranch}.`
      )
    }
    // The commit the check is made against: the one a conflicting session is told to merge,
    // rather than the branch name, whose tip may be an unverified merge by then. Read before
    // the worktree is looked at, so a session left mid-merge is told it too.
    const integrationHead = await this.git.revParse(
      integrationPath,
      `refs/heads/${integrationBranch}`
    )
    if (!integrationHead) throw new Error(`Branch ${integrationBranch} was not found.`)

    // The agent was told to commit; this is the safety net for what it left behind.
    if ((await this.git.isDirty(ticketPath)) || (await this.git.hasMergeHead(ticketPath))) {
      const unresolved = await this.git.conflictedFiles(ticketPath)
      if (unresolved.length > 0) {
        // Committing now would record the conflict markers as the resolution.
        return {
          state: 'conflict',
          conflictedFiles: unresolved,
          integrationHead,
          commitsAhead: await this.git
            .commitsAhead(integrationPath, integrationBranch, ticketBranch)
            .catch(() => 0),
          alreadyMerged: false
        }
      }
      const commit = await this.git.commitAll(ticketPath, `${item.key} · ${item.title}`)
      if (commit.committed) {
        progress.committed = true
        this.log(
          run,
          'auto_commit',
          `${item.key}: uncommitted work committed before merging${where}`,
          { itemId: item.id, data: { sha: commit.sha } }
        )
      }
    }

    const tip = await this.git.revParse(integrationPath, `refs/heads/${ticketBranch}`)
    if (!tip) throw new Error(`Branch ${ticketBranch} was not found.`)
    if (await this.findMergeCommit(context, tip)) {
      return {
        state: 'clean',
        alreadyMerged: true,
        conflictedFiles: [],
        integrationHead,
        commitsAhead: 0
      }
    }
    await this.assertNoRolledBackMerge(run, item, context, tip, integrationHead)

    const commitsAhead = await this.git.commitsAhead(
      integrationPath,
      integrationBranch,
      ticketBranch
    )
    if (commitsAhead === 0) {
      return {
        state: 'no_changes',
        conflictedFiles: [],
        integrationHead,
        commitsAhead,
        alreadyMerged: false
      }
    }

    const check = await this.git.mergeTreeCheck(integrationPath, integrationBranch, ticketBranch)
    if (check.state === 'conflict') {
      return {
        state: 'conflict',
        conflictedFiles: check.files,
        integrationHead,
        commitsAhead,
        alreadyMerged: false
      }
    }
    // `unknown` (a git too old for a dry run) is left for the real merge to decide.
    return {
      state: 'clean',
      conflictedFiles: [],
      integrationHead,
      commitsAhead,
      alreadyMerged: false
    }
  }

  async merge(runId: string, itemId: string): Promise<DocumentMergeResult> {
    this.requireItem(runId, itemId)
    const merging = this.mergeLocked(runId, itemId)
    this.mergesInFlight.set(runId, merging)
    try {
      return await merging
    } finally {
      if (this.mergesInFlight.get(runId) === merging) this.mergesInFlight.delete(runId)
    }
  }

  private mergeLocked(runId: string, itemId: string): Promise<DocumentMergeResult> {
    return this.integrationLocks.run(runId, async () => {
      // Read again inside the lock: an earlier merge may have just finished.
      const { run, item } = this.requireItem(runId, itemId)
      try {
        const contexts = this.mergeContexts(run, item)
        return isConnectionRun(run)
          ? await this.mergeMembers(run, item, contexts)
          : await this.mergeOne(run, item, contexts[0])
      } catch (error) {
        return { success: false, error: describeError(error) }
      }
    })
  }

  /**
   * The integration checkout as a merge needs it: on its branch, no merge left half-way, and
   * nothing uncommitted (a fix session's leftovers are committed rather than lost).
   */
  private async readyCheckout(
    run: DocumentRun,
    item: DocumentRunItem,
    context: MergeContext
  ): Promise<void> {
    const { path } = context
    await this.assertIntegrationCheckout(context)
    if (await this.git.hasMergeHead(path)) await this.git.mergeAbort(path)
    if (await this.git.isDirty(path)) {
      const commit = await this.git.commitAll(
        path,
        `Save uncommitted changes before merging ${item.key}`
      )
      if (commit.committed) {
        const where = context.member ? ` of ${context.member.project_name}` : ''
        this.log(
          run,
          'integration_commit',
          `Uncommitted changes in the integration worktree${where} were committed before merging ${item.key}`,
          { itemId: item.id, data: { sha: commit.sha } }
        )
      }
    }
  }

  /** The merge into a git project's integration branch. */
  private async mergeOne(
    run: DocumentRun,
    item: DocumentRunItem,
    context: MergeContext
  ): Promise<DocumentMergeResult> {
    const { path: integrationPath, ticketBranch } = context
    await this.readyCheckout(run, item, context)

    const tip = await this.git.revParse(integrationPath, `refs/heads/${ticketBranch}`)
    if (!tip) throw new Error(`Branch ${ticketBranch} was not found.`)
    const existing = await this.findMergeCommit(context, tip)
    if (existing) {
      if (!item.merge_sha || !item.pre_merge_sha) {
        this.saveItem(run, item.id, {
          merge_sha: item.merge_sha ?? existing,
          pre_merge_sha:
            item.pre_merge_sha ?? (await this.git.revParse(integrationPath, `${existing}^1`))
        })
      }
      return { success: true, alreadyMerged: true, mergeSha: existing }
    }
    const preMergeSha = await this.git.revParse(integrationPath, 'HEAD')
    if (!preMergeSha) throw new Error('The integration branch has no commits.')
    if (await this.git.isAncestor(integrationPath, tip, preMergeSha)) {
      // Nothing of the branch is missing; there is no merge commit to record or roll back.
      return { success: true, alreadyMerged: true }
    }
    await this.assertNoRolledBackMerge(run, item, context, tip, preMergeSha)

    const attempt = await this.git.mergeNoFf(
      integrationPath,
      ticketBranch,
      `Merge ${item.key} · ${item.title}`
    )
    if (!attempt.ok) {
      const conflicted = await this.git.conflictedFiles(integrationPath).catch(() => [])
      if (await this.git.hasMergeHead(integrationPath)) {
        await this.git.mergeAbort(integrationPath)
      }
      this.log(
        run,
        'merge_failed',
        conflicted.length > 0
          ? `${item.key} conflicts with ${run.integration_branch} in ${conflicted.length} file(s)`
          : `${item.key} could not be merged`,
        { itemId: item.id, data: { conflictedFiles: conflicted } }
      )
      return conflicted.length > 0
        ? { success: false, conflictedFiles: conflicted }
        : { success: false, error: describeError(attempt.output || 'git merge failed') }
    }

    const mergeSha = await this.git.revParse(integrationPath, 'HEAD')
    this.saveItem(run, item.id, { pre_merge_sha: preMergeSha, merge_sha: mergeSha })
    this.log(run, 'merged', `${item.key} merged into ${run.integration_branch}`, {
      itemId: item.id,
      data: { mergeSha, preMergeSha }
    })
    return { success: true, mergeSha: mergeSha ?? undefined }
  }

  /**
   * The merge into a connection run's members, all or nothing: every member is readied and
   * checked first, then merged in member order; a member that will not merge has the members
   * merged before it in this call reset to where they were. A member the ticket brought nothing
   * new to merges nothing, and a member merged by an earlier (interrupted) call keeps its merge.
   * Every member's pre-merge commit is recorded, so a later launch can cut from them.
   */
  private async mergeMembers(
    run: DocumentRun,
    item: DocumentRunItem,
    contexts: readonly MergeContext[]
  ): Promise<DocumentMergeResult> {
    interface Plan {
      context: MergeContext
      member: DocumentRunMember
      preMergeSha: string
      existing: string | null
      /** The tip is on the integration branch already: an earlier merge, or nothing to merge. */
      inBranch: boolean
    }
    const plans: Plan[] = []
    for (const context of contexts) {
      const member = memberOf(context)
      const { path, ticketBranch } = context
      await this.readyCheckout(run, item, context)
      const tip = await this.git.revParse(path, `refs/heads/${ticketBranch}`)
      if (!tip) throw new Error(`Branch ${ticketBranch} was not found in ${member.project_name}.`)
      const head = await this.git.revParse(path, 'HEAD')
      if (!head) throw new Error(`The integration branch of ${member.project_name} has no commits.`)
      const existing = await this.findMergeCommit(context, tip)
      const preMergeSha = existing
        ? ((await this.git.revParse(path, `${existing}^1`)) ?? head)
        : head
      const inBranch = existing !== null || (await this.git.isAncestor(path, tip, head))
      if (!inBranch) await this.assertNoRolledBackMerge(run, item, context, tip, head)
      plans.push({ context, member, preMergeSha, existing, inBranch })
    }
    if (plans.every((plan) => plan.inBranch && plan.existing === null)) {
      // Nothing of any branch is missing; there is no merge commit to record or roll back.
      return { success: true, alreadyMerged: true }
    }

    const merges: MemberMerge[] = []
    for (const plan of plans) {
      const { context, member } = plan
      if (plan.inBranch) {
        merges.push({
          context,
          preMergeSha: plan.preMergeSha,
          mergeSha: plan.existing,
          fresh: false
        })
        continue
      }
      let attempt: Awaited<ReturnType<DocumentFlowGit['mergeNoFf']>>
      try {
        attempt = await this.git.mergeNoFf(
          context.path,
          context.ticketBranch,
          `Merge ${item.key} · ${item.title}`
        )
      } catch (error) {
        await this.undoMemberMerges(run, item, merges)
        throw error
      }
      if (attempt.ok) {
        const mergeSha = await this.git.revParse(context.path, 'HEAD')
        merges.push({ context, preMergeSha: plan.preMergeSha, mergeSha, fresh: true })
        continue
      }
      const conflicted = await this.git.conflictedFiles(context.path).catch(() => [])
      if (await this.git.hasMergeHead(context.path)) await this.git.mergeAbort(context.path)
      const undone = await this.undoMemberMerges(run, item, merges)
      const prefixed = conflicted.map((file) => `${member.symlink_name}/${file}`)
      const rolledBack = undone.length > 0 ? `; the merge into ${undone.join(', ')} was undone` : ''
      this.log(
        run,
        'merge_failed',
        conflicted.length > 0
          ? `${item.key} conflicts with ${member.integration_branch} of ${member.project_name} in ${conflicted.length} file(s)${rolledBack}`
          : `${item.key} could not be merged into ${member.project_name}${rolledBack}`,
        {
          itemId: item.id,
          data: {
            conflictedFiles: prefixed,
            member: { project_id: member.project_id, symlink_name: member.symlink_name },
            undone
          }
        }
      )
      return conflicted.length > 0
        ? { success: false, conflictedFiles: prefixed }
        : { success: false, error: describeError(attempt.output || 'git merge failed') }
    }

    const recorded = this.recordMemberMerges(run, item, merges)
    const fresh = merges.filter((merge) => merge.fresh)
    if (fresh.length > 0) {
      this.log(
        run,
        'merged',
        `${item.key} merged into ${fresh.map((merge) => `${memberOf(merge.context).integration_branch} of ${memberOf(merge.context).project_name}`).join(', ')}`,
        {
          itemId: item.id,
          data: {
            mergeSha: recorded.merge_sha,
            preMergeSha: recorded.pre_merge_sha,
            members: merges.map((merge) => ({
              project_id: memberOf(merge.context).project_id,
              symlink_name: memberOf(merge.context).symlink_name,
              mergeSha: merge.mergeSha,
              preMergeSha: merge.preMergeSha
            }))
          }
        }
      )
    }
    return {
      success: true,
      ...(recorded.merge_sha ? { mergeSha: recorded.merge_sha } : {}),
      ...(fresh.length === 0 ? { alreadyMerged: true } : {})
    }
  }

  /**
   * Reset the members merged so far in this call to their pre-merge commits, newest first.
   * Returns the names of the members that were reset. A reset that fails is logged and left for
   * the user: the merge result that follows says the ticket did not merge either way.
   */
  private async undoMemberMerges(
    run: DocumentRun,
    item: DocumentRunItem,
    merges: readonly MemberMerge[]
  ): Promise<string[]> {
    const undone: string[] = []
    for (const merge of [...merges].reverse()) {
      if (!merge.fresh) continue
      const member = memberOf(merge.context)
      try {
        await this.git.resetHard(merge.context.path, merge.preMergeSha)
        undone.push(member.project_name)
      } catch (error) {
        this.log(
          run,
          'rollback_failed',
          `The merge of ${item.key} into ${member.project_name} could not be undone after another member failed: ${describeError(error)}`,
          { itemId: item.id, data: { member: member.project_id, resetTo: merge.preMergeSha } }
        )
      }
    }
    return undone
  }

  /** Store the per-member shas on the item, with the composites the rest of the flow reads. */
  private recordMemberMerges(
    run: DocumentRun,
    item: DocumentRunItem,
    merges: readonly MemberMerge[]
  ): { pre_merge_sha: string | null; merge_sha: string | null } {
    const members = (item.members ?? []).map((own): DocumentRunItemMember => {
      const merge = merges.find(
        (candidate) => memberOf(candidate.context).project_id === own.project_id
      )
      return merge ? { ...own, pre_merge_sha: merge.preMergeSha, merge_sha: merge.mergeSha } : own
    })
    const patch = { members, ...this.memberComposites(run, members) }
    this.saveItem(run, item.id, patch)
    return { pre_merge_sha: patch.pre_merge_sha, merge_sha: patch.merge_sha }
  }

  /** The item's composite shas from its members, in the run's member order; '' becomes null. */
  private memberComposites(
    run: DocumentRun,
    members: readonly DocumentRunItemMember[]
  ): { pre_merge_sha: string | null; merge_sha: string | null } {
    const ordered = (run.members ?? []).flatMap((member) => {
      const own = members.find((candidate) => candidate.project_id === member.project_id)
      return own ? [{ symlink_name: member.symlink_name, own }] : []
    })
    const pre = compositeSha(
      ordered.map(({ symlink_name, own }) => ({ symlink_name, sha: own.pre_merge_sha }))
    )
    const merged = compositeSha(
      ordered.map(({ symlink_name, own }) => ({ symlink_name, sha: own.merge_sha }))
    )
    return { pre_merge_sha: pre || null, merge_sha: merged || null }
  }

  /**
   * Run the verify command in the integration worktree; on a connection project each member's
   * command in that member's, in member order, stopping at the first failure.
   */
  async verify(runId: string): Promise<DocumentVerifyResult> {
    const commands = runVerifyCommands(this.requireRun(runId))
    if (commands.length === 0) {
      return { skipped: true, ok: true, exitCode: null, timedOut: false, output: '', durationMs: 0 }
    }
    return this.integrationLocks.run(runId, async () => {
      const run = this.requireRun(runId)
      const connection = isConnectionRun(run)
      let checkouts: IntegrationCheckout[]
      try {
        checkouts = this.integrationCheckouts(run)
        for (const checkout of checkouts) await this.assertIntegrationCheckout(checkout)
      } catch (error) {
        throw invalidState(describeError(error))
      }

      // The result describes these commits: a rollback or a later merge makes it history.
      const heads: string[] = []
      for (const checkout of checkouts)
        heads.push((await this.git.revParse(checkout.path, 'HEAD')) ?? '')
      const headKey = connection
        ? compositeSha(
            checkouts.map((checkout, index) => ({
              symlink_name: memberOf(checkout).symlink_name,
              sha: heads[index] || null
            }))
          )
        : heads[0] || null
      const label = connection
        ? commands
            .map(
              ({ project_id, command }) =>
                `${run.members?.find((member) => member.project_id === project_id)?.symlink_name ?? project_id}: ${command}`
            )
            .join('; ')
        : commands[0].command

      let durationMs = 0
      let last: VerifyCommandResult | null = null
      for (const [position, { project_id, command }] of commands.entries()) {
        const index =
          project_id === null
            ? 0
            : checkouts.findIndex((checkout) => checkout.member?.project_id === project_id)
        const checkout = checkouts[index]
        if (!checkout) throw invalidState(`The run has no integration worktree for ${project_id}.`)
        const sha = heads[index] || null
        const result = await this.runVerify(command, checkout.path)
        durationMs += result.durationMs
        last = result
        const ok = result.exitCode === 0 && !result.timedOut
        const outcome = result.timedOut
          ? 'timed out'
          : ok
            ? 'passed'
            : `failed (exit code ${result.exitCode ?? 'unknown'})`
        const member = checkout.member
        this.log(
          run,
          ok ? 'verify_passed' : 'verify_failed',
          `Verify ${outcome}${member ? ` in ${member.project_name}` : ''}: ${command}`,
          {
            data: {
              command,
              sha,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              durationMs: result.durationMs,
              output: ok ? result.output.slice(-PASSED_VERIFY_EVENT_OUTPUT_CHARS) : result.output,
              ...(member
                ? {
                    member: {
                      project_id: member.project_id,
                      project_name: member.project_name,
                      symlink_name: member.symlink_name
                    }
                  }
                : {}),
              // The run-wide view of a connection run's verify, for the report (`lastVerifyOf`):
              // only on the event that decides it — a failure, or the last member passing. A
              // member passing before another has run says nothing about the run.
              ...(member && (!ok || position === commands.length - 1)
                ? { heads: headKey, commands: label }
                : {})
            }
          }
        )
        if (!ok) {
          this.lastVerify.set(run.id, {
            command: label,
            ok: false,
            output: result.output,
            sha: headKey
          })
          return {
            skipped: false,
            ok: false,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            output: result.output,
            durationMs,
            ...(member
              ? {
                  failedMember: {
                    project_id: member.project_id,
                    project_name: member.project_name,
                    symlink_name: member.symlink_name,
                    command
                  }
                }
              : {})
          }
        }
      }
      if (!last) throw invalidState('Nothing to verify.')
      this.lastVerify.set(run.id, { command: label, ok: true, output: last.output, sha: headKey })
      return {
        skipped: false,
        ok: true,
        exitCode: last.exitCode,
        timedOut: last.timedOut,
        output: last.output,
        durationMs,
        ...(connection ? { failedMember: null } : {})
      }
    })
  }

  async commitIntegration(runId: string, message: string): Promise<DocumentCommitResult> {
    this.requireRun(runId)
    return this.integrationLocks.run(runId, async () => {
      const run = this.requireRun(runId)
      try {
        const checkouts = this.integrationCheckouts(run)
        for (const checkout of checkouts) await this.assertIntegrationCheckout(checkout)
        let committed = false
        for (const checkout of checkouts) {
          // Also concludes a merge the fix session resolved but did not commit.
          const commit = await this.git.commitAll(checkout.path, message.trim() || 'Save changes')
          if (!commit.committed) continue
          committed = true
          this.log(
            run,
            'integration_commit',
            `Committed on ${this.describeCheckout(checkout)}: ${message}`,
            {
              data: {
                sha: commit.sha,
                ...(checkout.member ? { member: checkout.member.project_id } : {})
              }
            }
          )
        }
        return { success: true, committed }
      } catch (error) {
        return { success: false, committed: false, error: describeError(error) }
      }
    })
  }

  async rollbackMerge(runId: string, itemId: string): Promise<DocumentSimpleResult> {
    this.requireItem(runId, itemId)
    return this.integrationLocks.run(runId, async () => {
      const { run, item } = this.requireItem(runId, itemId)
      try {
        if (isConnectionRun(run)) await this.rollbackMembers(run, item)
        else await this.rollbackOne(run, item)
        return { success: true }
      } catch (error) {
        return { success: false, error: describeError(error) }
      }
    })
  }

  /** Undo a git project's merge: reset the integration branch to the recorded pre-merge commit. */
  private async rollbackOne(run: DocumentRun, item: DocumentRunItem): Promise<void> {
    const target = item.pre_merge_sha
    if (!target) throw new Error(`${item.key} has no recorded merge to roll back.`)
    const checkout = this.integrationCheckouts(run)[0]
    const path = await this.assertResettable(run, checkout)

    if (await this.git.hasMergeHead(path)) await this.git.mergeAbort(path)
    if (!(await this.git.isAncestor(path, target, 'HEAD'))) {
      throw new Error(
        `The integration branch no longer contains the commit ${item.key} was merged onto.`
      )
    }
    await this.assertNothingMergedAfter(run, item, checkout, target)

    await this.git.resetHard(path, target)
    // The merge is gone as of the reset: the row must say so even if the clean-up fails.
    this.saveItem(run, item.id, { merge_sha: null, pre_merge_sha: null })
    this.lastVerify.delete(run.id)
    this.log(run, 'rolled_back', `The merge of ${item.key} was rolled back`, {
      itemId: item.id,
      data: { resetTo: target, mergeSha: item.merge_sha }
    })
    try {
      await this.git.cleanUntracked(path)
    } catch (error) {
      this.log(
        run,
        'rollback_leftovers',
        `Untracked files left behind after rolling back ${item.key} could not all be removed: ${describeError(error)}`,
        { itemId: item.id }
      )
    }
  }

  /**
   * Undo a connection run's merge in every member that recorded one. Every member passes the
   * safety checks before any is reset; each reset is written to the row as it happens, so a
   * reset that fails half-way leaves the row saying what is still merged.
   */
  private async rollbackMembers(run: DocumentRun, item: DocumentRunItem): Promise<void> {
    if (!isConnectionRun(run)) return
    const plans: { checkout: IntegrationCheckout; own: DocumentRunItemMember; target: string }[] =
      []
    for (const member of run.members) {
      const own = item.members?.find((candidate) => candidate.project_id === member.project_id)
      // A member the item merged nothing into has a pre-merge head (for launches to cut from)
      // but no merge: nothing to reset there.
      if (!own?.pre_merge_sha || !own.merge_sha) continue
      plans.push({ checkout: this.memberCheckout(run, member), own, target: own.pre_merge_sha })
    }
    if (plans.length === 0) throw new Error(`${item.key} has no recorded merge to roll back.`)

    for (const { checkout, target } of plans) {
      const name = memberOf(checkout).project_name
      const path = await this.assertResettable(run, checkout)
      if (await this.git.hasMergeHead(path)) await this.git.mergeAbort(path)
      if (!(await this.git.isAncestor(path, target, 'HEAD'))) {
        throw new Error(
          `The integration branch of ${name} no longer contains the commit ${item.key} was merged onto.`
        )
      }
      await this.assertNothingMergedAfter(run, item, checkout, target)
    }

    let members = item.members ?? []
    const resets: {
      project_id: string
      symlink_name: string
      resetTo: string
      mergeSha: string | null
    }[] = []
    for (const { checkout, own, target } of plans) {
      const member = memberOf(checkout)
      await this.git.resetHard(checkout.path, target)
      resets.push({
        project_id: member.project_id,
        symlink_name: member.symlink_name,
        resetTo: target,
        mergeSha: own.merge_sha
      })
      // The merge is gone as of the reset: the row must say so even if the rest fails.
      members = members.map((candidate) =>
        candidate.project_id === own.project_id
          ? { ...candidate, pre_merge_sha: null, merge_sha: null }
          : candidate
      )
      this.saveItem(run, item.id, { members, ...this.memberComposites(run, members) })
    }
    // The members that merged nothing lose their pre-merge head too: the item is no longer
    // landing, so there is nothing to cut from.
    const untouched = members.filter((candidate) => candidate.pre_merge_sha && !candidate.merge_sha)
    if (untouched.length > 0) {
      members = members.map((candidate) =>
        candidate.merge_sha ? candidate : { ...candidate, pre_merge_sha: null }
      )
      this.saveItem(run, item.id, { members, ...this.memberComposites(run, members) })
    }
    this.lastVerify.delete(run.id)
    this.log(
      run,
      'rolled_back',
      `The merge of ${item.key} was rolled back in ${plans.map(({ checkout }) => memberOf(checkout).project_name).join(', ')}`,
      {
        itemId: item.id,
        data: { resetTo: item.pre_merge_sha, mergeSha: item.merge_sha, members: resets }
      }
    )
    for (const { checkout } of plans) {
      try {
        await this.git.cleanUntracked(checkout.path)
      } catch (error) {
        this.log(
          run,
          'rollback_leftovers',
          `Untracked files left behind after rolling back ${item.key} in ${memberOf(checkout).project_name} could not all be removed: ${describeError(error)}`,
          { itemId: item.id }
        )
      }
    }
  }

  /**
   * Resetting drops everything after the target, so nothing else may sit there. A recorded
   * merge the branch no longer has (its own rollback lost the bookkeeping) is not on the branch
   * either way.
   */
  private async assertNothingMergedAfter(
    run: DocumentRun,
    item: DocumentRunItem,
    checkout: IntegrationCheckout,
    target: string
  ): Promise<void> {
    const { path } = checkout
    for (const other of this.db.getDocumentRunItems(run.id)) {
      if (other.id === item.id) continue
      const mergeSha = this.mergeShaOf(other, checkout)
      if (!mergeSha) continue
      const onBranch = await this.git.isAncestor(path, mergeSha, 'HEAD').catch(() => false)
      if (!onBranch || (await this.git.isAncestor(path, mergeSha, target))) continue
      throw new Error(`${other.key} was merged after ${item.key}; rolling back would drop it too.`)
    }
  }

  /**
   * The one place a hard reset may happen: only in the run's own integration worktree(s), never
   * a project root, and only while that worktree has the integration branch checked out.
   */
  private async assertResettable(run: DocumentRun, checkout: IntegrationCheckout): Promise<string> {
    const { path } = checkout
    const projectPath = checkout.member
      ? checkout.member.project_path
      : this.deps.getProject(run.project_id)?.path
    if (!projectPath) throw new Error('The project of this run no longer exists.')
    if (samePath(path, projectPath)) {
      throw new Error('Refusing to reset the project root.')
    }
    if (!samePath(await this.git.topLevel(path), path)) {
      throw new Error(`Refusing to reset ${path}: it is not the root of a worktree.`)
    }
    await this.assertIntegrationCheckout(checkout)
    return path
  }

  // ── End of a run ──────────────────────────────────────────────────────────

  async finalize(runId: string): Promise<DocumentRunDetail> {
    const run = this.requireRun(runId)
    // A run made from board tickets can take one while it settles: one change at a time, so a
    // ticket that joins is either in the report or resumes the finished run.
    return isTicketRun(run)
      ? this.ticketRunLocks.run(run.id, () => this.finalizeRun(run.id))
      : this.finalizeRun(run.id)
  }

  private async finalizeRun(runId: string): Promise<DocumentRunDetail> {
    const run = this.requireRun(runId)
    if (run.status !== 'running' && run.status !== 'paused') {
      throw invalidState('Only a launched run that has not finished yet can be finalized.')
    }
    // A merge still under way lands (or fails) first, so the report cannot miss it.
    await this.mergesInFlight.get(runId)?.catch(() => undefined)
    // A ticket that joined after the orchestrator decided the run was over has yet to launch:
    // not finished after all (the orchestrator asks again later). One whose merge is on the
    // branch already counts, as below; finishing early skips every other one first.
    if (
      isTicketRun(run) &&
      this.db
        .getDocumentRunItems(run.id)
        .some((item) => item.selected && !isTerminalItemStatus(item.status) && !item.merge_sha)
    ) {
      return this.detail(this.requireRun(run.id), true)
    }
    // The orchestrator only finalizes once the document edit lane has drained; finishing early
    // closes whatever is left in it.
    this.skipPendingDocumentUpdates(run, DOCUMENT_UPDATE_FINISHED_DETAIL)
    const unconfirmed = await this.adoptLandedMerges(run)
    const items = this.db.getDocumentRunItems(run.id).filter((item) => item.selected)
    const merged = items.filter((item) => item.status === 'merged')
    const report = await this.buildReport(run, items)
    // A skipped ticket is a deliberate choice (the user's, or an agent that found nothing to
    // do), not an issue: the run completed unless something else was left unmerged, or a
    // merge landed without its checks being confirmed.
    const settled = items.every((item) => item.status === 'merged' || item.status === 'skipped')
    const status = settled && unconfirmed === 0 ? 'completed' : 'completed_with_issues'
    const updated = this.saveRun(run, { status, report, finished_at: this.now().toISOString() })
    // Before the run's last log line, so that one stays "Run finished". A run made from board
    // tickets has no document to write it into.
    if (!isTicketRun(updated)) await this.writeRunStatus(updated, items, report)
    this.log(
      updated,
      status,
      `Run finished: ${merged.length} of ${items.length} tickets merged into ${report.integrationBranch}`
    )
    await this.settleRunTicket(updated)
    return this.detail(updated, true)
  }

  /**
   * A run that ends closes its document edit lane: every document update still queued or under
   * way is skipped with `detail`, so the dashboard and the run status say it never happened. A
   * session in the middle of its edit is not stopped (the user may still be talking to it).
   */
  private skipPendingDocumentUpdates(run: DocumentRun, detail: string): void {
    const finishedAt = this.now().toISOString()
    const event = DOCUMENT_UPDATE_EVENTS.skipped
    for (const item of this.db.getDocumentRunItems(run.id)) {
      const from = item.document_update_status
      if (from !== 'queued' && from !== 'updating') continue
      this.saveItem(run, item.id, {
        document_update_status: 'skipped',
        document_update_detail: detail,
        document_update_finished_at: finishedAt
      })
      this.log(run, event.type, `${item.key} ${event.message}: ${detail}`, {
        itemId: item.id,
        data: { from, to: 'skipped' }
      })
    }
  }

  /**
   * Writes the run status summary (see document-status.ts) into the document the run was made
   * from, replacing the one an earlier run left there. Only a UTF-8 document is rewritten (a
   * BOM is kept): any other encoding would be corrupted by the round trip, so it is skipped and
   * logged, as is a document the user made read-only. The file is read right before the block is built and written back through a
   * temporary file, and the write is redone when the document changed in between. Never
   * throws: the run is finished either way, and the outcome is in the run's log.
   */
  private async writeRunStatus(
    run: DocumentRun,
    items: readonly DocumentRunItem[],
    report: DocumentRunReport
  ): Promise<void> {
    const path = run.source_path
    const name = basename(path)
    const failed = (reason: string): void =>
      this.log(
        run,
        'document_summary_failed',
        `The run status could not be written into ${name}: ${reason}`,
        { data: { path } }
      )
    const skipped = (reason: string, data: Record<string, unknown> = {}): void =>
      this.log(
        run,
        'document_summary_skipped',
        `The run status was not written into ${name}: ${reason}`,
        { data: { path, ...data } }
      )
    try {
      if (!(await documentFileExists(path))) {
        failed(`the document is no longer at ${path}.`)
        return
      }
      // The write renames a new file over the document, which only needs the directory to be
      // writable: a document the user made read-only would be replaced all the same.
      const writable = await access(path, fsConstants.W_OK).then(
        () => true,
        () => false
      )
      if (!writable) {
        skipped('the document is read-only.')
        return
      }
      const input = runStatusInput(run, items, report)
      for (let attempt = 0; attempt < RUN_STATUS_WRITE_ATTEMPTS; attempt++) {
        const bytes = await readFile(path)
        if (bytes.subarray(0, SOURCE_BINARY_SNIFF_BYTES).includes(0)) {
          skipped('it is not a text file.')
          return
        }
        const { text, encoding } = decodeDocument(bytes)
        if (encoding.toLowerCase() !== 'utf-8') {
          skipped(`it is encoded as ${encoding}, and only UTF-8 documents are rewritten.`, {
            encoding
          })
          return
        }
        const format = detectDocumentFormat(name, text)
        const next = upsertRunStatusBlock(text, format, renderRunStatusBlock(format, input))
        if (next === text) return
        const bom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
        const data = Buffer.concat([bom ? UTF8_BOM : Buffer.alloc(0), Buffer.from(next, 'utf8')])
        if (await replaceDocumentFile(path, data, bytes)) {
          this.log(run, 'document_summary_written', `Wrote the run status into ${name}`, {
            data: { path, format }
          })
          return
        }
      }
      failed('the document kept changing while it was being written.')
    } catch (error) {
      failed(describeError(error))
    }
  }

  /**
   * The report describes the branch, not the bookkeeping: a ticket whose merge commit is on the
   * integration branch is merged, even if the run ended (finished early, checks never confirmed,
   * a rollback that failed) before its row said so. Returns how many were adopted this way.
   */
  private async adoptLandedMerges(run: DocumentRun): Promise<number> {
    let adopted = 0
    for (const item of this.db.getDocumentRunItems(run.id)) {
      if (!item.selected || item.status === 'merged' || !item.merge_sha) continue
      if (!(await this.mergeLanded(run, item))) continue
      adopted++
      const note = 'Merged, but its checks were not confirmed before the run ended.'
      this.saveItem(run, item.id, {
        status: 'merged',
        status_detail: item.status_detail ? `${note} ${item.status_detail}` : note,
        finished_at: this.now().toISOString()
      })
      this.log(run, 'merged', `${item.key} is on ${run.integration_branch}; counted as merged`, {
        itemId: item.id,
        data: { from: item.status, mergeSha: item.merge_sha, unconfirmed: true }
      })
    }
    return adopted
  }

  /**
   * Whether the item's recorded merge commit is on the integration branch — on a connection
   * project, every recorded member merge on its member's branch. False when it cannot be read.
   */
  private async mergeLanded(run: DocumentRun, item: DocumentRunItem): Promise<boolean> {
    const landed = (path: string, branch: string, mergeSha: string): Promise<boolean> =>
      existsSync(path)
        ? this.git.isAncestor(path, mergeSha, `refs/heads/${branch}`).catch(() => false)
        : Promise.resolve(false)
    if (!isConnectionRun(run)) {
      const path = run.integration_worktree_path
      if (!path || !run.integration_branch || !item.merge_sha) return false
      return landed(path, run.integration_branch, item.merge_sha)
    }
    const recorded = (item.members ?? []).filter((own) => own.merge_sha !== null)
    if (recorded.length === 0) return false
    for (const own of recorded) {
      const member = run.members.find((candidate) => candidate.project_id === own.project_id)
      if (!member || !own.merge_sha) return false
      if (
        !(await landed(member.integration_worktree_path, member.integration_branch, own.merge_sha))
      ) {
        return false
      }
    }
    return true
  }

  private async buildReport(
    run: DocumentRun,
    items: readonly DocumentRunItem[]
  ): Promise<DocumentRunReport> {
    const merged = items.filter((item) => item.status === 'merged')
    const report: DocumentRunReport = {
      generatedAt: this.now().toISOString(),
      integrationBranch: run.integration_branch ?? '',
      integrationWorktreePath: run.integration_worktree_path ?? run.integration_connection_path,
      baseBranch: run.base_branch ?? '',
      baseSha: run.base_sha ?? '',
      headSha: '',
      baseMoved: false,
      merged: merged.map((item) => ({
        key: item.key,
        title: item.title,
        mergeSha: item.merge_sha,
        summary: item.verdict?.summary ?? null
      })),
      unmerged: items
        .filter((item) => item.status !== 'merged')
        .map((item) => ({
          key: item.key,
          title: item.title,
          status: item.status,
          reason: item.status_detail ?? item.verdict?.reason ?? null
        })),
      migrations: unique(merged.flatMap((item) => item.verdict?.migrations ?? [])),
      manualSteps: unique(merged.flatMap((item) => item.verdict?.manualSteps ?? [])),
      stats: { filesChanged: 0, insertions: 0, deletions: 0, commits: 0 },
      verify: null
    }

    // The git half is best effort: a run whose worktree was removed by hand still gets closed.
    try {
      if (isConnectionRun(run)) await this.summarizeMembers(run, report)
      else await this.summarizeBranch(run, report)
    } catch (error) {
      this.log(
        run,
        'report_incomplete',
        `The git summary could not be read: ${describeError(error)}`
      )
    }
    return report
  }

  /** The git summary of a git project's integration branch, written into `report`. */
  private async summarizeBranch(run: DocumentRun, report: DocumentRunReport): Promise<void> {
    const project = this.deps.getProject(run.project_id)
    const worktreePath = run.integration_worktree_path
    const inWorktree = worktreePath !== null && existsSync(worktreePath)
    const cwd = inWorktree ? worktreePath : project?.path
    if (!cwd || !run.base_sha || !run.base_branch || !run.integration_branch) return
    const head = await this.git.revParse(cwd, `refs/heads/${run.integration_branch}`)
    if (!head) return
    report.headSha = head
    if (run.config.verifyCommand) report.verify = this.lastVerifyOf(run, head)

    if (project) {
      const baseNow =
        (await this.git.revParse(project.path, `refs/heads/${run.base_branch}`)) ??
        (await this.git.revParse(project.path, `refs/remotes/origin/${run.base_branch}`))
      report.baseMoved = baseNow !== null && baseNow !== run.base_sha
    }
    report.stats = {
      ...(await this.git.shortStat(cwd, run.base_sha, head)),
      commits: await this.git.commitCount(cwd, run.base_sha, head)
    }
    const changed = (await this.git.diffNameStatus(cwd, run.base_sha, head))
      .filter((entry) => entry.status !== 'D')
      .map((entry) => entry.path)
    report.migrations = unique([...this.git.collectMigrationPaths(changed), ...report.migrations])
  }

  /**
   * The git summary of every member of a connection run: per member in `report.members`, and
   * summed (stats), any-of (base moved), prefixed with the member directory (migrations) at the
   * top level. The members that were read stay in the report when a later one fails.
   */
  private async summarizeMembers(run: DocumentRun, report: DocumentRunReport): Promise<void> {
    if (!isConnectionRun(run)) return
    const members: DocumentRunReportMember[] = []
    report.members = members
    const migrations: string[] = []
    for (const member of run.members) {
      const cwd = existsSync(member.integration_worktree_path)
        ? member.integration_worktree_path
        : member.project_path
      const head = await this.git.revParse(cwd, `refs/heads/${member.integration_branch}`)
      if (!head) {
        this.log(
          run,
          'report_incomplete',
          `Branch ${member.integration_branch} of ${member.project_name} was not found.`
        )
        continue
      }
      const baseNow =
        (await this.git.revParse(member.project_path, `refs/heads/${member.base_branch}`)) ??
        (await this.git.revParse(member.project_path, `refs/remotes/origin/${member.base_branch}`))
      const stats = {
        ...(await this.git.shortStat(cwd, member.base_sha, head)),
        commits: await this.git.commitCount(cwd, member.base_sha, head)
      }
      const changed = (await this.git.diffNameStatus(cwd, member.base_sha, head))
        .filter((entry) => entry.status !== 'D')
        .map((entry) => entry.path)
      migrations.push(
        ...this.git.collectMigrationPaths(changed).map((path) => `${member.symlink_name}/${path}`)
      )
      members.push({
        project_id: member.project_id,
        project_name: member.project_name,
        symlink_name: member.symlink_name,
        integrationBranch: member.integration_branch,
        integrationWorktreePath: member.integration_worktree_path,
        baseBranch: member.base_branch,
        baseSha: member.base_sha,
        headSha: head,
        baseMoved: baseNow !== null && baseNow !== member.base_sha,
        stats
      })
    }
    report.headSha = members[0]?.headSha ?? ''
    report.baseMoved = members.some((member) => member.baseMoved)
    report.stats = members.reduce(
      (sum, member) => ({
        filesChanged: sum.filesChanged + member.stats.filesChanged,
        insertions: sum.insertions + member.stats.insertions,
        deletions: sum.deletions + member.stats.deletions,
        commits: sum.commits + member.stats.commits
      }),
      { filesChanged: 0, insertions: 0, deletions: 0, commits: 0 }
    )
    report.migrations = unique([...migrations, ...report.migrations])
    // A verify result describes every member's commit; with one unread there is nothing to match.
    if (hasVerifyCommand(run) && members.length === run.members.length) {
      report.verify = this.lastVerifyOf(
        run,
        compositeSha(
          members.map((member) => ({ symlink_name: member.symlink_name, sha: member.headSha }))
        )
      )
    }
  }

  /**
   * The verify result that describes the branch as it is now (`head`; the members' composite
   * for a connection run): remembered in this process, else read back from the audit log. A run
   * on a commit that was rolled back since, or that a later merge moved past, says nothing
   * about the branch.
   */
  private lastVerifyOf(run: DocumentRun, head: string): DocumentRunReport['verify'] {
    const remembered = this.lastVerify.get(run.id)
    if (remembered?.sha === head) {
      return { command: remembered.command, ok: remembered.ok, output: remembered.output }
    }
    // Newest first across both outcomes, read by type so the rest of the log cannot crowd
    // them out.
    const events = [
      ...this.db.listDocumentRunEvents(run.id, EVENTS_BY_TYPE, 'verify_passed'),
      ...this.db.listDocumentRunEvents(run.id, EVENTS_BY_TYPE, 'verify_failed')
    ].sort((a, b) => b.id - a.id)
    for (const event of events) {
      // The orchestrator logs its own verify events, without the command or the output. A
      // connection run's events are per member: `heads` and `commands` are the run-wide view.
      const data = (event.data ?? {}) as {
        command?: unknown
        commands?: unknown
        sha?: unknown
        heads?: unknown
        output?: unknown
      }
      if (typeof data.command !== 'string' || (data.sha !== head && data.heads !== head)) continue
      return {
        command: typeof data.commands === 'string' ? data.commands : data.command,
        ok: event.type === 'verify_passed',
        output: typeof data.output === 'string' ? data.output : ''
      }
    }
    return null
  }

  cancel(runId: string): DocumentRunDetail {
    const run = this.recoverInterruptedExtraction(this.requireRun(runId))
    if (run.status === 'cancelled') return this.detail(run, true)
    if (run.status === 'completed' || run.status === 'completed_with_issues') {
      throw invalidState('This run has already finished.')
    }
    const finishedAt = this.now().toISOString()
    this.skipPendingDocumentUpdates(run, DOCUMENT_UPDATE_CANCELLED_DETAIL)
    let cancelledItems = 0
    for (const item of this.db.getDocumentRunItems(run.id)) {
      if (!item.selected || isTerminalItemStatus(item.status)) continue
      this.saveItem(run, item.id, { status: 'cancelled', finished_at: finishedAt })
      cancelledItems++
    }
    const updated = this.saveRun(run, { status: 'cancelled', finished_at: finishedAt })
    this.log(
      updated,
      'cancelled',
      `Run cancelled; ${cancelledItems} unfinished tickets were stopped. Branches and worktrees were kept.`
    )
    void this.settleRunTicket(updated)
    return this.detail(updated, true)
  }

  /**
   * Removes the run and its own board ticket. Its directory goes with it unless a task ticket
   * (kept, as promised) attaches the spec text and figures from it by path; `removeFiles`
   * removes it regardless, for a caller whose tickets are going too (the project is being
   * deleted). Branches and worktrees stay.
   */
  async delete(runId: string, options: { removeFiles?: boolean } = {}): Promise<boolean> {
    const found = this.db.getDocumentRun(runId)
    if (!found) return false
    const run = this.recoverInterruptedExtraction(found)
    // An extraction under way notices the missing run and discards what it produced.
    if (run.status === 'running' || run.status === 'paused') {
      throw invalidState('Cancel the run before deleting it.')
    }
    // A project that is being deleted takes the migration session with it.
    if (run.migration_session_id && !options.removeFiles) {
      throw invalidState('Stop the migrations of the run before deleting it.')
    }
    const items = this.db.getDocumentRunItems(run.id)
    const hasTickets = items.some((item) => item.ticket_id)
    const deleted = this.db.deleteDocumentRun(run.id)
    this.lastVerify.delete(run.id)
    const ticketId = run.ticket_id
    if (ticketId) {
      try {
        // Detached, so the board of whoever asked reloads too.
        await this.detach(() => this.deps.deleteTicket(run.project_id, ticketId))
      } catch (error) {
        log.warn('Could not delete the ticket of a document run', {
          runId: run.id,
          ticketId,
          error: describeError(error)
        })
      }
      // The tickets a run made from board tickets adopted are the user's: they stay, no longer
      // pointing at a ticket that is gone.
      if (isTicketRun(run)) {
        await this.detach(async () => {
          for (const item of items) await this.releaseParentLink(run, item.ticket_id)
        })
      }
    }
    if (!hasTickets || options.removeFiles) {
      try {
        await removeRunDir(run.run_dir, this.runsRoot)
      } catch (error) {
        log.warn('Could not remove a document run directory', {
          runId: run.id,
          runDir: run.run_dir,
          error: describeError(error)
        })
      }
    }
    this.deps.publish({ runId: run.id, projectId: run.project_id, reason: 'deleted' })
    return deleted
  }

  // ── Duplicates ────────────────────────────────────────────────────────────

  /**
   * A fresh copy of the run, back at the start: a new run in the preview with a ticket of its
   * own in To Do, to review and launch again. What the user chose comes along: the title, the
   * whole config (models, parallel tickets, verify commands, base branches, prompt style) and,
   * per ticket, its model, its verification and whether it is selected. Nothing of what the
   * original did does: every item is `pending` again with no session, worktree, branch or merge,
   * and the copy has no integration branch, report or event log of the original's.
   *
   * A document run is copied with its extraction (items, figures and the pre-processed text, in
   * a run directory of its own), so nothing is extracted again. A run made from board tickets
   * gets a new ticket in To Do for each of its own, a copy of it as the board has it now, linked
   * as the originals were; the original tickets stay where they are.
   *
   * Any run can be duplicated except one whose tickets are still being extracted. The original
   * is never changed.
   */
  async duplicateRun(runId: string): Promise<DocumentRunDetail> {
    const source = this.recoverInterruptedExtraction(this.requireRun(runId))
    if (source.status === 'extracting' || this.extractionJobs.has(source.id)) {
      throw invalidState('Wait for the extraction to finish.')
    }
    const project = this.deps.getProject(source.project_id)
    if (!project) throw notFound('The project of this run')
    // A connection project that lost members since has nowhere to run the copy: said now.
    this.resolveTarget(project, source.source_kind)
    return isTicketRun(source)
      ? // Detached, as when an orchestrator is made: the board of whoever asked shows the copies.
        this.detach(() => this.duplicateTicketRun(project, source))
      : this.duplicateDocumentRun(source)
  }

  /**
   * The copy of a document run: its files in a run directory of its own (a copy that shared the
   * original's would lose them when the original is deleted), every path into the old directory
   * re-pointed, the items as drafts. A run whose extraction failed is copied as that, to retry.
   */
  private async duplicateDocumentRun(source: DocumentRun): Promise<DocumentRunDetail> {
    const id = randomUUID()
    const runDir = join(this.runsRoot, id)
    const map: RunPathMap = { [source.run_dir]: runDir }
    let created = false
    try {
      await copyRunDir(source.run_dir, runDir)
      const blocksPath = join(runDir, 'blocks.json')
      if (existsSync(blocksPath)) {
        // Paths into the run directory, when the blocks file has any, follow the copy.
        const rewritten = rewriteBlocksJson(await readFile(blocksPath, 'utf8'), map)
        if (rewritten.ok) await writeFile(blocksPath, rewritten.json, 'utf8')
      }
      const rewritten = rewriteRunPaths(
        {
          run: {
            source_path: source.source_path,
            run_dir: source.run_dir,
            document_path: source.document_path
          },
          items: this.db.getDocumentRunItems(source.id).map(draftOfItem)
        },
        map
      )
      const failed = source.status === 'extract_failed'
      let run = this.db.createDocumentRun({
        id,
        project_id: source.project_id,
        title: source.title,
        source_kind: source.source_kind,
        source_path: rewritten.run.source_path,
        run_dir: runDir,
        document_path: rewritten.run.document_path,
        status: failed ? 'extract_failed' : 'preview',
        config: structuredClone(source.config)
      })
      created = true
      this.db.replaceDocumentRunItems(run.id, rewritten.items)
      run = this.saveRun(run, {
        extraction: source.extraction ? structuredClone(source.extraction) : null,
        error: failed && source.error !== null ? rewritePathsInText(source.error, map) : null
      })
      this.log(run, 'created', `Duplicated from “${source.title}”`, {
        data: { sourceRunId: source.id }
      })
      run = await this.createRunTicketQuietly(run)
      return this.detail(run, true)
    } catch (error) {
      // Half a copy is worse than none: the original is untouched, and the user can try again.
      if (created) {
        try {
          this.db.deleteDocumentRun(id)
          this.deps.publish({ runId: id, projectId: source.project_id, reason: 'deleted' })
        } catch (cleanupError) {
          log.warn('Could not remove the rows of a failed run duplicate', {
            runId: id,
            error: describeError(cleanupError)
          })
        }
      }
      await removeRunDir(runDir, this.runsRoot).catch(() => undefined)
      throw error
    }
  }

  /**
   * The copy of a run made from board tickets. Its tickets are the brief, so each gets a copy on
   * the board first (the board's own Duplicate; one that left the board is written again from
   * the item's copy of it), in To Do and in the items' order, waiting for the copies of what the
   * original waited for. The new run then adopts them as any orchestrator adopts tickets. A step
   * that fails takes the copies made so far off the board again.
   */
  private async duplicateTicketRun(
    project: DocumentFlowProject,
    source: DocumentRun
  ): Promise<DocumentRunDetail> {
    const items = this.db.getDocumentRunItems(source.id)
    if (items.length === 0) throw invalidState('This orchestrator has no tickets to duplicate.')
    const copyOf = new Map<string, string>()
    const choices = new Map<string, DocumentRunItem>()
    try {
      for (const item of items) {
        const original = item.ticket_id
          ? await this.deps.getTicket(project.id, item.ticket_id)
          : null
        const copy = original
          ? await this.deps.duplicateTicket(project.id, original.id)
          : (
              await this.deps.createTickets(project.id, [
                {
                  draft_key: item.key,
                  project_id: project.id,
                  title: item.title,
                  description: item.description || null,
                  column: 'todo'
                }
              ])
            ).tickets[0]
        if (!copy) throw new Error(`The board did not create a ticket for ${item.key}.`)
        copyOf.set(item.key, copy.id)
        choices.set(copy.id, item)
      }
      // The graph of a run made from board tickets is the board's: the copies wait for each
      // other as the originals did. A lost edge would launch a ticket ahead of what it needs.
      for (const item of items) {
        const dependent = copyOf.get(item.key)
        for (const key of item.depends_on) {
          const blocker = copyOf.get(key)
          if (!dependent || !blocker || blocker === dependent) continue
          const refusal = boardRefusal(
            await this.deps.addTicketDependency(project.id, dependent, blocker)
          )
          if (refusal) throw invalidState(`${item.key} could not wait for ${key}: ${refusal}`)
        }
      }
      const ticketIds = items.map((item) => copyOf.get(item.key) as string)
      return await this.adoptionLocks.run(project.id, () =>
        this.makeTicketRun(
          project,
          ticketIds,
          { projectId: project.id, ticketIds, title: source.title },
          { title: source.title, config: source.config, choices }
        )
      )
    } catch (error) {
      for (const ticketId of copyOf.values()) {
        await Promise.resolve(this.deps.deleteTicket(project.id, ticketId)).catch(
          (cleanupError: unknown) => {
            log.warn('Could not remove a ticket copied for a failed orchestrator duplicate', {
              runId: source.id,
              ticketId,
              error: describeError(cleanupError)
            })
          }
        )
      }
      throw error
    }
  }

  logEvent(params: {
    runId: string
    itemId?: string | null
    type: string
    message: string
    data?: unknown
  }): void {
    const run = this.requireRun(params.runId)
    this.db.appendDocumentRunEvent({
      run_id: run.id,
      item_id: params.itemId ?? null,
      type: params.type,
      message: params.message,
      data: params.data
    })
    this.deps.publish({
      runId: run.id,
      projectId: run.project_id,
      reason: 'event',
      ...(params.itemId ? { itemId: params.itemId } : {})
    })
  }

  /** `<pm> install && <pm> run typecheck && <pm> run lint`, from what the project defines. */
  async suggestVerifyCommand(projectId: string): Promise<string | null> {
    const project = this.deps.getProject(projectId)
    if (!project) return null
    let scripts: Record<string, unknown>
    try {
      const manifest: unknown = JSON.parse(
        await readFile(join(project.path, 'package.json'), 'utf8')
      )
      const declared = (manifest as { scripts?: unknown } | null)?.scripts
      scripts = typeof declared === 'object' && declared !== null ? { ...declared } : {}
    } catch {
      return null
    }
    const has = (name: string): boolean => typeof scripts[name] === 'string'
    const checks = [
      ['typecheck', 'type-check', 'tsc'].find(has),
      has('lint') ? 'lint' : undefined
    ].filter((name): name is string => name !== undefined)
    if (checks.length === 0) return null

    const lockfiles: [string, string][] = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['bun.lock', 'bun']
    ]
    const manager = lockfiles.find(([file]) => existsSync(join(project.path, file)))?.[1] ?? 'npm'
    return [`${manager} install`, ...checks.map((name) => `${manager} run ${name}`)].join(' && ')
  }

  // ── Shared plumbing ───────────────────────────────────────────────────────

  private requireRun(runId: string): DocumentRun {
    const run = this.db.getDocumentRun(runId)
    if (!run) throw notFound('The run')
    return run
  }

  private requireItem(runId: string, itemId: string): { run: DocumentRun; item: DocumentRunItem } {
    const run = this.requireRun(runId)
    const item = this.db.getDocumentRunItem(itemId)
    if (!item || item.run_id !== run.id) throw notFound('The ticket')
    return { run, item }
  }

  /**
   * What the run is made on; a connection project must still have at least two member projects.
   * `sourceKind` only words the refusal: an orchestrator made from board tickets implements no
   * document.
   */
  private resolveTarget(
    project: DocumentFlowProject,
    sourceKind: DocumentRun['source_kind'] = 'document'
  ): DocumentFlowRunTarget {
    if (project.kind !== 'connection') return { kind: 'git', project }
    const members = parseMemberProjectIds(project.member_project_ids)
      .map((id) => this.deps.getProject(id))
      .filter(
        (member): member is DocumentFlowProject => member !== null && member.kind !== 'connection'
      )
    if (members.length < 2) {
      const what = sourceKind === 'tickets' ? 'run an orchestrator in' : 'implement a document in'
      throw invalidState(
        `${project.name} needs at least two member projects to ${what}; it has ${members.length}.`
      )
    }
    return { kind: 'connection', project, members }
  }

  private requireTarget(run: DocumentRun): DocumentFlowRunTarget {
    const project = this.deps.getProject(run.project_id)
    if (!project) throw notFound('The project of this run')
    return this.resolveTarget(project, run.source_kind)
  }

  private integrationPath(run: DocumentRun): string {
    const path = run.integration_worktree_path
    if (!path || !run.integration_branch) {
      throw new Error('This run has no integration worktree yet.')
    }
    if (!existsSync(path)) throw new Error(`The integration worktree is missing: ${path}`)
    return path
  }

  /**
   * The run's integration checkouts: the integration worktree of a git project, one per member
   * for a connection project. Throws when one is not there.
   */
  private integrationCheckouts(run: DocumentRun): IntegrationCheckout[] {
    if (isConnectionRun(run)) return run.members.map((member) => this.memberCheckout(run, member))
    return [
      {
        member: null,
        path: this.integrationPath(run),
        branch: run.integration_branch ?? '',
        baseSha: run.base_sha
      }
    ]
  }

  private memberCheckout(run: DocumentRun, member: DocumentRunMember): IntegrationCheckout {
    if (!run.integration_connection_id) throw new Error('This run has no integration instance yet.')
    const path = member.integration_worktree_path
    if (!existsSync(path)) {
      throw new Error(`The integration worktree of ${member.project_name} is missing: ${path}`)
    }
    return { member, path, branch: member.integration_branch, baseSha: member.base_sha }
  }

  /** For messages: the branch, and whose it is on a connection run. */
  private describeCheckout(checkout: IntegrationCheckout): string {
    return checkout.member
      ? `${checkout.branch} of ${checkout.member.project_name}`
      : checkout.branch
  }

  /** A merge, commit or reset must land on the integration branch, whatever was left checked out. */
  private async assertIntegrationCheckout(checkout: IntegrationCheckout): Promise<void> {
    const branch = await this.git.currentBranch(checkout.path)
    if (branch !== checkout.branch) {
      const where = checkout.member
        ? `The integration worktree of ${checkout.member.project_name}`
        : 'The integration worktree'
      throw new Error(
        `${where} has ${branch ? `branch ${branch}` : 'a detached HEAD'} checked out, not ${checkout.branch}.`
      )
    }
  }

  /** The ticket branch against each integration checkout it merges into. */
  private mergeContexts(run: DocumentRun, item: DocumentRunItem): MergeContext[] {
    if (!isConnectionRun(run)) {
      const checkout = this.integrationCheckouts(run)[0]
      const worktree = item.worktree_id ? this.deps.getWorktree(item.worktree_id) : null
      const ticketBranch = item.branch_name || worktree?.branch_name
      if (!ticketBranch) throw new Error(`${item.key} has no branch to merge.`)
      return [{ ...checkout, ticketBranch, ticketPath: worktree?.path ?? null, itemMember: null }]
    }
    // A member the ticket has no worktree in is one it touched nothing in: a repository added
    // to the run after the ticket launched, or one its instance could not take. Nothing to merge
    // there — as `memberComposites` and `repointTaskWorktrees` already read it.
    const contexts = run.members.flatMap((member): MergeContext[] => {
      const own = item.members?.find((candidate) => candidate.project_id === member.project_id)
      if (!own) return []
      const worktree = this.deps.getWorktree(own.worktree_id)
      const ticketBranch = own.branch_name || worktree?.branch_name
      if (!ticketBranch) {
        throw new Error(`${item.key} has no branch to merge in ${member.project_name}.`)
      }
      return [
        {
          ...this.memberCheckout(run, member),
          ticketBranch,
          ticketPath: worktree?.path ?? null,
          itemMember: own
        }
      ]
    })
    if (contexts.length === 0)
      throw new Error(`${item.key} has no worktree in any member to merge.`)
    return contexts
  }

  /** The item's merge commit in this checkout's repository; null when it has none recorded. */
  private mergeShaOf(item: DocumentRunItem, checkout: IntegrationCheckout): string | null {
    if (!checkout.member) return item.merge_sha
    const projectId = checkout.member.project_id
    return item.members?.find((own) => own.project_id === projectId)?.merge_sha ?? null
  }

  private async findMergeCommit(context: MergeContext, tip: string): Promise<string | null> {
    if (!context.baseSha) return null
    return this.git.findMergeCommitOf(context.path, {
      since: context.baseSha,
      head: `refs/heads/${context.branch}`,
      tip
    })
  }

  /**
   * A ticket branch cut from (or merged with) the integration branch while another ticket's
   * merge sat on it unverified carries that merge in its history; merging the branch would
   * bring the merge back after its rollback, with nothing left to recognise it by. Refuses
   * while `tip` contains a rolled-back merge that `head` (the integration commit) does not.
   */
  private async assertNoRolledBackMerge(
    run: DocumentRun,
    item: DocumentRunItem,
    context: MergeContext,
    tip: string,
    head: string
  ): Promise<void> {
    const path = context.path
    const rolledBack = this.rolledBackMerges(run, item, context)
    for (const [mergeSha, key] of rolledBack) {
      // What the merge brought in (its second parent) is on the branch again, through the
      // retried ticket's own merge: nothing is left to bring back.
      const onBranch = async (ref: string): Promise<boolean> =>
        this.git.isAncestor(path, ref, head).catch(() => false)
      if ((await onBranch(mergeSha)) || (await onBranch(`${mergeSha}^2`))) continue
      if (!(await this.git.isAncestor(path, mergeSha, tip).catch(() => false))) continue
      const where = context.member ? ` in ${context.member.project_name}` : ''
      throw new Error(
        `The branch of ${item.key} contains the merge of ${key} that was rolled back after its checks failed. Rebase it onto ${context.branch}${where} without that merge (git rebase --onto ${head.slice(0, 12)} ${mergeSha.slice(0, 12)}) and retry, or skip it.`
      )
    }
  }

  /**
   * Merge commits of other tickets that were rolled back from this checkout's branch, by sha →
   * ticket key. From the audit log (the rollback nulls the item's merge_sha, so the event is the
   * only record of the commit; read by type, since a long run's log pushes an early one well
   * past the newest thousand) and from flagged tickets whose recorded merge is not on the branch.
   */
  private rolledBackMerges(
    run: DocumentRun,
    item: DocumentRunItem,
    context: MergeContext
  ): Map<string, string> {
    const items = this.db.getDocumentRunItems(run.id)
    const keyOf = new Map(items.map((other) => [other.id, other.key]))
    const rolledBack = new Map<string, string>()
    for (const event of this.db.listDocumentRunEvents(run.id, EVENTS_BY_TYPE, 'rolled_back')) {
      if (!event.item_id || event.item_id === item.id) continue
      const key = keyOf.get(event.item_id) ?? event.item_id
      const data = (event.data ?? {}) as { mergeSha?: unknown; members?: unknown }
      if (!context.member) {
        if (typeof data.mergeSha === 'string') rolledBack.set(data.mergeSha, key)
        continue
      }
      // A connection run's rollback lists the members it reset, each with its own merge commit.
      if (!Array.isArray(data.members)) continue
      for (const entry of data.members) {
        const { project_id, mergeSha } = (entry ?? {}) as {
          project_id?: unknown
          mergeSha?: unknown
        }
        if (project_id === context.member.project_id && typeof mergeSha === 'string') {
          rolledBack.set(mergeSha, key)
        }
      }
    }
    for (const other of items) {
      if (other.id === item.id || other.status !== 'needs_attention') continue
      const mergeSha = this.mergeShaOf(other, context)
      if (mergeSha) rolledBack.set(mergeSha, other.key)
    }
    return rolledBack
  }

  private detail(run: DocumentRun, withEvents: boolean): DocumentRunDetail {
    return {
      run,
      items: this.db.getDocumentRunItems(run.id),
      events: withEvents ? this.db.listDocumentRunEvents(run.id, EVENTS_IN_DETAIL) : []
    }
  }

  private publishRun(run: DocumentRun): void {
    this.deps.publish({ runId: run.id, projectId: run.project_id, reason: 'run' })
  }

  /**
   * The board ticket shows the model its item launches with, copied when the ticket was made.
   * A model changed before the launch is copied again, so the board does not show a stale
   * one. The item is the source of truth (the runner reads only it); the ticket is a badge,
   * so a board that cannot be written is logged, not fatal. Detached, or the board of the
   * window that made the change would ignore its own event and keep the old badge.
   */
  private stampTicketModel(run: DocumentRun, item: DocumentRunItem, ticketId: string): void {
    const model = (item.launch_config ?? run.config.defaultLaunch)?.model
    void this.detach(() =>
      this.deps.updateTicket(run.project_id, ticketId, {
        model_provider_id: model?.providerID ?? null,
        model_id: model?.modelID ?? null,
        model_variant: model?.variant ?? null
      })
    ).catch((error: unknown) => {
      log.warn('Could not update the model on a ticket', {
        runId: run.id,
        item: item.key,
        ticketId,
        error: describeError(error)
      })
    })
  }

  private saveRun(run: DocumentRun, patch: DocumentRunRowPatch): DocumentRun {
    const updated = this.db.updateDocumentRun(run.id, patch)
    if (!updated) throw notFound('The run')
    this.publishRun(updated)
    return updated
  }

  private saveItem(
    run: DocumentRun,
    itemId: string,
    patch: DocumentRunItemRowPatch
  ): DocumentRunItem {
    const updated = this.db.updateDocumentRunItem(itemId, patch)
    if (!updated) throw notFound('The ticket')
    this.deps.publish({ runId: run.id, projectId: run.project_id, reason: 'item', itemId })
    return updated
  }

  /** Append to the run's audit log. The log never fails the operation it describes. */
  private log(
    run: DocumentRun,
    type: string,
    message: string,
    extra: { itemId?: string; data?: unknown } = {}
  ): void {
    try {
      this.db.appendDocumentRunEvent({
        run_id: run.id,
        item_id: extra.itemId ?? null,
        type,
        message,
        data: extra.data
      })
      this.deps.publish({
        runId: run.id,
        projectId: run.project_id,
        reason: 'event',
        ...(extra.itemId ? { itemId: extra.itemId } : {})
      })
    } catch (error) {
      log.warn('Could not append a document run event', {
        runId: run.id,
        type,
        error: describeError(error)
      })
    }
  }
}

let liveService: DocumentFlowService | null = null
let livePublisher: DocumentFlowPublisher | null = null

const toFlowConnection = (connection: ConnectionWithMembers): DocumentFlowConnection => ({
  id: connection.id,
  path: connection.path,
  status: connection.status,
  members: connection.members.map((member) => ({
    project_id: member.project_id,
    worktree_id: member.worktree_id,
    symlink_name: member.symlink_name
  }))
})

/**
 * The process-wide service, wired to the app database, git, the board and the text-generation
 * router. `publish` (the RPC domain's event-bus publisher) replaces the previous one.
 */
export async function getDocumentFlowService(
  publish?: DocumentFlowPublisher
): Promise<DocumentFlowService> {
  if (publish) livePublisher = publish
  if (liveService) return liveService

  const [{ getDatabase }, { rpcRequestContext }] = await Promise.all([
    import('../../db'),
    import('../../../server/rpc/request-context')
  ])
  const db = getDatabase()
  liveService = new DocumentFlowService({
    db,
    publish: (event) => livePublisher?.(event),
    detach: (task) => rpcRequestContext.exit(task),
    generate: async (prompt, systemPrompt, provider, options) => {
      const { generateText } = await import('../text-generation-router')
      return generateText(prompt, systemPrompt, provider, options)
    },
    getProject: (projectId) => db.getProject(projectId),
    getWorktree: (worktreeId) => db.getWorktree(worktreeId),
    createConnection: async (worktreeIds, savedProjectId) => {
      const { createConnectionOp } = await import('../connection-ops')
      const result = await createConnectionOp(db, worktreeIds, savedProjectId)
      return {
        success: result.success,
        ...(result.connection ? { connection: toFlowConnection(result.connection) } : {}),
        ...(result.error ? { error: result.error } : {})
      }
    },
    getConnection: (connectionId) => {
      const connection = db.getConnection(connectionId)
      return connection ? toFlowConnection(connection) : null
    },
    renameConnection: async (connectionId, name) => {
      const { renameConnectionOp } = await import('../connection-ops')
      return renameConnectionOp(db, connectionId, name)
    },
    addConnectionMember: async (connectionId, worktreeId) => {
      const { addConnectionMemberOp } = await import('../connection-ops')
      const result = await addConnectionMemberOp(db, connectionId, worktreeId)
      return {
        success: result.success,
        ...(result.member
          ? {
              member: {
                project_id: result.member.project_id,
                worktree_id: result.member.worktree_id,
                symlink_name: result.member.symlink_name
              }
            }
          : {}),
        ...(result.error ? { error: result.error } : {})
      }
    },
    addConnectionProjectMember: async (projectId, memberProjectId) => {
      const { addConnectionProjectMemberOp } = await import('../connection-ops')
      const result = await addConnectionProjectMemberOp(db, projectId, memberProjectId)
      return { success: result.success, ...(result.error ? { error: result.error } : {}) }
    },
    setWorktreeBaseBranch: (worktreeId, baseBranch) => {
      db.setWorktreeBaseBranch(worktreeId, baseBranch)
    },
    getAppStartedAt: () => appStartedAtFromEnv() ?? db.getSetting(APP_STARTED_AT_SETTING),
    getAppPid: () => appPidFromEnv(),
    getDefaultBranch: async (projectPath) => {
      const { gitService } = await import('../../effect/git/facade')
      return gitService.getDefaultBranch(projectPath)
    },
    createWorktreeFromBranch: async (params) => {
      const { createWorktreeFromBranchOp } = await import('../worktree-ops')
      return createWorktreeFromBranchOp(params)
    },
    createTickets: async (projectId, drafts) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      return getKanbanBackendForProject(projectId).createBatch(projectId, { drafts })
    },
    addTicketDependency: async (projectId, dependentTicketId, blockerTicketId) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      return getKanbanBackendForProject(projectId).addDependency(
        projectId,
        dependentTicketId,
        blockerTicketId
      )
    },
    removeTicketDependency: async (projectId, dependentTicketId, blockerTicketId) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      return getKanbanBackendForProject(projectId).removeDependency(
        projectId,
        dependentTicketId,
        blockerTicketId
      )
    },
    getTicketDependencies: async (projectId) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      return getKanbanBackendForProject(projectId).getDependenciesForProject(projectId)
    },
    getTicket: async (projectId, ticketId) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      return getKanbanBackendForProject(projectId).get(projectId, ticketId)
    },
    // Asked of the markdown backend whatever the board: it answers nothing for one in SQLite.
    boardHasUnreadableCards: async (projectId) => {
      const { getMarkdownKanbanBackend } = await import('../kanban-backend')
      const diagnostics = await getMarkdownKanbanBackend().getDiagnostics(projectId)
      return diagnostics.some((diagnostic) => diagnostic.blocking)
    },
    isSessionActive: (sessionId) => db.getSession(sessionId)?.status === 'active',
    moveTicket: async (projectId, ticketId, column) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      const backend = getKanbanBackendForProject(projectId)
      const inColumn = (await backend.list(projectId, false)).filter(
        (ticket) => ticket.column === column && ticket.id !== ticketId
      )
      const top = Math.min(...inColumn.map((ticket) => ticket.sort_order))
      return backend.move(projectId, ticketId, column, Number.isFinite(top) ? top - 1 : 0)
    },
    updateTicket: async (projectId, ticketId, patch) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      return getKanbanBackendForProject(projectId).update(projectId, ticketId, patch)
    },
    deleteTicket: async (projectId, ticketId) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      return getKanbanBackendForProject(projectId).delete(projectId, ticketId)
    },
    duplicateTicket: async (projectId, ticketId) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      return getKanbanBackendForProject(projectId).duplicate(projectId, ticketId, {
        column: 'todo'
      })
    },
    unarchiveTicket: async (projectId, ticketId) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      return getKanbanBackendForProject(projectId).unarchive(projectId, ticketId)
    },
    resolveFinalMessage: async (input) => {
      const { readClaudeTranscript } = await import('../claude-transcript-reader')
      return resolveSessionFinalMessage(input, {
        getRecordedFinalMessage: (sessionId) => db.getSessionFinalMessage(sessionId),
        getSession: (sessionId) => db.getSession(sessionId),
        getWorktreePath: (worktreeId) => db.getWorktree(worktreeId)?.path ?? null,
        readClaudeTranscript,
        getSessionMessages: (sessionId) => db.getSessionMessages(sessionId)
      })
    }
  })
  // Nothing waits for it: the runs are listed as they are and updated when it gets to them.
  void liveService.reconcileRunTickets()
  // The runs made from board tickets missed every board change made before this.
  void liveService.refreshTicketRuns()
  return liveService
}

/**
 * The process-wide service if something already made it, else null. For the kanban hooks: a
 * board change does not start the service (the first one to start catches up on its own, see
 * `refreshTicketRuns`).
 */
export function liveDocumentFlowService(): DocumentFlowService | null {
  return liveService
}
