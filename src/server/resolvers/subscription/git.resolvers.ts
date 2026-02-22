import type { Resolvers } from '../../__generated__/resolvers-types'

export const gitSubscriptionResolvers: Resolvers = {
  Subscription: {
    gitStatusChanged: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: { worktreePath: string }[] = []
        let resolve: (() => void) | null = null

        const listener = (data: { worktreePath: string }) => {
          if (args.worktreePath && data.worktreePath !== args.worktreePath) return
          queue.push(data)
          resolve?.()
        }

        ctx.eventBus.on('git:statusChanged', listener)
        try {
          while (true) {
            if (queue.length === 0) {
              await new Promise<void>(r => { resolve = r })
            }
            while (queue.length > 0) {
              yield { gitStatusChanged: queue.shift()! }
            }
          }
        } finally {
          ctx.eventBus.off('git:statusChanged', listener)
        }
      }
    },
    gitBranchChanged: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: { worktreePath: string }[] = []
        let resolve: (() => void) | null = null

        const listener = (data: { worktreePath: string }) => {
          if (args.worktreePath && data.worktreePath !== args.worktreePath) return
          queue.push(data)
          resolve?.()
        }

        ctx.eventBus.on('git:branchChanged', listener)
        try {
          while (true) {
            if (queue.length === 0) {
              await new Promise<void>(r => { resolve = r })
            }
            while (queue.length > 0) {
              yield { gitBranchChanged: queue.shift()! }
            }
          }
        } finally {
          ctx.eventBus.off('git:branchChanged', listener)
        }
      }
    }
  }
}
