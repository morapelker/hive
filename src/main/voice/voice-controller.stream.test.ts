/**
 * VOICE-05: with a streaming speech model, the recording's audio flows from
 * the HUD into an engine session while the user speaks; with an offline model
 * nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VOICE_SETTINGS,
  type VoiceAudioChunk,
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
  readonly options: { sampleRate?: number; onError?: (error: Error) => void }
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
    error instanceof Error && error.name === 'VoiceStreamCancelledError'
}))

vi.mock('./voice-media', () => ({
  voiceMedia: {
    prepare: vi.fn(async () => undefined),
    recordingWillStart: vi.fn(async () => undefined),
    recordingDidStop: vi.fn(async () => undefined)
  }
}))

vi.mock('./voice-model-store', () => ({
  voiceModelStore: {
    onChange: vi.fn(() => () => {}),
    isReady: vi.fn(() => true),
    getState: vi.fn(() => ({ status: 'ready' })),
    getModelDir: vi.fn((id: string) => `/tmp/models/${id}`),
    download: vi.fn(async () => undefined),
    cancel: vi.fn(),
    delete: vi.fn(async () => undefined)
  }
}))

vi.mock('./voice-paste', () => ({
  deliverVoiceText: vi.fn(async () => 'pasted' as const),
  probeVoiceFocus: vi.fn(async () => null)
}))

vi.mock('./voice-cleanup', () => ({
  enhanceTranscript: vi.fn(async (raw: string) => ({
    text: raw,
    cleaned: false,
    fallbackReason: null,
    ai: 'disabled'
  }))
}))

const audio = vi.hoisted(() => ({
  trimSilence: (samples: Float32Array) => samples,
  isDigitalSilence: vi.fn(() => false)
}))
vi.mock('./voice-audio', () => audio)

const testClips = vi.hoisted(() => ({
  enabled: false,
  reportStream: vi.fn(),
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

function makeDb(): { addVoiceHistory: ReturnType<typeof vi.fn>; getSetting: () => null } {
  return {
    getSetting: () => null,
    addVoiceHistory: vi.fn(() => null)
  }
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

  it('still delivers the whole-clip transcript (the session text is not used yet)', async () => {
    controller.applySettings(STREAMING)
    const session = (await record())!
    const clip = recording(12 * CHUNK)
    for (const chunk of chunksOf(clip, streamId())) controller.onAudioChunk(chunk)
    controller.onHudStopClick()
    controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))
    expect(engine.transcribe).toHaveBeenCalledWith(clip, 16_000)
    expect(session.finish).toHaveBeenCalledTimes(1)
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

  it('keeps the dictation going when the session fails: the whole clip is still transcribed', async () => {
    controller.applySettings(STREAMING)
    const session = (await record())!
    session.finish.mockRejectedValueOnce(new Error('Speech engine exited (code 9)'))
    session.options.onError?.(new Error('Speech engine exited (code 9)'))
    const clip = recording(10 * CHUNK)
    for (const chunk of chunksOf(clip, streamId())) controller.onAudioChunk(chunk)
    controller.onHudStopClick()
    controller.onAudio({ samples: clip, sampleRate: 16_000, durationMs: 0 })
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))
    expect(engine.transcribe).toHaveBeenCalledWith(clip, 16_000)
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith('Streaming session did not finish', {
        error: 'Speech engine exited (code 9)'
      })
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
