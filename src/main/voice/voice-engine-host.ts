/**
 * The voice engine worker's logic: loads one speech model (an offline
 * Parakeet-style transducer or an online/streaming Nemotron-style one),
 * transcribes whole clips with either, and runs one streaming session at a
 * time on a streaming model.
 *
 * Kept apart from the utility-process entry (voice-engine-worker.ts) so tests
 * can drive it in-process with a fake or the real sherpa-onnx module.
 * Worker-only: the main process must never import it (see voice-windows.ts).
 */
import { join } from 'path'
import { OnlineTranscriptStream, transcribeClipOnline } from './voice-online-stream'
import type { SherpaOnlineRecognizer } from './voice-online-stream'
import { splitIntoWindows } from './voice-windows'
import type { VoiceEngineMessage, VoiceEngineRequest } from './voice-engine-protocol'

export interface SherpaOfflineStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
}

export interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream
  decodeAsync(stream: SherpaOfflineStream): Promise<{ text: string }>
}

export interface SherpaModule {
  version: string
  OfflineRecognizer: {
    createAsync(config: unknown): Promise<SherpaOfflineRecognizer>
  }
  /** Synchronous: construction blocks for about a second while the model loads. */
  OnlineRecognizer: new (config: unknown) => SherpaOnlineRecognizer
}

export interface VoiceEngineHostDeps {
  post(message: VoiceEngineMessage): void
  loadSherpa(): SherpaModule
  /** Called after an unload so the process can exit and free the model's native memory. */
  exit(): void
  /** Lets other messages through during a long whole-clip decode. */
  yieldToEventLoop?(): Promise<void>
}

type LoadedModel =
  | {
      readonly kind: 'offline'
      readonly modelDir: string
      readonly recognizer: SherpaOfflineRecognizer
    }
  | {
      readonly kind: 'streaming'
      readonly modelDir: string
      readonly recognizer: SherpaOnlineRecognizer
    }

interface OpenSession {
  readonly id: string
  readonly stream: OnlineTranscriptStream
}

/** Warm-up audio decoded right after loading a streaming model. */
const WARM_UP_SECONDS = 1

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toFloat32(samples: unknown): Float32Array {
  // Structured clone delivers a Float32Array; guard against plain objects from
  // a mismatched build so the native addon never sees garbage (an Int16Array,
  // for example, would be silently misread as floats).
  if (samples instanceof Float32Array) return samples
  if (Array.isArray(samples)) return Float32Array.from(samples as number[])
  throw new Error('Audio must be a Float32Array')
}

function modelFiles(modelDir: string): {
  transducer: { encoder: string; decoder: string; joiner: string }
  tokens: string
} {
  return {
    transducer: {
      encoder: join(modelDir, 'encoder.int8.onnx'),
      decoder: join(modelDir, 'decoder.int8.onnx'),
      joiner: join(modelDir, 'joiner.int8.onnx')
    },
    tokens: join(modelDir, 'tokens.txt')
  }
}

export class VoiceEngineHost {
  private sherpa: SherpaModule | null = null
  private model: LoadedModel | null = null
  private session: OpenSession | null = null
  /** The last session that failed on its own, so its finish reports why. */
  private failedSession: { readonly id: string; readonly message: string } | null = null
  /**
   * Bumped by every load and unload. An offline load awaits the native
   * loader; if the main process gave up on it and sent another load (or an
   * unload) meanwhile, the late result must not replace the newer state.
   */
  private loadGeneration = 0

  constructor(private readonly deps: VoiceEngineHostDeps) {}

  /** Handle one message from the main process. Never throws. */
  handle(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const message = raw as VoiceEngineRequest
    switch (message.type) {
      case 'load':
        if (typeof message.id !== 'string') return
        this.run(message.id, () =>
          this.load(message.id, message.modelDir, message.numThreads, message.streaming === true)
        )
        return
      case 'transcribe':
        if (typeof message.id !== 'string') return
        this.run(message.id, () => this.transcribe(message.id, message.samples, message.sampleRate))
        return
      case 'unload':
        if (typeof message.id !== 'string') return
        this.loadGeneration++
        this.dropSession()
        this.model = null
        this.deps.post({ type: 'unloaded', id: message.id })
        // The parent kills the process afterwards; exiting here frees the
        // native memory immediately even if it does not.
        this.deps.exit()
        return
      // Session messages are handled synchronously, so audio, finish and
      // cancel always apply in the order they were sent.
      case 'stream-start':
        if (typeof message.id !== 'string' || typeof message.sessionId !== 'string') return
        this.runSync(message.id, () =>
          this.startSession(message.id, message.sessionId, message.sampleRate)
        )
        return
      case 'stream-audio':
        if (typeof message.sessionId !== 'string') return
        this.acceptAudio(message.sessionId, message.samples)
        return
      case 'stream-finish':
        if (typeof message.id !== 'string' || typeof message.sessionId !== 'string') return
        this.runSync(message.id, () => this.finishSession(message.id, message.sessionId))
        return
      case 'stream-cancel':
        if (this.session && this.session.id === message.sessionId) this.dropSession()
        return
    }
  }

  // ---- model --------------------------------------------------------------------------------

  private async load(
    id: string,
    modelDir: string,
    numThreads: number,
    streaming: boolean
  ): Promise<void> {
    const generation = ++this.loadGeneration
    const sherpa = this.loadSherpa()
    const kind = streaming ? 'streaming' : 'offline'
    if (this.model && this.model.modelDir === modelDir && this.model.kind === kind) {
      this.deps.post({ type: 'loaded', id, loadMs: 0, version: sherpa.version })
      return
    }
    const started = Date.now()
    if (this.session) this.failSession(this.session.id, 'The speech model changed')
    this.model = null
    const threads = Math.max(1, Math.min(8, Math.round(numThreads)))
    if (streaming) {
      // featureDim is read from the model itself (128 for Nemotron); modelType
      // is not used by online NeMo transducers. Only greedy search is
      // supported for them; anything else ends the process.
      const recognizer = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 128 },
        modelConfig: { ...modelFiles(modelDir), numThreads: threads, provider: 'cpu', debug: 0 },
        decodingMethod: 'greedy_search',
        enableEndpoint: 0
      })
      warmUp(recognizer)
      this.model = { kind: 'streaming', modelDir, recognizer }
    } else {
      const recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          ...modelFiles(modelDir),
          numThreads: threads,
          provider: 'cpu',
          debug: 0,
          modelType: 'nemo_transducer'
        },
        decodingMethod: 'greedy_search'
      })
      if (generation !== this.loadGeneration) {
        throw new Error('A newer speech model load replaced this one')
      }
      this.model = { kind: 'offline', modelDir, recognizer }
    }
    this.deps.post({ type: 'loaded', id, loadMs: Date.now() - started, version: sherpa.version })
  }

  private loadSherpa(): SherpaModule {
    if (!this.sherpa) this.sherpa = this.deps.loadSherpa()
    return this.sherpa
  }

  // ---- whole clip ---------------------------------------------------------------------------

  private async transcribe(id: string, rawSamples: unknown, sampleRate: number): Promise<void> {
    const model = this.model
    if (!model) throw new Error('Speech model is not loaded')
    const samples = toFloat32(rawSamples)
    const started = Date.now()
    let text: string
    if (model.kind === 'streaming') {
      text = await transcribeClipOnline(model.recognizer, samples, sampleRate, () =>
        this.yieldToEventLoop()
      )
    } else {
      const parts: string[] = []
      for (const window of splitIntoWindows(samples, sampleRate)) {
        const stream = model.recognizer.createStream()
        stream.acceptWaveform({ samples: window, sampleRate })
        const result = await model.recognizer.decodeAsync(stream)
        const part = (result.text ?? '').trim()
        if (part) parts.push(part)
      }
      text = parts.join(' ')
    }
    this.deps.post({ type: 'result', id, text, decodeMs: Date.now() - started })
  }

  private yieldToEventLoop(): Promise<void> {
    if (this.deps.yieldToEventLoop) return this.deps.yieldToEventLoop()
    return new Promise((resolve) => setImmediate(resolve))
  }

  // ---- streaming session --------------------------------------------------------------------

  private startSession(id: string, sessionId: string, sampleRate: number): void {
    const model = this.model
    if (!model) throw new Error('Speech model is not loaded')
    if (model.kind !== 'streaming') {
      throw new Error('The loaded speech model cannot transcribe while you speak')
    }
    // One session at a time: a new one replaces whatever was left open.
    this.dropSession()
    this.failedSession = null
    this.session = {
      id: sessionId,
      stream: new OnlineTranscriptStream(model.recognizer, sampleRate)
    }
    this.deps.post({ type: 'stream-started', id, sessionId })
  }

  private acceptAudio(sessionId: string, rawSamples: unknown): void {
    const session = this.session
    // Audio for a cancelled, finished or replaced session is late, not an error.
    if (!session || session.id !== sessionId) return
    try {
      const text = session.stream.accept(toFloat32(rawSamples))
      if (text !== null) this.deps.post({ type: 'stream-partial', sessionId, text })
    } catch (error) {
      this.failSession(sessionId, errorMessage(error))
    }
  }

  private finishSession(id: string, sessionId: string): void {
    const session = this.session
    if (!session || session.id !== sessionId) {
      if (this.failedSession?.id === sessionId) throw new Error(this.failedSession.message)
      throw new Error('No open streaming session')
    }
    this.session = null
    const result = session.stream.finish()
    this.deps.post({
      type: 'stream-result',
      id,
      sessionId,
      text: result.text,
      finishMs: result.finishMs,
      finishDecodes: result.decodes,
      audioMs: session.stream.audioMs,
      busyMs: session.stream.busyMs
    })
  }

  private failSession(sessionId: string, message: string): void {
    if (this.session?.id === sessionId) this.dropSession()
    this.failedSession = { id: sessionId, message }
    this.deps.post({ type: 'stream-error', sessionId, message })
  }

  private dropSession(): void {
    const session = this.session
    this.session = null
    session?.stream.close()
  }

  // ---- plumbing -----------------------------------------------------------------------------

  private run(id: string, task: () => Promise<void>): void {
    task().catch((error: unknown) => {
      this.deps.post({ type: 'error', id, message: errorMessage(error) })
    })
  }

  private runSync(id: string, task: () => void): void {
    try {
      task()
    } catch (error) {
      this.deps.post({ type: 'error', id, message: errorMessage(error) })
    }
  }
}

/** One throwaway decode so the first dictation's steps are not the first ones the model runs. */
function warmUp(recognizer: SherpaOnlineRecognizer): void {
  const stream = new OnlineTranscriptStream(recognizer, 16000)
  try {
    stream.accept(new Float32Array(WARM_UP_SECONDS * 16000))
    stream.finish()
  } finally {
    stream.close()
  }
}
