import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceRecorder } from '../audio-capture'

/** Just enough Web Audio for VoiceRecorder: records what gets created and connected. */
class FakeNode {
  connections: unknown[] = []
  connect(target: unknown): void {
    this.connections.push(target)
  }
  disconnect(): void {
    this.connections = []
  }
}

class FakeWorkletNode extends FakeNode {
  static last: FakeWorkletNode | null = null
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: vi.fn((message: unknown) => {
      if (message === 'flush') {
        this.port.onmessage?.({ data: { pcm: new Float32Array([0.5]), level: 0, final: true } })
      }
    })
  }
  constructor() {
    super()
    FakeWorkletNode.last = this
  }
  /** What the worklet posts every ~96 ms while audio flows. */
  emit(pcm: Float32Array, level: number): void {
    this.port.onmessage?.({ data: { pcm, level, final: false } })
  }
}

class FakeScheduledSource extends FakeNode {
  onended: (() => void) | null = null
  started = false
  stopped = false
  start(): void {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
}

class FakeBufferSource extends FakeScheduledSource {
  static last: FakeBufferSource | null = null
  buffer: FakeAudioBuffer
  constructor(_context: unknown, options: { buffer: FakeAudioBuffer }) {
    super()
    this.buffer = options.buffer
    FakeBufferSource.last = this
  }
}

class FakeConstantSource extends FakeScheduledSource {
  static last: FakeConstantSource | null = null
  offset: number
  constructor(_context: unknown, options: { offset: number }) {
    super()
    this.offset = options.offset
    FakeConstantSource.last = this
  }
}

class FakeAudioBuffer {
  data: Float32Array | null = null
  constructor(
    readonly channels: number,
    readonly length: number,
    readonly sampleRate: number
  ) {}
  copyToChannel(data: Float32Array): void {
    this.data = data
  }
}

class FakeAudioContext {
  sampleRate: number
  state = 'suspended'
  destination = new FakeNode()
  audioWorklet = { addModule: vi.fn(async () => undefined) }
  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate)
  }
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  close = vi.fn(async () => undefined)
}

class FakeMediaStreamSource extends FakeNode {}

const getUserMedia = vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] }))

describe('VoiceRecorder', () => {
  beforeEach(() => {
    FakeWorkletNode.last = null
    FakeBufferSource.last = null
    FakeConstantSource.last = null
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
    vi.stubGlobal('AudioBufferSourceNode', FakeBufferSource)
    vi.stubGlobal('ConstantSourceNode', FakeConstantSource)
    vi.stubGlobal('MediaStreamAudioSourceNode', FakeMediaStreamSource)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia }
    })
    URL.createObjectURL = vi.fn(() => 'blob:worklet')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'mediaDevices')
    vi.clearAllMocks()
  })

  const clip = {
    name: 'sentence',
    samples: new Float32Array([0.1, 0.2, 0.3]),
    sampleRate: 16000
  }

  it('opens the microphone when no test clip is given', async () => {
    const recorder = new VoiceRecorder()
    await recorder.start()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(FakeBufferSource.last).toBeNull()
    recorder.cancel()
  })

  it('plays a test clip into the capture worklet instead of the microphone', async () => {
    const recorder = new VoiceRecorder()
    await recorder.start({ testClip: clip })

    expect(getUserMedia).not.toHaveBeenCalled()
    const worklet = FakeWorkletNode.last!
    const player = FakeBufferSource.last!
    const floor = FakeConstantSource.last!
    expect(player.buffer.sampleRate).toBe(16000)
    expect(Array.from(player.buffer.data!)).toEqual(Array.from(clip.samples))
    expect(player.connections).toEqual([worklet])
    expect(player.started).toBe(true)
    // Silence keeps flowing after the clip, like a quiet microphone.
    expect(floor.offset).toBe(0)
    expect(floor.connections).toEqual([worklet])
    expect(floor.started).toBe(true)
    recorder.cancel()
  })

  it('reports levels and returns the recorded audio exactly as with a microphone', async () => {
    const recorder = new VoiceRecorder()
    const levels: number[] = []
    recorder.onLevel = (level) => levels.push(level)
    await recorder.start({ testClip: clip })

    FakeWorkletNode.last!.emit(new Float32Array([0.1, 0.2]), 0.7)
    const audio = await recorder.stop()

    expect(levels).toEqual([0.7])
    expect(audio.sampleRate).toBe(16000)
    expect(Array.from(audio.samples)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.5)
    ])
    expect(FakeBufferSource.last!.stopped).toBe(true)
    expect(FakeConstantSource.last!.stopped).toBe(true)
  })

  it('hands over every chunk as it is recorded, the flushed last one before stop resolves', async () => {
    const recorder = new VoiceRecorder()
    const chunks: Array<{ samples: number[]; sampleRate: number }> = []
    recorder.onChunk = (samples, sampleRate) => {
      chunks.push({ samples: Array.from(samples), sampleRate })
    }
    await recorder.start({ testClip: clip })
    const worklet = FakeWorkletNode.last!
    worklet.emit(new Float32Array([0.1, 0.2]), 0.7)
    worklet.emit(new Float32Array([0.3]), 0.4)
    expect(chunks).toHaveLength(2)

    const audio = await recorder.stop()

    expect(chunks.map((c) => c.sampleRate)).toEqual([16000, 16000, 16000])
    // Together the chunks are exactly the clip handed over at stop.
    expect(chunks.flatMap((c) => c.samples)).toEqual(Array.from(audio.samples))
    expect(chunks[2].samples).toEqual([0.5])
  })

  it('keeps recording when the chunk listener throws', async () => {
    const recorder = new VoiceRecorder()
    const levels: number[] = []
    recorder.onLevel = (level) => levels.push(level)
    recorder.onChunk = () => {
      throw new Error('bridge gone')
    }
    await recorder.start({ testClip: clip })
    FakeWorkletNode.last!.emit(new Float32Array([0.1]), 0.6)
    const audio = await recorder.stop()
    expect(levels).toEqual([0.6])
    expect(audio.samples).toHaveLength(2)
  })

  it('hands over nothing after a cancel', async () => {
    const recorder = new VoiceRecorder()
    const onChunk = vi.fn()
    recorder.onChunk = onChunk
    await recorder.start({ testClip: clip })
    const worklet = FakeWorkletNode.last!
    recorder.cancel()
    worklet.emit(new Float32Array([0.1]), 0.5)
    expect(onChunk).not.toHaveBeenCalled()
  })

  it('reports the end of the clip while recording, but not after a cancel', async () => {
    const recorder = new VoiceRecorder()
    const ended = vi.fn()
    recorder.onTestClipEnded = ended
    await recorder.start({ testClip: clip })
    const player = FakeBufferSource.last!
    player.onended?.()
    expect(ended).toHaveBeenCalledTimes(1)

    recorder.cancel()
    expect(player.onended).toBeNull()
  })

  it('fails to start, without opening the microphone, when test clips are on but none is armed', async () => {
    const recorder = new VoiceRecorder()
    await expect(recorder.start({ testClip: null })).rejects.toThrow('No test clip selected')
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(recorder.isActive).toBe(false)
  })
})
