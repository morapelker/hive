/**
 * Read ticket-import provider settings from the persisted Zustand store.
 * This reads from localStorage directly because the settings are stored
 * in the hive-settings Zustand persist key.
 */
export function getProviderSettings(): Record<string, string> {
  try {
    const raw = localStorage.getItem('hive-settings')
    if (raw) {
      const parsed = JSON.parse(raw)
      const settings: Record<string, string> = {}
      if (parsed?.state?.github_pat) {
        settings.github_pat = parsed.state.github_pat
      }
      return settings
    }
  } catch {
    // ignore parse errors
  }
  return {}
}
