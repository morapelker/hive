import { spawn, type ChildProcess } from 'node:child_process'
import { Chunk, Duration, Effect, Layer, Stream } from 'effect'

import {
  SpawnFailed,
  SpawnNonZeroExit,
  SpawnOutputCapExceeded,
  SpawnSignalled,
  SpawnTimeout
} from './errors'
import { LowLevelSpawn, Spawn } from './service'
import type { RunOnceResult, SpawnOptions, StreamChunk } from './types'

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const PREVIEW_LENGTH = 500

type OutputState = {
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  releaseAlreadyHandled: boolean
}

type LowLevelSpawnApi = {
  readonly spawn: (options: SpawnOptions) => Effect.Effect<ChildProcess, SpawnFailed>
  readonly signalTree: (proc: ChildProcess, signal: NodeJS.Signals) => Effect.Effect<void>
}

const preview = (value: string): string =>
  value.length <= PREVIEW_LENGTH ? value : `${value.slice(0, PREVIEW_LENGTH)}...`

const isAlive = (proc: ChildProcess): boolean => proc.exitCode === null && proc.signalCode === null

const releaseProcess = (
  proc: ChildProcess,
  lowLevel: LowLevelSpawnApi,
  state?: OutputState
) =>
  Effect.gen(function* () {
    if (state?.releaseAlreadyHandled || !isAlive(proc)) return

    yield* lowLevel.signalTree(proc, 'SIGTERM')
    yield* Effect.sleep('2 seconds')
    if (isAlive(proc)) {
      yield* lowLevel.signalTree(proc, 'SIGKILL')
    }
  }).pipe(Effect.catchAll(() => Effect.void))

const appendOutput = (
  state: OutputState,
  streamName: 'stdout' | 'stderr',
  chunk: Buffer | string,
  limit: number
): SpawnOutputCapExceeded | null => {
  const data = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
  const bytes = Buffer.byteLength(data, 'utf8')

  if (streamName === 'stdout') {
    state.stdout += data
    state.stdoutBytes += bytes
    if (state.stdoutBytes > limit) {
      return new SpawnOutputCapExceeded({
        command: '',
        stream: 'stdout',
        bytes: state.stdoutBytes,
        limit
      })
    }
    return null
  }

  state.stderr += data
  state.stderrBytes += bytes
  if (state.stderrBytes > limit) {
    return new SpawnOutputCapExceeded({
      command: '',
      stream: 'stderr',
      bytes: state.stderrBytes,
      limit
    })
  }
  return null
}

const awaitClose = (
  proc: ChildProcess,
  options: SpawnOptions,
  lowLevel: LowLevelSpawnApi,
  state: OutputState
) =>
  Effect.async<
    RunOnceResult,
    SpawnFailed | SpawnNonZeroExit | SpawnSignalled | SpawnOutputCapExceeded
  >((resume, signal) => {
    let settled = false
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    const cleanup = (): void => {
      proc.stdout?.off('data', onStdout)
      proc.stderr?.off('data', onStderr)
      proc.off('close', onClose)
      proc.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }

    const settle = (
      effect: Effect.Effect<
        RunOnceResult,
        SpawnFailed | SpawnNonZeroExit | SpawnSignalled | SpawnOutputCapExceeded
      >
    ): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(effect)
    }

    const failOutputCap = (error: SpawnOutputCapExceeded): void => {
      if (settled) return
      state.releaseAlreadyHandled = true
      const tagged = new SpawnOutputCapExceeded({ ...error, command: options.command })
      settle(lowLevel.signalTree(proc, 'SIGKILL').pipe(Effect.zipRight(Effect.fail(tagged))))
    }

    const onStdout = (chunk: Buffer | string): void => {
      const error = appendOutput(state, 'stdout', chunk, maxOutputBytes)
      if (error) failOutputCap(error)
    }
    const onStderr = (chunk: Buffer | string): void => {
      const error = appendOutput(state, 'stderr', chunk, maxOutputBytes)
      if (error) failOutputCap(error)
    }
    const onClose = (code: number | null, signalCode: NodeJS.Signals | null): void => {
      if (signalCode !== null) {
        settle(
          Effect.fail(
            new SpawnSignalled({
              command: options.command,
              signal: signalCode,
              stdoutPreview: preview(state.stdout),
              stderrPreview: preview(state.stderr)
            })
          )
        )
        return
      }

      if (code === 0) {
        settle(
          Effect.succeed({
            stdout: state.stdout,
            stderr: options.collectStderr === true ? state.stderr : '',
            exitCode: 0
          })
        )
        return
      }

      settle(
        Effect.fail(
          new SpawnNonZeroExit({
            command: options.command,
            exitCode: code ?? -1,
            stdoutPreview: preview(state.stdout),
            stderrPreview: preview(state.stderr)
          })
        )
      )
    }
    const onError = (error: Error): void => {
      state.releaseAlreadyHandled = true
      settle(Effect.fail(new SpawnFailed({ command: options.command, cause: error })))
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(Effect.interrupt)
    }

    proc.stdout?.on('data', onStdout)
    proc.stderr?.on('data', onStderr)
    proc.once('close', onClose)
    proc.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })

    return Effect.sync(cleanup)
  })

const runOnceWithLowLevel = (options: SpawnOptions, lowLevel: LowLevelSpawnApi) => {
  const state: OutputState = {
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    releaseAlreadyHandled: false
  }

  const effect = Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* lowLevel.spawn(options)
      yield* Effect.addFinalizer(() => releaseProcess(proc, lowLevel, state))
      yield* Effect.sync(() => {
        try {
          proc.stdin?.end(options.stdin ?? '')
        } catch {
          // Matches the legacy helpers: stdin close failures do not change the process result.
        }
      })
      return yield* awaitClose(proc, options, lowLevel, state)
    })
  )

  if (options.timeout === undefined) return effect

  return effect.pipe(
    Effect.timeout(options.timeout),
    Effect.catchTag('TimeoutException', () =>
      Effect.fail(
        new SpawnTimeout({
          command: options.command,
          durationMs: Duration.toMillis(options.timeout!),
          stdoutPreview: preview(state.stdout),
          stderrPreview: preview(state.stderr)
        })
      )
    )
  )
}

const streamWithLowLevel = (options: SpawnOptions, lowLevel: LowLevelSpawnApi) => {
  const state: OutputState = {
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    releaseAlreadyHandled: false
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  const stream = Stream.unwrapScoped(
    Effect.gen(function* () {
      const proc = yield* lowLevel.spawn(options)
      yield* Effect.addFinalizer(() => releaseProcess(proc, lowLevel, state))
      yield* Effect.sync(() => {
        try {
          proc.stdin?.end(options.stdin ?? '')
        } catch {
          // See runOnce.
        }
      })

      return Stream.asyncPush<StreamChunk, SpawnFailed | SpawnSignalled | SpawnOutputCapExceeded>(
        (emit) =>
          Effect.gen(function* () {
            let settled = false

            const cleanup = (): void => {
              proc.stdout?.off('data', onStdout)
              proc.stderr?.off('data', onStderr)
              proc.off('close', onClose)
              proc.off('error', onError)
            }

            const failOutputCap = (error: SpawnOutputCapExceeded): void => {
              if (settled) return
              settled = true
              state.releaseAlreadyHandled = true
              cleanup()
              Effect.runFork(lowLevel.signalTree(proc, 'SIGKILL'))
              emit.fail(new SpawnOutputCapExceeded({ ...error, command: options.command }))
            }

            const onStdout = (chunk: Buffer | string): void => {
              const error = appendOutput(state, 'stdout', chunk, maxOutputBytes)
              if (error) {
                failOutputCap(error)
                return
              }
              emit.single({
                source: 'stdout',
                data: Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
              })
            }
            const onStderr = (chunk: Buffer | string): void => {
              const error = appendOutput(state, 'stderr', chunk, maxOutputBytes)
              if (error) {
                failOutputCap(error)
                return
              }
              emit.single({
                source: 'stderr',
                data: Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
              })
            }
            const onClose = (_code: number | null, signalCode: NodeJS.Signals | null): void => {
              if (settled) return
              settled = true
              cleanup()
              if (signalCode !== null) {
                emit.fail(
                  new SpawnSignalled({
                    command: options.command,
                    signal: signalCode,
                    stdoutPreview: preview(state.stdout),
                    stderrPreview: preview(state.stderr)
                  })
                )
                return
              }
              emit.end()
            }
            const onError = (error: Error): void => {
              if (settled) return
              settled = true
              cleanup()
              emit.fail(new SpawnFailed({ command: options.command, cause: error }))
            }

            proc.stdout?.on('data', onStdout)
            proc.stderr?.on('data', onStderr)
            proc.once('close', onClose)
            proc.once('error', onError)

            yield* Effect.addFinalizer(() => Effect.sync(cleanup))
          }),
        { bufferSize: 'unbounded' }
      ).pipe(
        Stream.groupedWithin(Number.MAX_SAFE_INTEGER, '16 millis'),
        Stream.map((chunks) => Chunk.toReadonlyArray(chunks)),
        Stream.mapConcat((chunks) => chunks)
      )
    })
  )

  if (options.timeout === undefined) return stream

  return stream.pipe(
    Stream.timeoutFail(
      () =>
        new SpawnTimeout({
          command: options.command,
          durationMs: Duration.toMillis(options.timeout!),
          stdoutPreview: preview(state.stdout),
          stderrPreview: preview(state.stderr)
        }),
      options.timeout
    )
  )
}

export const LowLevelSpawnLive = Layer.succeed(LowLevelSpawn, {
  spawn: (options: SpawnOptions) =>
    Effect.try({
      try: () =>
        spawn(options.command, [...options.args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: options.shell,
          detached: options.detached ?? process.platform !== 'win32',
          signal: options.signal
        }),
      catch: (cause) => new SpawnFailed({ command: options.command, cause })
    }),
  signalTree: (proc: ChildProcess, signal: NodeJS.Signals) =>
    Effect.gen(function* () {
      const pid = proc.pid
      if (!pid) {
        try {
          proc.kill(signal)
        } catch {
          // already dead
        }
        return
      }

      if (process.platform === 'win32') {
        const args = ['/pid', String(pid), '/t']
        if (signal === 'SIGKILL') args.push('/f')
        const taskkill = spawn('taskkill', args, { stdio: 'ignore' })
        taskkill.on('error', () => {
          try {
            proc.kill(signal)
          } catch {
            // already dead
          }
        })
        return
      }

      try {
        process.kill(-pid, signal)
      } catch {
        yield* Effect.logWarning(
          'Failed to signal process group; falling back to direct process kill',
          { pid, signal }
        )
        try {
          proc.kill(signal)
        } catch {
          // already dead
        }
      }
    })
})

export const SpawnLive = Layer.effect(
  Spawn,
  Effect.gen(function* () {
    const lowLevel = yield* LowLevelSpawn
    return {
      runOnce: (options: SpawnOptions) => runOnceWithLowLevel(options, lowLevel),
      stream: (options: SpawnOptions) => streamWithLowLevel(options, lowLevel)
    }
  })
)

export const AppLive = Layer.merge(LowLevelSpawnLive, Layer.provide(SpawnLive, LowLevelSpawnLive))
