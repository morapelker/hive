import React from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUsageStore } from '@/stores/useUsageStore'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

describe('useOpenCodeGlobalListener rate-limit events', () => {
  let streamListener: ((event: OpenCodeStreamEvent) => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-19T09:00:00.000Z'))
    streamListener = null

    Object.defineProperty(window, 'opencodeOps', {
      writable: true,
      configurable: true,
      value: {
        onStream: vi.fn((listener: (event: OpenCodeStreamEvent) => void) => {
          streamListener = listener
          return vi.fn()
        })
      }
    })

    Object.defineProperty(window, 'db', {
      writable: true,
      configurable: true,
      value: {
        setting: {
          get: vi.fn().mockResolvedValue({ success: true, value: null }),
          set: vi.fn().mockResolvedValue({ success: true, value: undefined })
        }
      }
    })

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
