import React from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUsageStore } from '@/stores/useUsageStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    setting: {
      get: vi.fn(),
      set: vi.fn()
    },
    session: {
      get: vi.fn()
    }
  },
  opencodeApi: {
    onStream: vi.fn()
  },
  settingsApi: {
    onSettingsUpdated: vi.fn()
  },
  worktreeApi: {
    onBranchRenamed: vi.fn(),
    onWorktreeCreated: vi.fn()
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
    apiMocks.dbApi.session.get.mockResolvedValue(null)
    apiMocks.settingsApi.onSettingsUpdated.mockReturnValue(vi.fn())
    apiMocks.worktreeApi.onBranchRenamed.mockReturnValue(vi.fn())
    apiMocks.worktreeApi.onWorktreeCreated.mockReturnValue(vi.fn())
    apiMocks.opencodeApi.onStream.mockImplementation(
      (listener: (event: OpenCodeStreamEvent) => void) => {
        streamListener = listener
        return vi.fn()
      }
    )

    useUsageStore.setState({
      anthropicRateLimit: null,
      anthropicLastFetchedAt: null,
      anthropicAccountSwitchedAt: null
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    useSessionStore.setState({
      sessionsByWorktree: new Map(),
      sessionsByConnection: new Map()
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useWorktreeStatusStore.setState({
      sessionStatuses: {}
    } as Partial<ReturnType<typeof useWorktreeStatusStore.getState>>)
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
    // The event must NOT masquerade as a usage fetch: bumping the fetch
    // timestamp would extend the debounce and suppress the very refresh that
    // reveals the account is exhausted.
    expect(useUsageStore.getState().anthropicLastFetchedAt).toBeNull()
  })

  it('attributes events by TURN start: pre-switch or unknown turns are dropped, post-switch turns accepted', async () => {
    const { useOpenCodeGlobalListener } = await import('@/hooks/useOpenCodeGlobalListener')
    function ListenerHarness(): null {
      useOpenCodeGlobalListener()
      return null
    }
    useUsageStore.setState({
      anthropicAccountSwitchedAt: Date.now()
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    render(<ListenerHarness />)

    const data = {
      status: 'rejected',
      resetsAt: Math.floor(Date.now() / 1000) + 1_800,
      rateLimitType: 'five_hour' as const
    }

    // No attributable running turn: discarded (self-heals next prompt).
    streamListener?.({ type: 'session.rate_limit', sessionId: 'session-idle', data })
    expect(useUsageStore.getState().anthropicRateLimit).toBeNull()

    // A turn that began BEFORE the switch captured the previous account's
    // credentials at query start — even in a session created long ago.
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-old-turn': { status: 'working', timestamp: Date.now() - 60_000 }
      }
    } as Partial<ReturnType<typeof useWorktreeStatusStore.getState>>)
    streamListener?.({ type: 'session.rate_limit', sessionId: 'session-old-turn', data })
    expect(useUsageStore.getState().anthropicRateLimit).toBeNull()

    // A turn begun AFTER the switch runs on the new account — a resumed
    // pre-switch session's fresh sdk.query() included. Its rejection is real.
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-new-turn': { status: 'working', timestamp: Date.now() + 5_000 }
      }
    } as Partial<ReturnType<typeof useWorktreeStatusStore.getState>>)
    streamListener?.({ type: 'session.rate_limit', sessionId: 'session-new-turn', data })
    expect(useUsageStore.getState().anthropicRateLimit?.fiveHour?.status).toBe('rejected')
  })

  it('prefers the immutable queryStartedAt stamp over the mutable status timestamp', async () => {
    const { useOpenCodeGlobalListener } = await import('@/hooks/useOpenCodeGlobalListener')
    function ListenerHarness(): null {
      useOpenCodeGlobalListener()
      return null
    }
    useUsageStore.setState({
      anthropicAccountSwitchedAt: Date.now()
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    render(<ListenerHarness />)

    // A pre-switch query blocked on a permission and was restored after the
    // switch: the status timestamp reads post-switch, but the stamped query
    // start is pre-switch — the query still runs on the OLD credentials.
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-restored': { status: 'working', timestamp: Date.now() + 5_000 }
      }
    } as Partial<ReturnType<typeof useWorktreeStatusStore.getState>>)
    streamListener?.({
      type: 'session.rate_limit',
      sessionId: 'session-restored',
      data: {
        status: 'rejected',
        resetsAt: Math.floor(Date.now() / 1000) + 1_800,
        rateLimitType: 'five_hour' as const,
        queryStartedAt: Date.now() - 60_000
      }
    })
    expect(useUsageStore.getState().anthropicRateLimit).toBeNull()

    // And a stamped post-switch query is accepted even when the status
    // entry is missing entirely.
    useWorktreeStatusStore.setState({
      sessionStatuses: {}
    } as Partial<ReturnType<typeof useWorktreeStatusStore.getState>>)
    streamListener?.({
      type: 'session.rate_limit',
      sessionId: 'session-stamped-new',
      data: {
        status: 'rejected',
        resetsAt: Math.floor(Date.now() / 1000) + 1_800,
        rateLimitType: 'five_hour' as const,
        queryStartedAt: Date.now() + 5_000
      }
    })
    expect(useUsageStore.getState().anthropicRateLimit?.fiveHour?.status).toBe('rejected')
  })
})
