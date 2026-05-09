import { Data, Effect } from 'effect'

export class IpcError extends Data.TaggedError('IpcError')<{
  readonly errorCode: string
  readonly error: string
  readonly details?: unknown
}> {}

export const catchIpcCode =
  <B, E2, R2>(code: string, recover: (error: IpcError) => Effect.Effect<B, E2, R2>) =>
  <A, E extends { readonly _tag: string }, R>(
    self: Effect.Effect<A, IpcError | E, R>
  ): Effect.Effect<A | B, E | IpcError | E2, R | R2> =>
    self.pipe(
      Effect.catchTag('IpcError', (error): Effect.Effect<B, IpcError | E2, R2> => {
        const ipcError = error as IpcError
        return ipcError.errorCode === code ? recover(ipcError) : Effect.fail(ipcError)
      })
    ) as Effect.Effect<A | B, E | IpcError | E2, R | R2>
