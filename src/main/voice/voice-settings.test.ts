import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import { DEFAULT_VOICE_SETTINGS, type VoiceSpeechModelId } from '@shared/types/voice'

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))
vi.mock('../services/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/logger')>()),
  createLogger: () => logger
}))

import { loadVoiceSettingsOnStartup, readVoiceSettings } from './voice-settings'

/** An in-memory settings table holding the app-settings blob. */
function makeDb(blob: Record<string, unknown> | null): {
  getSetting: (key: string) => string | null
  setSetting: ReturnType<typeof vi.fn>
  saved: () => Record<string, unknown> | null
} {
  let raw = blob ? JSON.stringify(blob) : null
  const setSetting = vi.fn((key: string, value: string) => {
    if (key === APP_SETTINGS_DB_KEY) raw = value
  })
  return {
    getSetting: (key) => (key === APP_SETTINGS_DB_KEY ? raw : null),
    setSetting,
    saved: () => (raw ? (JSON.parse(raw) as Record<string, unknown>) : null)
  }
}

/** A voice blob as saved before the streaming default (no marker, Parakeet v2). */
const PRE_UPGRADE_VOICE = {
  enabled: false,
  speechModel: 'parakeet-tdt-0.6b-v2',
  hotkey: 'option+space',
  sounds: true,
  pauseMediaWhileRecording: true,
  cleanup: {
    enabled: true,
    model: null,
    customProviderId: null,
    timeoutSeconds: 10,
    systemPrompt: ''
  },
  dictionary: [],
  restoreClipboardDelayMs: 400,
  unloadModelAfterMinutes: 10
}

const nothingOnDisk = (): boolean => false
const v2OnDisk = (id: VoiceSpeechModelId): boolean => id === 'parakeet-tdt-0.6b-v2'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadVoiceSettingsOnStartup', () => {
  it('gives a fresh data dir the streaming model and writes nothing', () => {
    const db = makeDb(null)
    const settings = loadVoiceSettingsOnStartup(db, nothingOnDisk)
    expect(settings.speechModel).toBe('nemotron-speech-streaming-en-0.6b')
    expect(settings.enabled).toBe(false)
    expect(db.setSetting).not.toHaveBeenCalled()
  })

  it('gives a profile saved before voice existed the streaming model', () => {
    const db = makeDb({ theme: 'dark' })
    expect(loadVoiceSettingsOnStartup(db, nothingOnDisk).speechModel).toBe(
      'nemotron-speech-streaming-en-0.6b'
    )
    expect(db.setSetting).not.toHaveBeenCalled()
  })

  it('leaves an existing Parakeet v2 profile with voice on unchanged, and records the check', () => {
    const voice = { ...PRE_UPGRADE_VOICE, enabled: true, hotkey: 'f19' }
    const db = makeDb({ theme: 'dark', voice })
    const settings = loadVoiceSettingsOnStartup(db, nothingOnDisk)
    expect(settings).toMatchObject({
      enabled: true,
      speechModel: 'parakeet-tdt-0.6b-v2',
      hotkey: 'f19'
    })
    expect(db.saved()).toEqual({
      theme: 'dark',
      voice: {
        ...voice,
        speechModelDefaultMigrated: true,
        streamingSuggestionDismissed: false
      }
    })
    expect(logger.info).toHaveBeenCalledWith('Checked the voice speech-model default', {
      speechModel: 'parakeet-tdt-0.6b-v2',
      switched: false
    })
  })

  it('keeps Parakeet v2 for a profile with voice off whose model is still on disk', () => {
    const db = makeDb({ voice: PRE_UPGRADE_VOICE })
    expect(loadVoiceSettingsOnStartup(db, v2OnDisk).speechModel).toBe('parakeet-tdt-0.6b-v2')
    expect((db.saved()?.voice as Record<string, unknown>).speechModel).toBe('parakeet-tdt-0.6b-v2')
  })

  it('moves a profile that never used voice to the streaming model and saves it', () => {
    const db = makeDb({ theme: 'dark', voice: PRE_UPGRADE_VOICE })
    const settings = loadVoiceSettingsOnStartup(db, nothingOnDisk)
    expect(settings.speechModel).toBe('nemotron-speech-streaming-en-0.6b')
    expect(db.saved()).toMatchObject({
      theme: 'dark',
      voice: { speechModel: 'nemotron-speech-streaming-en-0.6b', speechModelDefaultMigrated: true }
    })
    expect(readVoiceSettings(db).speechModel).toBe('nemotron-speech-streaming-en-0.6b')
  })

  it('runs only once per profile', () => {
    const db = makeDb({ voice: { ...PRE_UPGRADE_VOICE, enabled: true } })
    loadVoiceSettingsOnStartup(db, nothingOnDisk)
    expect(db.setSetting).toHaveBeenCalledTimes(1)
    // Next launch, voice since turned off with the model deleted: the user's model stays.
    const next = makeDb({ voice: { ...(db.saved()?.voice as object), enabled: false } })
    expect(loadVoiceSettingsOnStartup(next, nothingOnDisk).speechModel).toBe('parakeet-tdt-0.6b-v2')
    expect(next.setSetting).not.toHaveBeenCalled()
  })

  it('does not write for settings saved with the new defaults', () => {
    const db = makeDb({ voice: { ...DEFAULT_VOICE_SETTINGS, enabled: true } })
    expect(loadVoiceSettingsOnStartup(db, nothingOnDisk).speechModel).toBe(
      'nemotron-speech-streaming-en-0.6b'
    )
    expect(db.setSetting).not.toHaveBeenCalled()
  })

  it('still returns the checked settings when saving fails', () => {
    const db = makeDb({ voice: PRE_UPGRADE_VOICE })
    db.setSetting.mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(loadVoiceSettingsOnStartup(db, nothingOnDisk).speechModel).toBe(
      'nemotron-speech-streaming-en-0.6b'
    )
    expect(logger.warn).toHaveBeenCalled()
  })

  it('falls back to the defaults for an unreadable blob without writing', () => {
    const db = { getSetting: () => '{not json', setSetting: vi.fn() }
    expect(loadVoiceSettingsOnStartup(db, nothingOnDisk)).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(db.setSetting).not.toHaveBeenCalled()
  })
})
