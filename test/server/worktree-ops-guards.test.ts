import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { DatabaseService } from '../../src/main/db/database'

const { duplicateWorktreeMock, renameBranchMock } = vi.hoisted(() => ({
  duplicateWorktreeMock: vi.fn(),
  renameBranchMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp')
  }
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../src/main/services/git-service', () => ({
  createGitService: vi.fn(() => ({
    duplicateWorktree: duplicateWorktreeMock,
    renameBranch: renameBranchMock
  })),
  isAutoNamedBranch: vi.fn(() => false)
}))

import { duplicateWorktreeOp, renameWorktreeBranchOp } from '../../src/main/services/worktree-ops'

describe('worktree branch guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('rejects duplicate requests for detached HEAD worktrees', async () => {
    const db = {} as DatabaseService

    await expect(
      duplicateWorktreeOp(db, {
        projectId: 'proj-1',
        projectPath: '/repos/app',
        projectName: 'app',
        sourceBranch: '',
        sourceWorktreePath: '/repos/app-detached'
      })
    ).resolves.toEqual({
      success: false,
      error: 'Detached HEAD worktrees cannot be duplicated'
    })

    expect(duplicateWorktreeMock).not.toHaveBeenCalled()
  })

  test('rejects rename requests for detached HEAD worktrees', async () => {
    const db = {} as DatabaseService

    await expect(
      renameWorktreeBranchOp(db, {
        worktreeId: 'wt-detached',
        worktreePath: '/repos/app-detached',
        oldBranch: '',
        newBranch: 'feature/new-name'
      })
    ).resolves.toEqual({
      success: false,
      error: 'Detached HEAD worktrees cannot be renamed'
    })

    expect(renameBranchMock).not.toHaveBeenCalled()
  })
})
