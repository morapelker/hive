import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useAccountScheduleRunner,
  __resetAccountScheduleRunnerForTests
} from '../useAccountScheduleRunner'
import { useAccountScheduleStore } from '@/stores/useAccountScheduleStore'
import { useAccountStore } from '@/stores/useAccountStore'
import { usageApi } from '@/api/usage-api'
import type { SavedAccountDTO } from '@shared/types/usage'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { Session } from '@shared/types/session'
import type { UsageData } from '@shared/types/usage'

function makeUsage(fiveHour: number, sevenDay: number): UsageData {
  const futureReset = new Date(Date.now() + 3_600_000).toISOString()
  return {
    five_hour: { utilization: fiveHour, resets_at: futureReset },
    seven_day: { utilization: sevenDay, resets_at: futureReset }
  }
}

vi.mock('@/api/usage-api', () => ({
  usageApi: {
    getClaudeTokenTally: vi.fn().mockResolvedValue({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionCount: 0,
      sampledAt: 0
    })
  }
}))

const runningSession = { id: 'session-1', agent_sdk: 'claude-code' } as unknown as Session

describe('useAccountScheduleRunner usage refresh cadence', () => {
  const initialStatusState = useWorktreeStatusStore.getState()
  const initialSessionState = useSessionStore.getState()
  const initialUsageState = useUsageStore.getState()
  const initialScheduleState = useAccountScheduleStore.getState()

  let fetchUsageForProvider: ReturnType<typeof vi.fn>
  let checkSchedules: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T10:00:00.000Z'))
    // lastAttemptAt + predictor state live at module scope in the runner —
    // without this, one test's fetch attempt suppresses the next test's
    // (clock-reset) cadence expectations.
    __resetAccountScheduleRunnerForTests()

    fetchUsageForProvider = vi.fn().mockResolvedValue(undefined)
    checkSchedules = vi.fn().mockResolvedValue(undefined)

    useWorktreeStatusStore.setState(
      {
        ...initialStatusState,
        sessionStatuses: { 'session-1': { status: 'working', timestamp: Date.now() } }
      },
      true
    )
    useSessionStore.setState(
      {
        ...initialSessionState,
        sessionsByWorktree: new Map([['wt-1', [runningSession]]]),
        sessionsByConnection: new Map()
      },
      true
    )
    useUsageStore.setState({
      ...initialUsageState,
      anthropicUsage: makeUsage(85, 40),
      // The pre-existing usage snapshot came from a real fetch, as it would
      // in the app — seed tests override this explicitly.
      anthropicUsageFromFetch: true,
      anthropicLastFetchedAt: Date.now(),
      fetchUsageForProvider
    })
    useAccountScheduleStore.setState({ schedules: {}, autoSwitch: {}, checkSchedules })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useWorktreeStatusStore.setState(initialStatusState, true)
    useSessionStore.setState(initialSessionState, true)
    useUsageStore.setState(initialUsageState, true)
    useAccountScheduleStore.setState(initialScheduleState, true)
  })

  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('refreshes every 5 minutes while running when no usage switch is armed', async () => {
    renderHook(() => useAccountScheduleRunner())

    await advance(4 * 60_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalled()

    await advance(60_000)
    expect(fetchUsageForProvider).toHaveBeenCalledTimes(1)
    // The default cadence keeps the store's own debounce as the floor.
    expect(fetchUsageForProvider).toHaveBeenCalledWith('anthropic', { minIntervalMs: 180_000 })
  })

  it('refreshes every 2 minutes in the last 10 points before an armed auto-switch threshold', async () => {
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    renderHook(() => useAccountScheduleRunner())

    await advance(90_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalled()

    await advance(30_000)
    expect(fetchUsageForProvider).toHaveBeenCalledTimes(1)
    // Tightened cadences override the 3-minute debounce, or they'd be
    // silently vetoed by the store and never actually fetch.
    expect(fetchUsageForProvider).toHaveBeenCalledWith('anthropic', { minIntervalMs: 120_000 })

    await advance(2 * 60_000)
    expect(fetchUsageForProvider).toHaveBeenCalledTimes(2)
  })

  it('refreshes every minute in the last 3 points before an armed auto-switch threshold', async () => {
    useUsageStore.setState({ anthropicUsage: makeUsage(88, 40) })
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    renderHook(() => useAccountScheduleRunner())

    await advance(30_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalled()

    await advance(30_000)
    expect(fetchUsageForProvider).toHaveBeenCalledTimes(1)
    expect(fetchUsageForProvider).toHaveBeenCalledWith('anthropic', { minIntervalMs: 60_000 })

    await advance(60_000)
    expect(fetchUsageForProvider).toHaveBeenCalledTimes(2)
  })

  it('keeps the 5-minute cadence while usage is still far below the threshold', async () => {
    useUsageStore.setState({ anthropicUsage: makeUsage(40, 30) })
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    renderHook(() => useAccountScheduleRunner())

    await advance(4 * 60_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalled()

    await advance(60_000)
    expect(fetchUsageForProvider).toHaveBeenCalledTimes(1)
  })

  it('refreshes every 2 minutes when near a usage-mode scheduled switch threshold', async () => {
    useAccountScheduleStore.setState({
      schedules: {
        anthropic: {
          provider: 'anthropic',
          accountId: 'acc-2',
          email: 'other@x.com',
          mode: 'usage',
          executeAt: null,
          thresholdPercent: 90,
          createdAt: Date.now()
        }
      }
    })
    renderHook(() => useAccountScheduleRunner())

    await advance(60_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalled()

    await advance(60_000)
    expect(fetchUsageForProvider).toHaveBeenCalledTimes(1)
  })

  const setTallyTokens = (inputTokens: number): void => {
    vi.mocked(usageApi.getClaudeTokenTally).mockResolvedValue({
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionCount: 1,
      sampledAt: 0
    })
  }

  it('pulls an early floored refresh when the disk burn rate projects crossing the threshold before the next poll', async () => {
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    useUsageStore.setState({ anthropicUsage: makeUsage(80, 40) })

    // Mount tick (t=0): first tally sample + anchor at 80% / 10M tokens.
    setTallyTokens(10_000_000)
    renderHook(() => useAccountScheduleRunner())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // A real fetch lands (85% at 12M tokens): the next tick anchors it and
    // calibrates 5 points per 2M tokens.
    setTallyTokens(12_000_000)
    useUsageStore.setState({
      anthropicUsage: makeUsage(85, 40),
      anthropicLastFetchedAt: Date.now() + 30_000,
      anthropicUsageFromFetch: true
    })
    await advance(30_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalled()

    // 2M more tokens in 30s: estimated ≈90% now and far past it by the next
    // scheduled poll → the predictor pulls a real sample at the 30s floor.
    setTallyTokens(14_000_000)
    await advance(30_000)
    expect(fetchUsageForProvider).toHaveBeenCalledTimes(1)
    expect(fetchUsageForProvider).toHaveBeenCalledWith('anthropic', { minIntervalMs: 30_000 })
  })

  it('ignores a lastFetchedAt bump without new usage data (retryAfter back-dating) instead of anchoring stale percent', async () => {
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    useUsageStore.setState({ anthropicUsage: makeUsage(80, 40) })

    setTallyTokens(10_000_000)
    renderHook(() => useAccountScheduleRunner())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // Real fetch lands: calibrates 5 points per 2M tokens at 85% / 12M.
    setTallyTokens(12_000_000)
    useUsageStore.setState({
      anthropicUsage: makeUsage(85, 40),
      anthropicLastFetchedAt: Date.now() + 30_000,
      anthropicUsageFromFetch: true
    })
    await advance(30_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalled()

    // A FAILED fetch with retryAfter back-dates anthropicLastFetchedAt
    // without touching anthropicUsage. Were this treated as a fetch anchor,
    // the predictor would re-baseline 85% against the newer 13M tally and
    // lose both the burn since the real fetch and its slope window.
    setTallyTokens(13_000_000)
    useUsageStore.setState({ anthropicLastFetchedAt: Date.now() + 30_000 - 40_000 })
    await advance(30_000)
    expect(fetchUsageForProvider).toHaveBeenCalledTimes(1)
    expect(fetchUsageForProvider).toHaveBeenCalledWith('anthropic', { minIntervalMs: 30_000 })
  })

  it('anchors at the percent read AFTER the tally await when a fetch lands mid-scan', async () => {
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    useUsageStore.setState({ anthropicUsage: makeUsage(80, 40) })

    setTallyTokens(10_000_000)
    renderHook(() => useAccountScheduleRunner())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // The next tally resolves AFTER a usage fetch completes mid-scan: the
    // anchor must pair the new usage object with its fresh 85%, not with
    // the 80% read before the await (which would zero the calibration delta
    // and permanently skip the correct baseline).
    vi.mocked(usageApi.getClaudeTokenTally).mockImplementation(async () => {
      useUsageStore.setState({
        anthropicUsage: makeUsage(85, 40),
        anthropicUsageFromFetch: true,
        anthropicLastFetchedAt: Date.now()
      })
      return {
        inputTokens: 12_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sessionCount: 1,
        sampledAt: 0
      }
    })
    await advance(30_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalled()

    // Calibration only exists if the anchor used the post-await 85% —
    // with it, this burn projects past the threshold and fires early.
    setTallyTokens(14_000_000)
    await advance(30_000)
    expect(fetchUsageForProvider).toHaveBeenCalledWith('anthropic', { minIntervalMs: 30_000 })
  })

  it('does not treat a post-switch seed as a fetch even when a retryAfter timestamp change coincides', async () => {
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    useUsageStore.setState({ anthropicUsage: makeUsage(80, 40) })

    setTallyTokens(10_000_000)
    renderHook(() => useAccountScheduleRunner())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // Between ticks BOTH a switch seeds anthropicUsage from another
    // account's cache (usage object changes with anthropicUsageFromFetch
    // false) and a failed fetch's retryAfter back-dates
    // anthropicLastFetchedAt. Were timestamps or counters taken as fetch
    // evidence, the seed would calibrate against the previous account's
    // anchor and arm the predictor on garbage.
    setTallyTokens(12_000_000)
    useUsageStore.setState({
      anthropicUsage: makeUsage(85, 40),
      anthropicUsageFromFetch: false,
      anthropicLastFetchedAt: Date.now() + 30_000 - 40_000
    })
    await advance(30_000)

    // Heavy burn afterwards: an (invalid) calibration would now fire an
    // early refresh — a correctly uncalibrated predictor stays quiet.
    setTallyTokens(14_000_000)
    await advance(30_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalledWith('anthropic', {
      minIntervalMs: 30_000
    })
  })

  it('does not mistake a seed for a fetch even when a real fetch landed while the predictor was below the band', async () => {
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    // Below the predictor band (90 - 15 = 75): the predictor is idle and
    // observes none of what follows.
    useUsageStore.setState({ anthropicUsage: makeUsage(60, 40) })
    setTallyTokens(10_000_000)
    renderHook(() => useAccountScheduleRunner())
    await advance(30_000)

    // A real fetch lands (still below the band)…
    useUsageStore.setState({
      anthropicUsage: makeUsage(70, 40),
      anthropicUsageFromFetch: true,
      anthropicLastFetchedAt: Date.now() + 30_000
    })
    // …then a switch seeds another account's cache, jumping into the band.
    useUsageStore.setState({
      anthropicUsage: makeUsage(85, 40),
      anthropicUsageFromFetch: false
    })
    setTallyTokens(12_000_000)
    await advance(30_000)

    // Heavy burn: had the seed been (mis)calibrated as a fetch, the
    // predictor would fire an early refresh now.
    setTallyTokens(14_000_000)
    await advance(30_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalledWith('anthropic', {
      minIntervalMs: 30_000
    })
  })

  it('resets calibration on an account switch even when the seed was overwritten unobserved', async () => {
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    useUsageStore.setState({ anthropicUsage: makeUsage(80, 40) })

    // Calibrate on the FIRST account (5 pts / 2M tokens).
    setTallyTokens(10_000_000)
    renderHook(() => useAccountScheduleRunner())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    setTallyTokens(12_000_000)
    useUsageStore.setState({
      anthropicUsage: makeUsage(85, 40),
      anthropicUsageFromFetch: true,
      anthropicLastFetchedAt: Date.now() + 30_000
    })
    await advance(30_000)

    // A switch happens and its seed is immediately overwritten by the
    // post-switch live refresh (fromFetch: true) — the predictor never sees
    // a non-fetch usage object, only the switch timestamp reveals the hop.
    useUsageStore.setState({
      anthropicAccountSwitchedAt: Date.now(),
      anthropicUsage: makeUsage(85, 40),
      anthropicUsageFromFetch: true,
      anthropicLastFetchedAt: Date.now() + 60_000
    })
    setTallyTokens(13_000_000)
    await advance(30_000)

    // Heavy burn on the NEW account: the old account's calibration must not
    // arm an early refresh — it describes different plan limits.
    setTallyTokens(15_000_000)
    await advance(30_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalledWith('anthropic', {
      minIntervalMs: 30_000
    })
  })

  it('does not early-refresh while the burn rate stays flat', async () => {
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    useUsageStore.setState({ anthropicUsage: makeUsage(80, 40) })

    setTallyTokens(10_000_000)
    renderHook(() => useAccountScheduleRunner())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    setTallyTokens(12_000_000)
    useUsageStore.setState({
      anthropicUsage: makeUsage(85, 40),
      anthropicLastFetchedAt: Date.now() + 30_000,
      anthropicUsageFromFetch: true
    })
    await advance(30_000)

    // Barely any tokens burned since the fetch: projection stays below 90.
    setTallyTokens(12_050_000)
    await advance(30_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalled()
  })

  const savedAccount = (id: string, email: string, fiveHour: number): SavedAccountDTO => ({
    id,
    provider: 'anthropic',
    email,
    last_usage: makeUsage(fiveHour, 10),
    last_fetched_at: new Date().toISOString(),
    status: 'ok',
    last_error: null,
    created_at: new Date().toISOString(),
    plan: null
  })

  it('pre-warms auto-switch candidates inside the near-threshold margin', async () => {
    const refreshAllForProvider = vi.fn().mockResolvedValue([])
    useAccountStore.setState({ anthropicEmail: 'current@x.com' } as Partial<
      ReturnType<typeof useAccountStore.getState>
    >)
    useUsageStore.setState({
      refreshAllForProvider,
      savedAccountsLoaded: { anthropic: true, openai: false },
      savedAccounts: {
        anthropic: [
          savedAccount('acc-1', 'current@x.com', 85),
          savedAccount('acc-2', 'other@x.com', 10)
        ],
        openai: []
      }
    })
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    renderHook(() => useAccountScheduleRunner())

    await advance(30_000)
    expect(refreshAllForProvider).toHaveBeenCalledWith('anthropic', ['acc-1'], {
      maxAgeMs: 150_000
    })
    // Each settled pre-warm re-evaluates schedules (on top of the per-tick
    // call), so a threshold crossing that landed mid-sweep — when the
    // refreshing flag made checkSchedules skip its round — is caught as
    // soon as the sweep ends instead of a full tick later.
    expect(checkSchedules.mock.calls.length).toBe(2 + refreshAllForProvider.mock.calls.length)
  })

  it('does not pre-warm at/above the threshold — the due switch owns the sweep', async () => {
    const refreshAllForProvider = vi.fn().mockResolvedValue([])
    useUsageStore.setState({
      anthropicUsage: makeUsage(92, 40),
      refreshAllForProvider,
      savedAccountsLoaded: { anthropic: true, openai: false },
      savedAccounts: {
        anthropic: [
          savedAccount('acc-1', 'current@x.com', 92),
          savedAccount('acc-2', 'other@x.com', 10)
        ],
        openai: []
      }
    })
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    renderHook(() => useAccountScheduleRunner())

    await advance(60_000)
    expect(refreshAllForProvider).not.toHaveBeenCalled()
  })

  it('rechecks schedules even when the pre-warm sweep fails', async () => {
    const refreshAllForProvider = vi.fn().mockRejectedValue(new Error('ipc down'))
    useAccountStore.setState({ anthropicEmail: 'current@x.com' } as Partial<
      ReturnType<typeof useAccountStore.getState>
    >)
    useUsageStore.setState({
      refreshAllForProvider,
      savedAccountsLoaded: { anthropic: true, openai: false },
      savedAccounts: {
        anthropic: [
          savedAccount('acc-1', 'current@x.com', 85),
          savedAccount('acc-2', 'other@x.com', 10)
        ],
        openai: []
      }
    })
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    renderHook(() => useAccountScheduleRunner())

    await advance(30_000)
    expect(refreshAllForProvider).toHaveBeenCalled()
    // A failed sweep still cleared the refreshing flag with nothing else
    // subscribed to it — the settle-time recheck must fire regardless.
    expect(checkSchedules.mock.calls.length).toBe(2 + refreshAllForProvider.mock.calls.length)
  })

  it('does not pre-warm while usage is still below the near-threshold margin', async () => {
    const refreshAllForProvider = vi.fn().mockResolvedValue([])
    useUsageStore.setState({
      anthropicUsage: makeUsage(70, 40),
      refreshAllForProvider,
      savedAccountsLoaded: { anthropic: true, openai: false },
      savedAccounts: {
        anthropic: [
          savedAccount('acc-1', 'current@x.com', 70),
          savedAccount('acc-2', 'other@x.com', 10)
        ],
        openai: []
      }
    })
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    renderHook(() => useAccountScheduleRunner())

    await advance(60_000)
    expect(refreshAllForProvider).not.toHaveBeenCalled()
  })

  it('never refreshes near the threshold when no session is running', async () => {
    useWorktreeStatusStore.setState({ sessionStatuses: {} })
    useAccountScheduleStore.setState({
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    renderHook(() => useAccountScheduleRunner())

    await advance(10 * 60_000)
    expect(fetchUsageForProvider).not.toHaveBeenCalled()
  })
})
