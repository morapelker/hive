import { Effect } from 'effect'
import type { z } from 'zod'

import { ZodDecodeError } from './errors'

export { ZodDecodeError } from './errors'

/**
 * Tagged failure raised by `decodeWithZod` when input fails to parse.
 *
 * `issues` is the raw `z.ZodIssue[]` from `safeParse` - preserve the array
 * verbatim so consumers can render rich messages or forward it across the
 * IPC boundary without lossy stringification.
 *
 * `schemaName` is optional but strongly recommended at call sites: it scopes
 * the error in logs and tests (`expectExitFailure(exit, 'ZodDecodeError')`
 * doesn't disambiguate between two decoders).
 */
/**
 * Validate `input` against `schema`, returning a typed Effect.
 *
 * Success -> `Effect.succeed(parsed)`.
 * Failure -> `Effect.fail(new ZodDecodeError(...))`.
 *
 * The schema's inferred output type is preserved (`z.infer<T>`), so callers
 * get full type narrowing without a manual generic.
 *
 * @example
 *   const Settings = z.object({ keepAwake: z.boolean() })
 *   const program = decodeWithZod(Settings, raw, 'AppSettings').pipe(
 *     Effect.flatMap((settings) => applySettings(settings))
 *   )
 */
export const decodeWithZod = <T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  schemaName?: string
): Effect.Effect<z.infer<T>, ZodDecodeError> => {
  const result = schema.safeParse(input)
  if (result.success) return Effect.succeed(result.data)
  return Effect.fail(new ZodDecodeError({ issues: result.error.issues, schemaName }))
}
