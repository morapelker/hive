/**
 * Streaming (online) transcription with a sherpa-onnx OnlineRecognizer
 * (Nemotron Speech Streaming): one stream per dictation, fed while the user
 * speaks, flushed at stop.
 *
 * Worker-only, like voice-windows.ts: only the engine worker (and tests)
 * import it, so the worker bundle stays self-contained. The main process must
 * never import it, or Rollup moves it into a chunk shared with the main bundle.
 *
 * The online recogniser is synchronous and several misuses end the process
 * natively (`_Exit`, no JS exception): decoding a stream that is not ready, or
 * changing the sample rate mid-stream. Every call here is guarded against both.
 */

export interface SherpaOnlineStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
  inputFinished(): void
}

export interface SherpaOnlineRecognizer {
  createStream(): SherpaOnlineStream
  isReady(stream: SherpaOnlineStream): boolean
  decode(stream: SherpaOnlineStream): void
  getResult(stream: SherpaOnlineStream): { text?: unknown }
  reset(stream: SherpaOnlineStream): void
}

/**
 * Silence fed before the first real sample. The exported model never decodes
 * its first ~90 ms (they only fill the encoder's pre-encode cache), so speech
 * that starts at the very first sample lost its first word; 0.07 s was enough
 * in every test, 0.5 s is sherpa-onnx's own default.
 */
export const STREAM_LEAD_IN_SECONDS = 0.5

/**
 * Silence fed at finish, before `inputFinished()`. A 560 ms model chunk is only
 * decoded once a full window of audio exists past it, so without this the last
 * words never come out. 0.64 s was the shortest tail that kept the last word at
 * every chunk alignment; 0.8 s is the upstream default and still needs at most
 * two decode steps at finish, which keeps finish time flat in session length.
 */
export const STREAM_TAIL_SECONDS = 0.8

/** Whole-clip decoding is fed in slices this long, yielding in between. */
const WHOLE_CLIP_SLICE_SECONDS = 1

const MIN_SAMPLE_RATE = 8000
const MAX_SAMPLE_RATE = 192_000

export interface OnlineStreamFinish {
  readonly text: string
  /** Decode steps the flush needed. */
  readonly decodes: number
  /** Time spent flushing, in ms. */
  readonly finishMs: number
}

function now(): number {
  return performance.now()
}

/** NaN or Infinity poisons the recogniser for the rest of the stream; treat them as silence. */
function sanitize(samples: Float32Array): Float32Array {
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) {
      const clean = new Float32Array(samples.length)
      for (let j = 0; j < samples.length; j++) {
        clean[j] = Number.isFinite(samples[j]) ? samples[j] : 0
      }
      return clean
    }
  }
  return samples
}

/**
 * One streaming transcription. Accepts audio of any size in order, decodes as
 * soon as the model has a full chunk, and reports the transcript when it
 * changes. Transcripts do not depend on how the audio was sliced.
 */
export class OnlineTranscriptStream {
  private stream: SherpaOnlineStream | null
  private text = ''
  private samplesReceived = 0
  private busy = 0

  constructor(
    private readonly recognizer: SherpaOnlineRecognizer,
    readonly sampleRate: number
  ) {
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate < MIN_SAMPLE_RATE ||
      sampleRate > MAX_SAMPLE_RATE
    ) {
      throw new Error(`Unsupported sample rate ${sampleRate}`)
    }
    // Integer rates only: the recogniser truncates, and the lead-in, audio and
    // tail must all be accepted at exactly the same rate.
    this.sampleRate = Math.round(sampleRate)
    const stream = recognizer.createStream()
    this.stream = stream
    const started = now()
    stream.acceptWaveform({
      samples: this.silence(STREAM_LEAD_IN_SECONDS),
      sampleRate: this.sampleRate
    })
    this.busy += now() - started
  }

  /** The transcript so far (trimmed). */
  get currentText(): string {
    return this.text
  }

  /** Real audio received, excluding the lead-in and tail padding. */
  get audioMs(): number {
    return (this.samplesReceived / this.sampleRate) * 1000
  }

  /** Time spent inside the recogniser for this stream. */
  get busyMs(): number {
    return this.busy
  }

  get isOpen(): boolean {
    return this.stream !== null
  }

  /**
   * Accept the next chunk and decode whatever is ready.
   * Returns the full transcript when it changed, otherwise null.
   */
  accept(samples: Float32Array): string | null {
    const stream = this.requireOpen()
    if (samples.length === 0) return null
    const clean = sanitize(samples)
    const started = now()
    try {
      stream.acceptWaveform({ samples: clean, sampleRate: this.sampleRate })
      this.samplesReceived += clean.length
      if (this.drain(stream) === 0) return null
      const text = this.readText(stream)
      if (text === this.text) return null
      this.text = text
      return text
    } finally {
      this.busy += now() - started
    }
  }

  /**
   * Flush with trailing silence and return the final transcript, including the
   * words spoken right before stop. The stream is closed afterwards.
   */
  finish(): OnlineStreamFinish {
    const stream = this.requireOpen()
    const started = now()
    try {
      stream.acceptWaveform({
        samples: this.silence(STREAM_TAIL_SECONDS),
        sampleRate: this.sampleRate
      })
      stream.inputFinished()
      const decodes = this.drain(stream)
      this.text = this.readText(stream)
      return { text: this.text, decodes, finishMs: now() - started }
    } finally {
      this.busy += now() - started
      this.close()
    }
  }

  /** Drop the stream. Idempotent; never throws. */
  close(): void {
    const stream = this.stream
    if (!stream) return
    this.stream = null
    try {
      // Frees the stream's ~7.5 MB of encoder cache now instead of whenever
      // the garbage collector finalises the native handle (it never sees that
      // memory, so it may not run for a long time).
      this.recognizer.reset(stream)
    } catch {
      // Releasing only; the handle is dropped either way.
    }
  }

  private requireOpen(): SherpaOnlineStream {
    if (!this.stream) throw new Error('The streaming session is closed')
    return this.stream
  }

  /** Decode every chunk that is ready. Never decodes a stream that is not ready. */
  private drain(stream: SherpaOnlineStream): number {
    let decodes = 0
    while (this.recognizer.isReady(stream)) {
      this.recognizer.decode(stream)
      decodes++
    }
    return decodes
  }

  private readText(stream: SherpaOnlineStream): string {
    let result: { text?: unknown }
    try {
      result = this.recognizer.getResult(stream)
    } catch (error) {
      throw new Error(
        `Speech recognizer returned an unreadable result (${error instanceof Error ? error.message : String(error)})`
      )
    }
    return typeof result?.text === 'string' ? result.text.trim() : ''
  }

  private silence(seconds: number): Float32Array {
    return new Float32Array(Math.round(seconds * this.sampleRate))
  }
}

/**
 * Transcribe a finished clip with an online recogniser: exactly the streaming
 * path (same padding, same text), fed in slices with a yield between them so a
 * long clip never blocks the worker's message handling for seconds.
 */
export async function transcribeClipOnline(
  recognizer: SherpaOnlineRecognizer,
  samples: Float32Array,
  sampleRate: number,
  yieldToEventLoop: () => Promise<void>
): Promise<string> {
  const stream = new OnlineTranscriptStream(recognizer, sampleRate)
  try {
    const slice = Math.max(1, Math.round(WHOLE_CLIP_SLICE_SECONDS * stream.sampleRate))
    for (let start = 0; start < samples.length; start += slice) {
      stream.accept(samples.subarray(start, start + slice))
      await yieldToEventLoop()
    }
    return stream.finish().text
  } finally {
    stream.close()
  }
}
