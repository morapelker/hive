import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import {
  sanitizeVoiceSettings,
  VOICE_SPEECH_MODELS,
  type VoiceSpeechModelId
} from '@shared/types/voice'
import type { DatabaseService } from '../db/database'
import { createLogger } from '../services/logger'
import { voiceController, type VoiceAudioPayload } from './voice-controller'
import { voiceHud } from './voice-hud-window'
import { loadVoiceSoundBuffers } from './voice-sounds'

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
    voiceController.cancel()
  })

  ipcMain.on('voice:hud:capture-started', (event) => {
    if (!isHud(event)) return
    voiceController.onCaptureStarted()
  })

  ipcMain.on('voice:hud:capture-error', (event, message: unknown) => {
    if (!isHud(event)) return
    voiceController.onCaptureError(typeof message === 'string' ? message : 'capture failed')
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
}

export function disposeVoiceDictation(): void {
  voiceController.dispose()
}
