import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FAKE_RATE,
  FakeOnlineRecognizer,
  concat,
  fakeSpeech,
  silence,
  type FakeOnlineStream
} from './__tests__/voice-engine-fakes'
import {
  OnlineTranscriptStream,
  STREAM_LEAD_IN_SECONDS,
  STREAM_TAIL_SECONDS,
  transcribeClipOnline
} from './voice-online-stream'

const WORDS = ['hello', 'can', 'you', 'rename', 'this', 'branch', 'to', 'main']

/** Feed `samples` in chunks of `size` (or the sizes produced by `sizes`). */
function feed(
  stream: OnlineTranscriptStream,
  samples: Float32Array,
  sizes: () => number
): string[] {
  const updates: string[] = []
  for (let start = 0; start < samples.length;) {
    const end = Math.min(samples.length, start + Math.max(1, sizes()))
    const text = stream.accept(samples.subarray(start, end))
    if (text !== null) updates.push(text)
    start = end
  }
  return updates
}

function seededSizes(seed: number, max: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return 1 + (state % max)
  }
}

describe('OnlineTranscriptStream', () => {
  it('feeds 0.5 s of silence before the first real sample, at the session rate', () => {
    const recognizer = new FakeOnlineRecognizer()
    new OnlineTranscriptStream(recognizer, FAKE_RATE)
    const stream = recognizer.streams[0]
    expect(stream.accepted[0]).toEqual({
      length: STREAM_LEAD_IN_SECONDS * FAKE_RATE,
      sampleRate: FAKE_RATE,
      zeros: true
    })
  })

  it('keeps the first word when speech starts at the very first sample', () => {
    const recognizer = new FakeOnlineRecognizer()
    const speech = concat(fakeSpeech(WORDS), silence(0.3))

    // Without the lead-in the (fake, like the real) model never decodes the first ~90 ms.
    const bare = recognizer.createStream()
    bare.acceptWaveform({ samples: concat(speech, silence(1)), sampleRate: FAKE_RATE })
    bare.inputFinished()
    while (recognizer.isReady(bare)) recognizer.decode(bare)
    expect(recognizer.getResult(bare).text.trim().split(' ')[0]).toBe('can')

    const stream = new OnlineTranscriptStream(recognizer, FAKE_RATE)
    feed(stream, speech, () => 1536)
    expect(stream.finish().text).toBe(WORDS.join(' '))
  })

  it('accepts chunks of any size in order and gives the same text', () => {
    const speech = concat(fakeSpeech(WORDS), silence(0.2))
    const results = [
      () => 1536,
      () => 160,
      () => 8960,
      () => speech.length,
      seededSizes(7, 5000),
      seededSizes(42, 37)
    ].map((sizes) => {
      const stream = new OnlineTranscriptStream(new FakeOnlineRecognizer(), FAKE_RATE)
      feed(stream, speech, sizes)
      return stream.finish().text
    })
    expect(new Set(results)).toEqual(new Set([WORDS.join(' ')]))
  })

  it('reports the transcript as it grows, only when it changes', () => {
    const stream = new OnlineTranscriptStream(new FakeOnlineRecognizer(), FAKE_RATE)
    const updates = feed(stream, fakeSpeech(WORDS), () => 1536)
    expect(updates.length).toBeGreaterThan(2)
    for (let i = 1; i < updates.length; i++) {
      expect(updates[i]).not.toBe(updates[i - 1])
      expect(updates[i].startsWith(updates[i - 1])).toBe(true)
    }
    expect(stream.currentText).toBe(updates[updates.length - 1])
    // The last words are still undecoded until finish flushes them.
    expect(stream.currentText).not.toBe(WORDS.join(' '))
  })

  it('flushes the last words at finish with 0.8 s of silence and inputFinished', () => {
    const recognizer = new FakeOnlineRecognizer()
    const stream = new OnlineTranscriptStream(recognizer, FAKE_RATE)
    // Speech right up to the stop, no trailing silence at all.
    feed(stream, fakeSpeech(WORDS, { gapSeconds: 0 }), () => 1536)
    const result = stream.finish()

    const fake = recognizer.streams[0]
    const tail = fake.accepted[fake.accepted.length - 1]
    expect(tail).toEqual({
      length: STREAM_TAIL_SECONDS * FAKE_RATE,
      sampleRate: FAKE_RATE,
      zeros: true
    })
    expect(fake.inputFinishedCalls).toBe(1)
    expect(result.text).toBe(WORDS.join(' '))
    expect(result.decodes).toBeGreaterThanOrEqual(1)
    expect(result.decodes).toBeLessThanOrEqual(2)
  })

  it('needs at most two decode steps at finish, however long the session', () => {
    for (const repeats of [1, 10, 40]) {
      const words = Array.from({ length: repeats }, () => WORDS).flat()
      const stream = new OnlineTranscriptStream(new FakeOnlineRecognizer(), FAKE_RATE)
      feed(stream, fakeSpeech(words), () => 1536)
      const result = stream.finish()
      expect(result.text).toBe(words.join(' '))
      expect(result.decodes).toBeLessThanOrEqual(2)
    }
  })

  it('reports audio length without the padding', () => {
    const stream = new OnlineTranscriptStream(new FakeOnlineRecognizer(), FAKE_RATE)
    feed(stream, silence(2), () => 1600)
    expect(stream.audioMs).toBe(2000)
    stream.finish()
    expect(stream.audioMs).toBe(2000)
  })

  it('counts the time spent decoding as busy time, while streaming and at finish', () => {
    // A clock that only moves inside the recogniser: 10 ms per decode step.
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const recognizer = new FakeOnlineRecognizer()
    const decode = recognizer.decode.bind(recognizer)
    recognizer.decode = (target) => {
      clock += 10
      decode(target)
    }
    const stream = new OnlineTranscriptStream(recognizer, FAKE_RATE)
    feed(stream, fakeSpeech(WORDS), () => 1536)
    const fake = recognizer.streams[0]
    expect(fake.decodes).toBeGreaterThan(3)
    expect(stream.busyMs).toBe(fake.decodes * 10)

    const result = stream.finish()
    expect(result.decodes).toBeGreaterThan(0)
    expect(result.finishMs).toBe(result.decodes * 10)
    expect(stream.busyMs).toBe(fake.decodes * 10)
  })

  it('returns empty text for silence', () => {
    const stream = new OnlineTranscriptStream(new FakeOnlineRecognizer(), FAKE_RATE)
    expect(feed(stream, silence(3), () => 1536)).toEqual([])
    expect(stream.finish().text).toBe('')
  })

  it('never decodes a stream that is not ready', () => {
    // The fake throws where the real recogniser would end the process.
    const stream = new OnlineTranscriptStream(new FakeOnlineRecognizer(), FAKE_RATE)
    expect(() => feed(stream, fakeSpeech(WORDS), seededSizes(3, 3000))).not.toThrow()
    expect(() => stream.finish()).not.toThrow()
  })

  it('treats NaN and Infinity as silence instead of poisoning the stream', () => {
    const recognizer = new FakeOnlineRecognizer()
    const stream = new OnlineTranscriptStream(recognizer, FAKE_RATE)
    const bad = new Float32Array(1536).fill(Number.NaN)
    bad[3] = Number.POSITIVE_INFINITY
    stream.accept(bad)
    feed(stream, fakeSpeech(WORDS), () => 1536)
    expect(stream.finish().text).toBe(WORDS.join(' '))
    expect(recognizer.streams[0].poisoned).toBe(false)
  })

  it('reports an unreadable recogniser result as an error, not as empty text', () => {
    const recognizer = new FakeOnlineRecognizer()
    const stream = new OnlineTranscriptStream(recognizer, FAKE_RATE)
    recognizer.streams[0].poisoned = true
    expect(() => feed(stream, fakeSpeech(WORDS), () => 1536)).toThrow(/unreadable result/)
  })

  it('keeps one sample rate for the lead-in, the audio and the tail', () => {
    const recognizer = new FakeOnlineRecognizer()
    const stream = new OnlineTranscriptStream(recognizer, 48_000)
    stream.accept(new Float32Array(4800))
    stream.finish()
    const rates = new Set(recognizer.streams[0].accepted.map((a) => a.sampleRate))
    expect(rates).toEqual(new Set([48_000]))
    expect(recognizer.streams[0].accepted[0].length).toBe(24_000)
  })

  it('rejects an unusable sample rate up front', () => {
    for (const rate of [0, 100, Number.NaN, 1_000_000]) {
      expect(() => new OnlineTranscriptStream(new FakeOnlineRecognizer(), rate)).toThrow(
        /Unsupported sample rate/
      )
    }
  })

  it('releases the native stream on finish and on close, once', () => {
    const recognizer = new FakeOnlineRecognizer()
    const finished = new OnlineTranscriptStream(recognizer, FAKE_RATE)
    finished.finish()
    finished.close()
    const cancelled = new OnlineTranscriptStream(recognizer, FAKE_RATE)
    cancelled.accept(silence(1))
    cancelled.close()
    cancelled.close()
    expect(recognizer.streams.map((s: FakeOnlineStream) => s.resetCalls)).toEqual([1, 1])
    expect(finished.isOpen).toBe(false)
    expect(() => cancelled.accept(silence(0.1))).toThrow(/closed/)
    expect(() => cancelled.finish()).toThrow(/closed/)
  })

  it('ignores empty chunks', () => {
    const recognizer = new FakeOnlineRecognizer()
    const stream = new OnlineTranscriptStream(recognizer, FAKE_RATE)
    expect(stream.accept(new Float32Array(0))).toBeNull()
    expect(recognizer.streams[0].accepted).toHaveLength(1)
  })
})

describe('transcribeClipOnline', () => {
  it('gives the same text as streaming, with the same padding', async () => {
    const clip = concat(fakeSpeech(WORDS), silence(0.2))
    const recognizer = new FakeOnlineRecognizer()
    const text = await transcribeClipOnline(recognizer, clip, FAKE_RATE, async () => undefined)
    expect(text).toBe(WORDS.join(' '))

    const fake = recognizer.streams[0]
    expect(fake.accepted[0]).toMatchObject({ length: 0.5 * FAKE_RATE, zeros: true })
    expect(fake.accepted[fake.accepted.length - 1]).toMatchObject({
      length: 0.8 * FAKE_RATE,
      zeros: true
    })
    expect(fake.inputFinishedCalls).toBe(1)
    expect(fake.resetCalls).toBe(1)
  })

  it('yields to the event loop between slices of a long clip', async () => {
    const clip = concat(...Array.from({ length: 6 }, () => fakeSpeech(WORDS)))
    let yields = 0
    await transcribeClipOnline(new FakeOnlineRecognizer(), clip, FAKE_RATE, async () => {
      yields++
    })
    expect(yields).toBe(Math.ceil(clip.length / FAKE_RATE))
  })

  it('releases the stream when decoding fails', async () => {
    const recognizer = new FakeOnlineRecognizer()
    const clip = fakeSpeech(WORDS)
    const pending = transcribeClipOnline(recognizer, clip, FAKE_RATE, async () => {
      recognizer.failAccept = 'native failure'
    })
    await expect(pending).rejects.toThrow('native failure')
    expect(recognizer.streams[0].resetCalls).toBe(1)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
