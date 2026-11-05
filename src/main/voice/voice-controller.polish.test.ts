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
  transcribe: vi.fn(async () => ({ text: 'create a tedo ticket', decodeMs: 3 })),
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
      _settings: import('@shared/types/voice').VoiceSettings,
      _deps?: { signal?: AbortSignal }
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
  // The offline (whole-clip) flow; the streaming default is covered in voice-controller.stream.test.ts.
  speechModel: 'parakeet-tdt-0.6b-v2',
  cleanup: { ...DEFAULT_VOICE_SETTINGS.cleanup, enabled: true },
  dictionary: [{ word: 'Tedooo', soundsLike: ['tedo'], caseSensitive: false }]
}

const AGENT_CONTEXT = {
  boardIdle: true,
  ticketOpen: false,
  sessionOpen: false,
  agentPanelOpen: false,
  agentAvailable: true
}

/** What the engine heard, and what the pill shows once the dictionary has run. */
const TRANSCRIPT = 'create a tedo ticket'
const SHOWN = 'create a Tedooo ticket'
const POLISHED = 'Create a Tedooo ticket.'

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
  const calls = electron.globalShortcut.register.mock.calls as unknown as Array<
    [string, () => void]
  >
  const call = calls.findLast(([accelerator]) => accelerator === 'Escape')
  expect(call).toBeDefined()
  call![1]()
}

type CleanupOutcome = Awaited<ReturnType<typeof cleanup.enhanceTranscript>>

/** An AI step that runs until the test answers it, like a slow model call. */
function pendingCleanup(): {
  signal: () => AbortSignal | undefined
  answer: (outcome: CleanupOutcome) => void
} {
  let signal: AbortSignal | undefined
  let answer!: (outcome: CleanupOutcome) => void
  cleanup.enhanceTranscript.mockImplementationOnce((_raw, _settings, deps) => {
    signal = deps?.signal
    return new Promise<CleanupOutcome>((resolve) => {
      answer = resolve
    })
  })
  return { signal: () => signal, answer: (outcome) => answer(outcome) }
}

const CLEANED: CleanupOutcome = {
  text: POLISHED,
  cleaned: true,
  fallbackReason: null,
  ai: 'cleaned'
}

function hudPhases(): string[] {
  return hud.setState.mock.calls.map(([state]) => (state as { phase: { kind: string } }).phase.kind)
}

function lastHudState(): { phase: { kind: string }; transcript?: string } {
  return hud.setState.mock.calls.at(-1)![0] as { phase: { kind: string }; transcript?: string }
}

function pasted(): string[] {
  return paste.deliverVoiceText.mock.calls.map((call) => (call as unknown[])[1] as string)
}

function results(window: import('electron').BrowserWindow): unknown[] {
  return vi
    .mocked(window.webContents.send)
    .mock.calls.filter(([channel]) => channel === 'voice:result')
    .map(([, result]) => result)
}

describe('VoiceController skippable AI polishing (VOICE-08)', () => {
  let controller: VoiceController
  let db: ReturnType<typeof makeDb>
  let window: import('electron').BrowserWindow
  let now = 9_000_000

  beforeEach(() => {
    vi.clearAllMocks()
    now += 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    db = makeDb()
    window = makeWindow()
    controller = new VoiceController()
    controller.init({ db: db as never, getMainWindow: () => window, headless: false })
    controller.applySettings(ENABLED)
    logger.info.mockClear()
  })

  afterEach(() => {
    controller.dispose()
    vi.restoreAllMocks()
  })

  async function record(): Promise<void> {
    now += 1_000
    await controller.toggle()
    expect(controller.getStatus().state).toBe('recording')
    controller.onCaptureStarted()
  }

  /** Record, stop, and wait until the pill shows "Polishing…" with the final text. */
  async function untilPolishing(): Promise<void> {
    await record()
    controller.onHudStopClick()
    controller.onAudio(AUDIO)
    await vi.waitFor(() => expect(lastHudState().phase.kind).toBe('enhancing'))
    expect(lastHudState().transcript).toBe(SHOWN)
  }

  async function untilIdle(): Promise<void> {
    await vi.waitFor(() => expect(controller.getStatus().state).toBe('idle'))
  }

  const SKIPS: Array<[string, (c: VoiceController) => void]> = [
    ['clicking Skip', (c) => c.skipPolishing('click')],
    ['pressing Escape', () => pressEscape()],
    [
      'pressing the dictation hotkey again',
      (c) => {
        now += 1_000
        void c.toggle()
      }
    ]
  ]

  describe.each(SKIPS)('skip by %s', (_name, skip) => {
    it('pastes exactly the shown text at once, once, and stops the AI request', async () => {
      let releasePaste!: () => void
      paste.deliverVoiceText.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releasePaste = () => resolve('pasted')
          })
      )
      const ai = pendingCleanup()
      await untilPolishing()
      expect(ai.signal()?.aborted).toBe(false)

      skip(controller)
      // The AI request is stopped by the skip itself, not later when the dictation ends.
      expect(ai.signal()?.aborted).toBe(true)
      await vi.waitFor(() => expect(paste.deliverVoiceText).toHaveBeenCalled())
      releasePaste()
      await untilIdle()

      expect(pasted()).toEqual([SHOWN])
      // The AI answering late changes nothing.
      ai.answer(CLEANED)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(pasted()).toEqual([SHOWN])
      expect(hudPhases().at(-1)).toBe('hidden')
    })
  })

  it('logs the skip with its input and timings, distinct from a timeout or failure', async () => {
    pendingCleanup()
    await untilPolishing()
    now += 1_000
    void controller.toggle()
    await untilIdle()

    const summary = onlySummary()
    expect(summary).toMatchObject({
      outcome: 'delivered',
      reason: null,
      aiStep: 'skipped',
      skipInput: 'hotkey',
      delivery: 'pasted',
      chars: SHOWN.length
    })
    expect(summary.aiMs).toEqual(expect.any(Number))
    expect(summary.skipToDeliveredMs).toEqual(expect.any(Number))
    expect(summary.stopToDeliveredMs!).toBeGreaterThanOrEqual(summary.skipToDeliveredMs!)
    expect(logger.info).toHaveBeenCalledWith('AI polishing skipped', { input: 'hotkey' })
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('records a skip in history as not cleaned, with the raw text, and never as a failure', async () => {
    pendingCleanup()
    await untilPolishing()
    controller.skipPolishing('click')
    await untilIdle()

    expect(db.addVoiceHistory).toHaveBeenCalledTimes(1)
    expect(db.addVoiceHistory).toHaveBeenCalledWith(
      expect.objectContaining({ text: SHOWN, raw_text: TRANSCRIPT, cleaned: false })
    )
    expect(results(window)).toEqual([
      expect.objectContaining({
        delivery: 'pasted',
        cleanupFallbackReason: null,
        cleanup: 'skipped'
      })
    ])
    // No notice on the pill and no error anywhere.
    expect(hudPhases()).not.toContain('notice')
    expect(controller.getStatus()).toMatchObject({ lastError: null, notice: null })
  })

  it('without a skip, pastes the polished text and logs "cleaned" with its duration', async () => {
    const ai = pendingCleanup()
    await untilPolishing()
    now += 1_000
    ai.answer(CLEANED)
    await untilIdle()

    expect(pasted()).toEqual([POLISHED])
    expect(results(window)).toEqual([
      expect.objectContaining({ cleanupFallbackReason: null, cleanup: 'cleaned' })
    ])
    expect(onlySummary()).toMatchObject({
      aiStep: 'cleaned',
      aiMs: expect.any(Number),
      skipInput: null,
      skipToDeliveredMs: null
    })
  })

  describe('the race between a skip and the AI answering', () => {
    it('AI first: the polished text lands once and a late skip or Escape changes nothing', async () => {
      let releasePaste!: () => void
      paste.deliverVoiceText.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releasePaste = () => resolve('pasted')
          })
      )
      const ai = pendingCleanup()
      await untilPolishing()
      ai.answer(CLEANED)
      await vi.waitFor(() => expect(paste.deliverVoiceText).toHaveBeenCalled())

      // The text is landing: these presses must neither re-paste nor discard it.
      expect(controller.skipPolishing('click')).toBe(true)
      pressEscape()
      releasePaste()
      await untilIdle()

      expect(pasted()).toEqual([POLISHED])
      expect(onlySummary()).toMatchObject({ outcome: 'delivered', aiStep: 'cleaned' })
      expect(ai.signal()?.aborted).toBe(true) // cleared with the finished dictation; nothing left to stop
    })

    it('skip first, AI answering in the same tick: the shown text lands once', async () => {
      const ai = pendingCleanup()
      await untilPolishing()
      controller.skipPolishing('escape')
      ai.answer(CLEANED)
      controller.skipPolishing('click')
      await untilIdle()
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(pasted()).toEqual([SHOWN])
      expect(onlySummary()).toMatchObject({ aiStep: 'skipped', skipInput: 'escape' })
    })
  })

  it('a timeout still pastes the raw text and reports it, unlike a skip', async () => {
    cleanup.enhanceTranscript.mockImplementationOnce(async (raw: string) => ({
      text: raw,
      cleaned: false,
      fallbackReason: 'provider error: AI cleanup did not answer within 10s',
      ai: 'timed-out' as const
    }))
    await record()
    controller.onHudStopClick()
    controller.onAudio(AUDIO)
    await untilIdle()

    expect(pasted()).toEqual([TRANSCRIPT])
    expect(results(window)).toEqual([
      expect.objectContaining({
        cleanupFallbackReason: 'provider error: AI cleanup did not answer within 10s',
        cleanup: 'timed-out'
      })
    ])
    expect(onlySummary()).toMatchObject({
      aiStep: 'timed-out',
      aiMs: expect.any(Number),
      skipInput: null,
      skipToDeliveredMs: null
    })
  })

  describe('Escape outside polishing still discards', () => {
    it('while recording', async () => {
      await record()
      pressEscape()

      expect(controller.getStatus().state).toBe('idle')
      expect(onlySummary()).toMatchObject({ outcome: 'cancelled', reason: 'escape' })
      expect(paste.deliverVoiceText).not.toHaveBeenCalled()
    })

    it('while transcribing, before the AI step starts', async () => {
      let finishTranscribing!: () => void
      engine.transcribe.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishTranscribing = () => resolve({ text: TRANSCRIPT, decodeMs: 3 })
          })
      )
      await record()
      controller.onHudStopClick()
      controller.onAudio(AUDIO)
      await vi.waitFor(() => expect(engine.transcribe).toHaveBeenCalled())
      expect(controller.skipPolishing('click')).toBe(false)
      pressEscape()
      finishTranscribing()
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(onlySummary()).toMatchObject({ outcome: 'cancelled', reason: 'escape' })
      expect(cleanup.enhanceTranscript).not.toHaveBeenCalled()
      expect(paste.deliverVoiceText).not.toHaveBeenCalled()
    })
  })

  it('other ways of ending the dictation mid-polish discard it and stop the AI request', async () => {
    const ai = pendingCleanup()
    await untilPolishing()
    controller.applySettings({ ...ENABLED, enabled: false })
    ai.answer(CLEANED)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(ai.signal()?.aborted).toBe(true)
    expect(paste.deliverVoiceText).not.toHaveBeenCalled()
    expect(onlySummary()).toMatchObject({ outcome: 'cancelled', reason: 'voice-disabled' })
  })

  describe('no polishing phase', () => {
    it('with AI cleanup off: nothing to skip, and the hotkey is ignored while processing', async () => {
      controller.applySettings({ ...ENABLED, cleanup: { ...ENABLED.cleanup, enabled: false } })
      await record()
      controller.onHudStopClick()
      controller.onAudio(AUDIO)
      expect(controller.skipPolishing('click')).toBe(false)
      await untilIdle()

      expect(hudPhases()).not.toContain('enhancing')
      expect(pasted()).toHaveLength(1)
      expect(cleanup.enhanceTranscript).toHaveBeenCalledWith(
        TRANSCRIPT,
        expect.objectContaining({ cleanup: expect.objectContaining({ enabled: false }) }),
        { db }
      )
      expect(onlySummary()).toMatchObject({ aiStep: 'disabled', skipInput: null })
      expect(results(window)).toEqual([expect.objectContaining({ cleanup: 'disabled' })])
    })

    it('for the agent target: no polishing phase, no AI request, delivered at once', async () => {
      controller.setUiContext(AGENT_CONTEXT)
      await record()
      controller.onHudStopClick()
      controller.onAudio(AUDIO)
      await untilIdle()

      expect(hudPhases()).not.toContain('enhancing')
      expect(cleanup.enhanceTranscript).toHaveBeenCalledWith(
        TRANSCRIPT,
        expect.objectContaining({ cleanup: expect.objectContaining({ enabled: false }) }),
        { db }
      )
      expect(controller.skipPolishing('click')).toBe(false)
      expect(onlySummary()).toMatchObject({ target: 'agent', aiStep: 'not-applicable' })
    })
  })
})
