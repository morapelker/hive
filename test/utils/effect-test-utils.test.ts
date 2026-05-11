// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Context, Data, Effect, Fiber, Layer, TestClock } from 'effect'

import {
  runEffect,
  runEffectWithTestClock,
  adjustClock,
  expectExitSuccess,
  expectExitFailure,
  withTestLayers
} from './effect-test-utils'

class TestError extends Data.TaggedError('TestError')<{ readonly why: string }> {}

class Greeter extends Context.Tag('test/Greeter')<
  Greeter,
  { readonly hello: (name: string) => Effect.Effect<string> }
>() {}

describe('effect-test-utils', () => {
  it('runEffect + expectExitSuccess returns the success value', async () => {
    const exit = await runEffect(Effect.succeed(42))
    expect(expectExitSuccess(exit)).toBe(42)
  })

  it('runEffectWithTestClock advances virtual time without real wait', async () => {
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.sleep('30 seconds').pipe(
        Effect.as('done'),
        Effect.fork
      )
      yield* TestClock.adjust('30 seconds')
      return yield* Fiber.join(fiber)
    })

    const exit = await runEffectWithTestClock(program)
    expect(expectExitSuccess(exit)).toBe('done')
  })

  it('adjustClock returns an Effect usable inside Effect.gen', async () => {
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.sleep('5 seconds').pipe(
        Effect.as(42),
        Effect.fork
      )
      yield* adjustClock('5 seconds')
      return yield* Fiber.join(fiber)
    })

    const exit = await runEffectWithTestClock(program)
    expect(expectExitSuccess(exit)).toBe(42)
  })

  it('expectExitSuccess throws when the Exit is a failure', async () => {
    const exit = await runEffect(Effect.fail(new TestError({ why: 'nope' })))
    expect(() => expectExitSuccess(exit)).toThrow(/Exit\.Failure/)
  })

  it('expectExitFailure returns the typed error when tag matches', async () => {
    const exit = await runEffect(Effect.fail(new TestError({ why: 'because' })))
    const err = expectExitFailure(exit, 'TestError')
    expect(err).toBeInstanceOf(TestError)
    expect((err as TestError).why).toBe('because')
  })

  it('expectExitFailure throws when tag does not match', async () => {
    const exit = await runEffect(Effect.fail(new TestError({ why: 'x' })))
    expect(() => expectExitFailure(exit, 'OtherTag')).toThrow(/expected.*"OtherTag"/)
  })

  it('expectExitFailure throws when Exit is a success', async () => {
    const exit = await runEffect(Effect.succeed('ok'))
    expect(() => expectExitFailure(exit, 'TestError')).toThrow(/got Exit\.Success/)
  })

  it('withTestLayers composes overrides for Effect.provide', async () => {
    const layer = withTestLayers(
      Layer.succeed(Greeter, {
        hello: (name) => Effect.succeed(`hi ${name}`)
      })
    )
    const program = Effect.flatMap(Greeter, (g) => g.hello('world')).pipe(
      Effect.provide(layer)
    )
    const exit = await runEffect(program)
    expect(expectExitSuccess(exit)).toBe('hi world')
  })
})
