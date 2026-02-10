import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'

// Mock window.worktreeOps
const mockDelete = vi.fn()
Object.defineProperty(window, 'worktreeOps', {
  writable: true,
  value: {
    delete: mockDelete,
    create: vi.fn(),
    sync: vi.fn(),
    openInTerminal: vi.fn(),
    openInEditor: vi.fn(),
    duplicate: vi.fn(),
    renameBranch: vi.fn()
  }
})

// Mock window.db.worktree
Object.defineProperty(window, 'db', {
  writable: true,
  value: {
    worktree: {
      getActiveByProject: vi.fn().mockResolvedValue([]),
      touch: vi.fn().mockResolvedValue(undefined)
    }
  }
})

// Mock window.projectOps
Object.defineProperty(window, 'projectOps', {
  writable: true,
  value: {
    copyToClipboard: vi.fn(),
    showInFolder: vi.fn()
  }
})

describe('Session 8: Archive Loading State', () => {
  beforeEach(() => {
    // Reset the store state before each test
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      isLoading: false,
      error: null,
      selectedWorktreeId: null,
      creatingForProjectId: null,
      archivingWorktreeIds: new Set()
    })
    mockDelete.mockReset()
  })

  test('archivingWorktreeIds starts empty', () => {
    const store = useWorktreeStore.getState()
    expect(store.archivingWorktreeIds.size).toBe(0)
  })

  test('archiveWorktree adds id to archivingWorktreeIds while in progress', async () => {
    // Set up a worktree in the store (non-default so it can be archived)
    const worktrees = new Map([
      [
        'proj1',
        [
          {
            id: 'wt1',
            project_id: 'proj1',
            name: 'feature-branch',
            branch_name: 'feature-branch',
            path: '/path/to/wt1',
            status: 'active' as const,
            is_default: false,
            branch_renamed: 0,
            created_at: new Date().toISOString(),
            last_accessed_at: new Date().toISOString()
          }
        ]
      ]
    ])
    useWorktreeStore.setState({ worktreesByProject: worktrees })

    // Mock a delayed delete operation
    let resolveDelete: (value: { success: boolean }) => void
    mockDelete.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve
      })
    )

    // Start archive but don't await yet
    const promise = useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    // While in progress, the id should be in archivingWorktreeIds
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(true)

    // Resolve the delete
    resolveDelete!({ success: true })
    await promise

    // After completion, the id should be cleared
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(false)
  })

  test('archiveWorktree clears id on success', async () => {
    const worktrees = new Map([
      [
        'proj1',
        [
          {
            id: 'wt1',
            project_id: 'proj1',
            name: 'feature-branch',
            branch_name: 'feature-branch',
            path: '/path/to/wt1',
            status: 'active' as const,
            is_default: false,
            branch_renamed: 0,
            created_at: new Date().toISOString(),
            last_accessed_at: new Date().toISOString()
          }
        ]
      ]
    ])
    useWorktreeStore.setState({ worktreesByProject: worktrees })

    mockDelete.mockResolvedValue({ success: true })

    await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(false)
  })

  test('archiveWorktree clears id on failure', async () => {
    const worktrees = new Map([
      [
        'proj1',
        [
          {
            id: 'wt1',
            project_id: 'proj1',
            name: 'feature-branch',
            branch_name: 'feature-branch',
            path: '/path/to/wt1',
            status: 'active' as const,
            is_default: false,
            branch_renamed: 0,
            created_at: new Date().toISOString(),
            last_accessed_at: new Date().toISOString()
          }
        ]
      ]
    ])
    useWorktreeStore.setState({ worktreesByProject: worktrees })

    mockDelete.mockResolvedValue({ success: false, error: 'Something went wrong' })

    await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(false)
  })

  test('archiveWorktree clears id on exception', async () => {
    const worktrees = new Map([
      [
        'proj1',
        [
          {
            id: 'wt1',
            project_id: 'proj1',
            name: 'feature-branch',
            branch_name: 'feature-branch',
            path: '/path/to/wt1',
            status: 'active' as const,
            is_default: false,
            branch_renamed: 0,
            created_at: new Date().toISOString(),
            last_accessed_at: new Date().toISOString()
          }
        ]
      ]
    ])
    useWorktreeStore.setState({ worktreesByProject: worktrees })

    mockDelete.mockRejectedValue(new Error('Network error'))

    await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(false)
  })

  test('archiveWorktree does not add id for default worktrees', async () => {
    const worktrees = new Map([
      [
        'proj1',
        [
          {
            id: 'wt-default',
            project_id: 'proj1',
            name: 'main',
            branch_name: 'main',
            path: '/path/to/main',
            status: 'active' as const,
            is_default: true,
            branch_renamed: 0,
            created_at: new Date().toISOString(),
            last_accessed_at: new Date().toISOString()
          }
        ]
      ]
    ])
    useWorktreeStore.setState({ worktreesByProject: worktrees })

    await useWorktreeStore
      .getState()
      .archiveWorktree('wt-default', '/path/to/main', 'main', '/project')

    // Should not be in archiving set because the guard blocks default worktrees
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt-default')).toBe(false)
  })

  test('multiple worktrees can be archived simultaneously', async () => {
    const worktrees = new Map([
      [
        'proj1',
        [
          {
            id: 'wt1',
            project_id: 'proj1',
            name: 'branch-a',
            branch_name: 'branch-a',
            path: '/path/to/wt1',
            status: 'active' as const,
            is_default: false,
            branch_renamed: 0,
            created_at: new Date().toISOString(),
            last_accessed_at: new Date().toISOString()
          },
          {
            id: 'wt2',
            project_id: 'proj1',
            name: 'branch-b',
            branch_name: 'branch-b',
            path: '/path/to/wt2',
            status: 'active' as const,
            is_default: false,
            branch_renamed: 0,
            created_at: new Date().toISOString(),
            last_accessed_at: new Date().toISOString()
          }
        ]
      ]
    ])
    useWorktreeStore.setState({ worktreesByProject: worktrees })

    let resolveFirst: (value: { success: boolean }) => void
    let resolveSecond: (value: { success: boolean }) => void

    mockDelete
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockReturnValueOnce(new Promise((r) => (resolveSecond = r)))

    const promise1 = useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'branch-a', '/project')
    const promise2 = useWorktreeStore
      .getState()
      .archiveWorktree('wt2', '/path/to/wt2', 'branch-b', '/project')

    // Both should be in archiving set
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(true)
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt2')).toBe(true)

    // Resolve first
    resolveFirst!({ success: true })
    await promise1
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(false)
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt2')).toBe(true)

    // Resolve second
    resolveSecond!({ success: true })
    await promise2
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt2')).toBe(false)
  })

  test('unbranchWorktree adds and clears archiving state', async () => {
    const worktrees = new Map([
      [
        'proj1',
        [
          {
            id: 'wt1',
            project_id: 'proj1',
            name: 'feature-branch',
            branch_name: 'feature-branch',
            path: '/path/to/wt1',
            status: 'active' as const,
            is_default: false,
            branch_renamed: 0,
            created_at: new Date().toISOString(),
            last_accessed_at: new Date().toISOString()
          }
        ]
      ]
    ])
    useWorktreeStore.setState({ worktreesByProject: worktrees })

    let resolveDelete: (value: { success: boolean }) => void
    mockDelete.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve
      })
    )

    const promise = useWorktreeStore
      .getState()
      .unbranchWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    // Should be in archiving set while in progress
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(true)

    resolveDelete!({ success: true })
    await promise

    // Should be cleared after completion
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(false)
  })

  test('archiveWorktree removes worktree from store on success', async () => {
    const worktrees = new Map([
      [
        'proj1',
        [
          {
            id: 'wt1',
            project_id: 'proj1',
            name: 'feature-branch',
            branch_name: 'feature-branch',
            path: '/path/to/wt1',
            status: 'active' as const,
            is_default: false,
            branch_renamed: 0,
            created_at: new Date().toISOString(),
            last_accessed_at: new Date().toISOString()
          }
        ]
      ]
    ])
    useWorktreeStore.setState({ worktreesByProject: worktrees })

    mockDelete.mockResolvedValue({ success: true })

    const result = await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    expect(result.success).toBe(true)
    const remaining = useWorktreeStore.getState().worktreesByProject.get('proj1')
    expect(remaining).toEqual([])
  })
})
