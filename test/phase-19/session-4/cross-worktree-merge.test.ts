import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

const gitApiMocks = vi.hoisted(() => ({
  commit: vi.fn(),
  getFileStatuses: vi.fn(),
  getBranchInfo: vi.fn()
}))

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
}))

// Mock useWorktreeStore before importing useGitStore internals
vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            { id: 'wt-1', project_id: 'proj-1', path: '/repo/wt-1', branch_name: 'feature-x' },
            { id: 'wt-2', project_id: 'proj-1', path: '/repo/wt-2', branch_name: 'main' }
          ]
        ]
      ])
    }))
  }
}))

vi.mock('../../../src/renderer/src/stores/useKanbanStore', () => ({
  useKanbanStore: {
    getState: () => ({
      updateTicket: vi.fn()
    })
  }
}))

describe('Session 4: Cross-Worktree Merge Default', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gitApiMocks.getFileStatuses.mockResolvedValue({ success: true, files: [] })
    gitApiMocks.getBranchInfo.mockResolvedValue({
      success: true,
      branch: { name: 'feature-x', tracking: null, ahead: 0, behind: 0 }
    })

    // Reset the store between tests
    useGitStore.setState({
      defaultMergeBranch: new Map(),
      branchInfoByWorktree: new Map(),
      fileStatusesByWorktree: new Map(),
      isCommitting: false,
      mergeSelectionVersion: 0,
      error: null
    })
  })

  test('setDefaultMergeBranch stores branch by project ID', () => {
    const store = useGitStore.getState()
    store.setDefaultMergeBranch('project-1', 'feature-auth')
    expect(useGitStore.getState().defaultMergeBranch.get('project-1')).toBe('feature-auth')
  })

  test('setDefaultMergeBranch overwrites previous value for same project', () => {
    const store = useGitStore.getState()
    store.setDefaultMergeBranch('project-1', 'feature-a')
    store.setDefaultMergeBranch('project-1', 'feature-b')
    expect(useGitStore.getState().defaultMergeBranch.get('project-1')).toBe('feature-b')
  })

  test('setDefaultMergeBranch keeps separate values per project', () => {
    const store = useGitStore.getState()
    store.setDefaultMergeBranch('proj-1', 'branch-a')
    store.setDefaultMergeBranch('proj-2', 'branch-b')
    expect(useGitStore.getState().defaultMergeBranch.get('proj-1')).toBe('branch-a')
    expect(useGitStore.getState().defaultMergeBranch.get('proj-2')).toBe('branch-b')
  })

  test('commit sets defaultMergeBranch for the project', async () => {
    // Set up branch info so commit can read the branch name
    useGitStore.setState({
      branchInfoByWorktree: new Map([
        ['/repo/wt-1', { name: 'feature-x', tracking: null, ahead: 0, behind: 0 }]
      ])
    })

    gitApiMocks.commit.mockResolvedValue({ success: true, commitHash: 'abc123' })

    const result = await useGitStore.getState().commit('/repo/wt-1', 'test commit')

    expect(result.success).toBe(true)

    // Wait for debounced refresh to complete
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(useGitStore.getState().defaultMergeBranch.get('proj-1')).toBe('feature-x')
  })

  test('commit does not set defaultMergeBranch on failure', async () => {
    gitApiMocks.commit.mockResolvedValue({ success: false, error: 'nothing to commit' })

    await useGitStore.getState().commit('/repo/wt-1', 'test commit')
    expect(useGitStore.getState().defaultMergeBranch.size).toBe(0)
  })

  test('defaultMergeBranch is in-memory only (starts empty)', () => {
    expect(useGitStore.getState().defaultMergeBranch.size).toBe(0)
  })

  test('commit increments mergeSelectionVersion so components reset manual selections', async () => {
    useGitStore.setState({
      branchInfoByWorktree: new Map([
        ['/repo/wt-1', { name: 'feature-x', tracking: null, ahead: 0, behind: 0 }]
      ])
    })

    gitApiMocks.commit.mockResolvedValue({ success: true, commitHash: 'def456' })

    expect(useGitStore.getState().mergeSelectionVersion).toBe(0)

    await useGitStore.getState().commit('/repo/wt-1', 'test commit')
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(useGitStore.getState().mergeSelectionVersion).toBe(1)

    // A second commit bumps it again
    await useGitStore.getState().commit('/repo/wt-1', 'another commit')
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(useGitStore.getState().mergeSelectionVersion).toBe(2)
  })

  test('failed commit does not increment mergeSelectionVersion', async () => {
    gitApiMocks.commit.mockResolvedValue({ success: false, error: 'nothing to commit' })

    expect(useGitStore.getState().mergeSelectionVersion).toBe(0)
    await useGitStore.getState().commit('/repo/wt-1', 'test commit')
    expect(useGitStore.getState().mergeSelectionVersion).toBe(0)
  })
})
