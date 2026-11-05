/**
 * Microphone capture for voice dictation, in the HUD window's renderer.
 *
 * Mirrors Wispelker's AudioRecorder: raw input (no echo cancellation, noise
 * suppression or gain control), Float32 mono at 16 kHz, a level reading per
 * ~96 ms chunk using the same dB mapping, samples accumulated until stop, and
 * the recording surviving an input-device change.
 *
 * Dev/test only: when the main process hands over a test clip (launched with
 * TEDOOO_CODE_VOICE_TEST_CLIPS), the clip is played in real time into the same
 * worklet instead of the microphone, so levels, chunking and stop handling are
 * exercised exactly as with a mic. After the clip ends the input stays silent,
 * like a quiet room, until the dictation is stopped.
 */

import type { VoiceCaptureStartOptions, VoiceTestCaptureClip } from '@shared/types/voice'

export const TARGET_SAMPLE_RATE = 16000
/** 1536 samples at 16 kHz ≈ 96 ms, close to Wispelker's 4096-frame tap at 48 kHz. */
const CHUNK_SAMPLES = 1536

const WORKLET_SOURCE = `
class VoicePcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(${CHUNK_SAMPLES})
    this.length = 0
    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.emit(true)
      }
    }
  }
  emit(final) {
    const chunk = this.buffer.subarray(0, this.length).slice()
    let energy = 0
    for (let i = 0; i < chunk.length; i++) energy += chunk[i] * chunk[i]
    const rms = chunk.length ? Math.sqrt(energy / chunk.length) : 0
    const level = Math.min(1, Math.max(0, (20 * Math.log10(Math.max(rms, 1e-6)) + 50) / 44))
    this.port.postMessage({ pcm: chunk, level, final: !!final }, [chunk.buffer])
    this.buffer = new Float32Array(${CHUNK_SAMPLES})
    this.length = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.length++] = channel[i]
      if (this.length === this.buffer.length) this.emit(false)
    }
    return true
  }
}
registerProcessor('voice-pcm-capture', VoicePcmCapture)
`

let workletUrl: string | null = null

function getWorkletUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  }
  return workletUrl
}

export interface CapturedAudio {
  readonly samples: Float32Array
  readonly sampleRate: number
}

export class VoiceRecorder {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private clipPlayer: AudioBufferSourceNode | null = null
  private clipFloor: ConstantSourceNode | null = null
  private chunks: Float32Array[] = []
  private flushWaiter: (() => void) | null = null
  private active = false

  onLevel: ((level: number) => void) | null = null

  /**
   * Every captured chunk, in order, as it is recorded (including the partial
   * one flushed at stop, before `stop()` resolves). Together the chunks are
   * exactly the samples `stop()` returns, before any resampling.
   */
  onChunk: ((samples: Float32Array, sampleRate: number) => void) | null = null

  get isActive(): boolean {
    return this.active
  }

  /** The test clip has played to its end (dev/test only). */
  onTestClipEnded: (() => void) | null = null

  async start(options?: VoiceCaptureStartOptions): Promise<void> {
    if (this.active) return
    this.chunks = []
    this.active = true
    try {
      const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      this.context = context
      await context.audioWorklet.addModule(getWorkletUrl())
      const node = new AudioWorkletNode(context, 'voice-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit'
      })
      node.port.onmessage = (
        event: MessageEvent<{ pcm: Float32Array; level: number; final: boolean }>
      ) => {
        const data = event.data
        if (!this.active && !data.final) return
        if (data.pcm.length > 0) {
          this.chunks.push(data.pcm)
          try {
            this.onChunk?.(data.pcm, context.sampleRate)
          } catch {
            // Streaming is best effort; the recording itself must carry on.
          }
        }
        if (!data.final) this.onLevel?.(data.level)
        if (data.final && this.flushWaiter) {
          const waiter = this.flushWaiter
          this.flushWaiter = null
          waiter()
        }
      }
      this.node = node
      // The worklet outputs silence; it still has to be connected so the graph pulls it.
      node.connect(context.destination)
      if (options && 'testClip' in options) {
        this.attachTestClip(options.testClip ?? null)
      } else {
        await this.attachInput()
      }
      if (context.state !== 'running') await context.resume()
    } catch (error) {
      this.teardown()
      this.active = false
      throw error
    }
  }

  /** Open the microphone and route it into the worklet; re-run after a device change. */
  private async attachInput(): Promise<void> {
    const context = this.context
    const node = this.node
    if (!context || !node) return
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: TARGET_SAMPLE_RATE },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    })
    if (!this.active) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    this.stream = stream
    const source = new MediaStreamAudioSourceNode(context, { mediaStream: stream })
    source.connect(node)
    this.source = source
    for (const track of stream.getAudioTracks()) {
      track.onended = () => {
        if (!this.active || this.stream !== stream) return
        // Input device vanished mid-recording: keep what we have and try to
        // continue on the new default device.
        this.detachInput()
        this.attachInput().catch(() => {
          this.onInterrupted?.()
        })
      }
    }
  }

  onInterrupted: (() => void) | null = null

  /** Dev/test only: play the clip into the worklet in place of the microphone. */
  private attachTestClip(clip: VoiceTestCaptureClip | null): void {
    const context = this.context
    const node = this.node
    if (!context || !node) return
    if (!clip) throw new Error('No test clip selected')
    const buffer = context.createBuffer(1, Math.max(1, clip.samples.length), clip.sampleRate)
    buffer.copyToChannel(new Float32Array(clip.samples), 0)
    const player = new AudioBufferSourceNode(context, { buffer })
    // Zeros once the clip is over, so the worklet keeps receiving input in real
    // time (like a quiet microphone) until the dictation is stopped.
    const floor = new ConstantSourceNode(context, { offset: 0 })
    player.connect(node)
    floor.connect(node)
    player.onended = () => {
      if (this.active && this.clipPlayer === player) this.onTestClipEnded?.()
    }
    this.clipPlayer = player
    this.clipFloor = floor
    floor.start()
    player.start()
  }

  private detachTestClip(): void {
    for (const source of [this.clipPlayer, this.clipFloor]) {
      if (!source) continue
      source.onended = null
      try {
        source.stop()
      } catch {
        // never started
      }
      try {
        source.disconnect()
      } catch {
        // ignore
      }
    }
    this.clipPlayer = null
    this.clipFloor = null
  }

  private detachInput(): void {
    try {
      this.source?.disconnect()
    } catch {
      // ignore
    }
    this.source = null
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.onended = null
        track.stop()
      }
    }
    this.stream = null
  }

  /** Stop capturing and return everything recorded, resampled to 16 kHz if needed. */
  async stop(): Promise<CapturedAudio> {
    if (!this.active) return { samples: new Float32Array(0), sampleRate: TARGET_SAMPLE_RATE }
    const context = this.context
    const node = this.node
    // Ask the worklet for its partial buffer before tearing the graph down.
    if (node) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.flushWaiter = null
          resolve()
        }, 300)
        this.flushWaiter = () => {
          clearTimeout(timer)
          resolve()
        }
        node.port.postMessage('flush')
      })
    }
    this.active = false
    const sourceRate = context?.sampleRate ?? TARGET_SAMPLE_RATE
    this.teardown()

    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const samples = new Float32Array(total)
    let offset = 0
    for (const chunk of this.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []

    if (sourceRate === TARGET_SAMPLE_RATE || samples.length === 0) {
      return { samples, sampleRate: sourceRate }
    }
    return {
      samples: await resample(samples, sourceRate, TARGET_SAMPLE_RATE),
      sampleRate: TARGET_SAMPLE_RATE
    }
  }

  cancel(): void {
    this.active = false
    this.chunks = []
    this.teardown()
  }

  private teardown(): void {
    this.detachInput()
    this.detachTestClip()
    try {
      this.node?.disconnect()
    } catch {
      // ignore
    }
    if (this.node) this.node.port.onmessage = null
    this.node = null
    const context = this.context
    this.context = null
    if (context) {
      void context.close().catch(() => {})
    }
  }
}

/** Chromium's sinc resampler via OfflineAudioContext (far better than linear interpolation). */
async function resample(samples: Float32Array, from: number, to: number): Promise<Float32Array> {
  const length = Math.ceil((samples.length * to) / from)
  const offline = new OfflineAudioContext(1, length, to)
  const buffer = offline.createBuffer(1, samples.length, from)
  buffer.copyToChannel(new Float32Array(samples), 0)
  const source = offline.createBufferSource()
  source.buffer = buffer
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}
