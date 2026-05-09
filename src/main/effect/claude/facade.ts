import { Effect, Fiber, Stream } from 'effect'

import type { ClaudeError } from './errors'
import { ClaudeAgent } from './service'
import type { SubscriptionHandle, SubscriptionParams } from './types'
import { getRuntime } from './runtime'
import { withLogComponent } from '../_shared/logger'

const tagged = <A, E>(effect: Effect.Effect<A, E, ClaudeAgent>) =>
  effect.pipe(withLogComponent('ClaudeAgentEffectIsland'))

class ClaudeAgentFacade {
  startSessionEvents(params: SubscriptionParams): SubscriptionHandle {
    const program = Effect.gen(function* () {
      const agent = yield* ClaudeAgent
      yield* Stream.runForEach(agent.sessionEvents(params), () => Effect.void)
    })
    const fiber = getRuntime().runFork(tagged(program))
    return {
      abort: () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid)),
      awaitDone: () => Effect.runPromise(Fiber.await(fiber)) as Promise<never>
    } as SubscriptionHandle
  }
}

export const claudeAgentFacade = new ClaudeAgentFacade()
export type { ClaudeError, SubscriptionHandle, SubscriptionParams }
