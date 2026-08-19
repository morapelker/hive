import { afterEach, describe, expect, it } from 'vitest'
import { useSessionStore, type TiledSessionsTab } from '../useSessionStore'

const initialSessionState = useSessionStore.getState()

const sampleTab: TiledSessionsTab = {
  scopeLabel: 'Acme',
  tiles: [
    {
      ticketIds: ['t1'],
      title: 'Fix the login flow',
      projectId: 'p1',
      projectName: null,
      sessionId: 's1',
      agentSdk: 'claude-code-cli',
      isRunning: true
    }
  ]
}

describe('useSessionStore tiled sessions tab', () => {
  afterEach(() => {
    useSessionStore.setState(initialSessionState, true)
  })

  it('openTiledSessions activates the tab and clears rival active states', () => {
    useSessionStore.setState({
      activeSessionId: 'other-session',
      activePinnedSessionId: 'pinned-session',
      inlineConnectionSessionId: 'inline-session',
      activeBoardAssistantProjectId: 'p9'
    })

    useSessionStore.getState().openTiledSessions(sampleTab)

    const state = useSessionStore.getState()
    expect(state.tiledSessionsTab).toEqual(sampleTab)
    expect(state.isTiledSessionsActive).toBe(true)
    expect(state.activeSessionId).toBeNull()
    expect(state.activePinnedSessionId).toBeNull()
    expect(state.inlineConnectionSessionId).toBeNull()
    expect(state.activeBoardAssistantProjectId).toBeNull()
  })

  it('focusTiledSessions is a no-op without a tab and re-activates with one', () => {
    useSessionStore.getState().focusTiledSessions()
    expect(useSessionStore.getState().isTiledSessionsActive).toBe(false)

    useSessionStore.getState().openTiledSessions(sampleTab)
    useSessionStore.getState().deactivateTiledSessions()
    expect(useSessionStore.getState().isTiledSessionsActive).toBe(false)
    expect(useSessionStore.getState().tiledSessionsTab).toEqual(sampleTab)

    useSessionStore.getState().focusTiledSessions()
    expect(useSessionStore.getState().isTiledSessionsActive).toBe(true)
  })

  it('closeTiledSessions restores the persisted active session for the scope', () => {
    useSessionStore.setState({
      activeWorktreeId: 'wt1',
      activeSessionByWorktree: { wt1: 'restored-session' },
      sessionsByWorktree: new Map([
        ['wt1', [{ id: 'restored-session', status: 'active' } as never]]
      ])
    })
    useSessionStore.getState().openTiledSessions(sampleTab)

    useSessionStore.getState().closeTiledSessions()

    const state = useSessionStore.getState()
    expect(state.tiledSessionsTab).toBeNull()
    expect(state.isTiledSessionsActive).toBe(false)
    expect(state.activeSessionId).toBe('restored-session')
  })

  it('closeTiledSessions falls back when the persisted session is stale', () => {
    useSessionStore.setState({
      activeWorktreeId: 'wt1',
      activeSessionByWorktree: { wt1: 'closed-session' },
      sessionsByWorktree: new Map([
        ['wt1', [{ id: 'other-session', status: 'active' } as never]]
      ])
    })
    useSessionStore.getState().openTiledSessions(sampleTab)

    useSessionStore.getState().closeTiledSessions()

    const state = useSessionStore.getState()
    // Stale persisted id is rejected; sticky-tab default falls back to the board
    expect(state.activeSessionId).not.toBe('closed-session')
  })

  it('any raw write of a non-null activeSessionId deactivates the tiled tab (invariant subscription)', () => {
    useSessionStore.getState().openTiledSessions(sampleTab)
    expect(useSessionStore.getState().isTiledSessionsActive).toBe(true)

    // Bypass all activator actions — write the field directly, as
    // reopenSession/createSession/closeOtherSessions do.
    useSessionStore.setState({ activeSessionId: 'raw-write-session' })

    expect(useSessionStore.getState().isTiledSessionsActive).toBe(false)
    expect(useSessionStore.getState().tiledSessionsTab).toEqual(sampleTab)
  })

  it('closeTiledSessions while inactive clears the tab without touching the active session', () => {
    useSessionStore.getState().openTiledSessions(sampleTab)
    useSessionStore.getState().setActiveSession('other-session')
    expect(useSessionStore.getState().isTiledSessionsActive).toBe(false)

    useSessionStore.getState().closeTiledSessions()

    const state = useSessionStore.getState()
    expect(state.tiledSessionsTab).toBeNull()
    expect(state.activeSessionId).toBe('other-session')
  })

  it('rival activators deactivate but keep the tab; null-clears do not deactivate', () => {
    useSessionStore.getState().openTiledSessions(sampleTab)

    // Null-clears must NOT deactivate (they are clears, not activations)
    useSessionStore.getState().setActivePinnedSession(null)
    useSessionStore.getState().setInlineConnectionSession(null)
    expect(useSessionStore.getState().isTiledSessionsActive).toBe(true)

    // Activating a pinned session deactivates
    useSessionStore.getState().setActivePinnedSession('pinned-1')
    expect(useSessionStore.getState().isTiledSessionsActive).toBe(false)
    expect(useSessionStore.getState().tiledSessionsTab).toEqual(sampleTab)

    // Re-focus, then an inline connection session deactivates
    useSessionStore.getState().focusTiledSessions()
    useSessionStore.getState().setInlineConnectionSession('inline-1')
    expect(useSessionStore.getState().isTiledSessionsActive).toBe(false)

    // Re-focus, then setActiveSession deactivates
    useSessionStore.getState().focusTiledSessions()
    useSessionStore.getState().setActiveSession('session-1')
    expect(useSessionStore.getState().isTiledSessionsActive).toBe(false)

    // Re-focus, then a scope switch deactivates
    useSessionStore.getState().focusTiledSessions()
    useSessionStore.getState().setActiveWorktree('wt-2')
    expect(useSessionStore.getState().isTiledSessionsActive).toBe(false)
  })

  it('setMountedTerminalMirror snapshots the mounted id list as a Set', () => {
    useSessionStore.getState().setMountedTerminalMirror(['a', 'b', 'a'])
    expect(useSessionStore.getState().mountedTerminalMirror).toEqual(new Set(['a', 'b']))

    useSessionStore.getState().setMountedTerminalMirror([])
    expect(useSessionStore.getState().mountedTerminalMirror.size).toBe(0)
  })
})
