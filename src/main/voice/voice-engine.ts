import { utilityProcess } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { cpus } from 'os'
import { join } from 'path'
import { findVoiceSpeechModel, type VoiceSpeechModelId } from '@shared/types/voice'
import { createLogger } from '../services/logger'
import {
  isVoiceEngineEvent,
  isVoiceEngineResponse,
  type VoiceEngineEvent,
  type VoiceEngineRequest,
  type VoiceEngineResponse,
  type VoiceEngineStreamResultResponse
} from './voice-engine-protocol'

const log = createLogger({ component: 'VoiceEngine' })

const LOAD_TIMEOUT_MS = 120_000
const TRANSCRIBE_TIMEOUT_MS = 120_000
/** The worker answers `stream-start` as soon as it reads it. */
const STREAM_START_TIMEOUT_MS = 10_000
/**
 * A finish normally takes well under 150 ms. The floor covers a busy machine;
 * the per-second share covers a worker that fell behind and still has audio to
 * decode (decoding runs at roughly 7–12% of real time).
 */
const STREAM_FINISH_TIMEOUT_FLOOR_MS = 10_000
const STREAM_FINISH_TIMEOUT_PER_AUDIO_SECOND_MS = 250
const DEFAULT_STREAM_SAMPLE_RATE = 16_000

interface Pending {
  readonly resolve: (response: VoiceEngineResponse) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

export interface VoiceTranscription {
  readonly text: string
  readonly decodeMs: number
}

/** A catalog speech model and where its files are. */
export interface VoiceEngineModel {
  readonly id: VoiceSpeechModelId
  /** The model's folder, i.e. `voiceModelStore.getModelDir(id)`. */
  readonly dir: string
}

export interface VoiceStreamResult {
  /** Final transcript, trimmed. Empty only when nothing was said. */
  readonly text: string
  /** `finish()` → final text in the main process, including IPC and any audio still queued. */
  readonly finishMs: number
  /** The worker's own flush time (tail padding plus the last decode steps). */
  readonly workerFinishMs: number
  /** Decode steps the flush needed: 1–2 normally, more if the worker had fallen behind. */
  readonly finishDecodes: number
  /** Audio the session received, excluding the engine's padding. */
  readonly audioMs: number
  /** Worker time spent decoding this session (the CPU cost of streaming). */
  readonly busyMs: number
}

export interface VoiceStreamSessionOptions {
  /** Sample rate of every pushed chunk; fixed for the session. Default 16 kHz. */
  readonly sampleRate?: number
  /** The full transcript so far, each time it changes (at most about twice a second). */
  readonly onUpdate?: (text: string) => void
  /**
   * The session failed (load error, session error, engine crash, unload or a
   * worker that stopped answering). Called once, asynchronously, so it may call
   * back into the engine (e.g. `ensureLoaded` to reload). Not called on cancel.
   */
  readonly onError?: (error: Error) => void
}

/**
 * A live transcription session on a streaming speech model. Created
 * synchronously; audio pushed before the model has loaded is held and fed in
 * order once it has, so nothing is lost on a cold start.
 */
export interface VoiceStreamSession {
  readonly id: string
  /** The first failure, if the session failed. */
  readonly error: Error | null
  /**
   * Queue the next chunk (any length, in order). Never throws. Chunks pushed
   * after `finish()` or `cancel()`, or after a failure, are ignored.
   */
  push(samples: Float32Array): void
  /**
   * Flush and return the final transcript. Idempotent. Rejects with the
   * session's error if it failed, or with a {@link VoiceStreamCancelledError}
   * if it was cancelled or replaced by a newer session.
   */
  finish(): Promise<VoiceStreamResult>
  /** Drop the session without a result. Idempotent; never throws. */
  cancel(): void
}

/** The session was cancelled or replaced: not a failure, so no fallback is needed. */
export class VoiceStreamCancelledError extends Error {
  constructor(message = 'The streaming session was cancelled') {
    super(message)
    this.name = 'VoiceStreamCancelledError'
  }
}

export function isVoiceStreamCancelled(error: unknown): error is VoiceStreamCancelledError {
  return error instanceof VoiceStreamCancelledError
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** What a session needs from the engine (kept narrow so the session can't reach its internals). */
interface SessionHost {
  ensureLoaded(model: VoiceEngineModel): Promise<void>
  /** Posts `stream-start` right away; the promise settles with the worker's answer. */
  openStream(model: VoiceEngineModel, sessionId: string, sampleRate: number): Promise<void>
  postAudio(sessionId: string, samples: Float32Array): void
  requestFinish(sessionId: string, timeoutMs: number): Promise<VoiceEngineStreamResultResponse>
  postCancel(sessionId: string): void
  sessionEnded(session: EngineStreamSession): void
}

class EngineStreamSession implements VoiceStreamSession {
  readonly id = randomUUID()
  private readonly sampleRate: number
  /** Audio pushed before the worker's stream was opened (cold start). */
  private queue: Float32Array[] = []
  private samplesPushed = 0
  private lateChunks = 0
  /** `stream-start` was sent: audio goes straight to the worker from now on. */
  private opened = false
  private finishing = false
  /** Finished, cancelled or failed. */
  private closed = false
  private failure: Error | null = null
  private ready: Promise<void> = Promise.resolve()
  private finishPromise: Promise<VoiceStreamResult> | null = null
  private rejectFinish: ((error: Error) => void) | null = null

  constructor(
    private readonly host: SessionHost,
    readonly model: VoiceEngineModel,
    private readonly options: VoiceStreamSessionOptions
  ) {
    this.sampleRate = options.sampleRate ?? DEFAULT_STREAM_SAMPLE_RATE
  }

  get error(): Error | null {
    return this.failure
  }

  start(): void {
    // Deferred so even an immediate failure reaches `onError` after the
    // caller has its handle, never from inside `startSession()`.
    this.ready = Promise.resolve().then(() => this.open())
  }

  private async open(): Promise<void> {
    // Cancelled before it got going: nothing to load or open.
    if (this.closed) return
    try {
      const info = findVoiceSpeechModel(this.model.id)
      if (!info.streaming) {
        throw new Error(`${info.name} cannot transcribe while you speak`)
      }
      if (
        !Number.isFinite(this.sampleRate) ||
        this.sampleRate < 8000 ||
        this.sampleRate > 192_000
      ) {
        throw new Error(`Unsupported sample rate ${this.sampleRate}`)
      }
      await this.host.ensureLoaded(this.model)
      if (this.closed) return
      const started = this.host.openStream(this.model, this.id, this.sampleRate)
      this.opened = true
      // The worker handles messages in order, so the held audio lands right
      // after the stream opens and before anything pushed later.
      for (const chunk of this.queue.splice(0)) this.host.postAudio(this.id, chunk)
      await started
    } catch (error) {
      this.fail(toError(error))
    }
  }

  push(samples: Float32Array): void {
    if (this.closed || this.finishing) {
      this.lateChunks++
      if (this.lateChunks === 1) {
        log.warn('Ignoring audio pushed after the session ended', { sessionId: this.id })
      }
      return
    }
    if (!(samples instanceof Float32Array) || samples.length === 0) return
    this.samplesPushed += samples.length
    if (this.opened) {
      this.host.postAudio(this.id, samples)
    } else {
      // Copied: the caller may reuse its buffer before the model has loaded.
      this.queue.push(samples.slice())
    }
  }

  finish(): Promise<VoiceStreamResult> {
    if (this.finishPromise) return this.finishPromise
    if (this.closed) {
      this.finishPromise = Promise.reject(this.failure ?? new VoiceStreamCancelledError())
      return this.finishPromise
    }
    this.finishing = true
    const started = Date.now()
    const audioSeconds = this.samplesPushed / this.sampleRate
    const timeoutMs =
      STREAM_FINISH_TIMEOUT_FLOOR_MS + audioSeconds * STREAM_FINISH_TIMEOUT_PER_AUDIO_SECOND_MS
    this.finishPromise = new Promise<VoiceStreamResult>((resolve, reject) => {
      this.rejectFinish = reject
      this.ready
        .then(() => {
          if (this.closed) throw this.failure ?? new VoiceStreamCancelledError()
          return this.host.requestFinish(this.id, timeoutMs)
        })
        .then(
          (response) => {
            if (this.closed) {
              // Cancelled while the worker was flushing: the rejection already went out.
              reject(this.failure ?? new VoiceStreamCancelledError())
              return
            }
            this.closed = true
            this.host.sessionEnded(this)
            const result: VoiceStreamResult = {
              text: response.text.trim(),
              finishMs: Date.now() - started,
              workerFinishMs: Math.round(response.finishMs),
              finishDecodes: response.finishDecodes,
              audioMs: Math.round(response.audioMs),
              busyMs: Math.round(response.busyMs)
            }
            log.info('Streaming session finished', {
              audioMs: result.audioMs,
              finishMs: result.finishMs,
              workerFinishMs: result.workerFinishMs,
              finishDecodes: result.finishDecodes,
              busyMs: result.busyMs,
              chars: result.text.length
            })
            resolve(result)
          },
          (error: unknown) => {
            const failure = toError(error)
            this.fail(failure)
            reject(this.failure ?? failure)
          }
        )
    })
    return this.finishPromise
  }

  cancel(): void {
    if (this.closed) return
    this.closed = true
    this.queue = []
    if (this.opened) this.host.postCancel(this.id)
    this.rejectFinish?.(new VoiceStreamCancelledError())
    this.host.sessionEnded(this)
  }

  /** The session failed: reject `finish()` and tell the caller once. */
  fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    this.queue = []
    // Frees the worker's stream if the worker is still alive and still has it.
    if (this.opened) this.host.postCancel(this.id)
    this.rejectFinish?.(error)
    this.host.sessionEnded(this)
    log.warn('Streaming session failed', { sessionId: this.id, error: error.message })
    const onError = this.options.onError
    if (!onError) return
    // Delivered on a microtask: a failure is often found while the engine is
    // tearing a worker down, and a listener that calls back into the engine
    // (to reload the model, say) must see it finished, not half done.
    queueMicrotask(() => {
      try {
        onError(error)
      } catch (listenerError) {
        log.warn('session error listener failed', { error: String(listenerError) })
      }
    })
  }

  handleEvent(event: VoiceEngineEvent): void {
    if (this.closed) return
    if (event.type === 'stream-error') {
      this.fail(new Error(event.message))
      return
    }
    try {
      this.options.onUpdate?.(event.text)
    } catch (error) {
      log.warn('session update listener failed', { error: String(error) })
    }
  }
}

/**
 * Main-process client for the voice engine utility process. The recogniser is
 * loaded lazily (ideally while the user is still speaking), reused across
 * dictations, and unloaded after an idle period so the app does not sit on
 * ~1.4 GB of model memory all day.
 *
 * Offline models (Parakeet) transcribe finished clips. Streaming models
 * (Nemotron) also transcribe finished clips, and additionally run one live
 * session at a time ({@link startSession}).
 */
export class VoiceEngine {
  private child: Electron.UtilityProcess | null = null
  private pending = new Map<string, Pending>()
  private loadedModelDir: string | null = null
  private loading: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private idleMinutes = 10
  private listeners = new Set<(loaded: boolean) => void>()
  private session: EngineStreamSession | null = null

  onLoadedChange(listener: (loaded: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get isLoaded(): boolean {
    return this.child !== null && this.loadedModelDir !== null
  }

  /** The loaded model's folder, or null. */
  get loadedModel(): string | null {
    return this.loadedModelDir
  }

  setIdleUnloadMinutes(minutes: number): void {
    this.idleMinutes = Math.max(0, minutes)
    this.touch()
  }

  /**
   * Load (or switch to) `model`. Whether it is loaded as an offline or a
   * streaming recogniser comes from the speech-model catalog. Concurrent calls
   * share one load.
   */
  async ensureLoaded(model: VoiceEngineModel): Promise<void> {
    if (this.isLoaded && this.loadedModelDir === model.dir) {
      this.touch()
      return
    }
    if (this.loading) {
      await this.loading
      if (this.loadedModelDir === model.dir) return
    }
    this.loading = this.load(model).finally(() => {
      this.loading = null
    })
    await this.loading
  }

  private async load(model: VoiceEngineModel): Promise<void> {
    const streaming = findVoiceSpeechModel(model.id).streaming
    if (this.child && this.loadedModelDir !== null && this.loadedModelDir !== model.dir) {
      // One speech model in memory at a time: a recogniser is only really
      // freed when its process exits, so a switch gets a fresh worker. A
      // session waiting for this very model survives the switch.
      this.stopWorker('switching speech model', new Error('The speech model changed'), model.dir)
    }
    const child = this.spawn()
    const started = Date.now()
    const numThreads = Math.max(2, Math.min(4, Math.floor((cpus().length || 4) / 2)))
    const response = await this.request(
      child,
      { type: 'load', id: randomUUID(), modelDir: model.dir, numThreads, streaming },
      LOAD_TIMEOUT_MS,
      { replaceWorkerOnTimeout: true }
    )
    if (response.type !== 'loaded') {
      throw new Error(`Unexpected engine response ${response.type}`)
    }
    this.loadedModelDir = model.dir
    log.info('Speech model loaded', {
      modelDir: model.dir,
      streaming,
      loadMs: Date.now() - started,
      sherpaVersion: response.version,
      numThreads
    })
    this.notify(true)
    this.touch()
  }

  /** Transcribe a finished clip with the loaded model (offline or streaming). */
  async transcribe(samples: Float32Array, sampleRate: number): Promise<VoiceTranscription> {
    const child = this.child
    if (!child || !this.loadedModelDir) {
      throw new Error('Speech model is not ready yet')
    }
    this.touch()
    const response = await this.request(
      child,
      { type: 'transcribe', id: randomUUID(), samples, sampleRate },
      TRANSCRIBE_TIMEOUT_MS
    )
    if (response.type !== 'result') {
      throw new Error(`Unexpected engine response ${response.type}`)
    }
    this.touch()
    return { text: response.text, decodeMs: response.decodeMs }
  }

  /**
   * Start a live transcription session on a streaming model, loading it first
   * if needed. Any session still open is cancelled: there is one at a time.
   * The model stays loaded (no idle unload) while the session is open.
   */
  startSession(
    model: VoiceEngineModel,
    options: VoiceStreamSessionOptions = {}
  ): VoiceStreamSession {
    this.session?.cancel()
    const session = new EngineStreamSession(this.sessionHost, model, options)
    this.session = session
    session.start()
    return session
  }

  private readonly sessionHost: SessionHost = {
    ensureLoaded: (model) => this.ensureLoaded(model),
    openStream: (model, sessionId, sampleRate) => {
      const child = this.child
      if (!child || this.loadedModelDir !== model.dir) {
        return Promise.reject(new Error('Speech model is not ready yet'))
      }
      return this.request(
        child,
        { type: 'stream-start', id: randomUUID(), sessionId, sampleRate },
        STREAM_START_TIMEOUT_MS,
        { replaceWorkerOnTimeout: true }
      ).then((response) => {
        if (response.type !== 'stream-started') {
          throw new Error(`Unexpected engine response ${response.type}`)
        }
      })
    },
    postAudio: (sessionId, samples) => {
      this.post({ type: 'stream-audio', sessionId, samples })
    },
    requestFinish: async (sessionId, timeoutMs) => {
      const child = this.child
      if (!child) throw new Error('Speech engine is not running')
      const response = await this.request(
        child,
        { type: 'stream-finish', id: randomUUID(), sessionId },
        timeoutMs,
        { replaceWorkerOnTimeout: true }
      )
      if (response.type !== 'stream-result') {
        throw new Error(`Unexpected engine response ${response.type}`)
      }
      return response
    },
    postCancel: (sessionId) => {
      this.post({ type: 'stream-cancel', sessionId })
    },
    sessionEnded: (session) => {
      if (this.session !== session) return
      this.session = null
      this.touch()
    }
  }

  /** Kill the worker and drop the model from memory. Fails an open session. */
  unload(reason: string): void {
    this.stopWorker(reason, new Error('Speech engine was unloaded'), null)
  }

  /**
   * Kill the worker: pending requests and the open session fail with `error`,
   * except a session for `keepSessionFor`, which has not reached a worker yet.
   */
  private stopWorker(reason: string, error: Error, keepSessionFor: string | null): void {
    if (!this.child) return
    log.info('Unloading speech model', { reason })
    const child = this.child
    this.child = null
    this.loadedModelDir = null
    this.clearIdleTimer()
    this.rejectAll(error)
    if (this.session && this.session.model.dir !== keepSessionFor) this.session.fail(error)
    try {
      child.kill()
    } catch {
      // Already gone.
    }
    this.notify(false)
  }

  dispose(): void {
    this.session?.cancel()
    this.unload('shutdown')
    this.listeners.clear()
  }

  private spawn(): Electron.UtilityProcess {
    if (this.child) return this.child
    const scriptPath = resolveWorkerScriptPath()
    log.info('Starting voice engine worker', { scriptPath })
    const child = utilityProcess.fork(scriptPath, [], {
      serviceName: 'voice-engine',
      stdio: 'pipe'
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) log.debug('engine stdout', { text })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) log.warn('engine stderr', { text })
    })
    child.on('message', (message: unknown) => {
      if (this.child !== child) return
      if (isVoiceEngineEvent(message)) {
        if (this.session?.id === message.sessionId) this.session.handleEvent(message)
        return
      }
      if (!isVoiceEngineResponse(message)) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.type === 'error') {
        pending.reject(new Error(message.message))
      } else {
        pending.resolve(message)
      }
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      log.warn('Voice engine worker exited', { code })
      this.child = null
      this.loadedModelDir = null
      this.clearIdleTimer()
      const error = new Error(`Speech engine exited (code ${code})`)
      this.rejectAll(error)
      this.session?.fail(error)
      this.notify(false)
    })
    this.child = child
    return child
  }

  /** Fire-and-forget message to the running worker (dropped if there is none). */
  private post(message: VoiceEngineRequest): void {
    const child = this.child
    if (!child) return
    try {
      child.postMessage(message)
    } catch (error) {
      log.warn('engine postMessage failed', { type: message.type, error: String(error) })
    }
  }

  /**
   * Send `message` and wait for its answer. With `replaceWorkerOnTimeout`, a
   * missed deadline means the worker is stuck or in an unknown state (a load
   * still running, a native call that never returns), so it is killed rather
   * than reused: the next load starts a fresh one.
   */
  private request(
    child: Electron.UtilityProcess,
    message: VoiceEngineRequest & { readonly id: string },
    timeoutMs: number,
    { replaceWorkerOnTimeout = false }: { replaceWorkerOnTimeout?: boolean } = {}
  ): Promise<VoiceEngineResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        const error = new Error(
          `Speech engine did not answer within ${Math.round(timeoutMs / 1000)}s`
        )
        reject(error)
        if (replaceWorkerOnTimeout && this.child === child) {
          this.stopWorker(`no answer to ${message.type}`, error, null)
        }
      }, timeoutMs)
      this.pending.set(message.id, { resolve, reject, timer })
      try {
        child.postMessage(message)
      } catch (error) {
        this.pending.delete(message.id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private touch(): void {
    this.clearIdleTimer()
    if (!this.child || this.idleMinutes <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      // Never unload under a request or an open session (a long dictation
      // has no request in flight between its start and its finish).
      if (this.pending.size > 0 || this.session) {
        this.touch()
        return
      }
      this.unload(`idle for ${this.idleMinutes} min`)
    }, this.idleMinutes * 60_000)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private notify(loaded: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(loaded)
      } catch (error) {
        log.warn('engine listener failed', { error: String(error) })
      }
    }
  }
}

/**
 * The worker bundle sits next to the main bundle. Inside a packaged app it is
 * unpacked from the asar (electron-builder `asarUnpack`) so the utility
 * process can load it and the native sherpa-onnx addon next to it.
 */
export function resolveWorkerScriptPath(): string {
  const plain = join(__dirname, 'voice-engine-worker.js')
  if (__dirname.includes('app.asar')) {
    const unpacked = join(
      __dirname.replace('app.asar', 'app.asar.unpacked'),
      'voice-engine-worker.js'
    )
    if (existsSync(unpacked)) return unpacked
  }
  return plain
}

export const voiceEngine = new VoiceEngine()
