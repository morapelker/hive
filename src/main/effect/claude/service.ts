import { Context, Effect, Stream } from 'effect'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

import type { ClaudeError } from './errors'
import type { SubscriptionParams } from './types'

export class EventBus extends Context.Tag('Agents/Claude/EventBus')<
  EventBus,
  {
    readonly publish: (event: OpenCodeStreamEvent) => Effect.Effect<void>
  }
>() {}

export class ClaudeAgent extends Context.Tag('Agents/Claude')<
  ClaudeAgent,
  {
    readonly sessionEvents: (params: SubscriptionParams) => Stream.Stream<void, ClaudeError, never>
  }
>() {}
