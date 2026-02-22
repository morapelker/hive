import type { Resolvers } from '../../__generated__/resolvers-types'
import type { ScriptOutputEvent } from '../../../shared/types/script'

export const scriptSubscriptionResolvers: Resolvers = {
  Subscription: {
    scriptOutput: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: ScriptOutputEvent[] = []
        let resolve: (() => void) | null = null

        const listener = (channel: string, event: ScriptOutputEvent) => {
          if (channel !== args.channel) return
          queue.push(event)
          resolve?.()
        }

        ctx.eventBus.on('script:output', listener)
        try {
          while (true) {
            if (queue.length === 0) {
              await new Promise<void>(r => { resolve = r })
            }
            while (queue.length > 0) {
              yield { scriptOutput: queue.shift()! }
            }
          }
        } finally {
          ctx.eventBus.off('script:output', listener)
        }
      }
    }
  }
}
