/**
 * Reads the automated-sign-in settings the renderer persists in the single
 * `app_settings` JSON blob, from the server child (login-service runs there),
 * mirroring voice-settings.ts. Sanitized on every read so a hand-edited or
 * pre-feature blob yields the defaults (automation off).
 */
import {
  APP_SETTINGS_DB_KEY,
  sanitizeAutoSignInSettings,
  type AutoSignInSettings
} from '@shared/types/settings'
import { getDatabase } from '../db'

export function parseAutoSignInSettings(raw: string | null | undefined): AutoSignInSettings {
  if (!raw) return sanitizeAutoSignInSettings(null)
  try {
    const parsed = JSON.parse(raw) as { autoSignIn?: unknown }
    return sanitizeAutoSignInSettings(parsed?.autoSignIn)
  } catch {
    return sanitizeAutoSignInSettings(null)
  }
}

export function readAutoSignInSettings(): AutoSignInSettings {
  try {
    return parseAutoSignInSettings(getDatabase().getSetting(APP_SETTINGS_DB_KEY))
  } catch {
    return sanitizeAutoSignInSettings(null)
  }
}
