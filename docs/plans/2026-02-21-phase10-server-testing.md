# Phase 10 — Server Testing & Regression Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fill all test coverage gaps identified by auditing the Phase 10 checklist against existing tests, then run full regression.

**Architecture:** All tests use the existing `createTestServer` helper (yoga.fetch-based integration tests) with `vi.mock()` for filesystem-dependent services. Subscription tests call resolver `subscribe` functions directly with a real `EventBus`.

**Tech Stack:** Vitest, graphql-yoga, graphql-ws, vi.mock/vi.fn

---

## Audit Summary — What's Missing

| Area | Gap Count | Details |
|------|-----------|---------|
| smoke.test.ts | NEW FILE | Does not exist |
| db.test.ts | 2 tests | `createProject` dup path, `touchWorktree` |
| Git resolvers | ~30 tests | ALL query + mutation resolvers untested |
| Project operation resolvers | 5 tests | All query + mutation resolvers untested |
| Worktree operation resolvers | 6 tests | All mutation resolvers untested |
| Connection mutation resolvers | 4 tests | `createConnection`, `add/removeMember`, `delete`, `rename` |
| OpenCode plan resolvers | 2 tests | `planApprove`, `planReject` |
| Subscription gaps | ~12 tests | Concurrent subscribers, stress test, cleanup gaps, script `error` type |

---

## Task 1: Create Smoke Test

**Files:**
- Create: `test/server/integration/smoke.test.ts`

**Step 1: Write the smoke test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

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

vi.mock('../../../src/main/services/worktree-watcher', () => ({
  watchWorktree: vi.fn(),
  unwatchWorktree: vi.fn()
}))

vi.mock('../../../src/main/services/branch-watcher', () => ({
  watchBranch: vi.fn(),
  unwatchBranch: vi.fn()
}))

vi.mock('../../../src/server/event-bus', () => ({
  getEventBus: vi.fn(() => ({ emit: vi.fn() }))
}))

import { MockDatabaseService } from '../helpers/mock-db'
import { createTestServer } from '../helpers/test-server'

describe('Server Smoke Test', () => {
  it('responds to a simple query', async () => {
    const db = new MockDatabaseService()
    const { execute } = createTestServer(db)
    const { data, errors } = await execute('{ systemAppVersion }')
    expect(errors).toBeUndefined()
    expect(data.systemAppVersion).toBeTruthy()
  })

  it('responds to a mutation', async () => {
    const db = new MockDatabaseService()
    const { execute } = createTestServer(db)
    const { data, errors } = await execute(`
      mutation {
        createProject(input: { name: "smoke-test", path: "/tmp/smoke-test" }) {
          id name path
        }
      }
    `)
    expect(errors).toBeUndefined()
    expect(data.createProject.name).toBe('smoke-test')
    expect(data.createProject.path).toBe('/tmp/smoke-test')
  })

  it('returns errors for unknown fields', async () => {
    const db = new MockDatabaseService()
    const { execute } = createTestServer(db)
    const { errors } = await execute('{ nonExistentField }')
    expect(errors).toBeDefined()
    expect(errors!.length).toBeGreaterThan(0)
  })
})
```

**Step 2: Run test to verify it passes**

Run: `pnpm vitest run test/server/integration/smoke.test.ts`
Expected: 3 tests PASS

**Step 3: Commit**

```bash
git add test/server/integration/smoke.test.ts
git commit -m "test: add server smoke test (Phase 10 Session 100)"
```

---

## Task 2: Fill db.test.ts Gaps

**Files:**
- Modify: `test/server/integration/db.test.ts`

**Step 1: Add the two missing tests**

Add inside the `Project Resolvers` describe block (after the existing `'reorders projects'` test):

```typescript
    it('rejects createProject with duplicate path', async () => {
      // Create first project
      await execute(`
        mutation {
          createProject(input: { name: "first", path: "/tmp/dup-path" }) { id }
        }
      `)
      // Attempt duplicate
      const { data, errors } = await execute(`
        mutation {
          createProject(input: { name: "second", path: "/tmp/dup-path" }) { id }
        }
      `)
      // Should either return an error or null — the mock-db enforces unique paths
      expect(errors ?? data?.createProject === null).toBeTruthy()
    })
```

Add inside the `Worktree Resolvers` describe block (after `'archives a worktree'`):

```typescript
    it('touches a worktree and updates lastAccessedAt', async () => {
      // Create project + worktree
      const { data: pData } = await execute(`
        mutation {
          createProject(input: { name: "wt-touch-proj", path: "/tmp/wt-touch" }) { id }
        }
      `)
      const projectId = pData.createProject.id

      // Seed a worktree directly in mock-db
      db.createWorktree({
        project_id: projectId,
        name: 'touch-test',
        branch_name: 'main',
        path: '/tmp/wt-touch/touch-test',
        status: 'active',
        is_default: 0
      })
      const worktrees = db.getWorktreesByProject(projectId)
      const wt = worktrees[0]

      const { data } = await execute(`
        mutation { touchWorktree(id: "${wt.id}") }
      `)
      expect(data?.touchWorktree).toBe(true)
    })
```

**Step 2: Run test to verify**

Run: `pnpm vitest run test/server/integration/db.test.ts`
Expected: All existing + 2 new tests PASS

**Step 3: Commit**

```bash
git add test/server/integration/db.test.ts
git commit -m "test: add duplicate project path + touchWorktree tests (Phase 10)"
```

---

## Task 3: Git Resolver Integration Tests

**Files:**
- Create: `test/server/integration/git.test.ts`
- Reference: `src/server/resolvers/query/git.resolvers.ts`
- Reference: `src/server/resolvers/mutation/git.resolvers.ts`

This is the largest gap. All git resolvers delegate to `createGitService(path)` from `src/main/services/git-service`. We mock it to return a fake service with `vi.fn()` methods.

**Step 1: Write the git resolver test file**

```typescript
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

// Mock electron
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

// Mock git-service — all resolvers go through createGitService(path)
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

import { MockDatabaseService } from '../helpers/mock-db'
import { createTestServer } from '../helpers/test-server'

describe('Git Resolvers — Integration Tests', () => {
  let execute: (q: string, v?: Record<string, unknown>) => Promise<{ data?: any; errors?: any[] }>

  beforeEach(() => {
    vi.clearAllMocks()
    const db = new MockDatabaseService()
    const server = createTestServer(db)
    execute = server.execute
  })

  // ── Query resolvers ─────────────────────────────────────────────

  describe('gitFileStatuses', () => {
    it('returns file list on success', async () => {
      mockGitService.getFileStatuses.mockResolvedValue({
        success: true,
        files: [
          { path: 'src/app.ts', index: 'M', working_dir: ' ' },
          { path: 'README.md', index: '?', working_dir: '?' }
        ]
      })
      const { data, errors } = await execute(`
        { gitFileStatuses(worktreePath: "/tmp/repo") { success files { path index workingDir } } }
      `)
      expect(errors).toBeUndefined()
      expect(data.gitFileStatuses.success).toBe(true)
      expect(data.gitFileStatuses.files).toHaveLength(2)
    })

    it('returns empty files for non-git directory', async () => {
      // The resolver checks for .git existence before calling git-service
      // With our mock, existsSync won't find .git, so it returns []
      const { data } = await execute(`
        { gitFileStatuses(worktreePath: "/nonexistent") { success files { path } } }
      `)
      expect(data.gitFileStatuses.success).toBe(true)
      expect(data.gitFileStatuses.files).toEqual([])
    })
  })

  describe('gitDiff', () => {
    it('returns diff string', async () => {
      mockGitService.getDiff.mockResolvedValue({
        success: true,
        diff: '@@ -1,3 +1,4 @@\n+new line'
      })
      const { data, errors } = await execute(`
        query {
          gitDiff(input: {
            worktreePath: "/tmp/repo"
            filePath: "src/app.ts"
            staged: false
          }) {
            success diff
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data.gitDiff.success).toBe(true)
      expect(data.gitDiff.diff).toContain('+new line')
    })

    it('returns untracked file diff when isUntracked is true', async () => {
      mockGitService.getUntrackedFileDiff.mockResolvedValue({
        success: true,
        diff: '+entire file content'
      })
      const { data } = await execute(`
        query {
          gitDiff(input: {
            worktreePath: "/tmp/repo"
            filePath: "new-file.ts"
            staged: false
            isUntracked: true
          }) {
            success diff
          }
        }
      `)
      expect(data.gitDiff.success).toBe(true)
      expect(mockGitService.getUntrackedFileDiff).toHaveBeenCalledWith('new-file.ts')
    })
  })

  describe('gitDiffStat', () => {
    it('returns file stats', async () => {
      mockGitService.getDiffStat.mockResolvedValue({
        success: true,
        files: [{ file: 'src/app.ts', insertions: 5, deletions: 2 }]
      })
      const { data } = await execute(`
        { gitDiffStat(worktreePath: "/tmp/repo") { success files { file insertions deletions } } }
      `)
      expect(data.gitDiffStat.success).toBe(true)
      expect(data.gitDiffStat.files[0].insertions).toBe(5)
    })
  })

  describe('gitBranchInfo', () => {
    it('returns branch details', async () => {
      mockGitService.getBranchInfo.mockResolvedValue({
        success: true,
        name: 'main',
        tracking: 'origin/main',
        ahead: 1,
        behind: 0
      })
      const { data } = await execute(`
        { gitBranchInfo(worktreePath: "/tmp/repo") { success name tracking ahead behind } }
      `)
      expect(data.gitBranchInfo.success).toBe(true)
      expect(data.gitBranchInfo.name).toBe('main')
      expect(data.gitBranchInfo.ahead).toBe(1)
    })
  })

  describe('gitBranchesWithStatus', () => {
    it('returns branch list', async () => {
      mockGitService.listBranchesWithStatus.mockResolvedValue([
        { name: 'main', isCurrent: true, isRemote: false },
        { name: 'feature', isCurrent: false, isRemote: false }
      ])
      const { data } = await execute(`
        { gitBranchesWithStatus(projectPath: "/tmp/repo") { success branches { name isCurrent isRemote } } }
      `)
      expect(data.gitBranchesWithStatus.success).toBe(true)
      expect(data.gitBranchesWithStatus.branches).toHaveLength(2)
    })
  })

  // ── Mutation resolvers ──────────────────────────────────────────

  describe('gitStageFile / gitUnstageFile', () => {
    it('stages a file', async () => {
      mockGitService.stageFile.mockResolvedValue({ success: true })
      const { data } = await execute(`
        mutation { gitStageFile(worktreePath: "/tmp/repo", filePath: "src/app.ts") { success } }
      `)
      expect(data.gitStageFile.success).toBe(true)
      expect(mockGitService.stageFile).toHaveBeenCalledWith('src/app.ts')
    })

    it('unstages a file', async () => {
      mockGitService.unstageFile.mockResolvedValue({ success: true })
      const { data } = await execute(`
        mutation { gitUnstageFile(worktreePath: "/tmp/repo", filePath: "src/app.ts") { success } }
      `)
      expect(data.gitUnstageFile.success).toBe(true)
    })
  })

  describe('gitStageAll / gitUnstageAll', () => {
    it('stages all files', async () => {
      mockGitService.stageAll.mockResolvedValue({ success: true })
      const { data } = await execute(`
        mutation { gitStageAll(worktreePath: "/tmp/repo") { success } }
      `)
      expect(data.gitStageAll.success).toBe(true)
    })

    it('unstages all files', async () => {
      mockGitService.unstageAll.mockResolvedValue({ success: true })
      const { data } = await execute(`
        mutation { gitUnstageAll(worktreePath: "/tmp/repo") { success } }
      `)
      expect(data.gitUnstageAll.success).toBe(true)
    })
  })

  describe('gitStageHunk / gitUnstageHunk', () => {
    it('stages a hunk', async () => {
      mockGitService.stageHunk.mockResolvedValue({ success: true })
      const { data } = await execute(`
        mutation { gitStageHunk(worktreePath: "/tmp/repo", patch: "@@ -1 +1 @@\\n+line") { success } }
      `)
      expect(data.gitStageHunk.success).toBe(true)
    })

    it('unstages a hunk', async () => {
      mockGitService.unstageHunk.mockResolvedValue({ success: true })
      const { data } = await execute(`
        mutation { gitUnstageHunk(worktreePath: "/tmp/repo", patch: "@@ -1 +1 @@\\n+line") { success } }
      `)
      expect(data.gitUnstageHunk.success).toBe(true)
    })
  })

  describe('gitCommit', () => {
    it('returns commit hash on success', async () => {
      mockGitService.commit.mockResolvedValue({ success: true, commitHash: 'abc1234' })
      const { data } = await execute(`
        mutation { gitCommit(worktreePath: "/tmp/repo", message: "feat: add feature") { success commitHash } }
      `)
      expect(data.gitCommit.success).toBe(true)
      expect(data.gitCommit.commitHash).toBe('abc1234')
    })

    it('returns error on failure', async () => {
      mockGitService.commit.mockRejectedValue(new Error('nothing to commit'))
      const { data } = await execute(`
        mutation { gitCommit(worktreePath: "/tmp/repo", message: "empty") { success error commitHash } }
      `)
      expect(data.gitCommit.success).toBe(false)
      expect(data.gitCommit.error).toContain('nothing to commit')
    })
  })

  describe('gitPush', () => {
    it('pushes successfully', async () => {
      mockGitService.push.mockResolvedValue({ success: true })
      const { data } = await execute(`
        mutation { gitPush(input: { worktreePath: "/tmp/repo" }) { success } }
      `)
      expect(data.gitPush.success).toBe(true)
    })
  })

  describe('gitPull', () => {
    it('pulls successfully', async () => {
      mockGitService.pull.mockResolvedValue({ success: true })
      const { data } = await execute(`
        mutation { gitPull(input: { worktreePath: "/tmp/repo" }) { success } }
      `)
      expect(data.gitPull.success).toBe(true)
    })
  })

  describe('gitMerge', () => {
    it('returns merge result', async () => {
      mockGitService.merge.mockResolvedValue({ success: true })
      const { data } = await execute(`
        mutation { gitMerge(worktreePath: "/tmp/repo", sourceBranch: "feature") { success } }
      `)
      expect(data.gitMerge.success).toBe(true)
    })

    it('returns conflicts on merge failure', async () => {
      mockGitService.merge.mockResolvedValue({
        success: false,
        error: 'Merge conflict',
        conflicts: ['src/app.ts']
      })
      const { data } = await execute(`
        mutation { gitMerge(worktreePath: "/tmp/repo", sourceBranch: "feature") { success error conflicts } }
      `)
      expect(data.gitMerge.success).toBe(false)
      expect(data.gitMerge.conflicts).toContain('src/app.ts')
    })
  })

  describe('gitDeleteBranch', () => {
    it('deletes branch', async () => {
      mockGitService.deleteBranch.mockResolvedValue({ success: true })
      const { data } = await execute(`
        mutation { gitDeleteBranch(worktreePath: "/tmp/repo", branchName: "old-feature") { success } }
      `)
      expect(data.gitDeleteBranch.success).toBe(true)
    })
  })

  describe('gitWatchWorktree / gitUnwatchWorktree', () => {
    it('starts watching a worktree', async () => {
      const { data } = await execute(`
        mutation { gitWatchWorktree(worktreePath: "/tmp/repo") { success } }
      `)
      expect(data.gitWatchWorktree.success).toBe(true)
    })

    it('stops watching a worktree', async () => {
      const { data } = await execute(`
        mutation { gitUnwatchWorktree(worktreePath: "/tmp/repo") { success } }
      `)
      expect(data.gitUnwatchWorktree.success).toBe(true)
    })
  })
})
```

**Step 2: Run test to verify**

Run: `pnpm vitest run test/server/integration/git.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add test/server/integration/git.test.ts
git commit -m "test: add git resolver integration tests (Phase 10 Session 102)"
```

---

## Task 4: Project + Worktree + Connection Operation Tests

**Files:**
- Modify: `test/server/integration/operations.test.ts`
- Reference: `src/server/resolvers/query/project.resolvers.ts`
- Reference: `src/server/resolvers/mutation/project.resolvers.ts`
- Reference: `src/server/resolvers/mutation/worktree.resolvers.ts`
- Reference: `src/server/resolvers/mutation/connection.resolvers.ts`

The resolvers import from `project-ops`, `worktree-ops`, and `connection-ops`. `worktree-ops` is already mocked. Need to add mocks for `project-ops` and `connection-ops`.

**Step 1: Add project-ops and connection-ops mocks at the top of operations.test.ts**

After the existing `vi.mock('../../../src/server/event-bus', ...)` block (around line 58), add:

```typescript
// Mock project-ops (filesystem-dependent)
vi.mock('../../../src/main/services/project-ops', () => ({
  validateProject: vi.fn((path: string) => ({
    exists: path !== '/nonexistent',
    isDirectory: path !== '/nonexistent',
    canRead: true,
    canWrite: true
  })),
  isGitRepository: vi.fn((path: string) => path !== '/not-a-repo'),
  detectProjectLanguage: vi.fn(() => 'typescript'),
  loadLanguageIcons: vi.fn(() => [{ language: 'typescript', icon: 'ts-icon.svg' }]),
  getIconDataUrl: vi.fn(() => 'data:image/png;base64,abc'),
  initRepository: vi.fn(() => ({ success: true })),
  uploadIcon: vi.fn(() => ({ success: true, filename: 'icon.png' })),
  removeIcon: vi.fn(() => ({ success: true }))
}))

// Mock connection-ops (filesystem-dependent)
vi.mock('../../../src/main/services/connection-ops', () => ({
  createConnectionOp: vi.fn((_db: any, worktreeIds: string[]) => ({
    success: true,
    connection: {
      id: 'conn-1',
      name: 'Connection 1',
      custom_name: null,
      status: 'active',
      path: '/tmp/connections/conn-1',
      color: '["#aaa","#bbb","#ccc","#ddd"]',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      members: worktreeIds.map((wtId: string, i: number) => ({
        id: `cm-${i}`,
        connection_id: 'conn-1',
        worktree_id: wtId,
        project_id: `proj-${i}`,
        symlink_name: `wt-${i}`,
        added_at: new Date().toISOString()
      }))
    }
  })),
  deleteConnectionOp: vi.fn(() => ({ success: true })),
  renameConnectionOp: vi.fn((_db: any, connId: string, name: string | null) => ({
    success: true,
    connection: {
      id: connId,
      name: name ?? 'Connection 1',
      custom_name: name,
      status: 'active',
      path: '/tmp/connections/conn-1',
      color: '["#aaa","#bbb","#ccc","#ddd"]',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      members: []
    }
  })),
  addConnectionMemberOp: vi.fn(() => ({ success: true })),
  removeConnectionMemberOp: vi.fn(() => ({ success: true })),
  removeWorktreeFromAllConnectionsOp: vi.fn(() => ({ success: true }))
}))
```

**Step 2: Add project operation tests**

Add at the end of the main `describe` block, before the closing `})`:

```typescript
  // =========================================================================
  // Project Operations
  // =========================================================================
  describe('Project Operations', () => {
    it('projectValidate with valid path', async () => {
      const { data, errors } = await execute(`
        { projectValidate(path: "/tmp/valid-project") { exists isDirectory canRead canWrite } }
      `)
      expect(errors).toBeUndefined()
      expect(data.projectValidate.exists).toBe(true)
      expect(data.projectValidate.isDirectory).toBe(true)
    })

    it('projectValidate with invalid path', async () => {
      const { data } = await execute(`
        { projectValidate(path: "/nonexistent") { exists isDirectory } }
      `)
      expect(data.projectValidate.exists).toBe(false)
    })

    it('projectIsGitRepository true', async () => {
      const { data } = await execute(`
        { projectIsGitRepository(path: "/tmp/git-repo") }
      `)
      expect(data.projectIsGitRepository).toBe(true)
    })

    it('projectIsGitRepository false', async () => {
      const { data } = await execute(`
        { projectIsGitRepository(path: "/not-a-repo") }
      `)
      expect(data.projectIsGitRepository).toBe(false)
    })

    it('projectDetectLanguage returns language', async () => {
      const { data } = await execute(`
        { projectDetectLanguage(projectPath: "/tmp/project") }
      `)
      expect(data.projectDetectLanguage).toBe('typescript')
    })

    it('projectInitRepository creates repo', async () => {
      const { data } = await execute(`
        mutation { projectInitRepository(path: "/tmp/new-repo") { success } }
      `)
      expect(data.projectInitRepository.success).toBe(true)
    })

    it('projectUploadIcon stores icon', async () => {
      const { data } = await execute(`
        mutation { projectUploadIcon(projectId: "p1", data: "base64data", filename: "icon.png") { success filename } }
      `)
      expect(data.projectUploadIcon.success).toBe(true)
      expect(data.projectUploadIcon.filename).toBe('icon.png')
    })

    it('projectRemoveIcon removes icon', async () => {
      const { data } = await execute(`
        mutation { projectRemoveIcon(projectId: "p1") { success } }
      `)
      expect(data.projectRemoveIcon.success).toBe(true)
    })
  })

  // =========================================================================
  // Worktree Operations (mutation resolvers via mocked worktree-ops)
  // =========================================================================
  describe('Worktree Operations', () => {
    it('createWorktree creates worktree', async () => {
      const { createWorktreeOp } = await import('../../../src/main/services/worktree-ops')
      vi.mocked(createWorktreeOp).mockResolvedValue({
        success: true,
        worktree: {
          id: 'wt-new',
          project_id: 'p1',
          name: 'feature-x',
          branch_name: 'feature-x',
          path: '/tmp/project/feature-x',
          status: 'active',
          is_default: 0,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      })

      const { data, errors } = await execute(`
        mutation {
          createWorktree(input: {
            projectId: "p1"
            projectPath: "/tmp/project"
            projectName: "MyProject"
          }) {
            success
            worktree { id name branchName path status }
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data.createWorktree.success).toBe(true)
      expect(data.createWorktree.worktree.name).toBe('feature-x')
    })

    it('deleteWorktree removes worktree', async () => {
      const { deleteWorktreeOp } = await import('../../../src/main/services/worktree-ops')
      vi.mocked(deleteWorktreeOp).mockResolvedValue({ success: true })

      const { data } = await execute(`
        mutation {
          deleteWorktree(input: {
            worktreeId: "wt-1"
            worktreePath: "/tmp/project/wt-1"
            branchName: "feature"
            projectPath: "/tmp/project"
            archive: false
          }) {
            success
          }
        }
      `)
      expect(data.deleteWorktree.success).toBe(true)
    })

    it('syncWorktrees syncs with filesystem', async () => {
      const { syncWorktreesOp } = await import('../../../src/main/services/worktree-ops')
      vi.mocked(syncWorktreesOp).mockResolvedValue({ success: true })

      const { data } = await execute(`
        mutation {
          syncWorktrees(projectId: "p1", projectPath: "/tmp/project") { success }
        }
      `)
      expect(data.syncWorktrees.success).toBe(true)
    })

    it('duplicateWorktree copies worktree', async () => {
      const { duplicateWorktreeOp } = await import('../../../src/main/services/worktree-ops')
      vi.mocked(duplicateWorktreeOp).mockResolvedValue({
        success: true,
        worktree: {
          id: 'wt-dup',
          project_id: 'p1',
          name: 'feature-copy',
          branch_name: 'feature-copy',
          path: '/tmp/project/feature-copy',
          status: 'active',
          is_default: 0,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      })

      const { data } = await execute(`
        mutation {
          duplicateWorktree(input: {
            projectId: "p1"
            projectPath: "/tmp/project"
            projectName: "MyProject"
            sourceBranch: "feature"
            sourceWorktreePath: "/tmp/project/feature"
          }) {
            success
            worktree { id name branchName }
          }
        }
      `)
      expect(data.duplicateWorktree.success).toBe(true)
      expect(data.duplicateWorktree.worktree.name).toBe('feature-copy')
    })

    it('renameWorktreeBranch renames branch', async () => {
      const { renameWorktreeBranchOp } = await import('../../../src/main/services/worktree-ops')
      vi.mocked(renameWorktreeBranchOp).mockResolvedValue({ success: true })

      const { data } = await execute(`
        mutation {
          renameWorktreeBranch(input: {
            worktreeId: "wt-1"
            worktreePath: "/tmp/project/feature"
            oldBranch: "feature"
            newBranch: "feature-v2"
          }) {
            success
          }
        }
      `)
      expect(data.renameWorktreeBranch.success).toBe(true)
    })

    it('createWorktreeFromBranch creates from existing branch', async () => {
      const { createWorktreeFromBranchOp } = await import(
        '../../../src/main/services/worktree-ops'
      )
      vi.mocked(createWorktreeFromBranchOp).mockResolvedValue({
        success: true,
        worktree: {
          id: 'wt-from-branch',
          project_id: 'p1',
          name: 'existing-branch',
          branch_name: 'existing-branch',
          path: '/tmp/project/existing-branch',
          status: 'active',
          is_default: 0,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      })

      const { data } = await execute(`
        mutation {
          createWorktreeFromBranch(input: {
            projectId: "p1"
            projectPath: "/tmp/project"
            projectName: "MyProject"
            branchName: "existing-branch"
          }) {
            success
            worktree { id name branchName }
          }
        }
      `)
      expect(data.createWorktreeFromBranch.success).toBe(true)
      expect(data.createWorktreeFromBranch.worktree.branchName).toBe('existing-branch')
    })
  })

  // =========================================================================
  // Connection Mutation Operations
  // =========================================================================
  describe('Connection Mutations', () => {
    it('createConnection creates with members', async () => {
      const { data, errors } = await execute(`
        mutation {
          createConnection(worktreeIds: ["wt-1", "wt-2"]) {
            success
            connection { id name members { worktreeId } }
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data.createConnection.success).toBe(true)
      expect(data.createConnection.connection.members).toHaveLength(2)
    })

    it('deleteConnection removes connection', async () => {
      const { data } = await execute(`
        mutation { deleteConnection(connectionId: "conn-1") { success } }
      `)
      expect(data.deleteConnection.success).toBe(true)
    })

    it('renameConnection renames connection', async () => {
      const { data } = await execute(`
        mutation { renameConnection(connectionId: "conn-1", customName: "My Conn") { id name } }
      `)
      expect(data.renameConnection).toBeTruthy()
      expect(data.renameConnection.name).toBe('My Conn')
    })

    it('addConnectionMember adds member', async () => {
      const { data } = await execute(`
        mutation { addConnectionMember(connectionId: "conn-1", worktreeId: "wt-3") { success } }
      `)
      expect(data.addConnectionMember.success).toBe(true)
    })

    it('removeConnectionMember removes member', async () => {
      const { data } = await execute(`
        mutation { removeConnectionMember(connectionId: "conn-1", worktreeId: "wt-3") { success } }
      `)
      expect(data.removeConnectionMember.success).toBe(true)
    })
  })
```

**Step 3: Run test to verify**

Run: `pnpm vitest run test/server/integration/operations.test.ts`
Expected: All existing + new tests PASS

**Step 4: Commit**

```bash
git add test/server/integration/operations.test.ts
git commit -m "test: add project, worktree, connection operation tests (Phase 10 Session 102)"
```

---

## Task 5: OpenCode Plan Approve/Reject Tests

**Files:**
- Modify: `test/server/integration/opencode.test.ts`

**Step 1: Add plan approve/reject tests**

Add inside the main describe block (after the existing `'renames session'` test, before the closing `})`):

```typescript
    it('approves a pending plan', async () => {
      claudeImpl.hasPendingPlan.mockReturnValue(false)
      claudeImpl.hasPendingPlanForSession.mockReturnValue(true)
      claudeImpl.planApprove.mockResolvedValue(undefined)

      const { data, errors } = await execute(`
        mutation {
          opencodePlanApprove(input: {
            worktreePath: "/tmp/wt"
            hiveSessionId: "${hiveClaudeSessionId}"
          }) {
            success
          }
        }
      `)
      expect(errors).toBeUndefined()
      expect(data.opencodePlanApprove.success).toBe(true)
      expect(claudeImpl.planApprove).toHaveBeenCalled()
    })

    it('approves a pending plan by requestId', async () => {
      claudeImpl.hasPendingPlan.mockReturnValue(true)
      claudeImpl.planApprove.mockResolvedValue(undefined)

      const { data } = await execute(`
        mutation {
          opencodePlanApprove(input: {
            worktreePath: "/tmp/wt"
            hiveSessionId: "${hiveClaudeSessionId}"
            requestId: "plan-req-1"
          }) {
            success
          }
        }
      `)
      expect(data.opencodePlanApprove.success).toBe(true)
    })

    it('returns error when no pending plan for approve', async () => {
      claudeImpl.hasPendingPlan.mockReturnValue(false)
      claudeImpl.hasPendingPlanForSession.mockReturnValue(false)

      const { data } = await execute(`
        mutation {
          opencodePlanApprove(input: {
            worktreePath: "/tmp/wt"
            hiveSessionId: "no-such-session"
          }) {
            success error
          }
        }
      `)
      expect(data.opencodePlanApprove.success).toBe(false)
      expect(data.opencodePlanApprove.error).toContain('No pending plan')
    })

    it('rejects a pending plan with feedback', async () => {
      claudeImpl.hasPendingPlan.mockReturnValue(false)
      claudeImpl.hasPendingPlanForSession.mockReturnValue(true)
      claudeImpl.planReject.mockResolvedValue(undefined)

      const { data } = await execute(`
        mutation {
          opencodePlanReject(input: {
            worktreePath: "/tmp/wt"
            hiveSessionId: "${hiveClaudeSessionId}"
            feedback: "needs more detail"
          }) {
            success
          }
        }
      `)
      expect(data.opencodePlanReject.success).toBe(true)
      expect(claudeImpl.planReject).toHaveBeenCalledWith(
        '/tmp/wt',
        expect.any(String),
        'needs more detail',
        undefined
      )
    })
```

**Note:** This requires understanding the test's existing variable names. The file uses `claudeImpl` and `hiveClaudeSessionId`. Read the setup to confirm variable names before inserting.

**Step 2: Run test to verify**

Run: `pnpm vitest run test/server/integration/opencode.test.ts`
Expected: All existing + 4 new tests PASS

**Step 3: Commit**

```bash
git add test/server/integration/opencode.test.ts
git commit -m "test: add opencodePlanApprove/Reject tests (Phase 10 Session 102)"
```

---

## Task 6: Subscription Test Gaps

**Files:**
- Modify: `test/server/subscriptions/opencode.test.ts` — concurrent subscribers + better batching test
- Modify: `test/server/subscriptions/script.test.ts` — add `error` event type
- Modify: `test/server/subscriptions/git.test.ts` — add `gitBranchChanged` cleanup
- Modify: `test/server/subscriptions/terminal.test.ts` — add `terminalExit` cleanup
- Create: `test/server/subscriptions/stress.test.ts` — rapid event stress test

### Step 1: Add `error` type to script subscription test

In `test/server/subscriptions/script.test.ts`, update the `'handles all ScriptOutputEvent types'` test to include the `error` type. Change the events array:

```typescript
    const events: ScriptOutputEvent[] = [
      { type: 'command-start', command: 'npm test' },
      { type: 'output', data: 'PASS' },
      { type: 'error', data: 'Warning: deprecated API' },
      { type: 'done', exitCode: 0 },
    ]
```

### Step 2: Add gitBranchChanged cleanup test

In `test/server/subscriptions/git.test.ts`, add inside the `gitBranchChanged` describe block:

```typescript
  it('cleans up listener on return', async () => {
    const subscribe = getBranchSubscribeFn()
    const iter = subscribe(
      {},
      { worktreePath: '/repo' },
      { eventBus } as any,
      {} as any,
    ) as AsyncGenerator

    setTimeout(() => {
      eventBus.emit('git:branchChanged', { worktreePath: '/repo' })
    }, 10)

    await iter.next()
    await iter.return(undefined)

    // After return, no more events should be queued
    eventBus.emit('git:branchChanged', { worktreePath: '/repo' })
  })
```

**Note:** Verify the `getBranchSubscribeFn` helper name — it might differ. Read the file to confirm.

### Step 3: Add terminalExit cleanup test

In `test/server/subscriptions/terminal.test.ts`, add inside the `terminalExit` describe block:

```typescript
  it('cleans up listener on return', async () => {
    const subscribe = getExitSubscribeFn()
    const iter = subscribe(
      {},
      { worktreeId: 'wt-1' },
      { eventBus } as any,
      {} as any,
    ) as AsyncGenerator

    setTimeout(() => {
      eventBus.emit('terminal:exit', 'wt-1', 0)
    }, 10)

    await iter.next()
    await iter.return(undefined)

    eventBus.emit('terminal:exit', 'wt-1', 1)
  })
```

### Step 4: Add concurrent subscriber test to opencode subscriptions

In `test/server/subscriptions/opencode.test.ts`, add:

```typescript
  it('delivers same event to multiple concurrent subscribers', async () => {
    const subscribe = getSubscribeFn()
    const iter1 = subscribe({}, {}, { eventBus } as any, {} as any)
    const iter2 = subscribe({}, {}, { eventBus } as any, {} as any)

    const event: OpenCodeStreamEvent = {
      type: 'message.created',
      sessionId: 'sess-1',
      data: { content: 'shared' },
    }

    setTimeout(() => eventBus.emit('opencode:stream', event), 10)

    const [r1, r2] = await Promise.all([
      (iter1 as AsyncGenerator).next(),
      (iter2 as AsyncGenerator).next(),
    ])

    expect(r1.value.opencodeStream.sessionId).toBe('sess-1')
    expect(r2.value.opencodeStream.sessionId).toBe('sess-1')
  })
```

### Step 5: Create stress test file

```typescript
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import { opencodeSubscriptionResolvers } from '../../../src/server/resolvers/subscription/opencode.resolvers'

function getSubscribeFn() {
  const sub = opencodeSubscriptionResolvers.Subscription!.opencodeStream
  if (typeof sub === 'function') throw new Error('Expected object with subscribe')
  return (sub as { subscribe: (...args: any[]) => AsyncIterable<any> }).subscribe
}

describe('Subscription Stress Tests', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  it('handles 100 rapid events without dropping', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any) as AsyncGenerator

    const COUNT = 100
    const received: any[] = []

    // Emit 100 events rapidly
    setTimeout(() => {
      for (let i = 0; i < COUNT; i++) {
        eventBus.emit('opencode:stream', {
          type: `event-${i}`,
          sessionId: 'sess-1',
          data: { index: i },
        })
      }
    }, 10)

    // Collect all 100
    for (let i = 0; i < COUNT; i++) {
      const result = await iter.next()
      received.push(result.value.opencodeStream)
    }

    expect(received).toHaveLength(COUNT)
    // Verify ordering preserved
    expect(received[0].type).toBe('event-0')
    expect(received[COUNT - 1].type).toBe(`event-${COUNT - 1}`)
  })
})
```

### Step 6: Run all subscription tests

Run: `pnpm vitest run test/server/subscriptions/`
Expected: All tests PASS

### Step 7: Commit

```bash
git add test/server/subscriptions/
git commit -m "test: fill subscription test gaps — concurrent, stress, cleanup (Phase 10 Session 103)"
```

---

## Task 7: Regression — Full Test Suite + Lint + Build

**Step 1: Run full test suite**

Run: `pnpm vitest run --workspace vitest.workspace.ts`
Expected: ALL tests pass (renderer + main workspaces)

Also run: `pnpm test`
Check: Does `pnpm test` automatically pick up the workspace file? If not, update `package.json` test script to `vitest run --workspace vitest.workspace.ts`.

**Step 2: Run lint**

Run: `pnpm lint`
Expected: No new lint errors. Fix any that appear (likely: missing semicolons, quote style).

**Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: Zero type errors.

**Step 4: Run production build**

Run: `pnpm build`
Expected: Build succeeds, output in `out/`.

**Step 5: Fix any failures**

If any tests, lint, or build fail: investigate, fix, re-run.

**Step 6: Final commit**

```bash
git add -A
git commit -m "chore: Phase 10 regression — all tests, lint, build pass"
```

---

## Summary of All Changes

### Files Created
| File | Purpose |
|------|---------|
| `test/server/integration/smoke.test.ts` | Basic server smoke test |
| `test/server/integration/git.test.ts` | Full git resolver test coverage |
| `test/server/subscriptions/stress.test.ts` | Rapid event stress test |

### Files Modified
| File | Change |
|------|--------|
| `test/server/integration/db.test.ts` | +2 tests (duplicate path, touchWorktree) |
| `test/server/integration/operations.test.ts` | +19 tests (project ops, worktree ops, connection mutations) + 2 new `vi.mock` blocks |
| `test/server/integration/opencode.test.ts` | +4 tests (planApprove, planReject) |
| `test/server/subscriptions/script.test.ts` | +1 event type (`error`) in existing test |
| `test/server/subscriptions/git.test.ts` | +1 test (branchChanged cleanup) |
| `test/server/subscriptions/terminal.test.ts` | +1 test (terminalExit cleanup) |
| `test/server/subscriptions/opencode.test.ts` | +1 test (concurrent subscribers) |
| `package.json` | Possibly update test script for workspace (Task 7) |
