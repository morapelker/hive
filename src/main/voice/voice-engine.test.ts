import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeEngineChild } from './__tests__/voice-engine-fakes'

const forked = vi.hoisted(() => ({
  children: [] as FakeEngineChild[],
  onFork: null as ((child: FakeEngineChild) => void) | null
}))

vi.mock('electron', async () => {
  const { FakeEngineChild } = await import('./__tests__/voice-engine-fakes')
  return {
    utilityProcess: {
      fork: vi.fn(() => {
        const child = new FakeEngineChild()
        forked.children.push(child)
        forked.onFork?.(child)
        return child
      })
    }
  }
})

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../services/logger', () => ({ createLogger: () => logger }))

import {
  FAKE_RATE,
  concat,
  connectToHost,
  createFakeSherpa,
  fakeSpeech,
  silence,
  type FakeSherpa
} from './__tests__/voice-engine-fakes'
import {
  VoiceEngine,
  VoiceStreamCancelledError,
  isVoiceEngineExited,
  isVoiceStreamCancelled,
  type VoiceEngineModel,
  type VoiceStreamSession
} from './voice-engine'

const NEMOTRON: VoiceEngineModel = {
  id: 'nemotron-speech-streaming-en-0.6b',
  dir: '/models/nemotron'
}
const PARAKEET: VoiceEngineModel = { id: 'parakeet-tdt-0.6b-v2', dir: '/models/parakeet' }
const WORDS = ['hello', 'can', 'you', 'rename', 'this', 'branch', 'to', 'main']

let engine: VoiceEngine
let sherpa: FakeSherpa

/** Every forked worker runs the real host in-process, on the fake recogniser. */
function connectWorkers(): void {
  forked.onFork = (child) => connectToHost(child, sherpa)
}

function child(index = 0): FakeEngineChild {
  const found = forked.children[index]
  if (!found) throw new Error(`worker ${index} was not forked`)
  return found
}

/** Wait until worker `index` has been forked (sessions start loading on the next tick). */
function worker(index = 0): Promise<FakeEngineChild> {
  return vi.waitFor(() => child(index))
}

/** Manual mode: answer worker `index`'s pending load. */
async function answerLoad(index = 0): Promise<FakeEngineChild> {
  const target = await worker(index)
  const load = await vi.waitFor(() => target.lastOfType('load'))
  target.reply({ type: 'loaded', id: load.id, loadMs: 1, version: 'manual' })
  return target
}

/** Manual mode: answer worker `index`'s pending stream-start. */
async function answerStart(index = 0): Promise<string> {
  const target = await worker(index)
  const start = await vi.waitFor(() => target.lastOfType('stream-start'))
  target.reply({ type: 'stream-started', id: start.id, sessionId: start.sessionId })
  return start.sessionId
}

function pushInChunks(session: VoiceStreamSession, samples: Float32Array, size = 1536): void {
  for (let start = 0; start < samples.length; start += size) {
    session.push(samples.subarray(start, start + size))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  forked.children.length = 0
  forked.onFork = null
  sherpa = createFakeSherpa()
  engine = new VoiceEngine()
})

afterEach(() => {
  engine.dispose()
  vi.useRealTimers()
})

describe('VoiceEngine model loading', () => {
  it('loads the streaming model as streaming and Parakeet as offline, from the catalog', async () => {
    const loading = engine.ensureLoaded(NEMOTRON)
    await answerLoad(0)
    await loading
    expect(child(0).lastOfType('load')).toMatchObject({ modelDir: NEMOTRON.dir, streaming: true })
    expect(engine.isLoaded).toBe(true)
    expect(engine.loadedModel).toBe(NEMOTRON.dir)

    const switching = engine.ensureLoaded(PARAKEET)
    await answerLoad(1)
    await switching
    expect(child(1).lastOfType('load')).toMatchObject({ modelDir: PARAKEET.dir, streaming: false })
  })

  it('starts a fresh worker when switching models, so only one model is in memory', async () => {
    connectWorkers()
    await engine.ensureLoaded(PARAKEET)
    await engine.ensureLoaded(NEMOTRON)
    expect(forked.children).toHaveLength(2)
    expect(child(0).killed).toBe(true)
    expect(child(1).killed).toBe(false)
    expect(engine.loadedModel).toBe(NEMOTRON.dir)
  })

  it('reports a load failure as an error', async () => {
    connectWorkers()
    sherpa.brokenDirs.add(NEMOTRON.dir)
    await expect(engine.ensureLoaded(NEMOTRON)).rejects.toThrow('Please check your config!')
    expect(engine.isLoaded).toBe(false)
  })

  it('replaces a worker whose load never answers, instead of reusing it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stuck = engine.ensureLoaded(PARAKEET).catch((error: Error) => error)
    await vi.waitFor(() => child(0).lastOfType('load'))
    await vi.advanceTimersByTimeAsync(120_001)
    expect(await stuck).toEqual(new Error('Speech engine did not answer within 120s'))
    expect(child(0).killed).toBe(true)

    // The next load goes to a fresh worker, not behind the stuck one.
    const next = engine.ensureLoaded(NEMOTRON)
    await answerLoad(1)
    await next
    expect(child(0).sentOfType('load')).toHaveLength(1)
    expect(engine.loadedModel).toBe(NEMOTRON.dir)
  })

  it('starts a fresh load when asked right after an unload killed the one in flight', async () => {
    const first = engine.ensureLoaded(NEMOTRON).catch((error: Error) => error)
    await vi.waitFor(() => child(0).lastOfType('load'))
    engine.unload('speech model changed')
    // In the same tick, as the warm-up right after a model switch asks.
    const second = engine.ensureLoaded(NEMOTRON)
    expect(await first).toEqual(new Error('Speech engine was unloaded'))
    await answerLoad(1)
    await second
    expect(child(0).killed).toBe(true)
    expect(engine.loadedModel).toBe(NEMOTRON.dir)
  })

  it('lets onError reload when the worker dies while the session waits for its load', async () => {
    const reloads: Array<Promise<void>> = []
    const session = engine.startSession(NEMOTRON, {
      onError: () => reloads.push(engine.ensureLoaded(NEMOTRON))
    })
    await vi.waitFor(() => child(0).lastOfType('load'))
    child(0).crash(9)
    await expect(session.finish()).rejects.toThrow('Speech engine exited (code 9)')
    await vi.waitFor(() => expect(reloads).toHaveLength(1))
    // A fresh worker loads the model, instead of the reload joining the dead load.
    await answerLoad(1)
    await reloads[0]
    expect(engine.loadedModel).toBe(NEMOTRON.dir)
  })

  it('reports a worker that dies while loading as an error', async () => {
    const loading = engine.ensureLoaded(NEMOTRON)
    await vi.waitFor(() => child(0).lastOfType('load'))
    child(0).crash(255)
    await expect(loading).rejects.toThrow('Speech engine exited (code 255)')
  })
})

describe('VoiceEngine whole-clip transcription', () => {
  it('transcribes a finished clip with the streaming model', async () => {
    connectWorkers()
    await engine.ensureLoaded(NEMOTRON)
    const clip = fakeSpeech(WORDS, { gapSeconds: 0 })
    await expect(engine.transcribe(clip, FAKE_RATE)).resolves.toMatchObject({
      text: WORDS.join(' ')
    })
  })

  it('transcribes a finished clip with an offline model, as before', async () => {
    connectWorkers()
    await engine.ensureLoaded(PARAKEET)
    const clip = concat(fakeSpeech(WORDS), silence(0.2))
    await expect(engine.transcribe(clip, FAKE_RATE)).resolves.toMatchObject({
      text: WORDS.join(' ')
    })
    expect(sherpa.offline).toHaveLength(1)
  })
})

describe('VoiceEngine streaming sessions', () => {
  it('streams audio, reports the transcript as it grows and finishes with every word', async () => {
    connectWorkers()
    await engine.ensureLoaded(NEMOTRON)
    const updates: string[] = []
    const onError = vi.fn()
    const session = engine.startSession(NEMOTRON, {
      onUpdate: (text) => updates.push(text),
      onError
    })
    // Speech right up to the stop: the last words come out only through the flush.
    const speech = fakeSpeech(WORDS, { gapSeconds: 0 })
    pushInChunks(session, speech)
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(2))

    const result = await session.finish()
    expect(result).toMatchObject({
      text: WORDS.join(' '),
      audioMs: (speech.length / FAKE_RATE) * 1000
    })
    expect(result.finishDecodes).toBeLessThanOrEqual(2)
    expect(result.finishMs).toBeGreaterThanOrEqual(0)
    expect(result.busyMs).toBeGreaterThanOrEqual(result.workerFinishMs)
    expect(updates.every((text, i) => i === 0 || text.startsWith(updates[i - 1]))).toBe(true)
    expect(onError).not.toHaveBeenCalled()
    expect(session.error).toBeNull()
  })

  it('holds audio during a cold start and feeds it in order once the model has loaded', async () => {
    const session = engine.startSession(NEMOTRON)
    const speech = concat(fakeSpeech(WORDS), silence(0.2))
    pushInChunks(session, speech, 1000)
    const finishing = session.finish()

    const target = await answerLoad(0)
    const sessionId = await answerStart(0)
    expect(sessionId).toBe(session.id)

    const types = target.sent.map((m) => m.type)
    const startAt = types.indexOf('stream-start')
    const finishAt = types.indexOf('stream-finish')
    expect(types.slice(0, startAt)).toEqual(['load'])
    expect(types.slice(startAt + 1, finishAt).every((t) => t === 'stream-audio')).toBe(true)
    const audio = target.sentOfType('stream-audio')
    expect(audio.every((m) => m.sessionId === session.id)).toBe(true)
    expect(concat(...audio.map((m) => m.samples))).toEqual(speech)

    const finish = await vi.waitFor(() => target.lastOfType('stream-finish'))
    target.reply({
      type: 'stream-result',
      id: finish.id,
      sessionId: session.id,
      text: ' hello ',
      finishMs: 40,
      finishDecodes: 1,
      audioMs: 1000,
      busyMs: 90
    })
    await expect(finishing).resolves.toMatchObject({
      text: 'hello',
      workerFinishMs: 40,
      busyMs: 90
    })
  })

  it('loses nothing on a cold start, end to end', async () => {
    connectWorkers()
    const session = engine.startSession(NEMOTRON)
    pushInChunks(session, fakeSpeech(WORDS, { gapSeconds: 0 }))
    await expect(session.finish()).resolves.toMatchObject({ text: WORDS.join(' ') })
    expect(engine.isLoaded).toBe(true)
  })

  it('copies audio it has to hold, so the caller can reuse its buffer', async () => {
    const session = engine.startSession(NEMOTRON)
    const buffer = new Float32Array(1536).fill(0.25)
    session.push(buffer)
    buffer.fill(0)
    await answerLoad(0)
    await answerStart(0)
    expect(child(0).lastOfType('stream-audio').samples[0]).toBeCloseTo(0.25)
  })

  it('returns empty text for silence', async () => {
    connectWorkers()
    const session = engine.startSession(NEMOTRON)
    pushInChunks(session, silence(3))
    await expect(session.finish()).resolves.toMatchObject({ text: '' })
  })

  it('makes finish idempotent and ignores audio pushed after it', async () => {
    connectWorkers()
    const session = engine.startSession(NEMOTRON)
    pushInChunks(session, fakeSpeech(WORDS))
    const first = session.finish()
    session.push(fakeSpeech(['main']))
    expect(session.finish()).toBe(first)
    await expect(first).resolves.toMatchObject({ text: WORDS.join(' ') })
    const types = child(0).sent.map((m) => m.type)
    expect(types.lastIndexOf('stream-audio')).toBeLessThan(types.indexOf('stream-finish'))
    expect(types.filter((t) => t === 'stream-finish')).toHaveLength(1)
  })

  it('cancels: the worker drops the stream, finish rejects as cancelled, nothing is reported as an error', async () => {
    connectWorkers()
    const onError = vi.fn()
    const onUpdate = vi.fn()
    const session = engine.startSession(NEMOTRON, { onError, onUpdate })
    pushInChunks(session, fakeSpeech(WORDS))
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalled())
    session.cancel()
    session.cancel()
    const updatesAtCancel = onUpdate.mock.calls.length

    await expect(session.finish()).rejects.toBeInstanceOf(VoiceStreamCancelledError)
    await vi.waitFor(() => expect(child(0).sentOfType('stream-cancel')).toHaveLength(1))
    expect(onError).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledTimes(updatesAtCancel)

    // The next session starts clean.
    const next = engine.startSession(NEMOTRON)
    pushInChunks(next, fakeSpeech(['open', 'the', 'terminal']))
    await expect(next.finish()).resolves.toMatchObject({ text: 'open the terminal' })
  })

  it('rejects a finish that is in flight when the session is cancelled', async () => {
    const session = engine.startSession(NEMOTRON)
    await answerLoad(0)
    await answerStart(0)
    const finishing = session.finish()
    await vi.waitFor(() => child(0).lastOfType('stream-finish'))
    session.cancel()
    await expect(finishing).rejects.toSatisfy(isVoiceStreamCancelled)
  })

  it('cancels a session that is still waiting for the model, without opening it', async () => {
    const session = engine.startSession(NEMOTRON)
    const target = await worker(0)
    await vi.waitFor(() => target.lastOfType('load'))
    session.push(new Float32Array(1536))
    session.cancel()
    await answerLoad(0)
    await new Promise((resolve) => setImmediate(resolve))
    expect(target.sentOfType('stream-start')).toEqual([])
    expect(target.sentOfType('stream-audio')).toEqual([])
  })

  it('does not load anything for a session cancelled straight away', async () => {
    engine.startSession(NEMOTRON).cancel()
    await new Promise((resolve) => setImmediate(resolve))
    expect(forked.children).toHaveLength(0)
  })

  it('keeps one session at a time: starting another cancels the first', async () => {
    connectWorkers()
    const firstUpdates = vi.fn()
    const first = engine.startSession(NEMOTRON, { onUpdate: firstUpdates })
    pushInChunks(first, fakeSpeech(['hello', 'can', 'you']))
    const second = engine.startSession(NEMOTRON)
    pushInChunks(second, fakeSpeech(WORDS))

    await expect(first.finish()).rejects.toBeInstanceOf(VoiceStreamCancelledError)
    await expect(second.finish()).resolves.toMatchObject({ text: WORDS.join(' ') })
  })

  it('never delivers a replaced session’s late updates to the new one', async () => {
    const firstUpdates = vi.fn()
    const secondUpdates = vi.fn()
    const first = engine.startSession(NEMOTRON, { onUpdate: firstUpdates })
    await answerLoad(0)
    const firstId = await answerStart(0)
    engine.startSession(NEMOTRON, { onUpdate: secondUpdates })
    child(0).reply({ type: 'stream-partial', sessionId: firstId, text: 'stale words' })
    child(0).reply({ type: 'stream-error', sessionId: firstId, message: 'stale failure' })
    expect(firstUpdates).not.toHaveBeenCalled()
    expect(secondUpdates).not.toHaveBeenCalled()
    expect(first.error).toBeNull()
  })

  it('fails a session on a model that cannot stream, after startSession returns', async () => {
    let returned = false
    const calledAfterReturn: boolean[] = []
    const session = engine.startSession(PARAKEET, {
      onError: () => calledAfterReturn.push(returned)
    })
    returned = true
    await expect(session.finish()).rejects.toThrow(
      'Parakeet TDT 0.6B v2 cannot transcribe while you speak'
    )
    expect(calledAfterReturn).toEqual([true])
    expect(forked.children).toHaveLength(0)
  })

  it('reports a model that fails to load as the session error', async () => {
    connectWorkers()
    sherpa.brokenDirs.add(NEMOTRON.dir)
    const onError = vi.fn()
    const session = engine.startSession(NEMOTRON, { onError })
    pushInChunks(session, fakeSpeech(WORDS))
    await expect(session.finish()).rejects.toThrow('Please check your config!')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(session.error?.message).toBe('Please check your config!')
  })

  it('reports a worker crash mid-session as an error, never as empty text', async () => {
    connectWorkers()
    const onError = vi.fn()
    const session = engine.startSession(NEMOTRON, { onError })
    pushInChunks(session, fakeSpeech(WORDS))
    await vi.waitFor(() => expect(child(0).sentOfType('stream-audio').length).toBeGreaterThan(0))
    child(0).crash(139)
    const error = await session.finish().catch((e: unknown) => e)
    expect((error as Error).message).toBe('Speech engine exited (code 139)')
    // Typed, so a dictation can tell a crash from other session failures.
    expect(isVoiceEngineExited(error)).toBe(true)
    expect(isVoiceStreamCancelled(error)).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    // The same failure that finish() rejected with.
    expect(onError.mock.calls[0][0]).toBe(error)
    expect(engine.isLoaded).toBe(false)
  })

  it.each([
    ['the worker crashes', () => child(0).crash(137)],
    ['the model is unloaded', () => engine.unload('voice disabled')]
  ])('lets onError reload the model when %s', async (_, end) => {
    connectWorkers()
    const reloads: Array<Promise<void>> = []
    const session = engine.startSession(NEMOTRON, {
      onError: () => reloads.push(engine.ensureLoaded(NEMOTRON))
    })
    pushInChunks(session, fakeSpeech(WORDS))
    await vi.waitFor(() => expect(child(0).sentOfType('stream-audio').length).toBeGreaterThan(0))
    end()
    await expect(session.finish()).rejects.toThrow()
    await vi.waitFor(() => expect(reloads).toHaveLength(1))
    await expect(reloads[0]).resolves.toBeUndefined()
    expect(engine.isLoaded).toBe(true)
    expect(forked.children).toHaveLength(2)
    expect(child(1).killed).toBe(false)
    // The engine still owns the new worker: unloading it frees it.
    engine.unload('voice disabled')
    expect(child(1).killed).toBe(true)
  })

  it('lets onError reload during a model switch without sharing the switch’s worker', async () => {
    connectWorkers()
    const reloads: Array<Promise<void>> = []
    const session = engine.startSession(NEMOTRON, {
      onError: () => reloads.push(engine.ensureLoaded(NEMOTRON))
    })
    await vi.waitFor(() => child(0).lastOfType('stream-start'))
    await engine.ensureLoaded(PARAKEET)
    await expect(session.finish()).rejects.toThrow('The speech model changed')
    await vi.waitFor(() => expect(reloads).toHaveLength(1))
    await reloads[0]
    // The reload waited for the switch, then got a worker of its own.
    expect(forked.children.map((c) => c.sentOfType('load').map((m) => m.modelDir))).toEqual([
      [NEMOTRON.dir],
      [PARAKEET.dir],
      [NEMOTRON.dir]
    ])
    expect(engine.loadedModel).toBe(NEMOTRON.dir)
  })

  it('keeps a session that is waiting for the model a switch is loading', async () => {
    connectWorkers()
    await engine.ensureLoaded(PARAKEET)
    const onError = vi.fn()
    const session = engine.startSession(NEMOTRON, { onError })
    pushInChunks(session, fakeSpeech(WORDS))
    await expect(session.finish()).resolves.toMatchObject({ text: WORDS.join(' ') })
    expect(onError).not.toHaveBeenCalled()
    expect(child(0).killed).toBe(true)
    expect(engine.loadedModel).toBe(NEMOTRON.dir)
  })

  it('rejects a finish in flight when the worker crashes', async () => {
    const session = engine.startSession(NEMOTRON)
    await answerLoad(0)
    await answerStart(0)
    const finishing = session.finish()
    await vi.waitFor(() => child(0).lastOfType('stream-finish'))
    child(0).crash(134)
    await expect(finishing).rejects.toThrow('Speech engine exited (code 134)')
  })

  it('fails the session when the model is unloaded mid-dictation', async () => {
    connectWorkers()
    const onError = vi.fn()
    const session = engine.startSession(NEMOTRON, { onError })
    await vi.waitFor(() => expect(engine.isLoaded).toBe(true))
    engine.unload('voice disabled')
    await expect(session.finish()).rejects.toThrow('Speech engine was unloaded')
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('passes a session error from the worker on, and finish reports it', async () => {
    connectWorkers()
    const onError = vi.fn()
    const session = engine.startSession(NEMOTRON, { onError })
    pushInChunks(session, fakeSpeech(['hello']))
    await vi.waitFor(() => expect(sherpa.online).toHaveLength(1))
    sherpa.online[0].failAccept = 'native decoder failure'
    pushInChunks(session, fakeSpeech(['can', 'you']))
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(new Error('native decoder failure'))
    )
    await expect(session.finish()).rejects.toThrow('native decoder failure')
  })

  it('times out a finish the worker never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const session = engine.startSession(NEMOTRON)
    await answerLoad(0)
    await answerStart(0)
    const finishing = session.finish()
    const outcome = finishing.catch((error: Error) => error)
    await vi.waitFor(() => child(0).lastOfType('stream-finish'))
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await outcome).toEqual(new Error('Speech engine did not answer within 10s'))
    // A stuck worker is not reused: a fallback loads into a fresh one.
    expect(child(0).killed).toBe(true)
    expect(engine.isLoaded).toBe(false)
  })

  it('never unloads the model for idleness while a session is open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    engine.setIdleUnloadMinutes(1)
    const session = engine.startSession(NEMOTRON)
    await answerLoad(0)
    await answerStart(0)

    // A long dictation: no request in flight between start and finish.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(engine.isLoaded).toBe(true)
    expect(child(0).killed).toBe(false)

    const finishing = session.finish()
    const finish = await vi.waitFor(() => child(0).lastOfType('stream-finish'))
    child(0).reply({
      type: 'stream-result',
      id: finish.id,
      sessionId: session.id,
      text: 'done',
      finishMs: 1,
      finishDecodes: 1,
      audioMs: 300_000,
      busyMs: 20_000
    })
    await finishing
    await vi.advanceTimersByTimeAsync(60_001)
    expect(engine.isLoaded).toBe(false)
    expect(child(0).killed).toBe(true)
  })

  it('logs timings for a finished session but never the transcript', async () => {
    connectWorkers()
    const session = engine.startSession(NEMOTRON)
    pushInChunks(session, fakeSpeech(WORDS))
    await session.finish()
    expect(logger.info).toHaveBeenCalledWith(
      'Streaming session finished',
      expect.objectContaining({ chars: WORDS.join(' ').length, finishDecodes: expect.any(Number) })
    )
    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.debug.mock.calls
    ])
    expect(logged).not.toContain('rename this branch')
  })
})
