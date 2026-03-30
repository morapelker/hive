/**
 * Read ticket-import provider settings from localStorage.
 * Provider credentials are stored in a dedicated 'hive-provider-settings' key
 * to avoid being overwritten by the Zustand useSettingsStore which persists
 * to the 'hive-settings' key with a partialize function.
 */
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
