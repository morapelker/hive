/**
 * Interactive OAuth login in the user's own browser: opens the provider's
 * authorize URL in the user's regular Google Chrome (a new tab in the running
 * instance, via `open -a "Google Chrome"`), captures the resulting
 * `code`/`state` on a loopback HTTP callback server, exchanges it for tokens,
 * and stores the account. This is the same shape as Claude Code's and Codex
 * CLI's own sign-in flows — no automation-driven Chrome, no per-account
 * profile directories, no email autofill: the user signs in with whatever
 * account they like in their everyday browser.
 *
 * Runs in-process (in the spawned server process) rather than as a sidecar.
 *
 * Callback ports:
 *   - Anthropic accepts a loopback `http://localhost:<port>/callback`
 *     redirect. We prefer Claude Code's port (54545) and fall back to an
 *     OS-assigned one if it's busy.
 *   - OpenAI's redirect is pinned to `http://localhost:1455/auth/callback`
 *     (Codex CLI's port); if that port is busy the login fails with a clear
 *     message rather than silently redirecting somewhere we can't hear.
 *
 * State machine (module-scope, one login at a time):
 *   launching -> waiting -> exchanging -> done
 *                        \-> failed
 *   (any non-terminal state) -> cancelled
 *
 * Unlike the old automation-driven flow, closing the browser tab is
 * invisible to us — the user cancels from the app (or the 30-minute timeout
 * fires).
 *
 * Terminal sessions (`done`/`failed`/`cancelled`) are retained until the next
 * `loginStart` (which replaces `currentSession`) or 5 minutes, whichever comes
 * first, so a renderer's final status poll always lands.
 */
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { getDatabase } from '../db'
import { addClaudeAccount } from './account-store-claude'
import { addCodexAccount } from './account-store-codex'
import { createLogger } from './logger'
import { buildAnthropicAuthorizeUrl, exchangeAnthropicCode } from './oauth-anthropic'
import { buildOpenAIAuthorizeUrl, exchangeOpenAICode } from './oauth-openai'
import { generatePkce, type Pkce } from './oauth-pkce'
import { fetchForSavedAccount, listSavedAccounts } from './saved-usage-orchestrator'
import type { LoginState, LoginStatusDTO, UsageProvider } from '@shared/types/usage'
import type { SavedUsageProvider } from '../db/types'

const log = createLogger({ component: 'LoginService' })

const GC_DELAY_MS = 5 * 60 * 1000
const LOGIN_TIMEOUT_MS = 30 * 60 * 1000
/** Grace period for in-flight callback responses to flush before their sockets are destroyed. */
const CLOSE_DELAY_MS = 1500
const OPEN_TIMEOUT_MS = 15_000
/** The callback server only ever listens on the loopback interface. */
const LOOPBACK_HOST = '127.0.0.1'

// ─── Browser opener ──────────────────────────────────────────────────────

export type LoginUrlOpener = (url: string) => Promise<void>

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: OPEN_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (!error) {
        resolve()
        return
      }
      const detail = typeof stderr === 'string' && stderr.trim().length > 0 ? stderr.trim() : error.message
      reject(new Error(detail))
    })
  })
}

function isChromeMissingError(message: string): boolean {
  return /unable to find application/i.test(message) || /can't be opened/i.test(message)
}

/**
 * `open -a "Google Chrome" <url>` hands the URL to the running Chrome (new tab
 * in the frontmost window) or launches Chrome if it isn't running — either
 * way it's the user's own profile. Falls back to the default browser when
 * Chrome isn't installed: the loopback callback works from any browser.
 */
async function defaultLoginUrlOpener(url: string): Promise<void> {
  try {
    await execFileAsync('open', ['-a', 'Google Chrome', url])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!isChromeMissingError(message)) throw error
    log.warn('Google Chrome not found — opening sign-in in the default browser', { error: message })
    await execFileAsync('open', [url])
  }
}

let openLoginUrl: LoginUrlOpener = defaultLoginUrlOpener

/** Test-only seam: inject a fake URL opener, or pass `null` to restore the real one. */
export function setLoginUrlOpenerForTests(opener: LoginUrlOpener | null): void {
  openLoginUrl = opener ?? defaultLoginUrlOpener
}

// ─── Provider config ──────────────────────────────────────────────────────

interface ProviderConfig {
  /** Path of the loopback redirect URI (everything after the port). */
  callbackPath: string
  /** Port we try first. */
  preferredPort: number
  /** Whether a busy preferred port may fall back to an OS-assigned one. */
  allowEphemeralPort: boolean
  /** Shown when the preferred port is busy and no fallback is allowed. */
  portBusyMessage: string
  buildAuthorizeUrl: (pkce: Pkce, redirectUri: string) => string
}

const PROVIDER_CONFIG: Record<UsageProvider, ProviderConfig> = {
  anthropic: {
    callbackPath: '/callback',
    preferredPort: 54545,
    allowEphemeralPort: true,
    portBusyMessage: 'Port 54545 is in use',
    buildAuthorizeUrl: buildAnthropicAuthorizeUrl
  },
  openai: {
    callbackPath: '/auth/callback',
    preferredPort: 1455,
    allowEphemeralPort: false,
    portBusyMessage:
      'Port 1455 is in use (another Codex sign-in may be running). Close it and try again.',
    buildAuthorizeUrl: buildOpenAIAuthorizeUrl
  }
}

let preferredPortOverrides: Partial<Record<UsageProvider, number>> | null = null

/**
 * Test-only seam: override the port tried first per provider (0 = OS-assigned),
 * or pass `null` to restore the defaults. The fallback rules are unchanged.
 */
export function setLoginCallbackPortsForTests(
  overrides: Partial<Record<UsageProvider, number>> | null
): void {
  preferredPortOverrides = overrides
}

function preferredPortFor(provider: UsageProvider): number {
  return preferredPortOverrides?.[provider] ?? PROVIDER_CONFIG[provider].preferredPort
}

function buildRedirectUri(config: ProviderConfig, port: number): string {
  return `http://localhost:${port}${config.callbackPath}`
}

// ─── Callback pages ───────────────────────────────────────────────────────

function renderPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hive</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0e14;color:#e6e6e6;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:32rem;padding:0 1rem}h1{font-size:22px}p{color:#9aa5b1}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`
}

const SIGNED_IN_HTML = renderPage(
  '&#9989; Signed in',
  'You can close this tab and return to Hive.'
)

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Session state ────────────────────────────────────────────────────────

interface LoginSession {
  loginId: string
  provider: UsageProvider
  state: LoginState
  email: string | null
  error: string | null
  pkce: Pkce
  /** Loopback server waiting for the provider's redirect; null until it's listening and after teardown. */
  server: Server | null
  /** The exact redirect URI the authorize URL was built with (the exchange must echo it). */
  redirectUri: string | null
  /** Guards the capture so only the first callback wins. */
  resolved: boolean
  timeoutTimer: NodeJS.Timeout | null
  gcTimer: NodeJS.Timeout | null
}

let currentSession: LoginSession | null = null

function isTerminal(state: LoginState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}

function clearActiveTimers(session: LoginSession): void {
  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer)
    session.timeoutTimer = null
  }
}

function scheduleGc(session: LoginSession): void {
  if (session.gcTimer) clearTimeout(session.gcTimer)
  const timer = setTimeout(() => {
    if (currentSession === session) currentSession = null
  }, GC_DELAY_MS)
  timer.unref()
  session.gcTimer = timer
}

/**
 * Stops the callback server. Idle keep-alive sockets go immediately; a
 * connection still streaming a callback response gets a short grace period
 * before it's destroyed.
 */
function closeServer(server: Server | null): void {
  if (!server) return
  server.close()
  server.closeIdleConnections()
  const timer = setTimeout(() => server.closeAllConnections(), CLOSE_DELAY_MS)
  timer.unref()
}

function teardownServer(session: LoginSession): void {
  const server = session.server
  session.server = null
  closeServer(server)
}

function failSession(session: LoginSession, message: string): void {
  if (isTerminal(session.state)) return
  session.state = 'failed'
  session.error = message
  clearActiveTimers(session)
  teardownServer(session)
  scheduleGc(session)
  log.warn('Login failed', { loginId: session.loginId, provider: session.provider, error: message })
}

/** Moves a non-terminal session to `cancelled` and tears down its callback server. Callers check the state first. */
function cancelSession(session: LoginSession): void {
  session.state = 'cancelled'
  clearActiveTimers(session)
  teardownServer(session)
  scheduleGc(session)
}

/** Public status snapshot for the renderer's poller. */
export type LoginStatus = LoginStatusDTO

export function isLoginActive(): boolean {
  return currentSession !== null && !isTerminal(currentSession.state)
}

export function loginStatus(loginId: string): LoginStatusDTO {
  if (!currentSession || currentSession.loginId !== loginId) {
    throw new Error('login session not found')
  }
  const { provider, state, email, error } = currentSession
  return { loginId, provider, state, email, error }
}

/** Test-only seam: cancels any in-flight login (freeing its callback port) and forgets the session. */
export function resetLoginServiceForTests(): void {
  const session = currentSession
  currentSession = null
  if (!session) return
  if (!isTerminal(session.state)) cancelSession(session)
  if (session.gcTimer) clearTimeout(session.gcTimer)
}

export async function loginCancel(loginId: string): Promise<boolean> {
  const session = currentSession
  if (!session || session.loginId !== loginId) return false
  if (isTerminal(session.state)) return false

  cancelSession(session)
  return true
}

export async function loginStart(
  provider: UsageProvider,
  emailHint?: string
): Promise<{ loginId: string }> {
  if (process.platform !== 'darwin') {
    throw new Error('Account sign-in is only supported on macOS')
  }
  if (currentSession && !isTerminal(currentSession.state)) {
    throw new Error('A login is already in progress')
  }

  const session: LoginSession = {
    loginId: randomUUID(),
    provider,
    state: 'launching',
    email: emailHint ?? null,
    error: null,
    pkce: generatePkce(),
    server: null,
    redirectUri: null,
    resolved: false,
    timeoutTimer: null,
    gcTimer: null
  }
  currentSession = session

  // Start the overall timeout at session creation so it also covers the
  // 'launching' state: a hung server start or browser launch would otherwise
  // leave a non-terminal 'launching' session forever, blocking every future
  // login. failSession tears down whatever server exists by then.
  const timeoutTimer = setTimeout(() => {
    failSession(session, 'Login timed out')
  }, LOGIN_TIMEOUT_MS)
  timeoutTimer.unref()
  session.timeoutTimer = timeoutTimer

  // Fire-and-forget: the whole flow lives in the background so loginStart
  // never blocks the RPC caller. Every failure lands in session.state — this
  // never throws out of the background flow.
  void runLoginFlow(session).catch((error) => {
    failSession(session, error instanceof Error ? error.message : String(error))
  })

  return { loginId: session.loginId }
}

// ─── Background flow ──────────────────────────────────────────────────────

async function runLoginFlow(session: LoginSession): Promise<void> {
  const config = PROVIDER_CONFIG[session.provider]

  let server: Server
  try {
    server = await startCallbackServer(session, config)
  } catch (error) {
    failSession(session, error instanceof Error ? error.message : String(error))
    return
  }

  // A cancel (or the timeout) could have landed while the server was starting.
  if (isTerminal(session.state)) {
    closeServer(server)
    return
  }

  session.server = server
  const port = (server.address() as AddressInfo).port
  const redirectUri = buildRedirectUri(config, port)
  session.redirectUri = redirectUri
  const authorizeUrl = config.buildAuthorizeUrl(session.pkce, redirectUri)

  // The server is ready to receive the redirect before the browser is even
  // asked to open — so flip to 'waiting' now. A fast redirect (profile still
  // signed in) can then never race the state transition.
  session.state = 'waiting'

  try {
    await openLoginUrl(authorizeUrl)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failSession(session, `Could not open the browser for sign-in: ${message}`)
    return
  }

  log.info('Sign-in opened in the browser', {
    loginId: session.loginId,
    provider: session.provider,
    redirectUri
  })
}

/** Listens on the provider's preferred port, falling back to an OS-assigned one when allowed. */
async function startCallbackServer(session: LoginSession, config: ProviderConfig): Promise<Server> {
  const preferred = preferredPortFor(session.provider)
  try {
    return await listen(session, config, preferred)
  } catch (error) {
    if (!isAddressInUse(error)) throw error
    if (!config.allowEphemeralPort) throw new Error(config.portBusyMessage)
    log.info('Preferred callback port busy — using an OS-assigned port', {
      loginId: session.loginId,
      provider: session.provider,
      port: preferred
    })
    return listen(session, config, 0)
  }
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
}

function listen(session: LoginSession, config: ProviderConfig, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => handleCallbackRequest(session, config, req, res))
    server.once('error', reject)
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', reject)
      // A stray error later (e.g. the socket being torn down) must never crash the process.
      server.on('error', (error) => {
        log.warn('Login callback server error', {
          loginId: session.loginId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
      resolve(server)
    })
  })
}

function respondHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close'
  })
  res.end(html)
}

function handleCallbackRequest(
  session: LoginSession,
  config: ProviderConfig,
  req: IncomingMessage,
  res: ServerResponse
): void {
  let url: URL
  try {
    url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`)
  } catch {
    res.writeHead(400).end()
    return
  }
  if (req.method !== 'GET' || url.pathname !== config.callbackPath) {
    res.writeHead(404).end()
    return
  }

  const outcome = extractAndHandle(session, url)
  switch (outcome.kind) {
    case 'captured':
    case 'duplicate':
      respondHtml(res, 200, SIGNED_IN_HTML)
      return
    case 'error':
      respondHtml(
        res,
        200,
        renderPage('Sign-in failed', `${escapeHtml(outcome.message)}. You can close this tab.`)
      )
      return
    case 'ignored':
      respondHtml(
        res,
        400,
        renderPage('Sign-in not completed', 'This sign-in is no longer active. Start again from Hive.')
      )
      return
  }
}

type CaptureOutcome =
  | { kind: 'captured' }
  /** A repeat of an already-captured redirect (e.g. a reloaded tab). */
  | { kind: 'duplicate' }
  | { kind: 'error'; message: string }
  /** Nothing usable, or the session is no longer waiting for a code. */
  | { kind: 'ignored' }

function extractAndHandle(session: LoginSession, url: URL): CaptureOutcome {
  // A callback can still arrive after the session went terminal (e.g. the
  // user cancelled). `resolved` doesn't guard that — a cancel never sets it —
  // so without this check a late callback could set 'exchanging' and complete
  // to 'done' post-cancel.
  if (isTerminal(session.state)) return { kind: 'ignored' }
  if (session.resolved) return { kind: 'duplicate' }

  const errorParam = url.searchParams.get('error')
  if (errorParam) {
    session.resolved = true
    const message = `Provider returned error: ${errorParam}`
    failSession(session, message)
    return { kind: 'error', message }
  }

  const code = url.searchParams.get('code')
  if (!code) return { kind: 'ignored' }

  const state = url.searchParams.get('state')
  session.resolved = true
  void exchange(session, code, state)
  return { kind: 'captured' }
}

async function exchange(session: LoginSession, code: string, state: string | null): Promise<void> {
  session.state = 'exchanging'

  if (state !== session.pkce.state) {
    failSession(session, 'State mismatch — please retry')
    return
  }

  try {
    const email =
      session.provider === 'anthropic'
        ? await exchangeAndStoreAnthropic(session, code)
        : await exchangeAndStoreOpenAI(session, code)

    if (email === null) return // failSession already called by the store helper

    session.email = email
    await refreshCacheForNewAccount(session.provider, email)

    // A cancel could have landed while the exchange/store/cache-refresh above
    // was in flight — don't clobber the terminal state it already set. The
    // account may already be stored (the code was consumed; that's fine),
    // but only loginCancel gets to decide the final state in that race, and
    // it already tore down the server and scheduled its own GC.
    if (isTerminal(session.state)) return

    session.state = 'done'
    clearActiveTimers(session) // the 30-min timeout no longer applies once we've succeeded
    teardownServer(session)
    scheduleGc(session)
  } catch (error) {
    failSession(session, error instanceof Error ? error.message : String(error))
  }
}

/** Returns the stored account's email, or null if `failSession` was already called. */
async function exchangeAndStoreAnthropic(session: LoginSession, code: string): Promise<string | null> {
  const tokens = await exchangeAnthropicCode(
    code,
    session.pkce.state,
    session.pkce,
    session.redirectUri ?? undefined
  )
  const email = tokens.account?.emailAddress?.toLowerCase()
  if (!email) {
    failSession(session, 'Login succeeded but no account email was returned')
    return null
  }
  const uuid = tokens.account?.uuid ?? ''
  const scopes = tokens.scope?.split(' ') ?? ['org:create_api_key', 'user:profile', 'user:inference']
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes
    }
  })
  await addClaudeAccount(email, uuid, blob)
  return email
}

async function exchangeAndStoreOpenAI(session: LoginSession, code: string): Promise<string | null> {
  const tokens = await exchangeOpenAICode(code, session.pkce, session.redirectUri ?? undefined)
  const { email } = await addCodexAccount(tokens.idToken, tokens.accessToken, tokens.refreshToken)
  return email
}

/** Best-effort: populating the usage cache never blocks or fails a completed login. */
async function refreshCacheForNewAccount(provider: UsageProvider, email: string): Promise<void> {
  try {
    await listSavedAccounts(provider)
    const savedProvider: SavedUsageProvider = provider
    // The orchestrator upserts rows with lowercased emails — match that here,
    // since the email returned by the account-store helpers isn't guaranteed
    // to be lowercased (e.g. Codex's id_token claim is verbatim).
    const row = getDatabase().getSavedUsageAccountByProviderEmail(savedProvider, email.toLowerCase())
    if (row) {
      void fetchForSavedAccount(row.id).catch(() => {})
    }
  } catch (error) {
    log.warn('Failed to refresh saved-account cache after login', {
      provider,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
