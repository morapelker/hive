import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeLiveUsageHealthPayload,
  ClaudeLiveUsagePayload
} from '@shared/types/claude-live-usage'

const mocks = vi.hoisted(() => ({
  onClaudeLiveUsage: vi.fn(),
  onClaudeLiveUsageHealth: vi.fn(),
  onClaudeCodeModeUsageUnavailable: vi.fn(),
  claimClaudeCodeModeUsageUnavailableNotice: vi.fn(),
  applyClaudeLiveUsage: vi.fn(),
  applyClaudeLiveUsageHealth: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('@/api/usage-api', () => ({
  usageApi: {
    onClaudeLiveUsage: mocks.onClaudeLiveUsage,
    onClaudeLiveUsageHealth: mocks.onClaudeLiveUsageHealth,
    onClaudeCodeModeUsageUnavailable: mocks.onClaudeCodeModeUsageUnavailable,
    claimClaudeCodeModeUsageUnavailableNotice: mocks.claimClaudeCodeModeUsageUnavailableNotice
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: { warning: mocks.toastWarning }
}))

vi.mock('@/stores/useUsageStore', () => ({
  useUsageStore: {
    getState: () => ({
      applyClaudeLiveUsage: mocks.applyClaudeLiveUsage,
      applyClaudeLiveUsageHealth: mocks.applyClaudeLiveUsageHealth
    })
  }
}))

import {
  CODE_MODE_USAGE_UNAVAILABLE_TITLE,
  CODE_MODE_USAGE_UNAVAILABLE_TOAST_ID,
  codeModeUsageUnavailableDescription,
  useClaudeLiveUsageListener
} from '../useClaudeLiveUsageListener'

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

beforeEach(() => {
  mocks.onClaudeLiveUsage.mockReturnValue(vi.fn())
  mocks.onClaudeLiveUsageHealth.mockReturnValue(vi.fn())
  mocks.onClaudeCodeModeUsageUnavailable.mockReturnValue(vi.fn())
  mocks.claimClaudeCodeModeUsageUnavailableNotice.mockResolvedValue(null)
})

afterEach(() => {
  vi.resetAllMocks()
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

  describe('when live usage in Code Mode is switched off for the installed Claude Code (T19)', () => {
    const notice = { provider: 'anthropic' as const, cliVersion: '2.1.326' }

    /** Mount the listener and return what delivers the cue from the main process. */
    const mount = (): { cue: () => void; unmount: () => void } => {
      const { unmount } = renderHook(() => useClaudeLiveUsageListener())
      const cue = mocks.onClaudeCodeModeUsageUnavailable.mock.calls[0][0] as (
        payload: typeof notice
      ) => void
      return { cue: () => cue(notice), unmount }
    }

    it('says nothing until the cue comes: mounting claims nothing', () => {
      mount()

      expect(mocks.onClaudeCodeModeUsageUnavailable).toHaveBeenCalledTimes(1)
      expect(mocks.claimClaudeCodeModeUsageUnavailableNotice).not.toHaveBeenCalled()
      expect(mocks.toastWarning).not.toHaveBeenCalled()
    })

    it('claims the notice and tells the person in plain words, with the version', async () => {
      mocks.claimClaudeCodeModeUsageUnavailableNotice.mockResolvedValueOnce(notice)
      const { cue } = mount()

      cue()

      await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalledTimes(1))
      const [title, options] = mocks.toastWarning.mock.calls[0] as [
        string,
        { id: string; description: string; duration: number; closeButton: boolean }
      ]
      expect(title).toBe('Live usage is unavailable in Code Mode with this version of Claude Code')
      expect(title).toBe(CODE_MODE_USAGE_UNAVAILABLE_TITLE)
      expect(options.description).toBe(codeModeUsageUnavailableDescription('2.1.326'))
      expect(options.description).toContain('Claude Code 2.1.326')
      expect(options.description).toContain('Code Mode sessions keep working')
      // It is said once, so it stays until it is closed.
      expect(options).toMatchObject({
        id: CODE_MODE_USAGE_UNAVAILABLE_TOAST_ID,
        duration: Infinity,
        closeButton: true
      })
    })

    it('tells once, however often the cue comes: later claims come back empty', async () => {
      mocks.claimClaudeCodeModeUsageUnavailableNotice.mockResolvedValueOnce(notice)
      const { cue } = mount()

      cue()
      await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalledTimes(1))
      // The next blocked sessions, and the other window's share of the same cue.
      cue()
      cue()

      await waitFor(() =>
        expect(mocks.claimClaudeCodeModeUsageUnavailableNotice).toHaveBeenCalledTimes(3)
      )
      await Promise.resolve()
      expect(mocks.toastWarning).toHaveBeenCalledTimes(1)
    })

    it('shows nothing in a window that another window was ahead of', async () => {
      const { cue } = mount()

      cue()

      await waitFor(() =>
        expect(mocks.claimClaudeCodeModeUsageUnavailableNotice).toHaveBeenCalledTimes(1)
      )
      await Promise.resolve()
      expect(mocks.toastWarning).not.toHaveBeenCalled()
    })

    it('shows nothing when the claim fails, and tells with the next cue', async () => {
      mocks.claimClaudeCodeModeUsageUnavailableNotice
        .mockRejectedValueOnce(new Error('server restarting'))
        .mockResolvedValueOnce(notice)
      const { cue } = mount()

      cue()
      await waitFor(() =>
        expect(mocks.claimClaudeCodeModeUsageUnavailableNotice).toHaveBeenCalledTimes(1)
      )
      await Promise.resolve()
      expect(mocks.toastWarning).not.toHaveBeenCalled()

      cue()
      await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalledTimes(1))
    })

    it('stops listening for the cue on unmount', () => {
      const unsubscribe = vi.fn()
      mocks.onClaudeCodeModeUsageUnavailable.mockReturnValue(unsubscribe)
      const { unmount } = mount()

      unmount()

      expect(unsubscribe).toHaveBeenCalledTimes(1)
    })
  })
})
