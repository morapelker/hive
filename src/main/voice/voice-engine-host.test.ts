import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FAKE_RATE,
  concat,
  createFakeSherpa,
  fakeSpeech,
  silence,
  type FakeSherpa
} from './__tests__/voice-engine-fakes'
import { VoiceEngineHost } from './voice-engine-host'
import type { VoiceEngineMessage, VoiceEngineRequest } from './voice-engine-protocol'

const WORDS = ['open', 'the', 'terminal', 'then', 'run', 'all', 'tests', 'again']
const STREAMING_DIR = '/models/nemotron'
const OFFLINE_DIR = '/models/parakeet'

interface Harness {
  readonly host: VoiceEngineHost
  readonly sherpa: FakeSherpa
  readonly posted: VoiceEngineMessage[]
  readonly exit: ReturnType<typeof vi.fn>
  send(message: VoiceEngineRequest): void
  /** Resolves once the reply to request `id` was posted. */
  reply(id: string): Promise<VoiceEngineMessage>
  ofType<T extends VoiceEngineMessage['type']>(
    type: T
  ): Array<Extract<VoiceEngineMessage, { type: T }>>
}

/** `defaultYield` leaves out the injected yield, so the host's own production one runs. */
function createHarness({ defaultYield = false } = {}): Harness {
  const sherpa = createFakeSherpa()
  const posted: VoiceEngineMessage[] = []
  const exit = vi.fn()
  const host = new VoiceEngineHost({
    post: (message) => posted.push(message),
    loadSherpa: () => sherpa,
    exit,
    ...(defaultYield
      ? {}
      : { yieldToEventLoop: () => new Promise<void>((resolve) => setImmediate(resolve)) })
  })
  return {
    host,
    sherpa,
    posted,
    exit,
    send: (message) => host.handle(message),
    reply: async (id) => {
      await vi.waitFor(() => {
        if (!posted.some((m) => 'id' in m && m.id === id)) throw new Error(`no reply to ${id} yet`)
      })
      return posted.find((m) => 'id' in m && m.id === id) as VoiceEngineMessage
    },
    ofType: (type) => posted.filter((m) => m.type === type) as never
  }
}

async function load(h: Harness, streaming: boolean, id = 'load-1'): Promise<VoiceEngineMessage> {
  h.send({
    type: 'load',
    id,
    modelDir: streaming ? STREAMING_DIR : OFFLINE_DIR,
    numThreads: 4,
    streaming
  })
  return h.reply(id)
}

function streamChunks(h: Harness, sessionId: string, samples: Float32Array, size = 1536): void {
  for (let start = 0; start < samples.length; start += size) {
    // Copied, as structured clone would.
    h.send({ type: 'stream-audio', sessionId, samples: samples.slice(start, start + size) })
  }
}

describe('VoiceEngineHost model loading', () => {
  it('loads a streaming model with the online recogniser (feature size from the model, no model type)', async () => {
    const h = createHarness()
    expect(await load(h, true)).toMatchObject({ type: 'loaded', version: 'fake-1.0' })
    expect(h.sherpa.online).toHaveLength(1)
    expect(h.sherpa.offline).toHaveLength(0)
    const config = h.sherpa.online[0].config as Record<string, never>
    expect(config).toMatchObject({
      featConfig: { sampleRate: 16000, featureDim: 128 },
      modelConfig: {
        transducer: {
          encoder: `${STREAMING_DIR}/encoder.int8.onnx`,
          decoder: `${STREAMING_DIR}/decoder.int8.onnx`,
          joiner: `${STREAMING_DIR}/joiner.int8.onnx`
        },
        tokens: `${STREAMING_DIR}/tokens.txt`,
        numThreads: 4,
        provider: 'cpu'
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: 0
    })
    expect(config.modelConfig).not.toHaveProperty('modelType')
  })

  it('warms a streaming model up with one throwaway stream', async () => {
    const h = createHarness()
    await load(h, true)
    const [warmUp] = h.sherpa.online[0].streams
    expect(warmUp.decodes).toBeGreaterThan(0)
    expect(warmUp.resetCalls).toBe(1)
  })

  it('loads an offline model exactly as before', async () => {
    const h = createHarness()
    expect(await load(h, false)).toMatchObject({ type: 'loaded' })
    expect(h.sherpa.online).toHaveLength(0)
    expect(h.sherpa.offline[0].config).toEqual({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: `${OFFLINE_DIR}/encoder.int8.onnx`,
          decoder: `${OFFLINE_DIR}/decoder.int8.onnx`,
          joiner: `${OFFLINE_DIR}/joiner.int8.onnx`
        },
        tokens: `${OFFLINE_DIR}/tokens.txt`,
        numThreads: 4,
        provider: 'cpu',
        debug: 0,
        modelType: 'nemo_transducer'
      },
      decodingMethod: 'greedy_search'
    })
  })

  it('answers a repeated load of the same model without reloading it', async () => {
    const h = createHarness()
    await load(h, true, 'a')
    expect(await load(h, true, 'b')).toMatchObject({ type: 'loaded', loadMs: 0 })
    expect(h.sherpa.online).toHaveLength(1)
  })

  it('reports a model that fails to load as an error', async () => {
    const h = createHarness()
    h.sherpa.brokenDirs.add(STREAMING_DIR)
    expect(await load(h, true)).toEqual({
      type: 'error',
      id: 'load-1',
      message: 'Please check your config!'
    })
    h.send({ type: 'transcribe', id: 't', samples: fakeSpeech(WORDS), sampleRate: FAKE_RATE })
    expect(await h.reply('t')).toMatchObject({
      type: 'error',
      message: 'Speech model is not loaded'
    })
  })

  it('never lets a late offline load replace the model loaded after it', async () => {
    const h = createHarness()
    const release = h.sherpa.holdOfflineLoads()
    h.send({ type: 'load', id: 'slow', modelDir: OFFLINE_DIR, numThreads: 4, streaming: false })
    // The main process gave up on it and loaded the streaming model instead.
    expect(await load(h, true, 'fresh')).toMatchObject({ type: 'loaded' })
    release()
    expect(await h.reply('slow')).toEqual({
      type: 'error',
      id: 'slow',
      message: 'A newer speech model load replaced this one'
    })
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: FAKE_RATE })
    expect(await h.reply('s')).toMatchObject({ type: 'stream-started' })
  })

  it('never lets an offline load that finishes after an unload bring the model back', async () => {
    const h = createHarness()
    const release = h.sherpa.holdOfflineLoads()
    h.send({ type: 'load', id: 'slow', modelDir: OFFLINE_DIR, numThreads: 4, streaming: false })
    h.send({ type: 'unload', id: 'u' })
    release()
    expect(await h.reply('slow')).toMatchObject({ type: 'error' })
    h.send({ type: 'transcribe', id: 't', samples: fakeSpeech(WORDS), sampleRate: FAKE_RATE })
    expect(await h.reply('t')).toMatchObject({
      type: 'error',
      message: 'Speech model is not loaded'
    })
  })

  it('drops the model and exits on unload', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: FAKE_RATE })
    h.send({ type: 'unload', id: 'u' })
    expect(await h.reply('u')).toEqual({ type: 'unloaded', id: 'u' })
    expect(h.exit).toHaveBeenCalledTimes(1)
    // The open session's native stream was released too.
    expect(h.sherpa.online[0].streams[1].resetCalls).toBe(1)
  })

  it('ignores malformed messages', () => {
    const h = createHarness()
    for (const message of [
      null,
      'load',
      42,
      {},
      { type: 'load' },
      { type: 'stream-finish', id: 'x' }
    ]) {
      expect(() => h.host.handle(message)).not.toThrow()
    }
    expect(h.posted).toEqual([])
  })
})

describe('VoiceEngineHost whole-clip transcription', () => {
  it('transcribes with an offline model in windows, as before', async () => {
    const h = createHarness()
    await load(h, false)
    const clip = concat(fakeSpeech(WORDS), silence(0.2))
    h.send({ type: 'transcribe', id: 't', samples: clip, sampleRate: FAKE_RATE })
    expect(await h.reply('t')).toMatchObject({ type: 'result', text: WORDS.join(' ') })
    expect(h.sherpa.offline[0].windows).toEqual([clip.length])
  })

  it('transcribes with a streaming model, first and last words included', async () => {
    const h = createHarness()
    await load(h, true)
    // Speech from the first sample to the last: the padding must cover both ends.
    const clip = fakeSpeech(WORDS, { gapSeconds: 0 })
    h.send({ type: 'transcribe', id: 't', samples: clip, sampleRate: FAKE_RATE })
    const reply = await h.reply('t')
    expect(reply).toMatchObject({ type: 'result', text: WORDS.join(' ') })
    expect((reply as { decodeMs: number }).decodeMs).toBeGreaterThanOrEqual(0)
  })

  it('returns empty text for silence with a streaming model', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'transcribe', id: 't', samples: silence(3), sampleRate: FAKE_RATE })
    expect(await h.reply('t')).toMatchObject({ type: 'result', text: '' })
  })

  it.each([
    ['the injected yield', false],
    ['the production yield', true]
  ])(
    'keeps handling session messages during a long streaming-model transcription (%s)',
    async (_, defaultYield) => {
      const h = createHarness({ defaultYield })
      await load(h, true)
      const clip = concat(...Array.from({ length: 10 }, () => fakeSpeech(WORDS)))
      h.send({ type: 'transcribe', id: 't', samples: clip, sampleRate: FAKE_RATE })
      // A later message arrives as its own event-loop task, as from parentPort.
      await new Promise((resolve) => setImmediate(resolve))
      h.send({ type: 'stream-start', id: 's', sessionId: 'live', sampleRate: FAKE_RATE })
      expect(h.ofType('stream-started')).toHaveLength(1)
      expect(h.ofType('result')).toHaveLength(0)
      expect(await h.reply('t')).toMatchObject({
        type: 'result',
        text: Array.from({ length: 10 }, () => WORDS.join(' ')).join(' ')
      })
    }
  )

  it('reports non-audio samples as an error', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({
      type: 'transcribe',
      id: 't',
      samples: new Int16Array(8) as never,
      sampleRate: FAKE_RATE
    })
    expect(await h.reply('t')).toMatchObject({
      type: 'error',
      message: 'Audio must be a Float32Array'
    })
  })
})

describe('VoiceEngineHost streaming sessions', () => {
  it('streams audio, reports the growing transcript and finishes with every word', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: FAKE_RATE })
    expect(await h.reply('s')).toEqual({ type: 'stream-started', id: 's', sessionId: 'one' })

    streamChunks(h, 'one', fakeSpeech(WORDS, { gapSeconds: 0.2 }))
    const partials = h.ofType('stream-partial').map((p) => p.text)
    expect(partials.length).toBeGreaterThan(2)
    expect(partials.every((text, i) => i === 0 || text.startsWith(partials[i - 1]))).toBe(true)
    expect(h.ofType('stream-partial').every((p) => p.sessionId === 'one')).toBe(true)

    h.send({ type: 'stream-finish', id: 'f', sessionId: 'one' })
    const result = await h.reply('f')
    expect(result).toMatchObject({
      type: 'stream-result',
      sessionId: 'one',
      text: WORDS.join(' '),
      audioMs: (fakeSpeech(WORDS, { gapSeconds: 0.2 }).length / FAKE_RATE) * 1000
    })
    const { finishDecodes, finishMs, busyMs } = result as Extract<
      VoiceEngineMessage,
      { type: 'stream-result' }
    >
    expect(finishDecodes).toBeGreaterThanOrEqual(1)
    expect(finishDecodes).toBeLessThanOrEqual(2)
    expect(finishMs).toBeGreaterThanOrEqual(0)
    expect(busyMs).toBeGreaterThanOrEqual(finishMs)
  })

  it('returns empty text, not an error, for a silent session', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-start', id: 's', sessionId: 'quiet', sampleRate: FAKE_RATE })
    streamChunks(h, 'quiet', silence(3))
    h.send({ type: 'stream-finish', id: 'f', sessionId: 'quiet' })
    expect(await h.reply('f')).toMatchObject({ type: 'stream-result', text: '' })
    expect(h.ofType('stream-partial')).toEqual([])
  })

  it('refuses to start a session on an offline model', async () => {
    const h = createHarness()
    await load(h, false)
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: FAKE_RATE })
    expect(await h.reply('s')).toMatchObject({
      type: 'error',
      message: 'The loaded speech model cannot transcribe while you speak'
    })
  })

  it('refuses to start a session before a model is loaded', async () => {
    const h = createHarness()
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: FAKE_RATE })
    expect(await h.reply('s')).toMatchObject({
      type: 'error',
      message: 'Speech model is not loaded'
    })
  })

  it('rejects an unusable sample rate', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: 0 })
    expect(await h.reply('s')).toMatchObject({
      type: 'error',
      message: 'Unsupported sample rate 0'
    })
  })

  it('replaces a leftover session when a new one starts', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-start', id: 's1', sessionId: 'old', sampleRate: FAKE_RATE })
    streamChunks(h, 'old', fakeSpeech(['hello', 'can', 'you']))
    h.send({ type: 'stream-start', id: 's2', sessionId: 'new', sampleRate: FAKE_RATE })
    streamChunks(h, 'new', fakeSpeech(WORDS))
    // Late audio for the old session is ignored, not mixed into the new one.
    streamChunks(h, 'old', fakeSpeech(['main']))
    h.send({ type: 'stream-finish', id: 'f-old', sessionId: 'old' })
    h.send({ type: 'stream-finish', id: 'f-new', sessionId: 'new' })

    expect(await h.reply('f-old')).toMatchObject({
      type: 'error',
      message: 'No open streaming session'
    })
    expect(await h.reply('f-new')).toMatchObject({ type: 'stream-result', text: WORDS.join(' ') })
    // The replaced session's native stream was released when the new one started.
    expect(h.sherpa.online[0].streams[1].resetCalls).toBe(1)
  })

  it('cancels a session and ignores its later messages', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: FAKE_RATE })
    streamChunks(h, 'one', fakeSpeech(WORDS))
    const partialsBefore = h.ofType('stream-partial').length
    h.send({ type: 'stream-cancel', sessionId: 'one' })
    streamChunks(h, 'one', fakeSpeech(WORDS))
    h.send({ type: 'stream-cancel', sessionId: 'one' })
    h.send({ type: 'stream-finish', id: 'f', sessionId: 'one' })

    expect(await h.reply('f')).toMatchObject({
      type: 'error',
      message: 'No open streaming session'
    })
    expect(h.ofType('stream-partial')).toHaveLength(partialsBefore)
    expect(h.sherpa.online[0].streams[1].resetCalls).toBe(1)
  })

  it('ignores a cancel for another session', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: FAKE_RATE })
    h.send({ type: 'stream-cancel', sessionId: 'other' })
    streamChunks(h, 'one', fakeSpeech(WORDS))
    h.send({ type: 'stream-finish', id: 'f', sessionId: 'one' })
    expect(await h.reply('f')).toMatchObject({ type: 'stream-result', text: WORDS.join(' ') })
  })

  it('turns a decoding failure into a session error, and finish reports it', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: FAKE_RATE })
    streamChunks(h, 'one', fakeSpeech(['hello']))
    h.sherpa.online[0].failAccept = 'native decoder failure'
    streamChunks(h, 'one', fakeSpeech(['can', 'you']))
    expect(h.ofType('stream-error')).toEqual([
      { type: 'stream-error', sessionId: 'one', message: 'native decoder failure' }
    ])
    h.send({ type: 'stream-finish', id: 'f', sessionId: 'one' })
    expect(await h.reply('f')).toMatchObject({ type: 'error', message: 'native decoder failure' })
  })

  it('answers a finish for an unknown session with an error, never empty text', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-finish', id: 'f', sessionId: 'never-started' })
    expect(await h.reply('f')).toMatchObject({
      type: 'error',
      message: 'No open streaming session'
    })
  })

  it('fails the open session when a different model is loaded', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: FAKE_RATE })
    await load(h, false, 'load-2')
    expect(h.ofType('stream-error')).toEqual([
      { type: 'stream-error', sessionId: 'one', message: 'The speech model changed' }
    ])
  })

  it('keeps each session to the sample rate it started with', async () => {
    const h = createHarness()
    await load(h, true)
    h.send({ type: 'stream-start', id: 's', sessionId: 'one', sampleRate: 48_000 })
    streamChunks(h, 'one', new Float32Array(48_000), 4800)
    h.send({ type: 'stream-finish', id: 'f', sessionId: 'one' })
    expect(await h.reply('f')).toMatchObject({ type: 'stream-result', audioMs: 1000 })
    const rates = new Set(h.sherpa.online[0].streams[1].accepted.map((a) => a.sampleRate))
    expect(rates).toEqual(new Set([48_000]))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
