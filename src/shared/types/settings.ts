/** DB key for the single JSON blob of app settings (useSettingsStore, openPathWithPreferredEditor, etc.). */
export const APP_SETTINGS_DB_KEY = 'app_settings'

export const DEFAULT_HIVE_ENTERPRISE_SERVER_URL = 'https://hive.tedooo.com'

export interface Setting {
  key: string
  value: string
}

export interface TeleportSettings {
  url: string
  bootstrapToken: string
}

/**
 * Automated Claude sign-in: instead of handing the OAuth page to the user's
 * browser, the app drives a fresh Chrome profile through claude.ai's email +
 * code form, fetching the code from a server that watches the mailbox
 * (claude-code-extractor's `GET /api/codes/wait`).
 */
export interface AutoSignInSettings {
  enabled: boolean
  /** Base URL of the code server, no trailing slash (e.g. `http://claudit-dashboard:3000`). */
  codeServerUrl: string
  /** Optional bearer token the code server requires (`CODES_API_TOKEN`); empty = none. */
  apiToken: string
  /** How long to wait for the code to land in the mailbox before giving up. */
  codeTimeoutSeconds: number
}

export const AUTO_SIGN_IN_CODE_TIMEOUT_MIN_SECONDS = 15
export const AUTO_SIGN_IN_CODE_TIMEOUT_MAX_SECONDS = 300

export const DEFAULT_AUTO_SIGN_IN_SETTINGS: AutoSignInSettings = {
  enabled: false,
  codeServerUrl: '',
  apiToken: '',
  // Gmail delivery plus the extractor's headless Cloudflare pass routinely take
  // 30-60 s; a minute is tight, so leave headroom by default.
  codeTimeoutSeconds: 90
}

/** Trim and drop trailing slashes so `${url}/api/...` composes cleanly. */
export function normalizeAutoSignInUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** Only http(s) URLs with a host are usable as a code server. */
export function isValidAutoSignInUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

/** Validate every field so pre-feature or hand-edited settings blobs get defaults. */
export function sanitizeAutoSignInSettings(value: unknown): AutoSignInSettings {
  const defaults = DEFAULT_AUTO_SIGN_IN_SETTINGS
  if (!value || typeof value !== 'object') return { ...defaults }
  const record = value as Record<string, unknown>
  const codeServerUrl =
    typeof record.codeServerUrl === 'string' ? normalizeAutoSignInUrl(record.codeServerUrl) : ''
  const timeout =
    typeof record.codeTimeoutSeconds === 'number' && Number.isFinite(record.codeTimeoutSeconds)
      ? Math.min(
          AUTO_SIGN_IN_CODE_TIMEOUT_MAX_SECONDS,
          Math.max(AUTO_SIGN_IN_CODE_TIMEOUT_MIN_SECONDS, Math.round(record.codeTimeoutSeconds))
        )
      : defaults.codeTimeoutSeconds
  return {
    // The switch is meaningless without a usable server URL.
    enabled: record.enabled === true && isValidAutoSignInUrl(codeServerUrl),
    codeServerUrl,
    apiToken: typeof record.apiToken === 'string' ? record.apiToken.trim() : '',
    codeTimeoutSeconds: timeout
  }
}

/** Whether a login may be automated with these settings. */
export function isAutoSignInUsable(settings: AutoSignInSettings): boolean {
  return settings.enabled && isValidAutoSignInUrl(settings.codeServerUrl)
}

export interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}
