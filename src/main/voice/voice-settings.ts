import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import {
  DEFAULT_VOICE_SETTINGS,
  migrateVoiceSpeechModelDefault,
  sanitizeVoiceSettings,
  type VoiceSettings,
  type VoiceSpeechModelId
} from '@shared/types/voice'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'VoiceSettings' })

/**
 * Voice settings live in the app-settings JSON blob the renderer store owns
 * (key `voice`). The main process reads them once at startup and receives
 * every later change directly over IPC (the renderer pushes the new object
 * alongside its own DB write, so main never races the async save).
 */
export function readVoiceSettings(
  db: { getSetting(key: string): string | null } | null
): VoiceSettings {
  if (!db) return sanitizeVoiceSettings(DEFAULT_VOICE_SETTINGS)
  try {
    const raw = db.getSetting(APP_SETTINGS_DB_KEY)
    if (!raw) return sanitizeVoiceSettings(DEFAULT_VOICE_SETTINGS)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return sanitizeVoiceSettings(parsed.voice)
  } catch {
    return sanitizeVoiceSettings(DEFAULT_VOICE_SETTINGS)
  }
}

/**
 * Startup read: `readVoiceSettings` plus the one-time move of profiles that
 * never used voice to the streaming default speech model
 * (`migrateVoiceSpeechModelDefault`). The result is written back into the
 * app-settings blob before the main window loads it, so the renderer and main
 * agree, and the check never runs twice for a profile.
 */
export function loadVoiceSettingsOnStartup(
  db: { getSetting(key: string): string | null; setSetting(key: string, value: string): void },
  hasLocalFiles: (modelId: VoiceSpeechModelId) => boolean
): VoiceSettings {
  let parsed: Record<string, unknown>
  try {
    const raw = db.getSetting(APP_SETTINGS_DB_KEY)
    // New setup: the renderer seeds the blob from the defaults, which need no migration.
    if (!raw) return sanitizeVoiceSettings(DEFAULT_VOICE_SETTINGS)
    parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return sanitizeVoiceSettings(DEFAULT_VOICE_SETTINGS)
  } catch {
    return sanitizeVoiceSettings(DEFAULT_VOICE_SETTINGS)
  }
  const current = sanitizeVoiceSettings(parsed.voice)
  const migration = migrateVoiceSpeechModelDefault(current, hasLocalFiles)
  if (!migration) return current
  try {
    db.setSetting(APP_SETTINGS_DB_KEY, JSON.stringify({ ...parsed, voice: migration.settings }))
  } catch (error) {
    // Not saved: the check simply runs again next launch, with the same outcome.
    log.warn('Could not save the voice speech-model default check', { error: String(error) })
  }
  log.info('Checked the voice speech-model default', {
    speechModel: migration.settings.speechModel,
    switched: migration.switched
  })
  return migration.settings
}
