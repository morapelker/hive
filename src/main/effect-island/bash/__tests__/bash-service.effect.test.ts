// @vitest-environment node
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { describe, expect, it } from 'vitest'
import { Effect, Either, Layer, Ref, TestClock, TestContext } from 'effect'

import { BashAlreadyRunning } from '../errors'
import { Bash, EventSink, Spawner } from '../service'
import { BashLive } from '../layers'
import type { BashStreamEvent } from '../types'

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: () => undefined }
  pid = 12345
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  close(code: number | null = null): void {
    this.exitCode = code
    this.emit('close', code)
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signalCode = signal ?? 'SIGTERM'
    return true
  }
}

interface FakeSpawner {
  proc: FakeProc
  signals: Ref.Ref<ReadonlyArray<NodeJS.Signals>>
}

const testLayer = (
  events: Ref.Ref<ReadonlyArray<BashStreamEvent>>,
  fake: FakeSpawner
) => {
  const dependencies = Layer.mergeAll(
    Layer.succeed(EventSink, {
      send: (event: BashStreamEvent) => Ref.update(events, (xs) => [...xs, event])
    }),
    Layer.succeed(Spawner, {
      spawn: () => Effect.succeed(fake.proc as unknown as ChildProcess),
      signalTree: (_proc: ChildProcess, signal: NodeJS.Signals) =>
        Ref.update(fake.signals, (xs) => [...xs, signal])
    })
  )

  return Layer.provide(BashLive, dependencies)
}

describe('Bash Effect island', () => {
  it('returns BashAlreadyRunning as a typed failure instead of throwing', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Ref.make<ReadonlyArray<BashStreamEvent>>([])
        const signals = yield* Ref.make<ReadonlyArray<NodeJS.Signals>>([])
        const fake = { proc: new FakeProc(), signals }
        const layer = testLayer(events, fake)

        return yield* Effect.either(
          Effect.gen(function* () {
            const bash = yield* Bash
            yield* bash.run('session-a', 'sleep 30', '/tmp')
            yield* bash.run('session-a', 'echo second', '/tmp')
          }).pipe(Effect.provide(layer))
        )
      })
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(BashAlreadyRunning)
      expect(result.left._tag).toBe('BashAlreadyRunning')
      if (result.left instanceof BashAlreadyRunning) {
        expect(result.left.sessionId).toBe('session-a')
      }
    }
  })

  it('escalates abort from SIGTERM to SIGKILL after 2 seconds with TestClock', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Ref.make<ReadonlyArray<BashStreamEvent>>([])
        const signals = yield* Ref.make<ReadonlyArray<NodeJS.Signals>>([])
        const fake = { proc: new FakeProc(), signals }
        const layer = testLayer(events, fake)

        return yield* Effect.gen(function* () {
          const bash = yield* Bash
          yield* bash.run('session-abort', 'sleep 30', '/tmp')

          const abortFiber = yield* Effect.fork(bash.abort('session-abort'))
          yield* Effect.yieldNow()
          const afterTerm = yield* Ref.get(signals)

          yield* TestClock.adjust('2 seconds')
          const aborted = yield* abortFiber
          const finalSignals = yield* Ref.get(signals)

          return { aborted, afterTerm, finalSignals }
        }).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext))
      })
    )

    expect(result.aborted).toBe(true)
    expect(result.afterTerm).toEqual(['SIGTERM'])
    expect(result.finalSignals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('emits a truncated end event when the output cap is reached', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Ref.make<ReadonlyArray<BashStreamEvent>>([])
        const signals = yield* Ref.make<ReadonlyArray<NodeJS.Signals>>([])
        const fake = { proc: new FakeProc(), signals }
        const layer = testLayer(events, fake)

        return yield* Effect.gen(function* () {
          const bash = yield* Bash
          yield* bash.run('session-truncated', 'cat /dev/zero', '/tmp')

          fake.proc.stdout.emit('data', Buffer.alloc(1024 * 1024 + 32, 'A'))
          fake.proc.close(null)

          yield* TestClock.adjust('16 millis')

          const recordedEvents = yield* Ref.get(events)
          const recordedSignals = yield* Ref.get(signals)
          const snapshot = yield* bash.getRun('session-truncated')

          return { recordedEvents, recordedSignals, snapshot }
        }).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext))
      })
    )

    const end = result.recordedEvents.find(
      (event): event is Extract<BashStreamEvent, { type: 'end' }> => event.type === 'end'
    )

    expect(end?.status).toBe('truncated')
    expect(result.recordedSignals).toContain('SIGKILL')
    expect(result.snapshot?.status).toBe('truncated')
    expect(result.snapshot?.outputBuffer).toContain('[output truncated at 1 MB')
  })
})
