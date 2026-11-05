import type { VoiceAudioChunk } from '@shared/types/voice'
import { createLogger } from '../services/logger'
import type { VoiceStreamResult, VoiceStreamSession } from './voice-engine'

const log = createLogger({ component: 'VoiceDictationStream' })

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
      this.break(new Error(`Audio chunk ${this.nextSeq} never arrived (got ${chunk.seq})`))
      return
    }
    if (chunk.sampleRate !== this.sampleRate) {
      this.break(
        new Error(`Audio arrived at ${chunk.sampleRate} Hz; the session expects ${this.sampleRate}`)
      )
      return
    }
    this.nextSeq++
    this.chunks++
    this.streamedSamples += chunk.samples.length
    this.session.push(chunk.samples)
  }

  /**
   * Recording stopped and `clip` is everything that was captured: push what the
   * chunks did not carry, then finish the session. Rejects if the stream broke
   * or the session failed.
   */
  async finish(clip: Float32Array, clipSampleRate: number): Promise<DictationStreamResult> {
    if (this.closed) throw new Error('The dictation stream was already closed')
    this.closed = true
    if (this.broken) throw this.broken
    if (clipSampleRate !== this.sampleRate) {
      this.session.cancel()
      throw new Error(`The clip is ${clipSampleRate} Hz; the session expects ${this.sampleRate}`)
    }
    let topUpSamples = 0
    if (clip.length > this.streamedSamples) {
      // A copy, not a view: a view would send the whole clip's buffer to the engine.
      const tail = clip.slice(this.streamedSamples)
      topUpSamples = tail.length
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
      topUpSamples,
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
