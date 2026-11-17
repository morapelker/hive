// @vitest-environment node
/**
 * Which sessions have a command running (`Bash.runningSessionIds`). Moving a project asks for
 * them, so a run has to be listed for as long as it runs and never after it is over, whichever
 * way it ended.
 */
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { describe, expect, it } from 'vitest'
import { Effect, Exit, Layer, type Context } from 'effect'

import { Bash, EventSink, Spawner } from '../service'
import { BashLive } from '../layers'
import type { BashStreamEvent } from '../types'

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  /** The process is gone and its output is closed. */
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('close', code)
  }
}

interface Fake {
  readonly proc: FakeProc
  readonly signals: NodeJS.Signals[]
  /** Resolves when the service announces the end of the run. */
  readonly ended: Promise<void>
  /** Resolves when the service kills the process outright. */
  readonly killed: Promise<void>
}

interface FakeOptions {
  /** Stands in for the listeners of the event bus; one that throws is `Effect.die`. */
  readonly onEvent?: (event: BashStreamEvent) => Effect.Effect<void>
  /** What a signal does to the process; nothing when absent. */
  readonly onSignal?: (proc: FakeProc, signal: NodeJS.Signals) => void
  /** The processes of the commands after the first; without them each gets the first one's. */
  readonly nextProcs?: readonly FakeProc[]
}

const makeFake = (options: FakeOptions = {}): { fake: Fake; layer: Layer.Layer<Bash> } => {
  const proc = new FakeProc()
  const procs = [proc, ...(options.nextProcs ?? [])]
  let spawns = 0
  const signals: NodeJS.Signals[] = []
  let announceEnd = (): void => undefined
  let announceKill = (): void => undefined
  const ended = new Promise<void>((resolve) => {
    announceEnd = resolve
  })
  const killed = new Promise<void>((resolve) => {
    announceKill = resolve
  })
  const dependencies = Layer.mergeAll(
    Layer.succeed(EventSink, {
      send: (event: BashStreamEvent) =>
        Effect.suspend(() => {
          if (event.type === 'end') announceEnd()
          return options.onEvent?.(event) ?? Effect.void
        })
    }),
    Layer.succeed(Spawner, {
      spawn: () =>
        Effect.sync(() => {
          const next = procs[Math.min(spawns, procs.length - 1)]
          spawns += 1
          return next as unknown as ChildProcess
        }),
      signalTree: (target: ChildProcess, signal: NodeJS.Signals) =>
        Effect.sync(() => {
          signals.push(signal)
          options.onSignal?.(target as unknown as FakeProc, signal)
          if (signal === 'SIGKILL') announceKill()
        })
    })
  )
  return { fake: { proc, signals, ended, killed }, layer: Layer.provide(BashLive, dependencies) }
}

/** A process that dies of the signal it is sent, as `sleep` does. */
const diesOfSignal = (proc: FakeProc, signal: NodeJS.Signals): void => proc.close(null, signal)

const wait = (promise: Promise<void>): Effect.Effect<void> => Effect.promise(() => promise)

/** Until no session is listed, for at most two seconds; the last list either way. */
const untilNoneRuns = (bash: Context.Tag.Service<typeof Bash>): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    let running = yield* bash.runningSessionIds
    for (let attempt = 0; attempt < 400 && running.length > 0; attempt += 1) {
      yield* Effect.sleep('5 millis')
      running = yield* bash.runningSessionIds
    }
    return running
  })

describe('Bash.runningSessionIds', () => {
  it('lists a session while its command runs, and not once the command has exited', async () => {
    const { fake, layer } = makeFake()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bash = yield* Bash
        const before = yield* bash.runningSessionIds
        yield* bash.run('session-a', 'sleep 30', '/tmp')
        const during = yield* bash.runningSessionIds

        fake.proc.close(0)
        yield* wait(fake.ended)

        return {
          before,
          during,
          after: yield* bash.runningSessionIds,
          // The finished run is still there to be read: it is the status that takes it out.
          run: yield* bash.getRun('session-a')
        }
      }).pipe(Effect.provide(layer))
    )

    expect(result.before).toEqual([])
    expect(result.during).toEqual(['session-a'])
    expect(result.after).toEqual([])
    expect(result.run?.status).toBe('exited')
  })

  it('lists every session that has a command running', async () => {
    const { fake, layer } = makeFake()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bash = yield* Bash
        yield* bash.run('session-a', 'sleep 30', '/tmp')
        yield* bash.run('session-b', 'sleep 30', '/tmp')
        const both = yield* bash.runningSessionIds

        // One process stands in for both runs: closing it ends them together.
        fake.proc.close(0)
        return { both, after: yield* untilNoneRuns(bash) }
      }).pipe(Effect.provide(layer))
    )

    expect([...result.both].sort()).toEqual(['session-a', 'session-b'])
    expect(result.after).toEqual([])
  })

  it('no longer lists a command that was stopped', async () => {
    const { fake, layer } = makeFake({ onSignal: diesOfSignal })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bash = yield* Bash
        yield* bash.run('session-stop', 'sleep 30', '/tmp')
        const during = yield* bash.runningSessionIds

        const stopped = yield* bash.abort('session-stop')
        yield* wait(fake.ended)

        return {
          during,
          stopped,
          after: yield* bash.runningSessionIds,
          run: yield* bash.getRun('session-stop')
        }
      }).pipe(Effect.provide(layer))
    )

    expect(result.during).toEqual(['session-stop'])
    expect(result.stopped).toBe(true)
    expect(fake.signals).toEqual(['SIGTERM'])
    expect(result.after).toEqual([])
    expect(result.run?.status).toBe('killed')
  })

  it('no longer lists a command that was cut off at the output limit', async () => {
    const { fake, layer } = makeFake()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bash = yield* Bash
        yield* bash.run('session-cut', 'cat /dev/zero', '/tmp')

        fake.proc.stdout.emit('data', Buffer.alloc(1024 * 1024 + 32, 'A'))
        yield* wait(fake.killed)
        // The process was sent the kill and has not closed yet: the run already reads as over.
        const cutOff = yield* bash.runningSessionIds

        fake.proc.close(null, 'SIGKILL')
        yield* wait(fake.ended)

        return {
          cutOff,
          after: yield* bash.runningSessionIds,
          run: yield* bash.getRun('session-cut')
        }
      }).pipe(Effect.provide(layer))
    )

    expect(result.cutOff).toEqual([])
    expect(result.after).toEqual([])
    expect(result.run?.status).toBe('truncated')
  })

  it('goes on listing the next command of a session when the one cut off before it closes late', async () => {
    const second = new FakeProc()
    const { fake, layer } = makeFake({
      nextProcs: [second],
      onSignal: (proc, signal) => {
        if (proc === second) diesOfSignal(proc, signal)
      }
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bash = yield* Bash
        yield* bash.run('session-next', 'cat /dev/zero', '/tmp')
        fake.proc.stdout.emit('data', Buffer.alloc(1024 * 1024 + 32, 'A'))
        yield* wait(fake.killed)

        // The first command reads as over, so the session may start its next one, and does
        // before the process of the first has closed.
        const next = yield* bash.run('session-next', 'sleep 30', '/tmp')
        fake.proc.close(null, 'SIGKILL')
        yield* wait(fake.ended)
        // Time for the first run to finish what it does after announcing its end.
        yield* Effect.sleep('20 millis')

        const running = yield* bash.runningSessionIds
        const run = yield* bash.getRun('session-next')
        const stopped = yield* bash.abort('session-next')
        return { next, running, run, stopped, after: yield* untilNoneRuns(bash) }
      }).pipe(Effect.provide(layer))
    )

    expect(result.running).toEqual(['session-next'])
    expect(result.run).toMatchObject({ id: result.next.runId, status: 'running' })
    // Stop reaches the command that is running, not the one that was cut off.
    expect(result.stopped).toBe(true)
    expect(result.after).toEqual([])
  })

  it('does not go on listing a run whose lifecycle failed before it set the final status', async () => {
    // A listener of the event bus that throws on the output of the run.
    const { fake, layer } = makeFake({
      onEvent: (event) =>
        event.type === 'output' ? Effect.die(new Error('a listener threw')) : Effect.void,
      onSignal: diesOfSignal
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bash = yield* Bash
        yield* bash.run('session-broken', 'sleep 30', '/tmp')
        const during = yield* bash.runningSessionIds

        // The process reports an error: the lifecycle goes to announce it and fails there.
        fake.proc.emit('error', new Error('write EPIPE'))

        return {
          during,
          after: yield* untilNoneRuns(bash),
          run: yield* bash.getRun('session-broken'),
          // The session is free for its next command.
          again: yield* Effect.exit(bash.run('session-broken', 'echo again', '/tmp'))
        }
      }).pipe(Effect.provide(layer))
    )

    expect(result.during).toEqual(['session-broken'])
    expect(result.after).toEqual([])
    expect(result.run?.status).toBe('error')
    // The lifecycle let go of the process on its way out.
    expect(fake.signals).toContain('SIGTERM')
    expect(Exit.isSuccess(result.again)).toBe(true)
  })

  it('ends and forgets a run whose start could not be announced', async () => {
    // A listener that throws is a defect, not a typed failure of the announcement.
    const { fake, layer } = makeFake({
      onEvent: (event) =>
        event.type === 'start' ? Effect.die(new Error('a listener threw')) : Effect.void
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bash = yield* Bash
        const started = yield* Effect.exit(bash.run('session-unannounced', 'sleep 30', '/tmp'))

        return {
          started,
          running: yield* bash.runningSessionIds,
          run: yield* bash.getRun('session-unannounced')
        }
      }).pipe(Effect.provide(layer))
    )

    expect(Exit.isFailure(result.started)).toBe(true)
    expect(fake.signals).toEqual(['SIGKILL'])
    expect(result.running).toEqual([])
    expect(result.run).toBeNull()
  })
})
