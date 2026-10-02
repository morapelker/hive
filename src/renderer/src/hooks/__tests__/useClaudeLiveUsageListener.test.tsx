import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeLiveUsagePayload } from '@shared/types/claude-live-usage'

const mocks = vi.hoisted(() => ({
  onClaudeLiveUsage: vi.fn(),
  applyClaudeLiveUsage: vi.fn()
}))

vi.mock('@/api/usage-api', () => ({
  usageApi: { onClaudeLiveUsage: mocks.onClaudeLiveUsage }
}))

vi.mock('@/stores/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ applyClaudeLiveUsage: mocks.applyClaudeLiveUsage }) }
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

    const { unmount } = renderHook(() => useClaudeLiveUsageListener())
    expect(mocks.onClaudeLiveUsage).toHaveBeenCalledTimes(1)

    const callback = mocks.onClaudeLiveUsage.mock.calls[0][0] as (p: ClaudeLiveUsagePayload) => void
    callback(payload)
    expect(mocks.applyClaudeLiveUsage).toHaveBeenCalledWith(payload)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
