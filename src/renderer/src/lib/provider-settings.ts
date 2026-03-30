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
      if (parsed?.state?.jira_domain) settings.jira_domain = parsed.state.jira_domain
      if (parsed?.state?.jira_email) settings.jira_email = parsed.state.jira_email
      if (parsed?.state?.jira_api_token) settings.jira_api_token = parsed.state.jira_api_token
      return settings
    }
  } catch {
    // ignore parse errors
  }
  return {}
}
