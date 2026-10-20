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
 *
 * The tunnel itself runs in its own utility process (`claude-proxy-host.ts`)
 * so that a stall in main — whose thread pool once wedged for a whole night
 * and silently hung every session's request — cannot touch the API path, and
 * so that the host can be restarted on the same port without the app. Main
 * keeps the policy and the consumers; see `claude-proxy-host-manager.ts`.
 * Without Electron (tests) or when the host bundle is missing, the tunnel
 * runs in-process as before.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
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
import { perfLog, PERF_ROLE_ENV } from '../perf-logging/perf-logger'
import {
  ANTHROPIC_BASE_URL_ENV,
  ASSUME_FIRST_PARTY_ENV,
  getClaudeApiProxyBaseUrl,
  setClaudeApiProxyBaseUrl
} from './claude-api-proxy-env'
import {
  ClaudeProxyHostManager,
  type ProxyHostChild,
  type ProxyHostFork,
  type ProxyHostStatus
} from './claude-proxy-host-manager'
import { CLAUDE_PROXY_HOST_SERVICE_NAME } from './claude-proxy-host-protocol'
import { ClaudeUsageLiveUpdater } from './claude-usage-live-updater'
import {
  startLocalApiProxy,
  type LocalApiProxy,
  type LocalApiProxyProbeResult,
  type LocalApiProxyRequestRecord
} from './local-api-proxy'

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
/** Force the tunnel to run inside main (`in-process`) instead of the utility process. */
export const CLAUDE_API_PROXY_HOST_MODE_ENV = 'HIVE_CLAUDE_API_PROXY_HOST'
/** TCP+TLS connect budget for a new upstream socket, in ms (default 15000). */
export const CLAUDE_API_PROXY_CONNECT_TIMEOUT_ENV = 'HIVE_CLAUDE_API_PROXY_CONNECT_TIMEOUT_MS'

const SETTINGS_ENV_TTL_MS = 15_000

export type ClaudeApiProxySkipReason =
  'disabled' | 'http-proxy-env' | 'client-cert' | 'unix-socket' | 'third-party-provider'

export type ClaudeApiProxyHostMode = 'utility' | 'in-process'

export type ClaudeApiProxyStartResult =
  | { started: true; baseUrl: string; port: number; upstream: string; hostMode: ClaudeApiProxyHostMode }
  | { started: false; reason: ClaudeApiProxySkipReason | 'bind-failed'; error?: string }

interface ProxyState {
  hostMode: ClaudeApiProxyHostMode
  proxy: LocalApiProxy | null
  manager: ClaudeProxyHostManager | null
  updater: ClaudeUsageLiveUpdater
  /** The user's own `ANTHROPIC_BASE_URL` (the default upstream) before the proxy took the variable over. */
  originalBaseUrl: string | null
  /** What `process.env.ANTHROPIC_BASE_URL` held before we exported ours, to restore on close. */
  previousProcessEnvBaseUrl: string | undefined
  appliedToProcessEnv: boolean
  port: number
}

let state: ProxyState | null = null
let startingPromise: Promise<ClaudeApiProxyStartResult> | null = null
let settingsEnvCache: { value: Record<string, string>; expiresAt: number } | null = null
const requestRecordListeners = new Set<(record: LocalApiProxyRequestRecord) => void>()
const hostEventListeners = new Set<(name: string, data: Record<string, unknown>) => void>()

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

export function parseClaudeApiProxyConnectTimeout(value: string | undefined): number | undefined {
  const parsed = Number(value?.trim())
  if (value === undefined || value.trim() === '' || !Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.round(parsed)
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
  ownPort: number | null = state?.port ?? null,
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

/**
 * The host bundle sits next to the main bundle (electron-vite entry
 * `claude-proxy-host`). Inside a packaged app it is read from the asar, or
 * from the unpacked copy when one exists.
 */
export function resolveClaudeProxyHostScriptPath(): string {
  const plain = join(__dirname, 'claude-proxy-host.js')
  if (__dirname.includes('app.asar')) {
    const unpacked = join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'claude-proxy-host.js')
    if (existsSync(unpacked)) return unpacked
  }
  return plain
}

/**
 * Electron's `utilityProcess.fork`, resolved lazily: the module is absent or
 * stubbed under vitest, and `require` keeps this file importable there.
 */
function resolveElectronFork(): ProxyHostFork | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      utilityProcess?: {
        fork: (
          modulePath: string,
          args?: string[],
          options?: Record<string, unknown>
        ) => ProxyHostChild
      }
    }
    const utilityProcess = electron.utilityProcess
    if (!utilityProcess || typeof utilityProcess.fork !== 'function') return null
    return (scriptPath) =>
      utilityProcess.fork(scriptPath, [], {
        serviceName: CLAUDE_PROXY_HOST_SERVICE_NAME,
        stdio: 'pipe',
        env: { ...process.env, [PERF_ROLE_ENV]: 'claude-proxy' }
      })
  } catch {
    return null
  }
}

export interface StartClaudeApiProxyOptions {
  env?: NodeJS.ProcessEnv
  /** Default true: export the proxy env on `process.env` so child processes inherit it. */
  applyToProcessEnv?: boolean
  /** Default true: consult Settings → Environment Variables for the skip decision. */
  includeSettingsEnv?: boolean
  /** Where the tunnel runs. Default: the utility process when Electron and the host bundle are available. */
  hostMode?: ClaudeApiProxyHostMode
  /** Test seam: how the host process is forked. */
  fork?: ProxyHostFork
  /** Test seam: where the host bundle is. */
  hostScriptPath?: string
  /** Whether perf logging is currently on (forwarded to the host at start). */
  perfEnabled?: () => boolean
}

function chooseHostMode(options: StartClaudeApiProxyOptions, env: NodeJS.ProcessEnv): {
  mode: ClaudeApiProxyHostMode
  fork: ProxyHostFork | null
  scriptPath: string
  why: string
} {
  const scriptPath = options.hostScriptPath ?? resolveClaudeProxyHostScriptPath()
  const forced = options.hostMode ?? (env[CLAUDE_API_PROXY_HOST_MODE_ENV] === 'in-process' ? 'in-process' : undefined)
  if (forced === 'in-process') return { mode: 'in-process', fork: null, scriptPath, why: 'forced' }
  const fork = options.fork ?? resolveElectronFork()
  if (!fork) return { mode: 'in-process', fork: null, scriptPath, why: 'no utilityProcess (not Electron main)' }
  if (!options.fork && !existsSync(scriptPath)) {
    return { mode: 'in-process', fork: null, scriptPath, why: 'host bundle missing' }
  }
  return { mode: 'utility', fork, scriptPath, why: 'utility process available' }
}

function applyBaseUrl(baseUrl: string, applyToProcessEnv: boolean): void {
  setClaudeApiProxyBaseUrl(baseUrl)
  if (applyToProcessEnv) {
    process.env[ANTHROPIC_BASE_URL_ENV] = baseUrl
    process.env[ASSUME_FIRST_PARTY_ENV] = '1'
  }
}

function emitHostEvent(name: string, data: Record<string, unknown>): void {
  perfLog.mark(name, data)
  for (const listener of hostEventListeners) {
    try {
      listener(name, data)
    } catch {
      // listeners are best effort
    }
  }
}

function emitRequestRecord(record: LocalApiProxyRequestRecord): void {
  for (const listener of requestRecordListeners) {
    try {
      listener(record)
    } catch (error) {
      log.warn('Request record listener threw', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

export async function startClaudeApiProxy(
  options: StartClaudeApiProxyOptions = {}
): Promise<ClaudeApiProxyStartResult> {
  if (state !== null) {
    return {
      started: true,
      baseUrl: getClaudeApiProxyBaseUrl() ?? '',
      port: state.port,
      upstream: resolveClaudeApiUpstream(),
      hostMode: state.hostMode
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
    const preferredPort = parseClaudeApiProxyPort(env[CLAUDE_API_PROXY_PORT_ENV])
    const connectTimeoutMs = parseClaudeApiProxyConnectTimeout(env[CLAUDE_API_PROXY_CONNECT_TIMEOUT_ENV])
    const applyToProcessEnv = options.applyToProcessEnv ?? true
    const perfEnabled = options.perfEnabled ?? (() => perfLog.isEnabled())
    const choice = chooseHostMode(options, env)
    log.info('Claude API proxy host mode', { mode: choice.mode, why: choice.why })

    let port = 0
    let baseUrl = ''
    let proxy: LocalApiProxy | null = null
    let manager: ClaudeProxyHostManager | null = null
    const resolveUpstream = (): string => resolveClaudeApiUpstream(originalBaseUrl, state?.port ?? (port || null))

    if (choice.mode === 'utility' && choice.fork) {
      manager = new ClaudeProxyHostManager({
        scriptPath: choice.scriptPath,
        fork: choice.fork,
        port: preferredPort,
        host: '127.0.0.1',
        resolveUpstream,
        ca: trust.ca,
        connectTimeoutMs,
        perfEnabled,
        onExchange: (exchange) => updater.handleExchange(exchange),
        onRequestRecord: emitRequestRecord,
        onEvent: emitHostEvent,
        onListening: (info) => {
          if (!info.restarted) return
          // A restarted host that lost the port: new spawns must get the new one.
          if (state && info.baseUrl !== getClaudeApiProxyBaseUrl()) {
            state.port = info.port
            applyBaseUrl(info.baseUrl, state.appliedToProcessEnv)
          }
        },
        log
      })
      try {
        const info = await manager.start()
        port = info.port
        baseUrl = info.baseUrl
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('Claude API proxy host failed to start; running the tunnel in-process instead', {
          error: message
        })
        await manager.stop().catch(() => undefined)
        manager = null
      }
    }

    if (manager === null) {
      try {
        proxy = await startLocalApiProxy({
          port: preferredPort,
          resolveUpstream,
          onExchange: (exchange) => updater.handleExchange(exchange),
          onRequestRecord: emitRequestRecord,
          upstreamTls: { ca: trust.ca },
          connectTimeoutMs,
          log
        })
        port = proxy.port
        baseUrl = proxy.baseUrl
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('Claude API proxy failed to start; usage stays poll-based', { error: message })
        return { started: false, reason: 'bind-failed', error: message }
      }
    }

    state = {
      hostMode: manager ? 'utility' : 'in-process',
      proxy,
      manager,
      updater,
      originalBaseUrl,
      previousProcessEnvBaseUrl: process.env[ANTHROPIC_BASE_URL_ENV],
      appliedToProcessEnv: applyToProcessEnv,
      port
    }
    applyBaseUrl(baseUrl, applyToProcessEnv)

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

    const upstream = resolveClaudeApiUpstream(originalBaseUrl, port)
    log.info('Claude API proxy started', {
      baseUrl,
      upstream,
      hostMode: state.hostMode,
      connectTimeoutMs: connectTimeoutMs ?? null,
      trust: trust.sources
    })
    return { started: true, baseUrl, port, upstream, hostMode: state.hostMode }
  })().finally(() => {
    startingPromise = null
  })

  return startingPromise
}

export function isClaudeApiProxyRunning(): boolean {
  return state !== null
}

export { getClaudeApiProxyBaseUrl }

export function getClaudeApiProxyHostMode(): ClaudeApiProxyHostMode | null {
  return state?.hostMode ?? null
}

/** Host process status for diagnostics (null when the tunnel runs in-process or is off). */
export function getClaudeApiProxyHostStatus(): ProxyHostStatus | null {
  return state?.manager?.status() ?? null
}

/** After sleep the idle pooled upstream sockets are dead; drop them before the first request pays for it. */
export function dropClaudeApiProxyUpstreamSockets(): void {
  state?.proxy?.dropUpstreamSockets()
  state?.manager?.dropIdleSockets()
}

/** The perf-logging switch, forwarded to the host (the in-process tunnel reads it directly). */
export function setClaudeApiProxyPerfLogging(enabled: boolean): void {
  state?.manager?.setPerfEnabled(enabled)
}

/** Ask the host to write a handle dump next to the perf logs. */
export function dumpClaudeApiProxyHostHandles(reason: string): void {
  state?.manager?.dumpHandles(reason)
}

/** Settings → Environment Variables changed: let the host pick up a new upstream now. */
export function refreshClaudeApiProxyUpstream(): void {
  settingsEnvCache = null
  state?.manager?.refreshUpstream()
}

/**
 * Can the API be reached through the proxy right now? Used by the session
 * recovery service before it re-prompts a session that died of a hang.
 */
export async function probeClaudeApiUpstream(timeoutMs = 10_000): Promise<LocalApiProxyProbeResult> {
  if (state?.manager) return state.manager.probeUpstream(timeoutMs)
  if (state?.proxy) return state.proxy.probeUpstream(timeoutMs)
  return { ok: false, status: null, ms: 0, error: 'proxy not running' }
}

/** Every request that did not complete normally (aborts, upstream failures, error statuses). */
export function onClaudeApiProxyRequestRecord(
  listener: (record: LocalApiProxyRequestRecord) => void
): () => void {
  requestRecordListeners.add(listener)
  return () => requestRecordListeners.delete(listener)
}

/** Host lifecycle events (`proxy-host-start`, `proxy-host-restart`, `proxy-host-stall`, …). */
export function onClaudeApiProxyHostEvent(
  listener: (name: string, data: Record<string, unknown>) => void
): () => void {
  hostEventListeners.add(listener)
  return () => hostEventListeners.delete(listener)
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
  if (current.manager) await current.manager.stop()
  if (current.proxy) await current.proxy.close()
  log.info('Claude API proxy closed')
}

/** Test-only: forget cached settings so the next upstream resolution re-reads them. */
export function __resetClaudeApiProxyCachesForTests(): void {
  settingsEnvCache = null
}
