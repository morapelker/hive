import { Context, Effect, Stream } from 'effect'

import type { OpenCodeError } from './errors'
import type { SubscriptionParams } from './types'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

export class EventBus extends Context.Tag('Agents/OpenCode/EventBus')<
  EventBus,
  {
    readonly publish: (event: OpenCodeStreamEvent) => Effect.Effect<void>
  }
>() {}

export class OpenCodeAgent extends Context.Tag('Agents/OpenCode')<
  OpenCodeAgent,
  {
    readonly sessionEvents: (
      params: SubscriptionParams
    ) => Stream.Stream<void, OpenCodeError, never>
  }
>() {}
