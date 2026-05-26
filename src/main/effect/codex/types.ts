import type { Exit, Schedule } from 'effect'

import type { CodexError } from './errors'
import type { CodexSdkEvent } from './schemas'

export interface CodexManagerLike {
  // EventEmitter-compatible listener typing requires `any[]`; concrete payloads are decoded by Zod.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly on: (...args: any[]) => unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly off?: (...args: any[]) => unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly removeListener?: (...args: any[]) => unknown
}

export interface SubscriptionParams {
  readonly manager: CodexManagerLike
  readonly hiveSessionId: string
  readonly threadId: string
  readonly retrySchedule?: Schedule.Schedule<unknown, unknown, never>
  readonly startup?: () => void | Promise<void>
  readonly onEvent?: (event: CodexSdkEvent) => void | Promise<void>
}

export interface SubscriptionHandle {
  readonly abort: () => Promise<void>
  readonly awaitDone: () => Promise<Exit.Exit<void, CodexError>>
}
