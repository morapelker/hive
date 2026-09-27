import { app, globalShortcut, shell, systemPreferences, type BrowserWindow } from 'electron'
import {
  findVoiceSpeechModel,
  type VoiceDictationResult,
  type VoiceDictationState,
  type VoiceHistoryEntry,
  type VoiceHudPhase,
  type VoiceMicPermission,
  type VoiceSettings,
  type VoiceSpeechModelId,
  type VoiceStatus
} from '@shared/types/voice'
import { parseHotkey, type HotkeySpec } from '@shared/voice/hotkey-spec'
import type { DatabaseService } from '../db/database'
import type { VoiceHistoryRow } from '../db/types'
import { createLogger } from '../services/logger'
import { isDigitalSilence, trimSilence } from './voice-audio'
import { enhanceTranscript } from './voice-cleanup'
import { voiceEngine } from './voice-engine'
import { voiceHud } from './voice-hud-window'
import { voiceMedia } from './voice-media'
import { voiceModelStore } from './voice-model-store'
import { deliverVoiceText } from './voice-paste'
import { readVoiceSettings } from './voice-settings'
import type { VoiceSoundName } from './voice-sounds'

const log = createLogger({ component: 'VoiceDictation' })

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
const MAC_MIC_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

export interface VoiceAudioPayload {
  readonly samples: Float32Array
  readonly sampleRate: number
  readonly durationMs: number
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
    this.generation++
    this.unregisterHotkey()
    this.unregisterEscape()
    for (const off of this.unsubscribe.splice(0)) off()
    this.clearNoticeTimer()
    this.rejectAudioWaiter(new Error('shutting down'))
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
    if (previous.speechModel !== next.speechModel && voiceEngine.isLoaded) {
      voiceEngine.unload('speech model changed')
    }

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
    } else {
      this.unregisterHotkey()
      if (this.state === 'recording' || this.state === 'processing') {
        this.cancel()
      }
      voiceHud.hide()
      if (voiceEngine.isLoaded) voiceEngine.unload('voice disabled')
    }

    this.recomputeState()
    this.broadcast()
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

  /** Escape cancels — registered only while a dictation is in flight (Wispelker semantics). */
  private registerEscape(): void {
    if (this.escapeRegistered) return
    try {
      this.escapeRegistered = globalShortcut.register('Escape', () => this.cancel())
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
    if (voiceEngine.loadedModel === voiceModelStore.getModelDir(modelId)) {
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
        // Let it finish; Escape cancels.
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

    // With Chromium's fake capture device (automated runs) no real microphone
    // is opened, so the OS permission pre-flight would only block on a dialog.
    const fakeDevice = app.commandLine.hasSwitch('use-fake-device-for-media-stream')
    if (process.platform === 'darwin' && !fakeDevice) {
      const status = this.getMicPermission()
      if (status === 'not-determined') {
        const granted = await this.requestMicrophoneAccess()
        if (granted !== 'granted') {
          this.showTransientNotice('Microphone access denied')
          return
        }
      } else if (status === 'denied' || status === 'restricted') {
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
      this.lastError = 'Could not start recording'
      this.showTransientNotice('Could not start recording')
      return
    }

    this.setHudPhase({ kind: 'recording' })
    voiceHud.show()
    voiceHud.startCapture()
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
      .ensureLoaded(voiceModelStore.getModelDir(this.settings.speechModel))
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
    this.playSound('start')
  }

  /** The HUD renderer could not open the microphone. */
  onCaptureError(message: string): void {
    if (this.state !== 'recording') return
    log.warn('capture failed', { message })
    this.generation++
    this.rejectAudioWaiter(new Error(message))
    void voiceMedia.recordingDidStop()
    this.lastError = message
    const denied = /permission|denied|notallowed/i.test(message)
    this.showTransientNotice(denied ? 'Microphone access denied' : 'Could not start recording')
  }

  /** Click on the pill while recording. */
  onHudStopClick(): void {
    if (this.state === 'recording') void this.stopAndProcess()
  }

  private async stopAndProcess(): Promise<void> {
    if (this.state !== 'recording') return
    const generation = ++this.generation
    const durationMs = Date.now() - this.recordingStartedAt
    this.clearMaxRecordingTimer()

    const audioPromise = this.waitForAudio()
    voiceHud.stopCapture()
    this.playSound('stop')
    void voiceMedia.recordingDidStop()

    this.state = 'processing'
    this.setHudPhase({ kind: 'transcribing', progress: null, showsProgress: false })
    this.broadcast()

    try {
      const audio = await audioPromise
      if (generation !== this.generation) return

      const seconds = audio.samples.length / Math.max(1, audio.sampleRate)
      if (seconds <= MIN_CLIP_SECONDS) {
        log.info('Discarding clip: too short', { seconds })
        this.finish()
        return
      }
      const samples = trimSilence(audio.samples, audio.sampleRate)
      if (samples.length / audio.sampleRate <= MIN_CLIP_SECONDS || isDigitalSilence(samples)) {
        log.info('Discarding clip: nothing heard', { seconds })
        this.showTransientNotice('Nothing heard', SHORT_NOTICE_SECONDS)
        return
      }

      await voiceEngine.ensureLoaded(voiceModelStore.getModelDir(this.settings.speechModel))
      if (generation !== this.generation) return

      const { text: raw, decodeMs } = await voiceEngine.transcribe(samples, audio.sampleRate)
      if (generation !== this.generation) return
      log.info('Transcribed', {
        seconds: Math.round(seconds * 10) / 10,
        decodeMs,
        chars: raw.length
      })
      if (!raw) {
        this.showTransientNotice('Nothing heard', SHORT_NOTICE_SECONDS)
        return
      }

      if (this.settings.cleanup.enabled) {
        this.setHudPhase({ kind: 'enhancing', progress: null, showsProgress: false })
      }
      const outcome = await enhanceTranscript(raw, this.settings, { db: this.db })
      if (generation !== this.generation) return

      await this.deliver(outcome.text, raw, outcome.cleaned, outcome.fallbackReason, durationMs)
    } catch (error) {
      if (generation !== this.generation) return
      const message = error instanceof Error ? error.message : String(error)
      log.error('Transcription failed', error instanceof Error ? error : new Error(message))
      this.lastError = message
      this.showTransientNotice('Transcription failed')
    }
  }

  private async deliver(
    text: string,
    raw: string,
    cleaned: boolean,
    fallbackReason: string | null,
    durationMs: number
  ): Promise<void> {
    if (!text.trim()) {
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

    if (entry) {
      this.broadcastResult({ entry, delivery, cleanupFallbackReason: fallbackReason })
    }

    if (delivery === 'copied') {
      this.showTransientNotice('Copied to clipboard')
    } else {
      this.finish()
    }
  }

  /** Escape, a click on a notice, or the app disabling voice mid-flight. */
  cancel(): void {
    const wasRecording = this.state === 'recording'
    this.generation++
    this.clearMaxRecordingTimer()
    this.rejectAudioWaiter(new Error('cancelled'))
    if (wasRecording) {
      voiceHud.cancelCapture()
      void voiceMedia.recordingDidStop()
    }
    this.finish()
  }

  private finish(): void {
    this.clearNoticeTimer()
    this.clearMaxRecordingTimer()
    this.notice = null
    this.unregisterEscape()
    voiceHud.setState({ phase: { kind: 'hidden' }, sounds: this.settings.sounds })
    this.state =
      this.settings.enabled && this.modelReady() && !this.headless ? 'idle' : 'unavailable'
    this.broadcast()
  }

  private showTransientNotice(text: string, seconds = NOTICE_SECONDS): void {
    const generation = this.generation
    const serial = ++this.noticeSerial
    this.clearNoticeTimer()
    this.clearMaxRecordingTimer()
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
    voiceHud.setState({ phase, sounds: this.settings.sounds })
  }

  private playSound(name: VoiceSoundName): void {
    if (!this.settings.sounds) return
    voiceHud.playSound(name)
  }

  // ---- audio hand-off from the HUD renderer -------------------------------------------------

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
