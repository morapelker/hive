// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_CLI_AUTO_RESUME_CHANNEL } from '@shared/types/claude-cli-api-error'
import {
  buildResumePrompt,
  ClaudeCliSessionRecovery,
  classifyApiErrorForRecovery,
  isUserTerminalInput,
  summariseApiError,
  type ClaudeCliSessionRecoveryDeps
} from './claude-cli-session-recovery'

const NO_RESPONSE =
  'API Error: No response from API (waited 4m, then 10m on the retry). If a proxy or gateway on your network holds responses until they complete, raise API_TIMEOUT_MS.'

function makeDeps(overrides: Partial<ClaudeCliSessionRecoveryDeps> = {}) {
  const written: Array<{ sessionId: string; prompt: string }> = []
  const published: Array<{ channel: string; payload: unknown }> = []
  const deps: ClaudeCliSessionRecoveryDeps & {
    written: typeof written
    published: typeof published
    probe: ReturnType<typeof vi.fn>
  } = {
    hasLivePty: () => true,
    getLastStatus: () => 'completed',
    getAgentSdk: () => 'claude-code-cli',
    writePrompt: (sessionId, prompt) => {
      written.push({ sessionId, prompt })
      return { delivered: true }
    },
    probe: vi.fn(async () => ({ ok: true, status: 401, ms: 120, error: null })),
    probeUpstream: (timeoutMs) => deps.probe(timeoutMs),
    isEnabled: () => true,
    publish: (channel, payload) => {
      published.push({ channel, payload })
      return true
    },
    log: { info: vi.fn(), warn: vi.fn() },
    mark: vi.fn(),
    initialDelayMs: 1,
    probeIntervalMs: 1,
    settleMs: 0,
    probeTimeoutMs: 10,
    written,
    published,
    ...overrides
  }
  return deps
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 15))

describe('classifyApiErrorForRecovery', () => {
  it('treats hangs, connection losses, sleep and 5xx as transient', () => {
    for (const lastAssistantMessage of [
      NO_RESPONSE,
      'API Error: Connection lost mid-response. The response above may be incomplete.',
      'API Error: Your computer went to sleep mid-response',
      'API Error: 500 Internal server error',
      'API Error: 529 Overloaded'
    ]) {
      expect(
        classifyApiErrorForRecovery({ sessionId: 's', error: 'server_error', lastAssistantMessage })
      ).toBe('transient')
    }
    expect(classifyApiErrorForRecovery({ sessionId: 's', error: 'overloaded' })).toBe('transient')
    expect(classifyApiErrorForRecovery({ sessionId: 's', error: 'unknown' })).toBe('transient')
  })

  it('leaves auth, billing, limits and content filters alone', () => {
    for (const error of ['authentication_failed', 'billing_error', 'invalid_request', 'rate_limit', 'max_output_tokens']) {
      expect(classifyApiErrorForRecovery({ sessionId: 's', error })).toBe('permanent')
    }
    expect(
      classifyApiErrorForRecovery({
        sessionId: 's',
        error: 'server_error',
        lastAssistantMessage: 'API Error: Output blocked by content filtering policy'
      })
    ).toBe('permanent')
    expect(
      classifyApiErrorForRecovery({
        sessionId: 's',
        error: 'unknown',
        lastAssistantMessage: "API Error: Opus 5.5's safeguards flagged this session"
      })
    ).toBe('permanent')
  })
})

describe('resume prompt', () => {
  it('quotes a one-line summary of the failure', () => {
    const summary = summariseApiError({ sessionId: 's', error: 'server_error', lastAssistantMessage: NO_RESPONSE })
    expect(summary).toBe('API Error: No response from API (waited 4m, then 10m on the retry).')
    expect(buildResumePrompt({ sessionId: 's', error: 'server_error', lastAssistantMessage: NO_RESPONSE })).toContain(
      'continue from where you left off'
    )
    expect(summariseApiError({ sessionId: 's', error: 'server_error' })).toBe('server_error')
  })

  it('does not count focus reports or mouse events as the user typing', () => {
    expect(isUserTerminalInput('\x1b[I')).toBe(false)
    expect(isUserTerminalInput('\x1b[O')).toBe(false)
    expect(isUserTerminalInput('\x1b[<64;10;20M')).toBe(false)
    expect(isUserTerminalInput('y')).toBe(true)
    expect(isUserTerminalInput('\r')).toBe(true)
    expect(isUserTerminalInput('\x1b')).toBe(true)
  })
})

describe('ClaudeCliSessionRecovery', () => {
  it('re-prompts an idle session once the API answers again, and tells the renderer', async () => {
    const deps = makeDeps()
    const recovery = new ClaudeCliSessionRecovery(deps)
    recovery.noteApiError({ sessionId: 'a', error: 'server_error', lastAssistantMessage: NO_RESPONSE })
    expect(recovery.pendingSessions()).toEqual(['a'])
    await flush()
    expect(deps.written).toHaveLength(1)
    expect(deps.written[0].sessionId).toBe('a')
    expect(deps.written[0].prompt).toContain('No response from API')
    expect(recovery.pendingSessions()).toEqual([])
    expect(deps.published).toEqual([
      {
        channel: CLAUDE_CLI_AUTO_RESUME_CHANNEL,
        payload: expect.objectContaining({ sessionId: 'a', error: 'server_error' })
      }
    ])
    expect(deps.mark).toHaveBeenCalledWith('session-auto-resume', expect.objectContaining({ sessionId: 'a' }))
    recovery.dispose()
  })

  it('keeps probing while the API is unreachable and resumes when it comes back', async () => {
    const deps = makeDeps()
    let reachable = false
    deps.probe.mockImplementation(async () =>
      reachable ? { ok: true, status: 401, ms: 5, error: null } : { ok: false, status: null, ms: 10, error: 'ENOTFOUND' }
    )
    const recovery = new ClaudeCliSessionRecovery(deps)
    recovery.noteApiError({ sessionId: 'a', error: 'server_error', lastAssistantMessage: NO_RESPONSE })
    await flush()
    expect(deps.written).toHaveLength(0)
    expect(deps.probe.mock.calls.length).toBeGreaterThanOrEqual(2)
    reachable = true
    await flush()
    expect(deps.written).toHaveLength(1)
    recovery.dispose()
  })

  it('leaves a session alone when the user typed into it, when it is busy, or when its PTY is gone', async () => {
    const typed = makeDeps()
    const typedRecovery = new ClaudeCliSessionRecovery(typed)
    typedRecovery.noteApiError({ sessionId: 'a', error: 'server_error', lastAssistantMessage: NO_RESPONSE })
    typedRecovery.noteUserInput('a', 'fix it\r')
    expect(typedRecovery.pendingSessions()).toEqual([])
    await flush()
    expect(typed.written).toHaveLength(0)

    const busy = makeDeps({ getLastStatus: () => 'working' })
    const busyRecovery = new ClaudeCliSessionRecovery(busy)
    busyRecovery.noteApiError({ sessionId: 'b', error: 'server_error', lastAssistantMessage: NO_RESPONSE })
    await flush()
    expect(busy.written).toHaveLength(0)
    expect(busy.mark).toHaveBeenCalledWith(
      'session-auto-resume-cancelled',
      expect.objectContaining({ sessionId: 'b', reason: 'session-busy' })
    )

    const gone = makeDeps({ hasLivePty: () => false })
    const goneRecovery = new ClaudeCliSessionRecovery(gone)
    goneRecovery.noteApiError({ sessionId: 'c', error: 'server_error', lastAssistantMessage: NO_RESPONSE })
    await flush()
    expect(gone.written).toHaveLength(0)
  })

  it('ignores permanent errors, non-CLI sessions and the switch being off', async () => {
    const deps = makeDeps()
    const recovery = new ClaudeCliSessionRecovery(deps)
    recovery.noteApiError({ sessionId: 'a', error: 'authentication_failed' })
    expect(recovery.pendingSessions()).toEqual([])

    const sdk = makeDeps({ getAgentSdk: () => 'claude-code' })
    new ClaudeCliSessionRecovery(sdk).noteApiError({ sessionId: 'b', error: 'server_error' })
    await flush()
    expect(sdk.written).toHaveLength(0)

    const off = makeDeps({ isEnabled: () => false })
    new ClaudeCliSessionRecovery(off).noteApiError({ sessionId: 'c', error: 'server_error' })
    await flush()
    expect(off.written).toHaveLength(0)
  })

  it('stops resuming a session that keeps failing within the hour', async () => {
    const deps = makeDeps({ maxResumesPerHour: 2 })
    const recovery = new ClaudeCliSessionRecovery(deps)
    for (let i = 0; i < 3; i += 1) {
      recovery.noteApiError({ sessionId: 'a', error: 'server_error', lastAssistantMessage: NO_RESPONSE })
      await flush()
    }
    expect(deps.written).toHaveLength(2)
    expect(deps.mark).toHaveBeenCalledWith(
      'session-auto-resume-skipped',
      expect.objectContaining({ sessionId: 'a', reason: 'budget' })
    )
  })

  it('gives up after the maximum wait', async () => {
    let now = 0
    const deps = makeDeps({ now: () => now, maxWaitMs: 1_000 })
    deps.probe.mockResolvedValue({ ok: false, status: null, ms: 1, error: 'down' })
    const recovery = new ClaudeCliSessionRecovery(deps)
    recovery.noteApiError({ sessionId: 'a', error: 'server_error', lastAssistantMessage: NO_RESPONSE })
    now = 5_000
    await flush()
    expect(recovery.pendingSessions()).toEqual([])
    expect(deps.mark).toHaveBeenCalledWith(
      'session-auto-resume-cancelled',
      expect.objectContaining({ reason: 'timeout' })
    )
  })
})
