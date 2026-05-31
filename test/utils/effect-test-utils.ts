import { Cause, Duration, Effect, Exit, Layer, TestClock, TestContext } from 'effect'

/**
 * Run an Effect to an Exit. Use this instead of `Effect.runPromise` in tests
 * so failures don't throw out of the test body - let `expectExit*` decide.
 */
export const runEffect = <A, E>(
  effect: Effect.Effect<A, E, never>
): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(effect)

/**
 * Run an Effect with Effect's TestContext so TestClock controls time.
 */
export const runEffectWithTestClock = <A, E>(
  effect: Effect.Effect<A, E, never>
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(TestContext.TestContext)))

/**
 * Advance TestClock virtual time from inside an Effect test program.
 */
export const adjustClock = (
  duration: Duration.DurationInput
): Effect.Effect<void> => TestClock.adjust(duration)

/**
 * Assert an Exit succeeded and return its value. Throws a readable message
 * (with the failure cause pretty-printed) if the Exit is a failure.
 */
export const expectExitSuccess = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(
    `expected Exit.Success, got Exit.Failure: ${Cause.pretty(exit.cause)}`
  )
}

/**
 * Assert an Exit failed with a tagged error matching `expectedTag`. Returns
 * the typed error value so callers can assert on its fields.
 *
 * - Success -> throw with the success value
 * - Defect (no failure in cause) -> throw with pretty cause
 * - Failure with wrong _tag -> throw with both expected and actual tag
 */
export const expectExitFailure = <A, E>(
  exit: Exit.Exit<A, E>,
  expectedTag: string
): E => {
  if (Exit.isSuccess(exit)) {
    throw new Error(
      `expected Exit.Failure tagged "${expectedTag}", got Exit.Success: ${JSON.stringify(exit.value)}`
    )
  }
  const failureOption = Cause.failureOption(exit.cause)
  if (failureOption._tag === 'None') {
    throw new Error(
      `expected Exit.Failure tagged "${expectedTag}", got defect: ${Cause.pretty(exit.cause)}`
    )
  }
  const actualTag = (failureOption.value as { _tag?: string })._tag
  if (actualTag !== expectedTag) {
    throw new Error(
      `expected Exit.Failure tagged "${expectedTag}", got "${actualTag ?? '<untagged>'}": ${Cause.pretty(exit.cause)}`
    )
  }
  return failureOption.value
}

/**
 * Compose test layer overrides into a single layer suitable for
 * `Effect.provide`. Thin sugar over `Layer.mergeAll` - the value is in having
 * one canonical name to reach for in test files.
 *
 * @example
 *   const layer = withTestLayers(
 *     Layer.succeed(EventSink, fakeEventSink),
 *     Layer.succeed(Spawner, fakeSpawner)
 *   )
 *   yield* program.pipe(Effect.provide(Layer.provide(BashLive, layer)))
 */
export const withTestLayers = (
  ...overrides: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>
): Layer.Layer<unknown, unknown, unknown> =>
  Layer.mergeAll(
    ...(overrides as [
      Layer.Layer<unknown, unknown, unknown>,
      ...Array<Layer.Layer<unknown, unknown, unknown>>
    ])
  )
