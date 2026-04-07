import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import type { DatabaseService } from '../db/database'

export function getUserEnvironmentVariables(db: DatabaseService | null): Record<string, string> {
  if (!db) return {}
  try {
    const raw = db.getSetting(APP_SETTINGS_DB_KEY)
    if (!raw) return {}
    const settings = JSON.parse(raw)
    const envVars: Array<{ key: string; value: string }> = settings.environmentVariables ?? []
    const result: Record<string, string> = {}
    for (const { key, value } of envVars) {
      if (key) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}
