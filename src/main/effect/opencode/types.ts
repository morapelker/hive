import type { Exit, Schedule } from 'effect'

import type { OpenCodeError } from './errors'
import type { OpenCodeSdkEvent } from './schemas'

export interface OpenCodeSubscriptionResult {
  readonly stream: AsyncIterable<unknown>
  readonly unsubscribe?: () => void
}

export interface OpenCodeClientLike {
  readonly event: {
    readonly subscribe: (params: {
      readonly signal?: AbortSignal
      readonly query: { readonly directory: string }
    }) => Promise<OpenCodeSubscriptionResult>
  }
}

export interface SubscriptionParams {
  readonly client: OpenCodeClientLike
  readonly directory: string
  readonly hiveSessionId: string
  readonly retrySchedule?: Schedule.Schedule<unknown, unknown, never>
  readonly onEvent?: (event: OpenCodeSdkEvent, directory: string) => void | Promise<void>
}

export interface SubscriptionHandle {
  readonly abort: () => Promise<void>
  readonly awaitDone: () => Promise<Exit.Exit<void, OpenCodeError>>
}
