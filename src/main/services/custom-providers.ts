import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import type { CustomClaudeProvider } from '@shared/types/custom-provider'
import { findCustomProvider, sanitizeCustomProviders } from '@shared/types/custom-provider'
import type { DatabaseService } from '../db/database'

/**
 * Custom claude-cli provider definitions live in the app-settings JSON blob
 * (written by the renderer settings store). The main process reads them
 * DB-side at spawn time, same as getUserEnvironmentVariables.
 */
export function getCustomProviders(db: DatabaseService | null): CustomClaudeProvider[] {
  if (!db) return []
  try {
    const raw = db.getSetting(APP_SETTINGS_DB_KEY)
    if (!raw) return []
    const settings = JSON.parse(raw)
    return sanitizeCustomProviders(settings.customProviders)
  } catch {
    return []
  }
}

export function getCustomProviderById(
  db: DatabaseService | null,
  id: string | null | undefined
): CustomClaudeProvider | undefined {
  return findCustomProvider(getCustomProviders(db), id)
}
