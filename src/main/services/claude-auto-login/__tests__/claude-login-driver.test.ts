// @vitest-environment node
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoginStage } from '@shared/types/usage'
import { PAGE_PROBE_EXPRESSION, type PageProbe } from '../page-scripts'

const mocks = vi.hoisted(() => ({ launchChrome: vi.fn() }))

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../chrome-launcher', () => ({ launchChrome: mocks.launchChrome }))

const REDIRECT_URI = 'http://localhost:54545/callback'
const CONSENT_URL = 'https://claude.ai/oauth/authorize?x=1'
const SESSION_ID = 'session-1'

interface FakeChrome {
  /** What the page probe answers from now on; null = mid-navigation. */
  setProbe: (probe: PageProbe | null) => void
  /** The page navigates to the loopback callback. */
  navigateToCallback: () => void
  /** `Date.now()` of every trusted mouse press the driver sent. */
  presses: number[]
}

/** A Chrome that answers the CDP calls the driver makes, over the same NUL-framed pipes. */
function fakeChrome(): FakeChrome {
  const toChrome = new PassThrough()
  const fromChrome = new PassThrough()
  const presses: number[] = []
  let probe: PageProbe | null = null
  let buffer = ''

  const emit = (message: Record<string, unknown>): void => {
    fromChrome.write(JSON.stringify(message) + '\0')
  }
  const navigateToCallback = (): void =>
    emit({
      method: 'Page.frameNavigated',
      sessionId: SESSION_ID,
      params: { frame: { url: `${REDIRECT_URI}?code=abc` } }
    })

  const answer = (request: {
    method: string
    params: { expression?: string; type?: string }
  }): unknown => {
    switch (request.method) {
      case 'Target.getTargets':
        return { targetInfos: [{ targetId: 'target-1', type: 'page', url: CONSENT_URL }] }
      case 'Target.attachToTarget':
        return { sessionId: SESSION_ID }
      case 'Runtime.evaluate': {
        if (request.params.expression === PAGE_PROBE_EXPRESSION) return { result: { value: probe } }
        // Anything else here is the lookup of the Authorize button.
        const armed = probe?.kind === 'consent' && probe.enabled === true
        return { result: { value: armed ? { x: 40, y: 60, disabled: false } : null } }
      }
      case 'Input.dispatchMouseEvent':
        if (request.params.type === 'mousePressed') presses.push(Date.now())
        if (request.params.type === 'mouseReleased') navigateToCallback()
        return {}
      default:
        return {}
    }
  }

  toChrome.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let end = buffer.indexOf('\0')
    while (end !== -1) {
      const request = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      emit({ id: request.id, sessionId: request.sessionId, result: answer(request) })
      end = buffer.indexOf('\0')
    }
  })

  mocks.launchChrome.mockResolvedValue({
    process: {},
    cdpWrite: toChrome,
    cdpRead: fromChrome,
    userDataDir: '/tmp/profile-test',
    exited: new Promise<void>(() => {}),
    kill: async () => {}
  })

  return {
    setProbe: (next) => {
      probe = next
    },
    navigateToCallback,
    presses
  }
}

const consent = (enabled: boolean): PageProbe => ({
  kind: 'consent',
  url: CONSENT_URL,
  title: 'Authorize',
  enabled
})

async function startDriver(): Promise<{
  stages: Array<[LoginStage, string | null]>
  finished: Promise<void>
  onBrowserClosed: ReturnType<typeof vi.fn>
}> {
  const { runClaudeAutoLogin } = await import('../claude-login-driver')
  const stages: Array<[LoginStage, string | null]> = []
  const onBrowserClosed = vi.fn()
  const handle = await runClaudeAutoLogin({
    loginId: 'login-1',
    authorizeUrl: CONSENT_URL,
    redirectUri: REDIRECT_URI,
    email: 'someone@example.com',
    settings: {
      enabled: true,
      codeServerUrl: 'http://code-server.invalid',
      apiToken: '',
      codeTimeoutSeconds: 60
    },
    onStage: (stage, detail) => stages.push([stage, detail ?? null]),
    onBrowserClosed,
    isResolved: () => false
  })
  return { stages, finished: handle.finished, onBrowserClosed }
}

describe('claude login driver: the consent page', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    mocks.launchChrome.mockReset()
  })

  it('waits 2 seconds after Authorize becomes clickable before pressing it', async () => {
    const chrome = fakeChrome()
    chrome.setProbe(consent(false))
    const { stages, finished } = await startDriver()

    // Not armed yet: however long that takes, nothing is pressed.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(chrome.presses).toEqual([])
    expect(stages.at(-1)).toEqual(['authorizing', null])

    chrome.setProbe(consent(true))
    const armedAt = Date.now()
    await vi.advanceTimersByTimeAsync(1_900)
    expect(chrome.presses).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(chrome.presses).toHaveLength(1)
    expect(chrome.presses[0] - armedAt).toBeGreaterThanOrEqual(2_000)

    await vi.advanceTimersByTimeAsync(1_000)
    await finished
    expect(stages.map(([stage]) => stage)).not.toContain('needs-human')
  })

  it('does not press when the page moves on during the wait', async () => {
    const chrome = fakeChrome()
    chrome.setProbe(consent(true))
    const { stages, finished, onBrowserClosed } = await startDriver()

    // The user presses Authorize themselves one second into the wait.
    await vi.advanceTimersByTimeAsync(1_000)
    chrome.setProbe(null)
    chrome.navigateToCallback()

    await vi.advanceTimersByTimeAsync(5_000)
    await finished
    expect(chrome.presses).toEqual([])
    expect(stages.map(([stage]) => stage)).not.toContain('needs-human')
    expect(onBrowserClosed).not.toHaveBeenCalled()
  })

  it('waits for Authorize to be clickable again when it is disabled during the wait', async () => {
    const chrome = fakeChrome()
    chrome.setProbe(consent(true))
    await startDriver()

    await vi.advanceTimersByTimeAsync(1_000)
    chrome.setProbe(consent(false))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(chrome.presses).toEqual([])

    chrome.setProbe(consent(true))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(chrome.presses).toHaveLength(1)
  })
})
