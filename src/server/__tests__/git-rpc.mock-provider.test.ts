import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { GIT_STATUS_CHANGED_CHANNEL } from '@shared/git-events'
import { makeEventBus } from '../events/event-bus'
import type { GitOpsRpcService } from '../rpc/domains/git-ops'
import { makeRpcRouter } from '../rpc/router'

describe('git ops RPC mocked provider', () => {
  it('routes gitOps.getFileStatuses to the injected provider service', async () => {
    const files = [
      {
        path: '/repo/src/App.tsx',
        relativePath: 'src/App.tsx',
        status: 'M',
        staged: false
      }
    ]
    const getFileStatuses = vi.fn(() => Effect.succeed({ success: true, files }))
    const service = { getFileStatuses } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-file-statuses-1',
        method: 'gitOps.getFileStatuses',
        params: { worktreePath: '/repo' }
      })
    )

    expect(getFileStatuses).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-file-statuses-1',
      ok: true,
      value: { success: true, files }
    })
  })

  it('validates gitOps.getFileStatuses params before calling the provider service', async () => {
    const getFileStatuses = vi.fn(() => Effect.succeed({ success: true, files: [] }))
    const service = { getFileStatuses } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-file-statuses-invalid',
        method: 'gitOps.getFileStatuses',
        params: { worktreePath: '' }
      })
    )

    expect(getFileStatuses).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-file-statuses-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.stageFile to the injected provider service', async () => {
    const stageFile = vi.fn(() => Effect.succeed({ success: true }))
    const service = { stageFile } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-stage-file-1',
        method: 'gitOps.stageFile',
        params: { worktreePath: '/repo', filePath: 'src/App.tsx' }
      })
    )

    expect(stageFile).toHaveBeenCalledWith('/repo', 'src/App.tsx')
    expect(response).toEqual({
      id: 'git-stage-file-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.stageFile params before calling the provider service', async () => {
    const stageFile = vi.fn(() => Effect.succeed({ success: true }))
    const service = { stageFile } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-stage-file-invalid',
        method: 'gitOps.stageFile',
        params: { worktreePath: '/repo', filePath: '' }
      })
    )

    expect(stageFile).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-stage-file-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.unstageFile to the injected provider service', async () => {
    const unstageFile = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unstageFile } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-unstage-file-1',
        method: 'gitOps.unstageFile',
        params: { worktreePath: '/repo', filePath: 'src/App.tsx' }
      })
    )

    expect(unstageFile).toHaveBeenCalledWith('/repo', 'src/App.tsx')
    expect(response).toEqual({
      id: 'git-unstage-file-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.unstageFile params before calling the provider service', async () => {
    const unstageFile = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unstageFile } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-unstage-file-invalid',
        method: 'gitOps.unstageFile',
        params: { worktreePath: '/repo', filePath: '' }
      })
    )

    expect(unstageFile).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-unstage-file-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.discardChanges to the injected provider service', async () => {
    const discardChanges = vi.fn(() => Effect.succeed(null))
    const service = { discardChanges } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-discard-changes-1',
        method: 'gitOps.discardChanges',
        params: { worktreePath: '/repo', filePath: 'src/App.tsx' }
      })
    )

    expect(discardChanges).toHaveBeenCalledWith('/repo', 'src/App.tsx')
    expect(response).toEqual({
      id: 'git-discard-changes-1',
      ok: true,
      value: null
    })
  })

  it('validates gitOps.discardChanges params before calling the provider service', async () => {
    const discardChanges = vi.fn(() => Effect.succeed(null))
    const service = { discardChanges } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-discard-changes-invalid',
        method: 'gitOps.discardChanges',
        params: { worktreePath: '/repo', filePath: '' }
      })
    )

    expect(discardChanges).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-discard-changes-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.addToGitignore to the injected provider service', async () => {
    const addToGitignore = vi.fn(() => Effect.succeed({ success: true }))
    const service = { addToGitignore } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-add-to-gitignore-1',
        method: 'gitOps.addToGitignore',
        params: { worktreePath: '/repo', pattern: 'dist/' }
      })
    )

    expect(addToGitignore).toHaveBeenCalledWith('/repo', 'dist/')
    expect(response).toEqual({
      id: 'git-add-to-gitignore-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.addToGitignore params before calling the provider service', async () => {
    const addToGitignore = vi.fn(() => Effect.succeed({ success: true }))
    const service = { addToGitignore } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-add-to-gitignore-invalid',
        method: 'gitOps.addToGitignore',
        params: { worktreePath: '/repo', pattern: '' }
      })
    )

    expect(addToGitignore).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-add-to-gitignore-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.openInEditor to the injected provider service', async () => {
    const openInEditor = vi.fn(() => Effect.succeed({ success: true }))
    const service = { openInEditor } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-open-in-editor-1',
        method: 'gitOps.openInEditor',
        params: { filePath: '/repo/src/App.tsx' }
      })
    )

    expect(openInEditor).toHaveBeenCalledWith('/repo/src/App.tsx')
    expect(response).toEqual({
      id: 'git-open-in-editor-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.openInEditor params before calling the provider service', async () => {
    const openInEditor = vi.fn(() => Effect.succeed({ success: true }))
    const service = { openInEditor } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-open-in-editor-invalid',
        method: 'gitOps.openInEditor',
        params: { filePath: '' }
      })
    )

    expect(openInEditor).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-open-in-editor-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.showInFinder to the injected provider service', async () => {
    const showInFinder = vi.fn(() => Effect.succeed({ success: true }))
    const service = { showInFinder } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-show-in-finder-1',
        method: 'gitOps.showInFinder',
        params: { filePath: '/repo/src/App.tsx' }
      })
    )

    expect(showInFinder).toHaveBeenCalledWith('/repo/src/App.tsx')
    expect(response).toEqual({
      id: 'git-show-in-finder-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.showInFinder params before calling the provider service', async () => {
    const showInFinder = vi.fn(() => Effect.succeed({ success: true }))
    const service = { showInFinder } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-show-in-finder-invalid',
        method: 'gitOps.showInFinder',
        params: { filePath: '' }
      })
    )

    expect(showInFinder).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-show-in-finder-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.watchWorktree to the injected provider service', async () => {
    const watchWorktree = vi.fn(() => Effect.succeed({ success: true }))
    const service = { watchWorktree } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-watch-worktree-1',
        method: 'gitOps.watchWorktree',
        params: { worktreePath: '/repo' }
      })
    )

    expect(watchWorktree).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-watch-worktree-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.watchWorktree params before calling the provider service', async () => {
    const watchWorktree = vi.fn(() => Effect.succeed({ success: true }))
    const service = { watchWorktree } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-watch-worktree-invalid',
        method: 'gitOps.watchWorktree',
        params: { worktreePath: '' }
      })
    )

    expect(watchWorktree).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-watch-worktree-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.unwatchWorktree to the injected provider service', async () => {
    const unwatchWorktree = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unwatchWorktree } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-unwatch-worktree-1',
        method: 'gitOps.unwatchWorktree',
        params: { worktreePath: '/repo' }
      })
    )

    expect(unwatchWorktree).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-unwatch-worktree-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.unwatchWorktree params before calling the provider service', async () => {
    const unwatchWorktree = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unwatchWorktree } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-unwatch-worktree-invalid',
        method: 'gitOps.unwatchWorktree',
        params: { worktreePath: '' }
      })
    )

    expect(unwatchWorktree).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-unwatch-worktree-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.watchBranch to the injected provider service', async () => {
    const watchBranch = vi.fn(() => Effect.succeed({ success: true }))
    const service = { watchBranch } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-watch-branch-1',
        method: 'gitOps.watchBranch',
        params: { worktreePath: '/repo' }
      })
    )

    expect(watchBranch).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-watch-branch-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.watchBranch params before calling the provider service', async () => {
    const watchBranch = vi.fn(() => Effect.succeed({ success: true }))
    const service = { watchBranch } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-watch-branch-invalid',
        method: 'gitOps.watchBranch',
        params: { worktreePath: '' }
      })
    )

    expect(watchBranch).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-watch-branch-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.unwatchBranch to the injected provider service', async () => {
    const unwatchBranch = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unwatchBranch } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-unwatch-branch-1',
        method: 'gitOps.unwatchBranch',
        params: { worktreePath: '/repo' }
      })
    )

    expect(unwatchBranch).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-unwatch-branch-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.unwatchBranch params before calling the provider service', async () => {
    const unwatchBranch = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unwatchBranch } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-unwatch-branch-invalid',
        method: 'gitOps.unwatchBranch',
        params: { worktreePath: '' }
      })
    )

    expect(unwatchBranch).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-unwatch-branch-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getBranchInfo to the injected provider service', async () => {
    const branch = {
      name: 'feature/http-rpc',
      tracking: 'origin/feature/http-rpc',
      ahead: 2,
      behind: 1
    }
    const getBranchInfo = vi.fn(() => Effect.succeed({ success: true, branch }))
    const service = { getBranchInfo } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-branch-info-1',
        method: 'gitOps.getBranchInfo',
        params: { worktreePath: '/repo' }
      })
    )

    expect(getBranchInfo).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-get-branch-info-1',
      ok: true,
      value: { success: true, branch }
    })
  })

  it('validates gitOps.getBranchInfo params before calling the provider service', async () => {
    const getBranchInfo = vi.fn(() =>
      Effect.succeed({
        success: true,
        branch: { name: 'main', tracking: null, ahead: 0, behind: 0 }
      })
    )
    const service = { getBranchInfo } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-branch-info-invalid',
        method: 'gitOps.getBranchInfo',
        params: { worktreePath: '' }
      })
    )

    expect(getBranchInfo).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-branch-info-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.stageAll to the injected provider service', async () => {
    const stageAll = vi.fn(() => Effect.succeed({ success: true }))
    const service = { stageAll } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-stage-all-1',
        method: 'gitOps.stageAll',
        params: { worktreePath: '/repo' }
      })
    )

    expect(stageAll).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-stage-all-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.stageAll params before calling the provider service', async () => {
    const stageAll = vi.fn(() => Effect.succeed({ success: true }))
    const service = { stageAll } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-stage-all-invalid',
        method: 'gitOps.stageAll',
        params: { worktreePath: '' }
      })
    )

    expect(stageAll).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-stage-all-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.unstageAll to the injected provider service', async () => {
    const unstageAll = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unstageAll } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-unstage-all-1',
        method: 'gitOps.unstageAll',
        params: { worktreePath: '/repo' }
      })
    )

    expect(unstageAll).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-unstage-all-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.unstageAll params before calling the provider service', async () => {
    const unstageAll = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unstageAll } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-unstage-all-invalid',
        method: 'gitOps.unstageAll',
        params: { worktreePath: '' }
      })
    )

    expect(unstageAll).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-unstage-all-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.stageHunk to the injected provider service', async () => {
    const patch = 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
    const stageHunk = vi.fn(() => Effect.succeed({ success: true }))
    const service = { stageHunk } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-stage-hunk-1',
        method: 'gitOps.stageHunk',
        params: { worktreePath: '/repo', patch }
      })
    )

    expect(stageHunk).toHaveBeenCalledWith('/repo', patch)
    expect(response).toEqual({
      id: 'git-stage-hunk-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.stageHunk params before calling the provider service', async () => {
    const stageHunk = vi.fn(() => Effect.succeed({ success: true }))
    const service = { stageHunk } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-stage-hunk-invalid',
        method: 'gitOps.stageHunk',
        params: { worktreePath: '/repo', patch: '' }
      })
    )

    expect(stageHunk).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-stage-hunk-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.unstageHunk to the injected provider service', async () => {
    const patch = 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
    const unstageHunk = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unstageHunk } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-unstage-hunk-1',
        method: 'gitOps.unstageHunk',
        params: { worktreePath: '/repo', patch }
      })
    )

    expect(unstageHunk).toHaveBeenCalledWith('/repo', patch)
    expect(response).toEqual({
      id: 'git-unstage-hunk-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.unstageHunk params before calling the provider service', async () => {
    const unstageHunk = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unstageHunk } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-unstage-hunk-invalid',
        method: 'gitOps.unstageHunk',
        params: { worktreePath: '/repo', patch: '' }
      })
    )

    expect(unstageHunk).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-unstage-hunk-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.revertHunk to the injected provider service', async () => {
    const patch = 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
    const revertHunk = vi.fn(() => Effect.succeed({ success: true }))
    const service = { revertHunk } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-revert-hunk-1',
        method: 'gitOps.revertHunk',
        params: { worktreePath: '/repo', patch }
      })
    )

    expect(revertHunk).toHaveBeenCalledWith('/repo', patch)
    expect(response).toEqual({
      id: 'git-revert-hunk-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.revertHunk params before calling the provider service', async () => {
    const revertHunk = vi.fn(() => Effect.succeed({ success: true }))
    const service = { revertHunk } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-revert-hunk-invalid',
        method: 'gitOps.revertHunk',
        params: { worktreePath: '/repo', patch: '' }
      })
    )

    expect(revertHunk).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-revert-hunk-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.commit to the injected provider service', async () => {
    const commit = vi.fn(() => Effect.succeed({ success: true, commitHash: 'abc1234' }))
    const service = { commit } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-commit-1',
        method: 'gitOps.commit',
        params: { worktreePath: '/repo', message: 'Update app shell' }
      })
    )

    expect(commit).toHaveBeenCalledWith('/repo', 'Update app shell')
    expect(response).toEqual({
      id: 'git-commit-1',
      ok: true,
      value: { success: true, commitHash: 'abc1234' }
    })
  })

  it('validates gitOps.commit params before calling the provider service', async () => {
    const commit = vi.fn(() => Effect.succeed({ success: true, commitHash: 'abc1234' }))
    const service = { commit } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-commit-invalid',
        method: 'gitOps.commit',
        params: { worktreePath: '', message: 'Update app shell' }
      })
    )

    expect(commit).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-commit-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.push to the injected provider service', async () => {
    const push = vi.fn(() => Effect.succeed({ success: true, pushed: true }))
    const service = { push } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-push-1',
        method: 'gitOps.push',
        params: { worktreePath: '/repo', remote: 'origin', branch: 'main', force: true }
      })
    )

    expect(push).toHaveBeenCalledWith('/repo', 'origin', 'main', true)
    expect(response).toEqual({
      id: 'git-push-1',
      ok: true,
      value: { success: true, pushed: true }
    })
  })

  it('validates gitOps.push params before calling the provider service', async () => {
    const push = vi.fn(() => Effect.succeed({ success: true, pushed: true }))
    const service = { push } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-push-invalid',
        method: 'gitOps.push',
        params: { worktreePath: '', remote: 'origin', branch: 'main', force: true }
      })
    )

    expect(push).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-push-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.pull to the injected provider service', async () => {
    const pull = vi.fn(() => Effect.succeed({ success: true, updated: true }))
    const service = { pull } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-pull-1',
        method: 'gitOps.pull',
        params: { worktreePath: '/repo', remote: 'origin', branch: 'main', rebase: true }
      })
    )

    expect(pull).toHaveBeenCalledWith('/repo', 'origin', 'main', true)
    expect(response).toEqual({
      id: 'git-pull-1',
      ok: true,
      value: { success: true, updated: true }
    })
  })

  it('validates gitOps.pull params before calling the provider service', async () => {
    const pull = vi.fn(() => Effect.succeed({ success: true, updated: true }))
    const service = { pull } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-pull-invalid',
        method: 'gitOps.pull',
        params: { worktreePath: '', remote: 'origin', branch: 'main', rebase: true }
      })
    )

    expect(pull).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-pull-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.merge to the injected provider service', async () => {
    const merge = vi.fn(() => Effect.succeed({ success: true }))
    const service = { merge } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-merge-1',
        method: 'gitOps.merge',
        params: { worktreePath: '/repo', sourceBranch: 'feature/api' }
      })
    )

    expect(merge).toHaveBeenCalledWith('/repo', 'feature/api')
    expect(response).toEqual({
      id: 'git-merge-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.merge params before calling the provider service', async () => {
    const merge = vi.fn(() => Effect.succeed({ success: true }))
    const service = { merge } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-merge-invalid',
        method: 'gitOps.merge',
        params: { worktreePath: '/repo', sourceBranch: '' }
      })
    )

    expect(merge).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-merge-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.mergeAbort to the injected provider service', async () => {
    const mergeAbort = vi.fn(() => Effect.succeed({ success: true }))
    const service = { mergeAbort } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-merge-abort-1',
        method: 'gitOps.mergeAbort',
        params: { worktreePath: '/repo' }
      })
    )

    expect(mergeAbort).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-merge-abort-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates gitOps.mergeAbort params before calling the provider service', async () => {
    const mergeAbort = vi.fn(() => Effect.succeed({ success: true }))
    const service = { mergeAbort } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-merge-abort-invalid',
        method: 'gitOps.mergeAbort',
        params: { worktreePath: '' }
      })
    )

    expect(mergeAbort).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-merge-abort-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.hasUncommittedChanges to the injected provider service', async () => {
    const hasUncommittedChanges = vi.fn(() => Effect.succeed(true))
    const service = { hasUncommittedChanges } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-has-uncommitted-changes-1',
        method: 'gitOps.hasUncommittedChanges',
        params: { worktreePath: '/repo' }
      })
    )

    expect(hasUncommittedChanges).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-has-uncommitted-changes-1',
      ok: true,
      value: true
    })
  })

  it('validates gitOps.hasUncommittedChanges params before calling the provider service', async () => {
    const hasUncommittedChanges = vi.fn(() => Effect.succeed(true))
    const service = { hasUncommittedChanges } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-has-uncommitted-changes-invalid',
        method: 'gitOps.hasUncommittedChanges',
        params: { worktreePath: '' }
      })
    )

    expect(hasUncommittedChanges).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-has-uncommitted-changes-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.branchDiffShortStat to the injected provider service', async () => {
    const stat = {
      success: true,
      filesChanged: 3,
      insertions: 12,
      deletions: 4,
      commitsAhead: 2
    }
    const branchDiffShortStat = vi.fn(() => Effect.succeed(stat))
    const service = { branchDiffShortStat } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-branch-diff-short-stat-1',
        method: 'gitOps.branchDiffShortStat',
        params: { worktreePath: '/repo', baseBranch: 'main' }
      })
    )

    expect(branchDiffShortStat).toHaveBeenCalledWith('/repo', 'main')
    expect(response).toEqual({
      id: 'git-branch-diff-short-stat-1',
      ok: true,
      value: stat
    })
  })

  it('validates gitOps.branchDiffShortStat params before calling the provider service', async () => {
    const branchDiffShortStat = vi.fn(() =>
      Effect.succeed({
        success: true,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        commitsAhead: 0
      })
    )
    const service = { branchDiffShortStat } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-branch-diff-short-stat-invalid',
        method: 'gitOps.branchDiffShortStat',
        params: { worktreePath: '/repo', baseBranch: '' }
      })
    )

    expect(branchDiffShortStat).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-branch-diff-short-stat-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getDiff to the injected provider service', async () => {
    const diff = {
      success: true,
      diff: 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n',
      fileName: 'src/App.tsx'
    }
    const getDiff = vi.fn(() => Effect.succeed(diff))
    const service = { getDiff } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-diff-1',
        method: 'gitOps.getDiff',
        params: {
          worktreePath: '/repo',
          filePath: 'src/App.tsx',
          staged: true,
          isUntracked: false,
          contextLines: 5
        }
      })
    )

    expect(getDiff).toHaveBeenCalledWith('/repo', 'src/App.tsx', true, false, 5)
    expect(response).toEqual({
      id: 'git-get-diff-1',
      ok: true,
      value: diff
    })
  })

  it('validates gitOps.getDiff params before calling the provider service', async () => {
    const getDiff = vi.fn(() => Effect.succeed({ success: true, diff: '', fileName: 'src/App.tsx' }))
    const service = { getDiff } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-diff-invalid',
        method: 'gitOps.getDiff',
        params: {
          worktreePath: '/repo',
          filePath: '',
          staged: true,
          isUntracked: false,
          contextLines: 5
        }
      })
    )

    expect(getDiff).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-diff-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.listBranchesWithStatus to the injected provider service', async () => {
    const branches = [
      {
        name: 'main',
        isRemote: false,
        isCheckedOut: true,
        worktreePath: '/repo'
      },
      {
        name: 'origin/main',
        isRemote: true,
        isCheckedOut: false
      }
    ]
    const listBranchesWithStatus = vi.fn(() => Effect.succeed({ success: true, branches }))
    const service = { listBranchesWithStatus } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-list-branches-with-status-1',
        method: 'gitOps.listBranchesWithStatus',
        params: { projectPath: '/repo' }
      })
    )

    expect(listBranchesWithStatus).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-list-branches-with-status-1',
      ok: true,
      value: { success: true, branches }
    })
  })

  it('validates gitOps.listBranchesWithStatus params before calling the provider service', async () => {
    const listBranchesWithStatus = vi.fn(() =>
      Effect.succeed({ success: true, branches: [] })
    )
    const service = { listBranchesWithStatus } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-list-branches-with-status-invalid',
        method: 'gitOps.listBranchesWithStatus',
        params: { projectPath: '' }
      })
    )

    expect(listBranchesWithStatus).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-list-branches-with-status-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getFileContent to the injected provider service', async () => {
    const result = { success: true, content: 'const value = 1\n' }
    const getFileContent = vi.fn(() => Effect.succeed(result))
    const service = { getFileContent } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-file-content-1',
        method: 'gitOps.getFileContent',
        params: { worktreePath: '/repo', filePath: 'src/App.tsx' }
      })
    )

    expect(getFileContent).toHaveBeenCalledWith('/repo', 'src/App.tsx')
    expect(response).toEqual({
      id: 'git-get-file-content-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getFileContent params before calling the provider service', async () => {
    const getFileContent = vi.fn(() => Effect.succeed({ success: true, content: null }))
    const service = { getFileContent } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-file-content-invalid',
        method: 'gitOps.getFileContent',
        params: { worktreePath: '/repo', filePath: '' }
      })
    )

    expect(getFileContent).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-file-content-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getFileContentBase64 to the injected provider service', async () => {
    const result = {
      success: true,
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png'
    }
    const getFileContentBase64 = vi.fn(() => Effect.succeed(result))
    const service = { getFileContentBase64 } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-file-content-base64-1',
        method: 'gitOps.getFileContentBase64',
        params: { worktreePath: '/repo', filePath: 'assets/logo.png' }
      })
    )

    expect(getFileContentBase64).toHaveBeenCalledWith('/repo', 'assets/logo.png')
    expect(response).toEqual({
      id: 'git-get-file-content-base64-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getFileContentBase64 params before calling the provider service', async () => {
    const getFileContentBase64 = vi.fn(() =>
      Effect.succeed({ success: true, data: 'iVBORw0KGgo=' })
    )
    const service = { getFileContentBase64 } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-file-content-base64-invalid',
        method: 'gitOps.getFileContentBase64',
        params: { worktreePath: '/repo', filePath: '' }
      })
    )

    expect(getFileContentBase64).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-file-content-base64-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getRefContent to the injected provider service', async () => {
    const result = { success: true, content: 'export const value = 1\n' }
    const getRefContent = vi.fn(() => Effect.succeed(result))
    const service = { getRefContent } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-ref-content-1',
        method: 'gitOps.getRefContent',
        params: { worktreePath: '/repo', ref: 'HEAD~1', filePath: 'src/App.tsx' }
      })
    )

    expect(getRefContent).toHaveBeenCalledWith('/repo', 'HEAD~1', 'src/App.tsx')
    expect(response).toEqual({
      id: 'git-get-ref-content-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getRefContent params before calling the provider service', async () => {
    const getRefContent = vi.fn(() => Effect.succeed({ success: true, content: '' }))
    const service = { getRefContent } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-ref-content-invalid',
        method: 'gitOps.getRefContent',
        params: { worktreePath: '/repo', ref: 'HEAD', filePath: '' }
      })
    )

    expect(getRefContent).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-ref-content-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getBranchBaseContent to the injected provider service', async () => {
    const result = { success: true, content: 'export const base = true\n' }
    const getBranchBaseContent = vi.fn(() => Effect.succeed(result))
    const service = { getBranchBaseContent } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-branch-base-content-1',
        method: 'gitOps.getBranchBaseContent',
        params: { worktreePath: '/repo', branch: 'main', filePath: 'src/App.tsx' }
      })
    )

    expect(getBranchBaseContent).toHaveBeenCalledWith('/repo', 'main', 'src/App.tsx')
    expect(response).toEqual({
      id: 'git-get-branch-base-content-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getBranchBaseContent params before calling the provider service', async () => {
    const getBranchBaseContent = vi.fn(() => Effect.succeed({ success: true, content: '' }))
    const service = { getBranchBaseContent } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-branch-base-content-invalid',
        method: 'gitOps.getBranchBaseContent',
        params: { worktreePath: '/repo', branch: '', filePath: 'src/App.tsx' }
      })
    )

    expect(getBranchBaseContent).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-branch-base-content-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getRefContentBase64 to the injected provider service', async () => {
    const result = {
      success: true,
      data: 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
      mimeType: 'image/gif'
    }
    const getRefContentBase64 = vi.fn(() => Effect.succeed(result))
    const service = { getRefContentBase64 } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-ref-content-base64-1',
        method: 'gitOps.getRefContentBase64',
        params: { worktreePath: '/repo', ref: 'HEAD~1', filePath: 'assets/logo.gif' }
      })
    )

    expect(getRefContentBase64).toHaveBeenCalledWith('/repo', 'HEAD~1', 'assets/logo.gif')
    expect(response).toEqual({
      id: 'git-get-ref-content-base64-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getRefContentBase64 params before calling the provider service', async () => {
    const getRefContentBase64 = vi.fn(() =>
      Effect.succeed({ success: true, data: 'R0lGODlhAQABAIAAAAAAAP///w==' })
    )
    const service = { getRefContentBase64 } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-ref-content-base64-invalid',
        method: 'gitOps.getRefContentBase64',
        params: { worktreePath: '/repo', ref: 'HEAD', filePath: '' }
      })
    )

    expect(getRefContentBase64).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-ref-content-base64-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getBranchBaseContentBase64 to the injected provider service', async () => {
    const result = {
      success: true,
      data: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AA/vuUAAA=',
      mimeType: 'image/webp'
    }
    const getBranchBaseContentBase64 = vi.fn(() => Effect.succeed(result))
    const service = { getBranchBaseContentBase64 } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-branch-base-content-base64-1',
        method: 'gitOps.getBranchBaseContentBase64',
        params: { worktreePath: '/repo', branch: 'main', filePath: 'assets/logo.webp' }
      })
    )

    expect(getBranchBaseContentBase64).toHaveBeenCalledWith('/repo', 'main', 'assets/logo.webp')
    expect(response).toEqual({
      id: 'git-get-branch-base-content-base64-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getBranchBaseContentBase64 params before calling the provider service', async () => {
    const getBranchBaseContentBase64 = vi.fn(() =>
      Effect.succeed({ success: true, data: 'UklGRiIAAABXRUJQ' })
    )
    const service = { getBranchBaseContentBase64 } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-branch-base-content-base64-invalid',
        method: 'gitOps.getBranchBaseContentBase64',
        params: { worktreePath: '/repo', branch: '', filePath: 'assets/logo.webp' }
      })
    )

    expect(getBranchBaseContentBase64).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-branch-base-content-base64-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getRemoteUrl to the injected provider service', async () => {
    const result = {
      success: true,
      url: 'git@github.com:example/repo.git',
      remote: 'origin'
    }
    const getRemoteUrl = vi.fn(() => Effect.succeed(result))
    const service = { getRemoteUrl } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-remote-url-1',
        method: 'gitOps.getRemoteUrl',
        params: { worktreePath: '/repo', remote: 'origin' }
      })
    )

    expect(getRemoteUrl).toHaveBeenCalledWith('/repo', 'origin')
    expect(response).toEqual({
      id: 'git-get-remote-url-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getRemoteUrl params before calling the provider service', async () => {
    const getRemoteUrl = vi.fn(() =>
      Effect.succeed({ success: true, url: null, remote: null })
    )
    const service = { getRemoteUrl } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-remote-url-invalid',
        method: 'gitOps.getRemoteUrl',
        params: { worktreePath: '', remote: 'origin' }
      })
    )

    expect(getRemoteUrl).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-remote-url-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getDiffStat to the injected provider service', async () => {
    const result = {
      success: true,
      files: [
        {
          path: 'src/App.tsx',
          additions: 10,
          deletions: 2,
          binary: false
        },
        {
          path: 'assets/logo.png',
          additions: 0,
          deletions: 0,
          binary: true
        }
      ]
    }
    const getDiffStat = vi.fn(() => Effect.succeed(result))
    const service = { getDiffStat } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-diff-stat-1',
        method: 'gitOps.getDiffStat',
        params: { worktreePath: '/repo' }
      })
    )

    expect(getDiffStat).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-get-diff-stat-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getDiffStat params before calling the provider service', async () => {
    const getDiffStat = vi.fn(() => Effect.succeed({ success: true, files: [] }))
    const service = { getDiffStat } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-diff-stat-invalid',
        method: 'gitOps.getDiffStat',
        params: { worktreePath: '' }
      })
    )

    expect(getDiffStat).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-diff-stat-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getBranchDiffFiles to the injected provider service', async () => {
    const result = {
      success: true,
      files: [
        {
          relativePath: 'src/App.tsx',
          status: 'M',
          additions: 8,
          deletions: 3,
          binary: false
        },
        {
          relativePath: 'assets/banner.png',
          status: 'A',
          additions: 0,
          deletions: 0,
          binary: true
        }
      ]
    }
    const getBranchDiffFiles = vi.fn(() => Effect.succeed(result))
    const service = { getBranchDiffFiles } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-branch-diff-files-1',
        method: 'gitOps.getBranchDiffFiles',
        params: { worktreePath: '/repo', branch: 'main' }
      })
    )

    expect(getBranchDiffFiles).toHaveBeenCalledWith('/repo', 'main')
    expect(response).toEqual({
      id: 'git-get-branch-diff-files-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getBranchDiffFiles params before calling the provider service', async () => {
    const getBranchDiffFiles = vi.fn(() => Effect.succeed({ success: true, files: [] }))
    const service = { getBranchDiffFiles } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-branch-diff-files-invalid',
        method: 'gitOps.getBranchDiffFiles',
        params: { worktreePath: '/repo', branch: '' }
      })
    )

    expect(getBranchDiffFiles).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-branch-diff-files-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getBranchFileDiff to the injected provider service', async () => {
    const result = {
      success: true,
      diff: 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
    }
    const getBranchFileDiff = vi.fn(() => Effect.succeed(result))
    const service = { getBranchFileDiff } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-branch-file-diff-1',
        method: 'gitOps.getBranchFileDiff',
        params: { worktreePath: '/repo', branch: 'main', filePath: 'src/App.tsx' }
      })
    )

    expect(getBranchFileDiff).toHaveBeenCalledWith('/repo', 'main', 'src/App.tsx')
    expect(response).toEqual({
      id: 'git-get-branch-file-diff-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getBranchFileDiff params before calling the provider service', async () => {
    const getBranchFileDiff = vi.fn(() => Effect.succeed({ success: true, diff: '' }))
    const service = { getBranchFileDiff } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-branch-file-diff-invalid',
        method: 'gitOps.getBranchFileDiff',
        params: { worktreePath: '/repo', branch: 'main', filePath: '' }
      })
    )

    expect(getBranchFileDiff).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-branch-file-diff-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getRangeDiff to the injected provider service', async () => {
    const result = {
      commitSummary: 'abc123 Add feature\n',
      diffSummary: '2 files changed, 10 insertions(+), 3 deletions(-)',
      diffPatch: 'diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n',
      commitCount: 1
    }
    const getRangeDiff = vi.fn(() => Effect.succeed(result))
    const service = { getRangeDiff } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-range-diff-1',
        method: 'gitOps.getRangeDiff',
        params: { worktreePath: '/repo', baseBranch: 'main' }
      })
    )

    expect(getRangeDiff).toHaveBeenCalledWith('/repo', 'main')
    expect(response).toEqual({
      id: 'git-get-range-diff-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getRangeDiff params before calling the provider service', async () => {
    const getRangeDiff = vi.fn(() =>
      Effect.succeed({
        commitSummary: '',
        diffSummary: '',
        diffPatch: '',
        commitCount: 0
      })
    )
    const service = { getRangeDiff } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-range-diff-invalid',
        method: 'gitOps.getRangeDiff',
        params: { worktreePath: '/repo', baseBranch: '' }
      })
    )

    expect(getRangeDiff).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-range-diff-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.needsPush to the injected provider service', async () => {
    const needsPush = vi.fn(() => Effect.succeed(true))
    const service = { needsPush } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-needs-push-1',
        method: 'gitOps.needsPush',
        params: { worktreePath: '/repo' }
      })
    )

    expect(needsPush).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-needs-push-1',
      ok: true,
      value: true
    })
  })

  it('validates gitOps.needsPush params before calling the provider service', async () => {
    const needsPush = vi.fn(() => Effect.succeed(false))
    const service = { needsPush } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-needs-push-invalid',
        method: 'gitOps.needsPush',
        params: { worktreePath: '' }
      })
    )

    expect(needsPush).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-needs-push-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.createPR to the injected provider service', async () => {
    const result = {
      success: true,
      url: 'https://github.com/acme/repo/pull/42',
      number: 42
    }
    const createPR = vi.fn(() => Effect.succeed(result))
    const service = { createPR } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-create-pr-1',
        method: 'gitOps.createPR',
        params: {
          worktreePath: '/repo',
          baseBranch: 'main',
          title: 'Ship feature',
          body: 'PR body'
        }
      })
    )

    expect(createPR).toHaveBeenCalledWith('/repo', 'main', 'Ship feature', 'PR body')
    expect(response).toEqual({
      id: 'git-create-pr-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.createPR params before calling the provider service', async () => {
    const createPR = vi.fn(() => Effect.succeed({ success: false, error: 'not called' }))
    const service = { createPR } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-create-pr-invalid',
        method: 'gitOps.createPR',
        params: {
          worktreePath: '/repo',
          baseBranch: '',
          title: 'Ship feature',
          body: 'PR body'
        }
      })
    )

    expect(createPR).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-create-pr-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.generatePRContent to the injected provider service', async () => {
    const result = {
      success: true,
      title: 'Generated title',
      body: 'Generated body'
    }
    const generatePRContent = vi.fn(() => Effect.succeed(result))
    const service = { generatePRContent } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-generate-pr-content-1',
        method: 'gitOps.generatePRContent',
        params: {
          worktreePath: '/repo',
          baseBranch: 'main',
          provider: 'codex'
        }
      })
    )

    expect(generatePRContent).toHaveBeenCalledWith('/repo', 'main', 'codex')
    expect(response).toEqual({
      id: 'git-generate-pr-content-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.generatePRContent params before calling the provider service', async () => {
    const generatePRContent = vi.fn(() =>
      Effect.succeed({ success: false, error: 'not called' })
    )
    const service = { generatePRContent } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-generate-pr-content-invalid',
        method: 'gitOps.generatePRContent',
        params: {
          worktreePath: '/repo',
          baseBranch: 'main',
          provider: ''
        }
      })
    )

    expect(generatePRContent).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-generate-pr-content-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.prMerge to the injected provider service and publishes status changes', async () => {
    const result = { success: true }
    const events: Array<{ channel: string; payload: unknown }> = []
    const prMerge = vi.fn(() => Effect.succeed(result))
    const eventBus = makeEventBus()
    const unsubscribe = await Effect.runPromise(
      eventBus.subscribe(GIT_STATUS_CHANGED_CHANNEL, (event) => {
        events.push(event)
      })
    )
    const service = { prMerge } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus,
      gitOps: service
    })

    try {
      const response = await Effect.runPromise(
        router.handle({
          id: 'git-pr-merge-1',
          method: 'gitOps.prMerge',
          params: { worktreePath: '/repo', prNumber: 42 }
        })
      )

      expect(prMerge).toHaveBeenCalledWith('/repo', 42)
      expect(response).toEqual({
        id: 'git-pr-merge-1',
        ok: true,
        value: result
      })
      expect(events).toEqual([
        {
          channel: GIT_STATUS_CHANGED_CHANNEL,
          payload: { worktreePath: '/repo' }
        }
      ])
    } finally {
      unsubscribe()
    }
  })

  it('validates gitOps.prMerge params before calling the provider service', async () => {
    const prMerge = vi.fn(() => Effect.succeed({ success: true }))
    const service = { prMerge } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-pr-merge-invalid',
        method: 'gitOps.prMerge',
        params: { worktreePath: '/repo', prNumber: '42' }
      })
    )

    expect(prMerge).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-pr-merge-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.isBranchMerged to the injected provider service', async () => {
    const result = { success: true, isMerged: true }
    const isBranchMerged = vi.fn(() => Effect.succeed(result))
    const service = { isBranchMerged } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-is-branch-merged-1',
        method: 'gitOps.isBranchMerged',
        params: { worktreePath: '/repo', branch: 'feature/add-rpc' }
      })
    )

    expect(isBranchMerged).toHaveBeenCalledWith('/repo', 'feature/add-rpc')
    expect(response).toEqual({
      id: 'git-is-branch-merged-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.isBranchMerged params before calling the provider service', async () => {
    const isBranchMerged = vi.fn(() => Effect.succeed({ success: true, isMerged: false }))
    const service = { isBranchMerged } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-is-branch-merged-invalid',
        method: 'gitOps.isBranchMerged',
        params: { worktreePath: '/repo', branch: '' }
      })
    )

    expect(isBranchMerged).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-is-branch-merged-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.deleteBranch to the injected provider service', async () => {
    const result = { success: true }
    const deleteBranch = vi.fn(() => Effect.succeed(result))
    const service = { deleteBranch } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-delete-branch-1',
        method: 'gitOps.deleteBranch',
        params: { worktreePath: '/repo', branchName: 'feature/add-rpc' }
      })
    )

    expect(deleteBranch).toHaveBeenCalledWith('/repo', 'feature/add-rpc')
    expect(response).toEqual({
      id: 'git-delete-branch-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.deleteBranch params before calling the provider service', async () => {
    const deleteBranch = vi.fn(() => Effect.succeed({ success: true }))
    const service = { deleteBranch } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-delete-branch-invalid',
        method: 'gitOps.deleteBranch',
        params: { worktreePath: '/repo', branchName: '' }
      })
    )

    expect(deleteBranch).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-delete-branch-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.listPRs to the injected provider service', async () => {
    const result = {
      success: true,
      prs: [
        {
          number: 42,
          title: 'Add RPC coverage',
          author: 'mona',
          headRefName: 'feature/add-rpc'
        }
      ]
    }
    const listPRs = vi.fn(() => Effect.succeed(result))
    const service = { listPRs } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-list-prs-1',
        method: 'gitOps.listPRs',
        params: { projectPath: '/repo' }
      })
    )

    expect(listPRs).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'git-list-prs-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.listPRs params before calling the provider service', async () => {
    const listPRs = vi.fn(() => Effect.succeed({ success: true, prs: [] }))
    const service = { listPRs } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-list-prs-invalid',
        method: 'gitOps.listPRs',
        params: { projectPath: '' }
      })
    )

    expect(listPRs).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-list-prs-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getPRState to the injected provider service', async () => {
    const result = {
      success: true,
      state: 'OPEN',
      title: 'Add RPC coverage'
    }
    const getPRState = vi.fn(() => Effect.succeed(result))
    const service = { getPRState } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-pr-state-1',
        method: 'gitOps.getPRState',
        params: { projectPath: '/repo', prNumber: 42 }
      })
    )

    expect(getPRState).toHaveBeenCalledWith('/repo', 42)
    expect(response).toEqual({
      id: 'git-get-pr-state-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getPRState params before calling the provider service', async () => {
    const getPRState = vi.fn(() => Effect.succeed({ success: true, state: 'OPEN' }))
    const service = { getPRState } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-pr-state-invalid',
        method: 'gitOps.getPRState',
        params: { projectPath: '/repo', prNumber: '42' }
      })
    )

    expect(getPRState).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-pr-state-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes gitOps.getPRReviewComments to the injected provider service', async () => {
    const result = {
      success: true,
      comments: [
        {
          id: 'review-comment-1',
          reviewId: 7,
          author: 'mona',
          authorAvatarUrl: 'https://example.com/avatar.png',
          body: 'Looks good',
          bodyHTML: '<p>Looks good</p>',
          path: 'src/App.tsx',
          line: 12,
          originalLine: 12,
          diffHunk: '@@ -10,3 +10,4 @@',
          createdAt: '2026-05-31T00:00:00Z',
          updatedAt: '2026-05-31T00:01:00Z',
          inReplyToId: undefined,
          isResolved: false,
          isOutdated: false,
          side: 'RIGHT',
          subjectType: 'LINE'
        }
      ],
      baseBranch: 'main'
    }
    const getPRReviewComments = vi.fn(() => Effect.succeed(result))
    const service = { getPRReviewComments } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-pr-review-comments-1',
        method: 'gitOps.getPRReviewComments',
        params: { projectPath: '/repo', prNumber: 42 }
      })
    )

    expect(getPRReviewComments).toHaveBeenCalledWith('/repo', 42)
    expect(response).toEqual({
      id: 'git-get-pr-review-comments-1',
      ok: true,
      value: result
    })
  })

  it('validates gitOps.getPRReviewComments params before calling the provider service', async () => {
    const getPRReviewComments = vi.fn(() =>
      Effect.succeed({ success: true, comments: [], baseBranch: 'main' })
    )
    const service = { getPRReviewComments } as unknown as GitOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      gitOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'git-get-pr-review-comments-invalid',
        method: 'gitOps.getPRReviewComments',
        params: { projectPath: '/repo', prNumber: '42' }
      })
    )

    expect(getPRReviewComments).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'git-get-pr-review-comments-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
