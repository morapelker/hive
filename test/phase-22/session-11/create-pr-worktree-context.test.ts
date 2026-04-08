import { describe, test, expect, beforeEach } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

beforeEach(() => {
  useGitStore.setState({
    createPRModalOpen: false,
    createPRWorktreeId: null,
    createPRWorktreePath: null,
    creatingPRByWorktreeId: new Map(),
  })
})

describe('Create PR worktree context', () => {
  test('setCreatePRModalOpen stores worktree context when opening with context', () => {
    useGitStore.getState().setCreatePRModalOpen(true, {
      worktreeId: 'wt-ticket-1',
      worktreePath: '/path/to/ticket-worktree',
    })

    const state = useGitStore.getState()
    expect(state.createPRModalOpen).toBe(true)
    expect(state.createPRWorktreeId).toBe('wt-ticket-1')
    expect(state.createPRWorktreePath).toBe('/path/to/ticket-worktree')
  })

  test('setCreatePRModalOpen clears worktree context when closing', () => {
    useGitStore.getState().setCreatePRModalOpen(true, {
      worktreeId: 'wt-ticket-1',
      worktreePath: '/path/to/ticket-worktree',
    })

    useGitStore.getState().setCreatePRModalOpen(false)

    const state = useGitStore.getState()
    expect(state.createPRModalOpen).toBe(false)
    expect(state.createPRWorktreeId).toBeNull()
    expect(state.createPRWorktreePath).toBeNull()
  })

  test('setCreatePRModalOpen without context is a no-op', () => {
    useGitStore.getState().setCreatePRModalOpen(true)

    const state = useGitStore.getState()
    expect(state.createPRModalOpen).toBe(false)
    expect(state.createPRWorktreeId).toBeNull()
    expect(state.createPRWorktreePath).toBeNull()
  })

  test('setCreatingPR tracks creation state per worktree', () => {
    useGitStore.getState().setCreatingPR('wt-ticket-1', true)

    const state = useGitStore.getState()
    expect(state.creatingPRByWorktreeId.get('wt-ticket-1')).toBe(true)
  })

  test('setCreatingPR clears only the targeted worktree entry', () => {
    useGitStore.getState().setCreatingPR('wt-ticket-1', true)
    useGitStore.getState().setCreatingPR('wt-ticket-2', true)

    useGitStore.getState().setCreatingPR('wt-ticket-1', false)

    const state = useGitStore.getState()
    expect(state.creatingPRByWorktreeId.has('wt-ticket-1')).toBe(false)
    expect(state.creatingPRByWorktreeId.get('wt-ticket-2')).toBe(true)
  })
})
