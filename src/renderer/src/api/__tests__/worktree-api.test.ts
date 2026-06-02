import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_BRANCH_RENAMED_CHANNEL } from '@shared/worktree-events'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { worktreeApi } from '../worktree-api'

describe('worktreeApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes hasCommits through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.hasCommits('/tmp/hive')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('worktreeOps.hasCommits', { projectPath: '/tmp/hive' })
  })

  it('routes branchExists through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.branchExists('/tmp/hive', 'feature')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('worktreeOps.branchExists', {
      projectPath: '/tmp/hive',
      branchName: 'feature'
    })
  })

  it('routes create through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()
    const params = {
      projectId: 'project-1',
      projectPath: '/tmp/hive',
      projectName: 'Hive'
    }

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.create(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.create', params)
  })

  it('routes createFromBranch through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()
    const params = {
      projectId: 'project-1',
      projectPath: '/tmp/hive',
      projectName: 'Hive',
      branchName: 'feature/example',
      nameHint: 'example'
    }

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.createFromBranch(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.createFromBranch', params)
  })

  it('preserves createFromBranch prNumber when routing through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()
    const params = {
      projectId: 'project-1',
      projectPath: '/tmp/hive',
      projectName: 'Hive',
      branchName: 'feature/pr-42',
      prNumber: 42
    }

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.createFromBranch(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.createFromBranch', params)
  })

  it('routes delete through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()
    const params = {
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/hive-feature',
      branchName: 'feature/example',
      projectPath: '/tmp/hive',
      archive: true
    }

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.delete(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.delete', params)
  })

  it('routes sync through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()
    const params = {
      projectId: 'project-1',
      projectPath: '/tmp/hive'
    }

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.sync(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.sync', params)
  })

  it('routes duplicate through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()
    const params = {
      projectId: 'project-1',
      projectPath: '/tmp/hive',
      projectName: 'Hive',
      sourceBranch: 'feature/example',
      sourceWorktreePath: '/tmp/hive-feature',
      nameHint: 'example-copy'
    }

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.duplicate(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.duplicate', params)
  })

  it('routes exists through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.exists('/tmp/hive-feature')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('worktreeOps.exists', {
      worktreePath: '/tmp/hive-feature'
    })
  })

  it('routes renameBranch through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()
    const params = {
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/hive-feature',
      oldBranch: 'feature/old',
      newBranch: 'feature/new'
    }

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.renameBranch(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.renameBranch', params)
  })

  it('routes getContext through the renderer RPC client', async () => {
    const result = { success: true, context: 'Use pnpm for local tasks.' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.getContext('worktree-1')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.getContext', { worktreeId: 'worktree-1' })
  })

  it('routes updateContext through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.updateContext('worktree-1', 'Use pnpm.')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.updateContext', {
      worktreeId: 'worktree-1',
      context: 'Use pnpm.'
    })
  })

  it('routes getBranches through the renderer RPC client', async () => {
    const result = { success: true, branches: ['main', 'feature'], currentBranch: 'main' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.getBranches('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.getBranches', {
      projectPath: '/tmp/hive'
    })
  })

  it('routes openInTerminal through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.openInTerminal('/tmp/hive-feature')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.openInTerminal', {
      worktreePath: '/tmp/hive-feature'
    })
  })

  it('routes openInEditor through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(worktreeApi.openInEditor('/tmp/hive-feature')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('worktreeOps.openInEditor', {
      worktreePath: '/tmp/hive-feature'
    })
  })

  it('routes branch-renamed events through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    let listener: ((event: { channel: string; payload: unknown }) => void) | undefined
    const subscribe = vi.fn(
      (_channel: string, next: (event: { channel: string; payload: unknown }) => void) => {
        listener = next
        return unsubscribe
      }
    )

    setRendererRpcClient({ request, subscribe })

    const callback = vi.fn()
    const returned = worktreeApi.onBranchRenamed(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(WORKTREE_BRANCH_RENAMED_CHANNEL, expect.any(Function))

    listener?.({
      channel: WORKTREE_BRANCH_RENAMED_CHANNEL,
      payload: { worktreeId: 'worktree-1', newBranch: 'feature-renamed' }
    })
    listener?.({
      channel: WORKTREE_BRANCH_RENAMED_CHANNEL,
      payload: { worktreeId: 'worktree-1' }
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      newBranch: 'feature-renamed'
    })
  })
})
