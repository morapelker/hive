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

  // Cmd+G was "Filter Projects" (nav:filter-projects) until the Go to project switcher took
  // it: the filter field is click-to-type and is not a shortcut any more.
  test('filter-projects shortcut is no longer defined in DEFAULT_SHORTCUTS', () => {
    expect(DEFAULT_SHORTCUTS.find((s) => s.id === 'nav:filter-projects')).toBeUndefined()
    expect(DEFAULT_SHORTCUTS.find((s) => s.label === 'Filter Projects')).toBeUndefined()
  })

  test('go-to-project shortcut is defined in DEFAULT_SHORTCUTS on Cmd+G', () => {
    const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'nav:go-to-project')
    expect(shortcut).toBeDefined()
    expect(shortcut!.category).toBe('navigation')
    expect(shortcut!.label).toBe('Go to Project')
    expect(shortcut!.defaultBinding).toEqual({ key: 'g', modifiers: ['meta'] })
    expect(shortcut!.description).toBeTruthy()
  })
})
