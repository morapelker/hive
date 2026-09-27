import { utilityProcess } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { cpus } from 'os'
import { join } from 'path'
import { createLogger } from '../services/logger'
import {
  isVoiceEngineResponse,
  type VoiceEngineRequest,
  type VoiceEngineResponse
} from './voice-engine-protocol'

const log = createLogger({ component: 'VoiceEngine' })

const LOAD_TIMEOUT_MS = 120_000
const TRANSCRIBE_TIMEOUT_MS = 120_000

interface Pending {
  readonly resolve: (response: VoiceEngineResponse) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

export interface VoiceTranscription {
  readonly text: string
  readonly decodeMs: number
}

/**
 * Main-process client for the voice engine utility process. The recogniser is
 * loaded lazily (ideally while the user is still speaking), reused across
 * dictations, and unloaded after an idle period so the app does not sit on
 * ~1.4 GB of model memory all day.
 */
export class VoiceEngine {
  private child: Electron.UtilityProcess | null = null
  private pending = new Map<string, Pending>()
  private loadedModelDir: string | null = null
  private loading: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private idleMinutes = 10
  private listeners = new Set<(loaded: boolean) => void>()

  onLoadedChange(listener: (loaded: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get isLoaded(): boolean {
    return this.child !== null && this.loadedModelDir !== null
  }

  get loadedModel(): string | null {
    return this.loadedModelDir
  }

  setIdleUnloadMinutes(minutes: number): void {
    this.idleMinutes = Math.max(0, minutes)
    this.touch()
  }

  /** Load (or switch to) the model in `modelDir`. Concurrent calls share one load. */
  async ensureLoaded(modelDir: string): Promise<void> {
    if (this.isLoaded && this.loadedModelDir === modelDir) {
      this.touch()
      return
    }
    if (this.loading) {
      await this.loading
      if (this.loadedModelDir === modelDir) return
    }
    this.loading = this.load(modelDir).finally(() => {
      this.loading = null
    })
    await this.loading
  }

  private async load(modelDir: string): Promise<void> {
    const child = this.spawn()
    const started = Date.now()
    const numThreads = Math.max(2, Math.min(4, Math.floor((cpus().length || 4) / 2)))
    const response = await this.request(
      child,
      { type: 'load', id: randomUUID(), modelDir, numThreads },
      LOAD_TIMEOUT_MS
    )
    if (response.type !== 'loaded') {
      throw new Error(`Unexpected engine response ${response.type}`)
    }
    this.loadedModelDir = modelDir
    log.info('Speech model loaded', {
      modelDir,
      loadMs: Date.now() - started,
      sherpaVersion: response.version,
      numThreads
    })
    this.notify(true)
    this.touch()
  }

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

  /** Kill the worker and drop the model from memory. */
  unload(reason: string): void {
    if (!this.child) return
    log.info('Unloading speech model', { reason })
    const child = this.child
    this.child = null
    this.loadedModelDir = null
    this.clearIdleTimer()
    this.rejectAll(new Error('Speech engine was unloaded'))
    try {
      child.kill()
    } catch {
      // Already gone.
    }
    this.notify(false)
  }

  dispose(): void {
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
      this.rejectAll(new Error(`Speech engine exited (code ${code})`))
      this.notify(false)
    })
    this.child = child
    return child
  }

  private request(
    child: Electron.UtilityProcess,
    message: VoiceEngineRequest,
    timeoutMs: number
  ): Promise<VoiceEngineResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error(`Speech engine did not answer within ${Math.round(timeoutMs / 1000)}s`))
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
      if (this.pending.size > 0) {
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
