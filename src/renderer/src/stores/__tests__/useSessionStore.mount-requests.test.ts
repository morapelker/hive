import { afterEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../useSessionStore'

const initialSessionState = useSessionStore.getState()

describe('useSessionStore session mount requests', () => {
  afterEach(() => {
    useSessionStore.setState(initialSessionState, true)
  })

  it('refcounts renderer-only session mount requests by session id', () => {
    const store = useSessionStore.getState()

    store.requestSessionMount('session-1')
    store.requestSessionMount('session-1')
    store.requestSessionMount('session-2')

    expect(useSessionStore.getState().sessionMountRequests).toEqual(
      new Map([
        ['session-1', 2],
        ['session-2', 1]
      ])
    )

    useSessionStore.getState().releaseSessionMount('session-1')

    expect(useSessionStore.getState().sessionMountRequests).toEqual(
      new Map([
        ['session-1', 1],
        ['session-2', 1]
      ])
    )

    useSessionStore.getState().releaseSessionMount('session-1')
    useSessionStore.getState().releaseSessionMount('session-2')
    useSessionStore.getState().releaseSessionMount('session-2')

    expect(useSessionStore.getState().sessionMountRequests.size).toBe(0)
  })
})
