/**
 * The one place the main process asks "is live usage for Code Mode sessions
 * enabled right now" (CODE_MODE_PRD.html FR-5; CODE_MODE_TASKS.html T09).
 *
 * Two inputs, the kill switch first:
 *
 * - `HIVE_DISABLE_CLAUDE_DEBUG_USAGE=1` in the environment turns the
 *   feature off whatever the setting says. It is read like its sibling
 *   `HIVE_DISABLE_CLAUDE_API_PROXY`: unset, empty, `0`, `false` and `no`
 *   leave the feature alone, anything else disables it.
 * - Settings › Advanced › "Live usage in Code Mode sessions"
 *   (`claudeCodeModeLiveUsage` in the `app_settings` blob the renderer saves),
 *   on by default: only a stored `false` turns it off, so a fresh install, a
 *   blob from before the setting and an unreadable blob all report enabled,
 *   which is also what the switch shows in those cases.
 *
 * Nothing is cached: the database read is one synchronous lookup, and a caller
 * deciding the transport of a new session must see a switch flipped a moment
 * ago.
 */
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import { getDatabase } from '../../db'

export const CLAUDE_DEBUG_USAGE_DISABLE_ENV = 'HIVE_DISABLE_CLAUDE_DEBUG_USAGE'

/** The key of the Advanced switch in the `app_settings` blob (AppSettings in useSettingsStore.ts). */
export const CLAUDE_DEBUG_USAGE_SETTING_KEY = 'claudeCodeModeLiveUsage'

/** Whether the environment kill switch is set. */
export function isClaudeDebugUsageKillSwitchSet(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CLAUDE_DEBUG_USAGE_DISABLE_ENV]
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

/** The Advanced switch as stored in the raw `app_settings` blob: on unless it was saved as `false`. */
export function parseClaudeDebugUsageSetting(raw: string | null | undefined): boolean {
  if (!raw) return true
  try {
    const settings = JSON.parse(raw) as Record<string, unknown> | null
    return settings?.[CLAUDE_DEBUG_USAGE_SETTING_KEY] !== false
  } catch {
    return true
  }
}

/** The Advanced switch as stored right now, without the kill switch. */
export function readClaudeDebugUsageSetting(): boolean {
  try {
    return parseClaudeDebugUsageSetting(getDatabase().getSetting(APP_SETTINGS_DB_KEY))
  } catch {
    return true
  }
}

/** Is live usage for Code Mode sessions enabled right now: the switch is on and the kill switch is not set. */
export function isClaudeDebugUsageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isClaudeDebugUsageKillSwitchSet(env)) return false
  return readClaudeDebugUsageSetting()
}
