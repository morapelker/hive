import React from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUsageStore } from '@/stores/useUsageStore'
import { useSessionStore } from '@/stores/useSessionStore'
import type { Session } from '@shared/types/session'
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

  it('ignores rate-limit events from sessions created before the last account switch', async () => {
    const { useOpenCodeGlobalListener } = await import('@/hooks/useOpenCodeGlobalListener')
    function ListenerHarness(): null {
      useOpenCodeGlobalListener()
      return null
    }

    // session-old was spawned (with the previous account's credentials)
    // before the switch; session-new after it.
    const oldSession = {
      id: 'session-old',
      created_at: new Date(Date.now() - 60_000).toISOString()
    } as unknown as Session
    const newSession = {
      id: 'session-new',
      created_at: new Date(Date.now() + 5_000).toISOString()
    } as unknown as Session
    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt-1', [oldSession, newSession]]]),
      sessionsByConnection: new Map()
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useUsageStore.setState({
      anthropicAccountSwitchedAt: Date.now()
    } as Partial<ReturnType<typeof useUsageStore.getState>>)

    render(<ListenerHarness />)

    const data = {
      status: 'rejected',
      resetsAt: Math.floor(Date.now() / 1000) + 1_800,
      rateLimitType: 'five_hour' as const
    }
    streamListener?.({ type: 'session.rate_limit', sessionId: 'session-old', data })
    // The zombie session's rejection describes the account we left.
    expect(useUsageStore.getState().anthropicRateLimit).toBeNull()

    streamListener?.({ type: 'session.rate_limit', sessionId: 'session-new', data })
    expect(useUsageStore.getState().anthropicRateLimit?.fiveHour?.status).toBe('rejected')
  })

  it('resolves unknown sessions from the DB post-switch and discards unresolvable events', async () => {
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

    // Unknown everywhere (DB returns null): discarded — falling through
    // would let a still-running pre-switch session poison the new account.
    streamListener?.({ type: 'session.rate_limit', sessionId: 'session-ghost', data })
    await vi.runOnlyPendingTimersAsync()
    expect(useUsageStore.getState().anthropicRateLimit).toBeNull()

    // Known to the DB as created BEFORE the switch: discarded.
    apiMocks.dbApi.session.get.mockResolvedValue({
      created_at: new Date(Date.now() - 60_000).toISOString()
    })
    streamListener?.({ type: 'session.rate_limit', sessionId: 'session-db-old', data })
    await vi.runOnlyPendingTimersAsync()
    expect(useUsageStore.getState().anthropicRateLimit).toBeNull()

    // Known to the DB as created AFTER the switch: accepted.
    apiMocks.dbApi.session.get.mockResolvedValue({
      created_at: new Date(Date.now() + 5_000).toISOString()
    })
    streamListener?.({ type: 'session.rate_limit', sessionId: 'session-db-new', data })
    await vi.runOnlyPendingTimersAsync()
    expect(useUsageStore.getState().anthropicRateLimit?.fiveHour?.status).toBe('rejected')
  })
})
