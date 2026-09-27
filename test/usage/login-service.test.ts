// @vitest-environment node
import { request as httpRequest } from 'http'
import { createServer, type Server } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoginUrlOpener } from '../../src/main/services/login-service'

const mocks = vi.hoisted(() => ({
  db: {
    getSavedUsageAccountByProviderEmail: vi.fn()
  },
  addClaudeAccount: vi.fn(),
  addCodexAccount: vi.fn(),
  exchangeAnthropicCode: vi.fn(),
  exchangeOpenAICode: vi.fn(),
  listSavedAccounts: vi.fn(),
  fetchForSavedAccount: vi.fn()
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: () => mocks.db
}))

vi.mock('../../src/main/services/account-store-claude', () => ({
  addClaudeAccount: mocks.addClaudeAccount
}))

vi.mock('../../src/main/services/account-store-codex', () => ({
  addCodexAccount: mocks.addCodexAccount
}))

vi.mock('../../src/main/services/oauth-anthropic', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/services/oauth-anthropic')>(
    '../../src/main/services/oauth-anthropic'
  )
  return { ...actual, exchangeAnthropicCode: mocks.exchangeAnthropicCode }
})

vi.mock('../../src/main/services/oauth-openai', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/services/oauth-openai')>(
    '../../src/main/services/oauth-openai'
  )
  return { ...actual, exchangeOpenAICode: mocks.exchangeOpenAICode }
})

vi.mock('../../src/main/services/saved-usage-orchestrator', () => ({
  listSavedAccounts: mocks.listSavedAccounts,
  fetchForSavedAccount: mocks.fetchForSavedAccount
}))

type LoginServiceModule = typeof import('../../src/main/services/login-service')

/**
 * Each test gets a fresh module (fresh `currentSession`). Every module the
 * suite loads is tracked so `afterEach` can cancel whatever it left behind —
 * otherwise a stray callback server would outlive the test.
 */
const loadedModules: LoginServiceModule[] = []

async function importFresh(): Promise<LoginServiceModule> {
  vi.resetModules()
  const mod = await import('../../src/main/services/login-service')
  // Never bind the real Claude Code / Codex CLI ports from a test run.
  mod.setLoginCallbackPortsForTests({ anthropic: 0, openai: 0 })
  loadedModules.push(mod)
  return mod
}

/** A fake browser: records the authorize URLs it was asked to open. */
function createFakeOpener(): { opener: LoginUrlOpener; openedUrls: string[] } {
  const openedUrls: string[] = []
  const opener: LoginUrlOpener = vi.fn(async (url: string) => {
    openedUrls.push(url)
  })
  return { opener, openedUrls }
}

/** The authorize URL's `redirect_uri` is our loopback callback URL. */
function redirectUriOf(authorizeUrl: string): string {
  const redirectUri = new URL(authorizeUrl).searchParams.get('redirect_uri')
  if (!redirectUri) throw new Error('authorize URL has no redirect_uri')
  return redirectUri
}

function stateOf(authorizeUrl: string): string {
  const state = new URL(authorizeUrl).searchParams.get('state')
  if (!state) throw new Error('authorize URL has no state')
  return state
}

interface HttpReply {
  status: number
  body: string
}

/**
 * Plain Node http client (not fetch/undici, whose internal timers the fake
 * clock would freeze). `localhost` in the redirect URI is what the browser
 * sees; the server listens on 127.0.0.1, so hit that directly.
 */
function httpGet(url: string): Promise<HttpReply> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: Number(target.port),
        path: target.pathname + target.search,
        method: 'GET'
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** Follows the provider's redirect to our callback with the given query. */
async function hitCallback(authorizeUrl: string, query: Record<string, string>): Promise<HttpReply> {
  const url = new URL(redirectUriOf(authorizeUrl))
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return httpGet(url.toString())
}

async function isPortClosed(url: string): Promise<boolean> {
  try {
    await httpGet(url)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
  }
}

/** Occupies a loopback port so the login service finds it busy. */
async function occupyPort(): Promise<{ port: number; server: Server }> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { port: address.port, server }
}

/** Advances the fake clock in small steps, letting real microtasks/socket I/O interleave, until `predicate` holds. */
async function pumpUntil(predicate: () => boolean, maxIterations = 400): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return
    await vi.advanceTimersByTimeAsync(5)
  }
  if (!predicate()) {
    throw new Error('pumpUntil: condition was never satisfied within the iteration budget')
  }
}

/** Lets a test control exactly when a mocked async dependency resolves. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('login-service', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.db.getSavedUsageAccountByProviderEmail.mockReturnValue(null)
    mocks.listSavedAccounts.mockResolvedValue([])
    mocks.fetchForSavedAccount.mockResolvedValue({ success: true, status: 'ok' })
    mocks.exchangeAnthropicCode.mockResolvedValue({
      accessToken: 'anthropic-access-token',
      refreshToken: 'anthropic-refresh-token',
      expiresAt: 1_700_000_000_000,
      scope: 'org:create_api_key user:profile user:inference',
      account: { uuid: 'uuid-1', emailAddress: 'User@Example.com' }
    })
    mocks.exchangeOpenAICode.mockResolvedValue({
      idToken: 'id-token',
      accessToken: 'openai-access-token',
      refreshToken: 'openai-refresh-token'
    })
    mocks.addClaudeAccount.mockResolvedValue('1')
    mocks.addCodexAccount.mockResolvedValue({ accountKey: 'user-1::acct-1', email: 'codex@example.com' })

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(async () => {
    // Tear down any callback server a test left listening.
    for (const mod of loadedModules.splice(0)) {
      mod.resetLoginServiceForTests()
      mod.setLoginUrlOpenerForTests(null)
      mod.setLoginCallbackPortsForTests(null)
    }
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  })

  it('runs the full happy path for an Anthropic login: launching -> waiting -> exchanging -> done', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    expect(loginStatus(loginId).state).toBe('launching')
    // The email hint is surfaced to the renderer right away.
    expect(loginStatus(loginId).email).toBe('user@example.com')

    await pumpUntil(() => loginStatus(loginId).state === 'waiting')
    await pumpUntil(() => openedUrls.length === 1)

    const authorizeUrl = openedUrls[0]
    expect(authorizeUrl.startsWith('https://claude.ai/oauth/authorize')).toBe(true)
    const redirectUri = redirectUriOf(authorizeUrl)
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)
    const state = stateOf(authorizeUrl)

    const reply = await hitCallback(authorizeUrl, { code: 'abc123', state })
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('Signed in')

    await pumpUntil(() => loginStatus(loginId).state === 'done')

    // The exchange must echo the exact redirect URI the authorize URL used.
    expect(mocks.exchangeAnthropicCode).toHaveBeenCalledWith(
      'abc123',
      state,
      expect.objectContaining({ state }),
      redirectUri
    )
    expect(mocks.addClaudeAccount).toHaveBeenCalledWith(
      'user@example.com',
      'uuid-1',
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'anthropic-access-token',
          refreshToken: 'anthropic-refresh-token',
          expiresAt: 1_700_000_000_000,
          scopes: ['org:create_api_key', 'user:profile', 'user:inference']
        }
      })
    )
    expect(mocks.listSavedAccounts).toHaveBeenCalledWith('anthropic')
    expect(mocks.db.getSavedUsageAccountByProviderEmail).toHaveBeenCalledWith(
      'anthropic',
      'user@example.com'
    )

    const status = loginStatus(loginId)
    expect(status.email).toBe('user@example.com')
    expect(status.error).toBeNull()

    // The callback server is torn down once the login succeeds.
    await pumpUntil(() => loginStatus(loginId).state === 'done')
    expect(await isPortClosed(redirectUri)).toBe(true)

    // The 30-minute waiting timeout is cancelled once a login succeeds — it
    // must not re-fire as time passes. A 'done' session stays queryable
    // comfortably before the 5-minute GC mark (leaving margin for the
    // pumpUntil polling jitter above)...
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 5000)
    expect(loginStatus(loginId).state).toBe('done')
    expect(loginStatus(loginId).error).toBeNull()

    // ...and is GC'd once 5 minutes since it went 'done' has elapsed, so a
    // stale poll doesn't retain it forever.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(() => loginStatus(loginId)).toThrow('login session not found')
  })

  it('resolves the cache row id via getSavedUsageAccountByProviderEmail and fires fetchForSavedAccount', async () => {
    const { opener, openedUrls } = createFakeOpener()
    mocks.db.getSavedUsageAccountByProviderEmail.mockReturnValue({ id: 'row-42' })
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => openedUrls.length === 1)
    await hitCallback(openedUrls[0], { code: 'abc123', state: stateOf(openedUrls[0]) })
    await pumpUntil(() => loginStatus(loginId).state === 'done')

    expect(mocks.fetchForSavedAccount).toHaveBeenCalledWith('row-42')
  })

  it('lowercases the addCodexAccount email before the cache lookup, and swallows a rejected fetch', async () => {
    const { opener, openedUrls } = createFakeOpener()
    mocks.addCodexAccount.mockResolvedValue({ accountKey: 'user-1::acct-1', email: 'User@Example.com' })
    mocks.db.getSavedUsageAccountByProviderEmail.mockReturnValue({ id: 'row-99' })
    mocks.fetchForSavedAccount.mockRejectedValue(new Error('network blip'))

    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('openai')
    await pumpUntil(() => openedUrls.length === 1)
    await hitCallback(openedUrls[0], { code: 'codex-code', state: stateOf(openedUrls[0]) })
    await pumpUntil(() => loginStatus(loginId).state === 'done')

    expect(mocks.db.getSavedUsageAccountByProviderEmail).toHaveBeenCalledWith(
      'openai',
      'user@example.com'
    )
    expect(mocks.fetchForSavedAccount).toHaveBeenCalledWith('row-99')
    // The status keeps the email as the store returned it.
    expect(loginStatus(loginId).email).toBe('User@Example.com')
    expect(loginStatus(loginId).state).toBe('done')
  })

  it('runs the full happy path for an OpenAI (Codex) login', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('openai')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')
    await pumpUntil(() => openedUrls.length === 1)

    const authorizeUrl = openedUrls[0]
    expect(authorizeUrl.startsWith('https://auth.openai.com/oauth/authorize')).toBe(true)
    const redirectUri = redirectUriOf(authorizeUrl)
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/)
    const state = stateOf(authorizeUrl)

    const reply = await hitCallback(authorizeUrl, { code: 'codex-code', state })
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('Signed in')

    await pumpUntil(() => loginStatus(loginId).state === 'done')

    expect(mocks.exchangeOpenAICode).toHaveBeenCalledWith(
      'codex-code',
      expect.objectContaining({ state }),
      redirectUri
    )
    expect(mocks.addCodexAccount).toHaveBeenCalledWith(
      'id-token',
      'openai-access-token',
      'openai-refresh-token'
    )
    expect(loginStatus(loginId).email).toBe('codex@example.com')
  })

  it('uses the real Codex CLI callback (port 1455, /auth/callback) for OpenAI by default', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, setLoginUrlOpenerForTests, setLoginCallbackPortsForTests } =
      await importFresh()
    setLoginUrlOpenerForTests(opener)
    setLoginCallbackPortsForTests(null)

    const { loginId } = await loginStart('openai')
    await pumpUntil(() => loginStatus(loginId).state !== 'launching')

    if (loginStatus(loginId).state === 'failed') {
      // Something else on this machine (a real Codex sign-in) already owns
      // 1455 — that's the documented failure, and the message names the port.
      expect(loginStatus(loginId).error).toContain('1455')
      return
    }
    await pumpUntil(() => openedUrls.length === 1)
    expect(redirectUriOf(openedUrls[0])).toBe('http://localhost:1455/auth/callback')
  })

  it('prefers the configured Anthropic port and echoes it in the redirect URI', async () => {
    const { port, server } = await occupyPort()
    await new Promise<void>((resolve) => server.close(() => resolve()))

    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, setLoginUrlOpenerForTests, setLoginCallbackPortsForTests } =
      await importFresh()
    setLoginUrlOpenerForTests(opener)
    setLoginCallbackPortsForTests({ anthropic: port, openai: 0 })

    await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)
    expect(redirectUriOf(openedUrls[0])).toBe(`http://localhost:${port}/callback`)
  })

  it('falls back to an OS-assigned port for Anthropic when the preferred port is busy', async () => {
    const { port, server } = await occupyPort()
    try {
      const { opener, openedUrls } = createFakeOpener()
      const { loginStart, loginStatus, setLoginUrlOpenerForTests, setLoginCallbackPortsForTests } =
        await importFresh()
      setLoginUrlOpenerForTests(opener)
      setLoginCallbackPortsForTests({ anthropic: port, openai: 0 })

      const { loginId } = await loginStart('anthropic')
      await pumpUntil(() => openedUrls.length === 1)

      const redirectUri = redirectUriOf(openedUrls[0])
      expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)
      expect(new URL(redirectUri).port).not.toBe(String(port))
      expect(loginStatus(loginId).state).toBe('waiting')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('fails an OpenAI login when port 1455 is busy instead of redirecting somewhere it cannot hear', async () => {
    const { port, server } = await occupyPort()
    try {
      const { opener, openedUrls } = createFakeOpener()
      const { loginStart, loginStatus, setLoginUrlOpenerForTests, setLoginCallbackPortsForTests } =
        await importFresh()
      setLoginUrlOpenerForTests(opener)
      setLoginCallbackPortsForTests({ anthropic: 0, openai: port })

      const { loginId } = await loginStart('openai')
      await pumpUntil(() => loginStatus(loginId).state === 'failed')

      expect(loginStatus(loginId).error).toContain('Port 1455 is in use')
      expect(openedUrls).toEqual([])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('answers 404 for any other path and keeps waiting', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)
    const state = stateOf(openedUrls[0])
    const base = new URL(redirectUriOf(openedUrls[0]))

    const reply = await httpGet(`${base.origin}/elsewhere?code=abc123&state=${state}`)
    expect(reply.status).toBe(404)
    await vi.advanceTimersByTimeAsync(20)

    expect(loginStatus(loginId).state).toBe('waiting')
    expect(mocks.exchangeAnthropicCode).not.toHaveBeenCalled()
  })

  it('ignores a callback without a code and keeps waiting', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)

    const reply = await hitCallback(openedUrls[0], { state: stateOf(openedUrls[0]) })
    expect(reply.status).toBe(400)
    await vi.advanceTimersByTimeAsync(20)

    expect(loginStatus(loginId).state).toBe('waiting')
    expect(mocks.exchangeAnthropicCode).not.toHaveBeenCalled()
  })

  it('serves the signed-in page again on a duplicate callback without a second exchange', async () => {
    const deferred = createDeferred<never>()
    mocks.exchangeAnthropicCode.mockReturnValue(deferred.promise)
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)
    const state = stateOf(openedUrls[0])

    await hitCallback(openedUrls[0], { code: 'abc123', state })
    expect(loginStatus(loginId).state).toBe('exchanging')

    // The user reloads the tab while the exchange is still in flight.
    const reply = await hitCallback(openedUrls[0], { code: 'abc123', state })
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('Signed in')
    expect(mocks.exchangeAnthropicCode).toHaveBeenCalledTimes(1)
  })

  it('fails on a PKCE state mismatch and never calls the token exchange', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)
    const redirectUri = redirectUriOf(openedUrls[0])

    await hitCallback(openedUrls[0], { code: 'abc123', state: 'wrong-state' })
    await pumpUntil(() => loginStatus(loginId).state === 'failed')

    expect(loginStatus(loginId).error).toBe('State mismatch — please retry')
    expect(mocks.exchangeAnthropicCode).not.toHaveBeenCalled()
    // A failed login tears its server down too.
    await vi.advanceTimersByTimeAsync(1500)
    expect(await isPortClosed(redirectUri)).toBe(true)
  })

  it('fails when the provider redirect carries an error query param', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)

    const reply = await hitCallback(openedUrls[0], {
      error: 'access_denied',
      state: stateOf(openedUrls[0])
    })
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('Sign-in failed')
    expect(reply.body).toContain('access_denied')

    await pumpUntil(() => loginStatus(loginId).state === 'failed')
    expect(loginStatus(loginId).error).toBe('Provider returned error: access_denied')
    expect(mocks.exchangeAnthropicCode).not.toHaveBeenCalled()
  })

  it('escapes provider error text before rendering it in the callback page', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)

    const reply = await hitCallback(openedUrls[0], { error: '<script>alert(1)</script>' })
    expect(reply.body).not.toContain('<script>')
    expect(reply.body).toContain('&lt;script&gt;')
  })

  it('fails when no account email is returned from the Anthropic exchange', async () => {
    mocks.exchangeAnthropicCode.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1,
      account: { uuid: 'uuid-1' }
    })
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)
    await hitCallback(openedUrls[0], { code: 'abc123', state: stateOf(openedUrls[0]) })
    await pumpUntil(() => loginStatus(loginId).state === 'failed')

    expect(loginStatus(loginId).error).toBe('Login succeeded but no account email was returned')
    expect(mocks.addClaudeAccount).not.toHaveBeenCalled()
  })

  it('cancels a non-terminal login and tears down the callback server', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, loginCancel, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => openedUrls.length === 1)
    const redirectUri = redirectUriOf(openedUrls[0])
    expect(await isPortClosed(redirectUri)).toBe(false)

    const result = await loginCancel(loginId)

    expect(result).toBe(true)
    expect(loginStatus(loginId).state).toBe('cancelled')
    expect(loginStatus(loginId).error).toBeNull()
    // A redirect landing after the cancel finds nobody listening — it can
    // never resurrect the flow into 'exchanging'/'done'.
    await vi.advanceTimersByTimeAsync(1500)
    expect(await isPortClosed(redirectUri)).toBe(true)
    expect(mocks.exchangeAnthropicCode).not.toHaveBeenCalled()
  })

  it('a cancel that lands during the in-flight token exchange is not clobbered back to done', async () => {
    const deferred = createDeferred<{
      accessToken: string
      refreshToken: string
      expiresAt: number
      scope: string
      account: { uuid: string; emailAddress: string }
    }>()
    mocks.exchangeAnthropicCode.mockReturnValue(deferred.promise)

    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, loginCancel, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => openedUrls.length === 1)

    await hitCallback(openedUrls[0], { code: 'abc123', state: stateOf(openedUrls[0]) })
    // The request handler runs extractAndHandle -> exchange() synchronously up
    // to the awaited (still-pending) token exchange call.
    expect(loginStatus(loginId).state).toBe('exchanging')

    const cancelled = await loginCancel(loginId)
    expect(cancelled).toBe(true)
    expect(loginStatus(loginId).state).toBe('cancelled')

    // Now let the in-flight exchange resolve — it must NOT overwrite the
    // already-terminal 'cancelled' state back to 'done'.
    deferred.resolve({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1,
      scope: 'org:create_api_key user:profile user:inference',
      account: { uuid: 'uuid-1', emailAddress: 'user@example.com' }
    })
    await vi.advanceTimersByTimeAsync(0)

    // The account may still get stored (the code was consumed; that's fine) —
    // only the session STATE must hold.
    expect(mocks.addClaudeAccount).toHaveBeenCalled()
    expect(loginStatus(loginId).state).toBe('cancelled')
    expect(loginStatus(loginId).error).toBeNull()
  })

  it('cancels while the browser is still being opened without leaving a server behind', async () => {
    let openedUrl: string | null = null
    const neverResolves = new Promise<void>(() => {})
    const { loginStart, loginStatus, loginCancel, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests((url) => {
      openedUrl = url
      return neverResolves
    })

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => openedUrl !== null)
    expect(loginStatus(loginId).state).toBe('waiting')

    expect(await loginCancel(loginId)).toBe(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(await isPortClosed(redirectUriOf(openedUrl!))).toBe(true)
  })

  it('times out even while the browser is still being opened (a hung opener does not block future logins)', async () => {
    const neverResolves = new Promise<void>(() => {})
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(() => neverResolves)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    expect(loginStatus(loginId).state).toBe('launching')

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(loginStatus(loginId).state).toBe('failed')
    expect(loginStatus(loginId).error).toBe('Login timed out')
  })

  it('loginCancel returns false for an unknown login', async () => {
    const { loginCancel } = await importFresh()
    expect(await loginCancel('does-not-exist')).toBe(false)
  })

  it('loginCancel returns false once the session is already terminal', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, loginCancel, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)
    await hitCallback(openedUrls[0], { code: 'abc123', state: stateOf(openedUrls[0]) })
    await pumpUntil(() => loginStatus(loginId).state === 'done')

    expect(await loginCancel(loginId)).toBe(false)
    expect(loginStatus(loginId).state).toBe('done')
  })

  it('throws when a login is already in progress', async () => {
    const { opener } = createFakeOpener()
    const { loginStart, loginCancel, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic')
    await expect(loginStart('openai')).rejects.toThrow('A login is already in progress')
    await loginCancel(loginId)
  })

  it('lets a new loginStart supersede a terminal session; the old loginId 404s', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, loginCancel, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId: first } = await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)
    await loginCancel(first)
    expect(loginStatus(first).state).toBe('cancelled')

    const { loginId: second } = await loginStart('openai')
    expect(second).not.toBe(first)
    expect(() => loginStatus(first)).toThrow('login session not found')
    expect(loginStatus(second).provider).toBe('openai')
    await loginCancel(second)
  })

  it('GCs a terminal session after 5 minutes if no new login starts', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, loginCancel, setLoginUrlOpenerForTests, isLoginActive } =
      await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)
    await loginCancel(loginId)
    expect(loginStatus(loginId).state).toBe('cancelled')

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1)
    expect(loginStatus(loginId).state).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(2)
    expect(() => loginStatus(loginId)).toThrow('login session not found')
    expect(isLoginActive()).toBe(false)
  })

  it('fails with a timeout after 30 minutes of waiting, and closes the callback server', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => openedUrls.length === 1)
    const redirectUri = redirectUriOf(openedUrls[0])

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(loginStatus(loginId).state).toBe('failed')
    expect(loginStatus(loginId).error).toBe('Login timed out')
    expect(await isPortClosed(redirectUri)).toBe(true)
  })

  it('fails with the opener error when the browser cannot be opened', async () => {
    let openedUrl: string | null = null
    const { loginStart, loginStatus, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(async (url) => {
      openedUrl = url
      throw new Error('LSOpenURLsWithRole() failed with error -10814')
    })

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => loginStatus(loginId).state === 'failed')

    expect(loginStatus(loginId).error).toBe(
      'Could not open the browser for sign-in: LSOpenURLsWithRole() failed with error -10814'
    )
    await vi.advanceTimersByTimeAsync(1500)
    expect(await isPortClosed(redirectUriOf(openedUrl!))).toBe(true)
  })

  it('throws on non-macOS platforms', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const { loginStart } = await importFresh()
      await expect(loginStart('anthropic')).rejects.toThrow(
        'Account sign-in is only supported on macOS'
      )
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('isLoginActive reflects whether the current session is non-terminal', async () => {
    const { opener, openedUrls } = createFakeOpener()
    const { loginStart, loginCancel, isLoginActive, setLoginUrlOpenerForTests } = await importFresh()
    setLoginUrlOpenerForTests(opener)

    expect(isLoginActive()).toBe(false)
    const { loginId } = await loginStart('anthropic')
    expect(isLoginActive()).toBe(true)
    await pumpUntil(() => openedUrls.length === 1)
    expect(isLoginActive()).toBe(true)
    await loginCancel(loginId)
    expect(isLoginActive()).toBe(false)
  })
})
