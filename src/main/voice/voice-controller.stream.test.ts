/**
 * VOICE-05: with a streaming speech model, the recording's audio flows from
 * the HUD into an engine session while the user speaks; with an offline model
 * nothing changes.
 *
 * VOICE-06: the session's transcript updates become the HUD's live preview,
 * its final text becomes the dictation's transcript at stop, the whole clip is
 * the fallback when the session can't be used, and the streaming model is kept
 * warm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import {
  DEFAULT_VOICE_SETTINGS,
  type VoiceAudioChunk,
  type VoiceHudState,
  type VoiceSettings
} from '@shared/types/voice'

const electron = vi.hoisted(() => ({
  app: {
    on: vi.fn(),
    off: vi.fn(),
    getPath: vi.fn(() => '/tmp/tedooo-code-test-voice'),
    commandLine: { hasSwitch: vi.fn(() => true) }
  },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true)
  },
  shell: { openExternal: vi.fn(async () => undefined) },
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  utilityProcess: { fork: vi.fn() },
  screen: { getDisplayMatching: vi.fn(), getPrimaryDisplay: vi.fn() },
  net: {},
  BrowserWindow: vi.fn()
}))
vi.mock('electron', () => electron)

const hud = vi.hoisted(() => ({
  configure: vi.fn(),
  ensureCreated: vi.fn(),
  waitUntilReady: vi.fn(async () => true),
  setState: vi.fn(),
  getState: vi.fn(() => ({ phase: { kind: 'hidden' }, sounds: false })),
  show: vi.fn(),
  hide: vi.fn(),
  startCapture: vi.fn(),
  stopCapture: vi.fn(),
  cancelCapture: vi.fn(),
  playSound: vi.fn(),
  destroy: vi.fn()
}))
vi.mock('./voice-hud-window', () => ({ voiceHud: hud }))

interface FakeSession {
  readonly model: { id: string; dir: string }
  readonly options: {
    sampleRate?: number
    onUpdate?: (text: string) => void
    onError?: (error: Error) => void
  }
  readonly pushed: Float32Array[]
  push: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

const sessions = vi.hoisted(() => ({ all: [] as FakeSession[] }))

const engine = vi.hoisted(() => ({
  isLoaded: false,
  loadedModel: null,
  onLoadedChange: vi.fn(() => () => {}),
  setIdleUnloadMinutes: vi.fn(),
  ensureLoaded: vi.fn(async () => undefined),
  transcribe: vi.fn(async () => ({ text: 'create a ticket', decodeMs: 3 })),
  startSession: vi.fn(
    (model: { id: string; dir: string }, options: FakeSession['options']): FakeSession => {
      const pushed: Float32Array[] = []
      const session: FakeSession = {
        model,
        options,
        pushed,
        push: vi.fn((samples: Float32Array) => {
          pushed.push(samples)
        }),
        finish: vi.fn(async () => ({
          text: 'create a ticket',
          finishMs: 12,
          workerFinishMs: 9,
          finishDecodes: 1,
          audioMs: Math.round(
            (pushed.reduce((sum, chunk) => sum + chunk.length, 0) / 16_000) * 1000
          ),
          busyMs: 4
        })),
        cancel: vi.fn()
      }
      sessions.all.push(session)
      return session
    }
  ),
  unload: vi.fn(),
  dispose: vi.fn()
}))
vi.mock('./voice-engine', () => ({
  voiceEngine: engine,
  isVoiceStreamCancelled: (error: unknown) =>
    error instanceof Error && error.name === 'VoiceStreamCancelledError',
  isVoiceEngineExited: (error: unknown) =>
    error instanceof Error && error.name === 'VoiceEngineExitedError'
}))

vi.mock('./voice-media', () => ({
  voiceMedia: {
    prepare: vi.fn(async () => undefined),
    recordingWillStart: vi.fn(async () => undefined),
    recordingDidStop: vi.fn(async () => undefined)
  }
}))

const modelStore = vi.hoisted(() => ({
  listeners: [] as Array<(modelId: string) => void>,
  isReady: vi.fn((_id: string) => true)
}))
vi.mock('./voice-model-store', () => ({
  voiceModelStore: {
    onChange: vi.fn((listener: (modelId: string) => void) => {
      modelStore.listeners.push(listener)
      return () => {
        modelStore.listeners = modelStore.listeners.filter((l) => l !== listener)
      }
    }),
    isReady: modelStore.isReady,
    getState: vi.fn(() => ({ status: 'ready' })),
    getModelDir: vi.fn((id: string) => `/tmp/models/${id}`),
    download: vi.fn(async () => undefined),
    cancel: vi.fn(),
    delete: vi.fn(async () => undefined)
  }
}))

const paste = vi.hoisted(() => ({
  deliverVoiceText: vi.fn(async () => 'pasted' as const),
  probeVoiceFocus: vi.fn(async () => null)
}))
vi.mock('./voice-paste', () => paste)

const cleanup = vi.hoisted(() => ({
  enhanceTranscript: vi.fn(async (raw: string) => ({
    text: raw,
    cleaned: false,
    fallbackReason: null,
    ai: 'disabled'
  }))
}))
vi.mock('./voice-cleanup', () => cleanup)

const audio = vi.hoisted(() => ({
  trimSilence: (samples: Float32Array) => samples,
  isDigitalSilence: vi.fn(() => false)
}))
vi.mock('./voice-audio', () => audio)

const testClips = vi.hoisted(() => ({
  enabled: false,
  reportStream: vi.fn(),
  reportPreview: vi.fn(),
  captureSource: vi.fn(() => undefined),
  captureEnded: vi.fn()
}))
vi.mock('./voice-test-clips', () => ({ voiceTestClips: testClips }))

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../services/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/logger')>()),
  createLogger: () => logger
}))

import { VoiceController } from './voice-controller'
import { DICTATION_SUMMARY_MESSAGE, type DictationSummary } from './voice-dictation-summary'

const STREAMING: VoiceSettings = {
  ...DEFAULT_VOICE_SETTINGS,
  enabled: true,
  speechModel: 'nemotron-speech-streaming-en-0.6b',
  cleanup: { ...DEFAULT_VOICE_SETTINGS.cleanup, enabled: false }
}
const OFFLINE: VoiceSettings = { ...STREAMING, speechModel: 'parakeet-tdt-0.6b-v2' }

/** The HUD's capture chunk: 1536 samples at 16 kHz ≈ 96 ms. */
const CHUNK = 1536

function makeWindow(): import('electron').BrowserWindow {
  return {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: { send: vi.fn(), isFocused: () => true }
  } as unknown as import('electron').BrowserWindow
}

function makeDb(saved: VoiceSettings | null = null): {
  addVoiceHistory: ReturnType<typeof vi.fn>
  getSetting: (key: string) => string | null
} {
  return {
    getSetting: (key) =>
      saved && key === APP_SETTINGS_DB_KEY ? JSON.stringify({ voice: saved }) : null,
    addVoiceHistory: vi.fn(() => null)
  }
}

function summaries(): DictationSummary[] {
  return logger.info.mock.calls
    .filter(([message]) => message === DICTATION_SUMMARY_MESSAGE)
    .map(([, data]) => data as DictationSummary)
}

function onlySummary(): DictationSummary {
  const all = summaries()
  expect(all).toHaveLength(1)
  return all[0]
}

/** Every state the controller sent to the HUD, oldest first. */
function hudStates(): VoiceHudState[] {
  return hud.setState.mock.calls.map(([state]) => state as VoiceHudState)
}

/** The text the controller handed to the paste target. */
function pasted(): string[] {
  return paste.deliverVoiceText.mock.calls.map((call) => (call as unknown[])[1] as string)
}

/** The engine's error for a worker that exited (the real class is mocked away). */
function engineExited(code: number): Error {
  return Object.assign(new Error(`Speech engine exited (code ${code})`), {
    name: 'VoiceEngineExitedError'
  })
}

/** Lets queued microtasks and the session's async callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A recording of `length` samples, as the HUD captures it. */
function recording(length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => ((i % 97) - 48) / 100)
}

/** The streamId the controller handed to the HUD for the current capture. */
function streamId(): number {
  const options = hud.startCapture.mock.lastCall?.[0] as { streamId?: number } | undefined
  expect(options?.streamId).toEqual(expect.any(Number))
  return options!.streamId!
}

/** What the HUD sends: the clip cut into worklet-sized chunks, the last one partial. */
function chunksOf(samples: Float32Array, id: number): VoiceAudioChunk[] {
  const chunks: VoiceAudioChunk[] = []
  for (let from = 0, seq = 0; from < samples.length; from += CHUNK, seq++) {
    chunks.push({
      streamId: id,
      seq,
      samples: samples.slice(from, from + CHUNK),
      sampleRate: 16_000
    })
  }
  return chunks
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function pressEscape(): void {
  const call = electron.globalShortcut.register.mock.calls.find(
    ([accelerator]) => accelerator === 'Escape'
  ) as unknown as [string, () => void] | undefined
  expect(call).toBeDefined()
  call![1]()
}

describe('VoiceController streaming captured audio (VOICE-05)', () => {
  let controller: VoiceController
  let now = 1_000_000

  beforeEach(() => {
    vi.clearAllMocks()
    sessions.all.length = 0
    // Successive dictations need presses further apart than the toggle debounce.
    now += 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    controller = new VoiceController()
    controller.init({ db: makeDb() as never, getMainWindow: makeWindow, headless: false })
  })

  afterEach(() => {
    controller.dispose()
    vi.restoreAllMocks()
    audio.isDigitalSilence.mockReturnValue(false)
    modelStore.isReady.mockReturnValue(true)
    engine.loadedModel = null
  })

  async function record(): Promise<FakeSession | undefined> {
    now += 1_000
    await controller.toggle()
    expect(controller.getStatus().state).toBe('recording')
    controller.onCaptureStarted()
    return sessions.all.at(-1)
  }

  it('opens a session at recording start, before the HUD starts capturing, with a stream id', async () => {
    controller.applySettings(STREAMING)
    const session = await record()

    expect(engine.startSession).toHaveBeenCalledTimes(1)
    expect(session!.model).toEqual({
      id: 'nemotron-speech-streaming-en-0.6b',
      dir: '/tmp/models/nemotron-speech-streaming-en-0.6b'
    })
    expect(session!.options.sampleRate).toBe(16_000)
    expect(engine.startSession.mock.invocationCallOrder[0]).toBeLessThan(
      hud.startCapture.mock.invocationCallOrder[0]
    )
    streamId()
  })

  it('feeds every chunk into the session as it arrives, then finishes it at stop with exactly the clip', async () => {
    controller.applySettings(STREAMING)
    const session = (await record())!
    const clip = recording(5 * CHUNK + 700)
    const chunks = chunksOf(clip, streamId())

    for (const chunk of chunks.slice(0, 3)) controller.onAudioChunk(chunk)
    expect(session.pushed).toHaveLength(3)

    controller.onHudStopClick()
    expect(hud.stopCapture).toHaveBeenCalledTimes(1)
    // The rest, including the partial chunk flushed at stop, lands before the clip.
    for (const chunk of chunks.slice(3)) controller.onAudioChunk(chunk)
    expect(session.finish).not.toHaveBeenCalled()
    controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))

    expect(session.finish).toHaveBeenCalledTimes(1)
    expect(session.cancel).not.toHaveBeenCalled()
    expect(session.pushed).toHaveLength(chunks.length)
    expect(concat(session.pushed)).toEqual(clip)
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith('Streamed dictation audio', {
        chunks: chunks.length,
        streamedMs: Math.round((clip.length / 16_000) * 1000),
        topUpMs: 0,
        clipMs: Math.round((clip.length / 16_000) * 1000),
        sessionAudioMs: Math.round((clip.length / 16_000) * 1000),
        finishMs: 12,
        chars: 'create a ticket'.length
      })
    )
    expect(testClips.reportStream).toHaveBeenCalledWith(
      expect.objectContaining({ chunks: chunks.length, text: 'create a ticket' })
    )
    // The streamed text is never logged.
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('create a ticket')
  })

  it("delivers the session's final text, without transcribing the whole clip (VOICE-06)", async () => {
    controller.applySettings(STREAMING)
    const session = (await record())!
    session.finish.mockResolvedValueOnce({
      text: 'streamed words',
      finishMs: 61,
      workerFinishMs: 38,
      finishDecodes: 1,
      audioMs: 768,
      busyMs: 40
    })
    const clip = recording(8 * CHUNK)
    for (const chunk of chunksOf(clip, streamId())) controller.onAudioChunk(chunk)
    controller.onHudStopClick()
    controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))
    expect(session.finish).toHaveBeenCalledTimes(1)
    expect(engine.transcribe).not.toHaveBeenCalled()
    expect(pasted()).toEqual(['streamed words'])
  })

  it('tops the session up from the clip when the last chunk never came, so no words are cut off', async () => {
    controller.applySettings(STREAMING)
    const session = (await record())!
    const clip = recording(10 * CHUNK + 300)
    const chunks = chunksOf(clip, streamId())
    for (const chunk of chunks.slice(0, -1)) controller.onAudioChunk(chunk)
    controller.onHudStopClick()
    controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(session.finish).toHaveBeenCalledTimes(1))
    expect(concat(session.pushed)).toEqual(clip)
    expect(session.push.mock.invocationCallOrder.at(-1)).toBeLessThan(
      session.finish.mock.invocationCallOrder[0]
    )
    // A chunk straggling in after the clip is ignored, not fed twice.
    controller.onAudioChunk(chunks.at(-1)!)
    expect(concat(session.pushed)).toEqual(clip)
  })

  it('ignores chunks from an earlier capture', async () => {
    controller.applySettings(STREAMING)
    const session = (await record())!
    const id = streamId()
    controller.onAudioChunk({
      streamId: id - 1,
      seq: 0,
      samples: new Float32Array(CHUNK),
      sampleRate: 16_000
    })
    expect(session.push).not.toHaveBeenCalled()
  })

  it('cancels the session on Escape while recording; the next dictation gets a fresh one', async () => {
    controller.applySettings(STREAMING)
    const first = (await record())!
    const firstId = streamId()
    controller.onAudioChunk(chunksOf(recording(CHUNK), firstId)[0])
    pressEscape()

    expect(first.cancel).toHaveBeenCalled()
    expect(hud.cancelCapture).toHaveBeenCalledTimes(1)
    expect(controller.getStatus().state).toBe('idle')
    // A chunk that was already on its way is dropped.
    controller.onAudioChunk({ ...chunksOf(recording(CHUNK), firstId)[0], seq: 1 })
    expect(first.pushed).toHaveLength(1)

    const second = (await record())!
    expect(second).not.toBe(first)
    const secondId = streamId()
    expect(secondId).not.toBe(firstId)
    const clip = recording(8 * CHUNK)
    for (const chunk of chunksOf(clip, secondId)) controller.onAudioChunk(chunk)
    controller.onHudStopClick()
    controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(second.finish).toHaveBeenCalledTimes(1))
    expect(concat(second.pushed)).toEqual(clip)
    expect(first.finish).not.toHaveBeenCalled()
  })

  it('cancels the session when voice is disabled mid-recording', async () => {
    controller.applySettings(STREAMING)
    const session = (await record())!
    controller.applySettings({ ...STREAMING, enabled: false })
    expect(session.cancel).toHaveBeenCalled()
    expect(session.finish).not.toHaveBeenCalled()
  })

  it('cancels the session when the microphone fails to open', async () => {
    controller.applySettings(STREAMING)
    now += 1_000
    await controller.toggle()
    const session = sessions.all.at(-1)!
    controller.onCaptureError('NotReadableError: device busy')
    expect(session.cancel).toHaveBeenCalled()
  })

  it('cancels the session for a clip discarded as too short or silent', async () => {
    controller.applySettings(STREAMING)
    const short = (await record())!
    controller.onHudStopClick()
    controller.onAudio({ samples: recording(4_000), sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))
    expect(short.cancel).toHaveBeenCalled()
    expect(short.finish).not.toHaveBeenCalled()

    audio.isDigitalSilence.mockReturnValue(true)
    const silent = (await record())!
    controller.onHudStopClick()
    controller.onAudio({ samples: new Float32Array(32_000), sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(controller.getStatus().notice).toBe('Nothing heard'))
    expect(silent.cancel).toHaveBeenCalled()
    expect(silent.finish).not.toHaveBeenCalled()
  })

  it('cancels the session when the clip never arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      controller.applySettings(STREAMING)
      const session = (await record())!
      controller.onHudStopClick()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(controller.getStatus().notice).toBe('Transcription failed')
      expect(session.cancel).toHaveBeenCalled()
      expect(session.finish).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the dictation going when the session fails: the whole clip is transcribed instead', async () => {
    controller.applySettings(STREAMING)
    const session = (await record())!
    session.finish.mockRejectedValueOnce(engineExited(9))
    session.options.onError?.(engineExited(9))
    const clip = recording(10 * CHUNK)
    for (const chunk of chunksOf(clip, streamId())) controller.onAudioChunk(chunk)
    controller.onHudStopClick()
    controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))
    expect(engine.transcribe).toHaveBeenCalledWith(clip, 16_000)
    expect(pasted()).toEqual(['create a ticket'])
    expect(logger.warn).toHaveBeenCalledWith('Streaming session failed during dictation', {
      error: 'Speech engine exited (code 9)'
    })
    expect(logger.warn).toHaveBeenCalledWith(
      'Transcribing the whole clip instead of the streamed text',
      { reason: 'engine-exited', error: 'Speech engine exited (code 9)' }
    )
  })

  it('with an offline model: no session, no stream id, the HUD capture starts exactly as before', async () => {
    controller.applySettings(OFFLINE)
    await record()
    expect(engine.startSession).not.toHaveBeenCalled()
    expect(hud.startCapture).toHaveBeenCalledWith({})
    // A stray chunk has nowhere to go.
    controller.onAudioChunk({
      streamId: 1,
      seq: 0,
      samples: new Float32Array(CHUNK),
      sampleRate: 16_000
    })
    const clip = recording(10 * CHUNK)
    controller.onHudStopClick()
    controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))
    expect(engine.transcribe).toHaveBeenCalledWith(clip, 16_000)
    expect(logger.info).not.toHaveBeenCalledWith('Streamed dictation audio', expect.anything())
  })
})

describe('VoiceController streaming dictation flow (VOICE-06)', () => {
  let controller: VoiceController
  let now = 5_000_000

  beforeEach(() => {
    vi.clearAllMocks()
    sessions.all.length = 0
    now += 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    controller = new VoiceController()
    controller.init({ db: makeDb() as never, getMainWindow: makeWindow, headless: false })
  })

  afterEach(() => {
    controller.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
    audio.isDigitalSilence.mockReturnValue(false)
    modelStore.isReady.mockReturnValue(true)
    engine.loadedModel = null
  })

  async function record(): Promise<FakeSession> {
    now += 1_000
    await controller.toggle()
    expect(controller.getStatus().state).toBe('recording')
    controller.onCaptureStarted()
    return sessions.all.at(-1)!
  }

  /** Stream `clip` as the HUD would, stop, hand over the clip, and wait for the dictation to end. */
  async function stopWith(clip: Float32Array, options: { chunks?: VoiceAudioChunk[] } = {}) {
    for (const chunk of options.chunks ?? chunksOf(clip, streamId())) {
      controller.onAudioChunk(chunk)
    }
    controller.onHudStopClick()
    controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(controller.getStatus().state).not.toBe('processing'))
  }

  function streamedResult(text: string, clip: Float32Array) {
    return {
      text,
      finishMs: 64,
      workerFinishMs: 41,
      finishDecodes: 1,
      audioMs: Math.round((clip.length / 16_000) * 1000),
      busyMs: 30
    }
  }

  describe('stream path', () => {
    it('uses the session text, and the summary says it streamed', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      const clip = recording(20 * CHUNK)
      session.finish.mockResolvedValueOnce(streamedResult('ship the release notes', clip))
      await stopWith(clip)

      expect(engine.transcribe).not.toHaveBeenCalled()
      expect(pasted()).toEqual(['ship the release notes'])
      expect(onlySummary()).toMatchObject({
        outcome: 'delivered',
        speechModel: 'nemotron-speech-streaming-en-0.6b',
        streamed: true,
        textSource: 'streamed',
        fallbackReason: null,
        decodeMs: 41,
        delivery: 'pasted',
        chars: 'ship the release notes'.length
      })
      const summary = onlySummary()
      expect(summary.stopToTranscriptMs).toEqual(expect.any(Number))
      expect(summary.stopToDeliveredMs!).toBeGreaterThanOrEqual(summary.stopToTranscriptMs!)
      expect(logger.info).toHaveBeenCalledWith('Transcribed', {
        seconds: 1.9,
        source: 'streamed',
        decodeMs: 41,
        chars: 'ship the release notes'.length
      })
      expect(testClips.reportStream).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'ship the release notes',
          textSource: 'streamed',
          fallbackReason: null,
          error: null
        })
      )
      // Never the transcript in the log.
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain('release notes')
    })

    it('goes on to the AI step as before, showing the final transcript with the dictionary applied', async () => {
      controller.applySettings({
        ...STREAMING,
        cleanup: { ...STREAMING.cleanup, enabled: true },
        dictionary: [{ word: 'Tedooo', soundsLike: ['tedo'], caseSensitive: false }]
      })
      const session = await record()
      const clip = recording(12 * CHUNK)
      session.finish.mockResolvedValueOnce(streamedResult('open tedo settings', clip))
      await stopWith(clip)

      expect(cleanup.enhanceTranscript).toHaveBeenCalledWith(
        'open tedo settings',
        expect.objectContaining({ cleanup: expect.objectContaining({ enabled: true }) }),
        expect.anything()
      )
      const enhancing = hudStates().find((state) => state.phase.kind === 'enhancing')
      expect(enhancing?.transcript).toBe('open Tedooo settings')
      expect(hudStates().at(-1)).toEqual({ phase: { kind: 'hidden' }, sounds: true })
    })

    it('lets the user skip polishing: the shown streamed text is pasted at once (VOICE-08)', async () => {
      controller.applySettings({
        ...STREAMING,
        cleanup: { ...STREAMING.cleanup, enabled: true },
        dictionary: [{ word: 'Tedooo', soundsLike: ['tedo'], caseSensitive: false }]
      })
      let signal: AbortSignal | undefined
      cleanup.enhanceTranscript.mockImplementationOnce(
        (_raw: string, _settings?: unknown, deps?: { signal?: AbortSignal }) => {
          signal = deps?.signal
          return new Promise<never>(() => {})
        }
      )
      const session = await record()
      const clip = recording(12 * CHUNK)
      session.finish.mockResolvedValueOnce(streamedResult('open tedo settings', clip))
      for (const chunk of chunksOf(clip, streamId())) controller.onAudioChunk(chunk)
      controller.onHudStopClick()
      controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
      await vi.waitFor(() => expect(hudStates().at(-1)?.phase.kind).toBe('enhancing'))

      expect(controller.skipPolishing('click')).toBe(true)
      await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))
      expect(pasted()).toEqual(['open Tedooo settings'])
      expect(signal?.aborted).toBe(true)
      expect(onlySummary()).toMatchObject({
        outcome: 'delivered',
        textSource: 'streamed',
        aiStep: 'skipped',
        skipInput: 'click'
      })
    })

    it('delivers to the agent with the streamed text, a live preview and no AI step', async () => {
      controller.setUiContext({
        boardIdle: true,
        ticketOpen: false,
        sessionOpen: false,
        agentPanelOpen: true,
        agentAvailable: true
      })
      controller.applySettings({ ...STREAMING, cleanup: { ...STREAMING.cleanup, enabled: true } })
      const session = await record()
      session.options.onUpdate?.('fix the')
      expect(hudStates().at(-1)).toEqual({
        phase: { kind: 'recording', target: 'agent' },
        sounds: true,
        transcript: 'fix the'
      })
      const clip = recording(12 * CHUNK)
      session.finish.mockResolvedValueOnce(streamedResult('fix the flaky test', clip))
      await stopWith(clip)
      expect(onlySummary()).toMatchObject({
        target: 'agent',
        delivery: 'agent',
        aiStep: 'not-applicable',
        textSource: 'streamed'
      })
      expect(cleanup.enhanceTranscript).toHaveBeenCalledWith(
        'fix the flaky test',
        expect.objectContaining({ cleanup: expect.objectContaining({ enabled: false }) }),
        expect.anything()
      )
      expect(hudStates().some((state) => state.phase.kind === 'enhancing')).toBe(false)
      expect(engine.transcribe).not.toHaveBeenCalled()
      expect(paste.deliverVoiceText).not.toHaveBeenCalled()
    })
  })

  describe('fallback to the whole clip', () => {
    async function expectFallback(reason: string): Promise<void> {
      expect(engine.ensureLoaded).toHaveBeenLastCalledWith({
        id: 'nemotron-speech-streaming-en-0.6b',
        dir: '/tmp/models/nemotron-speech-streaming-en-0.6b'
      })
      expect(engine.transcribe).toHaveBeenCalledTimes(1)
      expect(pasted()).toEqual(['whole clip words'])
      expect(onlySummary()).toMatchObject({
        outcome: 'delivered',
        streamed: true,
        textSource: 'fallback',
        fallbackReason: reason,
        decodeMs: 420
      })
      expect(logger.warn).toHaveBeenCalledWith(
        'Transcribing the whole clip instead of the streamed text',
        expect.objectContaining({ reason })
      )
      expect(testClips.reportStream).toHaveBeenCalledWith(
        expect.objectContaining({ textSource: 'fallback', fallbackReason: reason })
      )
    }

    beforeEach(() => {
      engine.transcribe.mockResolvedValueOnce({ text: 'whole clip words', decodeMs: 420 })
    })

    it('when the session errored', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      const failure = new Error('Speech engine did not answer within 10s')
      session.finish.mockRejectedValueOnce(failure)
      session.options.onError?.(failure)
      const clip = recording(10 * CHUNK)
      await stopWith(clip)
      await expectFallback('session-error')
      // The whole clip, trimmed as for an offline model.
      expect(engine.transcribe).toHaveBeenCalledWith(clip, 16_000)
    })

    it('when the engine crashed mid-dictation, reloading the model straight away', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      const loadsBefore = engine.ensureLoaded.mock.calls.length
      session.finish.mockRejectedValueOnce(engineExited(137))
      session.options.onError?.(engineExited(137))
      // The model is reloaded while the user is still speaking, so the fallback is warm.
      expect(engine.ensureLoaded.mock.calls.length).toBe(loadsBefore + 1)
      expect(controller.getStatus().state).toBe('recording')
      await stopWith(recording(10 * CHUNK))
      await expectFallback('engine-exited')
    })

    it('when the engine crashed while finishing', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      session.finish.mockRejectedValueOnce(engineExited(139))
      await stopWith(recording(10 * CHUNK))
      await expectFallback('engine-exited')
    })

    it('when the HUD audio broke off (a chunk went missing)', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      const clip = recording(10 * CHUNK)
      const chunks = chunksOf(clip, streamId())
      await stopWith(clip, { chunks: [chunks[0], ...chunks.slice(2)] })
      expect(session.cancel).toHaveBeenCalled()
      expect(session.finish).not.toHaveBeenCalled()
      await expectFallback('stream-broken')
    })

    it('when the session heard nothing in a clip that passed the speech checks', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      const clip = recording(10 * CHUNK)
      session.finish.mockResolvedValueOnce(streamedResult('', clip))
      await stopWith(clip)
      await expectFallback('empty-text')
    })

    it('when the session did not get the whole clip', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      const clip = recording(40 * CHUNK)
      session.finish.mockResolvedValueOnce({
        ...streamedResult('half of it', clip),
        audioMs: 1_900
      })
      await stopWith(clip)
      await expectFallback('incomplete-audio')
    })

    it('when the session was cancelled under a dictation that still needed it', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      session.finish.mockRejectedValueOnce(
        Object.assign(new Error('The streaming session was cancelled'), {
          name: 'VoiceStreamCancelledError'
        })
      )
      await stopWith(recording(10 * CHUNK))
      await expectFallback('stream-cancelled')
    })

    it('says "Nothing heard" and inserts nothing when the whole clip has no words either', async () => {
      engine.transcribe.mockReset()
      engine.transcribe.mockResolvedValueOnce({ text: '', decodeMs: 300 })
      controller.applySettings(STREAMING)
      const session = await record()
      const clip = recording(10 * CHUNK)
      session.finish.mockResolvedValueOnce(streamedResult('', clip))
      await stopWith(clip)
      expect(engine.transcribe).toHaveBeenCalledTimes(1)
      expect(paste.deliverVoiceText).not.toHaveBeenCalled()
      expect(controller.getStatus().notice).toBe('Nothing heard')
      expect(onlySummary()).toMatchObject({
        outcome: 'discarded',
        reason: 'nothing-heard',
        textSource: 'fallback',
        fallbackReason: 'empty-text'
      })
      engine.transcribe.mockResolvedValue({ text: 'create a ticket', decodeMs: 3 })
    })

    it('reports a failed transcription when the fallback fails too', async () => {
      engine.transcribe.mockReset()
      engine.transcribe.mockRejectedValueOnce(new Error('Speech model is not ready yet'))
      controller.applySettings(STREAMING)
      const session = await record()
      session.finish.mockRejectedValueOnce(engineExited(9))
      await stopWith(recording(10 * CHUNK))
      expect(paste.deliverVoiceText).not.toHaveBeenCalled()
      expect(controller.getStatus().notice).toBe('Transcription failed')
      expect(onlySummary()).toMatchObject({ outcome: 'failed', reason: 'transcription-error' })
      engine.transcribe.mockResolvedValue({ text: 'create a ticket', decodeMs: 3 })
    })
  })

  describe('discard rules and cancel', () => {
    it('discards a too-short clip without finishing the session or transcribing', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      await stopWith(recording(4_000))
      expect(session.cancel).toHaveBeenCalled()
      expect(session.finish).not.toHaveBeenCalled()
      expect(engine.transcribe).not.toHaveBeenCalled()
      expect(onlySummary()).toMatchObject({
        outcome: 'discarded',
        reason: 'too-short',
        streamed: true,
        textSource: null
      })
    })

    it('says "Nothing heard" for silence before any decoding, and inserts nothing', async () => {
      audio.isDigitalSilence.mockReturnValue(true)
      controller.applySettings(STREAMING)
      const session = await record()
      await stopWith(new Float32Array(48_000))
      expect(session.finish).not.toHaveBeenCalled()
      expect(engine.transcribe).not.toHaveBeenCalled()
      expect(paste.deliverVoiceText).not.toHaveBeenCalled()
      expect(controller.getStatus().notice).toBe('Nothing heard')
      expect(onlySummary()).toMatchObject({ outcome: 'discarded', reason: 'nothing-heard' })
    })

    it('Escape while recording discards everything; the next dictation starts clean', async () => {
      controller.applySettings(STREAMING)
      const first = await record()
      first.options.onUpdate?.('create a')
      pressEscape()
      expect(first.cancel).toHaveBeenCalled()
      expect(onlySummary()).toMatchObject({ outcome: 'cancelled', reason: 'escape' })
      // A late update from the cancelled session goes nowhere.
      const sentBefore = hud.setState.mock.calls.length
      first.options.onUpdate?.('create a ticket')
      expect(hud.setState.mock.calls.length).toBe(sentBefore)

      logger.info.mockClear()
      const second = await record()
      expect(second).not.toBe(first)
      // The new recording shows no leftover text.
      expect(hudStates().at(-1)).toEqual({
        phase: { kind: 'recording', target: 'paste' },
        sounds: true
      })
      const clip = recording(8 * CHUNK)
      second.finish.mockResolvedValueOnce(streamedResult('second dictation', clip))
      await stopWith(clip)
      expect(pasted()).toEqual(['second dictation'])
      expect(engine.transcribe).not.toHaveBeenCalled()
    })

    it.each([
      ['its text arrives too late', 'resolve'],
      ['its finish is rejected as cancelled', 'reject']
    ] as const)(
      'Escape while the session finishes (%s): nothing is inserted and no fallback runs',
      async (_label, outcome) => {
        controller.applySettings(STREAMING)
        const session = await record()
        let resolve: (value: unknown) => void = () => {}
        let reject: (error: Error) => void = () => {}
        session.finish.mockImplementationOnce(
          () =>
            new Promise((res, rej) => {
              resolve = res
              reject = rej
            })
        )
        const clip = recording(8 * CHUNK)
        for (const chunk of chunksOf(clip, streamId())) controller.onAudioChunk(chunk)
        controller.onHudStopClick()
        controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
        await vi.waitFor(() => expect(session.finish).toHaveBeenCalled())
        engine.ensureLoaded.mockClear()
        pressEscape()
        if (outcome === 'resolve') {
          resolve(streamedResult('too late', clip))
        } else {
          reject(
            Object.assign(new Error('The streaming session was cancelled'), {
              name: 'VoiceStreamCancelledError'
            })
          )
        }
        await settle()
        expect(paste.deliverVoiceText).not.toHaveBeenCalled()
        expect(engine.ensureLoaded).not.toHaveBeenCalled()
        expect(engine.transcribe).not.toHaveBeenCalled()
        // The cancelled dictation leaves no stream report and no fallback warning behind.
        expect(testClips.reportStream).not.toHaveBeenCalled()
        expect(logger.warn).not.toHaveBeenCalledWith(
          'Transcribing the whole clip instead of the streamed text',
          expect.anything()
        )
        expect(onlySummary()).toMatchObject({ outcome: 'cancelled', reason: 'escape' })
      }
    )

    it('disabling voice mid-recording cancels the session and unloads the engine', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      session.options.onUpdate?.('create a')
      controller.applySettings({ ...STREAMING, enabled: false })
      expect(session.cancel).toHaveBeenCalled()
      expect(engine.unload).toHaveBeenCalledWith('voice disabled')
      expect(hudStates().at(-1)?.transcript).toBeUndefined()
      expect(onlySummary()).toMatchObject({ outcome: 'cancelled', reason: 'voice-disabled' })
    })
  })

  describe('live preview', () => {
    it('passes each transcript update on to the HUD, dictionary applied, while recording', async () => {
      controller.applySettings({
        ...STREAMING,
        dictionary: [{ word: 'Tedooo', soundsLike: ['tedo'], caseSensitive: false }]
      })
      const session = await record()
      session.options.onUpdate?.('open')
      expect(hudStates().at(-1)).toEqual({
        phase: { kind: 'recording', target: 'paste' },
        sounds: true,
        transcript: 'open'
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      session.options.onUpdate?.('open tedo')
      expect(hudStates().at(-1)?.transcript).toBe('open Tedooo')
      expect(testClips.reportPreview.mock.calls).toEqual([['open'], ['open Tedooo']])

      // After stop the last text stays up while the final transcript is fetched…
      const clip = recording(12 * CHUNK)
      session.finish.mockResolvedValueOnce(streamedResult('open tedo settings', clip))
      for (const chunk of chunksOf(clip, streamId())) controller.onAudioChunk(chunk)
      controller.onHudStopClick()
      expect(hudStates().at(-1)).toMatchObject({
        phase: { kind: 'transcribing' },
        transcript: 'open Tedooo'
      })
      // …and later updates from the session are not shown, however late they come.
      await new Promise((resolve) => setTimeout(resolve, 200))
      session.options.onUpdate?.('open tedo set')
      expect(hudStates().at(-1)?.transcript).toBe('open Tedooo')
      expect(testClips.reportPreview).toHaveBeenCalledTimes(2)
      controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
      await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))
      // …then, with no AI step, the final transcript (dictionary applied) replaces
      // it on the pill just before delivery hides it.
      expect(hudStates().slice(-2)).toEqual([
        {
          phase: { kind: 'transcribing', progress: null, showsProgress: false, target: 'paste' },
          sounds: true,
          transcript: 'open Tedooo settings'
        },
        { phase: { kind: 'hidden' }, sounds: true }
      ])
      expect(onlySummary()).toMatchObject({ previewUpdates: 2 })
      expect(onlySummary().captureToPreviewMs).toEqual(expect.any(Number))
    })

    it('caps the update rate: a burst reaches the HUD as its first and latest text', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      const before = hud.setState.mock.calls.length
      const words = 'one two three four five six seven eight'.split(' ')
      for (let i = 1; i <= words.length; i++)
        session.options.onUpdate?.(words.slice(0, i).join(' '))
      expect(hud.setState.mock.calls.length).toBe(before + 1)
      expect(hudStates().at(-1)?.transcript).toBe('one')
      await vi.waitFor(() =>
        expect(hudStates().at(-1)?.transcript).toBe('one two three four five six seven eight')
      )
      expect(hud.setState.mock.calls.length).toBe(before + 2)
      // An update that changes nothing after the dictionary is not sent again.
      await new Promise((resolve) => setTimeout(resolve, 200))
      session.options.onUpdate?.('one two three four five six seven eight ')
      expect(hud.setState.mock.calls.length).toBe(before + 2)
    })

    it('clears the preview when the session fails while recording; recording goes on', async () => {
      controller.applySettings(STREAMING)
      const session = await record()
      session.options.onUpdate?.('create a')
      expect(hudStates().at(-1)?.transcript).toBe('create a')
      session.options.onError?.(engineExited(9))
      expect(controller.getStatus().state).toBe('recording')
      expect(hudStates().at(-1)).toEqual({
        phase: { kind: 'recording', target: 'paste' },
        sounds: true
      })
    })

    it('shows no preview with an offline model, and still shows the final text during the AI step', async () => {
      controller.applySettings({ ...OFFLINE, cleanup: { ...OFFLINE.cleanup, enabled: true } })
      now += 1_000
      await controller.toggle()
      controller.onCaptureStarted()
      expect(engine.startSession).not.toHaveBeenCalled()
      controller.onHudStopClick()
      controller.onAudio({ samples: recording(10 * CHUNK), sampleRate: 16_000, durationMs: 0 })
      await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))
      const states = hudStates()
      expect(states.filter((state) => state.phase.kind === 'recording')).toEqual([
        { phase: { kind: 'recording', target: 'paste' }, sounds: true }
      ])
      expect(states.find((state) => state.phase.kind === 'enhancing')?.transcript).toBe(
        'create a ticket'
      )
      expect(onlySummary()).toMatchObject({
        streamed: false,
        textSource: 'whole-clip',
        fallbackReason: null,
        previewUpdates: null
      })
    })
  })

  describe('keeping the streaming model warm', () => {
    const NEMOTRON_MODEL = {
      id: 'nemotron-speech-streaming-en-0.6b',
      dir: '/tmp/models/nemotron-speech-streaming-en-0.6b'
    }

    it('loads it when voice is turned on', () => {
      controller.applySettings(STREAMING)
      expect(engine.ensureLoaded).toHaveBeenCalledTimes(1)
      expect(engine.ensureLoaded).toHaveBeenCalledWith(NEMOTRON_MODEL)
    })

    it('loads it when voice is turned back on with the same model selected', () => {
      controller.applySettings({ ...STREAMING, enabled: false })
      expect(engine.ensureLoaded).not.toHaveBeenCalled()
      controller.applySettings(STREAMING)
      expect(engine.ensureLoaded).toHaveBeenCalledTimes(1)
      expect(engine.ensureLoaded).toHaveBeenCalledWith(NEMOTRON_MODEL)
      expect(logger.info).toHaveBeenCalledWith(
        'Loading the streaming speech model ahead of dictation',
        { reason: 'voice enabled' }
      )
    })

    it('loads it when the user switches to it', () => {
      controller.applySettings(OFFLINE)
      expect(engine.ensureLoaded).not.toHaveBeenCalled()
      controller.applySettings(STREAMING)
      expect(engine.unload).toHaveBeenCalledWith('speech model changed')
      expect(engine.ensureLoaded).toHaveBeenCalledWith(NEMOTRON_MODEL)
    })

    it('does not reload it on unrelated settings changes (the idle unload still applies)', () => {
      controller.applySettings(STREAMING)
      engine.ensureLoaded.mockClear()
      controller.applySettings({ ...STREAMING, sounds: false })
      controller.applySettings({ ...STREAMING, unloadModelAfterMinutes: 5 })
      expect(engine.ensureLoaded).not.toHaveBeenCalled()
      expect(engine.setIdleUnloadMinutes).toHaveBeenLastCalledWith(5)
    })

    it('skips offline models, a model that is not downloaded yet, and an already loaded model', () => {
      controller.applySettings(OFFLINE)
      controller.applySettings({ ...OFFLINE, enabled: false })
      modelStore.isReady.mockReturnValue(false)
      controller.applySettings(STREAMING)
      controller.applySettings({ ...STREAMING, enabled: false })
      modelStore.isReady.mockReturnValue(true)
      engine.loadedModel = NEMOTRON_MODEL.dir as never
      controller.applySettings(STREAMING)
      expect(engine.ensureLoaded).not.toHaveBeenCalled()
    })

    it('loads it once its download finishes', () => {
      modelStore.isReady.mockReturnValue(false)
      controller.applySettings(STREAMING)
      expect(engine.ensureLoaded).not.toHaveBeenCalled()
      // Progress events while downloading change nothing.
      for (const listener of modelStore.listeners) listener('nemotron-speech-streaming-en-0.6b')
      expect(engine.ensureLoaded).not.toHaveBeenCalled()
      modelStore.isReady.mockReturnValue(true)
      for (const listener of modelStore.listeners) listener('nemotron-speech-streaming-en-0.6b')
      for (const listener of modelStore.listeners) listener('nemotron-speech-streaming-en-0.6b')
      expect(engine.ensureLoaded).toHaveBeenCalledTimes(1)
      expect(engine.ensureLoaded).toHaveBeenCalledWith(NEMOTRON_MODEL)
    })

    it('loads it shortly after the app starts with voice on', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const started = new VoiceController()
      try {
        started.init({ db: makeDb(STREAMING) as never, getMainWindow: makeWindow, headless: false })
        expect(engine.ensureLoaded).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(2_000)
        expect(engine.ensureLoaded).toHaveBeenCalledTimes(1)
        expect(engine.ensureLoaded).toHaveBeenCalledWith(NEMOTRON_MODEL)
      } finally {
        started.dispose()
      }
    })

    it('does not load it at app start when voice is turned off first, or when headless', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const disabled = new VoiceController()
      const headless = new VoiceController()
      try {
        disabled.init({
          db: makeDb(STREAMING) as never,
          getMainWindow: makeWindow,
          headless: false
        })
        disabled.applySettings({ ...STREAMING, enabled: false })
        headless.init({ db: makeDb(STREAMING) as never, getMainWindow: makeWindow, headless: true })
        await vi.advanceTimersByTimeAsync(5_000)
        expect(engine.ensureLoaded).not.toHaveBeenCalled()
      } finally {
        disabled.dispose()
        headless.dispose()
      }
    })

    it('deleting the selected model stops a warm-up that is still loading it', async () => {
      controller.applySettings(STREAMING)
      expect(engine.ensureLoaded).toHaveBeenCalledWith(NEMOTRON_MODEL)
      engine.unload.mockClear()
      // Nothing has finished loading yet.
      expect(engine.loadedModel).toBeNull()
      await controller.deleteModel('nemotron-speech-streaming-en-0.6b')
      expect(engine.unload).toHaveBeenCalledWith('model deleted')

      // Another, unloaded model is deleted without touching the engine.
      engine.unload.mockClear()
      await controller.deleteModel('parakeet-tdt-0.6b-v3')
      expect(engine.unload).not.toHaveBeenCalled()
    })

    it('a warm-up that fails is logged, and dictation still works', async () => {
      engine.ensureLoaded.mockRejectedValueOnce(new Error('Speech engine was unloaded'))
      controller.applySettings(STREAMING)
      await settle()
      expect(logger.warn).toHaveBeenCalledWith('streaming model warm-up failed', {
        reason: 'voice enabled',
        error: 'Error: Speech engine was unloaded'
      })
      const session = await record()
      const clip = recording(8 * CHUNK)
      session.finish.mockResolvedValueOnce(streamedResult('still works', clip))
      await stopWith(clip)
      expect(pasted()).toEqual(['still works'])
    })
  })
})
