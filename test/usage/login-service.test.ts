// @vitest-environment node
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserContextLike,
  FrameLike,
  LoginBrowserLauncher,
  PageLike,
  RouteLike
} from '../../src/main/services/login-service'

const mocks = vi.hoisted(() => ({
  homeDir: '/tmp/hive-login-service-test',
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

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => mocks.homeDir }
})

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

async function importFresh(): Promise<typeof import('../../src/main/services/login-service')> {
  vi.resetModules()
  return import('../../src/main/services/login-service')
}

/** In-memory fake for BrowserContextLike/PageLike, small enough to exercise every capture path. */
function createFakeDriver(): {
  launcher: LoginBrowserLauncher
  close: ReturnType<typeof vi.fn>
  gotoCalls: string[]
  launchProfileDirs: string[]
  triggerRoute: (url: string) => Promise<{ fulfill: ReturnType<typeof vi.fn>; continue: ReturnType<typeof vi.fn> }>
  triggerFrameNavigated: (url: string) => void
  triggerClose: () => void
} {
  const routeHandlers: Array<(route: RouteLike) => void | Promise<void>> = []
  const closeHandlers: Array<() => void> = []
  const gotoCalls: string[] = []
  const launchProfileDirs: string[] = []
  let closed = false
  let frameNavigatedHandler: ((frame: FrameLike) => void) | null = null
  let currentFrameUrl = ''

  const mainFrame: FrameLike = { url: () => currentFrameUrl }

  const page: PageLike = {
    goto: vi.fn(async (url: string) => {
      gotoCalls.push(url)
      currentFrameUrl = url
    }),
    on: vi.fn((event: 'framenavigated', handler: (frame: FrameLike) => void) => {
      if (event === 'framenavigated') frameNavigatedHandler = handler
    }),
    mainFrame: () => mainFrame
  }

  const close = vi.fn(async () => {
    if (closed) return
    closed = true
    for (const handler of closeHandlers) handler()
  })

  const context: BrowserContextLike = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    route: vi.fn(async (_glob: string, handler: (route: RouteLike) => void | Promise<void>) => {
      routeHandlers.push(handler)
    }),
    on: vi.fn((event: 'close', handler: () => void) => {
      if (event === 'close') closeHandlers.push(handler)
    }),
    close
  }

  const launcher: LoginBrowserLauncher = vi.fn(async (profileDir: string) => {
    launchProfileDirs.push(profileDir)
    return context
  })

  return {
    launcher,
    close,
    gotoCalls,
    launchProfileDirs,
    async triggerRoute(url: string) {
      const fulfill = vi.fn(async () => {})
      const cont = vi.fn(async () => {})
      const route: RouteLike = {
        request: () => ({ url: () => url }),
        fulfill,
        continue: cont
      }
      const handler = routeHandlers[routeHandlers.length - 1]
      if (!handler) throw new Error('no route handler registered yet')
      await handler(route)
      return { fulfill, continue: cont }
    },
    triggerFrameNavigated(url: string) {
      currentFrameUrl = url
      frameNavigatedHandler?.(mainFrame)
    },
    triggerClose() {
      for (const handler of closeHandlers) handler()
    }
  }
}

/** Advances the fake clock in small steps, letting real microtasks/fs I/O interleave, until `predicate` holds. */
async function pumpUntil(predicate: () => boolean, maxIterations = 400): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return
    await vi.advanceTimersByTimeAsync(5)
  }
  if (!predicate()) {
    throw new Error('pumpUntil: condition was never satisfied within the iteration budget')
  }
}

describe('login-service', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    mocks.homeDir = await mkdtemp(join(tmpdir(), 'hive-login-service-'))
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
    vi.useRealTimers()
    await rm(mocks.homeDir, { recursive: true, force: true })
  })

  it('runs the full happy path for an Anthropic login: launching -> waiting -> exchanging -> done', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    expect(loginStatus(loginId).state).toBe('launching')

    await pumpUntil(() => loginStatus(loginId).state === 'waiting')
    expect(driver.launchProfileDirs).toEqual([
      join(mocks.homeDir, '.ccswitch', 'profiles', 'claude-user@example.com')
    ])

    const gotoUrl = driver.gotoCalls[0]
    expect(gotoUrl.startsWith('https://claude.ai/oauth/authorize')).toBe(true)
    const state = new URL(gotoUrl).searchParams.get('state')
    expect(state).toBeTruthy()

    const { fulfill, continue: cont } = await driver.triggerRoute(
      `https://console.anthropic.com/oauth/code/callback?code=abc123&state=${state}`
    )
    expect(cont).not.toHaveBeenCalled()
    expect(fulfill).toHaveBeenCalledWith({
      status: 200,
      contentType: 'text/html',
      body: expect.stringContaining('Signed in')
    })

    await pumpUntil(() => loginStatus(loginId).state === 'done')

    expect(mocks.exchangeAnthropicCode).toHaveBeenCalledWith(
      'abc123',
      state,
      expect.objectContaining({ state })
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

    // Fire-and-forget cache refresh — resolved from the row the DB lookup returns.
    mocks.db.getSavedUsageAccountByProviderEmail.mockReturnValue({ id: 'row-1' })

    // Context stays open ~1.5s so the user sees the Signed-in page.
    expect(driver.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(driver.close).toHaveBeenCalledTimes(1)
    // The close listener must not flip a terminal state.
    expect(loginStatus(loginId).state).toBe('done')

    // The 30-minute waiting timeout is cancelled once a login succeeds — it
    // must not re-fire (or double-close) once the original deadline elapses.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(driver.close).toHaveBeenCalledTimes(1)
    expect(loginStatus(loginId).state).toBe('done')
    expect(loginStatus(loginId).error).toBeNull()
  })

  it('resolves the cache row id via getSavedUsageAccountByProviderEmail and fires fetchForSavedAccount', async () => {
    const driver = createFakeDriver()
    mocks.db.getSavedUsageAccountByProviderEmail.mockReturnValue({ id: 'row-42' })
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')
    const state = new URL(driver.gotoCalls[0]).searchParams.get('state')
    await driver.triggerRoute(`https://console.anthropic.com/oauth/code/callback?code=abc123&state=${state}`)
    await pumpUntil(() => loginStatus(loginId).state === 'done')

    expect(mocks.fetchForSavedAccount).toHaveBeenCalledWith('row-42')
  })

  it('runs the full happy path for an OpenAI (Codex) login', async () => {
    const driver = createFakeDriver()
    mocks.db.getSavedUsageAccountByProviderEmail.mockReturnValue({ id: 'row-2' })
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('openai', 'codex@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')
    expect(driver.launchProfileDirs).toEqual([
      join(mocks.homeDir, '.ccswitch', 'profiles', 'codex-codex@example.com')
    ])

    const gotoUrl = driver.gotoCalls[0]
    expect(gotoUrl.startsWith('https://auth.openai.com/oauth/authorize')).toBe(true)
    const state = new URL(gotoUrl).searchParams.get('state')

    const { fulfill } = await driver.triggerRoute(
      `http://localhost:1455/auth/callback?code=xyz789&state=${state}`
    )
    expect(fulfill).toHaveBeenCalled()

    await pumpUntil(() => loginStatus(loginId).state === 'done')

    expect(mocks.exchangeOpenAICode).toHaveBeenCalledWith('xyz789', expect.objectContaining({ state }))
    expect(mocks.addCodexAccount).toHaveBeenCalledWith('id-token', 'openai-access-token', 'openai-refresh-token')
    expect(mocks.listSavedAccounts).toHaveBeenCalledWith('openai')
    expect(mocks.fetchForSavedAccount).toHaveBeenCalledWith('row-2')
    expect(loginStatus(loginId).email).toBe('codex@example.com')
  })

  it('captures the code via the framenavigated fallback when routing never fires', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')
    const state = new URL(driver.gotoCalls[0]).searchParams.get('state')

    driver.triggerFrameNavigated(`https://console.anthropic.com/oauth/code/callback?code=abc123&state=${state}`)
    await pumpUntil(() => loginStatus(loginId).state === 'done')

    expect(mocks.exchangeAnthropicCode).toHaveBeenCalledWith('abc123', state, expect.any(Object))
    expect(loginStatus(loginId).email).toBe('user@example.com')
  })

  it('ignores a redirect that matches the glob but not the exact redirect prefix', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('openai', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')

    const { fulfill, continue: cont } = await driver.triggerRoute(
      'https://evil.example.com/auth/callback?code=abc123&state=whatever'
    )

    expect(cont).toHaveBeenCalledTimes(1)
    expect(fulfill).not.toHaveBeenCalled()
    expect(loginStatus(loginId).state).toBe('waiting')
    expect(mocks.exchangeOpenAICode).not.toHaveBeenCalled()

    // The framenavigated fallback applies the same prefix check.
    driver.triggerFrameNavigated('https://evil.example.com/auth/callback?code=abc123&state=whatever')
    await vi.advanceTimersByTimeAsync(20)
    expect(loginStatus(loginId).state).toBe('waiting')
    expect(mocks.exchangeOpenAICode).not.toHaveBeenCalled()
  })

  it('fails on a PKCE state mismatch and never calls the token exchange', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')

    await driver.triggerRoute(
      'https://console.anthropic.com/oauth/code/callback?code=abc123&state=totally-wrong-state'
    )
    await pumpUntil(() => loginStatus(loginId).state === 'failed')

    expect(loginStatus(loginId).error).toBe('State mismatch — please retry')
    expect(mocks.exchangeAnthropicCode).not.toHaveBeenCalled()
    expect(mocks.addClaudeAccount).not.toHaveBeenCalled()
    expect(driver.close).toHaveBeenCalledTimes(1)
  })

  it('fails when the provider redirect carries an error query param', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')

    await driver.triggerRoute('https://console.anthropic.com/oauth/code/callback?error=access_denied')
    await pumpUntil(() => loginStatus(loginId).state === 'failed')

    expect(loginStatus(loginId).error).toBe('Provider returned error: access_denied')
    expect(mocks.exchangeAnthropicCode).not.toHaveBeenCalled()
  })

  it('fails when no account email is returned from the Anthropic exchange', async () => {
    mocks.exchangeAnthropicCode.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1,
      account: { uuid: 'uuid-1' }
    })
    const driver = createFakeDriver()
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')
    const state = new URL(driver.gotoCalls[0]).searchParams.get('state')
    await driver.triggerRoute(`https://console.anthropic.com/oauth/code/callback?code=abc123&state=${state}`)
    await pumpUntil(() => loginStatus(loginId).state === 'failed')

    expect(loginStatus(loginId).error).toBe('Login succeeded but no account email was returned')
    expect(mocks.addClaudeAccount).not.toHaveBeenCalled()
  })

  it('fails when the browser window is closed before login completes', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')

    driver.triggerClose()
    await pumpUntil(() => loginStatus(loginId).state === 'failed')

    expect(loginStatus(loginId).error).toBe('Browser closed before login completed')
  })

  it('cancels a non-terminal login; the resulting close does not overwrite the cancelled state', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, loginCancel, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')

    const result = await loginCancel(loginId)

    expect(result).toBe(true)
    expect(driver.close).toHaveBeenCalledTimes(1)
    // Our fake context.close() synchronously fires the 'close' listener — it must not
    // have overwritten the terminal 'cancelled' state set before close() was called.
    expect(loginStatus(loginId).state).toBe('cancelled')
    expect(loginStatus(loginId).error).toBeNull()
  })

  it('loginCancel returns false for an unknown login', async () => {
    const { loginCancel } = await importFresh()
    expect(await loginCancel('does-not-exist')).toBe(false)
  })

  it('loginCancel returns false once the session is already terminal', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, loginCancel, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')
    await loginCancel(loginId)
    expect(loginStatus(loginId).state).toBe('cancelled')

    expect(await loginCancel(loginId)).toBe(false)
  })

  it('throws when a login is already in progress', async () => {
    const driver = createFakeDriver()
    const { loginStart, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const first = loginStart('anthropic', 'user@example.com')
    await expect(loginStart('openai', 'other@example.com')).rejects.toThrow(
      'A login is already in progress'
    )
    await first
  })

  it('lets a new loginStart supersede a terminal session; the old loginId 404s', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId: firstId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(firstId).state === 'waiting')
    const state = new URL(driver.gotoCalls[0]).searchParams.get('state')
    await driver.triggerRoute(`https://console.anthropic.com/oauth/code/callback?code=abc123&state=${state}`)
    await pumpUntil(() => loginStatus(firstId).state === 'done')

    const driver2 = createFakeDriver()
    setLoginBrowserLauncherForTests(driver2.launcher)
    const { loginId: secondId } = await loginStart('openai', 'other@example.com')

    expect(() => loginStatus(firstId)).toThrow('login session not found')
    expect(loginStatus(secondId).state).toBe('launching')
  })

  it('GCs a terminal session after 5 minutes if no new login starts', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, loginCancel, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')
    await loginCancel(loginId)
    expect(loginStatus(loginId).state).toBe('cancelled')

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    expect(() => loginStatus(loginId)).toThrow('login session not found')
  })

  it('fails with a timeout after 30 minutes of waiting, and closes the context', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(loginStatus(loginId).state).toBe('failed')
    expect(loginStatus(loginId).error).toBe('Login timed out')
    expect(driver.close).toHaveBeenCalledTimes(1)
  })

  it('maps a chrome-missing launch error to a friendly failed state', async () => {
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(async () => {
      throw new Error(
        `Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app\nRun "npx patchright install chrome"`
      )
    })

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'failed')

    expect(loginStatus(loginId).error).toBe(
      'Google Chrome is required for sign-in. Please install Chrome and try again.'
    )
  })

  it('surfaces other launch failures with their raw message', async () => {
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(async () => {
      throw new Error('boom: some other launch failure')
    })

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    await pumpUntil(() => loginStatus(loginId).state === 'failed')

    expect(loginStatus(loginId).error).toBe('boom: some other launch failure')
  })

  it('throws on non-macOS platforms', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      const { loginStart } = await importFresh()
      await expect(loginStart('anthropic')).rejects.toThrow(
        'Account sign-in is only supported on macOS'
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('uses the "-new" scratch profile when no email hint is given', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, setLoginBrowserLauncherForTests } = await importFresh()
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic')
    await pumpUntil(() => loginStatus(loginId).state === 'waiting')

    expect(driver.launchProfileDirs).toEqual([
      join(mocks.homeDir, '.ccswitch', 'profiles', 'claude-new')
    ])
  })

  it('isLoginActive reflects whether the current session is non-terminal', async () => {
    const driver = createFakeDriver()
    const { loginStart, loginStatus, loginCancel, isLoginActive, setLoginBrowserLauncherForTests } =
      await importFresh()
    expect(isLoginActive()).toBe(false)
    setLoginBrowserLauncherForTests(driver.launcher)

    const { loginId } = await loginStart('anthropic', 'user@example.com')
    expect(isLoginActive()).toBe(true)

    await pumpUntil(() => loginStatus(loginId).state === 'waiting')
    expect(isLoginActive()).toBe(true)

    await loginCancel(loginId)
    expect(isLoginActive()).toBe(false)
  })
})
