// @vitest-environment node
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { spawn as nodeSpawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effect, Either, Fiber, Layer, Ref, TestClock, TestContext } from 'effect'

import {
  SpawnFailed,
  SpawnNonZeroExit,
  SpawnOutputCapExceeded,
  SpawnSignalled,
  SpawnTimeout
} from '../errors'
import { LowLevelSpawn, Spawn } from '../service'
import { LowLevelSpawnLive, SpawnLive } from '../layers'

vi.mock('node:child_process', () => ({
  spawn: vi.fn()
}))

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: vi.fn() }
  pid: number | undefined = 12345
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('close', code, signal)
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true
    this.signalCode = signal ?? 'SIGTERM'
    this.emit('exit', null, this.signalCode)
    return true
  }
}

const mockedSpawn = vi.mocked(nodeSpawn)

const withPlatform = (platform: NodeJS.Platform): (() => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  return () => {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
  }
}

const fakeLowLevelLayer = (
  proc: FakeProc,
  signals: Ref.Ref<ReadonlyArray<NodeJS.Signals>>
) =>
  Layer.succeed(LowLevelSpawn, {
    spawn: () => Effect.succeed(proc as unknown as ChildProcess),
    signalTree: (_proc: ChildProcess, signal: NodeJS.Signals) =>
      Ref.update(signals, (xs) => [...xs, signal])
  })

describe('LowLevelSpawnLive', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mockedSpawn.mockReset()
  })

  it('spawns a process with stdio pipes and a detached Unix process group by default', async () => {
    const restorePlatform = withPlatform('darwin')
    const proc = new FakeProc()
    mockedSpawn.mockReturnValue(proc as unknown as ChildProcess)

    try {
      const child = await Effect.runPromise(
        Effect.flatMap(LowLevelSpawn, (spawn) =>
          spawn.spawn({ command: 'node', args: ['--version'], cwd: '/tmp', env: { A: 'B' } })
        ).pipe(Effect.provide(LowLevelSpawnLive))
      )

      expect(child).toBe(proc)
      expect(mockedSpawn).toHaveBeenCalledWith('node', ['--version'], {
        cwd: '/tmp',
        env: { A: 'B' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: undefined,
        detached: true,
        signal: undefined
      })
    } finally {
      restorePlatform()
    }
  })

  it('returns SpawnFailed when node spawn throws synchronously', async () => {
    mockedSpawn.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const result = await Effect.runPromise(
      Effect.either(
        Effect.flatMap(LowLevelSpawn, (spawn) =>
          spawn.spawn({ command: 'missing-cli', args: [] })
        ).pipe(Effect.provide(LowLevelSpawnLive))
      )
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SpawnFailed)
      expect(result.left.command).toBe('missing-cli')
    }
  })

  it('signals Windows process trees through taskkill', async () => {
    const restorePlatform = withPlatform('win32')
    const proc = new FakeProc()
    const taskkill = new FakeProc()
    mockedSpawn.mockReturnValue(taskkill as unknown as ChildProcess)

    try {
      await Effect.runPromise(
        Effect.flatMap(LowLevelSpawn, (spawn) =>
          spawn.signalTree(proc as unknown as ChildProcess, 'SIGKILL')
        ).pipe(Effect.provide(LowLevelSpawnLive))
      )

      expect(mockedSpawn).toHaveBeenCalledWith('taskkill', ['/pid', '12345', '/t', '/f'], {
        stdio: 'ignore'
      })
      expect(proc.killed).toBe(false)
    } finally {
      restorePlatform()
    }
  })

  it('signals Unix process groups by negative pid', async () => {
    const restorePlatform = withPlatform('darwin')
    const proc = new FakeProc()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      await Effect.runPromise(
        Effect.flatMap(LowLevelSpawn, (spawn) =>
          spawn.signalTree(proc as unknown as ChildProcess, 'SIGTERM')
        ).pipe(Effect.provide(LowLevelSpawnLive))
      )

      expect(kill).toHaveBeenCalledWith(-12345, 'SIGTERM')
      expect(proc.killed).toBe(false)
    } finally {
      restorePlatform()
    }
  })

  it('falls back to direct kill when a process has no pid', async () => {
    const proc = new FakeProc()
    proc.pid = undefined

    await Effect.runPromise(
      Effect.flatMap(LowLevelSpawn, (spawn) =>
        spawn.signalTree(proc as unknown as ChildProcess, 'SIGTERM')
      ).pipe(Effect.provide(LowLevelSpawnLive))
    )

    expect(proc.killed).toBe(true)
    expect(proc.signalCode).toBe('SIGTERM')
  })
})

describe('SpawnLive.runOnce', () => {
  it('collects stdout, optionally collects stderr, and writes stdin', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const signals = yield* Ref.make<ReadonlyArray<NodeJS.Signals>>([])
        const proc = new FakeProc()
        const layer = Layer.provide(SpawnLive, fakeLowLevelLayer(proc, signals))

        const fiber = yield* Effect.flatMap(Spawn, (spawn) =>
          spawn.runOnce({
            command: 'tool',
            args: ['arg'],
            stdin: 'hello',
            collectStderr: true
          })
        ).pipe(Effect.provide(layer), Effect.fork)

        yield* Effect.yieldNow()
        proc.stdout.emit('data', Buffer.from('out'))
        proc.stderr.emit('data', Buffer.from('err'))
        proc.close(0)

        const value = yield* fiber
        const finalSignals = yield* Ref.get(signals)
        return { value, finalSignals, stdin: proc.stdin.end }
      })
    )

    expect(result.value).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 })
    expect(result.stdin).toHaveBeenCalledWith('hello')
    expect(result.finalSignals).toEqual([])
  })

  it('fails with SpawnNonZeroExit for non-zero exit codes', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const signals = yield* Ref.make<ReadonlyArray<NodeJS.Signals>>([])
        const proc = new FakeProc()
        const layer = Layer.provide(SpawnLive, fakeLowLevelLayer(proc, signals))

        const fiber = yield* Effect.flatMap(Spawn, (spawn) =>
          spawn.runOnce({ command: 'tool', args: [], collectStderr: true })
        ).pipe(Effect.provide(layer), Effect.either, Effect.fork)

        yield* Effect.yieldNow()
        proc.stdout.emit('data', 'partial stdout')
        proc.stderr.emit('data', 'failure stderr')
        proc.close(7)

        return yield* fiber
      })
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SpawnNonZeroExit)
      const error = result.left as SpawnNonZeroExit
      expect(error.exitCode).toBe(7)
      expect(error.stdoutPreview).toBe('partial stdout')
      expect(error.stderrPreview).toBe('failure stderr')
    }
  })

  it('fails with SpawnSignalled when the process closes with a signal', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const signals = yield* Ref.make<ReadonlyArray<NodeJS.Signals>>([])
        const proc = new FakeProc()
        const layer = Layer.provide(SpawnLive, fakeLowLevelLayer(proc, signals))

        const fiber = yield* Effect.flatMap(Spawn, (spawn) =>
          spawn.runOnce({ command: 'tool', args: [] })
        ).pipe(Effect.provide(layer), Effect.either, Effect.fork)

        yield* Effect.yieldNow()
        proc.close(null, 'SIGTERM')
        return yield* fiber
      })
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SpawnSignalled)
      expect((result.left as SpawnSignalled).signal).toBe('SIGTERM')
    }
  })

  it('fails with SpawnFailed when the child emits error', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const signals = yield* Ref.make<ReadonlyArray<NodeJS.Signals>>([])
        const proc = new FakeProc()
        const layer = Layer.provide(SpawnLive, fakeLowLevelLayer(proc, signals))

        const fiber = yield* Effect.flatMap(Spawn, (spawn) =>
          spawn.runOnce({ command: 'tool', args: [] })
        ).pipe(Effect.provide(layer), Effect.either, Effect.fork)

        yield* Effect.yieldNow()
        proc.emit('error', new Error('boom'))
        return yield* fiber
      })
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SpawnFailed)
      expect(result.left.command).toBe('tool')
    }
  })

  it('fails with SpawnOutputCapExceeded and kills before a later close event can win', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const signals = yield* Ref.make<ReadonlyArray<NodeJS.Signals>>([])
        const proc = new FakeProc()
        const layer = Layer.provide(SpawnLive, fakeLowLevelLayer(proc, signals))

        const fiber = yield* Effect.flatMap(Spawn, (spawn) =>
          spawn.runOnce({ command: 'tool', args: [], maxOutputBytes: 3 })
        ).pipe(Effect.provide(layer), Effect.either, Effect.fork)

        yield* Effect.yieldNow()
        proc.stdout.emit('data', Buffer.from('abcd'))
        proc.close(0)

        const outcome = yield* fiber
        const finalSignals = yield* Ref.get(signals)
        return { outcome, finalSignals }
      })
    )

    expect(Either.isLeft(result.outcome)).toBe(true)
    if (Either.isLeft(result.outcome)) {
      expect(result.outcome.left).toBeInstanceOf(SpawnOutputCapExceeded)
      const error = result.outcome.left as SpawnOutputCapExceeded
      expect(error.stream).toBe('stdout')
      expect(error.bytes).toBe(4)
      expect(error.limit).toBe(3)
    }
    expect(result.finalSignals).toEqual(['SIGKILL'])
  })

  it('maps timeouts and scoped cleanup escalates SIGTERM to SIGKILL after 2 seconds', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const signals = yield* Ref.make<ReadonlyArray<NodeJS.Signals>>([])
        const proc = new FakeProc()
        const layer = Layer.provide(SpawnLive, fakeLowLevelLayer(proc, signals))

        const fiber = yield* Effect.flatMap(Spawn, (spawn) =>
          spawn.runOnce({ command: 'tool', args: [], timeout: '30 millis' })
        ).pipe(Effect.provide(layer), Effect.either, Effect.fork)

        yield* TestClock.adjust('30 millis')
        yield* Effect.yieldNow()
        const afterTimeout = yield* Ref.get(signals)

        yield* TestClock.adjust('2 seconds')
        const outcome = yield* fiber
        const finalSignals = yield* Ref.get(signals)
        return { outcome, afterTimeout, finalSignals }
      }).pipe(Effect.provide(TestContext.TestContext))
    )

    expect(Either.isLeft(result.outcome)).toBe(true)
    if (Either.isLeft(result.outcome)) {
      expect(result.outcome.left).toBeInstanceOf(SpawnTimeout)
      expect((result.outcome.left as SpawnTimeout).durationMs).toBe(30)
    }
    expect(result.afterTimeout).toEqual(['SIGTERM'])
    expect(result.finalSignals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('runs scoped cleanup when the effect is interrupted', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const signals = yield* Ref.make<ReadonlyArray<NodeJS.Signals>>([])
        const proc = new FakeProc()
        const layer = Layer.provide(SpawnLive, fakeLowLevelLayer(proc, signals))

        const fiber = yield* Effect.flatMap(Spawn, (spawn) =>
          spawn.runOnce({ command: 'tool', args: [] })
        ).pipe(Effect.provide(layer), Effect.fork)

        yield* Effect.yieldNow()
        const interruptFiber = yield* Fiber.interrupt(fiber).pipe(Effect.fork)
        yield* Effect.yieldNow()
        yield* TestClock.adjust('2 seconds')
        yield* Effect.yieldNow()
        yield* interruptFiber
        return yield* Ref.get(signals)
      }).pipe(Effect.provide(TestContext.TestContext))
    )

    expect(result).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
