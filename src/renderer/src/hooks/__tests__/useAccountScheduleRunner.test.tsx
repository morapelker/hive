import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAccountScheduleRunner } from '../useAccountScheduleRunner'
import { useAccountScheduleStore } from '@/stores/useAccountScheduleStore'
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
    expect(fetchUsageForProvider).toHaveBeenCalledWith('anthropic')
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
