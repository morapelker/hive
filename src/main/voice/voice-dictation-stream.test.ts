import { describe, expect, it, vi } from 'vitest'

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../services/logger', () => ({ createLogger: () => logger }))

import { DictationAudioStream, isDictationStreamBroken } from './voice-dictation-stream'
import type { VoiceStreamResult, VoiceStreamSession } from './voice-engine'

/** Records what reaches the session, like the engine's session would receive it. */
function fakeSession(result: Partial<VoiceStreamResult> = {}): VoiceStreamSession & {
  pushed: number[][]
  push: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
} {
  const pushed: number[][] = []
  const session = {
    id: 'session-1',
    error: null,
    pushed,
    push: vi.fn((samples: Float32Array) => {
      pushed.push(Array.from(samples))
    }),
    finish: vi.fn(async () => ({
      text: 'hello world',
      finishMs: 40,
      workerFinishMs: 30,
      finishDecodes: 1,
      audioMs: Math.round((pushed.flat().length / 16_000) * 1000),
      busyMs: 5,
      ...result
    })),
    cancel: vi.fn()
  }
  return session
}

function chunk(seq: number, values: number[], streamId = 7, sampleRate = 16_000) {
  return { streamId, seq, samples: new Float32Array(values), sampleRate }
}

describe('DictationAudioStream', () => {
  it('pushes chunks to the session in order, as they arrive', () => {
    const session = fakeSession()
    const stream = new DictationAudioStream(7, session, 16_000)
    stream.accept(chunk(0, [0.1, 0.2]))
    stream.accept(chunk(1, [0.3]))
    stream.accept(chunk(2, [0.4, 0.5]))
    expect(session.pushed).toEqual([[0.1, 0.2], [0.3], [0.4, 0.5]].map((c) => c.map(Math.fround)))
  })

  it("ignores another capture's chunks", () => {
    const session = fakeSession()
    const stream = new DictationAudioStream(7, session, 16_000)
    stream.accept(chunk(0, [0.1], 6))
    stream.accept(chunk(0, [0.2]))
    expect(session.pushed).toEqual([[Math.fround(0.2)]])
  })

  it('drops a repeated chunk instead of feeding it twice', async () => {
    const session = fakeSession()
    const stream = new DictationAudioStream(7, session, 16_000)
    stream.accept(chunk(0, [0.1]))
    stream.accept(chunk(0, [0.1]))
    stream.accept(chunk(1, [0.2]))
    expect(session.pushed).toHaveLength(2)
    const result = await stream.finish(new Float32Array([0.1, 0.2]), 16_000)
    expect(result).toMatchObject({ chunks: 2, streamedSamples: 2, topUpSamples: 0 })
  })

  it('stops streaming on a gap: the session is cancelled and finish rejects', async () => {
    const session = fakeSession()
    const stream = new DictationAudioStream(7, session, 16_000)
    stream.accept(chunk(0, [0.1]))
    stream.accept(chunk(2, [0.3]))
    stream.accept(chunk(3, [0.4]))
    expect(session.pushed).toHaveLength(1)
    expect(session.cancel).toHaveBeenCalledTimes(1)
    const error = await stream.finish(new Float32Array(4), 16_000).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Audio chunk 1 never arrived (got 2)')
    // Told apart from a session failure, so the dictation can say why it fell back.
    expect(isDictationStreamBroken(error)).toBe(true)
    expect(session.finish).not.toHaveBeenCalled()
    expect(stream.progress).toEqual({
      chunks: 1,
      streamedSamples: 1,
      topUpSamples: 0,
      sampleRate: 16_000
    })
  })

  it('stops streaming when a chunk has a different sample rate', async () => {
    const session = fakeSession()
    const stream = new DictationAudioStream(7, session, 16_000)
    stream.accept(chunk(0, [0.1], 7, 48_000))
    expect(session.pushed).toHaveLength(0)
    expect(session.cancel).toHaveBeenCalledTimes(1)
    const error = await stream.finish(new Float32Array(1), 16_000).catch((e: unknown) => e)
    expect((error as Error).message).toContain('48000 Hz')
    expect(isDictationStreamBroken(error)).toBe(true)
  })

  it('counts a clip at another sample rate as a broken stream', async () => {
    const session = fakeSession()
    const stream = new DictationAudioStream(7, session, 16_000)
    const error = await stream.finish(new Float32Array(1), 44_100).catch((e: unknown) => e)
    expect(isDictationStreamBroken(error)).toBe(true)
    expect(session.cancel).toHaveBeenCalledTimes(1)
  })

  it('finishes with nothing to add when every sample arrived as a chunk', async () => {
    const session = fakeSession()
    const stream = new DictationAudioStream(7, session, 16_000)
    stream.accept(chunk(0, [0.1, 0.2]))
    stream.accept(chunk(1, [0.3]))
    const result = await stream.finish(new Float32Array([0.1, 0.2, 0.3]), 16_000)
    expect(session.pushed).toHaveLength(2)
    expect(session.finish).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      text: 'hello world',
      chunks: 2,
      streamedSamples: 3,
      topUpSamples: 0,
      clipSamples: 3,
      sampleRate: 16_000
    })
  })

  it('pushes the part of the clip no chunk carried before finishing, so the last words are kept', async () => {
    const session = fakeSession()
    const stream = new DictationAudioStream(7, session, 16_000)
    stream.accept(chunk(0, [0.1, 0.2]))
    const clip = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5])
    session.finish.mockImplementationOnce(async () => {
      // The tail is queued before the session is asked to finish.
      expect(session.pushed.flat()).toEqual(Array.from(clip))
      return { text: 'x', finishMs: 1, workerFinishMs: 1, finishDecodes: 1, audioMs: 0, busyMs: 0 }
    })
    const result = await stream.finish(clip, 16_000)
    expect(session.pushed[1]).toEqual([0.3, 0.4, 0.5].map(Math.fround))
    expect(result).toMatchObject({ streamedSamples: 2, topUpSamples: 3, clipSamples: 5 })
    // A copy, not a view into the whole clip's buffer.
    const tail = session.push.mock.calls[1][0] as Float32Array
    expect(tail.buffer.byteLength).toBe(3 * 4)
  })

  it('streams the whole clip at stop when no chunk arrived at all', async () => {
    const session = fakeSession()
    const stream = new DictationAudioStream(7, session, 16_000)
    const result = await stream.finish(new Float32Array([0.1, 0.2]), 16_000)
    expect(session.pushed).toEqual([[0.1, 0.2].map(Math.fround)])
    expect(result).toMatchObject({ chunks: 0, streamedSamples: 0, topUpSamples: 2 })
  })

  it('ignores chunks after finish or cancel', async () => {
    const finished = fakeSession()
    const a = new DictationAudioStream(7, finished, 16_000)
    a.accept(chunk(0, [0.1]))
    await a.finish(new Float32Array([0.1]), 16_000)
    a.accept(chunk(1, [0.2]))
    expect(finished.pushed).toHaveLength(1)

    const cancelled = fakeSession()
    const b = new DictationAudioStream(7, cancelled, 16_000)
    b.cancel()
    b.accept(chunk(0, [0.1]))
    expect(cancelled.push).not.toHaveBeenCalled()
    expect(cancelled.cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects when the session fails', async () => {
    const session = fakeSession()
    session.finish.mockRejectedValueOnce(new Error('Speech engine exited (code 9)'))
    const stream = new DictationAudioStream(7, session, 16_000)
    stream.accept(chunk(0, [0.1]))
    const error = await stream.finish(new Float32Array([0.1, 0.2]), 16_000).catch((e: unknown) => e)
    expect((error as Error).message).toContain('exited')
    expect(isDictationStreamBroken(error)).toBe(false)
    // What reached the session is still known, for the report.
    expect(stream.progress).toMatchObject({ chunks: 1, streamedSamples: 1, topUpSamples: 1 })
  })
})
