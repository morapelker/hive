import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import type {
  ClaudeLiveUsageHealthPayload,
  ClaudeLiveUsagePayload
} from '@shared/types/claude-live-usage'
import type { SavedAccountDTO, UsageData } from '@shared/types/usage'
import { useUsageStore } from '../useUsageStore'
import { useAccountStore } from '../useAccountStore'

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

vi.mock('@/lib/hive-account-report', () => ({
  reportActiveAccountsSnapshot: vi.fn()
}))

const NOW = new Date('2026-10-02T01:00:00.000Z').getTime()

const polledUsage: UsageData = {
  five_hour: { utilization: 70, resets_at: '2026-10-02T03:00:00.000Z' },
  seven_day: { utilization: 20, resets_at: '2026-10-05T10:00:00.000Z' },
  extra_usage: { is_enabled: true, utilization: 5, used_credits: 1, monthly_limit: 10 }
}

function account(id: string, email: string, usage: UsageData | null): SavedAccountDTO {
  return {
    id,
    provider: 'anthropic',
    email,
    last_usage: usage,
    last_fetched_at: '2026-10-02T00:00:00.000Z',
    status: 'error',
    last_error: 'stale',
    created_at: '2026-01-01T00:00:00.000Z',
    plan: 'max'
  }
}

function payload(overrides: Partial<ClaudeLiveUsagePayload> = {}): ClaudeLiveUsagePayload {
  return {
    provider: 'anthropic',
    accountId: 'row-a',
    email: 'a@example.com',
    accountUuid: '718fd88e-2076-4451-bc5f-066158379585',
    isLiveAccount: true,
    liveEmail: 'a@example.com',
    usage: {
      five_hour: { utilization: 42, resets_at: '2026-10-02T05:00:00.000Z' },
      seven_day: { utilization: 61, resets_at: '2026-10-05T10:00:00.000Z' },
      extra_usage: polledUsage.extra_usage
    },
    rateLimit: {
      fiveHour: { status: 'allowed', resetsAt: Math.floor(NOW / 1000) + 4 * 3600 },
      sevenDay: { status: 'allowed_warning', resetsAt: Math.floor(NOW / 1000) + 3 * 86400 }
    },
    observedAt: NOW,
    ...overrides
  }
}

describe('useUsageStore.applyClaudeLiveUsage', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    request = vi.fn(async (method: string) => {
      if (method === 'accountOps.getClaudeEmail') return 'a@example.com'
      if (method === 'accountOps.listSaved') return []
      if (method === 'usageOps.fetch') return { success: false, error: 'offline' }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    useAccountStore.setState({ anthropicEmail: 'a@example.com' })
    useUsageStore.setState({
      anthropicUsage: polledUsage,
      anthropicLastFetchedAt: NOW - 60_000,
      anthropicIsLoading: false,
      anthropicLastError: 'Usage API returned 429',
      anthropicLastRetryAfter: 30,
      anthropicRateLimit: {
        fiveHour: { status: 'rejected', resetsAt: Math.floor(NOW / 1000) + 3600 },
        updatedAt: NOW - 60_000
      },
      anthropicUsageFromFetch: false,
      anthropicAccountSwitchedAt: null,
      anthropicEarlyRefreshAttemptAt: null,
      anthropicLiveUpdatedAt: null,
      anthropicLiveSessionId: null,
      anthropicLiveDegradedSessions: {},
      savedAccounts: {
        anthropic: [
          account('row-a', 'a@example.com', polledUsage),
          account('row-b', 'b@example.com', null)
        ],
        openai: []
      },
      savedAccountsLoaded: { anthropic: true, openai: false }
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('updates the attributed row snapshot and, for the live account, the bar and overlay', async () => {
    useUsageStore.getState().applyClaudeLiveUsage(payload())
    await vi.runAllTimersAsync()

    const state = useUsageStore.getState()
    const rowA = state.savedAccounts.anthropic.find((row) => row.id === 'row-a')!
    expect(rowA.last_usage).toEqual(payload().usage)
    // The poll's bookkeeping on the row is not ours to touch.
    expect(rowA.last_fetched_at).toBe('2026-10-02T00:00:00.000Z')
    expect(rowA.status).toBe('error')
    expect(state.savedAccounts.anthropic.find((row) => row.id === 'row-b')!.last_usage).toBeNull()

    expect(state.anthropicUsage).toEqual(payload().usage)
    expect(state.anthropicUsageFromFetch).toBe(true)
    expect(state.anthropicLiveUpdatedAt).toBe(NOW)
    // The usage-endpoint poll keeps its own clock and its Retry-After state —
    // including the error that announces the pending deadline.
    expect(state.anthropicLastFetchedAt).toBe(NOW - 60_000)
    expect(state.anthropicLastRetryAfter).toBe(30)
    expect(state.anthropicLastError).toBe('Usage API returned 429')
    // The stale rejected 5h overlay is replaced by the response's own verdict.
    expect(state.anthropicRateLimit?.fiveHour).toMatchObject({ status: 'allowed' })
    expect(state.anthropicRateLimit?.sevenDay).toMatchObject({ status: 'allowed_warning' })
    // Neither the update nor the warning window issued a poll.
    expect(request).not.toHaveBeenCalledWith('usageOps.fetch', expect.anything())
    expect(state.anthropicEarlyRefreshAttemptAt).toBeNull()
  })

  it('keeps five_hour null for an account whose plan has no 5h window', async () => {
    // Plans without the 5h limit get no `-5h-*` headers: the main process then
    // publishes `five_hour: null` and no fiveHour rate-limit window. The null
    // must reach the bar and the row untouched (it is what hides the 5h bar),
    // and no 5h overlay may be conjured for a window that doesn't exist.
    useUsageStore.setState({ anthropicRateLimit: null })
    const noFiveHour = payload({
      usage: {
        five_hour: null,
        seven_day: { utilization: 6, resets_at: '2026-11-06T15:00:00.000Z' }
      },
      rateLimit: {
        sevenDay: { status: 'allowed', resetsAt: Math.floor(NOW / 1000) + 3 * 86400 }
      }
    })

    useUsageStore.getState().applyClaudeLiveUsage(noFiveHour)
    await vi.runAllTimersAsync()

    const state = useUsageStore.getState()
    expect(state.anthropicUsage).toEqual(noFiveHour.usage)
    expect(state.anthropicUsage?.five_hour).toBeNull()
    expect(state.anthropicUsage?.seven_day?.utilization).toBe(6)
    const rowA = state.savedAccounts.anthropic.find((row) => row.id === 'row-a')!
    expect(rowA.last_usage).toEqual(noFiveHour.usage)
    expect(rowA.last_usage).toMatchObject({ five_hour: null })
    expect(state.anthropicRateLimit?.fiveHour).toBeUndefined()
    expect(state.anthropicRateLimit?.sevenDay).toMatchObject({ status: 'allowed' })
  })

  it('clears a stale poll error once no Retry-After deadline is pending', () => {
    useUsageStore.setState({ anthropicLastRetryAfter: null, anthropicLastError: 'offline' })
    useUsageStore.getState().applyClaudeLiveUsage(payload())
    expect(useUsageStore.getState().anthropicLastError).toBeNull()
  })

  it('leaves the bar alone when the main process says the account is not the live one', () => {
    useUsageStore
      .getState()
      .applyClaudeLiveUsage(
        payload({ accountId: 'row-b', email: 'b@example.com', isLiveAccount: false })
      )

    const state = useUsageStore.getState()
    expect(state.savedAccounts.anthropic.find((row) => row.id === 'row-b')!.last_usage).toEqual(
      payload().usage
    )
    expect(state.anthropicUsage).toBe(polledUsage)
    expect(state.anthropicLiveUpdatedAt).toBeNull()
    expect(state.anthropicRateLimit?.fiveHour).toMatchObject({ status: 'rejected' })
  })

  it('drops a live verdict observed before this renderer stamped its switch', () => {
    useUsageStore.setState({ anthropicAccountSwitchedAt: NOW - 1_000 })
    useUsageStore.getState().applyClaudeLiveUsage(payload({ observedAt: NOW - 2_000 }))
    expect(useUsageStore.getState().anthropicUsage).toBe(polledUsage)
    expect(useUsageStore.getState().anthropicLiveUpdatedAt).toBeNull()

    useUsageStore.getState().applyClaudeLiveUsage(payload({ observedAt: NOW }))
    expect(useUsageStore.getState().anthropicUsage).toEqual(payload().usage)
  })

  it('syncs a lagging cached active email from the identity the main process saw', () => {
    // Switched to B, but the renderer's email refresh has not landed yet.
    useUsageStore.setState({ anthropicAccountSwitchedAt: NOW - 500 })
    useUsageStore
      .getState()
      .applyClaudeLiveUsage(
        payload({ accountId: 'row-b', email: 'b@example.com', liveEmail: 'b@example.com' })
      )

    expect(useAccountStore.getState().anthropicEmail).toBe('b@example.com')
    expect(useUsageStore.getState().anthropicUsage).toEqual(payload().usage)
    expect(useUsageStore.getState().anthropicLiveUpdatedAt).toBe(NOW)
    expect(request).not.toHaveBeenCalledWith('accountOps.getClaudeEmail', expect.anything())
  })

  it('applies when the identity was never loaded, seeding the active email', () => {
    useAccountStore.setState({ anthropicEmail: null })
    useUsageStore.getState().applyClaudeLiveUsage(payload())
    expect(useAccountStore.getState().anthropicEmail).toBe('a@example.com')
    expect(useUsageStore.getState().anthropicLiveUpdatedAt).toBe(NOW)
  })

  it('reloads the saved list when the attributed account is not in it yet', async () => {
    useUsageStore
      .getState()
      .applyClaudeLiveUsage(payload({ accountId: 'row-c', email: 'c@example.com' }))
    await vi.runAllTimersAsync()
    expect(request).toHaveBeenCalledWith('accountOps.listSaved', { provider: 'anthropic' })
  })

  it('a later switch clears the live marker so the predictor and label reset', () => {
    useUsageStore.getState().applyClaudeLiveUsage(payload())
    expect(useUsageStore.getState().anthropicLiveUpdatedAt).toBe(NOW)

    useUsageStore.getState().noteExternalAnthropicAccountSwitch()
    expect(useUsageStore.getState().anthropicLiveUpdatedAt).toBeNull()
  })
})

// Code Mode T18: a session whose debug log stops giving readings falls back to the poll,
// and the usage UI must not go on saying "Live" on the strength of that session.
describe('useUsageStore.applyClaudeLiveUsageHealth', () => {
  const CODE_MODE_SESSION = 'session-code-mode'
  const OTHER_SESSION = 'session-other'

  function health(
    overrides: Partial<ClaudeLiveUsageHealthPayload> = {}
  ): ClaudeLiveUsageHealthPayload {
    return {
      provider: 'anthropic',
      sessionId: CODE_MODE_SESSION,
      degraded: true,
      reason: 'hard-cap',
      at: NOW,
      ...overrides
    }
  }

  const store = (): ReturnType<typeof useUsageStore.getState> => useUsageStore.getState()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const request: ReturnType<typeof vi.fn> = vi.fn(async () => null)
    setRendererRpcClient({ request, subscribe: vi.fn() })
    useAccountStore.setState({ anthropicEmail: 'a@example.com' })
    useUsageStore.setState({
      anthropicUsage: polledUsage,
      anthropicLastFetchedAt: NOW - 60_000,
      anthropicLastError: null,
      anthropicLastRetryAfter: null,
      anthropicRateLimit: null,
      anthropicUsageFromFetch: true,
      anthropicAccountSwitchedAt: null,
      anthropicEarlyRefreshAttemptAt: null,
      anthropicLiveUpdatedAt: null,
      anthropicLiveSessionId: null,
      anthropicLiveDegradedSessions: {},
      savedAccounts: {
        anthropic: [account('row-a', 'a@example.com', polledUsage)],
        openai: []
      },
      savedAccountsLoaded: { anthropic: true, openai: false }
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('remembers which session a live reading came from', () => {
    store().applyClaudeLiveUsage(payload({ sessionId: CODE_MODE_SESSION, observedAt: NOW - 500 }))
    expect(store().anthropicLiveUpdatedAt).toBe(NOW)
    expect(store().anthropicLiveSessionId).toBe(CODE_MODE_SESSION)

    // A reading the proxy saw names no session.
    store().applyClaudeLiveUsage(payload())
    expect(store().anthropicLiveSessionId).toBeNull()
  })

  it('takes the live mark back when the session behind it stops giving readings', () => {
    store().applyClaudeLiveUsage(payload({ sessionId: CODE_MODE_SESSION, observedAt: NOW - 500 }))
    const fetchedAt = store().anthropicLastFetchedAt

    store().applyClaudeLiveUsageHealth(health())

    expect(store().anthropicLiveUpdatedAt).toBeNull()
    expect(store().anthropicLiveSessionId).toBeNull()
    // The numbers it gave stay until the poll brings newer ones, and the poll's own clock
    // was never touched: it runs on its normal schedule.
    expect(store().anthropicUsage?.seven_day?.utilization).toBe(61)
    expect(store().anthropicLastFetchedAt).toBe(fetchedAt)
  })

  it('keeps the live mark of a reading the proxy saw, or of another session', () => {
    store().applyClaudeLiveUsage(payload())
    store().applyClaudeLiveUsageHealth(health())
    expect(store().anthropicLiveUpdatedAt).toBe(NOW)

    store().applyClaudeLiveUsage(payload({ sessionId: OTHER_SESSION }))
    store().applyClaudeLiveUsageHealth(health({ reason: 'log-empty' }))
    expect(store().anthropicLiveUpdatedAt).toBe(NOW)
    expect(store().anthropicLiveSessionId).toBe(OTHER_SESSION)
  })

  it('does not call a reading live that the degraded session gave before it went quiet', () => {
    store().applyClaudeLiveUsageHealth(health({ at: NOW }))

    // Still on its way when the log was given up: updates are coalesced before they are sent.
    store().applyClaudeLiveUsage(
      payload({
        sessionId: CODE_MODE_SESSION,
        observedAt: NOW - 200,
        usage: {
          five_hour: { utilization: 44, resets_at: null },
          seven_day: { utilization: 62, resets_at: null }
        }
      })
    )

    // Its numbers count, its being live does not.
    expect(store().anthropicUsage?.seven_day?.utilization).toBe(62)
    expect(store().anthropicLiveUpdatedAt).toBeNull()
    expect(store().anthropicLiveDegradedSessions).toEqual({ [CODE_MODE_SESSION]: NOW })
  })

  it('is live again with the first reading after the session recovered', () => {
    store().applyClaudeLiveUsage(payload({ sessionId: CODE_MODE_SESSION, observedAt: NOW - 500 }))
    store().applyClaudeLiveUsageHealth(health({ at: NOW }))
    expect(store().anthropicLiveUpdatedAt).toBeNull()

    vi.setSystemTime(NOW + 30_000)
    store().applyClaudeLiveUsageHealth(health({ degraded: false, reason: null, at: NOW + 30_000 }))
    // Being healthy again is not a reading: nothing is live until one arrives.
    expect(store().anthropicLiveUpdatedAt).toBeNull()
    expect(store().anthropicLiveDegradedSessions).toEqual({})

    store().applyClaudeLiveUsage(
      payload({ sessionId: CODE_MODE_SESSION, observedAt: NOW + 29_900 })
    )
    expect(store().anthropicLiveUpdatedAt).toBe(NOW + 30_000)
    expect(store().anthropicLiveSessionId).toBe(CODE_MODE_SESSION)
  })

  it('takes a reading newer than the degradation as the recovery, should its notice be late', () => {
    store().applyClaudeLiveUsageHealth(health({ at: NOW }))
    vi.setSystemTime(NOW + 10_000)

    store().applyClaudeLiveUsage(payload({ sessionId: CODE_MODE_SESSION, observedAt: NOW + 9_000 }))

    expect(store().anthropicLiveUpdatedAt).toBe(NOW + 10_000)
    expect(store().anthropicLiveDegradedSessions).toEqual({})
  })

  it('leaves a session that never gave a reading without a live mark to take back', () => {
    // An empty log after the first turn: there was nothing live to begin with.
    store().applyClaudeLiveUsageHealth(health({ reason: 'log-empty' }))

    expect(store().anthropicLiveUpdatedAt).toBeNull()
    expect(store().anthropicUsage).toEqual(polledUsage)
    expect(store().anthropicLastFetchedAt).toBe(NOW - 60_000)
  })

  it('forgets the oldest marks rather than keeping every session that ever degraded', () => {
    for (let index = 0; index < 80; index += 1) {
      store().applyClaudeLiveUsageHealth(health({ sessionId: `session-${index}`, at: NOW + index }))
    }

    const kept = Object.keys(store().anthropicLiveDegradedSessions)
    expect(kept).toHaveLength(64)
    expect(kept[0]).toBe('session-16')
    expect(kept.at(-1)).toBe('session-79')
  })

  it('clears the live mark and the session behind it on an account switch', () => {
    store().applyClaudeLiveUsage(payload({ sessionId: CODE_MODE_SESSION }))
    store().noteExternalAnthropicAccountSwitch()

    expect(store().anthropicLiveUpdatedAt).toBeNull()
    expect(store().anthropicLiveSessionId).toBeNull()
  })
})
