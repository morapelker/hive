import { Context, Effect, Stream } from 'effect'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

import type { CodexError } from './errors'
import type { SubscriptionParams } from './types'

export class EventBus extends Context.Tag('Agents/Codex/EventBus')<
  EventBus,
  {
    readonly publish: (event: OpenCodeStreamEvent) => Effect.Effect<void>
  }
>() {}

export class CodexAgent extends Context.Tag('Agents/Codex')<
  CodexAgent,
  {
    readonly sessionEvents: (params: SubscriptionParams) => Stream.Stream<void, CodexError, never>
  }
>() {}
