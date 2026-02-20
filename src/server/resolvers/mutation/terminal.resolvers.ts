import type { Resolvers } from '../../__generated__/resolvers-types'
import { ptyService } from '../../../main/services/pty-service'
import { getEventBus } from '../../event-bus'

export const terminalMutationResolvers: Resolvers = {
  Mutation: {
    terminalCreate: async (_parent, { worktreeId, cwd, shell }, _ctx) => {
      try {
        const { cols, rows } = ptyService.create(worktreeId, {
          cwd,
          shell: shell || undefined
        })

        // Wire PTY output to EventBus for GraphQL subscriptions.
        // In the desktop app, terminal-handlers.ts wires ptyService.onData
        // -> webContents.send + EventBus. For headless-only terminals
        // (created via GraphQL), we wire directly to EventBus here.
        ptyService.onData(worktreeId, (data) => {
          try {
            getEventBus().emit('terminal:data', worktreeId, data)
          } catch {
            /* EventBus not available */
          }
        })
        ptyService.onExit(worktreeId, (code) => {
          try {
            getEventBus().emit('terminal:exit', worktreeId, code)
          } catch {
            /* EventBus not available */
          }
        })

        return { success: true, cols, rows }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    terminalWrite: async (_parent, { worktreeId, data }, _ctx) => {
      try {
        // ptyService.write is synchronous
        // (same as ipcMain.on('terminal:write') — fire-and-forget)
        ptyService.write(worktreeId, data)
        return true
      } catch {
        return false
      }
    },

    terminalResize: async (_parent, { worktreeId, cols, rows }, _ctx) => {
      try {
        ptyService.resize(worktreeId, cols, rows)
        return true
      } catch {
        return false
      }
    },

    terminalDestroy: async (_parent, { worktreeId }, _ctx) => {
      try {
        ptyService.destroy(worktreeId)
        return true
      } catch {
        return false
      }
    }
  }
}
