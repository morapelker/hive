/**
 * Which usage transport one interactive Claude CLI launch gets.
 *
 * Live usage normally comes from the app's local API proxy, but the CLI only
 * offers Code Mode when it talks to the Anthropic API directly. So a launch
 * that asks for Code Mode leaves the proxy and reports usage through the CLI's
 * debug log instead — unless Code Mode could not work anyway, in which case
 * nothing is gained by switching and the launch stays exactly as it is today.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  ANTHROPIC_BASE_URL_ENV,
  getClaudeApiProxyBaseUrl,
  getClaudeApiProxyUserBaseUrl,
  isTruthyEnvValue,
  THIRD_PARTY_PROVIDER_ENVS
} from './claude-api-proxy/claude-api-proxy-env'
import { resolveClaudeConfigDir } from './claude-skills'
import { getUserEnvironmentVariables } from './env-vars'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeUsageTransport' })

/**
 * - `proxy`: the launch goes through the local API proxy, as every launch did
 *   before Code Mode support.
 * - `debug-log`: the launch talks to the API directly and usage is read from
 *   the CLI's debug log.
 * - `none`: the launch talks to the API directly and has no live usage source.
 */
export type ClaudeUsageTransport = 'proxy' | 'debug-log' | 'none'

export const CODE_MODE_ENV = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE'
/** The only host the CLI accepts as "the Anthropic API" when it checks for Code Mode. */
export const ANTHROPIC_API_HOST = 'api.anthropic.com'
const CLAUDE_SETTINGS_FILE = 'settings.json'

/** Where a launch variable can come from, highest precedence first. */
export type ClaudeLaunchEnvSource = 'settings' | 'app-environment' | 'claude-settings'

/** Why Code Mode cannot work for a launch, whatever the user asked for. */
export type CodeModeExclusion = 'custom-provider' | 'own-api-address' | 'third-party-provider'

type EnvVars = Record<string, string | undefined>

export interface ClaudeUsageTransportInput {
  /** Whether live usage for Code Mode sessions is switched on. */
  featureEnabled: boolean
  /** The session's custom provider command, when it launches through one. */
  customProviderCommand?: string | null
  /** Settings → Environment Variables. */
  settingsEnv: EnvVars
  /** The app's own environment, which already holds the login shell's variables. */
  appEnv: EnvVars
  /** The `env` block of the user-level Claude settings file; null or empty when there is none. */
  claudeSettingsEnv?: EnvVars | null
  /**
   * The local API proxy's address while it runs. The proxy exports it as
   * `ANTHROPIC_BASE_URL` on the app's environment, so that value there is the
   * app's and not the user's.
   */
  appProxyBaseUrl?: string | null
  /** The user's own `ANTHROPIC_BASE_URL` that the proxy replaced on the app's environment. */
  userBaseUrl?: string | null
}

export interface ClaudeUsageTransportDecision {
  transport: ClaudeUsageTransport
  /** The source that requested Code Mode; null when it is not requested. */
  codeModeSource: ClaudeLaunchEnvSource | null
  /** Set when Code Mode cannot work for this launch; the transport is then `proxy`. */
  exclusion: CodeModeExclusion | null
}

function sources(
  input: ClaudeUsageTransportInput
): Array<[ClaudeLaunchEnvSource, EnvVars | null | undefined]> {
  return [
    ['settings', input.settingsEnv],
    ['app-environment', input.appEnv],
    ['claude-settings', input.claudeSettingsEnv]
  ]
}

/**
 * The first source that defines the variable decides, even with a value that
 * turns it off: Settings saying `0` beats a shell saying `1`, as it does in
 * the environment the launch really gets.
 */
function lookup(
  input: ClaudeUsageTransportInput,
  name: string
): { source: ClaudeLaunchEnvSource; value: string } | null {
  for (const [source, env] of sources(input)) {
    const value = env?.[name]
    if (typeof value === 'string') return { source, value }
  }
  return null
}

function codeModeSource(input: ClaudeUsageTransportInput): ClaudeLaunchEnvSource | null {
  const found = lookup(input, CODE_MODE_ENV)
  return found !== null && found.value.trim() === '1' ? found.source : null
}

/** The user's own API address for this launch, by the same precedence; null when they set none. */
function userApiAddress(input: ClaudeUsageTransportInput): string | null {
  const proxyBaseUrl = input.appProxyBaseUrl ?? null
  for (const [source, env] of sources(input)) {
    let value = env?.[ANTHROPIC_BASE_URL_ENV]
    if (source === 'app-environment' && proxyBaseUrl !== null && value === proxyBaseUrl) {
      value = input.userBaseUrl ?? undefined
    }
    if (typeof value === 'string') return value.trim() || null
  }
  return null
}

function isAnthropicApiAddress(address: string): boolean {
  try {
    return new URL(address).hostname.toLowerCase() === ANTHROPIC_API_HOST
  } catch {
    return false
  }
}

function codeModeExclusion(input: ClaudeUsageTransportInput): CodeModeExclusion | null {
  if (input.customProviderCommand?.trim()) return 'custom-provider'
  const address = userApiAddress(input)
  if (address !== null && !isAnthropicApiAddress(address)) return 'own-api-address'
  if (THIRD_PARTY_PROVIDER_ENVS.some((name) => isTruthyEnvValue(lookup(input, name)?.value))) {
    return 'third-party-provider'
  }
  return null
}

/** The decision itself: no I/O, every fact it depends on is in `input`. */
export function decideClaudeUsageTransport(
  input: ClaudeUsageTransportInput
): ClaudeUsageTransportDecision {
  const requestedBy = codeModeSource(input)
  const exclusion = codeModeExclusion(input)
  let transport: ClaudeUsageTransport = 'proxy'
  if (requestedBy !== null && exclusion === null) {
    transport = input.featureEnabled ? 'debug-log' : 'none'
  }
  return { transport, codeModeSource: requestedBy, exclusion }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

/**
 * The `env` block of the user-level Claude settings file in `configDir`. A
 * missing, unreadable or malformed file sets nothing: it never throws.
 */
export async function readClaudeSettingsEnv(configDir: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  try {
    const raw = await readFile(join(configDir, CLAUDE_SETTINGS_FILE), 'utf-8')
    const parsed: unknown = JSON.parse(stripBom(raw))
    if (!isPlainObject(parsed) || !isPlainObject(parsed.env)) return env
    for (const [name, value] of Object.entries(parsed.env)) {
      if (typeof value === 'string') env[name] = value
      else if (typeof value === 'number' || typeof value === 'boolean') env[name] = String(value)
    }
  } catch {
    // Not requested from this source.
  }
  return env
}

export interface ResolveClaudeUsageTransportOptions {
  /** Reads Settings → Environment Variables. */
  db: { getSetting(key: string): string | null } | null
  /** Whether live usage for Code Mode sessions is switched on. */
  featureEnabled: boolean
  /** The session's custom provider command, when it launches through one. */
  customProviderCommand?: string | null
  /** The app's own environment; `process.env` unless a test says otherwise. */
  env?: NodeJS.ProcessEnv
}

/**
 * Gather what the decision needs for one interactive CLI launch and decide.
 * Never throws: a source that cannot be read simply does not request Code Mode.
 */
export async function resolveClaudeUsageTransport(
  options: ResolveClaudeUsageTransportOptions
): Promise<ClaudeUsageTransport> {
  const appEnv = options.env ?? process.env
  const settingsEnv = getUserEnvironmentVariables(options.db)
  // The CLI reads its settings from the config dir of the environment it is
  // launched with: the app's, with Settings → Environment Variables on top.
  const configDir = resolveClaudeConfigDir({
    CLAUDE_CONFIG_DIR: settingsEnv.CLAUDE_CONFIG_DIR ?? appEnv.CLAUDE_CONFIG_DIR
  })
  const decision = decideClaudeUsageTransport({
    featureEnabled: options.featureEnabled,
    customProviderCommand: options.customProviderCommand,
    settingsEnv,
    appEnv,
    claudeSettingsEnv: await readClaudeSettingsEnv(configDir),
    appProxyBaseUrl: getClaudeApiProxyBaseUrl(),
    userBaseUrl: getClaudeApiProxyUserBaseUrl()
  })
  if (decision.codeModeSource !== null) {
    log.info('Usage transport for a Code Mode launch', { ...decision })
  }
  return decision.transport
}
