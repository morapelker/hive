// DataAssistantService: runs the database assistant for one question at a time per data project.
//
// `start` validates the project, supersedes an older run of the same project and returns at
// once; the run itself is detached and reports through events on DATA_ASSISTANT_CHANNEL, each
// stamped with the requestId and a per-run `seq`. A run: make sure the connection is open (for
// the server version and the current database), read a compact schema snapshot for the system
// prompt, then hand the question to a runner — Claude family → Agent SDK with in-process MCP
// tools; Codex/OpenCode → the JSON-action loop; a Claude failure before any output → the JSON
// loop on another installed provider. It ends with exactly one terminal event: `done` (a query
// was proposed, the model answered in prose, or the user cancelled) or `error`.
//
// Cancellation, the whole-run timeout and supersession all abort the run's AbortController,
// which the runners forward to the SDK / spawned CLI and the tools to their waits. Nothing in
// here executes a proposed query.

import { RpcRouteError } from '../../../../shared/rpc/errors'
import {
  DATA_ERROR_CODES,
  type DataAssistantEvent,
  type DataAssistantEventPayload,
  type DataAssistantGeneration,
  type DataAssistantStartRequest,
  type DataCompletionSchema
} from '../../../../shared/data-projects/types'
import { createLogger } from '../../logger'
import type { DataProjectRecord } from '../contracts'
import {
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  buildSchemaOverview,
  type AssistantPromptContext
} from './prompts'
import type { ClaudeAgentSdk, ClaudeLaunchSettings } from './runner-claude'
import { AssistantToolbox, resolveTimeZone } from './tools'
import {
  AssistantAbort,
  AssistantRunError,
  type AssistantAbortReason,
  type AssistantEngineService,
  type AssistantRunInput,
  type AssistantRunOutcome,
  type AssistantRunner,
  type ProposalValidator
} from './types'

const log = createLogger({ component: 'DataAssistant' })

/** A run that has not finished by then is stopped (and reported as a retryable error). */
export const ASSISTANT_RUN_TIMEOUT_MS = 180_000
const CONNECT_TIMEOUT_MS = 30_000
const SCHEMA_OVERVIEW_TIMEOUT_MS = 15_000

const PROVIDER_LABEL: Record<DataAssistantGeneration['provider'], string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode'
}

export interface DataAssistantServiceDeps {
  publish: (payload: DataAssistantEventPayload) => void
  getProject: (id: string) => Promise<DataProjectRecord | null>
  getEngine: () => Promise<AssistantEngineService>
  runClaude: AssistantRunner
  runJsonLoop: AssistantRunner
  validateProposal?: ProposalValidator
  /** Provider for the JSON loop when the Claude runner fails before any output (null = none). */
  fallbackProvider?: () => Promise<DataAssistantGeneration['provider'] | null>
  now?: () => Date
  /** The user's IANA time zone (defaults to this process's). */
  timeZone?: () => string | undefined
  runTimeoutMs?: number
}

interface ActiveRun {
  requestId: string
  dataProjectId: string
  controller: AbortController
  seq: number
  finished: boolean
  startedAt: number
  /** RPC client (renderer page) that asked; its runs stop when it disconnects. */
  clientId: string | null
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AssistantRunError(message, { retryable: true })), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

const errorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && name.startsWith('DATA_') ? name : undefined
}

/** The message and Retry flag the user sees for a failed run. */
export function describeAssistantError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof AssistantRunError)
    return { message: error.message, retryable: error.retryable }
  const code = errorCode(error)
  if (code === DATA_ERROR_CODES.credentialsRequired) {
    return {
      message: 'This connection needs its password. Connect from the toolbar, then ask again.',
      retryable: true
    }
  }
  if (code === DATA_ERROR_CODES.notFound) {
    return { message: 'This data project no longer exists.', retryable: false }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { message: message.trim() || 'The assistant failed.', retryable: true }
}

export class DataAssistantService {
  private readonly runs = new Map<string, ActiveRun>()
  private readonly activeByProject = new Map<string, string>()

  constructor(private readonly deps: DataAssistantServiceDeps) {}

  /** Resolves once the run is registered; progress arrives as events. */
  async start(
    request: DataAssistantStartRequest,
    clientId: string | null = null
  ): Promise<{ requestId: string }> {
    if (this.runs.has(request.requestId)) {
      throw new RpcRouteError(
        DATA_ERROR_CODES.invalidInput,
        'This assistant request is already running.'
      )
    }
    const record = await this.deps.getProject(request.dataProjectId)
    if (!record) throw new RpcRouteError(DATA_ERROR_CODES.notFound, 'Data project not found.')

    // One run per project: a newer question supersedes the one still running.
    const previous = this.activeByProject.get(request.dataProjectId)
    if (previous) this.abort(previous, 'superseded')

    const run: ActiveRun = {
      requestId: request.requestId,
      dataProjectId: request.dataProjectId,
      controller: new AbortController(),
      seq: 0,
      finished: false,
      startedAt: Date.now(),
      clientId
    }
    this.runs.set(run.requestId, run)
    this.activeByProject.set(run.dataProjectId, run.requestId)
    void this.execute(run, request, record)
    return { requestId: run.requestId }
  }

  cancel(requestId: string): { cancelled: boolean } {
    return { cancelled: this.abort(requestId, 'cancelled') }
  }

  /** A renderer disconnected: stop the runs it started (nobody is left to read them). */
  releaseClient(clientId: string): void {
    for (const run of [...this.runs.values()]) {
      if (run.clientId === clientId) this.abort(run.requestId, 'cancelled')
    }
  }

  /** Server shutdown: stop every run (each still emits its terminal event). */
  shutdown(): void {
    for (const requestId of [...this.runs.keys()]) this.abort(requestId, 'shutdown')
  }

  /** Runs that have not emitted their terminal event yet. */
  get activeRuns(): number {
    return this.runs.size
  }

  private abort(requestId: string, reason: AssistantAbortReason): boolean {
    const run = this.runs.get(requestId)
    if (!run || run.finished || run.controller.signal.aborted) return false
    run.controller.abort(new AssistantAbort(reason))
    return true
  }

  private emit(run: ActiveRun, event: DataAssistantEvent): void {
    if (run.finished) return
    run.seq += 1
    try {
      this.deps.publish({
        requestId: run.requestId,
        dataProjectId: run.dataProjectId,
        seq: run.seq,
        event
      })
    } catch (error) {
      log.warn('Failed to publish assistant event', {
        requestId: run.requestId,
        type: event.type,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private finish(run: ActiveRun, event: DataAssistantEvent): void {
    this.emit(run, event)
    run.finished = true
    this.runs.delete(run.requestId)
    if (this.activeByProject.get(run.dataProjectId) === run.requestId) {
      this.activeByProject.delete(run.dataProjectId)
    }
  }

  private async execute(
    run: ActiveRun,
    request: DataAssistantStartRequest,
    record: DataProjectRecord
  ): Promise<void> {
    const timeoutMs = this.deps.runTimeoutMs ?? ASSISTANT_RUN_TIMEOUT_MS
    const timer = setTimeout(() => this.abort(run.requestId, 'timeout'), timeoutMs)
    const signal = run.controller.signal
    const emit = (event: DataAssistantEvent): void => this.emit(run, event)
    let generation: DataAssistantGeneration = request.generation
    let toolbox: AssistantToolbox | null = null
    log.info('Assistant run started', {
      requestId: run.requestId,
      dataProjectId: run.dataProjectId,
      engine: record.engine,
      provider: generation.provider,
      model: generation.model ?? null
    })

    try {
      const engine = await raceAbort(this.deps.getEngine(), signal)

      let status = engine.status(record.id)
      if (status.state !== 'connected') {
        emit({ type: 'status', text: `Connecting to ${record.name}…` })
        status = await raceAbort(
          withTimeout(
            engine.connect(record.id),
            CONNECT_TIMEOUT_MS,
            `Connecting to ${record.name} took too long.`
          ),
          signal
        )
        if (status.state !== 'connected') {
          throw new AssistantRunError(
            `Could not connect to ${record.name}${status.error ? `: ${status.error}` : '.'}`,
            { retryable: true }
          )
        }
      }
      const database =
        request.database?.trim() || status.currentDatabase || record.config.database || undefined
      const schema = record.engine === 'postgres' ? request.schema?.trim() || undefined : undefined

      emit({ type: 'status', text: 'Reading the schema…' })
      let snapshot: DataCompletionSchema | null = null
      try {
        snapshot = await raceAbort(
          withTimeout(
            engine.completionSchema(record.id, database),
            SCHEMA_OVERVIEW_TIMEOUT_MS,
            'Reading the schema took too long.'
          ),
          signal
        )
      } catch (error) {
        if (signal.aborted) throw error
        // The tools can still explore; the prompt just has no overview.
        log.warn('Assistant schema overview unavailable', {
          requestId: run.requestId,
          error: describeAssistantError(error).message
        })
      }

      const now = this.deps.now ?? (() => new Date())
      const timeZone = resolveTimeZone(this.deps.timeZone?.())
      const activeToolbox = new AssistantToolbox({
        ctx: {
          dataProjectId: record.id,
          engine: record.engine,
          allowDataAccess: record.allowAiDataAccess === true,
          ...(database ? { database } : {}),
          ...(schema ? { schema } : {}),
          service: engine,
          signal,
          now,
          timeZone
        },
        emit,
        ...(this.deps.validateProposal ? { validateProposal: this.deps.validateProposal } : {})
      })
      toolbox = activeToolbox
      const promptContext: AssistantPromptContext = {
        engine: record.engine,
        projectName: record.name,
        environment: record.environment,
        ...(status.serverVersion ? { serverVersion: status.serverVersion } : {}),
        ...(database ? { database } : {}),
        ...(schema ? { schema } : {}),
        now: now(),
        timeZone,
        allowDataAccess: record.allowAiDataAccess === true,
        schemaOverview: buildSchemaOverview(snapshot)
      }
      const userPrompt = buildAssistantUserPrompt(request, record.engine)
      const runInput = (
        mode: 'tools' | 'json',
        gen: DataAssistantGeneration
      ): AssistantRunInput => ({
        systemPrompt: buildAssistantSystemPrompt(promptContext, activeToolbox.tools, mode),
        userPrompt,
        toolbox: activeToolbox,
        generation: gen,
        signal,
        emit
      })

      let outcome: AssistantRunOutcome
      if (generation.provider === 'claude-code') {
        emit({ type: 'status', text: 'Thinking…' })
        try {
          outcome = await this.deps.runClaude(runInput('tools', generation))
        } catch (error) {
          if (signal.aborted || !(error instanceof AssistantRunError) || !error.beforeOutput) {
            throw error
          }
          const fallback = this.deps.fallbackProvider
            ? await raceAbort(this.deps.fallbackProvider(), signal).catch((fallbackError) => {
                if (signal.aborted) throw fallbackError
                return null
              })
            : null
          if (!fallback || fallback === 'claude-code') throw error
          log.warn('Claude runner failed before any output; falling back', {
            requestId: run.requestId,
            fallback,
            error: error.message
          })
          generation = { provider: fallback }
          emit({
            type: 'status',
            text: `Claude Code failed (${error.message}). Falling back to ${PROVIDER_LABEL[fallback]}…`
          })
          outcome = await this.deps.runJsonLoop(runInput('json', generation))
        }
      } else {
        outcome = await this.deps.runJsonLoop(runInput('json', generation))
      }

      if (!activeToolbox.proposal) {
        const answer = outcome.answer?.trim()
        if (!answer) {
          throw new AssistantRunError(
            'The assistant finished without an answer. Try rephrasing the question.',
            { retryable: true }
          )
        }
        emit({ type: 'answer', text: answer })
      }
      log.info('Assistant run finished', {
        requestId: run.requestId,
        outcome: activeToolbox.proposal ? 'proposal' : 'answer',
        toolCalls: activeToolbox.calls,
        provider: outcome.provider,
        ms: Date.now() - run.startedAt
      })
      this.finish(run, {
        type: 'done',
        provider: outcome.provider,
        ...(outcome.model ? { model: outcome.model } : {})
      })
    } catch (error) {
      const reason: AssistantAbortReason | null = signal.aborted
        ? signal.reason instanceof AssistantAbort
          ? signal.reason.reason
          : 'cancelled'
        : null
      const done: DataAssistantEvent = {
        type: 'done',
        provider: generation.provider,
        ...(generation.model ? { model: generation.model } : {})
      }
      if (toolbox?.proposal) {
        // The query reached the editor before the failure/abort: that is a finished run.
        this.finish(run, done)
      } else if (reason === 'timeout') {
        log.warn('Assistant run timed out', { requestId: run.requestId, ms: timeoutMs })
        this.finish(run, {
          type: 'error',
          message: `The assistant took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`,
          retryable: true
        })
      } else if (reason) {
        log.info('Assistant run stopped', { requestId: run.requestId, reason })
        emit({
          type: 'status',
          text: reason === 'superseded' ? 'Replaced by a newer question' : 'Cancelled'
        })
        this.finish(run, done)
      } else {
        const { message, retryable } = describeAssistantError(error)
        log.warn('Assistant run failed', { requestId: run.requestId, error: message })
        this.finish(run, { type: 'error', message, retryable })
      }
    } finally {
      clearTimeout(timer)
      // Belt and braces: a run never stays registered after execute() returns.
      if (!run.finished)
        this.finish(run, { type: 'error', message: 'The assistant stopped.', retryable: true })
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Live wiring (everything imported lazily so tests and the RPC domain stay light)
// ---------------------------------------------------------------------------------------------

let instance: DataAssistantService | null = null
let currentPublish: (payload: DataAssistantEventPayload) => void = () => {}
let cachedClaudeBinary: string | null | undefined

async function liveClaudeLaunch(): Promise<ClaudeLaunchSettings> {
  const [{ getDatabase }, { getUserEnvironmentVariables }, proxy, binaryResolver, spawner] =
    await Promise.all([
      import('../../../db'),
      import('../../env-vars'),
      import('../../claude-api-proxy/claude-api-proxy-env'),
      import('../../claude-binary-resolver'),
      import('../../claude-cli-spawner')
    ])
  let userEnv: Record<string, string> = {}
  try {
    userEnv = getUserEnvironmentVariables(getDatabase())
  } catch {
    userEnv = {}
  }
  // Main points ANTHROPIC_BASE_URL at its usage proxy before this child starts; re-apply those
  // two variables after the user's own (as Claude sessions in main do) so usage is still counted.
  const inheritedProxy: Record<string, string> =
    process.env[proxy.ASSUME_FIRST_PARTY_ENV] === '1' && process.env[proxy.ANTHROPIC_BASE_URL_ENV]
      ? {
          [proxy.ANTHROPIC_BASE_URL_ENV]: process.env[proxy.ANTHROPIC_BASE_URL_ENV] as string,
          [proxy.ASSUME_FIRST_PARTY_ENV]: '1'
        }
      : {}
  if (cachedClaudeBinary === undefined)
    cachedClaudeBinary = binaryResolver.resolveClaudeBinaryPath()
  return {
    env: { ...process.env, ...userEnv, ...inheritedProxy, ...proxy.getClaudeApiProxyEnv() },
    binaryPath: cachedClaudeBinary,
    normalizeModel: spawner.normalizeClaudeCliModel
  }
}

/** Parser check for proposals: shared SQL splitter/lexer/classifier, or the mongosh parser. */
export const validateAssistantProposal: ProposalValidator = async ({
  language,
  dialect,
  query
}) => {
  if (language === 'sql') {
    if (!dialect) return { ok: true, isWrite: null }
    const sql = await import('../../../../shared/sql')
    const lexed = sql.lexSql(query, dialect)
    if (lexed.error) {
      return { ok: false, error: `${lexed.error.message} (at character ${lexed.error.offset})` }
    }
    const statements = sql.splitSqlStatements(query, dialect)
    if (!statements.length) return { ok: false, error: 'no SQL statement found' }
    const isWrite = statements.some((statement) => {
      const cls = sql.classifySqlStatement(statement.text, dialect).classification
      return cls !== 'read' && cls !== 'session'
    })
    return { ok: true, isWrite }
  }
  const shell = await import('../../../../shared/data-projects/mongo-shell')
  const statements = shell.splitMongoShell(query)
  if (!statements.length) return { ok: false, error: 'no mongosh statement found' }
  for (const statement of statements) {
    const parsed = shell.parseMongoShellStructure(statement.text)
    if ('error' in parsed && parsed.error) {
      return {
        ok: false,
        error: `${parsed.error.message} (at character ${statement.start + parsed.error.offset})`
      }
    }
  }
  const isWrite = statements.some((statement) => {
    const cls = shell.classifyMongoShellStatement(statement.text).classification
    return cls !== 'read' && cls !== 'session'
  })
  return { ok: true, isWrite }
}

async function liveFallbackProvider(): Promise<DataAssistantGeneration['provider'] | null> {
  const [{ detectAgentSdks }, { execFileSync }] = await Promise.all([
    import('../../system-info'),
    import('node:child_process')
  ])
  if (detectAgentSdks(null).codex) return 'codex'
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['opencode'], {
      encoding: 'utf-8',
      timeout: 5_000,
      env: process.env
    }).trim()
    return found ? 'opencode' : null
  } catch {
    return null
  }
}

function createLiveDeps(): DataAssistantServiceDeps {
  // Imported lazily inside: the runners' own modules are tiny, the SDK/router are not.
  const runClaude: AssistantRunner = async (input) => {
    const { createClaudeRunner } = await import('./runner-claude')
    return createClaudeRunner({
      loadSdk: async () => {
        const { loadClaudeSDK } = await import('../../claude-sdk-loader')
        return (await loadClaudeSDK()) as unknown as ClaudeAgentSdk
      },
      launch: liveClaudeLaunch
    })(input)
  }
  const runJsonLoop: AssistantRunner = async (input) => {
    const [{ createJsonLoopRunner }, { generateText }] = await Promise.all([
      import('./runner-json-loop'),
      import('../../text-generation-router')
    ])
    return createJsonLoopRunner({ generate: generateText })(input)
  }
  return {
    publish: (payload) => currentPublish(payload),
    getProject: async (id) => {
      const { getDatabase } = await import('../../../db')
      return getDatabase().getDataProject(id)
    },
    getEngine: async () => {
      const { getDataEngineService } = await import('../engine-service')
      return getDataEngineService()
    },
    runClaude,
    runJsonLoop,
    validateProposal: validateAssistantProposal,
    fallbackProvider: liveFallbackProvider
  }
}

/** The process-wide service; `publish` (the RPC domain's event-bus sink) replaces the last one. */
export function getDataAssistantService(
  publish: (payload: DataAssistantEventPayload) => void
): DataAssistantService {
  currentPublish = publish
  instance ??= new DataAssistantService(createLiveDeps())
  return instance
}

/** Server shutdown hook: aborts every running assistant run (kills spawned CLIs). */
export function shutdownDataAssistant(): void {
  instance?.shutdown()
}

/** Socket-close hook: stops the runs of a renderer that went away. */
export function releaseDataAssistantClient(clientId: string): void {
  instance?.releaseClient(clientId)
}
