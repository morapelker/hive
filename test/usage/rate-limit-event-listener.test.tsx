import React from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUsageStore } from '@/stores/useUsageStore'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    setting: {
      get: vi.fn(),
      set: vi.fn()
    }
  },
  opencodeApi: {
    onStream: vi.fn()
  },
  settingsApi: {
    onSettingsUpdated: vi.fn()
  },
  worktreeApi: {
    onBranchRenamed: vi.fn()
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: apiMocks.dbApi
}))

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: apiMocks.opencodeApi
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

vi.mock('@/api/worktree-api', () => ({
  worktreeApi: apiMocks.worktreeApi
}))

describe('useOpenCodeGlobalListener rate-limit events', () => {
  let streamListener: ((event: OpenCodeStreamEvent) => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-19T09:00:00.000Z'))
    streamListener = null

    vi.clearAllMocks()
    apiMocks.dbApi.setting.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.set.mockResolvedValue(true)
    apiMocks.settingsApi.onSettingsUpdated.mockReturnValue(vi.fn())
    apiMocks.worktreeApi.onBranchRenamed.mockReturnValue(vi.fn())
    apiMocks.opencodeApi.onStream.mockImplementation(
      (listener: (event: OpenCodeStreamEvent) => void) => {
        streamListener = listener
        return vi.fn()
      }
    )

    useUsageStore.setState({
      anthropicRateLimit: null,
      anthropicLastFetchedAt: null
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores streamed Claude Code rate-limit events as fresh Anthropic usage state', async () => {
    const { useOpenCodeGlobalListener } = await import('@/hooks/useOpenCodeGlobalListener')
    function ListenerHarness(): null {
      useOpenCodeGlobalListener()
      return null
    }

    render(<ListenerHarness />)

    streamListener?.({
      type: 'session.rate_limit',
      sessionId: 'session-1',
      data: {
        status: 'rejected',
        resetsAt: Math.floor(Date.now() / 1000) + 1_800,
        rateLimitType: 'five_hour',
        isUsingOverage: false,
        overageStatus: 'rejected'
      }
    })

    expect(useUsageStore.getState().anthropicRateLimit).toMatchObject({
      fiveHour: {
        status: 'rejected',
        resetsAt: Math.floor(Date.now() / 1000) + 1_800,
        isUsingOverage: false,
        overageStatus: 'rejected'
      },
      updatedAt: Date.now()
    })
    expect(useUsageStore.getState().anthropicLastFetchedAt).toBe(Date.now())
  })
})
