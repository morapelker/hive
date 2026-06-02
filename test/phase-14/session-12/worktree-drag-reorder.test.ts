import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'

// Mock window APIs used by the store
Object.defineProperty(window, 'db', {
  writable: true,
  value: {
    worktree: {
      getActiveByProject: vi.fn().mockResolvedValue([]),
      touch: vi.fn().mockResolvedValue(undefined)
    }
  }
})

Object.defineProperty(window, 'worktreeOps', {
  writable: true,
  value: {
    create: vi.fn(),
    delete: vi.fn(),
    sync: vi.fn(),
    openInTerminal: vi.fn(),
    openInEditor: vi.fn(),
    renameBranch: vi.fn(),
    duplicate: vi.fn()
  }
})

Object.defineProperty(window, 'projectOps', {
  writable: true,
  value: {
    showInFolder: vi.fn(),
    copyToClipboard: vi.fn()
  }
})

const makeWorktree = (id: string, projectId: string, isDefault = false) => ({
  id,
  project_id: projectId,
  name: `worktree-${id}`,
  branch_name: `branch-${id}`,
  path: `/test/${id}`,
  status: 'active' as const,
  is_default: isDefault,
  branch_renamed: 0,
  created_at: new Date().toISOString(),
  last_accessed_at: new Date().toISOString()
})

describe('Session 12: Worktree Drag Reorder', () => {
  beforeEach(() => {
    // Reset store state between tests
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      worktreeOrderByProject: new Map(),
      selectedWorktreeId: null,
      creatingForProjectId: null,
      archivingWorktreeIds: new Set(),
      isLoading: false,
      error: null
    })
    localStorage.removeItem('hive-worktree-order')
  })

  test('reorderWorktrees swaps items correctly', () => {
    const projectId = 'proj1'
    const wtA = makeWorktree('a', projectId)
    const wtB = makeWorktree('b', projectId)
    const wtC = makeWorktree('c', projectId)

    useWorktreeStore.setState({
      worktreesByProject: new Map([[projectId, [wtA, wtB, wtC]]])
    })

    // Reorder: move index 0 (a) to index 2 (after c)
    useWorktreeStore.getState().reorderWorktrees(projectId, 0, 2)

    const order = useWorktreeStore.getState().worktreeOrderByProject.get(projectId)
    expect(order).toEqual(['b', 'c', 'a'])
  })

  test('getWorktreesForProject applies custom order', () => {
    const projectId = 'proj1'
    const wtDefault = makeWorktree('def', projectId, true)
    const wtA = makeWorktree('a', projectId)
    const wtB = makeWorktree('b', projectId)
    const wtC = makeWorktree('c', projectId)

    useWorktreeStore.setState({
      worktreesByProject: new Map([[projectId, [wtDefault, wtA, wtB, wtC]]]),
      worktreeOrderByProject: new Map([[projectId, ['c', 'a', 'b']]])
    })

    const result = useWorktreeStore.getState().getWorktreesForProject(projectId)
    expect(result.map((w) => w.id)).toEqual(['c', 'a', 'b', 'def'])
  })

  test('default worktree stays last regardless of custom order', () => {
    const projectId = 'proj1'
    const wtDefault = makeWorktree('def', projectId, true)
    const wtA = makeWorktree('a', projectId)
    const wtB = makeWorktree('b', projectId)

    useWorktreeStore.setState({
      worktreesByProject: new Map([[projectId, [wtDefault, wtA, wtB]]]),
      worktreeOrderByProject: new Map([[projectId, ['b', 'a']]])
    })

    const result = useWorktreeStore.getState().getWorktreesForProject(projectId)
    expect(result[result.length - 1].id).toBe('def')
    expect(result[result.length - 1].is_default).toBe(true)
  })

  test('new worktrees appear at end of custom order', () => {
    const projectId = 'proj1'
    const wtDefault = makeWorktree('def', projectId, true)
    const wtA = makeWorktree('a', projectId)
    const wtB = makeWorktree('b', projectId)
    const wtNew = makeWorktree('new', projectId)

    useWorktreeStore.setState({
      worktreesByProject: new Map([[projectId, [wtDefault, wtA, wtB, wtNew]]]),
      // Custom order only knows about a and b
      worktreeOrderByProject: new Map([[projectId, ['b', 'a']]])
    })

    const result = useWorktreeStore.getState().getWorktreesForProject(projectId)
    expect(result.map((w) => w.id)).toEqual(['b', 'a', 'new', 'def'])
  })

  test('removing a worktree does not break ordering of remaining ones', () => {
    const projectId = 'proj1'
    const wtA = makeWorktree('a', projectId)
    const wtC = makeWorktree('c', projectId)

    // Order references 'b' which no longer exists
    useWorktreeStore.setState({
      worktreesByProject: new Map([[projectId, [wtA, wtC]]]),
      worktreeOrderByProject: new Map([[projectId, ['c', 'b', 'a']]])
    })

    const result = useWorktreeStore.getState().getWorktreesForProject(projectId)
    expect(result.map((w) => w.id)).toEqual(['c', 'a'])
  })

  test('reorderWorktrees ignores out-of-bounds indices', () => {
    const projectId = 'proj1'
    const wtA = makeWorktree('a', projectId)
    const wtB = makeWorktree('b', projectId)

    useWorktreeStore.setState({
      worktreesByProject: new Map([[projectId, [wtA, wtB]]])
    })

    // Out of bounds
    useWorktreeStore.getState().reorderWorktrees(projectId, -1, 5)

    const order = useWorktreeStore.getState().worktreeOrderByProject.get(projectId)
    // Should not have changed (no order set)
    expect(order).toBeUndefined()
  })

  test('persists order to localStorage', () => {
    const projectId = 'proj1'
    const wtA = makeWorktree('a', projectId)
    const wtB = makeWorktree('b', projectId)
    const wtC = makeWorktree('c', projectId)

    useWorktreeStore.setState({
      worktreesByProject: new Map([[projectId, [wtA, wtB, wtC]]])
    })

    useWorktreeStore.getState().reorderWorktrees(projectId, 0, 2)

    const stored = JSON.parse(localStorage.getItem('hive-worktree-order') || '{}')
    expect(stored[projectId]).toEqual(['b', 'c', 'a'])
  })

  test('returns worktrees without custom order in default sort', () => {
    const projectId = 'proj1'
    const wtDefault = makeWorktree('def', projectId, true)
    const wtA = makeWorktree('a', projectId)

    useWorktreeStore.setState({
      worktreesByProject: new Map([[projectId, [wtDefault, wtA]]])
    })

    const result = useWorktreeStore.getState().getWorktreesForProject(projectId)
    expect(result.map((w) => w.id)).toEqual(['a', 'def'])
  })
})
