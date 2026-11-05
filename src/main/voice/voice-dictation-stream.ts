import type { VoiceAudioChunk } from '@shared/types/voice'
import { createLogger } from '../services/logger'
import type { VoiceStreamResult, VoiceStreamSession } from './voice-engine'

const log = createLogger({ component: 'VoiceDictationStream' })

/**
 * The HUD's audio could not be streamed as recorded (a chunk went missing, or
 * audio came at another sample rate). The session was cancelled; the clip is
 * still whole, so the dictation can fall back to it.
 */
export class DictationStreamBrokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DictationStreamBrokenError'
  }
}

export function isDictationStreamBroken(error: unknown): error is DictationStreamBrokenError {
  return error instanceof DictationStreamBrokenError
}

/** What reached the session so far, whatever became of it. */
export interface DictationStreamProgress {
  readonly chunks: number
  readonly streamedSamples: number
  readonly topUpSamples: number
  readonly sampleRate: number
}

/** What a dictation's stream received and how its session finished. */
export interface DictationStreamResult extends VoiceStreamResult {
  /** Chunks accepted from the HUD while recording. */
  readonly chunks: number
  /** Samples that arrived as chunks. */
  readonly streamedSamples: number
  /** Samples added at stop from the full clip because no chunk carried them. */
  readonly topUpSamples: number
  /** Length of the clip the HUD handed over at stop, in samples. */
  readonly clipSamples: number
  readonly sampleRate: number
}

/**
 * Feeds one dictation's captured audio from the HUD into a streaming engine
 * session while the user speaks (VOICE-05).
 *
 * Chunks arrive numbered; a repeat is dropped, and a gap or a different sample
 * rate breaks the stream (the session is cancelled and `finish` rejects), since
 * a transcript with a hole in it is worse than none. At stop, the full clip is
 * the source of truth: anything it holds beyond what arrived as chunks is
 * pushed before the session is finished, so the last words are never cut off
 * however the final chunk raced the stop.
 */
export class DictationAudioStream {
  private nextSeq = 0
  private chunks = 0
  private streamedSamples = 0
  private topUpSamples = 0
  private duplicates = 0
  private broken: Error | null = null
  /** `finish` or `cancel` was called: later chunks are ignored. */
  private closed = false

  constructor(
    /** Tags this dictation's chunks; chunks with another id are not ours. */
    readonly id: number,
    private readonly session: VoiceStreamSession,
    readonly sampleRate: number
  ) {}

  /** A chunk from the HUD, in arrival order. */
  accept(chunk: VoiceAudioChunk): void {
    if (this.closed || this.broken || chunk.streamId !== this.id) return
    if (chunk.seq < this.nextSeq) {
      this.duplicates++
      if (this.duplicates === 1) {
        log.warn('Dropping a repeated audio chunk', { seq: chunk.seq, expected: this.nextSeq })
      }
      return
    }
    if (chunk.seq > this.nextSeq) {
      this.break(
        new DictationStreamBrokenError(
          `Audio chunk ${this.nextSeq} never arrived (got ${chunk.seq})`
        )
      )
      return
    }
    if (chunk.sampleRate !== this.sampleRate) {
      this.break(
        new DictationStreamBrokenError(
          `Audio arrived at ${chunk.sampleRate} Hz; the session expects ${this.sampleRate}`
        )
      )
      return
    }
    this.nextSeq++
    this.chunks++
    this.streamedSamples += chunk.samples.length
    this.session.push(chunk.samples)
  }

  /** Chunks and samples that reached the session so far (for reports after a failure). */
  get progress(): DictationStreamProgress {
    return {
      chunks: this.chunks,
      streamedSamples: this.streamedSamples,
      topUpSamples: this.topUpSamples,
      sampleRate: this.sampleRate
    }
  }

  /**
   * Recording stopped and `clip` is everything that was captured: push what the
   * chunks did not carry, then finish the session. Rejects if the stream broke
   * ({@link DictationStreamBrokenError}) or the session failed (the session's error).
   */
  async finish(clip: Float32Array, clipSampleRate: number): Promise<DictationStreamResult> {
    if (this.closed) throw new Error('The dictation stream was already closed')
    this.closed = true
    if (this.broken) throw this.broken
    if (clipSampleRate !== this.sampleRate) {
      this.session.cancel()
      throw new DictationStreamBrokenError(
        `The clip is ${clipSampleRate} Hz; the session expects ${this.sampleRate}`
      )
    }
    if (clip.length > this.streamedSamples) {
      // A copy, not a view: a view would send the whole clip's buffer to the engine.
      const tail = clip.slice(this.streamedSamples)
      this.topUpSamples = tail.length
      this.session.push(tail)
    } else if (clip.length < this.streamedSamples) {
      log.warn('More audio was streamed than the clip holds', {
        streamedSamples: this.streamedSamples,
        clipSamples: clip.length
      })
    }
    const result = await this.session.finish()
    return {
      ...result,
      chunks: this.chunks,
      streamedSamples: this.streamedSamples,
      topUpSamples: this.topUpSamples,
      clipSamples: clip.length,
      sampleRate: this.sampleRate
    }
  }

  /** Drop the stream and its session without a result. Idempotent. */
  cancel(): void {
    this.closed = true
    this.session.cancel()
  }

  private break(error: Error): void {
    this.broken = error
    log.warn('Streaming stopped for this dictation', { error: error.message })
    this.session.cancel()
  }
}
