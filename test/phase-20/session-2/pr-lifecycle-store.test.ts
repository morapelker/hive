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
      attachedPR: new Map()
    })
  })

  test('attachedPR starts as an empty map', () => {
    const state = useGitStore.getState()
    expect(state.attachedPR).toBeInstanceOf(Map)
    expect(state.attachedPR.size).toBe(0)
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

  test('PR lifecycle state is memory-backed only', () => {
    expect(useGitStore.getState().attachedPR.size).toBe(0)
  })
})
