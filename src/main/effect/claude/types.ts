import type { Exit, Schedule } from 'effect'

import type { ClaudeError } from './errors'
import type { ClaudeSdkMessage } from './schemas'

export interface CloseableAsyncIterable extends AsyncIterable<unknown> {
  readonly next?: (...args: ReadonlyArray<unknown>) => Promise<IteratorResult<unknown, void>>
  readonly return?: (value?: void) => Promise<IteratorResult<unknown, void>>
  readonly close?: () => void
}

export interface SubscriptionParams {
  readonly hiveSessionId: string
  readonly queryIterator?: CloseableAsyncIterable
  readonly connect?: () => CloseableAsyncIterable | Promise<CloseableAsyncIterable>
  readonly retrySchedule?: Schedule.Schedule<unknown, unknown, never>
  readonly onMessage?: (message: ClaudeSdkMessage) => void | Promise<void>
}

export interface SubscriptionHandle {
  readonly abort: () => Promise<void>
  readonly awaitDone: () => Promise<Exit.Exit<void, ClaudeError>>
}
