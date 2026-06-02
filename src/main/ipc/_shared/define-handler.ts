import { ipcMain } from 'electron'
import { Effect, Exit, type ManagedRuntime } from 'effect'
import type { z } from 'zod'

import { decodeWithZod } from '../../effect/_shared/zod-adapter'
import type { ZodDecodeError } from '../../effect/_shared/errors'
import { fromCause } from '../../services/error-utils'
import type { Envelope } from '@shared/types/ipc-envelope'
import { getIpcRuntime } from './ipc-runtime'

const humanizeError = (error: unknown): string => {
  const tagged = error as { _tag?: string; issues?: readonly { message: string }[]; schemaName?: string }
  if (tagged._tag === 'ZodDecodeError' && tagged.issues && tagged.issues.length > 0) {
    const prefix = tagged.schemaName ? `${tagged.schemaName}: ` : ''
    return `${prefix}${tagged.issues.map((issue) => issue.message).join('; ')}`
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Convert an Effect `Exit` into the renderer-facing envelope. Success -> plain
 * `{ success: true, value }`. Failure -> `{ success: false, errorCode, error, details? }`
 * where `errorCode` is the typed-error `_tag` (or `'UnexpectedDefect'` for
 * uncaught throws inside the Effect).
 */
export const toEnvelope = <A, E>(exit: Exit.Exit<A, E>): Envelope<A> =>
  Exit.match(exit, {
    onSuccess: (value) => ({ success: true as const, value }),
    onFailure: (cause) => ({ success: false as const, ...fromCause(cause, { humanize: humanizeError }) })
  })

/**
 * Register an `ipcMain.handle(channel, ...)` that:
 *   1. Validates raw renderer args via `decodeWithZod(inputSchema, raw, channel)`.
 *   2. Runs `handler(input)` on the shared IPC runtime (`getIpcRuntime`).
 *   3. Wraps the resulting Exit as `Envelope<A>`.
 *
 * Calling convention: if the renderer invokes with one positional arg, that
 * value is decoded directly. With N>1 positional args, the args are decoded as
 * a tuple - define the schema as `z.tuple([...])` to match.
 *
 * The handler's `R` is `never` (or whatever `getIpcRuntime()` provides). For
 * island-backed handlers, pre-provide layers with `Effect.provide` before
 * passing the program to `defineHandler`.
 */
export const defineHandler = <I, A, E>(
  channel: string,
  inputSchema: z.ZodType<I>,
  handler: (input: I) => Effect.Effect<A, E, never>
): void => {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    const raw: unknown = args.length === 1 ? args[0] : args
    const program: Effect.Effect<A, E | ZodDecodeError, never> = decodeWithZod(
      inputSchema,
      raw,
      channel
    ).pipe(Effect.flatMap(handler))

    const runtime: ManagedRuntime.ManagedRuntime<never, never> = getIpcRuntime()
    const exit = await runtime.runPromiseExit(program)
    return toEnvelope(exit)
  })
}
