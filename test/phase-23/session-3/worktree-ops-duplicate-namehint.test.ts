import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockDuplicateWorktree = vi.fn()
const mockCreateGitService = vi.fn(() => ({
  duplicateWorktree: mockDuplicateWorktree
}))

vi.mock('../../../src/main/services/git-service', () => ({
  createGitService: (...args: unknown[]) => mockCreateGitService(...args),
  isAutoNamedBranch: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { duplicateWorktreeOp } from '../../../src/main/services/worktree-ops'
import type { DatabaseService } from '../../../src/main/db/database'

function createMockDb(): DatabaseService {
  return {
    createWorktree: vi.fn().mockReturnValue({
      id: 'wt-2',
      project_id: 'proj-1',
      name: 'add-mul-998-function',
      branch_name: 'add-mul-998-function',
      path: '/tmp/project--add-mul-998-function',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      last_accessed_at: '2026-01-01T00:00:00Z'
    }),
    getWorktreeByPath: vi.fn().mockReturnValue(null),
    getProject: vi.fn().mockReturnValue(null)
  } as unknown as DatabaseService
}

describe('duplicateWorktreeOp nameHint forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDuplicateWorktree.mockResolvedValue({
      success: true,
      name: 'add-mul-998-function',
      path: '/tmp/project--add-mul-998-function',
      branchName: 'add-mul-998-function',
      baseBranch: 'main'
    })
  })

  test('forwards nameHint to gitService.duplicateWorktree', async () => {
    const db = createMockDb()

    const result = await duplicateWorktreeOp(db, {
      projectId: 'proj-1',
      projectPath: '/tmp/project',
      projectName: 'project',
      sourceBranch: 'main',
      sourceWorktreePath: '/tmp/project',
      nameHint: 'add-mul-998-function'
    })

    expect(mockCreateGitService).toHaveBeenCalledWith('/tmp/project')
    expect(mockDuplicateWorktree).toHaveBeenCalledWith(
      'main',
      '/tmp/project',
      'project',
      'add-mul-998-function'
    )
    expect(result.success).toBe(true)
  })

  test('omitting nameHint preserves legacy fallback behavior', async () => {
    const db = createMockDb()

    const result = await duplicateWorktreeOp(db, {
      projectId: 'proj-1',
      projectPath: '/tmp/project',
      projectName: 'project',
      sourceBranch: 'main',
      sourceWorktreePath: '/tmp/project'
    })

    expect(mockDuplicateWorktree).toHaveBeenCalledWith('main', '/tmp/project', 'project', undefined)
    expect(result.success).toBe(true)
  })
})
