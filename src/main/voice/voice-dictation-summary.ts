import type { VoiceCleanupResult, VoiceSkipInput, VoiceSpeechModelId } from '@shared/types/voice'

/** One stable message name per dictation, so `grep "Dictation summary"` finds them all. */
export const DICTATION_SUMMARY_MESSAGE = 'Dictation summary'

export type DictationOutcome = 'delivered' | 'discarded' | 'cancelled' | 'failed'

/**
 * Which path produced the text: `streamed` is the streaming session's final
 * text; `fallback` is the whole clip, transcribed because the session could not
 * be used (VOICE-06); `whole-clip` is an offline speech model.
 */
export type DictationTextSource = 'streamed' | 'fallback' | 'whole-clip'

/**
 * Why a streamed dictation's text came from the whole clip instead:
 * - `engine-exited`: the speech engine process crashed or was killed;
 * - `session-error`: the session failed any other way (load error, unload,
 *   no answer in time, an error in the worker);
 * - `stream-broken`: the HUD's audio arrived with a gap or at another sample rate;
 * - `stream-cancelled`: the session was cancelled while the dictation still needed it;
 * - `incomplete-audio`: the session got a different amount of audio than the clip holds;
 * - `empty-text`: the session heard no words, though the clip passed the speech checks.
 */
export type DictationFallbackReason =
  | 'engine-exited'
  | 'session-error'
  | 'stream-broken'
  | 'stream-cancelled'
  | 'incomplete-audio'
  | 'empty-text'

/** The AI step, as far as the dictation got; `skipped` when the user skipped polishing (VOICE-08). */
export type DictationAiStep = VoiceCleanupResult

/** AI steps that asked a model, so their duration is worth reporting. */
const TIMED_AI_STEPS: ReadonlySet<DictationAiStep> = new Set([
  'cleaned',
  'skipped',
  'timed-out',
  'failed'
])

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
  /** A streaming session ran alongside the recording (streaming speech models). */
  streamed: boolean
  textSource: DictationTextSource | null
  /** Set when `textSource` is `fallback`. */
  fallbackReason: DictationFallbackReason | null
  /** Length of the clip the HUD delivered. */
  audioMs: number | null
  /** Start press → the HUD reports the microphone open. */
  startToCaptureMs: number | null
  /** Live transcript updates passed on to the HUD while recording; null when not streamed. */
  previewUpdates: number | null
  /** Microphone open → the first live transcript update passed on to the HUD. */
  captureToPreviewMs: number | null
  /** Start press → stop press. */
  recordMs: number | null
  /** Stop press → final transcript ready. */
  stopToTranscriptMs: number | null
  /**
   * Time the recogniser spent decoding (reported by the engine): the whole clip,
   * or for a streamed transcript the final flush at stop.
   */
  decodeMs: number | null
  aiStep: DictationAiStep
  /** AI step start → its result, or → the skip when the user skipped it. */
  aiMs: number | null
  /** How polishing was skipped; null unless `aiStep` is `skipped`. */
  skipInput: VoiceSkipInput | null
  /** Skip pressed → text handed to its target. */
  skipToDeliveredMs: number | null
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
  private fallbackReason: DictationFallbackReason | null = null
  private streamed = false
  private previewUpdates = 0
  private firstPreviewAt: number | null = null
  private aiStep: DictationAiStep = 'not-applicable'
  private aiMs: number | null = null
  private skipAt: number | null = null
  private skipInput: VoiceSkipInput | null = null
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

  /** A streaming session was opened for this dictation. */
  markStreamed(): void {
    this.streamed = true
  }

  /** A live transcript update went to the HUD. */
  markPreview(): void {
    this.previewUpdates++
    this.firstPreviewAt ??= this.now()
  }

  markStop(): void {
    this.stopAt ??= this.now()
  }

  setAudio(samples: number, sampleRate: number): void {
    this.audioMs = Math.round((samples / Math.max(1, sampleRate)) * 1000)
  }

  markTranscript(
    source: DictationTextSource,
    decodeMs: number | null,
    fallbackReason: DictationFallbackReason | null = null
  ): void {
    this.transcriptAt = this.now()
    this.textSource = source
    this.fallbackReason = source === 'fallback' ? fallbackReason : null
    this.decodeMs = decodeMs === null || !Number.isFinite(decodeMs) ? null : Math.round(decodeMs)
  }

  markAiStarted(): void {
    this.aiStartedAt = this.now()
  }

  markAiFinished(step: DictationAiStep): void {
    this.aiStep = step
    // Only a step that actually asked a model has a duration worth reporting.
    this.aiMs =
      this.aiStartedAt !== null && TIMED_AI_STEPS.has(step)
        ? this.elapsed(this.aiStartedAt, this.now())
        : null
  }

  /** The user skipped polishing: the AI step ends here, with the shown text. */
  markAiSkipped(input: VoiceSkipInput): void {
    this.skipAt = this.now()
    this.skipInput = input
    this.markAiFinished('skipped')
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
      streamed: this.streamed,
      textSource: this.textSource,
      fallbackReason: this.fallbackReason,
      audioMs: this.audioMs,
      startToCaptureMs: this.since(this.startedAt, this.captureAt),
      previewUpdates: this.streamed ? this.previewUpdates : null,
      captureToPreviewMs: this.since(this.captureAt, this.firstPreviewAt),
      recordMs: this.since(this.startedAt, this.stopAt),
      stopToTranscriptMs: this.since(this.stopAt, this.transcriptAt),
      decodeMs: this.decodeMs,
      aiStep: this.aiStep,
      aiMs: this.aiMs,
      skipInput: this.aiStep === 'skipped' ? this.skipInput : null,
      skipToDeliveredMs:
        this.aiStep === 'skipped' ? this.since(this.skipAt, this.deliveredAt) : null,
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
