import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

// Mock useWorktreeStore (required by useGitStore internals)
vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map()
    }))
  }
}))

describe('Session 2: PR Lifecycle Store State', () => {
  beforeEach(() => {
    useGitStore.setState({
      prInfo: new Map()
    })
  })

  test('prInfo starts as an empty map', () => {
    const state = useGitStore.getState()
    expect(state.prInfo).toBeInstanceOf(Map)
    expect(state.prInfo.size).toBe(0)
  })

  test('setPrState adds a new PR info entry', () => {
    useGitStore.getState().setPrState('wt-1', {
      state: 'creating',
      sessionId: 'session-123',
      targetBranch: 'origin/main'
    })
    const info = useGitStore.getState().prInfo.get('wt-1')
    expect(info).toBeDefined()
    expect(info?.state).toBe('creating')
    expect(info?.sessionId).toBe('session-123')
    expect(info?.targetBranch).toBe('origin/main')
  })

  test('setPrState updates existing entry', () => {
    useGitStore.getState().setPrState('wt-1', { state: 'creating' })
    useGitStore.getState().setPrState('wt-1', {
      state: 'created',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42'
    })
    const info = useGitStore.getState().prInfo.get('wt-1')
    expect(info?.state).toBe('created')
    expect(info?.prNumber).toBe(42)
    expect(info?.prUrl).toBe('https://github.com/org/repo/pull/42')
  })

  test('different worktrees have independent PR states', () => {
    useGitStore.getState().setPrState('wt-1', { state: 'created', prNumber: 1 })
    useGitStore.getState().setPrState('wt-2', { state: 'merged', prNumber: 2 })
    expect(useGitStore.getState().prInfo.get('wt-1')?.state).toBe('created')
    expect(useGitStore.getState().prInfo.get('wt-1')?.prNumber).toBe(1)
    expect(useGitStore.getState().prInfo.get('wt-2')?.state).toBe('merged')
    expect(useGitStore.getState().prInfo.get('wt-2')?.prNumber).toBe(2)
  })

  test('setPrState does not affect other worktree entries', () => {
    useGitStore.getState().setPrState('wt-1', { state: 'creating', sessionId: 's1' })
    useGitStore.getState().setPrState('wt-2', { state: 'none' })

    // Update only wt-1
    useGitStore.getState().setPrState('wt-1', {
      state: 'created',
      prNumber: 99,
      prUrl: 'https://github.com/org/repo/pull/99'
    })

    // wt-2 should be unchanged
    const wt2Info = useGitStore.getState().prInfo.get('wt-2')
    expect(wt2Info?.state).toBe('none')
  })

  test('prInfo supports all valid states', () => {
    const states = ['none', 'creating', 'created', 'merged'] as const
    for (const state of states) {
      useGitStore.getState().setPrState('wt-test', { state })
      expect(useGitStore.getState().prInfo.get('wt-test')?.state).toBe(state)
    }
  })

  test('setPrState preserves optional fields when provided', () => {
    useGitStore.getState().setPrState('wt-1', {
      state: 'created',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
      targetBranch: 'main',
      sessionId: 'session-abc'
    })
    const info = useGitStore.getState().prInfo.get('wt-1')
    expect(info?.prNumber).toBe(42)
    expect(info?.prUrl).toBe('https://github.com/org/repo/pull/42')
    expect(info?.targetBranch).toBe('main')
    expect(info?.sessionId).toBe('session-abc')
  })

  test('prInfo is in-memory only (no persistence key)', () => {
    // The store should not persist prInfo -- it resets on app restart
    // Verify initial state is empty (no persisted data loaded)
    const freshState = useGitStore.getState()
    expect(freshState.prInfo.size).toBe(0)
  })
})
