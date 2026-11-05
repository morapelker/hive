import { app, globalShortcut, shell, systemPreferences, type BrowserWindow } from 'electron'
import {
  findVoiceSpeechModel,
  type VoiceAudioChunk,
  type VoiceCleanupResult,
  type VoiceDictationResult,
  type VoiceDictationState,
  type VoiceHistoryEntry,
  type VoiceHudPhase,
  type VoiceMicPermission,
  type VoiceSettings,
  type VoiceSkipInput,
  type VoiceSpeechModelId,
  type VoiceStatus
} from '@shared/types/voice'
import { DictionaryReplacer } from '@shared/voice/dictionary-replacer'
import { parseHotkey, type HotkeySpec } from '@shared/voice/hotkey-spec'
import type { DatabaseService } from '../db/database'
import type { VoiceHistoryRow } from '../db/types'
import { createLogger } from '../services/logger'
import { isDigitalSilence, trimSilence } from './voice-audio'
import { enhanceTranscript, type VoiceCleanupOutcome } from './voice-cleanup'
import {
  DICTATION_SUMMARY_MESSAGE,
  DictationTrace,
  type DictationDelivery,
  type DictationFallbackReason,
  type DictationOutcome,
  type DictationTextSource
} from './voice-dictation-summary'
import {
  DictationAudioStream,
  isDictationStreamBroken,
  type DictationStreamResult
} from './voice-dictation-stream'
import {
  isVoiceEngineExited,
  isVoiceStreamCancelled,
  voiceEngine,
  type VoiceEngineModel
} from './voice-engine'
import { voiceHud } from './voice-hud-window'
import { voiceMedia } from './voice-media'
import { voiceModelStore } from './voice-model-store'
import { deliverVoiceText } from './voice-paste'
import { PreviewThrottle } from './voice-preview-throttle'
import { readVoiceSettings } from './voice-settings'
import type { VoiceSoundName } from './voice-sounds'
import { voiceTestClips } from './voice-test-clips'

const log = createLogger({ component: 'VoiceDictation' })

/** The engine loads a model as offline or streaming from the catalog; it needs the id and folder. */
function engineModel(id: VoiceSpeechModelId): VoiceEngineModel {
  return { id, dir: voiceModelStore.getModelDir(id) }
}

/** Clips at or below this length are accidental double-taps (Wispelker: 8 000 samples at 16 kHz). */
const MIN_CLIP_SECONDS = 0.5
/** A hotkey press this soon after the previous one is a bounce, not an intent. */
const TOGGLE_DEBOUNCE_MS = 250
/** A forgotten recording stops itself and is processed. */
const MAX_RECORDING_SECONDS = 600
const NOTICE_SECONDS = 2.5
const SHORT_NOTICE_SECONDS = 1.2
const HUD_READY_TIMEOUT_MS = 4_000
const AUDIO_TIMEOUT_MS = 8_000
/** The HUD records at 16 kHz; a streaming session takes its chunks at that rate. */
const STREAM_SAMPLE_RATE = 16_000
/**
 * Live transcript updates reach the HUD at most this often. The engine sends
 * about two a second while the user speaks, but bursts while a backlog drains.
 */
const PREVIEW_INTERVAL_MS = 150
/**
 * A streamed transcript is only used if its session got the whole clip, give
 * or take this much audio (the clip is the source of truth; VOICE-05 tops the
 * session up from it at stop).
 */
const STREAM_AUDIO_TOLERANCE_MS = 250
/** At app start the streaming model loads this long after voice is set up, clear of startup work. */
const APP_START_WARM_UP_DELAY_MS = 2_000
const MAC_MIC_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

export interface VoiceAudioPayload {
  readonly samples: Float32Array
  readonly sampleRate: number
  readonly durationMs: number
}

/** A dictation's transcript and the path that produced it. */
interface DictationTranscript {
  readonly text: string
  readonly decodeMs: number | null
  readonly source: DictationTextSource
  readonly fallbackReason: DictationFallbackReason | null
}

/**
 * The AI polishing step of one dictation (VOICE-08). It can be skipped until it
 * settles; whichever comes first, the AI's result or the skip, is the one the
 * dictation delivers.
 */
interface PolishingStep {
  readonly generation: number
  /** Stops the AI request itself (and its CLI process), not just its result. */
  readonly abort: AbortController
  /** Settle with the shown transcript now; a no-op once settled. */
  readonly skip: (input: VoiceSkipInput) => void
}

/** Why a streaming session's result could not be used, from how its finish failed. */
function fallbackReasonFor(error: unknown): DictationFallbackReason {
  if (isDictationStreamBroken(error)) return 'stream-broken'
  if (isVoiceEngineExited(error)) return 'engine-exited'
  if (isVoiceStreamCancelled(error)) return 'stream-cancelled'
  return 'session-error'
}

export function toVoiceHistoryEntry(row: VoiceHistoryRow): VoiceHistoryEntry {
  return {
    id: row.id,
    text: row.text,
    rawText: row.raw_text,
    createdAt: row.created_at,
    durationMs: row.duration_ms,
    cleaned: row.cleaned,
    speechModel: row.speech_model
  }
}

/**
 * The dictation state machine, ported from Wispelker's DictationController:
 *
 *   unavailable ⇄ idle → recording → processing → idle
 *
 * `unavailable` covers "voice is off" and "speech model not ready". Every
 * asynchronous step is guarded by a generation counter so a cancel or a
 * newer recording silently drops an in-flight result.
 */
export class VoiceController {
  private settings: VoiceSettings
  private state: VoiceDictationState = 'unavailable'
  private generation = 0
  private db: DatabaseService | null = null
  private getMainWindow: () => BrowserWindow | null = () => null
  private headless = false

  private hotkeySpec: HotkeySpec | null = null
  private hotkeyProblem: string | null = null
  private registeredAccelerator: string | null = null
  private escapeRegistered = false

  private lastError: string | null = null
  private notice: string | null = null
  private noticeTimer: NodeJS.Timeout | null = null
  private noticeSerial = 0
  private lastToggleAt = 0
  private maxRecordingTimer: NodeJS.Timeout | null = null

  private recordingStartedAt = 0
  /** Timings of the dictation in flight; logged once as a summary line when it ends. */
  private dictation: DictationTrace | null = null
  /**
   * Streaming speech models only: carries the recording's audio into an engine
   * session while the user speaks. Open from capture start until the clip
   * arrives at stop (or the dictation ends first).
   */
  private stream: DictationAudioStream | null = null
  /**
   * The transcript the HUD shows above the pill, dictionary applied: the text
   * so far while a streamed recording runs, then the final transcript. Sent
   * with every HUD state; cleared when the pill hides or shows a notice.
   */
  private hudTranscript = ''
  /** The pill's current phase, re-sent with each live transcript update. */
  private hudPhase: VoiceHudPhase = { kind: 'hidden' }
  /** Caps the live transcript updates of the streamed recording in progress. */
  private preview: PreviewThrottle | null = null
  /** The AI polishing step in flight, from its start until the dictation ends. */
  private polishing: PolishingStep | null = null
  /** Pending app-start load of the streaming model. */
  private warmUpTimer: NodeJS.Timeout | null = null
  /** The selected speech model was on disk at the last check (to load it once it arrives). */
  private speechModelReady = false
  private audioWaiter: {
    resolve: (payload: VoiceAudioPayload) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  } | null = null
  private unsubscribe: Array<() => void> = []

  constructor() {
    this.settings = readVoiceSettings(null)
  }

  init(options: {
    db: DatabaseService
    getMainWindow: () => BrowserWindow | null
    headless?: boolean
  }): void {
    this.db = options.db
    this.getMainWindow = options.getMainWindow
    this.headless = options.headless ?? false
    voiceHud.configure({ getMainWindow: options.getMainWindow })

    this.unsubscribe.push(
      voiceModelStore.onChange((modelId) => {
        if (modelId !== this.settings.speechModel) return
        this.recomputeState()
        this.broadcast()
        const ready = this.modelReady()
        const arrived = ready && !this.speechModelReady
        this.speechModelReady = ready
        if (arrived) this.warmUpStreamingModel('model downloaded')
      }),
      voiceEngine.onLoadedChange(() => this.broadcast())
    )

    const onFocus = (): void => this.registerHotkey()
    const onBlur = (): void => this.unregisterHotkey()
    app.on('browser-window-focus', onFocus)
    app.on('browser-window-blur', onBlur)
    this.unsubscribe.push(() => {
      app.off('browser-window-focus', onFocus)
      app.off('browser-window-blur', onBlur)
    })

    this.applySettings(readVoiceSettings(options.db), { initial: true })
  }

  dispose(): void {
    this.endDictation('cancelled', 'shutdown')
    this.generation++
    this.unregisterHotkey()
    this.unregisterEscape()
    for (const off of this.unsubscribe.splice(0)) off()
    this.clearNoticeTimer()
    this.clearWarmUpTimer()
    this.rejectAudioWaiter(new Error('shutting down'))
    this.closeStream()
    this.clearPreview()
    this.abortPolishing()
    voiceEngine.dispose()
    voiceHud.destroy()
  }

  getSettings(): VoiceSettings {
    return this.settings
  }

  // ---- settings ---------------------------------------------------------------------------

  applySettings(next: VoiceSettings, options: { initial?: boolean } = {}): void {
    const previous = this.settings
    this.settings = next

    voiceEngine.setIdleUnloadMinutes(next.unloadModelAfterMinutes)
    const modelChanged = previous.speechModel !== next.speechModel
    // Also while the old model is still loading (a warm-up), so it never lands
    // in memory after the switch. A no-op when the engine is not running.
    if (modelChanged) voiceEngine.unload('speech model changed')

    this.parseHotkeySetting()

    if (next.enabled && !this.headless) {
      // Pre-create the pill window so the first hotkey press shows it instantly,
      // warm up the media adapter, and fetch the model the first time voice is on.
      voiceHud.ensureCreated()
      void voiceMedia.prepare()
      if (!voiceModelStore.isReady(next.speechModel)) {
        const state = voiceModelStore.getState(next.speechModel)
        if (state.status === 'not-downloaded' || (!options.initial && state.status === 'failed')) {
          this.downloadModel(next.speechModel)
        }
      }
      if (this.isAnyWindowFocused()) this.registerHotkey()
      // Keep a streaming model warm so the first dictation previews from its
      // first words: at app start (a moment later, clear of startup work),
      // when voice is turned on, and when the user switches models.
      if (options.initial) {
        this.scheduleWarmUp(APP_START_WARM_UP_DELAY_MS)
      } else if (!previous.enabled || modelChanged) {
        this.warmUpStreamingModel(previous.enabled ? 'speech model changed' : 'voice enabled')
      }
    } else {
      this.unregisterHotkey()
      this.clearWarmUpTimer()
      if (this.state === 'recording' || this.state === 'processing') {
        this.cancel('voice-disabled')
      }
      voiceHud.hide()
      // Also stops a warm-up still loading. A no-op when the engine is not running.
      voiceEngine.unload('voice disabled')
    }

    this.speechModelReady = this.modelReady()
    this.recomputeState()
    this.broadcast()
  }

  /**
   * Load the selected streaming model ahead of the first press, so a dictation
   * previews from its first words instead of after a cold load. Offline models
   * still load at the press, as before. The idle-unload setting still applies:
   * after an idle unload the model loads again at the next press.
   */
  private warmUpStreamingModel(reason: string): void {
    this.clearWarmUpTimer()
    if (!this.settings.enabled || this.headless) return
    const modelId = this.settings.speechModel
    if (!findVoiceSpeechModel(modelId).streaming || !voiceModelStore.isReady(modelId)) return
    const model = engineModel(modelId)
    if (voiceEngine.loadedModel === model.dir) return
    log.info('Loading the streaming speech model ahead of dictation', { reason })
    void voiceEngine.ensureLoaded(model).catch((error: unknown) => {
      log.warn('streaming model warm-up failed', { reason, error: String(error) })
    })
  }

  private scheduleWarmUp(delayMs: number): void {
    this.clearWarmUpTimer()
    this.warmUpTimer = setTimeout(() => {
      this.warmUpTimer = null
      this.warmUpStreamingModel('app start')
    }, delayMs)
  }

  private clearWarmUpTimer(): void {
    if (this.warmUpTimer) {
      clearTimeout(this.warmUpTimer)
      this.warmUpTimer = null
    }
  }

  private parseHotkeySetting(): void {
    try {
      const spec = parseHotkey(this.settings.hotkey, { platform: process.platform })
      const changed = spec.accelerator !== this.hotkeySpec?.accelerator
      this.hotkeySpec = spec
      this.hotkeyProblem = null
      if (changed && this.registeredAccelerator) {
        this.unregisterHotkey()
        this.registerHotkey()
      }
    } catch (error) {
      this.hotkeySpec = null
      this.hotkeyProblem = `Invalid hotkey: ${error instanceof Error ? error.message : String(error)}`
      this.unregisterHotkey()
    }
  }

  // ---- hotkeys ----------------------------------------------------------------------------

  private isAnyWindowFocused(): boolean {
    const main = this.getMainWindow()
    return !!main && !main.isDestroyed() && main.isFocused()
  }

  /**
   * Registered only while one of our windows is focused so the combo is not
   * stolen from other dictation apps when the user is elsewhere. A Carbon hot
   * key still fires while the native Ghostty terminal has keyboard focus.
   */
  private registerHotkey(): void {
    if (!this.settings.enabled || !this.hotkeySpec || this.headless) return
    const accelerator = this.hotkeySpec.accelerator
    if (this.registeredAccelerator === accelerator) return
    this.unregisterHotkey()
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, () => {
        void this.toggle()
      })
    } catch (error) {
      log.warn('hotkey registration threw', { accelerator, error: String(error) })
    }
    if (ok) {
      this.registeredAccelerator = accelerator
      if (this.hotkeyProblem?.startsWith('Could not register')) {
        this.hotkeyProblem = null
        this.broadcast()
      }
    } else {
      this.hotkeyProblem = `Could not register ${this.hotkeySpec.display} (in use?)`
      log.warn('hotkey registration failed', { accelerator })
      this.broadcast()
    }
  }

  private unregisterHotkey(): void {
    if (!this.registeredAccelerator) return
    try {
      globalShortcut.unregister(this.registeredAccelerator)
    } catch {
      // ignore
    }
    this.registeredAccelerator = null
  }

  /**
   * Escape — registered only while a dictation is in flight (Wispelker
   * semantics). It discards the dictation, except during AI polishing, where it
   * skips the AI and pastes the shown transcript.
   */
  private registerEscape(): void {
    if (this.escapeRegistered) return
    try {
      this.escapeRegistered = globalShortcut.register('Escape', () => this.onEscape())
    } catch {
      this.escapeRegistered = false
    }
  }

  private unregisterEscape(): void {
    if (!this.escapeRegistered) return
    try {
      globalShortcut.unregister('Escape')
    } catch {
      // ignore
    }
    this.escapeRegistered = false
  }

  private onEscape(): void {
    if (this.skipPolishing('escape')) return
    this.cancel('escape')
  }

  // ---- state ------------------------------------------------------------------------------

  private modelReady(): boolean {
    return voiceModelStore.isReady(this.settings.speechModel)
  }

  private recomputeState(): void {
    if (this.state === 'recording' || this.state === 'processing') return
    this.state =
      this.settings.enabled && this.modelReady() && !this.headless ? 'idle' : 'unavailable'
  }

  getStatus(): VoiceStatus {
    const cleanupModel = this.settings.cleanup.model
    return {
      enabled: this.settings.enabled,
      state: this.state,
      model: voiceModelStore.getState(this.settings.speechModel),
      speechModel: this.settings.speechModel,
      engineLoaded: voiceEngine.isLoaded,
      hotkeyDisplay: this.hotkeySpec?.display ?? null,
      hotkeyProblem: this.hotkeyProblem,
      cleanupLabel: !this.settings.cleanup.enabled
        ? 'off'
        : cleanupModel
          ? cleanupModel.modelID
          : 'default provider',
      micPermission: this.getMicPermission(),
      lastError: this.lastError,
      notice: this.notice
    }
  }

  private broadcast(): void {
    const main = this.getMainWindow()
    if (!main || main.isDestroyed()) return
    try {
      main.webContents.send('voice:status', this.getStatus())
    } catch (error) {
      log.warn('status broadcast failed', { error: String(error) })
    }
  }

  private broadcastResult(result: VoiceDictationResult): void {
    const main = this.getMainWindow()
    if (!main || main.isDestroyed()) return
    try {
      main.webContents.send('voice:result', result)
    } catch (error) {
      log.warn('result broadcast failed', { error: String(error) })
    }
  }

  // ---- model ------------------------------------------------------------------------------

  downloadModel(modelId: VoiceSpeechModelId = this.settings.speechModel): void {
    voiceModelStore.download(modelId).catch((error: unknown) => {
      log.warn('model download failed', { modelId, error: String(error) })
    })
    this.broadcast()
  }

  cancelDownload(modelId: VoiceSpeechModelId): void {
    voiceModelStore.cancel(modelId)
  }

  async deleteModel(modelId: VoiceSpeechModelId): Promise<void> {
    // The selected model may still be loading (a warm-up), with nothing loaded
    // yet: stop that too, so a deleted model never lands in memory.
    if (
      modelId === this.settings.speechModel ||
      voiceEngine.loadedModel === voiceModelStore.getModelDir(modelId)
    ) {
      this.clearWarmUpTimer()
      voiceEngine.unload('model deleted')
    }
    await voiceModelStore.delete(modelId)
    this.recomputeState()
    this.broadcast()
  }

  // ---- microphone -------------------------------------------------------------------------

  getMicPermission(): VoiceMicPermission {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted'
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      return status === 'granted' ||
        status === 'denied' ||
        status === 'restricted' ||
        status === 'not-determined'
        ? status
        : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async requestMicrophoneAccess(): Promise<VoiceMicPermission> {
    if (process.platform === 'darwin') {
      const status = this.getMicPermission()
      if (status === 'not-determined') {
        try {
          await systemPreferences.askForMediaAccess('microphone')
        } catch (error) {
          log.warn('askForMediaAccess failed', { error: String(error) })
        }
      }
    }
    const result = this.getMicPermission()
    this.broadcast()
    return result
  }

  openMicrophoneSettings(): void {
    if (process.platform === 'darwin') {
      void shell.openExternal(MAC_MIC_SETTINGS_URL)
    } else if (process.platform === 'win32') {
      void shell.openExternal('ms-settings:privacy-microphone')
    }
  }

  // ---- dictation --------------------------------------------------------------------------

  async toggle(): Promise<void> {
    const now = Date.now()
    if (now - this.lastToggleAt < TOGGLE_DEBOUNCE_MS) return
    this.lastToggleAt = now
    switch (this.state) {
      case 'idle':
        await this.startRecording()
        return
      case 'recording':
        void this.stopAndProcess()
        return
      case 'processing':
        // During AI polishing the hotkey skips it; otherwise let it finish (Escape cancels).
        this.skipPolishing('hotkey')
        return
      case 'unavailable': {
        if (!this.settings.enabled) return
        const model = voiceModelStore.getState(this.settings.speechModel)
        if (model.status === 'failed' || model.status === 'not-downloaded') {
          this.downloadModel()
          this.showTransientNotice(
            model.status === 'failed'
              ? 'Retrying speech model download…'
              : 'Downloading speech model…'
          )
        } else if (model.status === 'downloading') {
          this.showTransientNotice('Downloading speech model…')
        } else {
          this.showTransientNotice('Speech model not ready yet')
        }
      }
    }
  }

  private async startRecording(): Promise<void> {
    if (this.state !== 'idle') return
    // A second press while the permission dialog was open: the first never recorded.
    this.endDictation('cancelled', 'superseded')
    this.closeStream()
    // The start press: every timing in the summary line is measured from here.
    this.dictation = new DictationTrace(this.settings.speechModel)

    // With Chromium's fake capture device or test clips (automated runs) no real
    // microphone is opened, so the OS permission pre-flight would only block on a dialog.
    const fakeDevice =
      app.commandLine.hasSwitch('use-fake-device-for-media-stream') || voiceTestClips.enabled
    if (process.platform === 'darwin' && !fakeDevice) {
      const status = this.getMicPermission()
      if (status === 'not-determined') {
        const granted = await this.requestMicrophoneAccess()
        if (granted !== 'granted') {
          this.endDictation('failed', 'mic-permission')
          this.showTransientNotice('Microphone access denied')
          return
        }
      } else if (status === 'denied' || status === 'restricted') {
        this.endDictation('failed', 'mic-permission')
        this.showTransientNotice('Grant microphone access in System Settings')
        this.openMicrophoneSettings()
        return
      }
    }

    const generation = ++this.generation
    this.clearNoticeTimer()
    this.notice = null
    this.lastError = null
    this.state = 'recording'
    this.recordingStartedAt = Date.now()
    this.broadcast()

    const ready = await voiceHud.waitUntilReady(HUD_READY_TIMEOUT_MS)
    if (generation !== this.generation) return
    if (!ready) {
      log.warn('HUD window did not become ready')
      this.endDictation('failed', 'hud-not-ready')
      this.lastError = 'Could not start recording'
      this.showTransientNotice('Could not start recording')
      return
    }

    this.clearPreview()
    this.setHudPhase({ kind: 'recording' })
    voiceHud.show()
    // Opened before capture starts so no chunk arrives without a session to take
    // it; on a cold start the session holds the audio until the model is loaded.
    this.stream = this.openStream(generation)
    voiceHud.startCapture(this.stream ? { streamId: this.stream.id } : {})
    this.registerEscape()
    this.clearMaxRecordingTimer()
    this.maxRecordingTimer = setTimeout(() => {
      this.maxRecordingTimer = null
      if (this.state === 'recording' && generation === this.generation) {
        log.info('Recording reached the maximum length; stopping')
        void this.stopAndProcess()
      }
    }, MAX_RECORDING_SECONDS * 1000)

    // Warm the recogniser while the user speaks so the stop feels instant.
    void voiceEngine
      .ensureLoaded(engineModel(this.settings.speechModel))
      .catch((error: unknown) => {
        log.warn('speech model warm-up failed', { error: String(error) })
      })

    if (this.settings.pauseMediaWhileRecording) {
      void voiceMedia.recordingWillStart()
    }
  }

  /** The HUD renderer has the microphone open. */
  onCaptureStarted(): void {
    if (this.state !== 'recording') return
    this.dictation?.markCaptureStarted()
    this.playSound('start')
  }

  /** The HUD renderer could not open the microphone. */
  onCaptureError(message: string): void {
    if (this.state !== 'recording') return
    log.warn('capture failed', { message })
    this.endDictation('failed', 'capture-error')
    this.generation++
    this.rejectAudioWaiter(new Error(message))
    this.closeStream()
    void voiceMedia.recordingDidStop()
    this.lastError = message
    const denied = /permission|denied|notallowed/i.test(message)
    this.showTransientNotice(denied ? 'Microphone access denied' : 'Could not start recording')
  }

  isRecording(): boolean {
    return this.state === 'recording'
  }

  /** Click on the pill while recording. */
  onHudStopClick(): void {
    if (this.state === 'recording') void this.stopAndProcess()
  }

  private async stopAndProcess(): Promise<void> {
    if (this.state !== 'recording') return
    this.dictation?.markStop()
    const generation = ++this.generation
    const durationMs = Date.now() - this.recordingStartedAt
    this.clearMaxRecordingTimer()

    const audioPromise = this.waitForAudio()
    voiceHud.stopCapture()
    this.playSound('stop')
    void voiceMedia.recordingDidStop()

    this.state = 'processing'
    // The live text so far stays on the pill until the final transcript is in;
    // no update goes out after the stop press.
    this.preview?.cancel()
    this.preview = null
    this.setHudPhase({ kind: 'transcribing', progress: null, showsProgress: false })
    this.broadcast()

    try {
      const audio = await audioPromise
      if (generation !== this.generation) return
      // Every streamed chunk arrived before the clip (same IPC pipe); from here
      // the stream belongs to this stop, not to the controller.
      const stream = this.stream
      this.stream = null

      const seconds = audio.samples.length / Math.max(1, audio.sampleRate)
      this.dictation?.setAudio(audio.samples.length, audio.sampleRate)
      if (seconds <= MIN_CLIP_SECONDS) {
        log.info('Discarding clip: too short', { seconds })
        stream?.cancel()
        this.endDictation('discarded', 'too-short')
        this.finish()
        return
      }
      const samples = trimSilence(audio.samples, audio.sampleRate)
      if (samples.length / audio.sampleRate <= MIN_CLIP_SECONDS || isDigitalSilence(samples)) {
        log.info('Discarding clip: nothing heard', { seconds })
        stream?.cancel()
        this.endDictation('discarded', 'nothing-heard')
        this.showTransientNotice('Nothing heard', SHORT_NOTICE_SECONDS)
        return
      }
      // A streaming model's session has heard everything already: finishing it
      // gives the final text at once, whatever the length. The whole clip is
      // only transcribed when the session can't be used.
      const transcript = stream
        ? await this.transcribeStreamed(stream, audio, samples, generation)
        : await this.transcribeWholeClip(samples, audio.sampleRate, generation, 'whole-clip', null)
      if (!transcript) return
      const raw = transcript.text
      this.dictation?.markTranscript(
        transcript.source,
        transcript.decodeMs,
        transcript.fallbackReason
      )
      log.info('Transcribed', {
        seconds: Math.round(seconds * 10) / 10,
        source: transcript.source,
        decodeMs: transcript.decodeMs,
        chars: raw.length
      })
      if (!raw) {
        this.endDictation('discarded', 'nothing-heard')
        this.showTransientNotice('Nothing heard', SHORT_NOTICE_SECONDS)
        return
      }

      // From here the pill shows the final transcript: exactly what
      // enhanceTranscript pastes when the AI step is off or falls back.
      this.hudTranscript = new DictionaryReplacer(this.settings.dictionary).apply(raw.trim())
      if (this.settings.cleanup.enabled) {
        this.setHudPhase({ kind: 'enhancing', progress: null, showsProgress: false })
      } else {
        // No AI step: the preview still swaps to the final text for the
        // moment until delivery hides the pill.
        this.setHudPhase(this.hudPhase)
      }
      this.dictation?.markAiStarted()
      const outcome = this.settings.cleanup.enabled
        ? await this.polish(raw, this.settings, generation)
        : await enhanceTranscript(raw, this.settings, { db: this.db })
      if (generation !== this.generation) return
      // A skip already ended the AI step at the moment it was pressed.
      if (outcome.ai !== 'skipped') {
        this.dictation?.markAiFinished(outcome.ai)
      }

      await this.deliver(
        outcome.text,
        raw,
        outcome.cleaned,
        outcome.fallbackReason,
        durationMs,
        outcome.ai
      )
    } catch (error) {
      if (generation !== this.generation) return
      const message = error instanceof Error ? error.message : String(error)
      log.error('Transcription failed', error instanceof Error ? error : new Error(message))
      this.endDictation('failed', 'transcription-error')
      this.lastError = message
      this.showTransientNotice('Transcription failed')
    }
  }

  /**
   * Run AI cleanup as a skippable step: the pill shows the final transcript and
   * "Polishing…" until the AI answers, or until the user skips (Skip, Escape or
   * the hotkey), which settles at once with exactly the shown text and aborts
   * the AI request. Settles once, with whichever came first.
   */
  private polish(
    raw: string,
    settings: VoiceSettings,
    generation: number
  ): Promise<VoiceCleanupOutcome> {
    const shown = this.hudTranscript
    const abort = new AbortController()
    return new Promise<VoiceCleanupOutcome>((resolve) => {
      let settled = false
      const settle = (outcome: VoiceCleanupOutcome): boolean => {
        if (settled) return false
        settled = true
        resolve(outcome)
        return true
      }
      this.polishing = {
        generation,
        abort,
        skip: (input) => {
          if (!settle({ text: shown, cleaned: false, fallbackReason: null, ai: 'skipped' })) return
          this.dictation?.markAiSkipped(input)
          log.info('AI polishing skipped', { input })
          abort.abort()
        }
      }
      enhanceTranscript(raw, settings, { db: this.db, signal: abort.signal }).then(
        settle,
        // enhanceTranscript never throws; should it ever, the shown text still lands.
        (error: unknown) =>
          settle({ text: shown, cleaned: false, fallbackReason: String(error), ai: 'failed' })
      )
    })
  }

  /**
   * Skip the AI polishing step of the dictation in flight: paste the shown
   * transcript now. True when the press belongs to the polishing step (also
   * when the AI already answered and its text is landing), false when there is
   * no polishing step to skip.
   */
  skipPolishing(input: VoiceSkipInput): boolean {
    const step = this.polishing
    if (!step || step.generation !== this.generation || this.state !== 'processing') return false
    step.skip(input)
    return true
  }

  /** The dictation ended: stop its AI request if it is still running. */
  private abortPolishing(): void {
    const step = this.polishing
    if (!step) return
    this.polishing = null
    step.abort.abort()
  }

  private async deliver(
    text: string,
    raw: string,
    cleaned: boolean,
    fallbackReason: string | null,
    durationMs: number,
    cleanup: VoiceCleanupResult
  ): Promise<void> {
    if (!text.trim()) {
      this.endDictation('discarded', 'empty-text')
      this.finish()
      return
    }

    let entry: VoiceHistoryEntry | null = null
    try {
      const row = this.db?.addVoiceHistory({
        text,
        raw_text: raw !== text ? raw : null,
        duration_ms: durationMs,
        cleaned,
        speech_model: this.settings.speechModel
      })
      entry = row ? toVoiceHistoryEntry(row) : null
    } catch (error) {
      log.warn('Could not save transcript to history', { error: String(error) })
    }

    const delivery = await deliverVoiceText(
      this.getMainWindow(),
      text,
      this.settings.restoreClipboardDelayMs
    )
    this.endDelivered(delivery, text)

    if (entry) {
      this.broadcastResult({ entry, delivery, cleanupFallbackReason: fallbackReason, cleanup })
    }

    if (delivery === 'copied') {
      this.showTransientNotice('Copied to clipboard')
    } else {
      this.finish()
    }
  }

  /** Escape, a click on a notice, or the app disabling voice mid-flight. */
  cancel(reason = 'user'): void {
    const wasRecording = this.state === 'recording'
    // A click on the notice after a dictation already ended has nothing left to log.
    this.endDictation('cancelled', reason)
    this.generation++
    this.clearMaxRecordingTimer()
    this.rejectAudioWaiter(new Error('cancelled'))
    this.closeStream()
    if (wasRecording) {
      voiceHud.cancelCapture()
      void voiceMedia.recordingDidStop()
    }
    this.finish()
  }

  private endDelivered(delivery: DictationDelivery, text: string): void {
    this.dictation?.markDelivered(delivery, text.length)
    this.endDictation('delivered')
  }

  /**
   * Writes the dictation's one summary line (VOICE-01). Every way a dictation
   * ends goes through here; the trace is dropped afterwards so a later cancel,
   * notice click or shutdown cannot log it twice.
   */
  private endDictation(outcome: DictationOutcome, reason: string | null = null): void {
    const trace = this.dictation
    if (!trace) return
    this.dictation = null
    const summary = trace.finish(outcome, reason)
    if (summary) log.info(DICTATION_SUMMARY_MESSAGE, summary)
  }

  private finish(): void {
    this.abortPolishing()
    this.closeStream()
    this.clearPreview()
    this.clearNoticeTimer()
    this.clearMaxRecordingTimer()
    this.notice = null
    this.unregisterEscape()
    this.setHudPhase({ kind: 'hidden' })
    this.state =
      this.settings.enabled && this.modelReady() && !this.headless ? 'idle' : 'unavailable'
    this.broadcast()
  }

  private showTransientNotice(text: string, seconds = NOTICE_SECONDS): void {
    const generation = this.generation
    const serial = ++this.noticeSerial
    this.clearNoticeTimer()
    this.clearMaxRecordingTimer()
    this.closeStream()
    this.clearPreview()
    this.abortPolishing()
    this.notice = text
    this.unregisterEscape()
    if (this.state === 'recording' || this.state === 'processing') {
      this.state = this.settings.enabled && this.modelReady() ? 'idle' : 'unavailable'
    }
    this.setHudPhase({ kind: 'notice', text })
    voiceHud.show()
    this.broadcast()
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null
      // A newer notice or a new dictation owns the pill now.
      if (generation !== this.generation || serial !== this.noticeSerial) return
      if (voiceHud.getState().phase.kind !== 'notice') return
      this.finish()
    }, seconds * 1000)
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer)
      this.noticeTimer = null
    }
  }

  private clearMaxRecordingTimer(): void {
    if (this.maxRecordingTimer) {
      clearTimeout(this.maxRecordingTimer)
      this.maxRecordingTimer = null
    }
  }

  private setHudPhase(phase: VoiceHudPhase): void {
    this.hudPhase = phase
    const transcript = phase.kind === 'hidden' || phase.kind === 'notice' ? '' : this.hudTranscript
    voiceHud.setState({
      phase,
      sounds: this.settings.sounds,
      ...(transcript ? { transcript } : {})
    })
  }

  /** Drop the live transcript and any update still scheduled for the HUD. */
  private clearPreview(): void {
    this.preview?.cancel()
    this.preview = null
    this.hudTranscript = ''
  }

  private playSound(name: VoiceSoundName): void {
    if (!this.settings.sounds) return
    voiceHud.playSound(name)
  }

  // ---- audio hand-off from the HUD renderer -------------------------------------------------

  /**
   * A streaming session for this recording, or null with an offline speech
   * model. Its transcript updates go to the HUD as the live preview: dictionary
   * applied (what you see is what gets pasted) and rate-capped.
   */
  private openStream(id: number): DictationAudioStream | null {
    const modelId = this.settings.speechModel
    if (!findVoiceSpeechModel(modelId).streaming) return null
    const replacer = new DictionaryReplacer(this.settings.dictionary)
    const preview = new PreviewThrottle(PREVIEW_INTERVAL_MS, (text) => this.showPreview(id, text))
    this.preview = preview
    const session = voiceEngine.startSession(engineModel(modelId), {
      sampleRate: STREAM_SAMPLE_RATE,
      onUpdate: (text) => {
        // Live text only while this recording runs; after stop the final transcript takes over.
        if (!this.isStreaming(id)) return
        preview.push(replacer.apply(text.trim()))
      },
      onError: (error) => this.onStreamFailed(id, error)
    })
    this.dictation?.markStreamed()
    return new DictationAudioStream(id, session, STREAM_SAMPLE_RATE)
  }

  /** The recording `id` is still being captured and streamed. */
  private isStreaming(id: number): boolean {
    return this.state === 'recording' && this.stream?.id === id
  }

  private showPreview(id: number, text: string): void {
    if (!this.isStreaming(id)) return
    this.hudTranscript = text
    this.dictation?.markPreview()
    voiceTestClips.reportPreview(text)
    this.setHudPhase(this.hudPhase)
  }

  /**
   * The session failed while the user was still speaking (or before the clip
   * arrived). The recording goes on, and at stop the whole clip is transcribed
   * instead, so start reloading the model now for that.
   */
  private onStreamFailed(id: number, error: Error): void {
    // Once the clip arrived the stop path owns the stream and sees the failure itself.
    if (this.stream?.id !== id) return
    log.warn('Streaming session failed during dictation', { error: error.message })
    if (this.state === 'recording') {
      // A preview that stopped growing would mislead; the final text comes at stop.
      this.clearPreview()
      this.setHudPhase(this.hudPhase)
    }
    void voiceEngine
      .ensureLoaded(engineModel(this.settings.speechModel))
      .catch((reloadError: unknown) => {
        log.warn('speech model reload after a failed session failed', {
          error: String(reloadError)
        })
      })
  }

  /** A chunk the HUD captured while recording (streaming speech models only). */
  onAudioChunk(chunk: VoiceAudioChunk): void {
    this.stream?.accept(chunk)
  }

  /** Cancel the open stream, if any: its session must not outlive the dictation. */
  private closeStream(): void {
    const stream = this.stream
    if (!stream) return
    this.stream = null
    stream.cancel()
  }

  /**
   * Finish the session and use its final text. Falls back to the whole clip
   * (same model) when the session failed, the engine crashed, the audio broke
   * off, the session did not get the whole clip, or it heard no words in a clip
   * that passed the speech checks. Null when the dictation was superseded.
   */
  private async transcribeStreamed(
    stream: DictationAudioStream,
    audio: VoiceAudioPayload,
    samples: Float32Array,
    generation: number
  ): Promise<DictationTranscript | null> {
    let result: DictationStreamResult | null = null
    let failure: unknown = null
    try {
      result = await stream.finish(audio.samples, audio.sampleRate)
    } catch (error) {
      failure = error
    }
    if (generation !== this.generation) return null

    let reason: DictationFallbackReason
    if (result) {
      const clipMs = (result.clipSamples / result.sampleRate) * 1000
      if (Math.abs(result.audioMs - clipMs) > STREAM_AUDIO_TOLERANCE_MS) {
        reason = 'incomplete-audio'
      } else if (!result.text) {
        reason = 'empty-text'
      } else {
        this.reportStream(stream, audio, result, null, null)
        return {
          text: result.text,
          decodeMs: result.workerFinishMs,
          source: 'streamed',
          fallbackReason: null
        }
      }
    } else {
      reason = fallbackReasonFor(failure)
    }

    const error =
      failure === null ? null : failure instanceof Error ? failure.message : String(failure)
    log.warn('Transcribing the whole clip instead of the streamed text', {
      reason,
      ...(error ? { error } : {}),
      ...(result
        ? {
            sessionAudioMs: result.audioMs,
            clipMs: Math.round((result.clipSamples / result.sampleRate) * 1000)
          }
        : {})
    })
    this.reportStream(stream, audio, result, reason, error)
    return this.transcribeWholeClip(samples, audio.sampleRate, generation, 'fallback', reason)
  }

  /** Transcribe the trimmed clip whole, loading the model first if it is not (or no longer) loaded. */
  private async transcribeWholeClip(
    samples: Float32Array,
    sampleRate: number,
    generation: number,
    source: DictationTextSource,
    fallbackReason: DictationFallbackReason | null
  ): Promise<DictationTranscript | null> {
    await voiceEngine.ensureLoaded(engineModel(this.settings.speechModel))
    if (generation !== this.generation) return null
    const { text, decodeMs } = await voiceEngine.transcribe(samples, sampleRate)
    if (generation !== this.generation) return null
    return { text, decodeMs, source, fallbackReason }
  }

  /** Log what the session received and how it ended; kept for the verify workflow too. */
  private reportStream(
    stream: DictationAudioStream,
    audio: VoiceAudioPayload,
    result: DictationStreamResult | null,
    fallbackReason: DictationFallbackReason | null,
    error: string | null
  ): void {
    const progress = result ?? stream.progress
    const ms = (samples: number): number => Math.round((samples / progress.sampleRate) * 1000)
    const report = {
      chunks: progress.chunks,
      streamedMs: ms(progress.streamedSamples),
      topUpMs: ms(progress.topUpSamples),
      clipMs: Math.round((audio.samples.length / Math.max(1, audio.sampleRate)) * 1000),
      sessionAudioMs: result ? result.audioMs : null,
      finishMs: result ? result.finishMs : null
    }
    if (result) log.info('Streamed dictation audio', { ...report, chars: result.text.length })
    voiceTestClips.reportStream({
      ...report,
      text: result ? result.text : null,
      textSource: fallbackReason ? 'fallback' : 'streamed',
      fallbackReason,
      error
    })
  }

  private waitForAudio(): Promise<VoiceAudioPayload> {
    this.rejectAudioWaiter(new Error('superseded'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.audioWaiter = null
        reject(new Error('Recording did not deliver any audio'))
      }, AUDIO_TIMEOUT_MS)
      this.audioWaiter = { resolve, reject, timer }
    })
  }

  onAudio(payload: VoiceAudioPayload): void {
    const waiter = this.audioWaiter
    if (!waiter) return
    this.audioWaiter = null
    clearTimeout(waiter.timer)
    waiter.resolve(payload)
  }

  private rejectAudioWaiter(error: Error): void {
    const waiter = this.audioWaiter
    if (!waiter) return
    this.audioWaiter = null
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }

  // ---- history ----------------------------------------------------------------------------

  listHistory(options: { limit: number; offset?: number; query?: string }): VoiceHistoryEntry[] {
    if (!this.db) return []
    return this.db.listVoiceHistory(options).map(toVoiceHistoryEntry)
  }

  countHistory(query?: string): number {
    return this.db?.countVoiceHistory(query) ?? 0
  }

  deleteHistory(id: string): boolean {
    return this.db?.deleteVoiceHistory(id) ?? false
  }

  clearHistory(): number {
    return this.db?.clearVoiceHistory() ?? 0
  }

  /** For status text: the human name of the configured speech model. */
  speechModelName(): string {
    return findVoiceSpeechModel(this.settings.speechModel).name
  }
}

export const voiceController = new VoiceController()
