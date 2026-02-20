import type { Resolvers } from '../../__generated__/resolvers-types'

export const worktreeSubscriptionResolvers: Resolvers = {
  Subscription: {
    worktreeBranchRenamed: {
      subscribe: async function* (_parent, _args, ctx) {
        const queue: { worktreeId: string; newBranch: string }[] = []
        let resolve: (() => void) | null = null

        const listener = (data: { worktreeId: string; newBranch: string }) => {
          queue.push(data)
          resolve?.()
        }

        ctx.eventBus.on('worktree:branchRenamed', listener)
        try {
          while (true) {
            if (queue.length === 0) {
              await new Promise<void>(r => { resolve = r })
            }
            while (queue.length > 0) {
              yield { worktreeBranchRenamed: queue.shift()! }
            }
          }
        } finally {
          ctx.eventBus.off('worktree:branchRenamed', listener)
        }
      }
    }
  }
}
