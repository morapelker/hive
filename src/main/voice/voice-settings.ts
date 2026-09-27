import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import {
  DEFAULT_VOICE_SETTINGS,
  sanitizeVoiceSettings,
  type VoiceSettings
} from '@shared/types/voice'

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
