import type { Resolvers } from '../../__generated__/resolvers-types'

export const terminalSubscriptionResolvers: Resolvers = {
  Subscription: {
    terminalData: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: { worktreeId: string; data: string }[] = []
        let resolve: (() => void) | null = null

        const listener = (worktreeId: string, data: string) => {
          if (worktreeId !== args.worktreeId) return
          queue.push({ worktreeId, data })
          resolve?.()
        }

        ctx.eventBus.on('terminal:data', listener)
        try {
          while (true) {
            if (queue.length === 0) {
              await new Promise<void>(r => { resolve = r })
            }
            while (queue.length > 0) {
              yield { terminalData: queue.shift()! }
            }
          }
        } finally {
          ctx.eventBus.off('terminal:data', listener)
        }
      }
    },
    terminalExit: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: { worktreeId: string; code: number }[] = []
        let resolve: (() => void) | null = null

        const listener = (worktreeId: string, code: number) => {
          if (worktreeId !== args.worktreeId) return
          queue.push({ worktreeId, code })
          resolve?.()
        }

        ctx.eventBus.on('terminal:exit', listener)
        try {
          while (true) {
            if (queue.length === 0) {
              await new Promise<void>(r => { resolve = r })
            }
            while (queue.length > 0) {
              yield { terminalExit: queue.shift()! }
            }
          }
        } finally {
          ctx.eventBus.off('terminal:exit', listener)
        }
      }
    }
  }
}
