import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useAccountScheduleStore, describeSchedule } from '../useAccountScheduleStore'
import { useUsageStore } from '../useUsageStore'
import { useAccountStore } from '../useAccountStore'
import { toast } from '@/lib/toast'
import type { SavedAccountDTO, UsageData } from '@shared/types/usage'

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

function makeAccount(id: string, email: string): SavedAccountDTO {
  return {
    id,
    provider: 'anthropic',
    email,
    last_usage: null,
    last_fetched_at: null,
    status: 'ok',
    last_error: null,
    created_at: new Date().toISOString(),
    plan: null
  }
}

function makeUsage(
  fiveHour: number,
  sevenDay: number,
  resetsAt?: string,
  scoped?: { label: string; used_percent: number; resets_at?: string | null }[]
): UsageData {
  const futureReset = resetsAt ?? new Date(Date.now() + 3_600_000).toISOString()
  return {
    five_hour: { utilization: fiveHour, resets_at: futureReset },
    seven_day: { utilization: sevenDay, resets_at: futureReset },
    ...(scoped
      ? {
          scoped: scoped.map((s) => ({
            label: s.label,
            used_percent: s.used_percent,
            resets_at: s.resets_at === undefined ? futureReset : s.resets_at
          }))
        }
      : {})
  }
}

describe('useAccountScheduleStore', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T10:00:00.000Z'))
    vi.clearAllMocks()

    useAccountScheduleStore.setState({ schedules: {} })
    useAccountStore.setState({ anthropicEmail: 'current@x.com', openaiEmail: null })
    useUsageStore.setState({
      anthropicUsage: null,
      anthropicLastFetchedAt: null,
      anthropicIsLoading: false,
      anthropicLastError: null,
      anthropicLastRetryAfter: null,
      openaiUsage: null,
      openaiIsLoading: false,
      savedAccounts: {
        anthropic: [makeAccount('acc-1', 'current@x.com'), makeAccount('acc-2', 'target@x.com')],
        openai: []
      },
      refreshingProviders: { anthropic: false, openai: false },
      switchingAccountIds: new Set<string>()
    })

    request = vi.fn(async (method: string) => {
      if (method === 'accountOps.switchAccount') return { success: true }
      if (method === 'accountOps.listSaved') return []
      if (method === 'accountOps.getClaudeEmail') return 'target@x.com'
      if (method === 'accountOps.getOpenAIEmail') return null
      if (method === 'usageOps.fetch') return { success: true, data: undefined }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.useRealTimers()
  })

  const switchCalls = (): unknown[][] =>
    request.mock.calls.filter(([method]) => method === 'accountOps.switchAccount')

  it('does not fire a time schedule before it is due, fires it after', async () => {
    useAccountScheduleStore
      .getState()
      .scheduleByTime('anthropic', 'acc-2', 'target@x.com', 30 * 60_000)

    await useAccountScheduleStore.getState().checkSchedules()
    expect(switchCalls()).toHaveLength(0)
    expect(useAccountScheduleStore.getState().schedules.anthropic).toBeDefined()

    vi.setSystemTime(Date.now() + 31 * 60_000)
    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(1)
    expect(switchCalls()[0][1]).toEqual({ accountId: 'acc-2' })
    expect(useAccountScheduleStore.getState().schedules.anthropic).toBeUndefined()
  })

  it('fires a usage schedule only once the active usage crosses the threshold', async () => {
    useAccountScheduleStore.getState().scheduleByUsage('anthropic', 'acc-2', 'target@x.com', 80)

    useUsageStore.setState({ anthropicUsage: makeUsage(60, 20) })
    await useAccountScheduleStore.getState().checkSchedules()
    expect(switchCalls()).toHaveLength(0)

    useUsageStore.setState({ anthropicUsage: makeUsage(85, 20) })
    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(1)
    expect(useAccountScheduleStore.getState().schedules.anthropic).toBeUndefined()
  })

  it('uses the max across usage windows (7d bar can trigger too)', async () => {
    useAccountScheduleStore.getState().scheduleByUsage('anthropic', 'acc-2', 'target@x.com', 80)

    useUsageStore.setState({ anthropicUsage: makeUsage(10, 91) })
    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(1)
  })

  it('includes scoped bars (e.g. Fable) when finding the highest usage', async () => {
    useAccountScheduleStore.getState().scheduleByUsage('anthropic', 'acc-2', 'target@x.com', 80)

    // 5h and 7d are below the threshold; only the scoped model bar is above.
    useUsageStore.setState({
      anthropicUsage: makeUsage(50, 60, undefined, [{ label: 'Fable', used_percent: 85 }])
    })
    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(1)
    expect(useAccountScheduleStore.getState().schedules.anthropic).toBeUndefined()
  })

  it('ignores a stale scoped bar whose reset time is in the past', async () => {
    useAccountScheduleStore.getState().scheduleByUsage('anthropic', 'acc-2', 'target@x.com', 80)

    const pastReset = new Date(Date.now() - 3_600_000).toISOString()
    useUsageStore.setState({
      anthropicUsage: makeUsage(50, 60, undefined, [
        { label: 'Fable', used_percent: 95, resets_at: pastReset }
      ])
    })
    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(0)
    expect(useAccountScheduleStore.getState().schedules.anthropic).toBeDefined()
  })

  it('ignores stale usage whose reset time is in the past', async () => {
    useAccountScheduleStore.getState().scheduleByUsage('anthropic', 'acc-2', 'target@x.com', 80)

    const pastReset = new Date(Date.now() - 3_600_000).toISOString()
    useUsageStore.setState({ anthropicUsage: makeUsage(95, 95, pastReset) })
    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(0)
    expect(useAccountScheduleStore.getState().schedules.anthropic).toBeDefined()
  })

  it('drops the schedule without switching when the target account is already active', async () => {
    useAccountScheduleStore.getState().scheduleByTime('anthropic', 'acc-2', 'target@x.com', 1_000)
    useAccountStore.setState({ anthropicEmail: 'target@x.com' })

    vi.setSystemTime(Date.now() + 2_000)
    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(0)
    expect(useAccountScheduleStore.getState().schedules.anthropic).toBeUndefined()
  })

  it('cancels with an error toast when the target account no longer exists', async () => {
    useAccountScheduleStore.getState().scheduleByTime('anthropic', 'gone-id', 'gone@x.com', 1_000)

    vi.setSystemTime(Date.now() + 2_000)
    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(0)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('gone@x.com'))
    expect(useAccountScheduleStore.getState().schedules.anthropic).toBeUndefined()
  })

  it('replaces an existing schedule for the provider and supports cancel', () => {
    const store = useAccountScheduleStore.getState()
    store.scheduleByTime('anthropic', 'acc-2', 'target@x.com', 60_000)
    store.scheduleByUsage('anthropic', 'acc-1', 'current@x.com', 70)

    const schedule = useAccountScheduleStore.getState().schedules.anthropic
    expect(schedule?.mode).toBe('usage')
    expect(schedule?.accountId).toBe('acc-1')
    expect(schedule?.thresholdPercent).toBe(70)

    useAccountScheduleStore.getState().cancelSchedule('anthropic')
    expect(useAccountScheduleStore.getState().schedules.anthropic).toBeUndefined()
  })

  it('describeSchedule renders time countdowns and usage thresholds', () => {
    const now = Date.now()
    expect(
      describeSchedule(
        {
          provider: 'anthropic',
          accountId: 'a',
          email: null,
          mode: 'time',
          executeAt: now + 90 * 60_000,
          thresholdPercent: null,
          createdAt: now
        },
        now
      )
    ).toBe('in 1h 30m')
    expect(
      describeSchedule(
        {
          provider: 'anthropic',
          accountId: 'a',
          email: null,
          mode: 'usage',
          executeAt: null,
          thresholdPercent: 85,
          createdAt: now
        },
        now
      )
    ).toBe('at 85% usage')
  })
})
