import type { Resolvers } from '../../__generated__/resolvers-types'
import { openCodeService } from '../../../main/services/opencode-service'
import { withSdkDispatch } from '../helpers/sdk-dispatch'

export const opencodeQueryResolvers: Resolvers = {
  Query: {
    opencodeMessages: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const messages = await withSdkDispatch(
          ctx,
          sessionId,
          () => openCodeService.getMessages(worktreePath, sessionId),
          (impl) => impl.getMessages(worktreePath, sessionId)
        )
        return { success: true, messages }
      } catch (error) {
        return {
          success: false,
          messages: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeSessionInfo: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const result = await withSdkDispatch(
          ctx,
          sessionId,
          () => openCodeService.getSessionInfo(worktreePath, sessionId),
          (impl) => impl.getSessionInfo(worktreePath, sessionId)
        )
        return {
          success: true,
          revertMessageID: result.revertMessageID,
          revertDiff: result.revertDiff
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeModels: async (_parent, { agentSdk }, ctx) => {
      try {
        if (agentSdk === 'claude_code' && ctx.sdkManager) {
          const impl = ctx.sdkManager.getImplementer('claude-code')
          const providers = await impl.getAvailableModels()
          return { success: true, providers }
        }
        const providers = await openCodeService.getAvailableModels()
        return { success: true, providers }
      } catch (error) {
        return {
          success: false,
          providers: {},
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeModelInfo: async (_parent, { worktreePath, modelId, agentSdk }, ctx) => {
      try {
        if (agentSdk === 'claude_code' && ctx.sdkManager) {
          const impl = ctx.sdkManager.getImplementer('claude-code')
          const model = await impl.getModelInfo(worktreePath, modelId)
          if (!model) return { success: false, error: 'Model not found' }
          return { success: true, model }
        }
        const model = await openCodeService.getModelInfo(worktreePath, modelId)
        if (!model) return { success: false, error: 'Model not found' }
        return { success: true, model }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
  }
}
