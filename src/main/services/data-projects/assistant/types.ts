// Types shared by the database assistant's modules (service, tools, runners). The assistant runs
// in the backend server child next to the connection pool: the tools read the schema through
// DataEngineService's introspection methods (never the safety gate, never user SQL), the
// runners talk to the user's default model, and the only way a query leaves a run is the
// `propose_query` tool, whose arguments are placed into the editor and never executed.

import type {
  DataAssistantEvent,
  DataAssistantGeneration,
  DataEngine,
  SqlDialect
} from '../../../../shared/data-projects/types'
import type { DataEngineService, MongoEngineService } from '../contracts'
import type { AssistantToolbox } from './tools'

/** What the tools read through: the introspection slice of DataEngineService. */
export type AssistantEngine = Pick<
  DataEngineService,
  'databases' | 'objects' | 'describe' | 'ddl' | 'completionSchema' | 'sampleRows'
> & { readonly mongo: Pick<MongoEngineService, 'schema' | 'indexes'> }

/** The engine service as the assistant service uses it (plus connect/status for the prompt). */
export type AssistantEngineService = AssistantEngine & Pick<DataEngineService, 'status' | 'connect'>

/** Everything a runner needs for one run. */
export interface AssistantRunInput {
  systemPrompt: string
  /** The conversation, the editor text and the question, as one user message. */
  userPrompt: string
  toolbox: AssistantToolbox
  generation: DataAssistantGeneration
  /** Aborted on cancel, on the whole-run timeout and when a newer question supersedes the run. */
  signal: AbortSignal
  emit: (event: DataAssistantEvent) => void
}

export interface AssistantRunOutcome {
  /** The model's prose when it answered without `propose_query` (a question back, an explanation). */
  answer: string | null
  /**
   * Something already reached the user (streamed text, a tool call, a proposal). A runner that
   * fails before this may be retried with the JSON-loop fallback; after it, never silently.
   */
  emitted: boolean
  /** The provider and model that actually answered (for the `done` event). */
  provider: string
  model?: string
}

export type AssistantRunner = (input: AssistantRunInput) => Promise<AssistantRunOutcome>

/** A failure the user should see as-is; `retryable` drives the Retry button. */
export class AssistantRunError extends Error {
  readonly retryable: boolean
  /** True when the runner failed before anything reached the user (fallback allowed). */
  readonly beforeOutput: boolean

  constructor(message: string, options: { retryable?: boolean; beforeOutput?: boolean } = {}) {
    super(message)
    this.name = 'AssistantRunError'
    this.retryable = options.retryable ?? true
    this.beforeOutput = options.beforeOutput ?? false
  }
}

/** Why a run's AbortController fired. */
export type AssistantAbortReason = 'cancelled' | 'timeout' | 'superseded' | 'shutdown'

export class AssistantAbort extends Error {
  readonly reason: AssistantAbortReason

  constructor(reason: AssistantAbortReason) {
    super(`Assistant run ${reason}`)
    this.name = 'AbortError'
    this.reason = reason
  }
}

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || /\babort(ed)?\b/i.test(error.message))

/** Checks a proposed query before it reaches the editor (parser errors go back to the model). */
export type ProposalValidator = (input: {
  language: 'sql' | 'mongo'
  dialect: SqlDialect | null
  engine: DataEngine
  query: string
}) => Promise<{ ok: true; isWrite: boolean | null } | { ok: false; error: string }>
