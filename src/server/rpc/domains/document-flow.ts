import { Effect } from 'effect'
import { z } from 'zod'
import {
  DOCUMENT_FLOW_UPDATED_CHANNEL,
  type DocumentFlowUpdatedEvent
} from '../../../shared/document-flow-events'
import {
  DOCUMENT_RUN_ITEM_STATUSES,
  DOCUMENT_RUN_STATUSES,
  type DocumentCommitResult,
  type DocumentMergeCheckResult,
  type DocumentMergeResult,
  type DocumentRun,
  type DocumentRunConfig,
  type DocumentRunDetail,
  type DocumentRunGeneration,
  type DocumentRunItem,
  type DocumentRunItemPatch,
  type DocumentRunLaunchConfig,
  type DocumentRunPatch,
  type DocumentRunVerdict,
  type DocumentRunnerClaim,
  type DocumentSimpleResult,
  type DocumentVerifyResult,
  type SessionFinalMessage
} from '../../../shared/types/document-flow'
import { AGENT_SDK_VALUES } from '../../../shared/types/agent-sdk'
import type { DocumentFlowService } from '../../../main/services/document-flow/document-flow-service'
import type { EventBus } from '../../events/event-bus'
import type { RpcHandler } from '../router'

export interface DocumentFlowCreateRunParams {
  projectId: string
  documentPath: string
  generation?: DocumentRunGeneration | null
}

export interface DocumentFlowRetryExtractionParams {
  runId: string
  generation?: DocumentRunGeneration | null
}

export interface DocumentFlowClassifyParams {
  runId: string
  itemId: string
  finalMessage?: string | null
}

export interface DocumentFlowLogEventParams {
  runId: string
  itemId?: string | null
  type: string
  message: string
  data?: unknown
}

type Rpc<A> = Effect.Effect<A, unknown, never>

export interface DocumentFlowRpcService {
  readonly createRun: (params: DocumentFlowCreateRunParams) => Rpc<DocumentRunDetail>
  readonly retryExtraction: (params: DocumentFlowRetryExtractionParams) => Rpc<DocumentRunDetail>
  readonly get: (runId: string) => Rpc<DocumentRunDetail | null>
  readonly list: (projectId?: string) => Rpc<DocumentRunDetail[]>
  readonly updateRun: (runId: string, patch: DocumentRunPatch) => Rpc<DocumentRun>
  readonly updateItem: (
    runId: string,
    itemId: string,
    patch: DocumentRunItemPatch
  ) => Rpc<DocumentRunItem>
  readonly start: (runId: string) => Rpc<DocumentRunDetail>
  readonly claimRunner: (runId: string, clientId: string) => Rpc<DocumentRunnerClaim>
  readonly sessionTurn: (sessionId: string) => Rpc<SessionFinalMessage | null>
  readonly classify: (params: DocumentFlowClassifyParams) => Rpc<DocumentRunVerdict>
  readonly prepareMerge: (runId: string, itemId: string) => Rpc<DocumentMergeCheckResult>
  readonly merge: (runId: string, itemId: string) => Rpc<DocumentMergeResult>
  readonly verify: (runId: string) => Rpc<DocumentVerifyResult>
  readonly commitIntegration: (runId: string, message: string) => Rpc<DocumentCommitResult>
  readonly rollbackMerge: (runId: string, itemId: string) => Rpc<DocumentSimpleResult>
  readonly finalize: (runId: string) => Rpc<DocumentRunDetail>
  readonly cancel: (runId: string) => Rpc<DocumentRunDetail>
  readonly delete: (runId: string) => Rpc<boolean>
  readonly logEvent: (params: DocumentFlowLogEventParams) => Rpc<void>
  readonly suggestVerifyCommand: (projectId: string) => Rpc<string | null>
}

const idSchema = z.string().min(1)
const nullableStringSchema = z.string().nullable().optional()
const counterSchema = z.number().int().min(0).optional()

const generationSchema = z
  .object({
    provider: z.enum(['claude-code', 'codex', 'opencode']),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional()
  })
  .strict() satisfies z.ZodType<DocumentRunGeneration>

const launchConfigSchema = z
  .object({
    sdk: z.enum(AGENT_SDK_VALUES).exclude(['terminal']),
    model: z
      .object({
        providerID: z.string().min(1),
        modelID: z.string().min(1),
        variant: z.string().optional()
      })
      .strict()
      .nullable(),
    codexFastMode: z.boolean(),
    customProviderId: z.string().nullable().optional()
  })
  .strict() satisfies z.ZodType<DocumentRunLaunchConfig>

const verdictSchema = z
  .object({
    status: z.enum(['done', 'needs_input', 'blocked', 'failed', 'partial']),
    reason: z.string(),
    question: z.string().nullable(),
    summary: z.string().nullable(),
    migrations: z.array(z.string()),
    manualSteps: z.array(z.string()),
    confidence: z.enum(['low', 'medium', 'high']),
    source: z.enum(['model', 'footer', 'fallback']),
    classifiedAt: z.string()
  })
  .strict() satisfies z.ZodType<DocumentRunVerdict>

const configPatchSchema = z
  .object({
    // Out-of-range values are clamped by the service rather than refused.
    maxParallel: z.number().optional(),
    verifyCommand: z.string().nullable().optional(),
    interactive: z.boolean().optional(),
    promptStyle: z.enum(['full', 'small']).optional(),
    defaultLaunch: launchConfigSchema.nullable().optional(),
    generation: generationSchema.nullable().optional(),
    // It ends up as a git argument: no whitespace, and nothing git could read as an option.
    baseBranch: z
      .string()
      .regex(/^(?!-)\S*$/)
      .nullable()
      .optional()
  })
  .strict() satisfies z.ZodType<Partial<DocumentRunConfig>>

const runPatchSchema = z
  .object({
    title: z.string().optional(),
    config: configPatchSchema.optional(),
    // Every other status is the server's to set.
    status: z.enum(DOCUMENT_RUN_STATUSES).extract(['running', 'paused']).optional()
  })
  .strict() satisfies z.ZodType<DocumentRunPatch>

const itemPatchSchema = z
  .object({
    title: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    depends_on: z.array(z.string()).optional(),
    selected: z.boolean().optional(),
    launch_config: launchConfigSchema.nullable().optional(),
    status: z.enum(DOCUMENT_RUN_ITEM_STATUSES).optional(),
    status_detail: nullableStringSchema,
    ticket_id: nullableStringSchema,
    worktree_id: nullableStringSchema,
    session_id: nullableStringSchema,
    fix_ticket_id: nullableStringSchema,
    fix_session_id: nullableStringSchema,
    branch_name: nullableStringSchema,
    verdict: verdictSchema.nullable().optional(),
    nudge_count: counterSchema,
    conflict_attempts: counterSchema,
    conflict_head: z.string().nullable().optional(),
    fix_attempts: counterSchema,
    continue_attempts: counterSchema,
    last_prompt_at: nullableStringSchema,
    last_checked_at: nullableStringSchema,
    retry_at: nullableStringSchema,
    started_at: nullableStringSchema,
    finished_at: nullableStringSchema
  })
  .strict() satisfies z.ZodType<DocumentRunItemPatch>

const runIdParamsSchema = z.object({ runId: idSchema }).strict()
const runItemParamsSchema = z.object({ runId: idSchema, itemId: idSchema }).strict()
const projectIdParamsSchema = z.object({ projectId: idSchema }).strict()
const createRunParamsSchema = z
  .object({
    projectId: idSchema,
    documentPath: z.string().min(1),
    generation: generationSchema.nullable().optional()
  })
  .strict() satisfies z.ZodType<DocumentFlowCreateRunParams>
const retryExtractionParamsSchema = z
  .object({ runId: idSchema, generation: generationSchema.nullable().optional() })
  .strict() satisfies z.ZodType<DocumentFlowRetryExtractionParams>
const listParamsSchema = z.union([
  z.object({ projectId: idSchema.optional() }).strict(),
  z.undefined(),
  z.null()
])
const updateRunParamsSchema = z.object({ runId: idSchema, patch: runPatchSchema }).strict()
const updateItemParamsSchema = z
  .object({ runId: idSchema, itemId: idSchema, patch: itemPatchSchema })
  .strict()
const claimRunnerParamsSchema = z.object({ runId: idSchema, clientId: idSchema }).strict()
const sessionTurnParamsSchema = z.object({ sessionId: idSchema }).strict()
const classifyParamsSchema = z
  .object({ runId: idSchema, itemId: idSchema, finalMessage: z.string().nullable().optional() })
  .strict() satisfies z.ZodType<DocumentFlowClassifyParams>
const commitIntegrationParamsSchema = z
  .object({ runId: idSchema, message: z.string().min(1) })
  .strict()
const logEventParamsSchema = z
  .object({
    runId: idSchema,
    itemId: idSchema.nullable().optional(),
    type: z.string().min(1),
    message: z.string(),
    data: z.unknown().optional()
  })
  .strict() satisfies z.ZodType<DocumentFlowLogEventParams>

export const makeLiveDocumentFlowRpcService = (eventBus?: EventBus): DocumentFlowRpcService => {
  const publish = (event: DocumentFlowUpdatedEvent): void => {
    if (!eventBus) return
    void Effect.runPromise(
      eventBus.publish({ channel: DOCUMENT_FLOW_UPDATED_CHANNEL, payload: event })
    ).catch(() => undefined)
  }

  const call = <A>(invoke: (service: DocumentFlowService) => A | Promise<A>): Rpc<A> =>
    Effect.tryPromise({
      try: async () => {
        const { getDocumentFlowService } =
          await import('../../../main/services/document-flow/document-flow-service')
        return invoke(await getDocumentFlowService(publish))
      },
      catch: (cause) => cause
    })

  return {
    createRun: (params) => call((service) => service.createRun(params)),
    retryExtraction: (params) => call((service) => service.retryExtraction(params)),
    get: (runId) => call((service) => service.get(runId)),
    list: (projectId) => call((service) => service.list(projectId)),
    updateRun: (runId, patch) => call((service) => service.updateRun(runId, patch)),
    updateItem: (runId, itemId, patch) =>
      call((service) => service.updateItem(runId, itemId, patch)),
    start: (runId) => call((service) => service.start(runId)),
    claimRunner: (runId, clientId) => call((service) => service.claimRunner(runId, clientId)),
    sessionTurn: (sessionId) => call((service) => service.sessionTurn(sessionId)),
    classify: (params) => call((service) => service.classify(params)),
    prepareMerge: (runId, itemId) => call((service) => service.prepareMerge(runId, itemId)),
    merge: (runId, itemId) => call((service) => service.merge(runId, itemId)),
    verify: (runId) => call((service) => service.verify(runId)),
    commitIntegration: (runId, message) =>
      call((service) => service.commitIntegration(runId, message)),
    rollbackMerge: (runId, itemId) => call((service) => service.rollbackMerge(runId, itemId)),
    finalize: (runId) => call((service) => service.finalize(runId)),
    cancel: (runId) => call((service) => service.cancel(runId)),
    delete: (runId) => call((service) => service.delete(runId)),
    logEvent: (params) => call((service) => service.logEvent(params)),
    suggestVerifyCommand: (projectId) => call((service) => service.suggestVerifyCommand(projectId))
  }
}

/** Validate the params against `schema`, then hand them to the service. */
const handle =
  <P, A>(schema: z.ZodType<P>, run: (params: P) => Rpc<A>): RpcHandler =>
  (params) =>
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => schema.parse(params),
        catch: (cause) => cause
      })
      return yield* run(parsed)
    })

export const makeDocumentFlowRpcHandlers = (
  service: DocumentFlowRpcService = makeLiveDocumentFlowRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'documentFlow.createRun',
      handle(createRunParamsSchema, (params) => service.createRun(params))
    ],
    [
      'documentFlow.retryExtraction',
      handle(retryExtractionParamsSchema, (params) => service.retryExtraction(params))
    ],
    ['documentFlow.get', handle(runIdParamsSchema, ({ runId }) => service.get(runId))],
    ['documentFlow.list', handle(listParamsSchema, (params) => service.list(params?.projectId))],
    [
      'documentFlow.updateRun',
      handle(updateRunParamsSchema, ({ runId, patch }) => service.updateRun(runId, patch))
    ],
    [
      'documentFlow.updateItem',
      handle(updateItemParamsSchema, ({ runId, itemId, patch }) =>
        service.updateItem(runId, itemId, patch)
      )
    ],
    ['documentFlow.start', handle(runIdParamsSchema, ({ runId }) => service.start(runId))],
    [
      'documentFlow.claimRunner',
      handle(claimRunnerParamsSchema, ({ runId, clientId }) => service.claimRunner(runId, clientId))
    ],
    [
      'documentFlow.sessionTurn',
      handle(sessionTurnParamsSchema, ({ sessionId }) => service.sessionTurn(sessionId))
    ],
    ['documentFlow.classify', handle(classifyParamsSchema, (params) => service.classify(params))],
    [
      'documentFlow.prepareMerge',
      handle(runItemParamsSchema, ({ runId, itemId }) => service.prepareMerge(runId, itemId))
    ],
    [
      'documentFlow.merge',
      handle(runItemParamsSchema, ({ runId, itemId }) => service.merge(runId, itemId))
    ],
    ['documentFlow.verify', handle(runIdParamsSchema, ({ runId }) => service.verify(runId))],
    [
      'documentFlow.commitIntegration',
      handle(commitIntegrationParamsSchema, ({ runId, message }) =>
        service.commitIntegration(runId, message)
      )
    ],
    [
      'documentFlow.rollbackMerge',
      handle(runItemParamsSchema, ({ runId, itemId }) => service.rollbackMerge(runId, itemId))
    ],
    ['documentFlow.finalize', handle(runIdParamsSchema, ({ runId }) => service.finalize(runId))],
    ['documentFlow.cancel', handle(runIdParamsSchema, ({ runId }) => service.cancel(runId))],
    ['documentFlow.delete', handle(runIdParamsSchema, ({ runId }) => service.delete(runId))],
    ['documentFlow.logEvent', handle(logEventParamsSchema, (params) => service.logEvent(params))],
    [
      'documentFlow.suggestVerifyCommand',
      handle(projectIdParamsSchema, ({ projectId }) => service.suggestVerifyCommand(projectId))
    ]
  ])
