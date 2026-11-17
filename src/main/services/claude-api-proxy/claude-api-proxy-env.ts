/**
 * The environment every Claude Code process must carry to talk through the
 * local API proxy. Kept dependency-free so spawn builders can import it
 * without pulling the proxy, the DB, or the account store into their graph.
 *
 * `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` tells the CLI that the custom
 * base URL still fronts the first-party API, so it keeps the first-party
 * behaviours a "gateway" would otherwise lose (policy lookups, tool search,
 * transcript counting) — the proxy forwards to api.anthropic.com unchanged.
 */
export const ANTHROPIC_BASE_URL_ENV = 'ANTHROPIC_BASE_URL'
export const ASSUME_FIRST_PARTY_ENV = '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL'

let activeBaseUrl: string | null = null

export function setClaudeApiProxyBaseUrl(baseUrl: string | null): void {
  activeBaseUrl = baseUrl
}

export function getClaudeApiProxyBaseUrl(): string | null {
  return activeBaseUrl
}

let userBaseUrl: string | null = null

export function setClaudeApiProxyUserBaseUrl(baseUrl: string | null): void {
  userBaseUrl = baseUrl
}

/**
 * The user's own `ANTHROPIC_BASE_URL` that the running proxy took over (it
 * exports its loopback address on `process.env` and chains to this one as its
 * upstream). Null when the user had none or the proxy is not running — in
 * which case `process.env` still holds whatever the user set.
 */
export function getClaudeApiProxyUserBaseUrl(): string | null {
  return userBaseUrl
}

/**
 * Env overrides for a Claude Code spawn. Spread these LAST so they win over
 * the user's own `ANTHROPIC_BASE_URL` (which the proxy chains to as its
 * upstream instead). Empty when the proxy is not running, so every launch
 * path degrades to the plain CLI behaviour.
 */
export function getClaudeApiProxyEnv(): Record<string, string> {
  if (activeBaseUrl === null) return {}
  return { [ANTHROPIC_BASE_URL_ENV]: activeBaseUrl, [ASSUME_FIRST_PARTY_ENV]: '1' }
}

/** The variables that switch the CLI to a non-Anthropic provider, which ignores the base URL. */
export const THIRD_PARTY_PROVIDER_ENVS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD'
] as const

export function isTruthyEnvValue(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}
