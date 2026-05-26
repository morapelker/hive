import { Data } from 'effect'
import type { z } from 'zod'

export class CodexConnectionFailed extends Data.TaggedError('CodexConnectionFailed')<{
  readonly cause: unknown
}> {}

export class CodexStreamInterrupted extends Data.TaggedError('CodexStreamInterrupted')<{
  readonly cause: unknown
}> {}

export class CodexPayloadInvalid extends Data.TaggedError('CodexPayloadInvalid')<{
  readonly schemaName: string
  readonly issues: readonly z.ZodIssue[]
}> {}

export class CodexSessionMissing extends Data.TaggedError('CodexSessionMissing')<{
  readonly threadId: string
}> {}

export type CodexError =
  | CodexConnectionFailed
  | CodexStreamInterrupted
  | CodexPayloadInvalid
  | CodexSessionMissing
