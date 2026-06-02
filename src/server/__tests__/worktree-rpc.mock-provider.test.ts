import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { WorktreeOpsRpcService } from '../rpc/domains/worktree-ops'
import { makeRpcRouter } from '../rpc/router'

describe('worktree ops RPC mocked provider', () => {
  it('routes worktreeOps.hasCommits to the injected provider service', async () => {
    const hasCommits = vi.fn(() => Effect.succeed(true))
    const service = { hasCommits } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-has-commits-1',
        method: 'worktreeOps.hasCommits',
        params: { projectPath: '/repo' }
      })
    )

    expect(hasCommits).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'worktree-has-commits-1',
      ok: true,
      value: true
    })
  })

  it('validates worktreeOps.hasCommits params before calling the provider service', async () => {
    const hasCommits = vi.fn(() => Effect.succeed(false))
    const service = { hasCommits } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-has-commits-invalid',
        method: 'worktreeOps.hasCommits',
        params: { projectPath: '' }
      })
    )

    expect(hasCommits).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-has-commits-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.create to the injected provider service', async () => {
    const params = {
      projectId: 'project-1',
      projectPath: '/repo',
      projectName: 'Hive'
    }
    const createdWorktree = {
      id: 'worktree-1',
      project_id: 'project-1',
      name: 'hive-feature',
      branch_name: 'hive-feature',
      path: '/repo-feature',
      status: 'active' as const,
      is_default: false,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '[]',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      attachments: '[]',
      pinned: 0,
      context: null,
      github_pr_number: null,
      github_pr_url: null,
      base_branch: 'main',
      created_at: '2026-05-26T00:00:00.000Z',
      last_accessed_at: '2026-05-26T00:00:00.000Z'
    }
    const result = {
      success: true,
      worktree: createdWorktree,
      pullInfo: { pulled: true, updated: false }
    }
    const create = vi.fn(() => Effect.succeed(result))
    const service = { create } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-create-1',
        method: 'worktreeOps.create',
        params
      })
    )

    expect(create).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      id: 'worktree-create-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.create params before calling the provider service', async () => {
    const create = vi.fn(() => Effect.succeed({ success: false }))
    const service = { create } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-create-invalid',
        method: 'worktreeOps.create',
        params: {
          projectId: 'project-1',
          projectPath: '',
          projectName: 'Hive'
        }
      })
    )

    expect(create).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-create-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.delete to the injected provider service', async () => {
    const params = {
      worktreeId: 'worktree-1',
      worktreePath: '/repo-feature',
      branchName: 'hive-feature',
      projectPath: '/repo',
      archive: true
    }
    const result = { success: true }
    const deleteWorktree = vi.fn(() => Effect.succeed(result))
    const service = { delete: deleteWorktree } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-delete-1',
        method: 'worktreeOps.delete',
        params
      })
    )

    expect(deleteWorktree).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      id: 'worktree-delete-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.delete params before calling the provider service', async () => {
    const deleteWorktree = vi.fn(() => Effect.succeed({ success: false }))
    const service = { delete: deleteWorktree } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-delete-invalid',
        method: 'worktreeOps.delete',
        params: {
          worktreeId: 'worktree-1',
          worktreePath: '/repo-feature',
          branchName: 'hive-feature',
          projectPath: '/repo',
          archive: 'yes'
        }
      })
    )

    expect(deleteWorktree).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-delete-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.sync to the injected provider service', async () => {
    const params = {
      projectId: 'project-1',
      projectPath: '/repo'
    }
    const result = { success: true }
    const sync = vi.fn(() => Effect.succeed(result))
    const service = { sync } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-sync-1',
        method: 'worktreeOps.sync',
        params
      })
    )

    expect(sync).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      id: 'worktree-sync-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.sync params before calling the provider service', async () => {
    const sync = vi.fn(() => Effect.succeed({ success: false }))
    const service = { sync } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-sync-invalid',
        method: 'worktreeOps.sync',
        params: {
          projectId: 'project-1',
          projectPath: ''
        }
      })
    )

    expect(sync).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-sync-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.exists to the injected provider service', async () => {
    const exists = vi.fn(() => Effect.succeed(true))
    const service = { exists } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-exists-1',
        method: 'worktreeOps.exists',
        params: { worktreePath: '/repo-feature' }
      })
    )

    expect(exists).toHaveBeenCalledWith('/repo-feature')
    expect(response).toEqual({
      id: 'worktree-exists-1',
      ok: true,
      value: true
    })
  })

  it('validates worktreeOps.exists params before calling the provider service', async () => {
    const exists = vi.fn(() => Effect.succeed(false))
    const service = { exists } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-exists-invalid',
        method: 'worktreeOps.exists',
        params: { worktreePath: '' }
      })
    )

    expect(exists).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-exists-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.openInTerminal to the injected provider service', async () => {
    const result = { success: true }
    const openInTerminal = vi.fn(() => Effect.succeed(result))
    const service = { openInTerminal } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-open-in-terminal-1',
        method: 'worktreeOps.openInTerminal',
        params: { worktreePath: '/repo-feature' }
      })
    )

    expect(openInTerminal).toHaveBeenCalledWith('/repo-feature')
    expect(response).toEqual({
      id: 'worktree-open-in-terminal-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.openInTerminal params before calling the provider service', async () => {
    const openInTerminal = vi.fn(() => Effect.succeed({ success: false }))
    const service = { openInTerminal } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-open-in-terminal-invalid',
        method: 'worktreeOps.openInTerminal',
        params: { worktreePath: '' }
      })
    )

    expect(openInTerminal).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-open-in-terminal-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.openInEditor to the injected provider service', async () => {
    const result = { success: true }
    const openInEditor = vi.fn(() => Effect.succeed(result))
    const service = { openInEditor } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-open-in-editor-1',
        method: 'worktreeOps.openInEditor',
        params: { worktreePath: '/repo-feature' }
      })
    )

    expect(openInEditor).toHaveBeenCalledWith('/repo-feature')
    expect(response).toEqual({
      id: 'worktree-open-in-editor-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.openInEditor params before calling the provider service', async () => {
    const openInEditor = vi.fn(() => Effect.succeed({ success: false }))
    const service = { openInEditor } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-open-in-editor-invalid',
        method: 'worktreeOps.openInEditor',
        params: { worktreePath: '' }
      })
    )

    expect(openInEditor).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-open-in-editor-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.getBranches to the injected provider service', async () => {
    const result = {
      success: true,
      branches: ['main', 'feature/rpc-worktree'],
      currentBranch: 'main'
    }
    const getBranches = vi.fn(() => Effect.succeed(result))
    const service = { getBranches } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-get-branches-1',
        method: 'worktreeOps.getBranches',
        params: { projectPath: '/repo' }
      })
    )

    expect(getBranches).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'worktree-get-branches-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.getBranches params before calling the provider service', async () => {
    const getBranches = vi.fn(() => Effect.succeed({ success: false }))
    const service = { getBranches } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-get-branches-invalid',
        method: 'worktreeOps.getBranches',
        params: { projectPath: '' }
      })
    )

    expect(getBranches).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-get-branches-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.branchExists to the injected provider service', async () => {
    const branchExists = vi.fn(() => Effect.succeed(true))
    const service = { branchExists } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-branch-exists-1',
        method: 'worktreeOps.branchExists',
        params: { projectPath: '/repo', branchName: 'feature/rpc-worktree' }
      })
    )

    expect(branchExists).toHaveBeenCalledWith('/repo', 'feature/rpc-worktree')
    expect(response).toEqual({
      id: 'worktree-branch-exists-1',
      ok: true,
      value: true
    })
  })

  it('validates worktreeOps.branchExists params before calling the provider service', async () => {
    const branchExists = vi.fn(() => Effect.succeed(false))
    const service = { branchExists } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-branch-exists-invalid',
        method: 'worktreeOps.branchExists',
        params: { projectPath: '/repo', branchName: '' }
      })
    )

    expect(branchExists).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-branch-exists-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.duplicate to the injected provider service', async () => {
    const params = {
      projectId: 'project-1',
      projectPath: '/repo',
      projectName: 'Hive',
      sourceBranch: 'main',
      sourceWorktreePath: '/repo',
      nameHint: 'rpc-copy'
    }
    const duplicatedWorktree = {
      id: 'worktree-duplicate-1',
      project_id: 'project-1',
      name: 'rpc-copy',
      branch_name: 'rpc-copy',
      path: '/repo-rpc-copy',
      status: 'active' as const,
      is_default: false,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '[]',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      attachments: '[]',
      pinned: 0,
      context: null,
      github_pr_number: null,
      github_pr_url: null,
      base_branch: 'main',
      created_at: '2026-05-26T00:00:00.000Z',
      last_accessed_at: '2026-05-26T00:00:00.000Z'
    }
    const result = { success: true, worktree: duplicatedWorktree }
    const duplicate = vi.fn(() => Effect.succeed(result))
    const service = { duplicate } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-duplicate-1',
        method: 'worktreeOps.duplicate',
        params
      })
    )

    expect(duplicate).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      id: 'worktree-duplicate-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.duplicate params before calling the provider service', async () => {
    const duplicate = vi.fn(() => Effect.succeed({ success: false }))
    const service = { duplicate } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-duplicate-invalid',
        method: 'worktreeOps.duplicate',
        params: {
          projectId: 'project-1',
          projectPath: '/repo',
          projectName: 'Hive',
          sourceBranch: '',
          sourceWorktreePath: '/repo'
        }
      })
    )

    expect(duplicate).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-duplicate-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.renameBranch to the injected provider service', async () => {
    const params = {
      worktreeId: 'worktree-1',
      worktreePath: '/repo-feature',
      oldBranch: 'feature/old-name',
      newBranch: 'feature/new-name'
    }
    const result = { success: true }
    const renameBranch = vi.fn(() => Effect.succeed(result))
    const service = { renameBranch } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-rename-branch-1',
        method: 'worktreeOps.renameBranch',
        params
      })
    )

    expect(renameBranch).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      id: 'worktree-rename-branch-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.renameBranch params before calling the provider service', async () => {
    const renameBranch = vi.fn(() => Effect.succeed({ success: false }))
    const service = { renameBranch } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-rename-branch-invalid',
        method: 'worktreeOps.renameBranch',
        params: {
          worktreeId: 'worktree-1',
          worktreePath: '/repo-feature',
          oldBranch: 'feature/old-name',
          newBranch: ''
        }
      })
    )

    expect(renameBranch).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-rename-branch-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.createFromBranch to the injected provider service', async () => {
    const params = {
      projectId: 'project-1',
      projectPath: '/repo',
      projectName: 'Hive',
      branchName: 'feature/source',
      prNumber: 42,
      nameHint: 'source-copy'
    }
    const createdWorktree = {
      id: 'worktree-from-branch-1',
      project_id: 'project-1',
      name: 'source-copy',
      branch_name: 'source-copy',
      path: '/repo-source-copy',
      status: 'active' as const,
      is_default: false,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '[]',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      attachments: '[]',
      pinned: 0,
      context: null,
      github_pr_number: 42,
      github_pr_url: 'https://github.com/acme/hive/pull/42',
      base_branch: 'main',
      created_at: '2026-05-26T00:00:00.000Z',
      last_accessed_at: '2026-05-26T00:00:00.000Z'
    }
    const result = { success: true, worktree: createdWorktree }
    const createFromBranch = vi.fn(() => Effect.succeed(result))
    const service = { createFromBranch } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-create-from-branch-1',
        method: 'worktreeOps.createFromBranch',
        params
      })
    )

    expect(createFromBranch).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      id: 'worktree-create-from-branch-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.createFromBranch params before calling the provider service', async () => {
    const createFromBranch = vi.fn(() => Effect.succeed({ success: false }))
    const service = { createFromBranch } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-create-from-branch-invalid',
        method: 'worktreeOps.createFromBranch',
        params: {
          projectId: 'project-1',
          projectPath: '/repo',
          projectName: 'Hive',
          branchName: '',
          prNumber: 42
        }
      })
    )

    expect(createFromBranch).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-create-from-branch-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.getContext to the injected provider service', async () => {
    const result = { success: true, context: 'Use the RPC migration branch context.' }
    const getContext = vi.fn(() => Effect.succeed(result))
    const service = { getContext } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-get-context-1',
        method: 'worktreeOps.getContext',
        params: { worktreeId: 'worktree-1' }
      })
    )

    expect(getContext).toHaveBeenCalledWith('worktree-1')
    expect(response).toEqual({
      id: 'worktree-get-context-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.getContext params before calling the provider service', async () => {
    const getContext = vi.fn(() => Effect.succeed({ success: false }))
    const service = { getContext } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-get-context-invalid',
        method: 'worktreeOps.getContext',
        params: { worktreeId: '' }
      })
    )

    expect(getContext).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-get-context-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes worktreeOps.updateContext to the injected provider service', async () => {
    const result = { success: true }
    const updateContext = vi.fn(() => Effect.succeed(result))
    const service = { updateContext } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-update-context-1',
        method: 'worktreeOps.updateContext',
        params: { worktreeId: 'worktree-1', context: null }
      })
    )

    expect(updateContext).toHaveBeenCalledWith('worktree-1', null)
    expect(response).toEqual({
      id: 'worktree-update-context-1',
      ok: true,
      value: result
    })
  })

  it('validates worktreeOps.updateContext params before calling the provider service', async () => {
    const updateContext = vi.fn(() => Effect.succeed({ success: false }))
    const service = { updateContext } as unknown as WorktreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      worktreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'worktree-update-context-invalid',
        method: 'worktreeOps.updateContext',
        params: { worktreeId: 'worktree-1', context: 42 }
      })
    )

    expect(updateContext).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'worktree-update-context-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
