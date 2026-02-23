import type { Resolvers } from '../../__generated__/resolvers-types'
import type { OpenCodeStreamEvent } from '../../../shared/types/opencode'

export const opencodeSubscriptionResolvers: Resolvers = {
  Subscription: {
    opencodeStream: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: OpenCodeStreamEvent[] = []
        let resolve: (() => void) | null = null
        let batchTimer: ReturnType<typeof setTimeout> | null = null
        const BATCH_MS = 50
        const sessionFilter = args.sessionIds
          ? new Set(args.sessionIds)
          : null

        const flush = () => {
          batchTimer = null
          resolve?.()
        }

        const listener = (event: OpenCodeStreamEvent) => {
          if (sessionFilter && !sessionFilter.has(event.sessionId)) return
          queue.push(event)
          if (!batchTimer) {
            batchTimer = setTimeout(flush, BATCH_MS)
          }
        }

        ctx.eventBus.on('opencode:stream', listener)
        try {
          while (true) {
            if (queue.length === 0) {
              await new Promise<void>(r => { resolve = r })
            }
            while (queue.length > 0) {
              yield { opencodeStream: queue.shift()! }
            }
          }
        } finally {
          if (batchTimer) clearTimeout(batchTimer)
          ctx.eventBus.off('opencode:stream', listener)
        }
      }
    }
  }
}
