import type { Envelope } from '@shared/types/ipc-envelope'
import type { ServerEvent } from '@shared/rpc/protocol'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import { getRendererRpcClient } from './rpc-client'

type OpenCodeAgentSdk = 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal'

export type OpenCodeSetModelInput = {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly agentSdk?: OpenCodeAgentSdk
}

type OpenCodeSetModelResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodeConnectResult = {
  readonly success: boolean
  readonly sessionId?: string
  readonly error?: string
}

type OpenCodeReconnectResult = {
  readonly success: boolean
  readonly sessionStatus?: 'busy' | 'idle' | 'retry'
  readonly revertMessageID?: string | null
  readonly error?: string
}

type OpenCodePromptPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'file'
      readonly mime: string
      readonly url: string
      readonly filename?: string
    }

type OpenCodePromptModel = {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

type OpenCodePromptOptions = {
  readonly codexFastMode?: boolean
}

type OpenCodePromptResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodeAbortResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodeSteerResult = {
  readonly success: boolean
  readonly error?: string
  readonly insertedMessageId?: string
  readonly nextAssistantMessageId?: string
  readonly turnId?: string
}

type OpenCodeDisconnectResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodeGetMessagesResult = {
  readonly success: boolean
  readonly messages: unknown[]
  readonly error?: string
}

type OpenCodeRefreshFromThreadResult = {
  readonly success: boolean
  readonly count?: number
  readonly error?: string
}

type OpenCodeListModelsResult = {
  readonly success: boolean
  readonly providers: unknown
  readonly error?: string
}

type OpenCodeModelInfoResult = {
  readonly success: boolean
  readonly model?: {
    readonly id: string
    readonly name: string
    readonly limit: { readonly context: number }
  }
  readonly error?: string
}

type OpenCodeSessionInfoResult = {
  readonly success: boolean
  readonly revertMessageID?: string | null
  readonly revertDiff?: string | null
  readonly error?: string
}

type OpenCodeUndoResult = {
  readonly success: boolean
  readonly revertMessageID?: string
  readonly restoredPrompt?: string
  readonly revertDiff?: string | null
  readonly error?: string
}

type OpenCodeRedoResult = {
  readonly success: boolean
  readonly revertMessageID?: string | null
  readonly error?: string
}

type OpenCodeCommandModel = {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

type OpenCodeCommandResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodeSlashCommandInfo = {
  readonly name: string
  readonly description?: string
  readonly template: string
  readonly agent?: string
  readonly builtIn?: boolean
}

type OpenCodeCommandsResult = {
  readonly success: boolean
  readonly commands: OpenCodeSlashCommandInfo[]
  readonly error?: string
}

type OpenCodeRenameSessionResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodeForkResult = {
  readonly success: boolean
  readonly sessionId?: string
  readonly error?: string
}

type OpenCodePlanApproveResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodePlanRejectResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodeQuestionReplyResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodeQuestionRejectResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodePermissionReplyResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodePermissionListResult = {
  readonly success: boolean
  readonly permissions: unknown[]
  readonly error?: string
}

type OpenCodeCommandApprovalReplyResult = {
  readonly success: boolean
  readonly error?: string
}

type OpenCodeCapabilities = {
  readonly supportsUndo: boolean
  readonly supportsRedo: boolean
  readonly supportsPlanMode: boolean
  readonly supportsPermissionRequests: boolean
  readonly supportsQuestionPrompts: boolean
  readonly supportsModelSelection: boolean
  readonly supportsReconnect: boolean
  readonly supportsPartialStreaming: boolean
  readonly supportsSteer: boolean
}

type OpenCodeCapabilitiesResult = {
  readonly success: boolean
  readonly capabilities?: OpenCodeCapabilities | null
  readonly error?: string
}

type RendererOpenCodeStreamEvent = Omit<OpenCodeStreamEvent, 'data'> & {
  // The existing renderer stream handlers consume SDK-specific event payloads.
  // Preserve that app-code surface while the transport validates the envelope shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly data: any
}

const isOpenCodeStreamEvent = (value: unknown): value is RendererOpenCodeStreamEvent =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string' &&
  'sessionId' in value &&
  typeof value.sessionId === 'string' &&
  'data' in value

export const opencodeApi = {
  connect: async (
    worktreePath: string,
    hiveSessionId: string
  ): Promise<Envelope<OpenCodeConnectResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeConnectResult>('opencodeOps.connect', {
      worktreePath,
      hiveSessionId
    })
  }),
  reconnect: async (
    worktreePath: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ): Promise<Envelope<OpenCodeReconnectResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeReconnectResult>('opencodeOps.reconnect', {
      worktreePath,
      opencodeSessionId,
      hiveSessionId
    })
  }),
  prompt: async (
    worktreePath: string,
    opencodeSessionId: string,
    messageOrParts: string | readonly OpenCodePromptPart[],
    model?: OpenCodePromptModel,
    options?: OpenCodePromptOptions
  ): Promise<Envelope<OpenCodePromptResult>> => {
    const parts =
      typeof messageOrParts === 'string'
        ? [{ type: 'text' as const, text: messageOrParts }]
        : messageOrParts

    return {
      success: true,
      value: await getRendererRpcClient().request<OpenCodePromptResult>('opencodeOps.prompt', {
        worktreePath,
        opencodeSessionId,
        messageOrParts: parts,
        model,
        options
      })
    }
  },
  abort: async (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<Envelope<OpenCodeAbortResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeAbortResult>('opencodeOps.abort', {
      worktreePath,
      opencodeSessionId
    })
  }),
  steer: async (
    worktreePath: string,
    opencodeSessionId: string,
    message: string
  ): Promise<Envelope<OpenCodeSteerResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeSteerResult>('opencodeOps.steer', {
      worktreePath,
      opencodeSessionId,
      message
    })
  }),
  disconnect: async (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<Envelope<OpenCodeDisconnectResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeDisconnectResult>(
      'opencodeOps.disconnect',
      {
        worktreePath,
        opencodeSessionId
      }
    )
  }),
  getMessages: async (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<Envelope<OpenCodeGetMessagesResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeGetMessagesResult>(
      'opencodeOps.getMessages',
      {
        worktreePath,
        opencodeSessionId
      }
    )
  }),
  refreshFromThread: async (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<Envelope<OpenCodeRefreshFromThreadResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeRefreshFromThreadResult>(
      'opencodeOps.refreshFromThread',
      {
        worktreePath,
        opencodeSessionId
      }
    )
  }),
  listModels: async (opts?: {
    readonly agentSdk?: OpenCodeAgentSdk
  }): Promise<Envelope<OpenCodeListModelsResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeListModelsResult>(
      'opencodeOps.listModels',
      opts ?? {}
    )
  }),
  modelInfo: async (
    worktreePath: string,
    modelId: string,
    agentSdk?: OpenCodeAgentSdk
  ): Promise<Envelope<OpenCodeModelInfoResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeModelInfoResult>('opencodeOps.modelInfo', {
      worktreePath,
      modelId,
      agentSdk
    })
  }),
  sessionInfo: async (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<Envelope<OpenCodeSessionInfoResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeSessionInfoResult>(
      'opencodeOps.sessionInfo',
      {
        worktreePath,
        opencodeSessionId
      }
    )
  }),
  undo: async (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<Envelope<OpenCodeUndoResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeUndoResult>('opencodeOps.undo', {
      worktreePath,
      opencodeSessionId
    })
  }),
  redo: async (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<Envelope<OpenCodeRedoResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeRedoResult>('opencodeOps.redo', {
      worktreePath,
      opencodeSessionId
    })
  }),
  command: async (
    worktreePath: string,
    opencodeSessionId: string,
    command: string,
    args: string,
    model?: OpenCodeCommandModel
  ): Promise<Envelope<OpenCodeCommandResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeCommandResult>('opencodeOps.command', {
      worktreePath,
      opencodeSessionId,
      command,
      args,
      model
    })
  }),
  commands: async (
    worktreePath: string,
    sessionId?: string
  ): Promise<Envelope<OpenCodeCommandsResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeCommandsResult>('opencodeOps.commands', {
      worktreePath,
      sessionId
    })
  }),
  renameSession: async (
    opencodeSessionId: string,
    title: string,
    worktreePath?: string
  ): Promise<Envelope<OpenCodeRenameSessionResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeRenameSessionResult>(
      'opencodeOps.renameSession',
      {
        opencodeSessionId,
        title,
        worktreePath
      }
    )
  }),
  fork: async (
    worktreePath: string,
    opencodeSessionId: string,
    messageId?: string
  ): Promise<Envelope<OpenCodeForkResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeForkResult>('opencodeOps.fork', {
      worktreePath,
      opencodeSessionId,
      messageId
    })
  }),
  planApprove: async (
    worktreePath: string,
    hiveSessionId: string,
    requestId?: string
  ): Promise<Envelope<OpenCodePlanApproveResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodePlanApproveResult>(
      'opencodeOps.planApprove',
      {
        worktreePath,
        hiveSessionId,
        requestId
      }
    )
  }),
  planReject: async (
    worktreePath: string,
    hiveSessionId: string,
    feedback: string,
    requestId?: string
  ): Promise<Envelope<OpenCodePlanRejectResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodePlanRejectResult>(
      'opencodeOps.planReject',
      {
        worktreePath,
        hiveSessionId,
        feedback,
        requestId
      }
    )
  }),
  questionReply: async (
    requestId: string,
    answers: string[][],
    worktreePath?: string
  ): Promise<Envelope<OpenCodeQuestionReplyResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeQuestionReplyResult>(
      'opencodeOps.questionReply',
      {
        requestId,
        answers,
        worktreePath
      }
    )
  }),
  questionReject: async (
    requestId: string,
    worktreePath?: string
  ): Promise<Envelope<OpenCodeQuestionRejectResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeQuestionRejectResult>(
      'opencodeOps.questionReject',
      {
        requestId,
        worktreePath
      }
    )
  }),
  permissionReply: async (
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    worktreePath?: string,
    message?: string
  ): Promise<Envelope<OpenCodePermissionReplyResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodePermissionReplyResult>(
      'opencodeOps.permissionReply',
      {
        requestId,
        reply,
        worktreePath,
        message
      }
    )
  }),
  permissionList: async (
    worktreePath?: string
  ): Promise<Envelope<OpenCodePermissionListResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodePermissionListResult>(
      'opencodeOps.permissionList',
      {
        worktreePath
      }
    )
  }),
  commandApprovalReply: async (
    requestId: string,
    approved: boolean,
    remember?: 'allow' | 'block',
    pattern?: string,
    worktreePath?: string,
    patterns?: string[]
  ): Promise<Envelope<OpenCodeCommandApprovalReplyResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeCommandApprovalReplyResult>(
      'opencodeOps.commandApprovalReply',
      {
        requestId,
        approved,
        remember,
        pattern,
        worktreePath,
        patterns
      }
    )
  }),
  setModel: async (
    model: OpenCodeSetModelInput | null
  ): Promise<Envelope<OpenCodeSetModelResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeSetModelResult>(
      'opencodeOps.setModel',
      model
    )
  }),
  capabilities: async (
    opencodeSessionId?: string
  ): Promise<Envelope<OpenCodeCapabilitiesResult>> => ({
    success: true,
    value: await getRendererRpcClient().request<OpenCodeCapabilitiesResult>(
      'opencodeOps.capabilities',
      {
        sessionId: opencodeSessionId
      }
    )
  }),
  onStream: (callback: (event: RendererOpenCodeStreamEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(OPENCODE_STREAM_CHANNEL, (event: ServerEvent) => {
      if (isOpenCodeStreamEvent(event.payload)) callback(event.payload)
    })
}
