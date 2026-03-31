/**
 * Read ticket-import provider settings from localStorage.
 * Provider credentials are stored in a dedicated 'hive-provider-settings' key
 * to avoid being overwritten by the Zustand useSettingsStore which persists
 * to the 'hive-settings' key with a partialize function.
 */

const PROVIDER_SETTINGS_KEY = 'provider_settings'

export function getProviderSettings(): Record<string, string> {
  try {
    const raw = localStorage.getItem('hive-provider-settings')
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, string>
      return { ...parsed }
    }
  } catch {
    // ignore parse errors
  }
  return {}
}

export async function saveProviderSettingsToDatabase(settings: Record<string, string>): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(PROVIDER_SETTINGS_KEY, JSON.stringify(settings))
    }
  } catch (error) {
    console.error('Failed to save provider settings to database:', error)
  }
}

export async function loadProviderSettingsFromDatabase(): Promise<Record<string, string> | null> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      const value = await window.db.setting.get(PROVIDER_SETTINGS_KEY)
      if (value) {
        return JSON.parse(value) as Record<string, string>
      }
    }
  } catch (error) {
    console.error('Failed to load provider settings from database:', error)
  }
  return null
}

