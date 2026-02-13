import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'
import { DEFAULT_SHORTCUTS } from '../../../src/renderer/src/lib/keyboard-shortcuts'

// Mock useWorktreeStore before importing useGitStore internals
vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map()
    }))
  }
}))

describe('Session 7: Merge Shortcut Store + Definition', () => {
  beforeEach(() => {
    useGitStore.setState({
      selectedMergeBranch: new Map()
    })
  })

  test('selectedMergeBranch starts as empty map', () => {
    expect(useGitStore.getState().selectedMergeBranch.size).toBe(0)
  })

  test('setSelectedMergeBranch stores branch by worktree path', () => {
    useGitStore.getState().setSelectedMergeBranch('/path/wt1', 'feature-x')
    expect(useGitStore.getState().selectedMergeBranch.get('/path/wt1')).toBe('feature-x')
  })

  test('setSelectedMergeBranch overwrites previous value for same worktree', () => {
    useGitStore.getState().setSelectedMergeBranch('/path/wt1', 'feature-x')
    useGitStore.getState().setSelectedMergeBranch('/path/wt1', 'main')
    expect(useGitStore.getState().selectedMergeBranch.get('/path/wt1')).toBe('main')
  })

  test('different worktrees have independent merge branch selections', () => {
    useGitStore.getState().setSelectedMergeBranch('/path/wt1', 'feature-x')
    useGitStore.getState().setSelectedMergeBranch('/path/wt2', 'main')
    expect(useGitStore.getState().selectedMergeBranch.get('/path/wt1')).toBe('feature-x')
    expect(useGitStore.getState().selectedMergeBranch.get('/path/wt2')).toBe('main')
  })

  test('selectedMergeBranch is in-memory only (starts empty)', () => {
    expect(useGitStore.getState().selectedMergeBranch.size).toBe(0)
  })

  test('merge shortcut is defined in DEFAULT_SHORTCUTS', () => {
    const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'git:merge')
    expect(shortcut).toBeDefined()
    expect(shortcut!.category).toBe('git')
    expect(shortcut!.label).toBe('Merge')
    expect(shortcut!.defaultBinding).toEqual({ key: 'g', modifiers: ['meta'] })
  })

  test('merge shortcut has a description', () => {
    const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'git:merge')
    expect(shortcut!.description).toBe('Merge selected branch')
  })
})
