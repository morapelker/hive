import type { VoiceSpeechModelId } from '@shared/types/voice'
import type { VoiceCleanupAiResult } from './voice-cleanup'

/** One stable message name per dictation, so `grep "Dictation summary"` finds them all. */
export const DICTATION_SUMMARY_MESSAGE = 'Dictation summary'

export type DictationOutcome = 'delivered' | 'discarded' | 'cancelled' | 'failed'

/** Which path produced the text. The streaming tickets add `streamed` and `fallback`. */
export type DictationTextSource = 'whole-clip'

/** The AI step, as far as the dictation got. The skip ticket adds `skipped`. */
export type DictationAiStep = VoiceCleanupAiResult

export type DictationDelivery = 'pasted' | 'copied'

/**
 * The per-dictation summary log line. Flat, timings in whole milliseconds, a
 * field is `null` when its step never happened. Never carries transcript text.
 */
export type DictationSummary = {
  outcome: DictationOutcome
  /** Short code for why a dictation was discarded, cancelled or failed. */
  reason: string | null
  speechModel: VoiceSpeechModelId
  streamed: boolean
  textSource: DictationTextSource | null
  /** Length of the clip the HUD delivered. */
  audioMs: number | null
  /** Start press → the HUD reports the microphone open. */
  startToCaptureMs: number | null
  /** Start press → stop press. */
  recordMs: number | null
  /** Stop press → final transcript ready. */
  stopToTranscriptMs: number | null
  /** Time the recogniser spent decoding (reported by the engine). */
  decodeMs: number | null
  aiStep: DictationAiStep
  aiMs: number | null
  /** Stop press → text handed to its target. */
  stopToDeliveredMs: number | null
  /** Start press → this line. */
  totalMs: number
  delivery: DictationDelivery | null
  chars: number | null
}

export type DictationClock = () => number

const monotonicNow: DictationClock = () => performance.now()

/**
 * Collects one dictation's timings as it runs and produces its summary once.
 * All times come from one monotonic clock, so the derived durations are
 * consistent with each other (stop → delivered ≥ stop → transcript, and so on).
 */
export class DictationTrace {
  private readonly startedAt: number
  private captureAt: number | null = null
  private stopAt: number | null = null
  private transcriptAt: number | null = null
  private aiStartedAt: number | null = null
  private deliveredAt: number | null = null
  private audioMs: number | null = null
  private decodeMs: number | null = null
  private textSource: DictationTextSource | null = null
  private aiStep: DictationAiStep = 'not-applicable'
  private aiMs: number | null = null
  private delivery: DictationDelivery | null = null
  private chars: number | null = null
  private finished = false

  constructor(
    private readonly speechModel: VoiceSpeechModelId,
    private readonly now: DictationClock = monotonicNow
  ) {
    this.startedAt = now()
  }

  get isFinished(): boolean {
    return this.finished
  }

  /** The microphone is open. Only the first report counts. */
  markCaptureStarted(): void {
    this.captureAt ??= this.now()
  }

  markStop(): void {
    this.stopAt ??= this.now()
  }

  setAudio(samples: number, sampleRate: number): void {
    this.audioMs = Math.round((samples / Math.max(1, sampleRate)) * 1000)
  }

  markTranscript(source: DictationTextSource, decodeMs: number | null): void {
    this.transcriptAt = this.now()
    this.textSource = source
    this.decodeMs = decodeMs === null || !Number.isFinite(decodeMs) ? null : Math.round(decodeMs)
  }

  markAiStarted(): void {
    this.aiStartedAt = this.now()
  }

  markAiFinished(step: DictationAiStep): void {
    this.aiStep = step
    // Only a step that actually asked a model has a duration worth reporting.
    this.aiMs =
      this.aiStartedAt !== null && (step === 'cleaned' || step === 'timed-out' || step === 'failed')
        ? this.elapsed(this.aiStartedAt, this.now())
        : null
  }

  markDelivered(delivery: DictationDelivery, chars: number): void {
    this.deliveredAt = this.now()
    this.delivery = delivery
    this.chars = chars
  }

  /** The summary, the first time only; later calls return null so a dictation logs once. */
  finish(outcome: DictationOutcome, reason: string | null = null): DictationSummary | null {
    if (this.finished) return null
    this.finished = true
    const end = this.now()
    return {
      outcome,
      reason,
      speechModel: this.speechModel,
      streamed: false,
      textSource: this.textSource,
      audioMs: this.audioMs,
      startToCaptureMs: this.since(this.startedAt, this.captureAt),
      recordMs: this.since(this.startedAt, this.stopAt),
      stopToTranscriptMs: this.since(this.stopAt, this.transcriptAt),
      decodeMs: this.decodeMs,
      aiStep: this.aiStep,
      aiMs: this.aiMs,
      stopToDeliveredMs: this.since(this.stopAt, this.deliveredAt),
      totalMs: this.elapsed(this.startedAt, end),
      delivery: this.delivery,
      chars: this.chars
    }
  }

  private since(from: number | null, to: number | null): number | null {
    return from === null || to === null ? null : this.elapsed(from, to)
  }

  private elapsed(from: number, to: number): number {
    return Math.max(0, Math.round(to - from))
  }
}
