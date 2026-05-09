import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import { Cause, Chunk, Deferred, Effect, Fiber, Layer, Ref, Stream } from 'effect'

import { BashAlreadyRunning, BashSpawnFailed, BashWindowMissing } from './errors'
import { Bash, EventSink, Spawner } from './service'
import type { BashRunSnapshot, BashRunStatus, BashStreamEvent } from './types'

const OUTPUT_BYTES_LIMIT = 1 * 1024 * 1024
const TRUNCATION_SENTINEL = '\n\n[output truncated at 1 MB — process killed]\n'

interface ActiveRun extends BashRunSnapshot {
  status: BashRunStatus
  proc?: ChildProcess
  fiber?: Fiber.RuntimeFiber<void, never>
  abortRequested?: boolean
}

type CloseOutcome =
  | { readonly _tag: 'closed'; readonly code: number | null }
  | { readonly _tag: 'error'; readonly error: Error }

type SpawnerApi = {
  readonly spawn: (
    sessionId: string,
    command: string,
    cwd: string
  ) => Effect.Effect<ChildProcess, BashSpawnFailed>
  readonly signalTree: (proc: ChildProcess, signal: NodeJS.Signals) => Effect.Effect<void>
}

type SendEvent = (event: BashStreamEvent) => Effect.Effect<void, BashWindowMissing>
type SendEventBestEffort = (event: BashStreamEvent) => Effect.Effect<void>

function getColorEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORCE_COLOR: '3',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLICOLOR_FORCE: '1'
  }
}

const isAlive = (proc: ChildProcess): boolean => proc.exitCode === null && proc.signalCode === null

const waitForExit = (proc: ChildProcess) => {
  if (!isAlive(proc)) return Effect.void

  return Effect.async<void>((resume, signal) => {
    let settled = false

    const cleanup = (): void => {
      proc.off('close', onExit)
      proc.off('exit', onExit)
      signal.removeEventListener('abort', onAbort)
    }

    const settle = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(Effect.void)
    }

    const onExit = (): void => settle()
    const onAbort = (): void => settle()

    proc.once('close', onExit)
    proc.once('exit', onExit)
    signal.addEventListener('abort', onAbort, { once: true })

    return Effect.sync(cleanup)
  })
}

const waitForCloseOrError = (proc: ChildProcess, ready: Deferred.Deferred<void>) =>
  Effect.async<CloseOutcome>((resume, signal) => {
    let settled = false

    const cleanup = (): void => {
      proc.off('close', onClose)
      proc.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }

    const settle = (outcome: CloseOutcome): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(Effect.succeed(outcome))
    }

    const onClose = (code: number | null): void => settle({ _tag: 'closed', code })
    const onError = (error: Error): void => settle({ _tag: 'error', error })
    const onAbort = (): void => {
      if (settled) return
      cleanup()
    }

    proc.once('close', onClose)
    proc.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    Effect.runFork(Deferred.succeed(ready, undefined))

    return Effect.sync(cleanup)
  })

const procToStream = (proc: ChildProcess, ready: Deferred.Deferred<void>) =>
  Stream.asyncPush<string>(
    (emit) =>
      Effect.gen(function* () {
        const onStdout = (chunk: Buffer | string): void => {
          emit.single(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk))
        }
        const onStderr = (chunk: Buffer | string): void => {
          emit.single(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk))
        }
        const onEnd = (): void => {
          emit.end()
        }
        const onError = (error: Error): void => {
          emit.single(error.message ?? String(error))
          emit.end()
        }
        const cleanup = (): void => {
          proc.stdout?.off('data', onStdout)
          proc.stderr?.off('data', onStderr)
          proc.off('close', onEnd)
          proc.off('error', onError)
        }

        proc.stdout?.on('data', onStdout)
        proc.stderr?.on('data', onStderr)
        proc.once('close', onEnd)
        proc.once('error', onError)

        yield* Deferred.succeed(ready, undefined)
        yield* Effect.addFinalizer(() => Effect.sync(cleanup))
      }),
    { bufferSize: 'unbounded' }
  )

const appendOutput = (run: ActiveRun, chunk: string, spawner: SpawnerApi) =>
  Effect.gen(function* () {
    if (run.status === 'truncated') return { data: '', done: true }

    const chunkBytes = Buffer.byteLength(chunk, 'utf-8')
    const remaining = OUTPUT_BYTES_LIMIT - run.outputBytes
    if (chunkBytes <= remaining) {
      run.outputBuffer += chunk
      run.outputBytes += chunkBytes
      return { data: chunk, done: false }
    }

    const allowed =
      remaining > 0 ? Buffer.from(chunk, 'utf-8').subarray(0, remaining).toString('utf-8') : ''
    const data = `${allowed}${TRUNCATION_SENTINEL}`

    if (allowed.length > 0) {
      run.outputBuffer += allowed
      run.outputBytes += Buffer.byteLength(allowed, 'utf-8')
    }

    run.outputBuffer += TRUNCATION_SENTINEL
    run.outputBytes += Buffer.byteLength(TRUNCATION_SENTINEL, 'utf-8')
    run.status = 'truncated'
    run.abortRequested = true

    if (run.proc) {
      yield* spawner.signalTree(run.proc, 'SIGKILL')
    }

    return { data, done: true }
  })

const streamOutput = (
  run: ActiveRun,
  proc: ChildProcess,
  ready: Deferred.Deferred<void>,
  spawner: SpawnerApi,
  sendBestEffort: SendEventBestEffort
) =>
  procToStream(proc, ready).pipe(
    Stream.groupedWithin(Number.MAX_SAFE_INTEGER, '16 millis'),
    Stream.map((chunks) => Chunk.toReadonlyArray(chunks).join('')),
    Stream.mapEffect((chunk) => appendOutput(run, chunk, spawner)),
    Stream.tap((result) =>
      result.data.length > 0
        ? sendBestEffort({
            type: 'output',
            sessionId: run.sessionId,
            runId: run.id,
            data: result.data
          })
        : Effect.void
    ),
    Stream.takeUntil((result) => result.done),
    Stream.runDrain
  )

const releaseProcess = (run: ActiveRun, proc: ChildProcess, spawner: SpawnerApi) =>
  Effect.gen(function* () {
    if (!isAlive(proc) || run.proc !== proc) return

    yield* spawner.signalTree(proc, 'SIGTERM')
    yield* waitForExit(proc).pipe(
      Effect.timeout('2 seconds'),
      Effect.catchTag('TimeoutException', () => spawner.signalTree(proc, 'SIGKILL')),
      Effect.catchAll(() => Effect.void)
    )
  }).pipe(Effect.catchAll(() => Effect.void))

const runLifecycle = (
  runs: Map<string, ActiveRun>,
  run: ActiveRun,
  proc: ChildProcess,
  ready: Deferred.Deferred<void>,
  spawner: SpawnerApi,
  sendBestEffort: SendEventBestEffort
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => releaseProcess(run, proc, spawner))

      const closeReady = yield* Deferred.make<void>()
      const outputReady = yield* Deferred.make<void>()
      const closeFiber = yield* waitForCloseOrError(proc, closeReady).pipe(Effect.forkScoped)
      const outputFiber = yield* streamOutput(run, proc, outputReady, spawner, sendBestEffort).pipe(
        Effect.forkScoped
      )

      yield* Deferred.await(closeReady)
      yield* Deferred.await(outputReady)
      yield* Deferred.succeed(ready, undefined)

      const outcome = yield* closeFiber
      yield* outputFiber.await

      if (outcome._tag === 'error') {
        const message = outcome.error.message ?? String(outcome.error)
        const result = yield* appendOutput(run, message, spawner)
        if (result.data.length > 0) {
          yield* sendBestEffort({
            type: 'output',
            sessionId: run.sessionId,
            runId: run.id,
            data: result.data
          })
        }
      }

      let finalStatus: 'exited' | 'killed' | 'truncated' | 'error' = 'exited'
      if (run.status === 'truncated') {
        finalStatus = 'truncated'
      } else if (outcome._tag === 'error') {
        finalStatus = 'error'
      } else if (run.abortRequested) {
        finalStatus = 'killed'
      }

      run.status = finalStatus
      run.exitCode = outcome._tag === 'closed' ? (outcome.code ?? undefined) : run.exitCode
      run.proc = undefined

      yield* Effect.logInfo('Bash run finished', {
        sessionId: run.sessionId,
        runId: run.id,
        status: finalStatus,
        exitCode: run.exitCode
      })

      yield* sendBestEffort({
        type: 'end',
        sessionId: run.sessionId,
        runId: run.id,
        status: finalStatus,
        exitCode: run.exitCode
      })

      runs.set(run.sessionId, run)
    })
  ).pipe(
    Effect.catchAllCause((cause) => Effect.logError('Bash lifecycle failed', Cause.squash(cause)))
  )

const snapshot = (run: ActiveRun): BashRunSnapshot => ({
  sessionId: run.sessionId,
  id: run.id,
  command: run.command,
  cwd: run.cwd,
  startedAt: run.startedAt,
  status: run.status,
  outputBuffer: run.outputBuffer,
  outputBytes: run.outputBytes,
  exitCode: run.exitCode
})

export const BashLive = Layer.effect(
  Bash,
  Effect.gen(function* () {
    const runsRef = yield* Ref.make(new Map<string, ActiveRun>())
    const spawner = yield* Spawner
    const eventSink = yield* EventSink
    const send: SendEvent = (event) => eventSink.send(event)
    const sendBestEffort: SendEventBestEffort = (event) =>
      send(event).pipe(Effect.catchAll(() => Effect.void))

    const run = (sessionId: string, command: string, cwd: string) =>
      Effect.gen(function* () {
        const runs = yield* Ref.get(runsRef)
        const existing = runs.get(sessionId)
        if (existing && existing.status === 'running') {
          return yield* Effect.fail(new BashAlreadyRunning({ sessionId }))
        }

        const proc = yield* spawner.spawn(sessionId, command, cwd)
        const runId = randomUUID()
        const startedAt = Date.now()
        const active: ActiveRun = {
          sessionId,
          id: runId,
          command,
          cwd,
          startedAt,
          status: 'running',
          outputBuffer: '',
          outputBytes: 0,
          proc
        }

        runs.set(sessionId, active)
        yield* Ref.set(runsRef, runs)

        yield* send({
          type: 'start',
          sessionId,
          runId,
          command,
          cwd,
          startedAt
        }).pipe(
          Effect.tapError(() => spawner.signalTree(proc, 'SIGKILL')),
          Effect.tapError(() =>
            Effect.sync(() => {
              runs.delete(sessionId)
            })
          )
        )

        const ready = yield* Deferred.make<void>()
        const fiber = yield* runLifecycle(runs, active, proc, ready, spawner, sendBestEffort).pipe(
          Effect.forkDaemon
        )
        active.fiber = fiber
        yield* Deferred.await(ready)

        yield* Effect.logInfo('Bash run started', { sessionId, runId, command, cwd, pid: proc.pid })
        return { runId }
      }).pipe(Effect.withSpan('bash.run'))

    const abort = (sessionId: string) =>
      Effect.gen(function* () {
        const runs = yield* Ref.get(runsRef)
        const active = runs.get(sessionId)
        if (!active || active.status !== 'running' || !active.proc) return false

        active.abortRequested = true
        yield* spawner.signalTree(active.proc, 'SIGTERM')
        yield* waitForExit(active.proc).pipe(
          Effect.timeout('2 seconds'),
          Effect.catchTag('TimeoutException', () => spawner.signalTree(active.proc!, 'SIGKILL'))
        )

        return true
      }).pipe(Effect.withSpan('bash.abort'))

    const getRun = (sessionId: string) =>
      Ref.get(runsRef).pipe(
        Effect.map((runs) => {
          const active = runs.get(sessionId)
          return active ? snapshot(active) : null
        })
      )

    const killAll = Effect.gen(function* () {
      const runs = yield* Ref.get(runsRef)

      for (const active of runs.values()) {
        active.abortRequested = true
        if (active.proc && active.status === 'running') {
          yield* spawner.signalTree(active.proc, 'SIGKILL')
          active.proc = undefined
        }
        if (active.fiber) {
          yield* Fiber.interrupt(active.fiber).pipe(Effect.asVoid)
        }
      }

      runs.clear()
      yield* Ref.set(runsRef, runs)
    }).pipe(Effect.withSpan('bash.killAll'))

    return { run, abort, getRun, killAll }
  })
)

export const EventSinkLive = (windowRef: { current: BrowserWindow | null }) =>
  Layer.succeed(EventSink, {
    send: (event: BashStreamEvent) =>
      Effect.gen(function* () {
        const win = windowRef.current
        if (!win) {
          return yield* Effect.fail(new BashWindowMissing({ reason: 'not-set' }))
        }
        if (win.isDestroyed()) {
          return yield* Effect.fail(new BashWindowMissing({ reason: 'destroyed' }))
        }
        yield* Effect.sync(() => {
          win.webContents.send('bash:stream', event)
        })
      })
  })

export const SpawnerLive = Layer.succeed(Spawner, {
  spawn: (sessionId: string, command: string, cwd: string) =>
    Effect.try({
      try: () => {
        const proc = spawn('sh', ['-c', command], {
          cwd,
          env: getColorEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32'
        })
        proc.stdin?.end()
        return proc
      },
      catch: (cause) => new BashSpawnFailed({ sessionId, command, cause })
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
          {
            pid,
            signal
          }
        )
        try {
          proc.kill(signal)
        } catch {
          // already dead
        }
      }
    })
})

export const AppLive = (windowRef: { current: BrowserWindow | null }) =>
  Layer.provide(BashLive, Layer.mergeAll(EventSinkLive(windowRef), SpawnerLive))
