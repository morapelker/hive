import { Data, Effect } from 'effect'

export class IpcError extends Data.TaggedError('IpcError')<{
  readonly errorCode: string
  readonly error: string
  readonly details?: unknown
}> {}

export const catchIpcCode =
  <B, E2, R2>(
    code: string,
    recover: (error: IpcError) => Effect.Effect<B, E2, R2>
  ) =>
  <A, E extends { readonly _tag: string }, R>(
    self: Effect.Effect<A, IpcError | E, R>
  ): Effect.Effect<A | B, IpcError | E | E2, R | R2> =>
    self.pipe(
      Effect.catchTag('IpcError', (error): Effect.Effect<B, E2 | IpcError, R2> =>
        error.errorCode === code ? recover(error) : Effect.fail(error)
      )
    )
