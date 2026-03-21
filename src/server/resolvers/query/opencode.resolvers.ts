/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Resolvers } from '../../__generated__/resolvers-types'
import { openCodeService } from '../../../main/services/opencode-service'
import { withSdkDispatch, mapGraphQLSdkToInternal } from '../helpers/sdk-dispatch'

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
        if (agentSdk && agentSdk !== 'opencode' && ctx.sdkManager) {
          const internalId = mapGraphQLSdkToInternal(agentSdk)
          const impl = ctx.sdkManager.getImplementer(internalId)
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
        if (agentSdk && agentSdk !== 'opencode' && ctx.sdkManager) {
          const internalId = mapGraphQLSdkToInternal(agentSdk)
          const impl = ctx.sdkManager.getImplementer(internalId)
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

    opencodeCommands: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        if (ctx.sdkManager && ctx.db && sessionId) {
          const sdkId = ctx.db.getAgentSdkForSession(sessionId)
          if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
            const impl = ctx.sdkManager.getImplementer(sdkId)
            const commands = await impl.listCommands(worktreePath)
            return { success: true, commands: commands as any[] }
          }
        }
        const commands = await openCodeService.listCommands(worktreePath)
        return { success: true, commands: commands as any[] }
      } catch (error) {
        return {
          success: false,
          commands: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeCapabilities: async (_parent, { sessionId }, ctx) => {
      try {
        if (ctx.sdkManager && ctx.db && sessionId) {
          const sdkId = ctx.db.getAgentSdkForSession(sessionId)
          if (sdkId) {
            return { success: true, capabilities: ctx.sdkManager.getCapabilities(sdkId) }
          }
        }
        const defaultCaps = ctx.sdkManager?.getCapabilities('opencode') ?? null
        return { success: true, capabilities: defaultCaps }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodePermissionList: async (_parent, { worktreePath }, ctx) => {
      try {
        const permissions = await openCodeService.permissionList(worktreePath)
        const allPermissions = [...(permissions as any[])]

        // Also collect permissions from non-OpenCode implementers
        if (ctx.sdkManager) {
          for (const sdkId of ['claude-code', 'codex'] as const) {
            try {
              const impl = ctx.sdkManager.getImplementer(sdkId)
              const sdkPerms = await impl.permissionList(worktreePath)
              allPermissions.push(...(sdkPerms as any[]))
            } catch {
              // Implementer may not exist or may throw — skip
            }
          }
        }

        return { success: true, permissions: allPermissions }
      } catch (error) {
        return {
          success: false,
          permissions: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  }
}
