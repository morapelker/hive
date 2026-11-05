import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '@shared/types/voice'

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

const engine = vi.hoisted(() => ({
  isLoaded: false,
  loadedModel: null,
  onLoadedChange: vi.fn(() => () => {}),
  setIdleUnloadMinutes: vi.fn(),
  ensureLoaded: vi.fn(async () => undefined),
  transcribe: vi.fn(async () => ({ text: 'create a ticket', decodeMs: 3 })),
  unload: vi.fn(),
  dispose: vi.fn()
}))
vi.mock('./voice-engine', () => ({ voiceEngine: engine }))

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
    getModelDir: vi.fn(() => '/tmp/model'),
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
  enhanceTranscript: vi.fn(
    async (
      raw: string,
      _settings: import('@shared/types/voice').VoiceSettings
    ): Promise<{
      text: string
      cleaned: boolean
      fallbackReason: string | null
      ai: import('./voice-cleanup').VoiceCleanupAiResult
    }> => ({
      text: raw,
      cleaned: false,
      fallbackReason: null,
      ai: 'disabled'
    })
  )
}))
vi.mock('./voice-cleanup', () => cleanup)

const audio = vi.hoisted(() => ({
  trimSilence: (samples: Float32Array) => samples,
  isDigitalSilence: vi.fn(() => false)
}))
vi.mock('./voice-audio', () => audio)

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))
vi.mock('../services/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/logger')>()),
  createLogger: () => logger
}))

import { VoiceController } from './voice-controller'
import { DICTATION_SUMMARY_MESSAGE, type DictationSummary } from './voice-dictation-summary'

const ENABLED: VoiceSettings = {
  ...DEFAULT_VOICE_SETTINGS,
  enabled: true,
  cleanup: { ...DEFAULT_VOICE_SETTINGS.cleanup, enabled: true }
}

const AGENT_CONTEXT = {
  boardIdle: true,
  ticketOpen: false,
  sessionOpen: false,
  agentPanelOpen: false,
  agentAvailable: true
}

const TRANSCRIPT = 'create a ticket'

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
    addVoiceHistory: vi.fn((data: Record<string, unknown>) => ({
      id: 'row-1',
      text: data.text,
      raw_text: data.raw_text,
      duration_ms: data.duration_ms,
      cleaned: data.cleaned,
      speech_model: data.speech_model,
      created_at: '2026-09-09T00:00:00.000Z'
    }))
  }
}

const AUDIO = {
  samples: new Float32Array(16_000).fill(0.2),
  sampleRate: 16_000,
  durationMs: 1_000
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

function pressEscape(): void {
  const call = electron.globalShortcut.register.mock.calls.find(
    ([accelerator]) => accelerator === 'Escape'
  ) as unknown as [string, () => void] | undefined
  expect(call).toBeDefined()
  call![1]()
}

function expectNoTranscriptInLogs(): void {
  for (const method of [logger.debug, logger.info, logger.warn, logger.error]) {
    expect(JSON.stringify(method.mock.calls)).not.toContain(TRANSCRIPT)
  }
}

describe('VoiceController dictation summary log', () => {
  let controller: VoiceController

  beforeEach(() => {
    vi.clearAllMocks()
    controller = new VoiceController()
    controller.init({ db: makeDb() as never, getMainWindow: makeWindow, headless: false })
    controller.applySettings(ENABLED)
    logger.info.mockClear()
  })

  afterEach(() => {
    controller.dispose()
    audio.isDigitalSilence.mockReturnValue(false)
  })

  async function record(): Promise<void> {
    await controller.toggle()
    expect(controller.getStatus().state).toBe('recording')
    controller.onCaptureStarted()
  }

  it('logs one summary for a delivered dictation, with consistent timings and no text', async () => {
    cleanup.enhanceTranscript.mockImplementationOnce(async (raw: string) => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return { text: `${raw}.`, cleaned: true, fallbackReason: null, ai: 'cleaned' as const }
    })
    await record()
    controller.onHudStopClick()
    controller.onAudio(AUDIO)
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))

    const summary = onlySummary()
    expect(summary).toMatchObject({
      outcome: 'delivered',
      reason: null,
      speechModel: ENABLED.speechModel,
      streamed: false,
      textSource: 'whole-clip',
      target: 'paste',
      audioMs: 1_000,
      decodeMs: 3,
      aiStep: 'cleaned',
      delivery: 'pasted',
      chars: TRANSCRIPT.length + 1
    })
    expect(summary.startToCaptureMs).toEqual(expect.any(Number))
    expect(summary.stopToTranscriptMs).toEqual(expect.any(Number))
    expect(summary.aiMs!).toBeGreaterThanOrEqual(10)
    expect(summary.stopToDeliveredMs!).toBeGreaterThanOrEqual(
      summary.stopToTranscriptMs! + summary.aiMs!
    )
    expect(summary.totalMs).toBeGreaterThanOrEqual(summary.recordMs! + summary.stopToDeliveredMs!)
    for (const [key, value] of Object.entries(summary)) {
      if (key.endsWith('Ms') && value !== null) expect(Number.isInteger(value), key).toBe(true)
    }
    expectNoTranscriptInLogs()
  })

  it('marks the AI step not applicable for the agent target', async () => {
    controller.setUiContext(AGENT_CONTEXT)
    await record()
    controller.onHudStopClick()
    controller.onAudio(AUDIO)
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))

    expect(onlySummary()).toMatchObject({
      outcome: 'delivered',
      target: 'agent',
      aiStep: 'not-applicable',
      aiMs: null,
      delivery: 'agent',
      chars: TRANSCRIPT.length
    })
  })

  it('reports an AI timeout and the clipboard fallback', async () => {
    cleanup.enhanceTranscript.mockImplementationOnce(async (raw: string) => ({
      text: raw,
      cleaned: false,
      fallbackReason: 'provider error: AI cleanup did not answer within 10s',
      ai: 'timed-out' as const
    }))
    paste.deliverVoiceText.mockResolvedValueOnce('copied' as never)
    await record()
    controller.onHudStopClick()
    controller.onAudio(AUDIO)
    await vi.waitFor(() => expect(controller.getStatus().notice).toBe('Copied to clipboard'))

    expect(onlySummary()).toMatchObject({
      outcome: 'delivered',
      aiStep: 'timed-out',
      aiMs: expect.any(Number),
      delivery: 'copied'
    })
    // Dismissing the notice afterwards does not log the dictation again.
    controller.cancel('hud-click')
    expect(summaries()).toHaveLength(1)
  })

  it('logs a discarded "Nothing heard" dictation once, even when its notice is dismissed', async () => {
    audio.isDigitalSilence.mockReturnValue(true)
    await record()
    controller.onHudStopClick()
    controller.onAudio(AUDIO)
    await vi.waitFor(() => expect(controller.getStatus().notice).toBe('Nothing heard'))
    controller.cancel('hud-click')

    const summary = onlySummary()
    expect(summary).toMatchObject({
      outcome: 'discarded',
      reason: 'nothing-heard',
      audioMs: 1_000,
      textSource: null,
      stopToTranscriptMs: null,
      aiStep: 'not-applicable',
      stopToDeliveredMs: null,
      delivery: null,
      chars: null
    })
    expect(summary.recordMs).toEqual(expect.any(Number))
    expect(engine.transcribe).not.toHaveBeenCalled()
  })

  it('logs a too-short clip as discarded', async () => {
    await record()
    controller.onHudStopClick()
    controller.onAudio({ ...AUDIO, samples: new Float32Array(4_000).fill(0.2) })
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))

    expect(onlySummary()).toMatchObject({ outcome: 'discarded', reason: 'too-short', audioMs: 250 })
  })

  it('logs a dictation cancelled with Escape while recording', async () => {
    await record()
    pressEscape()

    const summary = onlySummary()
    expect(summary).toMatchObject({
      outcome: 'cancelled',
      reason: 'escape',
      target: 'paste',
      recordMs: null,
      audioMs: null,
      stopToTranscriptMs: null
    })
    expect(summary.startToCaptureMs).toEqual(expect.any(Number))
  })

  it('logs a dictation cancelled during AI cleanup once, ignoring the late result', async () => {
    let release!: () => void
    cleanup.enhanceTranscript.mockImplementationOnce(
      (raw: string) =>
        new Promise((resolve) => {
          release = () =>
            resolve({ text: raw, cleaned: true, fallbackReason: null, ai: 'cleaned' as const })
        })
    )
    await record()
    controller.onHudStopClick()
    controller.onAudio(AUDIO)
    await vi.waitFor(() => expect(cleanup.enhanceTranscript).toHaveBeenCalled())
    // Escape now skips polishing (VOICE-08); the main window's cancel still discards.
    controller.cancel('user')
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(onlySummary()).toMatchObject({
      outcome: 'cancelled',
      reason: 'user',
      textSource: 'whole-clip',
      stopToTranscriptMs: expect.any(Number),
      stopToDeliveredMs: null,
      delivery: null
    })
    expect(paste.deliverVoiceText).not.toHaveBeenCalled()
  })

  it('logs a failed transcription', async () => {
    engine.transcribe.mockRejectedValueOnce(new Error('engine crashed'))
    await record()
    controller.onHudStopClick()
    controller.onAudio(AUDIO)
    await vi.waitFor(() => expect(controller.getStatus().notice).toBe('Transcription failed'))

    expect(onlySummary()).toMatchObject({
      outcome: 'failed',
      reason: 'transcription-error',
      audioMs: 1_000,
      stopToTranscriptMs: null
    })
  })

  it('logs a failed microphone capture', async () => {
    await controller.toggle()
    controller.onCaptureError('NotAllowedError: Permission denied')

    expect(onlySummary()).toMatchObject({
      outcome: 'failed',
      reason: 'capture-error',
      startToCaptureMs: null
    })
  })

  it('logs a dictation still in flight at shutdown', async () => {
    await record()
    controller.dispose()
    controller.dispose()

    expect(onlySummary()).toMatchObject({ outcome: 'cancelled', reason: 'shutdown' })
  })
})
