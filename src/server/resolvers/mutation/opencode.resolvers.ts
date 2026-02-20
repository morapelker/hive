import type { Resolvers } from '../../__generated__/resolvers-types'
import { openCodeService } from '../../../main/services/opencode-service'
import { withSdkDispatch, withSdkDispatchByHiveSession } from '../helpers/sdk-dispatch'

export const opencodeMutationResolvers: Resolvers = {
  Mutation: {
    opencodeConnect: async (_parent, { worktreePath, hiveSessionId }, ctx) => {
      try {
        const result = await withSdkDispatchByHiveSession(
          ctx,
          hiveSessionId,
          () => openCodeService.connect(worktreePath, hiveSessionId),
          (impl) => impl.connect(worktreePath, hiveSessionId)
        )
        return { success: true, sessionId: result.sessionId }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeReconnect: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, opencodeSessionId, hiveSessionId } = input
        const result = await withSdkDispatch(
          ctx,
          opencodeSessionId,
          () => openCodeService.reconnect(worktreePath, opencodeSessionId, hiveSessionId),
          (impl) => impl.reconnect(worktreePath, opencodeSessionId, hiveSessionId)
        )
        return {
          success: result.success ?? true,
          sessionStatus: result.sessionStatus ?? null,
          revertMessageID: result.revertMessageID ?? null
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeDisconnect: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        await withSdkDispatch(
          ctx,
          sessionId,
          () => openCodeService.disconnect(worktreePath, sessionId),
          (impl) => impl.disconnect(worktreePath, sessionId)
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodePrompt: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, opencodeSessionId, message, parts, model } = input
        const messageParts = parts ?? [{ type: 'text', text: message ?? '' }]
        await withSdkDispatch(
          ctx,
          opencodeSessionId,
          () => openCodeService.prompt(worktreePath, opencodeSessionId, messageParts, model),
          (impl) => impl.prompt(worktreePath, opencodeSessionId, messageParts, model)
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeAbort: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const result = await withSdkDispatch(
          ctx,
          sessionId,
          () => openCodeService.abort(worktreePath, sessionId),
          (impl) => impl.abort(worktreePath, sessionId)
        )
        return { success: result }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
  }
}
