import type { Resolvers } from '../../__generated__/resolvers-types'
import type { FileTreeChangeEvent } from '../../../shared/types/file-tree'

export const fileTreeSubscriptionResolvers: Resolvers = {
  Subscription: {
    fileTreeChange: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: FileTreeChangeEvent[] = []
        let resolve: (() => void) | null = null

        const listener = (event: FileTreeChangeEvent) => {
          if (args.worktreePath && event.worktreePath !== args.worktreePath) return
          queue.push(event)
          resolve?.()
        }

        ctx.eventBus.on('file-tree:change', listener)
        try {
          while (true) {
            if (queue.length === 0) {
              await new Promise<void>(r => { resolve = r })
            }
            while (queue.length > 0) {
              yield { fileTreeChange: queue.shift()! }
            }
          }
        } finally {
          ctx.eventBus.off('file-tree:change', listener)
        }
      }
    }
  }
}
