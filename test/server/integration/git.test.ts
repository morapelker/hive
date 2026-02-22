import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Module-level mocks (must be before any resolver imports)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return homedir()
      if (name === 'userData') return join(homedir(), '.hive')
      if (name === 'logs') return join(homedir(), '.hive', 'logs')
      return '/tmp'
    },
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/tmp/hive-test-app'
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn()
}))

// Mock git-service — the core of this test file
const mockGitService = {
  getFileStatuses: vi.fn(),
  getDiff: vi.fn(),
  getUntrackedFileDiff: vi.fn(),
  getDiffStat: vi.fn(),
  getBranchInfo: vi.fn(),
  listBranchesWithStatus: vi.fn(),
  isBranchMerged: vi.fn(),
  getRemoteUrl: vi.fn(),
  getRefContent: vi.fn(),
  stageFile: vi.fn(),
  unstageFile: vi.fn(),
  stageAll: vi.fn(),
  unstageAll: vi.fn(),
  stageHunk: vi.fn(),
  unstageHunk: vi.fn(),
  revertHunk: vi.fn(),
  discardChanges: vi.fn(),
  addToGitignore: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  merge: vi.fn(),
  deleteBranch: vi.fn()
}

vi.mock('../../../src/main/services/git-service', () => ({
  createGitService: vi.fn(() => mockGitService),
  parseWorktreeForBranch: vi.fn()
}))

vi.mock('../../../src/main/services/connection-service', () => ({
  createConnectionDir: vi.fn(() => '/tmp/fake-conn-dir'),
  createSymlink: vi.fn(),
  removeSymlink: vi.fn(),
  deleteConnectionDir: vi.fn(),
  generateConnectionInstructions: vi.fn(),
  deriveSymlinkName: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
  generateConnectionColor: vi.fn(() => '["#aaa","#bbb","#ccc","#ddd"]')
}))

vi.mock('../../../src/main/services/worktree-ops', () => ({
  createWorktreeOp: vi.fn(),
  deleteWorktreeOp: vi.fn(),
  syncWorktreesOp: vi.fn(),
  duplicateWorktreeOp: vi.fn(),
  renameWorktreeBranchOp: vi.fn(),
  createWorktreeFromBranchOp: vi.fn()
}))

vi.mock('../../../src/main/services/worktree-watcher', () => ({
  watchWorktree: vi.fn().mockResolvedValue(undefined),
  unwatchWorktree: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../../../src/main/services/branch-watcher', () => ({
  watchBranch: vi.fn().mockResolvedValue(undefined),
  unwatchBranch: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../../../src/server/event-bus', () => ({
  getEventBus: vi.fn(() => ({ emit: vi.fn() }))
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { MockDatabaseService } from '../helpers/mock-db'
import { createTestServer } from '../helpers/test-server'
import { watchWorktree, unwatchWorktree } from '../../../src/main/services/worktree-watcher'

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Git Resolvers — Integration Tests', () => {
  let execute: (
    query: string,
    variables?: Record<string, unknown>
  ) => Promise<{ data?: any; errors?: any[] }>

  // Create a temp dir with a .git folder so existsSync(join(path, '.git')) passes
  const fakeRepoDir = mkdtempSync(join(tmpdir(), 'hive-git-test-'))
  mkdirSync(join(fakeRepoDir, '.git'))

  afterAll(() => {
    try {
      rmSync(fakeRepoDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    const db = new MockDatabaseService()
    const server = createTestServer(db)
    execute = server.execute
  })

  // =========================================================================
  // Git Query Resolvers
  // =========================================================================
  describe('Git Query Resolvers', () => {
    // --- 1. gitFileStatuses — returns file list on success ---
    it('gitFileStatuses returns file list on success', async () => {
      mockGitService.getFileStatuses.mockResolvedValue({
        success: true,
        files: [
          { path: '/repo/src/app.ts', relativePath: 'src/app.ts', status: 'M', staged: false },
          { path: '/repo/README.md', relativePath: 'README.md', status: 'A', staged: true }
        ]
      })

      const { data, errors } = await execute(
        `query($path: String!) {
          gitFileStatuses(worktreePath: $path) {
            success
            files { path relativePath status staged }
          }
        }`,
        { path: fakeRepoDir }
      )
      expect(errors).toBeUndefined()
      expect(data?.gitFileStatuses.success).toBe(true)
      expect(data?.gitFileStatuses.files).toHaveLength(2)
      expect(data?.gitFileStatuses.files[0]).toMatchObject({
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        status: 'M',
        staged: false
      })
    })

    // --- 2. gitFileStatuses — returns empty files for non-git directory ---
    it('gitFileStatuses returns empty files for non-git directory', async () => {
      // The resolver checks existsSync(join(path, '.git')) — a fake path won't have .git
      const { data, errors } = await execute(`
        query {
          gitFileStatuses(worktreePath: "/no/such/repo/path") {
            success
            files { path }
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitFileStatuses.success).toBe(true)
      expect(data?.gitFileStatuses.files).toEqual([])
      // createGitService should NOT have been called
      expect(mockGitService.getFileStatuses).not.toHaveBeenCalled()
    })

    // --- 3. gitDiff — returns diff string ---
    it('gitDiff returns diff string', async () => {
      mockGitService.getDiff.mockResolvedValue({
        success: true,
        diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
        fileName: 'file.ts'
      })

      const { data, errors } = await execute(`
        query($input: GitDiffInput!) {
          gitDiff(input: $input) { success diff fileName }
        }
      `, {
        input: {
          worktreePath: '/repo',
          filePath: 'file.ts',
          staged: false,
          isUntracked: false,
          contextLines: 3
        }
      })
      expect(errors).toBeUndefined()
      expect(data?.gitDiff.success).toBe(true)
      expect(data?.gitDiff.diff).toContain('-old')
      expect(data?.gitDiff.diff).toContain('+new')
      expect(mockGitService.getDiff).toHaveBeenCalledWith('file.ts', false, 3)
    })

    // --- 4. gitDiff — uses getUntrackedFileDiff when isUntracked: true ---
    it('gitDiff uses getUntrackedFileDiff when isUntracked is true', async () => {
      mockGitService.getUntrackedFileDiff.mockResolvedValue({
        success: true,
        diff: 'diff --git a/new.ts b/new.ts\nnew file mode 100644',
        fileName: 'new.ts'
      })

      const { data, errors } = await execute(`
        query($input: GitDiffInput!) {
          gitDiff(input: $input) { success diff fileName }
        }
      `, {
        input: {
          worktreePath: '/repo',
          filePath: 'new.ts',
          staged: false,
          isUntracked: true
        }
      })
      expect(errors).toBeUndefined()
      expect(data?.gitDiff.success).toBe(true)
      expect(data?.gitDiff.diff).toContain('new file mode')
      expect(mockGitService.getUntrackedFileDiff).toHaveBeenCalledWith('new.ts')
      expect(mockGitService.getDiff).not.toHaveBeenCalled()
    })

    // --- 5. gitDiffStat — returns file stats ---
    it('gitDiffStat returns file stats', async () => {
      mockGitService.getDiffStat.mockResolvedValue({
        success: true,
        files: [
          { path: 'src/index.ts', additions: 10, deletions: 3, binary: false },
          { path: 'logo.png', additions: 0, deletions: 0, binary: true }
        ]
      })

      const { data, errors } = await execute(`
        query {
          gitDiffStat(worktreePath: "/repo") {
            success
            files { path additions deletions binary }
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitDiffStat.success).toBe(true)
      expect(data?.gitDiffStat.files).toHaveLength(2)
      expect(data?.gitDiffStat.files[0]).toMatchObject({
        path: 'src/index.ts',
        additions: 10,
        deletions: 3,
        binary: false
      })
      expect(data?.gitDiffStat.files[1].binary).toBe(true)
    })

    // --- 6. gitBranchInfo — returns branch details ---
    it('gitBranchInfo returns branch details', async () => {
      mockGitService.getBranchInfo.mockResolvedValue({
        success: true,
        branch: {
          name: 'feature/awesome',
          tracking: 'origin/feature/awesome',
          ahead: 2,
          behind: 1
        }
      })

      const { data, errors } = await execute(`
        query {
          gitBranchInfo(worktreePath: "/repo") {
            success
            branch { name tracking ahead behind }
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitBranchInfo.success).toBe(true)
      expect(data?.gitBranchInfo.branch).toMatchObject({
        name: 'feature/awesome',
        tracking: 'origin/feature/awesome',
        ahead: 2,
        behind: 1
      })
    })

    // --- 7. gitBranchesWithStatus — returns branch list ---
    it('gitBranchesWithStatus returns branch list', async () => {
      mockGitService.listBranchesWithStatus.mockResolvedValue([
        { name: 'main', isRemote: false, isCheckedOut: true, worktreePath: '/repo' },
        { name: 'develop', isRemote: false, isCheckedOut: false, worktreePath: null },
        { name: 'origin/main', isRemote: true, isCheckedOut: false, worktreePath: null }
      ])

      const { data, errors } = await execute(`
        query {
          gitBranchesWithStatus(projectPath: "/repo") {
            success
            branches { name isRemote isCheckedOut worktreePath }
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitBranchesWithStatus.success).toBe(true)
      expect(data?.gitBranchesWithStatus.branches).toHaveLength(3)
      expect(data?.gitBranchesWithStatus.branches[0]).toMatchObject({
        name: 'main',
        isRemote: false,
        isCheckedOut: true
      })
      expect(data?.gitBranchesWithStatus.branches[2].isRemote).toBe(true)
    })
  })

  // =========================================================================
  // Git Mutation Resolvers
  // =========================================================================
  describe('Git Mutation Resolvers', () => {
    // --- 8. gitStageFile — stages a file ---
    it('gitStageFile stages a file', async () => {
      mockGitService.stageFile.mockResolvedValue({ success: true })

      const { data, errors } = await execute(`
        mutation {
          gitStageFile(worktreePath: "/repo", filePath: "src/app.ts") {
            success error
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitStageFile.success).toBe(true)
      expect(mockGitService.stageFile).toHaveBeenCalledWith('src/app.ts')
    })

    // --- 9. gitUnstageFile — unstages a file ---
    it('gitUnstageFile unstages a file', async () => {
      mockGitService.unstageFile.mockResolvedValue({ success: true })

      const { data, errors } = await execute(`
        mutation {
          gitUnstageFile(worktreePath: "/repo", filePath: "src/app.ts") {
            success error
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitUnstageFile.success).toBe(true)
      expect(mockGitService.unstageFile).toHaveBeenCalledWith('src/app.ts')
    })

    // --- 10. gitStageAll — stages all ---
    it('gitStageAll stages all files', async () => {
      mockGitService.stageAll.mockResolvedValue({ success: true })

      const { data, errors } = await execute(`
        mutation {
          gitStageAll(worktreePath: "/repo") { success error }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitStageAll.success).toBe(true)
      expect(mockGitService.stageAll).toHaveBeenCalled()
    })

    // --- 11. gitUnstageAll — unstages all ---
    it('gitUnstageAll unstages all files', async () => {
      mockGitService.unstageAll.mockResolvedValue({ success: true })

      const { data, errors } = await execute(`
        mutation {
          gitUnstageAll(worktreePath: "/repo") { success error }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitUnstageAll.success).toBe(true)
      expect(mockGitService.unstageAll).toHaveBeenCalled()
    })

    // --- 12. gitStageHunk — stages a hunk ---
    it('gitStageHunk stages a hunk', async () => {
      mockGitService.stageHunk.mockResolvedValue({ success: true })
      const patch = '@@ -1,3 +1,4 @@\n context\n-old\n+new\n+extra'

      const { data, errors } = await execute(`
        mutation($path: String!, $patch: String!) {
          gitStageHunk(worktreePath: $path, patch: $patch) { success error }
        }
      `, { path: '/repo', patch })
      expect(errors).toBeUndefined()
      expect(data?.gitStageHunk.success).toBe(true)
      expect(mockGitService.stageHunk).toHaveBeenCalledWith(patch)
    })

    // --- 13. gitUnstageHunk — unstages a hunk ---
    it('gitUnstageHunk unstages a hunk', async () => {
      mockGitService.unstageHunk.mockResolvedValue({ success: true })
      const patch = '@@ -1,3 +1,4 @@\n context\n-old\n+new'

      const { data, errors } = await execute(`
        mutation($path: String!, $patch: String!) {
          gitUnstageHunk(worktreePath: $path, patch: $patch) { success error }
        }
      `, { path: '/repo', patch })
      expect(errors).toBeUndefined()
      expect(data?.gitUnstageHunk.success).toBe(true)
      expect(mockGitService.unstageHunk).toHaveBeenCalledWith(patch)
    })

    // --- 14. gitCommit — returns commit hash on success ---
    it('gitCommit returns commit hash on success', async () => {
      mockGitService.commit.mockResolvedValue({
        success: true,
        commitHash: 'abc1234'
      })

      const { data, errors } = await execute(`
        mutation {
          gitCommit(worktreePath: "/repo", message: "feat: add feature") {
            success commitHash error
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitCommit.success).toBe(true)
      expect(data?.gitCommit.commitHash).toBe('abc1234')
      expect(data?.gitCommit.error).toBeNull()
      expect(mockGitService.commit).toHaveBeenCalledWith('feat: add feature')
    })

    // --- 15. gitCommit — returns error on failure ---
    it('gitCommit returns error on failure', async () => {
      mockGitService.commit.mockRejectedValue(new Error('nothing to commit'))

      const { data, errors } = await execute(`
        mutation {
          gitCommit(worktreePath: "/repo", message: "empty commit") {
            success commitHash error
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitCommit.success).toBe(false)
      expect(data?.gitCommit.commitHash).toBeNull()
      expect(data?.gitCommit.error).toBe('nothing to commit')
    })

    // --- 16. gitPush — pushes successfully ---
    it('gitPush pushes successfully', async () => {
      mockGitService.push.mockResolvedValue({ success: true })

      const { data, errors } = await execute(`
        mutation($input: GitPushInput!) {
          gitPush(input: $input) { success error }
        }
      `, {
        input: { worktreePath: '/repo', remote: 'origin', branch: 'main' }
      })
      expect(errors).toBeUndefined()
      expect(data?.gitPush.success).toBe(true)
      expect(mockGitService.push).toHaveBeenCalledWith('origin', 'main', undefined)
    })

    // --- 17. gitPull — pulls successfully ---
    it('gitPull pulls successfully', async () => {
      mockGitService.pull.mockResolvedValue({ success: true })

      const { data, errors } = await execute(`
        mutation($input: GitPullInput!) {
          gitPull(input: $input) { success error }
        }
      `, {
        input: { worktreePath: '/repo', remote: 'origin', branch: 'main', rebase: true }
      })
      expect(errors).toBeUndefined()
      expect(data?.gitPull.success).toBe(true)
      expect(mockGitService.pull).toHaveBeenCalledWith('origin', 'main', true)
    })

    // --- 18. gitMerge — merge success ---
    it('gitMerge returns success on clean merge', async () => {
      mockGitService.merge.mockResolvedValue({ success: true })

      const { data, errors } = await execute(`
        mutation {
          gitMerge(worktreePath: "/repo", sourceBranch: "feature/x") {
            success error conflicts
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitMerge.success).toBe(true)
      expect(data?.gitMerge.conflicts).toBeNull()
      expect(mockGitService.merge).toHaveBeenCalledWith('feature/x')
    })

    // --- 19. gitMerge — merge conflict ---
    it('gitMerge returns conflicts on merge conflict', async () => {
      mockGitService.merge.mockResolvedValue({
        success: false,
        error: 'conflict',
        conflicts: ['file.ts']
      })

      const { data, errors } = await execute(`
        mutation {
          gitMerge(worktreePath: "/repo", sourceBranch: "feature/conflict") {
            success error conflicts
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitMerge.success).toBe(false)
      expect(data?.gitMerge.error).toBe('conflict')
      expect(data?.gitMerge.conflicts).toEqual(['file.ts'])
    })

    // --- 20. gitDeleteBranch — deletes branch ---
    it('gitDeleteBranch deletes a branch', async () => {
      mockGitService.deleteBranch.mockResolvedValue({ success: true })

      const { data, errors } = await execute(`
        mutation {
          gitDeleteBranch(worktreePath: "/repo", branchName: "old-branch") {
            success error
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitDeleteBranch.success).toBe(true)
      expect(mockGitService.deleteBranch).toHaveBeenCalledWith('old-branch')
    })

    // --- 21. gitWatchWorktree — starts watching ---
    it('gitWatchWorktree starts watching', async () => {
      const { data, errors } = await execute(`
        mutation {
          gitWatchWorktree(worktreePath: "/repo") { success error }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitWatchWorktree.success).toBe(true)
      expect(watchWorktree).toHaveBeenCalledWith('/repo')
    })

    // --- 22. gitUnwatchWorktree — stops watching ---
    it('gitUnwatchWorktree stops watching', async () => {
      const { data, errors } = await execute(`
        mutation {
          gitUnwatchWorktree(worktreePath: "/repo") { success error }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data?.gitUnwatchWorktree.success).toBe(true)
      expect(unwatchWorktree).toHaveBeenCalledWith('/repo')
    })
  })
})
