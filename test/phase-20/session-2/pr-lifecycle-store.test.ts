import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map()
    }))
  }
}))

describe('Session 2: PR lifecycle store state', () => {
  beforeEach(() => {
    useGitStore.setState({
      prCreation: new Map(),
      attachedPR: new Map()
    })
  })

  test('prCreation starts as an empty map', () => {
    const state = useGitStore.getState()
    expect(state.prCreation).toBeInstanceOf(Map)
    expect(state.prCreation.size).toBe(0)
  })

  test('attachedPR starts as an empty map', () => {
    const state = useGitStore.getState()
    expect(state.attachedPR).toBeInstanceOf(Map)
    expect(state.attachedPR.size).toBe(0)
  })

  test('setPrCreation adds a creating state for a worktree', () => {
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-123'
    })

    expect(useGitStore.getState().prCreation.get('wt-1')).toEqual({
      creating: true,
      sessionId: 'session-123'
    })
  })

  test('setPrCreation clears a worktree entry when passed null', () => {
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-123'
    })
    useGitStore.getState().setPrCreation('wt-1', null)

    expect(useGitStore.getState().prCreation.has('wt-1')).toBe(false)
  })

  test('setAttachedPR stores an attached PR for a worktree', () => {
    useGitStore.getState().setAttachedPR('wt-1', {
      number: 42,
      url: 'https://github.com/org/repo/pull/42'
    })

    expect(useGitStore.getState().attachedPR.get('wt-1')).toEqual({
      number: 42,
      url: 'https://github.com/org/repo/pull/42'
    })
  })

  test('setAttachedPR replaces an existing attached PR', () => {
    useGitStore.getState().setAttachedPR('wt-1', {
      number: 101,
      url: 'https://github.com/org/repo/pull/101'
    })
    useGitStore.getState().setAttachedPR('wt-1', {
      number: 280,
      url: 'https://github.com/org/repo/pull/280'
    })

    expect(useGitStore.getState().attachedPR.get('wt-1')).toEqual({
      number: 280,
      url: 'https://github.com/org/repo/pull/280'
    })
  })

  test('prCreation and attachedPR remain independent across worktrees', () => {
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-1'
    })
    useGitStore.getState().setAttachedPR('wt-2', {
      number: 55,
      url: 'https://github.com/org/repo/pull/55'
    })

    expect(useGitStore.getState().prCreation.get('wt-1')?.sessionId).toBe('session-1')
    expect(useGitStore.getState().attachedPR.get('wt-2')?.number).toBe(55)
    expect(useGitStore.getState().attachedPR.has('wt-1')).toBe(false)
    expect(useGitStore.getState().prCreation.has('wt-2')).toBe(false)
  })

  test('PR lifecycle state is memory-backed only', () => {
    expect(useGitStore.getState().prCreation.size).toBe(0)
    expect(useGitStore.getState().attachedPR.size).toBe(0)
  })
})
