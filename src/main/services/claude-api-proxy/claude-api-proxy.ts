/**
 * Lifecycle of the app-wide Claude API proxy.
 *
 * Started once in Electron main right after the shell environment is loaded
 * and BEFORE the backend child is spawned, so `ANTHROPIC_BASE_URL` (and the
 * first-party marker) reach every Claude Code process the app launches: PTY
 * sessions, the Agent SDK, tmux launches, plain terminals in the server child,
 * title generation. The proxy forwards to whatever the user already pointed
 * the CLI at (a corporate gateway) or to api.anthropic.com, and feeds each
 * exchange to the live usage updater. Nothing is logged to disk.
 */
import { readFileSync } from 'fs'
import tls from 'tls'
import { getDatabase } from '../../db'
import { publishDesktopBackendEvent } from '../../desktop/backend-event-publisher'
import {
  addClaudeAccount,
  isClaudeAccountManaged,
  listClaudeAccountTokenFingerprints,
  readClaudeLiveIdentityCached,
  readClaudeLiveRawBlob,
  readClaudeLiveTokenFingerprint,
  rememberClaudeAccountUuid,
  repairStaleClaudeLiveIdentityUuid
} from '../account-store-claude'
import { getUserEnvironmentVariables } from '../env-vars'
import { createLogger } from '../logger'
import {
  ANTHROPIC_BASE_URL_ENV,
  ASSUME_FIRST_PARTY_ENV,
  getClaudeApiProxyBaseUrl,
  setClaudeApiProxyBaseUrl
} from './claude-api-proxy-env'
import { ClaudeUsageLiveUpdater } from './claude-usage-live-updater'
import { startLocalApiProxy, type LocalApiProxy } from './local-api-proxy'

const log = createLogger({ component: 'ClaudeApiProxy' })

export const DEFAULT_CLAUDE_API_UPSTREAM = 'https://api.anthropic.com'
/**
 * A stable loopback port (overridable via `HIVE_CLAUDE_API_PROXY_PORT`; `0`
 * picks an ephemeral one) so Claude sessions that outlive the app — tmux
 * launches — find the proxy again after a restart. Falls back to an ephemeral
 * port when a second app instance already holds it.
 */
export const DEFAULT_CLAUDE_API_PROXY_PORT = 42411
export const CLAUDE_API_PROXY_PORT_ENV = 'HIVE_CLAUDE_API_PROXY_PORT'
export const CLAUDE_API_PROXY_DISABLE_ENV = 'HIVE_DISABLE_CLAUDE_API_PROXY'

const SETTINGS_ENV_TTL_MS = 15_000

export type ClaudeApiProxySkipReason =
  'disabled' | 'http-proxy-env' | 'client-cert' | 'unix-socket' | 'third-party-provider'

export type ClaudeApiProxyStartResult =
  | { started: true; baseUrl: string; port: number; upstream: string }
  | { started: false; reason: ClaudeApiProxySkipReason | 'bind-failed'; error?: string }

interface ProxyState {
  proxy: LocalApiProxy
  updater: ClaudeUsageLiveUpdater
  /** The user's own `ANTHROPIC_BASE_URL` (the default upstream) before the proxy took the variable over. */
  originalBaseUrl: string | null
  /** What `process.env.ANTHROPIC_BASE_URL` held before we exported ours, to restore on close. */
  previousProcessEnvBaseUrl: string | undefined
  appliedToProcessEnv: boolean
}

let state: ProxyState | null = null
let startingPromise: Promise<ClaudeApiProxyStartResult> | null = null
let settingsEnvCache: { value: Record<string, string>; expiresAt: number } | null = null

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * Environments where a plain-HTTP loopback hop would break the CLI or where
 * no subscription headers can exist: a corporate HTTP(S) proxy (Node's http
 * client does not honour those variables), mTLS to the API, a unix-socket
 * transport, or a non-Anthropic provider (which ignores the base URL).
 * Evaluated against the MERGED launch env (shell + Settings → Environment
 * Variables), since the CLI sees both.
 */
export function claudeApiProxySkipReason(
  env: NodeJS.ProcessEnv = process.env
): ClaudeApiProxySkipReason | null {
  if (isTruthy(env[CLAUDE_API_PROXY_DISABLE_ENV])) return 'disabled'
  if (
    nonEmpty(env.HTTPS_PROXY) ||
    nonEmpty(env.https_proxy) ||
    nonEmpty(env.HTTP_PROXY) ||
    nonEmpty(env.http_proxy) ||
    nonEmpty(env.ALL_PROXY) ||
    nonEmpty(env.all_proxy)
  ) {
    return 'http-proxy-env'
  }
  if (nonEmpty(env.CLAUDE_CODE_CLIENT_CERT)) return 'client-cert'
  if (nonEmpty(env.ANTHROPIC_UNIX_SOCKET)) return 'unix-socket'
  if (
    isTruthy(env.CLAUDE_CODE_USE_BEDROCK) ||
    isTruthy(env.CLAUDE_CODE_USE_VERTEX) ||
    isTruthy(env.CLAUDE_CODE_USE_FOUNDRY) ||
    isTruthy(env.CLAUDE_CODE_USE_ANTHROPIC_AWS) ||
    isTruthy(env.CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD)
  ) {
    return 'third-party-provider'
  }
  return null
}

export function parseClaudeApiProxyPort(value: string | undefined): number {
  const parsed = Number(value?.trim())
  if (value === undefined || value.trim() === '' || !Number.isInteger(parsed)) {
    return DEFAULT_CLAUDE_API_PROXY_PORT
  }
  return parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_CLAUDE_API_PROXY_PORT
}

/** Split a PEM bundle into its individual `-----BEGIN CERTIFICATE-----` blocks. */
export function splitPemCertificates(bundle: string): string[] {
  const matches = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
  return matches ? matches.map((block) => `${block.trim()}\n`) : []
}

type CertStore = 'bundled' | 'system'

/** `CLAUDE_CODE_CERT_STORE` as the CLI reads it (comma list; default `bundled,system`). */
export function parseClaudeCertStores(value: string | undefined): CertStore[] {
  const stores = (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is CertStore => entry === 'bundled' || entry === 'system')
  return stores.length > 0 ? stores : ['bundled', 'system']
}

type CaCertificateReader = (type: CertStore | 'default' | 'extra') => string[]

/**
 * The trust roots the upstream TLS leg must accept — the same set the CLI
 * itself trusts when it terminates TLS: its bundled roots, the OS trust store
 * (where corporate TLS-inspection roots are installed), and any PEM bundle
 * named by `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE`. Node only reads those
 * variables at process start, and a Dock-launched app has no shell env then,
 * so they are read here, after the shell env was loaded.
 */
export function buildUpstreamCaCertificates(
  env: NodeJS.ProcessEnv = process.env,
  readCa: CaCertificateReader | undefined = (
    tls as unknown as { getCACertificates?: CaCertificateReader }
  ).getCACertificates?.bind(tls),
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')
): { ca: string[]; sources: string[] } {
  const stores = parseClaudeCertStores(env.CLAUDE_CODE_CERT_STORE)
  const ca: string[] = []
  const sources: string[] = []
  const safeRead = (type: CertStore): string[] => {
    try {
      return readCa ? readCa(type) : type === 'bundled' ? [...tls.rootCertificates] : []
    } catch {
      return []
    }
  }
  for (const store of stores) {
    const certs = safeRead(store)
    if (certs.length > 0) {
      ca.push(...certs)
      sources.push(`${store}:${certs.length}`)
    }
  }
  for (const variable of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'] as const) {
    const file = nonEmpty(env[variable])
    if (file === null) continue
    try {
      const certs = splitPemCertificates(readFile(file))
      ca.push(...certs)
      sources.push(`${variable}:${certs.length}`)
    } catch (error) {
      log.warn(`Could not read ${variable}; continuing with the other trust roots`, {
        file,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return { ca, sources }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '::ffff:127.0.0.1'
  )
}

/** A candidate upstream is usable unless it is blank, unparsable, or this proxy itself. */
function usableUpstream(candidate: string | null, ownPort: number | null): string | null {
  if (candidate === null) return null
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (ownPort !== null && isLoopbackHost(url.hostname)) {
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    if (port === ownPort) return null
  }
  return candidate.replace(/\/+$/, '')
}

function readSettingsEnv(): Record<string, string> {
  const now = Date.now()
  if (settingsEnvCache !== null && settingsEnvCache.expiresAt > now) return settingsEnvCache.value
  let value: Record<string, string> = {}
  try {
    value = getUserEnvironmentVariables(getDatabase())
  } catch {
    value = {}
  }
  settingsEnvCache = { value, expiresAt: now + SETTINGS_ENV_TTL_MS }
  return value
}

/**
 * Where the proxy forwards to, re-evaluated per request: the user's Settings →
 * Environment Variables `ANTHROPIC_BASE_URL` (so a gateway configured in-app
 * keeps working), else the shell's original value, else the public API.
 */
export function resolveClaudeApiUpstream(
  originalBaseUrl: string | null = state?.originalBaseUrl ?? null,
  ownPort: number | null = state?.proxy.port ?? null,
  settingsEnv: Record<string, string> = readSettingsEnv()
): string {
  return (
    usableUpstream(nonEmpty(settingsEnv[ANTHROPIC_BASE_URL_ENV]), ownPort) ??
    usableUpstream(originalBaseUrl, ownPort) ??
    DEFAULT_CLAUDE_API_UPSTREAM
  )
}

function buildUpdater(): ClaudeUsageLiveUpdater {
  return new ClaudeUsageLiveUpdater({
    listManagedAccounts: (options) => listClaudeAccountTokenFingerprints(options),
    // Consulted on every update: served from a stat-keyed cache so the large
    // identity file is only re-parsed when it actually changed.
    readLiveIdentity: readClaudeLiveIdentityCached,
    readLiveTokenFingerprint: readClaudeLiveTokenFingerprint,
    isAccountManaged: isClaudeAccountManaged,
    ensureLiveAccountManaged: async (email, uuid) => {
      const rawBlob = await readClaudeLiveRawBlob()
      if (!rawBlob) return false
      await addClaudeAccount(email, uuid, rawBlob)
      return true
    },
    rememberAccountUuid: rememberClaudeAccountUuid,
    readUsageRow: (email) => getDatabase().getSavedUsageAccountByProviderEmail('anthropic', email),
    writeLiveUsage: (email, usage) => {
      const db = getDatabase()
      const row =
        db.getSavedUsageAccountByProviderEmail('anthropic', email) ??
        db.upsertSavedUsageAccount({ provider: 'anthropic', email, credentials_json: '' })
      return db.updateSavedUsageAccountLiveUsage(row.id, JSON.stringify(usage)) ?? row
    },
    publish: (channel, payload) => publishDesktopBackendEvent(channel, payload),
    log
  })
}

export interface StartClaudeApiProxyOptions {
  env?: NodeJS.ProcessEnv
  /** Default true: export the proxy env on `process.env` so child processes inherit it. */
  applyToProcessEnv?: boolean
  /** Default true: consult Settings → Environment Variables for the skip decision. */
  includeSettingsEnv?: boolean
}

export async function startClaudeApiProxy(
  options: StartClaudeApiProxyOptions = {}
): Promise<ClaudeApiProxyStartResult> {
  if (state !== null) {
    return {
      started: true,
      baseUrl: state.proxy.baseUrl,
      port: state.proxy.port,
      upstream: resolveClaudeApiUpstream()
    }
  }
  if (startingPromise !== null) return startingPromise

  const env = options.env ?? process.env
  // The CLI sees the shell env merged with the app's Settings env vars; a
  // corporate proxy configured in either place must stop us.
  const mergedEnv: NodeJS.ProcessEnv =
    options.includeSettingsEnv === false ? env : { ...env, ...readSettingsEnv() }
  const skip = claudeApiProxySkipReason(mergedEnv)
  if (skip !== null) {
    log.info('Claude API proxy not started', { reason: skip })
    return { started: false, reason: skip }
  }

  startingPromise = (async (): Promise<ClaudeApiProxyStartResult> => {
    const originalBaseUrl = nonEmpty(env[ANTHROPIC_BASE_URL_ENV])
    const updater = buildUpdater()
    const trust = buildUpstreamCaCertificates(mergedEnv)
    let proxy: LocalApiProxy
    try {
      proxy = await startLocalApiProxy({
        port: parseClaudeApiProxyPort(env[CLAUDE_API_PROXY_PORT_ENV]),
        resolveUpstream: () => resolveClaudeApiUpstream(originalBaseUrl, state?.proxy.port ?? null),
        onExchange: (exchange) => updater.handleExchange(exchange),
        upstreamTls: { ca: trust.ca },
        log
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Claude API proxy failed to start; usage stays poll-based', { error: message })
      return { started: false, reason: 'bind-failed', error: message }
    }

    const applyToProcessEnv = options.applyToProcessEnv ?? true
    state = {
      proxy,
      updater,
      originalBaseUrl,
      previousProcessEnvBaseUrl: process.env[ANTHROPIC_BASE_URL_ENV],
      appliedToProcessEnv: applyToProcessEnv
    }
    setClaudeApiProxyBaseUrl(proxy.baseUrl)
    if (applyToProcessEnv) {
      process.env[ANTHROPIC_BASE_URL_ENV] = proxy.baseUrl
      process.env[ASSUME_FIRST_PARTY_ENV] = '1'
    }

    // An older switch to an account whose uuid the index did not know left
    // the OUTGOING account's uuid in the CLI's identity file — requests would
    // be credited to the wrong account. Heal that once, in the background.
    void repairStaleClaudeLiveIdentityUuid()
      .then((repaired) => {
        if (repaired) log.info('Dropped a stale account uuid from the Claude identity file')
      })
      .catch((error) => {
        log.warn('Could not check the Claude identity file', {
          error: error instanceof Error ? error.message : String(error)
        })
      })

    const upstream = resolveClaudeApiUpstream(originalBaseUrl, proxy.port)
    log.info('Claude API proxy started', { baseUrl: proxy.baseUrl, upstream, trust: trust.sources })
    return { started: true, baseUrl: proxy.baseUrl, port: proxy.port, upstream }
  })().finally(() => {
    startingPromise = null
  })

  return startingPromise
}

export function isClaudeApiProxyRunning(): boolean {
  return state !== null
}

export { getClaudeApiProxyBaseUrl }

/** After sleep the idle pooled upstream sockets are dead; drop them before the first request pays for it. */
export function dropClaudeApiProxyUpstreamSockets(): void {
  state?.proxy.dropUpstreamSockets()
}

export async function closeClaudeApiProxy(): Promise<void> {
  const current = state
  state = null
  settingsEnvCache = null
  setClaudeApiProxyBaseUrl(null)
  if (current === null) return
  current.updater.dispose()
  if (current.appliedToProcessEnv) {
    if (current.previousProcessEnvBaseUrl !== undefined) {
      process.env[ANTHROPIC_BASE_URL_ENV] = current.previousProcessEnvBaseUrl
    } else {
      delete process.env[ANTHROPIC_BASE_URL_ENV]
    }
    delete process.env[ASSUME_FIRST_PARTY_ENV]
  }
  await current.proxy.close()
  log.info('Claude API proxy closed')
}

/** Test-only: forget cached settings so the next upstream resolution re-reads them. */
export function __resetClaudeApiProxyCachesForTests(): void {
  settingsEnvCache = null
}
