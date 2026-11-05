import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import {
  sanitizeVoiceAudioChunk,
  sanitizeVoiceSettings,
  VOICE_SPEECH_MODELS,
  type VoiceSpeechModelId,
  type VoiceTestSelectOptions
} from '@shared/types/voice'
import type { DatabaseService } from '../db/database'
import { createLogger } from '../services/logger'
import { voiceController, type VoiceAudioPayload } from './voice-controller'
import { voiceHud } from './voice-hud-window'
import { loadVoiceSoundBuffers } from './voice-sounds'
import { voiceTestClips } from './voice-test-clips'

const log = createLogger({ component: 'VoiceIpc' })

let registered = false

function isSpeechModelId(value: unknown): value is VoiceSpeechModelId {
  return typeof value === 'string' && VOICE_SPEECH_MODELS.some((m) => m.id === value)
}

/**
 * Wire voice dictation into the app: the controller, its IPC surface for the
 * main window (`window.desktopBridge.voice`) and for the floating pill
 * (`window.desktopBridge.voiceHud`).
 */
export function initVoiceDictation(options: {
  db: DatabaseService
  getMainWindow: () => BrowserWindow | null
  headless?: boolean
}): void {
  voiceController.init(options)
  if (registered) return
  registered = true

  const isMainWindow = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
    const main = options.getMainWindow()
    return !!main && !main.isDestroyed() && event.sender === main.webContents
  }
  const isHud = (event: IpcMainInvokeEvent | IpcMainEvent): boolean =>
    voiceHud.isHudContents(event.sender)
  const requireMain = (event: IpcMainInvokeEvent): void => {
    if (!isMainWindow(event)) throw new Error('voice: only the main window may call this')
  }

  // ---- main window --------------------------------------------------------------------------

  ipcMain.handle('voice:get-status', (event) => {
    requireMain(event)
    return voiceController.getStatus()
  })

  ipcMain.handle('voice:update-settings', (event, raw: unknown) => {
    requireMain(event)
    voiceController.applySettings(sanitizeVoiceSettings(raw))
  })

  ipcMain.handle('voice:toggle', async (event) => {
    requireMain(event)
    await voiceController.toggle()
  })

  ipcMain.handle('voice:cancel', (event) => {
    requireMain(event)
    voiceController.cancel()
  })

  ipcMain.handle('voice:model:download', (event, modelId: unknown) => {
    requireMain(event)
    if (!isSpeechModelId(modelId)) throw new Error('unknown speech model')
    voiceController.downloadModel(modelId)
  })

  ipcMain.handle('voice:model:cancel-download', (event, modelId: unknown) => {
    requireMain(event)
    if (!isSpeechModelId(modelId)) throw new Error('unknown speech model')
    voiceController.cancelDownload(modelId)
  })

  ipcMain.handle('voice:model:delete', async (event, modelId: unknown) => {
    requireMain(event)
    if (!isSpeechModelId(modelId)) throw new Error('unknown speech model')
    await voiceController.deleteModel(modelId)
  })

  ipcMain.handle('voice:mic:request', async (event) => {
    requireMain(event)
    return voiceController.requestMicrophoneAccess()
  })

  ipcMain.handle('voice:mic:open-settings', (event) => {
    requireMain(event)
    voiceController.openMicrophoneSettings()
  })

  ipcMain.handle('voice:history:list', (event, raw: unknown) => {
    requireMain(event)
    const options = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    return voiceController.listHistory({
      limit: typeof options.limit === 'number' ? options.limit : 20,
      offset: typeof options.offset === 'number' ? options.offset : 0,
      query: typeof options.query === 'string' ? options.query : undefined
    })
  })

  ipcMain.handle('voice:history:count', (event, query: unknown) => {
    requireMain(event)
    return voiceController.countHistory(typeof query === 'string' ? query : undefined)
  })

  ipcMain.handle('voice:history:delete', (event, id: unknown) => {
    requireMain(event)
    if (typeof id !== 'string') return false
    return voiceController.deleteHistory(id)
  })

  ipcMain.handle('voice:history:clear', (event) => {
    requireMain(event)
    return voiceController.clearHistory()
  })

  // ---- floating pill --------------------------------------------------------------------------

  ipcMain.on('voice:hud:ready', (event) => {
    if (!isHud(event)) return
    voiceHud.markReady()
  })

  ipcMain.on('voice:hud:click-stop', (event) => {
    if (!isHud(event)) return
    voiceController.onHudStopClick()
  })

  ipcMain.on('voice:hud:click-cancel', (event) => {
    if (!isHud(event)) return
    voiceController.cancel('hud-click')
  })

  ipcMain.on('voice:hud:capture-started', (event) => {
    if (!isHud(event)) return
    voiceController.onCaptureStarted()
  })

  ipcMain.on('voice:hud:capture-error', (event, message: unknown) => {
    if (!isHud(event)) return
    voiceController.onCaptureError(typeof message === 'string' ? message : 'capture failed')
  })

  // Streaming speech models: each captured chunk while recording. Sent on the
  // same pipe as 'voice:hud:audio', so all of them arrive before the clip.
  ipcMain.on('voice:hud:audio-chunk', (event, raw: unknown) => {
    if (!isHud(event)) return
    const chunk = sanitizeVoiceAudioChunk(raw)
    if (!chunk) {
      log.warn('HUD sent a malformed audio chunk')
      return
    }
    voiceController.onAudioChunk(chunk)
  })

  ipcMain.handle('voice:hud:audio', (event, raw: unknown) => {
    if (!isHud(event)) throw new Error('voice: only the HUD window may deliver audio')
    const payload = raw as Partial<VoiceAudioPayload> | null
    if (!payload || !(payload.samples instanceof Float32Array)) {
      log.warn('HUD delivered malformed audio payload')
      return
    }
    voiceController.onAudio({
      samples: payload.samples,
      sampleRate:
        typeof payload.sampleRate === 'number' && payload.sampleRate > 0
          ? payload.sampleRate
          : 16000,
      durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : 0
    })
  })

  ipcMain.handle('voice:hud:get-sounds', async (event) => {
    if (!isHud(event)) throw new Error('voice: only the HUD window may load sounds')
    return loadVoiceSoundBuffers()
  })

  if (voiceTestClips.enabled) registerVoiceTestClipIpc({ isMainWindow, isHud })
}

/**
 * Dev/test only (TEDOOO_CODE_VOICE_TEST_CLIPS): lets the verify workflow pick
 * the clip the HUD plays instead of the microphone, and start/stop a dictation
 * through the same controller toggle the hotkey uses. Never registered in normal use.
 */
export function registerVoiceTestClipIpc(guards: {
  isMainWindow: (event: IpcMainInvokeEvent | IpcMainEvent) => boolean
  isHud: (event: IpcMainInvokeEvent | IpcMainEvent) => boolean
}): void {
  const requireMain = (event: IpcMainInvokeEvent): void => {
    if (!guards.isMainWindow(event)) throw new Error('voice: only the main window may call this')
  }
  const options = (raw: unknown): VoiceTestSelectOptions => {
    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    return {
      autoStopAfterMs:
        typeof record.autoStopAfterMs === 'number' ? record.autoStopAfterMs : null
    }
  }

  // An elapsed auto-stop presses the hotkey, in effect.
  voiceTestClips.setStopHandler(() => {
    if (voiceController.isRecording()) void voiceController.toggle()
  })

  ipcMain.handle('voice:test:status', (event) => {
    requireMain(event)
    return voiceTestClips.status()
  })

  ipcMain.handle('voice:test:list', (event) => {
    requireMain(event)
    return voiceTestClips.list()
  })

  ipcMain.handle('voice:test:select', (event, name: unknown, raw: unknown) => {
    requireMain(event)
    return voiceTestClips.select(name, options(raw))
  })

  ipcMain.handle('voice:test:start', async (event, raw: unknown) => {
    requireMain(event)
    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (voiceController.getStatus().state !== 'idle') {
      throw new Error('voice: dictation is not idle')
    }
    await voiceTestClips.select(record.clip, options(raw))
    await voiceController.toggle()
    return voiceTestClips.status()
  })

  ipcMain.handle('voice:test:stop', async (event) => {
    requireMain(event)
    if (voiceController.isRecording()) await voiceController.toggle()
    return voiceTestClips.status()
  })

  ipcMain.on('voice:hud:test-clip-ended', (event) => {
    if (!guards.isHud(event)) return
    voiceTestClips.clipEnded()
  })
}

export function disposeVoiceDictation(): void {
  voiceController.dispose()
}
