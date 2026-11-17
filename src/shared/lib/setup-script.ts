// The setup script a project actually runs, given the app-wide default
// (`AppSettings.defaultSetupScript`, in the `app_settings` blob).
//
// `projects.setup_script` is three-valued:
//   - null         never set for this project: the default applies
//   - '' (blank)   deliberately cleared: nothing runs, the default does NOT come back
//   - anything else the project's own script

/** True when the project has no setup script of its own and follows the default. */
export function inheritsDefaultSetupScript(projectScript: string | null | undefined): boolean {
  return projectScript === null || projectScript === undefined
}

/** The script to run for a project, or null when there is nothing to run. */
export function resolveSetupScript(
  projectScript: string | null | undefined,
  defaultScript: string | null | undefined
): string | null {
  const script = inheritsDefaultSetupScript(projectScript) ? defaultScript : projectScript
  return script && script.trim() ? script : null
}

/** The default setup script out of the raw `app_settings` JSON blob (main / server side). */
export function readDefaultSetupScript(appSettingsJson: string | null | undefined): string | null {
  if (!appSettingsJson) return null
  try {
    const settings: unknown = JSON.parse(appSettingsJson)
    if (!settings || typeof settings !== 'object') return null
    const value = (settings as Record<string, unknown>).defaultSetupScript
    return typeof value === 'string' && value.trim() ? value : null
  } catch {
    return null
  }
}
