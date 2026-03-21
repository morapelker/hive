import { describe, it, expect, beforeEach } from 'vitest'
import { useHintStore } from '@/stores/useHintStore'

describe('useHintStore session hints', () => {
  beforeEach(() => {
    // Reset to initial state
    useHintStore.setState({
      hintMap: new Map(),
      hintTargetMap: new Map(),
      sessionHintMap: new Map(),
      sessionHintTargetMap: new Map(),
      mode: 'idle',
      pendingChar: null,
      filterActive: false,
      inputFocused: false
    })
  })

  it('has empty sessionHintMap and sessionHintTargetMap initially', () => {
    const state = useHintStore.getState()
    expect(state.sessionHintMap).toBeInstanceOf(Map)
    expect(state.sessionHintMap.size).toBe(0)
    expect(state.sessionHintTargetMap).toBeInstanceOf(Map)
    expect(state.sessionHintTargetMap.size).toBe(0)
  })

  it('setSessionHints populates both maps', () => {
    const hintMap = new Map([['s1', 'Sa'], ['s2', 'Sb']])
    const targetMap = new Map([['Sa', 's1'], ['Sb', 's2']])

    useHintStore.getState().setSessionHints(hintMap, targetMap)

    const state = useHintStore.getState()
    expect(state.sessionHintMap.get('s1')).toBe('Sa')
    expect(state.sessionHintMap.get('s2')).toBe('Sb')
    expect(state.sessionHintTargetMap.get('Sa')).toBe('s1')
    expect(state.sessionHintTargetMap.get('Sb')).toBe('s2')
  })

  it('clearSessionHints resets both maps to empty', () => {
    const hintMap = new Map([['s1', 'Sa']])
    const targetMap = new Map([['Sa', 's1']])
    useHintStore.getState().setSessionHints(hintMap, targetMap)

    useHintStore.getState().clearSessionHints()

    const state = useHintStore.getState()
    expect(state.sessionHintMap.size).toBe(0)
    expect(state.sessionHintTargetMap.size).toBe(0)
  })

  it('clearHints also clears session maps', () => {
    // Set up both worktree hints and session hints
    const worktreeHintMap = new Map([['w1', 'Aa']])
    const worktreeTargetMap = new Map([['w1', { kind: 'worktree' as const, worktreeId: 'w1', projectId: 'p1' }]])
    useHintStore.getState().setHints(worktreeHintMap, worktreeTargetMap)

    const sessionHintMap = new Map([['s1', 'Sa']])
    const sessionTargetMap = new Map([['Sa', 's1']])
    useHintStore.getState().setSessionHints(sessionHintMap, sessionTargetMap)

    // clearHints should clear everything
    useHintStore.getState().clearHints()

    const state = useHintStore.getState()
    expect(state.hintMap.size).toBe(0)
    expect(state.hintTargetMap.size).toBe(0)
    expect(state.sessionHintMap.size).toBe(0)
    expect(state.sessionHintTargetMap.size).toBe(0)
  })

  it('session hints are independent of worktree hints', () => {
    const worktreeHintMap = new Map([['w1', 'Aa']])
    const worktreeTargetMap = new Map([['w1', { kind: 'worktree' as const, worktreeId: 'w1', projectId: 'p1' }]])
    useHintStore.getState().setHints(worktreeHintMap, worktreeTargetMap)

    const sessionHintMap = new Map([['s1', 'Sa']])
    const sessionTargetMap = new Map([['Sa', 's1']])
    useHintStore.getState().setSessionHints(sessionHintMap, sessionTargetMap)

    // Clearing session hints should not affect worktree hints
    useHintStore.getState().clearSessionHints()

    const state = useHintStore.getState()
    expect(state.hintMap.size).toBe(1)
    expect(state.hintMap.get('w1')).toBe('Aa')
    expect(state.sessionHintMap.size).toBe(0)
  })
})
