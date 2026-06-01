import { Effect } from 'effect'
import { z } from 'zod'
import {
  isDesktopCommandResult,
  makeDesktopCommandRequest,
  type OpenCodeAbortResult,
  type OpenCodeCapabilitiesResult,
  type OpenCodeCommandResult,
  type OpenCodeCommandsResult,
  type OpenCodeCommandApprovalReplyResult,
  type OpenCodeConnectResult,
  type OpenCodeDisconnectResult,
  type OpenCodeForkResult,
  type OpenCodeGetMessagesResult,
  type OpenCodeListModelsPayload,
  type OpenCodeListModelsResult,
  type OpenCodeModelInfoResult,
  type OpenCodePermissionListResult,
  type OpenCodePermissionReplyResult,
  type OpenCodePlanApproveResult,
  type OpenCodePlanRejectResult,
  type OpenCodePromptMessage,
  type OpenCodePromptModel,
  type OpenCodePromptOptions,
  type OpenCodePromptResult,
  type OpenCodeQuestionReplyResult,
  type OpenCodeQuestionRejectResult,
  type OpenCodeRefreshFromThreadResult,
  type OpenCodeRedoResult,
  type OpenCodeReconnectResult,
  type OpenCodeRenameSessionResult,
  type OpenCodeSetModelInput,
  type OpenCodeSetModelResult,
  type OpenCodeSessionInfoResult,
  type OpenCodeSteerResult,
  type OpenCodeUndoResult
} from '../../../shared/desktop-command'
import type { RpcHandler } from '../router'

export interface OpenCodeOpsRpcService {
  readonly connect: (
    worktreePath: string,
    hiveSessionId: string
  ) => Effect.Effect<OpenCodeConnectResult, unknown, never>
  readonly reconnect: (
    worktreePath: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ) => Effect.Effect<OpenCodeReconnectResult, unknown, never>
  readonly prompt: (
    worktreePath: string,
    opencodeSessionId: string,
    messageOrParts: OpenCodePromptMessage,
    model?: OpenCodePromptModel,
    options?: OpenCodePromptOptions
  ) => Effect.Effect<OpenCodePromptResult, unknown, never>
  readonly abort: (
    worktreePath: string,
    opencodeSessionId: string
  ) => Effect.Effect<OpenCodeAbortResult, unknown, never>
  readonly steer: (
    worktreePath: string,
    opencodeSessionId: string,
    message: string
  ) => Effect.Effect<OpenCodeSteerResult, unknown, never>
  readonly disconnect: (
    worktreePath: string,
    opencodeSessionId: string
  ) => Effect.Effect<OpenCodeDisconnectResult, unknown, never>
  readonly getMessages: (
    worktreePath: string,
    opencodeSessionId: string
  ) => Effect.Effect<OpenCodeGetMessagesResult, unknown, never>
  readonly refreshFromThread: (
    worktreePath: string,
    opencodeSessionId: string
  ) => Effect.Effect<OpenCodeRefreshFromThreadResult, unknown, never>
  readonly listModels: (
    opts?: OpenCodeListModelsPayload
  ) => Effect.Effect<OpenCodeListModelsResult, unknown, never>
  readonly setModel: (
    model: OpenCodeSetModelInput | null
  ) => Effect.Effect<OpenCodeSetModelResult, unknown, never>
  readonly modelInfo: (
    worktreePath: string,
    modelId: string,
    agentSdk?: OpenCodeListModelsPayload['agentSdk']
  ) => Effect.Effect<OpenCodeModelInfoResult, unknown, never>
  readonly questionReply: (
    requestId: string,
    answers: string[][],
    worktreePath?: string
  ) => Effect.Effect<OpenCodeQuestionReplyResult, unknown, never>
  readonly questionReject: (
    requestId: string,
    worktreePath?: string
  ) => Effect.Effect<OpenCodeQuestionRejectResult, unknown, never>
  readonly planApprove: (
    worktreePath: string,
    hiveSessionId: string,
    requestId?: string
  ) => Effect.Effect<OpenCodePlanApproveResult, unknown, never>
  readonly planReject: (
    worktreePath: string,
    hiveSessionId: string,
    feedback: string,
    requestId?: string
  ) => Effect.Effect<OpenCodePlanRejectResult, unknown, never>
  readonly permissionReply: (
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    worktreePath?: string,
    message?: string
  ) => Effect.Effect<OpenCodePermissionReplyResult, unknown, never>
  readonly permissionList: (
    worktreePath?: string
  ) => Effect.Effect<OpenCodePermissionListResult, unknown, never>
  readonly commandApprovalReply: (
    requestId: string,
    approved: boolean,
    remember?: 'allow' | 'block',
    pattern?: string,
    worktreePath?: string,
    patterns?: string[]
  ) => Effect.Effect<OpenCodeCommandApprovalReplyResult, unknown, never>
  readonly sessionInfo: (
    worktreePath: string,
    opencodeSessionId: string
  ) => Effect.Effect<OpenCodeSessionInfoResult, unknown, never>
  readonly undo: (
    worktreePath: string,
    opencodeSessionId: string
  ) => Effect.Effect<OpenCodeUndoResult, unknown, never>
  readonly redo: (
    worktreePath: string,
    opencodeSessionId: string
  ) => Effect.Effect<OpenCodeRedoResult, unknown, never>
  readonly command: (
    worktreePath: string,
    opencodeSessionId: string,
    command: string,
    args: string,
    model?: OpenCodePromptModel,
    options?: OpenCodePromptOptions
  ) => Effect.Effect<OpenCodeCommandResult, unknown, never>
  readonly commands: (
    worktreePath: string,
    sessionId?: string
  ) => Effect.Effect<OpenCodeCommandsResult, unknown, never>
  readonly renameSession: (
    opencodeSessionId: string,
    title: string,
    worktreePath?: string
  ) => Effect.Effect<OpenCodeRenameSessionResult, unknown, never>
  readonly capabilities: (
    sessionId?: string
  ) => Effect.Effect<OpenCodeCapabilitiesResult, unknown, never>
  readonly fork: (
    worktreePath: string,
    opencodeSessionId: string,
    messageId?: string
  ) => Effect.Effect<OpenCodeForkResult, unknown, never>
}

const promptPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('file'),
      mime: z.string(),
      url: z.string(),
      filename: z.string().optional()
    })
    .strict()
])
const connectParamsSchema = z
  .object({ worktreePath: z.string().min(1), hiveSessionId: z.string().min(1) })
  .strict()
const reconnectParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    opencodeSessionId: z.string().min(1),
    hiveSessionId: z.string().min(1)
  })
  .strict()
const promptParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    opencodeSessionId: z.string().min(1),
    messageOrParts: z.union([z.string(), z.array(promptPartSchema)]),
    model: z
      .object({
        providerID: z.string().min(1),
        modelID: z.string().min(1),
        variant: z.string().optional()
      })
      .strict()
      .optional(),
    options: z.object({ codexFastMode: z.boolean().optional() }).strict().optional()
  })
  .strict()
const abortParamsSchema = z
  .object({ worktreePath: z.string().min(1), opencodeSessionId: z.string().min(1) })
  .strict()
const steerParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    opencodeSessionId: z.string().min(1),
    message: z.string()
  })
  .strict()
const disconnectParamsSchema = z
  .object({ worktreePath: z.string().min(1), opencodeSessionId: z.string().min(1) })
  .strict()
const getMessagesParamsSchema = z
  .object({ worktreePath: z.string().min(1), opencodeSessionId: z.string().min(1) })
  .strict()
const refreshFromThreadParamsSchema = z
  .object({ worktreePath: z.string().min(1), opencodeSessionId: z.string().min(1) })
  .strict()
const agentSdkSchema = z.enum(['opencode', 'claude-code', 'claude-code-cli', 'codex', 'terminal'])
const listModelsParamsSchema = z.object({ agentSdk: agentSdkSchema.optional() }).strict().optional()
const setModelParamsSchema = z
  .object({
    providerID: z.string(),
    modelID: z.string(),
    variant: z.string().optional(),
    agentSdk: agentSdkSchema.optional()
  })
  .passthrough()
  .nullable()
const modelInfoParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    modelId: z.string().min(1),
    agentSdk: agentSdkSchema.optional()
  })
  .strict()
const questionReplyParamsSchema = z
  .object({
    requestId: z.string().min(1),
    answers: z.array(z.array(z.string())),
    worktreePath: z.string().optional()
  })
  .strict()
const questionRejectParamsSchema = z
  .object({
    requestId: z.string().min(1),
    worktreePath: z.string().optional()
  })
  .strict()
const planApproveParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    hiveSessionId: z.string().min(1),
    requestId: z.string().optional()
  })
  .strict()
const planRejectParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    hiveSessionId: z.string().min(1),
    feedback: z.string(),
    requestId: z.string().optional()
  })
  .strict()
const permissionReplyParamsSchema = z
  .object({
    requestId: z.string().min(1),
    reply: z.enum(['once', 'always', 'reject']),
    worktreePath: z.string().optional(),
    message: z.string().optional()
  })
  .strict()
const permissionListParamsSchema = z.object({ worktreePath: z.string().optional() }).strict()
const commandApprovalReplyParamsSchema = z
  .object({
    requestId: z.string().min(1),
    approved: z.boolean(),
    remember: z.enum(['allow', 'block']).optional(),
    pattern: z.string().optional(),
    worktreePath: z.string().optional(),
    patterns: z.array(z.string()).optional()
  })
  .strict()
const sessionInfoParamsSchema = z
  .object({ worktreePath: z.string().min(1), opencodeSessionId: z.string().min(1) })
  .strict()
const undoParamsSchema = z
  .object({ worktreePath: z.string().min(1), opencodeSessionId: z.string().min(1) })
  .strict()
const redoParamsSchema = z
  .object({ worktreePath: z.string().min(1), opencodeSessionId: z.string().min(1) })
  .strict()
const commandParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    opencodeSessionId: z.string().min(1),
    command: z.string().min(1),
    args: z.string(),
    model: z
      .object({
        providerID: z.string().min(1),
        modelID: z.string().min(1),
        variant: z.string().optional()
      })
      .strict()
      .optional(),
    options: z.object({ codexFastMode: z.boolean().optional() }).strict().optional()
  })
  .strict()
const commandsParamsSchema = z
  .object({ worktreePath: z.string().min(1), sessionId: z.string().optional() })
  .strict()
const renameSessionParamsSchema = z
  .object({
    opencodeSessionId: z.string().min(1),
    title: z.string(),
    worktreePath: z.string().optional()
  })
  .strict()
const capabilitiesParamsSchema = z.object({ sessionId: z.string().optional() }).strict()
const forkParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    opencodeSessionId: z.string().min(1),
    messageId: z.string().optional()
  })
  .strict()

export const makeLiveOpenCodeOpsRpcService = (): OpenCodeOpsRpcService => ({
  connect: (worktreePath, hiveSessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeConnectCommand(worktreePath, hiveSessionId),
      catch: (cause) => cause
    }),
  reconnect: (worktreePath, opencodeSessionId, hiveSessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeReconnectCommand(worktreePath, opencodeSessionId, hiveSessionId),
      catch: (cause) => cause
    }),
  prompt: (worktreePath, opencodeSessionId, messageOrParts, model, options) =>
    Effect.tryPromise({
      try: () =>
        requestOpenCodePromptCommand(
          worktreePath,
          opencodeSessionId,
          messageOrParts,
          model,
          options
        ),
      catch: (cause) => cause
    }),
  abort: (worktreePath, opencodeSessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeAbortCommand(worktreePath, opencodeSessionId),
      catch: (cause) => cause
    }),
  steer: (worktreePath, opencodeSessionId, message) =>
    Effect.tryPromise({
      try: () => requestOpenCodeSteerCommand(worktreePath, opencodeSessionId, message),
      catch: (cause) => cause
    }),
  disconnect: (worktreePath, opencodeSessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeDisconnectCommand(worktreePath, opencodeSessionId),
      catch: (cause) => cause
    }),
  getMessages: (worktreePath, opencodeSessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeGetMessagesCommand(worktreePath, opencodeSessionId),
      catch: (cause) => cause
    }),
  refreshFromThread: (worktreePath, opencodeSessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeRefreshFromThreadCommand(worktreePath, opencodeSessionId),
      catch: (cause) => cause
    }),
  listModels: (opts) =>
    Effect.tryPromise({
      try: () => requestOpenCodeListModelsCommand(opts),
      catch: (cause) => cause
    }),
  setModel: (model) =>
    Effect.tryPromise({
      try: () => requestOpenCodeSetModelCommand(model),
      catch: (cause) => cause
    }),
  modelInfo: (worktreePath, modelId, agentSdk) =>
    Effect.tryPromise({
      try: () => requestOpenCodeModelInfoCommand(worktreePath, modelId, agentSdk),
      catch: (cause) => cause
    }),
  questionReply: (requestId, answers, worktreePath) =>
    Effect.tryPromise({
      try: () => requestOpenCodeQuestionReplyCommand(requestId, answers, worktreePath),
      catch: (cause) => cause
    }),
  questionReject: (requestId, worktreePath) =>
    Effect.tryPromise({
      try: () => requestOpenCodeQuestionRejectCommand(requestId, worktreePath),
      catch: (cause) => cause
    }),
  planApprove: (worktreePath, hiveSessionId, requestId) =>
    Effect.tryPromise({
      try: () => requestOpenCodePlanApproveCommand(worktreePath, hiveSessionId, requestId),
      catch: (cause) => cause
    }),
  planReject: (worktreePath, hiveSessionId, feedback, requestId) =>
    Effect.tryPromise({
      try: () => requestOpenCodePlanRejectCommand(worktreePath, hiveSessionId, feedback, requestId),
      catch: (cause) => cause
    }),
  permissionReply: (requestId, reply, worktreePath, message) =>
    Effect.tryPromise({
      try: () => requestOpenCodePermissionReplyCommand(requestId, reply, worktreePath, message),
      catch: (cause) => cause
    }),
  permissionList: (worktreePath) =>
    Effect.tryPromise({
      try: () => requestOpenCodePermissionListCommand(worktreePath),
      catch: (cause) => cause
    }),
  commandApprovalReply: (requestId, approved, remember, pattern, worktreePath, patterns) =>
    Effect.tryPromise({
      try: () =>
        requestOpenCodeCommandApprovalReplyCommand(
          requestId,
          approved,
          remember,
          pattern,
          worktreePath,
          patterns
        ),
      catch: (cause) => cause
    }),
  sessionInfo: (worktreePath, opencodeSessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeSessionInfoCommand(worktreePath, opencodeSessionId),
      catch: (cause) => cause
    }),
  undo: (worktreePath, opencodeSessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeUndoCommand(worktreePath, opencodeSessionId),
      catch: (cause) => cause
    }),
  redo: (worktreePath, opencodeSessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeRedoCommand(worktreePath, opencodeSessionId),
      catch: (cause) => cause
    }),
  command: (worktreePath, opencodeSessionId, command, args, model, options) =>
    Effect.tryPromise({
      try: () =>
        requestOpenCodeCommandCommand(
          worktreePath,
          opencodeSessionId,
          command,
          args,
          model,
          options
        ),
      catch: (cause) => cause
    }),
  commands: (worktreePath, sessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeCommandsCommand(worktreePath, sessionId),
      catch: (cause) => cause
    }),
  renameSession: (opencodeSessionId, title, worktreePath) =>
    Effect.tryPromise({
      try: () => requestOpenCodeRenameSessionCommand(opencodeSessionId, title, worktreePath),
      catch: (cause) => cause
    }),
  capabilities: (sessionId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeCapabilitiesCommand(sessionId),
      catch: (cause) => cause
    }),
  fork: (worktreePath, opencodeSessionId, messageId) =>
    Effect.tryPromise({
      try: () => requestOpenCodeForkCommand(worktreePath, opencodeSessionId, messageId),
      catch: (cause) => cause
    })
})

export const makeOpenCodeOpsRpcHandlers = (
  service: OpenCodeOpsRpcService = makeLiveOpenCodeOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'opencodeOps.connect',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, hiveSessionId } = yield* Effect.try({
            try: () => connectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.connect(worktreePath, hiveSessionId)
        })
    ],
    [
      'opencodeOps.reconnect',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId, hiveSessionId } = yield* Effect.try({
            try: () => reconnectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.reconnect(worktreePath, opencodeSessionId, hiveSessionId)
        })
    ],
    [
      'opencodeOps.prompt',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId, messageOrParts, model, options } =
            yield* Effect.try({
              try: () => promptParamsSchema.parse(params),
              catch: (cause) => cause
            })
          return yield* service.prompt(
            worktreePath,
            opencodeSessionId,
            messageOrParts,
            model,
            options
          )
        })
    ],
    [
      'opencodeOps.abort',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId } = yield* Effect.try({
            try: () => abortParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.abort(worktreePath, opencodeSessionId)
        })
    ],
    [
      'opencodeOps.steer',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId, message } = yield* Effect.try({
            try: () => steerParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.steer(worktreePath, opencodeSessionId, message)
        })
    ],
    [
      'opencodeOps.disconnect',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId } = yield* Effect.try({
            try: () => disconnectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.disconnect(worktreePath, opencodeSessionId)
        })
    ],
    [
      'opencodeOps.getMessages',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId } = yield* Effect.try({
            try: () => getMessagesParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getMessages(worktreePath, opencodeSessionId)
        })
    ],
    [
      'opencodeOps.refreshFromThread',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId } = yield* Effect.try({
            try: () => refreshFromThreadParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.refreshFromThread(worktreePath, opencodeSessionId)
        })
    ],
    [
      'opencodeOps.listModels',
      (params) =>
        Effect.gen(function* () {
          const opts = yield* Effect.try({
            try: () => listModelsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listModels(opts)
        })
    ],
    [
      'opencodeOps.setModel',
      (params) =>
        Effect.gen(function* () {
          const model = yield* Effect.try({
            try: () => setModelParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setModel(model)
        })
    ],
    [
      'opencodeOps.modelInfo',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, modelId, agentSdk } = yield* Effect.try({
            try: () => modelInfoParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.modelInfo(worktreePath, modelId, agentSdk)
        })
    ],
    [
      'opencodeOps.questionReply',
      (params) =>
        Effect.gen(function* () {
          const { requestId, answers, worktreePath } = yield* Effect.try({
            try: () => questionReplyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.questionReply(requestId, answers, worktreePath)
        })
    ],
    [
      'opencodeOps.questionReject',
      (params) =>
        Effect.gen(function* () {
          const { requestId, worktreePath } = yield* Effect.try({
            try: () => questionRejectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.questionReject(requestId, worktreePath)
        })
    ],
    [
      'opencodeOps.planApprove',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, hiveSessionId, requestId } = yield* Effect.try({
            try: () => planApproveParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.planApprove(worktreePath, hiveSessionId, requestId)
        })
    ],
    [
      'opencodeOps.planReject',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, hiveSessionId, feedback, requestId } = yield* Effect.try({
            try: () => planRejectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.planReject(worktreePath, hiveSessionId, feedback, requestId)
        })
    ],
    [
      'opencodeOps.permissionReply',
      (params) =>
        Effect.gen(function* () {
          const { requestId, reply, worktreePath, message } = yield* Effect.try({
            try: () => permissionReplyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.permissionReply(requestId, reply, worktreePath, message)
        })
    ],
    [
      'opencodeOps.permissionList',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => permissionListParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.permissionList(worktreePath)
        })
    ],
    [
      'opencodeOps.commandApprovalReply',
      (params) =>
        Effect.gen(function* () {
          const { requestId, approved, remember, pattern, worktreePath, patterns } =
            yield* Effect.try({
              try: () => commandApprovalReplyParamsSchema.parse(params),
              catch: (cause) => cause
            })
          return yield* service.commandApprovalReply(
            requestId,
            approved,
            remember,
            pattern,
            worktreePath,
            patterns
          )
        })
    ],
    [
      'opencodeOps.sessionInfo',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId } = yield* Effect.try({
            try: () => sessionInfoParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.sessionInfo(worktreePath, opencodeSessionId)
        })
    ],
    [
      'opencodeOps.undo',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId } = yield* Effect.try({
            try: () => undoParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.undo(worktreePath, opencodeSessionId)
        })
    ],
    [
      'opencodeOps.redo',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId } = yield* Effect.try({
            try: () => redoParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.redo(worktreePath, opencodeSessionId)
        })
    ],
    [
      'opencodeOps.command',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId, command, args, model, options } =
            yield* Effect.try({
              try: () => commandParamsSchema.parse(params),
              catch: (cause) => cause
            })
          return yield* service.command(
            worktreePath,
            opencodeSessionId,
            command,
            args,
            model,
            options
          )
        })
    ],
    [
      'opencodeOps.commands',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, sessionId } = yield* Effect.try({
            try: () => commandsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.commands(worktreePath, sessionId)
        })
    ],
    [
      'opencodeOps.renameSession',
      (params) =>
        Effect.gen(function* () {
          const { opencodeSessionId, title, worktreePath } = yield* Effect.try({
            try: () => renameSessionParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.renameSession(opencodeSessionId, title, worktreePath)
        })
    ],
    [
      'opencodeOps.capabilities',
      (params) =>
        Effect.gen(function* () {
          const { sessionId } = yield* Effect.try({
            try: () => capabilitiesParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.capabilities(sessionId)
        })
    ],
    [
      'opencodeOps.fork',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, opencodeSessionId, messageId } = yield* Effect.try({
            try: () => forkParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.fork(worktreePath, opencodeSessionId, messageId)
        })
    ]
  ])

const requestOpenCodeConnectCommand = (
  worktreePath: string,
  hiveSessionId: string
): Promise<OpenCodeConnectResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-connect-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeConnect'

  return new Promise<OpenCodeConnectResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeConnectResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, hiveSessionId }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeReconnectCommand = (
  worktreePath: string,
  opencodeSessionId: string,
  hiveSessionId: string
): Promise<OpenCodeReconnectResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({ success: false })
  }

  const id = `opencode-reconnect-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeReconnect'

  return new Promise<OpenCodeReconnectResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeReconnectResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        worktreePath,
        opencodeSessionId,
        hiveSessionId
      }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodePromptCommand = (
  worktreePath: string,
  opencodeSessionId: string,
  messageOrParts: OpenCodePromptMessage,
  model?: OpenCodePromptModel,
  options?: OpenCodePromptOptions
): Promise<OpenCodePromptResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodePrompt'

  return new Promise<OpenCodePromptResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodePromptResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        worktreePath,
        opencodeSessionId,
        messageOrParts,
        model,
        options
      }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeAbortCommand = (
  worktreePath: string,
  opencodeSessionId: string
): Promise<OpenCodeAbortResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-abort-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeAbort'

  return new Promise<OpenCodeAbortResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeAbortResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, opencodeSessionId }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeSteerCommand = (
  worktreePath: string,
  opencodeSessionId: string,
  message: string
): Promise<OpenCodeSteerResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-steer-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeSteer'

  return new Promise<OpenCodeSteerResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (desktopMessage: unknown): void => {
      if (!isDesktopCommandResult(desktopMessage) || desktopMessage.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!desktopMessage.ok) {
        reject(new Error(desktopMessage.error || `Desktop command failed: ${command}`))
        return
      }

      const value = desktopMessage.value
      if (isOpenCodeSteerResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, opencodeSessionId, message }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeDisconnectCommand = (
  worktreePath: string,
  opencodeSessionId: string
): Promise<OpenCodeDisconnectResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-disconnect-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeDisconnect'

  return new Promise<OpenCodeDisconnectResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeDisconnectResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, opencodeSessionId }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeGetMessagesCommand = (
  worktreePath: string,
  opencodeSessionId: string
): Promise<OpenCodeGetMessagesResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available',
      messages: []
    })
  }

  const id = `opencode-get-messages-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeGetMessages'

  return new Promise<OpenCodeGetMessagesResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeGetMessagesResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, opencodeSessionId }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeRefreshFromThreadCommand = (
  worktreePath: string,
  opencodeSessionId: string
): Promise<OpenCodeRefreshFromThreadResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-refresh-from-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeRefreshFromThread'

  return new Promise<OpenCodeRefreshFromThreadResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeRefreshFromThreadResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, opencodeSessionId }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeListModelsCommand = (
  opts?: OpenCodeListModelsPayload
): Promise<OpenCodeListModelsResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available',
      providers: {}
    })
  }

  const id = `opencode-list-models-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeListModels'

  return new Promise<OpenCodeListModelsResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeListModelsResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, opts ?? {}), (error) => {
      if (!error) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)
      reject(error)
    })
  })
}

const requestOpenCodeSetModelCommand = (
  model: OpenCodeSetModelInput | null
): Promise<OpenCodeSetModelResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-set-model-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeSetModel'

  return new Promise<OpenCodeSetModelResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeSetModelResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { model }), (error) => {
      if (!error) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)
      reject(error)
    })
  })
}

const requestOpenCodeModelInfoCommand = (
  worktreePath: string,
  modelId: string,
  agentSdk?: OpenCodeListModelsPayload['agentSdk']
): Promise<OpenCodeModelInfoResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-model-info-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeModelInfo'

  return new Promise<OpenCodeModelInfoResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeModelInfoResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, modelId, agentSdk }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeQuestionReplyCommand = (
  requestId: string,
  answers: string[][],
  worktreePath?: string
): Promise<OpenCodeQuestionReplyResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-question-reply-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeQuestionReply'

  return new Promise<OpenCodeQuestionReplyResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeQuestionReplyResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { requestId, answers, worktreePath }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeQuestionRejectCommand = (
  requestId: string,
  worktreePath?: string
): Promise<OpenCodeQuestionRejectResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-question-reject-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeQuestionReject'

  return new Promise<OpenCodeQuestionRejectResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeQuestionRejectResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { requestId, worktreePath }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodePlanApproveCommand = (
  worktreePath: string,
  hiveSessionId: string,
  requestId?: string
): Promise<OpenCodePlanApproveResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-plan-approve-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodePlanApprove'

  return new Promise<OpenCodePlanApproveResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodePlanApproveResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, hiveSessionId, requestId }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodePlanRejectCommand = (
  worktreePath: string,
  hiveSessionId: string,
  feedback: string,
  requestId?: string
): Promise<OpenCodePlanRejectResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-plan-reject-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodePlanReject'

  return new Promise<OpenCodePlanRejectResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodePlanRejectResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        worktreePath,
        hiveSessionId,
        feedback,
        requestId
      }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodePermissionReplyCommand = (
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  worktreePath?: string,
  message?: string
): Promise<OpenCodePermissionReplyResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-permission-reply-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodePermissionReply'

  return new Promise<OpenCodePermissionReplyResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (desktopMessage: unknown): void => {
      if (!isDesktopCommandResult(desktopMessage) || desktopMessage.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!desktopMessage.ok) {
        reject(new Error(desktopMessage.error || `Desktop command failed: ${command}`))
        return
      }

      const value = desktopMessage.value
      if (isOpenCodePermissionReplyResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        requestId,
        reply,
        worktreePath,
        message
      }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodePermissionListCommand = (
  worktreePath?: string
): Promise<OpenCodePermissionListResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      permissions: [],
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-permission-list-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodePermissionList'

  return new Promise<OpenCodePermissionListResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodePermissionListResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { worktreePath }), (error) => {
      if (!error) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)
      reject(error)
    })
  })
}

const requestOpenCodeCommandApprovalReplyCommand = (
  requestId: string,
  approved: boolean,
  remember?: 'allow' | 'block',
  pattern?: string,
  worktreePath?: string,
  patterns?: string[]
): Promise<OpenCodeCommandApprovalReplyResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-command-approval-reply-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeCommandApprovalReply'

  return new Promise<OpenCodeCommandApprovalReplyResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeCommandApprovalReplyResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        requestId,
        approved,
        remember,
        pattern,
        worktreePath,
        patterns
      }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeSessionInfoCommand = (
  worktreePath: string,
  opencodeSessionId: string
): Promise<OpenCodeSessionInfoResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-session-info-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeSessionInfo'

  return new Promise<OpenCodeSessionInfoResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeSessionInfoResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, opencodeSessionId }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeUndoCommand = (
  worktreePath: string,
  opencodeSessionId: string
): Promise<OpenCodeUndoResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-undo-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeUndo'

  return new Promise<OpenCodeUndoResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeUndoResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, opencodeSessionId }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeRedoCommand = (
  worktreePath: string,
  opencodeSessionId: string
): Promise<OpenCodeRedoResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-redo-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeRedo'

  return new Promise<OpenCodeRedoResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeRedoResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { worktreePath, opencodeSessionId }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeCommandCommand = (
  worktreePath: string,
  opencodeSessionId: string,
  commandName: string,
  args: string,
  model?: OpenCodePromptModel,
  options?: OpenCodePromptOptions
): Promise<OpenCodeCommandResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-command-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeCommand'

  return new Promise<OpenCodeCommandResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeCommandResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        worktreePath,
        opencodeSessionId,
        command: commandName,
        args,
        model,
        options
      }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeCommandsCommand = (
  worktreePath: string,
  sessionId?: string
): Promise<OpenCodeCommandsResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      commands: [],
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeCommands'

  return new Promise<OpenCodeCommandsResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeCommandsResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        worktreePath,
        sessionId
      }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeRenameSessionCommand = (
  opencodeSessionId: string,
  title: string,
  worktreePath?: string
): Promise<OpenCodeRenameSessionResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-rename-session-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeRenameSession'

  return new Promise<OpenCodeRenameSessionResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeRenameSessionResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        opencodeSessionId,
        title,
        worktreePath
      }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const requestOpenCodeCapabilitiesCommand = (
  sessionId?: string
): Promise<OpenCodeCapabilitiesResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-capabilities-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeCapabilities'

  return new Promise<OpenCodeCapabilitiesResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeCapabilitiesResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { sessionId }), (error) => {
      if (!error) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)
      reject(error)
    })
  })
}

const requestOpenCodeForkCommand = (
  worktreePath: string,
  opencodeSessionId: string,
  messageId?: string
): Promise<OpenCodeForkResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command bridge is not available'
    })
  }

  const id = `opencode-fork-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'opencodeFork'

  return new Promise<OpenCodeForkResult>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      process.off('message', onMessage)
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 10_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('message', onMessage)

      if (!message.ok) {
        reject(new Error(message.error || `Desktop command failed: ${command}`))
        return
      }

      const value = message.value
      if (isOpenCodeForkResult(value)) {
        resolve(value)
        return
      }

      reject(new Error(`Invalid desktop command response for ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        worktreePath,
        opencodeSessionId,
        messageId
      }),
      (error) => {
        if (!error) return
        if (settled) return
        settled = true
        clearTimeout(timeout)
        process.off('message', onMessage)
        reject(error)
      }
    )
  })
}

const isOpenCodeConnectResult = (value: unknown): value is OpenCodeConnectResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.sessionId === undefined || typeof record.sessionId === 'string') &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeReconnectResult = (value: unknown): value is OpenCodeReconnectResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.sessionStatus === undefined ||
      record.sessionStatus === 'idle' ||
      record.sessionStatus === 'busy' ||
      record.sessionStatus === 'retry') &&
    (record.revertMessageID === undefined ||
      record.revertMessageID === null ||
      typeof record.revertMessageID === 'string')
  )
}

const isOpenCodePromptResult = (value: unknown): value is OpenCodePromptResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeAbortResult = (value: unknown): value is OpenCodeAbortResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeSteerResult = (value: unknown): value is OpenCodeSteerResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string') &&
    (record.insertedMessageId === undefined || typeof record.insertedMessageId === 'string') &&
    (record.nextAssistantMessageId === undefined ||
      typeof record.nextAssistantMessageId === 'string') &&
    (record.turnId === undefined || typeof record.turnId === 'string')
  )
}

const isOpenCodeDisconnectResult = (value: unknown): value is OpenCodeDisconnectResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeGetMessagesResult = (value: unknown): value is OpenCodeGetMessagesResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    Array.isArray(record.messages) &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeRefreshFromThreadResult = (
  value: unknown
): value is OpenCodeRefreshFromThreadResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.count === undefined || typeof record.count === 'number') &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeListModelsResult = (value: unknown): value is OpenCodeListModelsResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    Object.prototype.hasOwnProperty.call(record, 'providers') &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeSetModelResult = (value: unknown): value is OpenCodeSetModelResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeModelInfoResult = (value: unknown): value is OpenCodeModelInfoResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.success !== 'boolean') return false
  if (record.error !== undefined && typeof record.error !== 'string') return false
  if (record.model === undefined) return true
  if (typeof record.model !== 'object' || record.model === null || Array.isArray(record.model)) {
    return false
  }
  const model = record.model as Record<string, unknown>
  if (typeof model.id !== 'string' || typeof model.name !== 'string') return false
  if (typeof model.limit !== 'object' || model.limit === null || Array.isArray(model.limit)) {
    return false
  }
  const limit = model.limit as Record<string, unknown>
  return (
    typeof limit.context === 'number' &&
    (limit.input === undefined || typeof limit.input === 'number') &&
    (limit.output === undefined || typeof limit.output === 'number')
  )
}

const isOpenCodeQuestionReplyResult = (value: unknown): value is OpenCodeQuestionReplyResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeQuestionRejectResult = (value: unknown): value is OpenCodeQuestionRejectResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodePlanApproveResult = (value: unknown): value is OpenCodePlanApproveResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodePlanRejectResult = (value: unknown): value is OpenCodePlanRejectResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodePermissionReplyResult = (
  value: unknown
): value is OpenCodePermissionReplyResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodePermissionListResult = (value: unknown): value is OpenCodePermissionListResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    Array.isArray(record.permissions) &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeCommandApprovalReplyResult = (
  value: unknown
): value is OpenCodeCommandApprovalReplyResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeSessionInfoResult = (value: unknown): value is OpenCodeSessionInfoResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.revertMessageID === undefined ||
      record.revertMessageID === null ||
      typeof record.revertMessageID === 'string') &&
    (record.revertDiff === undefined ||
      record.revertDiff === null ||
      typeof record.revertDiff === 'string') &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeUndoResult = (value: unknown): value is OpenCodeUndoResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.revertMessageID === undefined || typeof record.revertMessageID === 'string') &&
    (record.restoredPrompt === undefined || typeof record.restoredPrompt === 'string') &&
    (record.revertDiff === undefined ||
      record.revertDiff === null ||
      typeof record.revertDiff === 'string') &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeRedoResult = (value: unknown): value is OpenCodeRedoResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.revertMessageID === undefined ||
      record.revertMessageID === null ||
      typeof record.revertMessageID === 'string') &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeCommandResult = (value: unknown): value is OpenCodeCommandResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeCommandsResult = (value: unknown): value is OpenCodeCommandsResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    Array.isArray(record.commands) &&
    record.commands.every(isOpenCodeSlashCommand) &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeSlashCommand = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.name === 'string' &&
    typeof record.template === 'string' &&
    (record.description === undefined || typeof record.description === 'string') &&
    (record.agent === undefined || typeof record.agent === 'string') &&
    (record.model === undefined || typeof record.model === 'string') &&
    (record.source === undefined || typeof record.source === 'string') &&
    (record.path === undefined || typeof record.path === 'string') &&
    (record.scope === undefined || typeof record.scope === 'string') &&
    (record.enabled === undefined || typeof record.enabled === 'boolean') &&
    (record.subtask === undefined || typeof record.subtask === 'boolean') &&
    (record.hints === undefined ||
      (Array.isArray(record.hints) && record.hints.every((hint) => typeof hint === 'string')))
  )
}

const isOpenCodeRenameSessionResult = (value: unknown): value is OpenCodeRenameSessionResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeCapabilitiesResult = (value: unknown): value is OpenCodeCapabilitiesResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.capabilities === undefined ||
      record.capabilities === null ||
      isOpenCodeCapabilities(record.capabilities)) &&
    (record.error === undefined || typeof record.error === 'string')
  )
}

const isOpenCodeCapabilities = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.supportsUndo === 'boolean' &&
    typeof record.supportsRedo === 'boolean' &&
    typeof record.supportsCommands === 'boolean' &&
    typeof record.supportsPermissionRequests === 'boolean' &&
    typeof record.supportsQuestionPrompts === 'boolean' &&
    typeof record.supportsModelSelection === 'boolean' &&
    typeof record.supportsReconnect === 'boolean' &&
    typeof record.supportsPartialStreaming === 'boolean' &&
    typeof record.supportsSteer === 'boolean'
  )
}

const isOpenCodeForkResult = (value: unknown): value is OpenCodeForkResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.success === 'boolean' &&
    (record.sessionId === undefined || typeof record.sessionId === 'string') &&
    (record.error === undefined || typeof record.error === 'string')
  )
}
