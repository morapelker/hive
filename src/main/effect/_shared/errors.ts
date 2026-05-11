import { Data } from 'effect'
import type { z } from 'zod'

export class ZodDecodeError extends Data.TaggedError('ZodDecodeError')<{
  readonly issues: readonly z.ZodIssue[]
  readonly schemaName?: string
}> {}

export class IpcSerializationError extends Data.TaggedError('IpcSerializationError')<{
  readonly channel: string
  readonly cause: unknown
}> {}

export class TimeoutError extends Data.TaggedError('TimeoutError')<{
  readonly operation: string
  readonly durationMs: number
}> {}

export class CancelledError extends Data.TaggedError('CancelledError')<{
  readonly operation?: string
}> {}

export class UnexpectedDefect extends Data.TaggedError('UnexpectedDefect')<{
  readonly cause: unknown
}> {}
