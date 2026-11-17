import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeLiveUsageHealthPayload,
  ClaudeLiveUsagePayload
} from '@shared/types/claude-live-usage'

const mocks = vi.hoisted(() => ({
  onClaudeLiveUsage: vi.fn(),
  onClaudeLiveUsageHealth: vi.fn(),
  applyClaudeLiveUsage: vi.fn(),
  applyClaudeLiveUsageHealth: vi.fn()
}))

vi.mock('@/api/usage-api', () => ({
  usageApi: {
    onClaudeLiveUsage: mocks.onClaudeLiveUsage,
    onClaudeLiveUsageHealth: mocks.onClaudeLiveUsageHealth
  }
}))

vi.mock('@/stores/useUsageStore', () => ({
  useUsageStore: {
    getState: () => ({
      applyClaudeLiveUsage: mocks.applyClaudeLiveUsage,
      applyClaudeLiveUsageHealth: mocks.applyClaudeLiveUsageHealth
    })
  }
}))

import { useClaudeLiveUsageListener } from '../useClaudeLiveUsageListener'

const payload: ClaudeLiveUsagePayload = {
  provider: 'anthropic',
  accountId: 'row-a',
  email: 'a@example.com',
  accountUuid: '718fd88e-2076-4451-bc5f-066158379585',
  isLiveAccount: true,
  liveEmail: 'a@example.com',
  usage: {
    five_hour: { utilization: 3, resets_at: null },
    seven_day: { utilization: 39, resets_at: null }
  },
  rateLimit: {},
  observedAt: 1
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('useClaudeLiveUsageListener', () => {
  it('forwards live usage events into the store and unsubscribes on unmount', () => {
    const unsubscribe = vi.fn()
    mocks.onClaudeLiveUsage.mockReturnValue(unsubscribe)
    mocks.onClaudeLiveUsageHealth.mockReturnValue(vi.fn())

    const { unmount } = renderHook(() => useClaudeLiveUsageListener())
    expect(mocks.onClaudeLiveUsage).toHaveBeenCalledTimes(1)

    const callback = mocks.onClaudeLiveUsage.mock.calls[0][0] as (p: ClaudeLiveUsagePayload) => void
    callback(payload)
    expect(mocks.applyClaudeLiveUsage).toHaveBeenCalledWith(payload)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('forwards the health of Code Mode debug logs into the store and unsubscribes on unmount', () => {
    const unsubscribe = vi.fn()
    mocks.onClaudeLiveUsage.mockReturnValue(vi.fn())
    mocks.onClaudeLiveUsageHealth.mockReturnValue(unsubscribe)

    const { unmount } = renderHook(() => useClaudeLiveUsageListener())
    expect(mocks.onClaudeLiveUsageHealth).toHaveBeenCalledTimes(1)

    const degraded: ClaudeLiveUsageHealthPayload = {
      provider: 'anthropic',
      sessionId: 'session-1',
      degraded: true,
      reason: 'log-empty',
      at: 1
    }
    const callback = mocks.onClaudeLiveUsageHealth.mock.calls[0][0] as (
      p: ClaudeLiveUsageHealthPayload
    ) => void
    callback(degraded)
    expect(mocks.applyClaudeLiveUsageHealth).toHaveBeenCalledWith(degraded)
    expect(mocks.applyClaudeLiveUsage).not.toHaveBeenCalled()

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
