import { Data } from 'effect'
import type { z } from 'zod'

export class OpenCodeConnectionFailed extends Data.TaggedError('OpenCodeConnectionFailed')<{
  readonly directory: string
  readonly cause: unknown
}> {}

export class OpenCodeStreamInterrupted extends Data.TaggedError('OpenCodeStreamInterrupted')<{
  readonly directory: string
  readonly cause: unknown
}> {}

export class OpenCodePayloadInvalid extends Data.TaggedError('OpenCodePayloadInvalid')<{
  readonly schemaName: string
  readonly issues: readonly z.ZodIssue[]
}> {}

export class OpenCodeSessionMissing extends Data.TaggedError('OpenCodeSessionMissing')<{
  readonly sessionId: string
}> {}

export class OpenCodeWindowMissing extends Data.TaggedError('OpenCodeWindowMissing')<{
  readonly reason: 'not-set' | 'destroyed'
}> {}

export type OpenCodeError =
  | OpenCodeConnectionFailed
  | OpenCodeStreamInterrupted
  | OpenCodePayloadInvalid
  | OpenCodeSessionMissing
  | OpenCodeWindowMissing
