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
 * Runs in the server child. The orchestrator loop that decides WHEN to call these lives in the
 * renderer; nothing here launches or prompts a session. The base branch is only ever read.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
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
  sanitizeDependencies
} from '@shared/document-flow/planning'
import { DOCUMENT_TEXT_LIMIT, preprocessDocument } from '@shared/document-flow/preprocess'
import { buildLaunchPrompt, workspaceOfMembers } from '@shared/document-flow/prompts'
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
  runVerifyCommands,
  type DocumentCommitResult,
  type DocumentMergeCheckMember,
  type DocumentMergeCheckResult,
  type DocumentMergeCheckState,
  type DocumentMergeResult,
  type DocumentMigrationOutcome,
  type DocumentRun,
  type DocumentRunConfig,
  type DocumentRunDetail,
  type DocumentRunGeneration,
  type DocumentRunItem,
  type DocumentRunItemMember,
  type DocumentRunItemPatch,
  type DocumentRunMember,
  type DocumentRunPatch,
  type DocumentRunReport,
  type DocumentRunReportMember,
  type DocumentRunVerdict,
  type DocumentRunnerClaim,
  type DocumentSimpleResult,
  type DocumentSourceFile,
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
  documentFileExists,
  documentRunsRoot,
  normalizeDocumentPath,
  readDocumentSource,
  removeRunDir,
  writeRunFiles
} from './document-files'
import * as documentFlowGit from './document-flow-git'
import { resolveSessionFinalMessage } from './final-message'
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

/** A board ticket as far as a run cares: where it sits. */
export interface DocumentFlowTicket {
  id: string
  column: KanbanTicketColumn
}

/** What a run writes on a board ticket after creating it: the model badge. */
export type DocumentFlowTicketPatch = Pick<
  KanbanTicketUpdate,
  'model_provider_id' | 'model_id' | 'model_variant'
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
  /** Names an instance after the run that made it; cosmetic, so optional and never fatal. */
  renameConnection?: (connectionId: string, name: string) => Promise<unknown>
  /** Creates the tickets on the project's board; the result lists them in draft order. */
  createTickets: (
    projectId: string,
    drafts: KanbanTicketBatchCreateItem[]
  ) => Promise<{ tickets: readonly { id: string }[] }>
  addTicketDependency: (
    projectId: string,
    dependentTicketId: string,
    blockerTicketId: string
  ) => Promise<unknown>
  /** The ticket on the project's board; null when it is gone. */
  getTicket: (projectId: string, ticketId: string) => Promise<DocumentFlowTicket | null>
  /** Moves the ticket to the top of `column`. */
  moveTicket: (projectId: string, ticketId: string, column: KanbanTicketColumn) => Promise<unknown>
  /** Re-stamps the model the board shows on a ticket; cosmetic, so never fatal. */
  updateTicket: (
    projectId: string,
    ticketId: string,
    patch: DocumentFlowTicketPatch
  ) => Promise<unknown>
  deleteTicket: (projectId: string, ticketId: string) => Promise<unknown>
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
  'started_at',
  'finished_at'
] as const satisfies readonly (keyof DocumentRunItemPatch)[]

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

  /** The run's source document, and whether the file is still on disk (it is the user's file). */
  async sourceFile(runId: string): Promise<DocumentSourceFile> {
    const run = this.db.getDocumentRun(runId)
    if (!run) throw notFound('The run')
    return { path: run.source_path, exists: await documentFileExists(run.source_path) }
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
    const run = this.db.createDocumentRun({
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
    this.startExtraction(run.id)
    return this.detail(run, true)
  }

  retryExtraction(params: {
    runId: string
    generation?: DocumentRunGeneration | null
  }): DocumentRunDetail {
    const run = this.recoverInterruptedExtraction(this.requireRun(params.runId))
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
      this.cleanDependencies(run)
      if (!hasIntegration(run)) {
        run =
          target.kind === 'connection'
            ? await this.createIntegrationInstance(run, target)
            : await this.createIntegrationWorktree(run, target.project)
      }
      await this.createTickets(run, defaultSdk)
      run = await this.ensureRunTicket(run, 'in_progress')
      run = this.saveRun(run, {
        status: 'running',
        started_at: run.started_at ?? this.now().toISOString(),
        error: null
      })
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
      nameHint: integrationBranchHint(run.title),
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

    const nameHint = integrationBranchHint(run.title)
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
      await this.deps.renameConnection?.(connection.id, sanitizeLine(run.title) || 'Document run')
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
   * The run's ticket on the board: an ordinary ticket on the integration worktree, so moving
   * it to Done merges the integration branch into the base branch like any ticket's work. It
   * has no session; the external-source fields mark it (both board backends store those), and
   * `external_url` carries the path of the document the run was made from, so the ticket row
   * itself says which file to open even once the run record is gone.
   * On a connection project the ticket has no worktree: the board merges the run's integration
   * instance member by member from `integration_connection_id` instead.
   * Idempotent: a run that has its ticket is returned as it is.
   */
  private ensureRunTicket(run: DocumentRun, column: KanbanTicketColumn): Promise<DocumentRun> {
    return this.runTicketLocks.run(run.id, async () => {
      const current = this.db.getDocumentRun(run.id) ?? run
      if (current.ticket_id || !hasIntegration(current)) return current
      const { tickets } = await this.deps.createTickets(current.project_id, [
        {
          draft_key: `run-${current.id}`,
          project_id: current.project_id,
          title: sanitizeLine(current.title) || 'Document run',
          description: this.runTicketDescription(current),
          column,
          mode: null,
          worktree_id: current.integration_worktree_id,
          external_provider: DOCUMENT_RUN_TICKET_PROVIDER,
          external_id: current.id,
          external_url: current.source_path
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
      return updated
    })
  }

  private runTicketDescription(run: DocumentRun): string {
    if (!isConnectionRun(run)) {
      return `Document run of ${run.source_path}. Its branch ${run.integration_branch} collects the merged work of the run's tickets; move this ticket to Done to merge it into ${run.base_branch}.`
    }
    const branches = run.members
      .map(
        (member) =>
          `${member.project_name}: ${member.integration_branch} (from ${member.base_branch})`
      )
      .join(', ')
    return `Document run of ${run.source_path}. Its integration instance at ${run.integration_connection_path} collects the merged work of the run's tickets, one branch per member repository — ${branches}; move this ticket to Done to merge each into its base branch.`
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
      const members = checks.map(({ member, check }): DocumentMergeCheckMember => ({
        project_id: member.project_id,
        project_name: member.project_name,
        symlink_name: member.symlink_name,
        integrationBranch: member.integration_branch,
        integrationHead: check.integrationHead,
        state: check.state,
        conflictedFiles: check.conflictedFiles,
        commitsAhead: check.commitsAhead
      }))
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
    if (run.status !== 'running' && run.status !== 'paused') {
      throw invalidState('Only a launched run that has not finished yet can be finalized.')
    }
    // A merge still under way lands (or fails) first, so the report cannot miss it.
    await this.mergesInFlight.get(runId)?.catch(() => undefined)
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
    this.log(
      updated,
      status,
      `Run finished: ${merged.length} of ${items.length} tickets merged into ${report.integrationBranch}`
    )
    await this.settleRunTicket(updated)
    return this.detail(updated, true)
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
    const hasTickets = this.db.getDocumentRunItems(run.id).some((item) => item.ticket_id)
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

  /** What the run is made on; a connection project must still have at least two member projects. */
  private resolveTarget(project: DocumentFlowProject): DocumentFlowRunTarget {
    if (project.kind !== 'connection') return { kind: 'git', project }
    const members = parseMemberProjectIds(project.member_project_ids)
      .map((id) => this.deps.getProject(id))
      .filter(
        (member): member is DocumentFlowProject => member !== null && member.kind !== 'connection'
      )
    if (members.length < 2) {
      throw invalidState(
        `${project.name} needs at least two member projects to implement a document in; it has ${members.length}.`
      )
    }
    return { kind: 'connection', project, members }
  }

  private requireTarget(run: DocumentRun): DocumentFlowRunTarget {
    const project = this.deps.getProject(run.project_id)
    if (!project) throw notFound('The project of this run')
    return this.resolveTarget(project)
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
    return run.members.map((member): MergeContext => {
      const own = item.members?.find((candidate) => candidate.project_id === member.project_id)
      if (!own) throw new Error(`${item.key} has no worktree in ${member.project_name} to merge.`)
      const worktree = this.deps.getWorktree(own.worktree_id)
      const ticketBranch = own.branch_name || worktree?.branch_name
      if (!ticketBranch) {
        throw new Error(`${item.key} has no branch to merge in ${member.project_name}.`)
      }
      return {
        ...this.memberCheckout(run, member),
        ticketBranch,
        ticketPath: worktree?.path ?? null,
        itemMember: own
      }
    })
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
    getTicket: async (projectId, ticketId) => {
      const { getKanbanBackendForProject } = await import('../kanban-backend')
      return getKanbanBackendForProject(projectId).get(projectId, ticketId)
    },
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
  return liveService
}
