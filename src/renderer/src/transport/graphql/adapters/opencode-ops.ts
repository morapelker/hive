import { graphqlQuery, graphqlSubscribe } from '../client'
import type { OpenCodeOpsApi } from '../../types'

export function createOpenCodeOpsAdapter(): OpenCodeOpsApi {
  return {
    async connect(
      worktreePath: string,
      hiveSessionId: string
    ): Promise<{ success: boolean; sessionId?: string; error?: string }> {
      const data = await graphqlQuery<{
        opencodeConnect: { success: boolean; sessionId?: string; error?: string }
      }>(
        `mutation ($worktreePath: String!, $hiveSessionId: ID!) {
          opencodeConnect(worktreePath: $worktreePath, hiveSessionId: $hiveSessionId) {
            success sessionId error
          }
        }`,
        { worktreePath, hiveSessionId }
      )
      return data.opencodeConnect
    },

    async reconnect(
      worktreePath: string,
      opencodeSessionId: string,
      hiveSessionId: string
    ): Promise<{
      success: boolean
      sessionStatus?: 'idle' | 'busy' | 'retry'
      revertMessageID?: string | null
    }> {
      const data = await graphqlQuery<{
        opencodeReconnect: {
          success: boolean
          sessionStatus?: string
          revertMessageID?: string
          error?: string
        }
      }>(
        `mutation ($input: OpenCodeReconnectInput!) {
          opencodeReconnect(input: $input) {
            success sessionStatus revertMessageID error
          }
        }`,
        {
          input: {
            worktreePath,
            opencodeSessionId,
            hiveSessionId
          }
        }
      )
      const r = data.opencodeReconnect
      return {
        success: r.success,
        sessionStatus: r.sessionStatus as 'idle' | 'busy' | 'retry' | undefined,
        revertMessageID: r.revertMessageID ?? null
      }
    },

    async prompt(
      worktreePath: string,
      opencodeSessionId: string,
      messageOrParts: string | MessagePart[],
      model?: { providerID: string; modelID: string; variant?: string },
      _options?: { codexFastMode?: boolean },
      agent?: string
    ): Promise<{ success: boolean; error?: string }> {
      const input: Record<string, unknown> = {
        worktreePath,
        opencodeSessionId
      }
      if (typeof messageOrParts === 'string') {
        input.message = messageOrParts
      } else {
        input.parts = messageOrParts
      }
      if (model) {
        input.model = model
      }
      if (agent) {
        input.agent = agent
      }

      const data = await graphqlQuery<{
        opencodePrompt: { success: boolean; error?: string }
      }>(
        `mutation ($input: OpenCodePromptInput!) {
          opencodePrompt(input: $input) { success error }
        }`,
        { input }
      )
      return data.opencodePrompt
    },

    async abort(
      worktreePath: string,
      opencodeSessionId: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        opencodeAbort: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $sessionId: String!) {
          opencodeAbort(worktreePath: $worktreePath, sessionId: $sessionId) { success error }
        }`,
        { worktreePath, sessionId: opencodeSessionId }
      )
      return data.opencodeAbort
    },

    async disconnect(
      worktreePath: string,
      opencodeSessionId: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        opencodeDisconnect: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $sessionId: String!) {
          opencodeDisconnect(worktreePath: $worktreePath, sessionId: $sessionId) { success error }
        }`,
        { worktreePath, sessionId: opencodeSessionId }
      )
      return data.opencodeDisconnect
    },

    async getMessages(
      worktreePath: string,
      opencodeSessionId: string
    ): Promise<{ success: boolean; messages: unknown[]; error?: string }> {
      const data = await graphqlQuery<{
        opencodeMessages: { success: boolean; messages: unknown; error?: string }
      }>(
        `query ($worktreePath: String!, $sessionId: String!) {
          opencodeMessages(worktreePath: $worktreePath, sessionId: $sessionId) {
            success messages error
          }
        }`,
        { worktreePath, sessionId: opencodeSessionId }
      )
      const r = data.opencodeMessages
      // messages comes as JSON scalar; ensure it's an array
      const messages = Array.isArray(r.messages) ? r.messages : []
      return { success: r.success, messages, error: r.error ?? undefined }
    },

    async listModels(opts?: {
      agentSdk?: 'opencode' | 'claude-code' | 'codex' | 'terminal'
    }): Promise<{
      success: boolean
      providers: Record<string, unknown>
      error?: string
    }> {
      const agentSdk = opts?.agentSdk
        ? opts.agentSdk === 'claude-code'
          ? 'claude_code'
          : opts.agentSdk
        : undefined
      const data = await graphqlQuery<{
        opencodeModels: { success: boolean; providers: unknown; error?: string }
      }>(
        `query ($agentSdk: AgentSdk) {
          opencodeModels(agentSdk: $agentSdk) { success providers error }
        }`,
        { agentSdk }
      )
      const r = data.opencodeModels
      const providers =
        typeof r.providers === 'object' && r.providers !== null
          ? (r.providers as Record<string, unknown>)
          : {}
      return { success: r.success, providers, error: r.error ?? undefined }
    },

    async setModel(model: {
      providerID: string
      modelID: string
      variant?: string
      agentSdk?: 'opencode' | 'claude-code' | 'codex' | 'terminal'
    }): Promise<{ success: boolean; error?: string }> {
      const input: Record<string, unknown> = {
        providerID: model.providerID,
        modelID: model.modelID
      }
      if (model.variant !== undefined) input.variant = model.variant
      if (model.agentSdk) {
        input.agentSdk = model.agentSdk === 'claude-code' ? 'claude_code' : model.agentSdk
      }

      const data = await graphqlQuery<{
        opencodeSetModel: { success: boolean; error?: string }
      }>(
        `mutation ($input: SetModelInput!) {
          opencodeSetModel(input: $input) { success error }
        }`,
        { input }
      )
      return data.opencodeSetModel
    },

    async modelInfo(
      worktreePath: string,
      modelId: string,
      agentSdk?: 'opencode' | 'claude-code' | 'codex' | 'terminal'
    ): Promise<{
      success: boolean
      model?: { id: string; name: string; limit: { context: number } }
      error?: string
    }> {
      const sdk = agentSdk ? (agentSdk === 'claude-code' ? 'claude_code' : agentSdk) : undefined
      const data = await graphqlQuery<{
        opencodeModelInfo: { success: boolean; model: unknown; error?: string }
      }>(
        `query ($worktreePath: String!, $modelId: String!, $agentSdk: AgentSdk) {
          opencodeModelInfo(worktreePath: $worktreePath, modelId: $modelId, agentSdk: $agentSdk) {
            success model error
          }
        }`,
        { worktreePath, modelId, agentSdk: sdk }
      )
      const r = data.opencodeModelInfo
      return {
        success: r.success,
        model: r.model as { id: string; name: string; limit: { context: number } } | undefined,
        error: r.error ?? undefined
      }
    },

    async questionReply(
      requestId: string,
      answers: string[][],
      worktreePath?: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        opencodeQuestionReply: { success: boolean; error?: string }
      }>(
        `mutation ($input: QuestionReplyInput!) {
          opencodeQuestionReply(input: $input) { success error }
        }`,
        {
          input: {
            requestId,
            answers,
            worktreePath
          }
        }
      )
      return data.opencodeQuestionReply
    },

    async questionReject(
      requestId: string,
      worktreePath?: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        opencodeQuestionReject: { success: boolean; error?: string }
      }>(
        `mutation ($requestId: String!, $worktreePath: String) {
          opencodeQuestionReject(requestId: $requestId, worktreePath: $worktreePath) { success error }
        }`,
        { requestId, worktreePath }
      )
      return data.opencodeQuestionReject
    },

    async planApprove(
      worktreePath: string,
      hiveSessionId: string,
      requestId?: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        opencodePlanApprove: { success: boolean; error?: string }
      }>(
        `mutation ($input: PlanApproveInput!) {
          opencodePlanApprove(input: $input) { success error }
        }`,
        {
          input: { worktreePath, hiveSessionId, requestId }
        }
      )
      return data.opencodePlanApprove
    },

    async planReject(
      worktreePath: string,
      hiveSessionId: string,
      feedback: string,
      requestId?: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        opencodePlanReject: { success: boolean; error?: string }
      }>(
        `mutation ($input: PlanRejectInput!) {
          opencodePlanReject(input: $input) { success error }
        }`,
        {
          input: { worktreePath, hiveSessionId, feedback, requestId }
        }
      )
      return data.opencodePlanReject
    },

    async permissionReply(
      requestId: string,
      reply: 'once' | 'always' | 'reject',
      worktreePath?: string,
      message?: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        opencodePermissionReply: { success: boolean; error?: string }
      }>(
        `mutation ($input: PermissionReplyInput!) {
          opencodePermissionReply(input: $input) { success error }
        }`,
        {
          input: { requestId, reply, worktreePath, message }
        }
      )
      return data.opencodePermissionReply
    },

    async permissionList(
      worktreePath?: string
    ): Promise<{ success: boolean; permissions: PermissionRequest[]; error?: string }> {
      const data = await graphqlQuery<{
        opencodePermissionList: {
          success: boolean
          permissions: Array<{
            id: string
            sessionID: string
            permission: string
            patterns: string[]
            metadata: unknown
            always: string[]
            tool: { messageID: string; callID: string } | null
          }>
          error?: string
        }
      }>(
        `query ($worktreePath: String) {
          opencodePermissionList(worktreePath: $worktreePath) {
            success error
            permissions {
              id sessionID permission patterns metadata always
              tool { messageID callID }
            }
          }
        }`,
        { worktreePath }
      )
      const r = data.opencodePermissionList
      return {
        success: r.success,
        permissions: r.permissions.map((p) => ({
          ...p,
          metadata: (p.metadata || {}) as Record<string, unknown>,
          tool: p.tool ?? undefined
        })),
        error: r.error ?? undefined
      }
    },

    async commandApprovalReply(
      requestId: string,
      approved: boolean,
      remember?: 'allow' | 'block',
      pattern?: string,
      worktreePath?: string,
      _patterns?: string[]
    ): Promise<{ success: boolean; error?: string }> {
      // The GraphQL CommandApprovalReplyInput takes {worktreePath, hiveSessionId, requestId, approved}
      // We map what we can; hiveSessionId is not available at this layer, pass empty string
      void remember
      void pattern
      const data = await graphqlQuery<{
        opencodeCommandApprovalReply: { success: boolean; error?: string }
      }>(
        `mutation ($input: CommandApprovalReplyInput!) {
          opencodeCommandApprovalReply(input: $input) { success error }
        }`,
        {
          input: {
            worktreePath: worktreePath || '',
            hiveSessionId: '',
            requestId,
            approved
          }
        }
      )
      return data.opencodeCommandApprovalReply
    },

    async sessionInfo(
      worktreePath: string,
      opencodeSessionId: string
    ): Promise<{
      success: boolean
      revertMessageID?: string | null
      revertDiff?: string | null
      error?: string
    }> {
      const data = await graphqlQuery<{
        opencodeSessionInfo: {
          success: boolean
          revertMessageID?: string
          revertDiff?: string
          error?: string
        }
      }>(
        `query ($worktreePath: String!, $sessionId: String!) {
          opencodeSessionInfo(worktreePath: $worktreePath, sessionId: $sessionId) {
            success revertMessageID revertDiff error
          }
        }`,
        { worktreePath, sessionId: opencodeSessionId }
      )
      return data.opencodeSessionInfo
    },

    async undo(
      worktreePath: string,
      opencodeSessionId: string
    ): Promise<{
      success: boolean
      revertMessageID?: string
      restoredPrompt?: string
      revertDiff?: string | null
      error?: string
    }> {
      const data = await graphqlQuery<{
        opencodeUndo: {
          success: boolean
          revertMessageID?: string
          restoredPrompt?: string
          revertDiff?: string
          error?: string
        }
      }>(
        `mutation ($worktreePath: String!, $sessionId: String!) {
          opencodeUndo(worktreePath: $worktreePath, sessionId: $sessionId) {
            success revertMessageID restoredPrompt revertDiff error
          }
        }`,
        { worktreePath, sessionId: opencodeSessionId }
      )
      return data.opencodeUndo
    },

    async redo(
      worktreePath: string,
      opencodeSessionId: string
    ): Promise<{ success: boolean; revertMessageID?: string | null; error?: string }> {
      const data = await graphqlQuery<{
        opencodeRedo: { success: boolean; revertMessageID?: string; error?: string }
      }>(
        `mutation ($worktreePath: String!, $sessionId: String!) {
          opencodeRedo(worktreePath: $worktreePath, sessionId: $sessionId) {
            success revertMessageID error
          }
        }`,
        { worktreePath, sessionId: opencodeSessionId }
      )
      return data.opencodeRedo
    },

    async command(
      worktreePath: string,
      opencodeSessionId: string,
      command: string,
      args: string,
      model?: { providerID: string; modelID: string; variant?: string }
    ): Promise<{ success: boolean; error?: string }> {
      const input: Record<string, unknown> = {
        worktreePath,
        opencodeSessionId,
        command,
        args
      }
      if (model) input.model = model

      const data = await graphqlQuery<{
        opencodeCommand: { success: boolean; error?: string }
      }>(
        `mutation ($input: OpenCodeCommandInput!) {
          opencodeCommand(input: $input) { success error }
        }`,
        { input }
      )
      return data.opencodeCommand
    },

    async commands(
      worktreePath: string,
      sessionId?: string
    ): Promise<{ success: boolean; commands: OpenCodeCommand[]; error?: string }> {
      const data = await graphqlQuery<{
        opencodeCommands: {
          success: boolean
          commands: OpenCodeCommand[]
          error?: string
        }
      }>(
        `query ($worktreePath: String!, $sessionId: String) {
          opencodeCommands(worktreePath: $worktreePath, sessionId: $sessionId) {
            success error
            commands { name description template agent model source subtask hints }
          }
        }`,
        { worktreePath, sessionId }
      )
      return data.opencodeCommands
    },

    async renameSession(
      opencodeSessionId: string,
      title: string,
      worktreePath?: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        opencodeRenameSession: { success: boolean; error?: string }
      }>(
        `mutation ($input: RenameSessionInput!) {
          opencodeRenameSession(input: $input) { success error }
        }`,
        {
          input: { opencodeSessionId, title, worktreePath }
        }
      )
      return data.opencodeRenameSession
    },

    async capabilities(opencodeSessionId?: string): Promise<{
      success: boolean
      capabilities?: {
        supportsUndo: boolean
        supportsRedo: boolean
        supportsCommands: boolean
        supportsPermissionRequests: boolean
        supportsQuestionPrompts: boolean
        supportsModelSelection: boolean
        supportsReconnect: boolean
        supportsPartialStreaming: boolean
      }
      error?: string
    }> {
      const data = await graphqlQuery<{
        opencodeCapabilities: {
          success: boolean
          capabilities: {
            supportsUndo: boolean
            supportsRedo: boolean
            supportsCommands: boolean
            supportsPermissionRequests: boolean
            supportsQuestionPrompts: boolean
            supportsModelSelection: boolean
            supportsReconnect: boolean
            supportsPartialStreaming: boolean
          } | null
          error?: string
        }
      }>(
        `query ($sessionId: String) {
          opencodeCapabilities(sessionId: $sessionId) {
            success error
            capabilities {
              supportsUndo supportsRedo supportsCommands
              supportsPermissionRequests supportsQuestionPrompts
              supportsModelSelection supportsReconnect supportsPartialStreaming
            }
          }
        }`,
        { sessionId: opencodeSessionId }
      )
      const r = data.opencodeCapabilities
      return {
        success: r.success,
        capabilities: r.capabilities ?? undefined,
        error: r.error ?? undefined
      }
    },

    async fork(
      worktreePath: string,
      opencodeSessionId: string,
      messageId?: string
    ): Promise<{ success: boolean; sessionId?: string; error?: string }> {
      const data = await graphqlQuery<{
        opencodeFork: { success: boolean; sessionId?: string; error?: string }
      }>(
        `mutation ($input: ForkSessionInput!) {
          opencodeFork(input: $input) { success sessionId error }
        }`,
        {
          input: { worktreePath, opencodeSessionId, messageId }
        }
      )
      return data.opencodeFork
    },

    async listAgents(opts?: { worktreePath?: string }): Promise<{
      success: boolean
      agents: Array<{ name: string; description?: string; mode: string }>
      error?: string
    }> {
      const data = await graphqlQuery<{
        opencodeAgents: {
          success: boolean
          agents: Array<{ name: string; description?: string; mode: string }>
          error?: string
        }
      }>(
        `query ($worktreePath: String) {
          opencodeAgents(worktreePath: $worktreePath) {
            success error
            agents { name description mode }
          }
        }`,
        { worktreePath: opts?.worktreePath }
      )
      const r = data.opencodeAgents
      return {
        success: r.success,
        agents: r.agents ?? [],
        error: r.error ?? undefined
      }
    },

    // ─── Stream subscription (CRITICAL) ─────────────────────────
    onStream(callback: (event: OpenCodeStreamEvent) => void): () => void {
      return graphqlSubscribe<{ opencodeStream: OpenCodeStreamEvent }>(
        `subscription ($sessionIds: [String!]) {
          opencodeStream(sessionIds: $sessionIds) {
            type sessionId data childSessionId
            statusPayload { type attempt message next }
          }
        }`,
        undefined,
        (data) => {
          callback(data.opencodeStream)
        }
      )
    }
  }
}
