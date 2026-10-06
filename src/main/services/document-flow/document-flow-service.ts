/**
 * Server side of the "Implement document" flow (RPC domain `documentFlow.*`): turns a spec
 * document into previewable tickets with the generation model, launches a run (an integration
 * branch + worktree cut from the base branch, tickets on the board plus one ticket for the run
 * itself), judges sessions' final messages, and merges ticket branches into the integration
 * branch one at a time.
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
  integrationBranchHint,
  isTerminalItemStatus,
  sanitizeDependencies
} from '@shared/document-flow/planning'
import { DOCUMENT_TEXT_LIMIT, preprocessDocument } from '@shared/document-flow/preprocess'
import { buildLaunchPrompt } from '@shared/document-flow/prompts'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import {
  DOCUMENT_RUN_TICKET_PROVIDER,
  isActiveRunStatus,
  isEndedRunStatus
} from '@shared/document-flow/run-ticket'
import { RpcRouteError } from '@shared/rpc/errors'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  DOCUMENT_RUN_MAX_PARALLEL_LIMIT,
  DOCUMENT_RUN_NOTES_LIMIT,
  type DocumentCommitResult,
  type DocumentMergeCheckResult,
  type DocumentMergeResult,
  type DocumentMigrationOutcome,
  type DocumentRun,
  type DocumentRunConfig,
  type DocumentRunDetail,
  type DocumentRunGeneration,
  type DocumentRunItem,
  type DocumentRunItemPatch,
  type DocumentRunPatch,
  type DocumentRunReport,
  type DocumentRunVerdict,
  type DocumentRunnerClaim,
  type DocumentSimpleResult,
  type DocumentVerifyResult,
  type SessionFinalMessage
} from '@shared/types/document-flow'
import type { KanbanTicketBatchCreateItem, KanbanTicketColumn } from '../../db/types'
import { createLogger } from '../logger'
import type { CreateFromBranchParams, WorktreeResult } from '../worktree-ops'
import type { DocumentFlowDb, DocumentRunItemRowPatch, DocumentRunRowPatch } from './db-port'
import { downloadDocument, isDocumentUrl, type DocumentFetch } from './document-download'
import {
  DocumentFileError,
  assertDocumentFile,
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
const EXTRACTION_TIMEOUT_MS = 300_000
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
    timeoutMs?: number
    maxRetries?: number
  }
) => Promise<string | null>

export type DocumentFlowGit = typeof documentFlowGit

export interface DocumentFlowProject {
  id: string
  name: string
  path: string
  kind?: string | null
}

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
  'selected',
  'launch_config'
] as const satisfies readonly (keyof DocumentRunItemPatch)[]

const ORCHESTRATION_ITEM_FIELDS = [
  'status',
  'status_detail',
  'ticket_id',
  'worktree_id',
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

interface MergeContext {
  integrationPath: string
  integrationBranch: string
  ticketBranch: string
  /** null when the ticket's worktree row is gone (the branch may still exist). */
  ticketPath: string | null
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
    if (project.kind === 'connection') {
      throw invalidInput(
        'Documents cannot be implemented in a connection project yet. Pick one of its member projects.'
      )
    }

    // A link is downloaded into the project directory first; the run then reads that file.
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
      const options = {
        modelOverride: generation?.model,
        effort: generation?.effort,
        outputSchema: EXTRACTION_JSON_SCHEMA,
        cwd: tmpdir(),
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

    const rowPatch: DocumentRunItemPatch = {}
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
    // `running` without an integration worktree is a start that failed half-way.
    const halfStarted = run.status === 'running' && !run.integration_worktree_id
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
    const project = this.requireGitProject(run)

    const started = this.detach(() => this.launch(run, project, defaultSdk)).finally(() => {
      this.startsInFlight.delete(runId)
    })
    this.startsInFlight.set(runId, started)
    return started
  }

  /** Every step is idempotent, so starting again after a failure continues where it stopped. */
  private async launch(
    initialRun: DocumentRun,
    project: DocumentFlowProject,
    defaultSdk: HandoffAgentSdk | undefined
  ): Promise<DocumentRunDetail> {
    let run = initialRun
    try {
      this.cleanDependencies(run)
      if (!run.integration_worktree_id) run = await this.createIntegrationWorktree(run, project)
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
          sdk: launch?.sdk ?? defaultSdk ?? 'claude-code'
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
   * has no session; the external-source fields mark it (both board backends store those).
   * Idempotent: a run that has its ticket is returned as it is.
   */
  private ensureRunTicket(run: DocumentRun, column: KanbanTicketColumn): Promise<DocumentRun> {
    return this.runTicketLocks.run(run.id, async () => {
      const current = this.db.getDocumentRun(run.id) ?? run
      if (current.ticket_id || !current.integration_worktree_id) return current
      const { tickets } = await this.deps.createTickets(current.project_id, [
        {
          draft_key: `run-${current.id}`,
          project_id: current.project_id,
          title: sanitizeLine(current.title) || 'Document run',
          description: `Document run of ${current.source_path}. Its branch ${current.integration_branch} collects the merged work of the run's tickets; move this ticket to Done to merge it into ${current.base_branch}.`,
          column,
          mode: null,
          worktree_id: current.integration_worktree_id,
          external_provider: DOCUMENT_RUN_TICKET_PROVIDER,
          external_id: current.id
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
    const { base_branch: base, integration_branch: integration } = run
    if (!base || !integration || base === integration) return
    for (const item of this.db.getDocumentRunItems(run.id)) {
      if (!item.worktree_id) continue
      const worktree = this.deps.getWorktree(item.worktree_id)
      if (worktree?.base_branch !== integration) continue
      this.deps.setWorktreeBaseBranch(worktree.id, base)
    }
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
      if (!run.integration_worktree_id || (!active && !isEndedRunStatus(run.status))) continue
      // A launch under way creates the ticket itself.
      if (this.startsInFlight.has(run.id)) continue
      try {
        this.detach(() => this.repointTaskWorktrees(run))
        if (run.ticket_id) {
          await this.settleRunTicket(this.dropDeadMigrationSession(run))
          continue
        }
        // A run cancelled before its launch finished never had a ticket.
        if (!run.started_at) continue
        const worktree = this.deps.getWorktree(run.integration_worktree_id)
        if (!worktree || (worktree.status ?? 'active') !== 'active') continue
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
    const worktree = item.worktree_id ? this.deps.getWorktree(item.worktree_id) : null

    let message = params.finalMessage ?? ''
    if (message.trim() === '') {
      try {
        message =
          (await this.deps.resolveFinalMessage({
            sessionId,
            worktreePath: worktree?.path ?? null
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
      verdict = await this.judge(run, item, message, worktree)
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
    worktree: DocumentFlowWorktree | null
  ): Promise<DocumentRunVerdict> {
    const facts = await this.gitFacts(run, item, worktree)
    const generation = run.config.generation
    try {
      const reply = await this.classifications.run(() =>
        this.deps.generate(
          buildClassificationPrompt({
            ticketKey: item.key,
            ticketTitle: item.title,
            finalMessage: message,
            commitsAhead: facts.commitsAhead,
            hasUncommittedChanges: facts.dirty
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

  private async gitFacts(
    run: DocumentRun,
    item: DocumentRunItem,
    worktree: DocumentFlowWorktree | null
  ): Promise<{ commitsAhead: number | null; dirty: boolean | null }> {
    if (!worktree || !existsSync(worktree.path)) return { commitsAhead: null, dirty: null }
    const branch = item.branch_name || worktree.branch_name
    const [commitsAhead, dirty] = await Promise.all([
      run.integration_branch && branch
        ? this.git.commitsAhead(worktree.path, run.integration_branch, branch).catch(() => null)
        : null,
      this.git.isDirty(worktree.path).catch(() => null)
    ])
    return { commitsAhead, dirty }
  }

  // ── Merge ─────────────────────────────────────────────────────────────────

  async prepareMerge(runId: string, itemId: string): Promise<DocumentMergeCheckResult> {
    const { run, item } = this.requireItem(runId, itemId)
    let committed = false
    try {
      const context = this.mergeContext(run, item)
      const { integrationPath, integrationBranch, ticketBranch, ticketPath } = context
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
            committed: false,
            commitsAhead: await this.git
              .commitsAhead(integrationPath, integrationBranch, ticketBranch)
              .catch(() => 0)
          }
        }
        const commit = await this.git.commitAll(ticketPath, `${item.key} · ${item.title}`)
        committed = commit.committed
        if (committed) {
          this.log(run, 'auto_commit', `${item.key}: uncommitted work committed before merging`, {
            itemId: item.id,
            data: { sha: commit.sha }
          })
        }
      }

      const tip = await this.git.revParse(integrationPath, `refs/heads/${ticketBranch}`)
      if (!tip) throw new Error(`Branch ${ticketBranch} was not found.`)
      if (await this.findMergeCommit(run, context, tip)) {
        return {
          state: 'clean',
          alreadyMerged: true,
          conflictedFiles: [],
          integrationHead,
          committed,
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
          committed,
          commitsAhead
        }
      }

      const check = await this.git.mergeTreeCheck(integrationPath, integrationBranch, ticketBranch)
      if (check.state === 'conflict') {
        return {
          state: 'conflict',
          conflictedFiles: check.files,
          integrationHead,
          committed,
          commitsAhead
        }
      }
      // `unknown` (a git too old for a dry run) is left for the real merge to decide.
      return { state: 'clean', conflictedFiles: [], integrationHead, committed, commitsAhead }
    } catch (error) {
      return {
        state: 'error',
        conflictedFiles: [],
        committed,
        commitsAhead: 0,
        error: describeError(error)
      }
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
        const context = this.mergeContext(run, item)
        const { integrationPath, ticketBranch } = context
        await this.assertIntegrationCheckout(run, integrationPath)

        if (await this.git.hasMergeHead(integrationPath)) await this.git.mergeAbort(integrationPath)
        if (await this.git.isDirty(integrationPath)) {
          const commit = await this.git.commitAll(
            integrationPath,
            `Save uncommitted changes before merging ${item.key}`
          )
          if (commit.committed) {
            this.log(
              run,
              'integration_commit',
              `Uncommitted changes in the integration worktree were committed before merging ${item.key}`,
              { itemId: item.id, data: { sha: commit.sha } }
            )
          }
        }

        const tip = await this.git.revParse(integrationPath, `refs/heads/${ticketBranch}`)
        if (!tip) throw new Error(`Branch ${ticketBranch} was not found.`)
        const existing = await this.findMergeCommit(run, context, tip)
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
      } catch (error) {
        return { success: false, error: describeError(error) }
      }
    })
  }

  async verify(runId: string): Promise<DocumentVerifyResult> {
    if (!this.requireRun(runId).config.verifyCommand?.trim()) {
      return { skipped: true, ok: true, exitCode: null, timedOut: false, output: '', durationMs: 0 }
    }
    return this.integrationLocks.run(runId, async () => {
      const run = this.requireRun(runId)
      const command = run.config.verifyCommand?.trim() ?? ''
      let path: string
      try {
        path = this.integrationPath(run)
        await this.assertIntegrationCheckout(run, path)
      } catch (error) {
        throw invalidState(describeError(error))
      }

      // The result describes this commit: a rollback or a later merge makes it history.
      const sha = await this.git.revParse(path, 'HEAD')
      const result = await this.runVerify(command, path)
      const ok = result.exitCode === 0 && !result.timedOut
      this.lastVerify.set(run.id, { command, ok, output: result.output, sha })
      const outcome = result.timedOut
        ? 'timed out'
        : ok
          ? 'passed'
          : `failed (exit code ${result.exitCode ?? 'unknown'})`
      this.log(run, ok ? 'verify_passed' : 'verify_failed', `Verify ${outcome}: ${command}`, {
        data: {
          command,
          sha,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          output: ok ? result.output.slice(-PASSED_VERIFY_EVENT_OUTPUT_CHARS) : result.output
        }
      })
      return { skipped: false, ok, ...result }
    })
  }

  async commitIntegration(runId: string, message: string): Promise<DocumentCommitResult> {
    this.requireRun(runId)
    return this.integrationLocks.run(runId, async () => {
      const run = this.requireRun(runId)
      try {
        const path = this.integrationPath(run)
        await this.assertIntegrationCheckout(run, path)
        // Also concludes a merge the fix session resolved but did not commit.
        const commit = await this.git.commitAll(path, message.trim() || 'Save changes')
        if (commit.committed) {
          this.log(
            run,
            'integration_commit',
            `Committed on ${run.integration_branch}: ${message}`,
            {
              data: { sha: commit.sha }
            }
          )
        }
        return { success: true, committed: commit.committed }
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
        const target = item.pre_merge_sha
        if (!target) throw new Error(`${item.key} has no recorded merge to roll back.`)
        const path = await this.assertResettable(run)

        if (await this.git.hasMergeHead(path)) await this.git.mergeAbort(path)
        if (!(await this.git.isAncestor(path, target, 'HEAD'))) {
          throw new Error(
            `The integration branch no longer contains the commit ${item.key} was merged onto.`
          )
        }
        // Resetting drops everything after the target, so nothing else may sit there. A
        // recorded merge the branch no longer has (its own rollback lost the bookkeeping) is
        // not on the branch either way.
        for (const other of this.db.getDocumentRunItems(run.id)) {
          if (other.id === item.id || !other.merge_sha) continue
          const onBranch = await this.git
            .isAncestor(path, other.merge_sha, 'HEAD')
            .catch(() => false)
          if (!onBranch || (await this.git.isAncestor(path, other.merge_sha, target))) continue
          throw new Error(
            `${other.key} was merged after ${item.key}; rolling back would drop it too.`
          )
        }

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
        return { success: true }
      } catch (error) {
        return { success: false, error: describeError(error) }
      }
    })
  }

  /**
   * The one place a hard reset may happen: only in the run's own integration worktree, never
   * the project root, and only while that worktree has the integration branch checked out.
   */
  private async assertResettable(run: DocumentRun): Promise<string> {
    const path = this.integrationPath(run)
    const project = this.deps.getProject(run.project_id)
    if (!project) throw new Error('The project of this run no longer exists.')
    if (samePath(path, project.path)) {
      throw new Error('Refusing to reset the project root.')
    }
    if (!samePath(await this.git.topLevel(path), path)) {
      throw new Error(`Refusing to reset ${path}: it is not the root of a worktree.`)
    }
    await this.assertIntegrationCheckout(run, path)
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
    await this.adoptLandedMerges(run)
    const items = this.db.getDocumentRunItems(run.id).filter((item) => item.selected)
    const merged = items.filter((item) => item.status === 'merged')
    const report = await this.buildReport(run, items)
    const status = merged.length === items.length ? 'completed' : 'completed_with_issues'
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
   * a rollback that failed) before its row said so.
   */
  private async adoptLandedMerges(run: DocumentRun): Promise<void> {
    const path = run.integration_worktree_path
    if (!path || !run.integration_branch || !existsSync(path)) return
    const head = `refs/heads/${run.integration_branch}`
    for (const item of this.db.getDocumentRunItems(run.id)) {
      if (!item.selected || item.status === 'merged' || !item.merge_sha) continue
      try {
        if (!(await this.git.isAncestor(path, item.merge_sha, head))) continue
      } catch {
        continue
      }
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
  }

  private async buildReport(
    run: DocumentRun,
    items: readonly DocumentRunItem[]
  ): Promise<DocumentRunReport> {
    const merged = items.filter((item) => item.status === 'merged')
    const report: DocumentRunReport = {
      generatedAt: this.now().toISOString(),
      integrationBranch: run.integration_branch ?? '',
      integrationWorktreePath: run.integration_worktree_path,
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
      const project = this.deps.getProject(run.project_id)
      const worktreePath = run.integration_worktree_path
      const inWorktree = worktreePath !== null && existsSync(worktreePath)
      const cwd = inWorktree ? worktreePath : project?.path
      if (!cwd || !run.base_sha || !run.base_branch || !run.integration_branch) return report
      const head = await this.git.revParse(cwd, `refs/heads/${run.integration_branch}`)
      if (!head) return report
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
    } catch (error) {
      this.log(
        run,
        'report_incomplete',
        `The git summary could not be read: ${describeError(error)}`
      )
    }
    return report
  }

  /**
   * The verify result that describes the branch as it is now (`head`): remembered in this
   * process, else read back from the audit log. A run on a commit that was rolled back since,
   * or that a later merge moved past, says nothing about the branch.
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
      // The orchestrator logs its own verify events, without the command or the output.
      const data = (event.data ?? {}) as { command?: unknown; sha?: unknown; output?: unknown }
      if (typeof data.command !== 'string' || data.sha !== head) continue
      return {
        command: data.command,
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

  private requireGitProject(run: DocumentRun): DocumentFlowProject {
    const project = this.deps.getProject(run.project_id)
    if (!project) throw notFound('The project of this run')
    if (project.kind === 'connection') {
      throw invalidState('Documents cannot be implemented in a connection project yet.')
    }
    return project
  }

  private integrationPath(run: DocumentRun): string {
    const path = run.integration_worktree_path
    if (!path || !run.integration_branch) {
      throw new Error('This run has no integration worktree yet.')
    }
    if (!existsSync(path)) throw new Error(`The integration worktree is missing: ${path}`)
    return path
  }

  /** A merge, commit or reset must land on the integration branch, whatever was left checked out. */
  private async assertIntegrationCheckout(run: DocumentRun, path: string): Promise<void> {
    const branch = await this.git.currentBranch(path)
    if (branch !== run.integration_branch) {
      throw new Error(
        `The integration worktree has ${branch ? `branch ${branch}` : 'a detached HEAD'} checked out, not ${run.integration_branch}.`
      )
    }
  }

  private mergeContext(run: DocumentRun, item: DocumentRunItem): MergeContext {
    const integrationPath = this.integrationPath(run)
    const worktree = item.worktree_id ? this.deps.getWorktree(item.worktree_id) : null
    const ticketBranch = item.branch_name || worktree?.branch_name
    if (!ticketBranch) throw new Error(`${item.key} has no branch to merge.`)
    return {
      integrationPath,
      integrationBranch: run.integration_branch ?? '',
      ticketBranch,
      ticketPath: worktree?.path ?? null
    }
  }

  private async findMergeCommit(
    run: DocumentRun,
    context: MergeContext,
    tip: string
  ): Promise<string | null> {
    if (!run.base_sha) return null
    return this.git.findMergeCommitOf(context.integrationPath, {
      since: run.base_sha,
      head: `refs/heads/${context.integrationBranch}`,
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
    const path = context.integrationPath
    const items = this.db.getDocumentRunItems(run.id)
    const keyOf = new Map(items.map((other) => [other.id, other.key]))
    const rolledBack = new Map<string, string>()
    // By type: the rollback nulls the item's merge_sha, so this event is the only record of
    // the commit, and a long run's log pushes an early one well past the newest thousand.
    for (const event of this.db.listDocumentRunEvents(run.id, EVENTS_BY_TYPE, 'rolled_back')) {
      if (!event.item_id || event.item_id === item.id) continue
      const data = (event.data ?? {}) as { mergeSha?: unknown }
      if (typeof data.mergeSha === 'string') {
        rolledBack.set(data.mergeSha, keyOf.get(event.item_id) ?? event.item_id)
      }
    }
    // A flagged ticket whose recorded merge is not on the branch lost it to a rollback too.
    for (const other of items) {
      if (other.id === item.id || other.status !== 'needs_attention' || !other.merge_sha) continue
      rolledBack.set(other.merge_sha, other.key)
    }

    for (const [mergeSha, key] of rolledBack) {
      // What the merge brought in (its second parent) is on the branch again, through the
      // retried ticket's own merge: nothing is left to bring back.
      const onBranch = async (ref: string): Promise<boolean> =>
        this.git.isAncestor(path, ref, head).catch(() => false)
      if ((await onBranch(mergeSha)) || (await onBranch(`${mergeSha}^2`))) continue
      if (!(await this.git.isAncestor(path, mergeSha, tip).catch(() => false))) continue
      throw new Error(
        `The branch of ${item.key} contains the merge of ${key} that was rolled back after its checks failed. Rebase it onto ${context.integrationBranch} without that merge (git rebase --onto ${head.slice(0, 12)} ${mergeSha.slice(0, 12)}) and retry, or skip it.`
      )
    }
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
