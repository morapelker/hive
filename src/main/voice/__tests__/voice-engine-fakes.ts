/**
 * Test doubles for the voice engine: a fake sherpa-onnx module whose online
 * recogniser mimics the real one's chunking, and a fake utility-process child
 * that can be wired in-process to the real worker host.
 */
import { EventEmitter } from 'events'
import type { VoiceEngineMessage, VoiceEngineRequest } from '../voice-engine-protocol'
import {
  VoiceEngineHost,
  type SherpaModule,
  type SherpaOfflineRecognizer
} from '../voice-engine-host'
import type { SherpaOnlineRecognizer, SherpaOnlineStream } from '../voice-online-stream'

// ---- fake speech ----------------------------------------------------------------------------

/**
 * Fake "speech": each word is a run of samples holding the word's code value,
 * with silence (zeros) between words. The fake recognisers read it back.
 */
const VOCABULARY = [
  'hello',
  'can',
  'you',
  'rename',
  'this',
  'branch',
  'to',
  'main',
  'open',
  'the',
  'terminal',
  'then',
  'run',
  'all',
  'tests',
  'again'
]
const WORD_BASE = 0.2
const WORD_STEP = 0.02

export const FAKE_RATE = 16_000

function wordValue(word: string): number {
  const index = VOCABULARY.indexOf(word)
  if (index < 0) throw new Error(`fake vocabulary has no "${word}"`)
  return WORD_BASE + index * WORD_STEP
}

function wordAt(value: number): string | null {
  if (value < WORD_BASE - WORD_STEP / 2) return null
  return VOCABULARY[Math.round((value - WORD_BASE) / WORD_STEP)] ?? null
}

export function fakeSpeech(
  words: string[],
  { wordSeconds = 0.3, gapSeconds = 0.15, rate = FAKE_RATE } = {}
): Float32Array {
  const wordLength = Math.round(wordSeconds * rate)
  const gapLength = Math.round(gapSeconds * rate)
  const samples = new Float32Array(words.length * (wordLength + gapLength))
  words.forEach((word, i) => {
    const start = i * (wordLength + gapLength)
    samples.fill(wordValue(word), start, start + wordLength)
  })
  return samples
}

export function silence(seconds: number, rate = FAKE_RATE): Float32Array {
  return new Float32Array(Math.round(seconds * rate))
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Words in `samples[from, to)` whose run ends inside the range (complete words only). */
function readWords(samples: number[], from: number, to: number, skipStartBefore = 0): string[] {
  const words: string[] = []
  let i = from
  while (i < to) {
    const word = wordAt(samples[i])
    if (!word) {
      i++
      continue
    }
    const start = i
    while (i < to && samples[i] === samples[start]) i++
    const complete = i < samples.length ? samples[i] !== samples[start] : true
    if (complete && i <= to && start >= skipStartBefore) words.push(word)
    if (!complete) break
  }
  return words
}

// ---- fake online recogniser -----------------------------------------------------------------

/** Real model numbers at 16 kHz: a decode needs 10,688 samples of window and moves 8,960. */
const WINDOW_SAMPLES = 10_688
const SHIFT_SAMPLES = 8_960
/** The real model never decodes the first ~90 ms of a stream. */
const UNDECODED_HEAD_SAMPLES = 1_440

export class FakeOnlineStream implements SherpaOnlineStream {
  /** Every acceptWaveform call, in order. */
  readonly accepted: Array<{ length: number; sampleRate: number; zeros: boolean }> = []
  readonly samples: number[] = []
  sampleRate: number | null = null
  inputFinishedCalls = 0
  processed = 0
  decodes = 0
  resetCalls = 0
  poisoned = false

  constructor(private readonly owner: FakeOnlineRecognizer) {}

  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void {
    if (this.owner.failAccept) throw new Error(this.owner.failAccept)
    if (!(input.samples instanceof Float32Array)) throw new Error('should be a typed array')
    // The real recogniser ends the process here; fail loudly so tests catch it.
    if (this.sampleRate !== null && this.sampleRate !== input.sampleRate) {
      throw new Error('FATAL: sample rate changed mid-stream')
    }
    this.sampleRate = input.sampleRate
    let zeros = true
    for (const value of input.samples) {
      if (!Number.isFinite(value)) this.poisoned = true
      if (value !== 0) zeros = false
      this.samples.push(value)
    }
    this.accepted.push({ length: input.samples.length, sampleRate: input.sampleRate, zeros })
  }

  inputFinished(): void {
    this.inputFinishedCalls++
  }
}

export class FakeOnlineRecognizer implements SherpaOnlineRecognizer {
  readonly streams: FakeOnlineStream[] = []
  failAccept: string | null = null

  constructor(readonly config: unknown = {}) {}

  createStream(): FakeOnlineStream {
    const stream = new FakeOnlineStream(this)
    this.streams.push(stream)
    return stream
  }

  isReady(stream: SherpaOnlineStream): boolean {
    const s = stream as FakeOnlineStream
    return s.processed + WINDOW_SAMPLES <= s.samples.length
  }

  decode(stream: SherpaOnlineStream): void {
    // The real recogniser ends the process here; fail loudly so tests catch it.
    if (!this.isReady(stream)) throw new Error('FATAL: decode() on a stream that is not ready')
    const s = stream as FakeOnlineStream
    s.processed += SHIFT_SAMPLES
    s.decodes++
  }

  getResult(stream: SherpaOnlineStream): { text: string } {
    const s = stream as FakeOnlineStream
    if (s.poisoned) throw new SyntaxError('Unexpected token n in JSON ("ys_probs":[nan])')
    const decodedTo = Math.min(s.samples.length, s.processed)
    const words = readWords(s.samples, 0, decodedTo, UNDECODED_HEAD_SAMPLES)
    return { text: words.length ? ` ${words.join(' ')}` : '' }
  }

  reset(stream: SherpaOnlineStream): void {
    const s = stream as FakeOnlineStream
    s.resetCalls++
  }
}

// ---- fake offline recogniser and module -----------------------------------------------------

export class FakeOfflineRecognizer implements SherpaOfflineRecognizer {
  readonly windows: number[] = []

  constructor(readonly config: unknown) {}

  createStream(): { samples: number[]; acceptWaveform(input: { samples: Float32Array }): void } {
    const stream = {
      samples: [] as number[],
      acceptWaveform: (input: { samples: Float32Array }): void => {
        stream.samples.push(...input.samples)
      }
    }
    return stream
  }

  async decodeAsync(stream: unknown): Promise<{ text: string }> {
    const samples = (stream as { samples: number[] }).samples
    this.windows.push(samples.length)
    return { text: readWords(samples, 0, samples.length).join(' ') }
  }
}

export interface FakeSherpa extends SherpaModule {
  readonly online: FakeOnlineRecognizer[]
  readonly offline: FakeOfflineRecognizer[]
  /** Model folders whose load should fail like a missing file does. */
  readonly brokenDirs: Set<string>
  /** Hold offline loads in flight (like a very slow disk) until the returned release is called. */
  holdOfflineLoads(): () => void
}

export function createFakeSherpa(): FakeSherpa {
  const online: FakeOnlineRecognizer[] = []
  const offline: FakeOfflineRecognizer[] = []
  const brokenDirs = new Set<string>()
  let offlineGate: Promise<void> | null = null
  const isBroken = (config: unknown): boolean => {
    const encoder = (config as { modelConfig: { transducer: { encoder: string } } }).modelConfig
      .transducer.encoder
    return [...brokenDirs].some((dir) => encoder.startsWith(dir))
  }
  class OnlineRecognizer extends FakeOnlineRecognizer {
    constructor(config: unknown) {
      if (isBroken(config)) throw new TypeError('Please check your config!')
      super(config)
      online.push(this)
    }
  }
  return {
    version: 'fake-1.0',
    online,
    offline,
    brokenDirs,
    holdOfflineLoads: () => {
      let release = (): void => undefined
      offlineGate = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        offlineGate = null
        release()
      }
    },
    OnlineRecognizer,
    OfflineRecognizer: {
      createAsync: async (config: unknown) => {
        if (offlineGate) await offlineGate
        if (isBroken(config)) throw new TypeError('Please check your config!')
        const recognizer = new FakeOfflineRecognizer(config)
        offline.push(recognizer)
        return recognizer
      }
    }
  }
}

// ---- fake utility process -------------------------------------------------------------------

/** The subset of Electron's UtilityProcess the engine uses. */
export class FakeEngineChild extends EventEmitter {
  readonly sent: VoiceEngineRequest[] = []
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killed = false
  /** Set by {@link connectToHost}: delivers posted messages to an in-process host. */
  deliver: ((message: VoiceEngineRequest) => void) | null = null

  postMessage(message: unknown): void {
    // Like Electron: posting to a dead process is silently dropped.
    if (this.killed) return
    const copy = structuredClone(message) as VoiceEngineRequest
    this.sent.push(copy)
    this.deliver?.(copy)
  }

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    setImmediate(() => this.emit('exit', 0))
    return true
  }

  /** The worker answers (manual mode). */
  reply(message: VoiceEngineMessage): void {
    this.emit('message', message)
  }

  /** The worker dies natively (manual or connected mode). */
  crash(code: number): void {
    this.killed = true
    this.emit('exit', code)
  }

  sentOfType<T extends VoiceEngineRequest['type']>(
    type: T
  ): Array<Extract<VoiceEngineRequest, { type: T }>> {
    return this.sent.filter((m): m is Extract<VoiceEngineRequest, { type: T }> => m.type === type)
  }

  lastOfType<T extends VoiceEngineRequest['type']>(
    type: T
  ): Extract<VoiceEngineRequest, { type: T }> {
    const all = this.sentOfType(type)
    if (all.length === 0) throw new Error(`nothing of type ${type} was sent`)
    return all[all.length - 1]
  }
}

/**
 * Run a real {@link VoiceEngineHost} behind `child`, in-process: messages are
 * structured-cloned and delivered asynchronously and in order both ways, as
 * between Electron's main process and a utility process.
 */
export function connectToHost(child: FakeEngineChild, sherpa: SherpaModule): VoiceEngineHost {
  const host = new VoiceEngineHost({
    post: (message) => {
      const copy = structuredClone(message)
      setImmediate(() => {
        if (!child.killed) child.emit('message', copy)
      })
    },
    loadSherpa: () => sherpa,
    exit: () => {
      setTimeout(() => {
        if (child.killed) return
        child.killed = true
        child.emit('exit', 0)
      }, 5)
    }
  })
  child.deliver = (message) => {
    setImmediate(() => {
      if (!child.killed) host.handle(message)
    })
  }
  return host
}
