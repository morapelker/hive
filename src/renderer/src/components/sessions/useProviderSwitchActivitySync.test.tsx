import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore, type ProviderSwitchActivity } from '@/stores/useSessionStore'
import { useProviderSwitchActivitySync } from './useProviderSwitchActivitySync'

const initialSessionState = useSessionStore.getState()

describe('useProviderSwitchActivitySync', () => {
  beforeEach(() => {
    useSessionStore.setState(initialSessionState, true)
  })

  afterEach(() => {
    cleanup()
  })

  it('syncs activity into the session store and clears it on unmount', () => {
    const initialActivity: ProviderSwitchActivity = {
      sending: true,
      streaming: false,
      queuedLocalFollowUps: 0
    }
    const { rerender, unmount } = renderHook(
      ({ activity }) => useProviderSwitchActivitySync('session-1', activity),
      { initialProps: { activity: initialActivity } }
    )

    expect(useSessionStore.getState().providerSwitchActivityBySession.get('session-1')).toEqual(
      initialActivity
    )

    const nextActivity: ProviderSwitchActivity = {
      sending: false,
      streaming: true,
      queuedLocalFollowUps: 2
    }
    rerender({ activity: nextActivity })

    expect(useSessionStore.getState().providerSwitchActivityBySession.get('session-1')).toEqual(
      nextActivity
    )

    unmount()

    expect(useSessionStore.getState().providerSwitchActivityBySession.has('session-1')).toBe(false)
  })
})
