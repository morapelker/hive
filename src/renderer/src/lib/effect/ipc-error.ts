import { Data, Effect } from 'effect'

export class IpcError extends Data.TaggedError('IpcError')<{
  readonly errorCode: string
  readonly error: string
  readonly details?: unknown
}> {}

export const catchIpcCode =
  <A, R, B, E2, R2>(
    code: string,
    recover: (error: IpcError) => Effect.Effect<B, E2, R2>
  ) =>
  (self: Effect.Effect<A, IpcError, R>): Effect.Effect<A | B, E2 | IpcError, R | R2> =>
    self.pipe(
      Effect.catchTag('IpcError', (error: IpcError): Effect.Effect<B, E2 | IpcError, R2> =>
        error.errorCode === code ? recover(error) : Effect.fail(error)
      )
    )
