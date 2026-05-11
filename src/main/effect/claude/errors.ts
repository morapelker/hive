import { Data } from 'effect'
import type { z } from 'zod'

export class ClaudeConnectionFailed extends Data.TaggedError('ClaudeConnectionFailed')<{
  readonly cause: unknown
}> {}

export class ClaudeStreamInterrupted extends Data.TaggedError('ClaudeStreamInterrupted')<{
  readonly cause: unknown
}> {}

export class ClaudePayloadInvalid extends Data.TaggedError('ClaudePayloadInvalid')<{
  readonly schemaName: string
  readonly issues: readonly z.ZodIssue[]
}> {}

export class ClaudeSessionMissing extends Data.TaggedError('ClaudeSessionMissing')<{
  readonly sessionId: string
}> {}

export type ClaudeError =
  | ClaudeConnectionFailed
  | ClaudeStreamInterrupted
  | ClaudePayloadInvalid
  | ClaudeSessionMissing
