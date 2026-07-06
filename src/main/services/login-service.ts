/**
 * Interactive OAuth login: launches a real Chrome instance (via patchright, a
 * stealth-patched Playwright) with a persistent per-account profile, navigates
 * to the provider's authorize URL, captures the resulting `code`/`state` from
 * the redirect, exchanges it for tokens, and stores the account. TypeScript
 * port of ccswitch's manual-login path (`login-sidecar/login.mjs` capture
 * mechanics + `src/login.rs` orchestration) — no email autofill, no OTP
 * control channel.
 *
 * Runs in-process (in the spawned server process) rather than as a sidecar.
 * `patchright` is loaded via dynamic `import()` inside `loginStart` so that
 * no other code path — and never the desktop-main bundle — pays for it.
 *
 * State machine (module-scope, one login at a time):
 *   launching -> waiting -> exchanging -> done
 *                        \-> failed
 *   (any non-terminal state) -> cancelled
 *
 * Terminal sessions (`done`/`failed`/`cancelled`) are retained until the next
 * `loginStart` (which replaces `currentSession`) or 5 minutes, whichever comes
 * first, so a renderer's final status poll always lands.
 */
import { randomUUID } from 'crypto'
import { mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
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
const CLOSE_DELAY_MS = 1500

// ─── Minimal browser-driver surface ──────────────────────────────────────
//
// Deliberately NOT patchright's real (huge) BrowserContext/Page types — just
// the handful of members the login flow touches, so the fake driver used in
// tests stays small and the real implementation is a thin adapter over it.

export interface RouteRequestLike {
  url: () => string
}

export interface RouteLike {
  request: () => RouteRequestLike
  fulfill: (options: { status: number; contentType: string; body: string }) => Promise<void>
  continue: () => Promise<void>
}

export interface FrameLike {
  url: () => string
}

export interface PageLike {
  goto: (url: string) => Promise<unknown>
  on: (event: 'framenavigated', handler: (frame: FrameLike) => void) => void
  mainFrame: () => FrameLike
}

export interface BrowserContextLike {
  pages: () => PageLike[]
  newPage: () => Promise<PageLike>
  route: (glob: string, handler: (route: RouteLike) => void | Promise<void>) => Promise<void>
  on: (event: 'close', handler: () => void) => void
  close: () => Promise<void>
}

export interface LaunchOptions {
  channel: 'chrome'
  headless: false
  viewport: null
  args: string[]
}

export type LoginBrowserLauncher = (
  profileDir: string,
  options: LaunchOptions
) => Promise<BrowserContextLike>

async function defaultLoginBrowserLauncher(
  profileDir: string,
  options: LaunchOptions
): Promise<BrowserContextLike> {
  const { chromium } = await import('patchright')
  const context = await chromium.launchPersistentContext(profileDir, options)
  return context as unknown as BrowserContextLike
}

let launchBrowser: LoginBrowserLauncher = defaultLoginBrowserLauncher

/** Test-only seam: inject a fake browser driver, or pass `null` to restore the real one. */
export function setLoginBrowserLauncherForTests(launcher: LoginBrowserLauncher | null): void {
  launchBrowser = launcher ?? defaultLoginBrowserLauncher
}

// ─── Provider config ──────────────────────────────────────────────────────

interface ProviderConfig {
  /** ccswitch's `Provider::slug()` — MUST match exactly so profile dirs are reused. */
  slug: 'claude' | 'codex'
  matchGlob: string
  redirectPrefix: string
  buildAuthorizeUrl: (pkce: Pkce) => string
}

const PROVIDER_CONFIG: Record<UsageProvider, ProviderConfig> = {
  anthropic: {
    slug: 'claude',
    matchGlob: '**/oauth/code/callback*',
    redirectPrefix: 'https://console.anthropic.com/oauth/code/callback',
    buildAuthorizeUrl: buildAnthropicAuthorizeUrl
  },
  openai: {
    slug: 'codex',
    matchGlob: '**/auth/callback*',
    redirectPrefix: 'http://localhost:1455/auth/callback',
    buildAuthorizeUrl: buildOpenAIAuthorizeUrl
  }
}

/** Port of ccswitch's `login::profile_dir` — same slug + sanitization so existing profiles are reused. */
function resolveProfileDir(provider: UsageProvider, emailHint?: string): string {
  const safeEmail = (emailHint ?? '').replace(/[/\\:]/g, '_')
  const tag = safeEmail.length > 0 ? safeEmail : 'new'
  return join(homedir(), '.ccswitch', 'profiles', `${PROVIDER_CONFIG[provider].slug}-${tag}`)
}

const SIGNED_IN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Hive</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0e14;color:#e6e6e6;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center}h1{font-size:22px}p{color:#9aa5b1}</style></head>
<body><div class="card"><h1>&#9989; Signed in</h1>
<p>You can close this window and return to Hive.</p></div></body></html>`

// ─── Session state ────────────────────────────────────────────────────────

interface LoginSession {
  loginId: string
  provider: UsageProvider
  state: LoginState
  email: string | null
  error: string | null
  pkce: Pkce
  context: BrowserContextLike | null
  /** Guards the dual (route + framenavigated) capture so only the first hit wins. */
  resolved: boolean
  timeoutTimer: NodeJS.Timeout | null
  closeTimer: NodeJS.Timeout | null
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
  if (session.closeTimer) {
    clearTimeout(session.closeTimer)
    session.closeTimer = null
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

function failSession(session: LoginSession, message: string): void {
  if (isTerminal(session.state)) return
  session.state = 'failed'
  session.error = message
  clearActiveTimers(session)
  scheduleGc(session)
  log.warn('Login failed', { loginId: session.loginId, provider: session.provider, error: message })
}

async function safeClose(context: BrowserContextLike | null): Promise<void> {
  if (!context) return
  try {
    await context.close()
  } catch (error) {
    log.warn('Failed to close login browser context', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function isChromeMissingError(message: string): boolean {
  return /chrome/i.test(message) && (/is not found/i.test(message) || /not supported/i.test(message) || /doesn't exist/i.test(message))
}

function mapLaunchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (isChromeMissingError(message)) {
    return 'Google Chrome is required for sign-in. Please install Chrome and try again.'
  }
  return message
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

export async function loginCancel(loginId: string): Promise<boolean> {
  const session = currentSession
  if (!session || session.loginId !== loginId) return false
  if (isTerminal(session.state)) return false

  session.state = 'cancelled'
  clearActiveTimers(session)
  await safeClose(session.context)
  scheduleGc(session)
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
    context: null,
    resolved: false,
    timeoutTimer: null,
    closeTimer: null,
    gcTimer: null
  }
  currentSession = session

  // Fire-and-forget: the whole flow lives in the background so loginStart
  // never blocks the RPC caller. Every failure lands in session.state — this
  // never throws out of the background flow.
  void runLoginFlow(session, emailHint).catch((error) => {
    failSession(session, error instanceof Error ? error.message : String(error))
  })

  return { loginId: session.loginId }
}

// ─── Background flow ──────────────────────────────────────────────────────

async function runLoginFlow(session: LoginSession, emailHint?: string): Promise<void> {
  const config = PROVIDER_CONFIG[session.provider]
  const authorizeUrl = config.buildAuthorizeUrl(session.pkce)
  const profileDir = resolveProfileDir(session.provider, emailHint)
  await mkdir(profileDir, { recursive: true })

  let context: BrowserContextLike
  try {
    context = await launchBrowser(profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: ['--no-first-run', '--no-default-browser-check']
    })
  } catch (error) {
    failSession(session, mapLaunchError(error))
    return
  }

  // A cancel could have landed while Chrome was still launching.
  if (isTerminal(session.state)) {
    await safeClose(context)
    return
  }

  session.context = context
  session.state = 'waiting'

  context.on('close', () => {
    if (!isTerminal(session.state)) {
      failSession(session, 'Browser closed before login completed')
    }
  })

  const timeoutTimer = setTimeout(() => {
    failSession(session, 'Login timed out')
    void safeClose(context)
  }, LOGIN_TIMEOUT_MS)
  timeoutTimer.unref()
  session.timeoutTimer = timeoutTimer

  await context.route(config.matchGlob, (route) => handleRoute(session, config, route))

  let page: PageLike
  try {
    const pages = context.pages()
    page = pages[0] ?? (await context.newPage())
  } catch (error) {
    failSession(session, error instanceof Error ? error.message : String(error))
    return
  }

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      extractAndHandle(session, config, frame.url())
    }
  })

  try {
    await page.goto(authorizeUrl)
  } catch (error) {
    failSession(session, error instanceof Error ? error.message : String(error))
  }
}

async function handleRoute(session: LoginSession, config: ProviderConfig, route: RouteLike): Promise<void> {
  const url = route.request().url()
  if (!url.startsWith(config.redirectPrefix)) {
    try {
      await route.continue()
    } catch {
      // best-effort — the page may already have navigated away
    }
    return
  }

  extractAndHandle(session, config, url)

  try {
    await route.fulfill({ status: 200, contentType: 'text/html', body: SIGNED_IN_HTML })
  } catch {
    try {
      await route.continue()
    } catch {
      // best-effort
    }
  }
}

/** Shared capture logic for both the route interception and the framenavigated fallback. */
function extractAndHandle(session: LoginSession, config: ProviderConfig, rawUrl: string): void {
  if (session.resolved) return
  if (!rawUrl.startsWith(config.redirectPrefix)) return

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return
  }

  const errorParam = parsed.searchParams.get('error')
  if (errorParam) {
    session.resolved = true
    failSession(session, `Provider returned error: ${errorParam}`)
    return
  }

  const code = parsed.searchParams.get('code')
  if (!code) return

  const state = parsed.searchParams.get('state')
  session.resolved = true
  void exchange(session, code, state)
}

async function exchange(session: LoginSession, code: string, state: string | null): Promise<void> {
  session.state = 'exchanging'

  if (state !== session.pkce.state) {
    failSession(session, 'State mismatch — please retry')
    await safeClose(session.context)
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

    session.state = 'done'
    clearActiveTimers(session) // the 30-min timeout no longer applies once we've succeeded
    const closeTimer = setTimeout(() => {
      void safeClose(session.context)
    }, CLOSE_DELAY_MS)
    closeTimer.unref()
    session.closeTimer = closeTimer
  } catch (error) {
    failSession(session, error instanceof Error ? error.message : String(error))
  }
}

/** Returns the stored account's email, or null if `failSession` was already called. */
async function exchangeAndStoreAnthropic(session: LoginSession, code: string): Promise<string | null> {
  const tokens = await exchangeAnthropicCode(code, session.pkce.state, session.pkce)
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
  const tokens = await exchangeOpenAICode(code, session.pkce)
  const { email } = await addCodexAccount(tokens.idToken, tokens.accessToken, tokens.refreshToken)
  return email
}

/** Best-effort: populating the usage cache never blocks or fails a completed login. */
async function refreshCacheForNewAccount(provider: UsageProvider, email: string): Promise<void> {
  try {
    await listSavedAccounts(provider)
    const savedProvider: SavedUsageProvider = provider
    const row = getDatabase().getSavedUsageAccountByProviderEmail(savedProvider, email)
    if (row) {
      void fetchForSavedAccount(row.id)
    }
  } catch (error) {
    log.warn('Failed to refresh saved-account cache after login', {
      provider,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
