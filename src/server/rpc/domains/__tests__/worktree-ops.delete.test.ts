import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { RpcContext } from '../../router'
import { makeWorktreeOpsRpcHandlers, type WorktreeOpsRpcService } from '../worktree-ops'

const context = { eventBus: null } as unknown as RpcContext

const baseParams = {
  worktreeId: 'worktree-1',
  worktreePath: '/repo-worktrees/feature',
  branchName: 'feature',
  projectPath: '/repo',
  archive: false
}

function setup() {
  const deleteWorktree = vi.fn(() => Effect.succeed({ success: true }))
  const service = { delete: deleteWorktree } as unknown as WorktreeOpsRpcService
  const handler = makeWorktreeOpsRpcHandlers(service).get('worktreeOps.delete')
  if (!handler) throw new Error('missing handler for worktreeOps.delete')
  return {
    deleteWorktree,
    run: (params: unknown) => Effect.runPromiseExit(handler(params, context))
  }
}

describe('worktreeOps.delete params', () => {
  it('passes a worktree on a branch through to the service', async () => {
    const { deleteWorktree, run } = setup()

    expect((await run(baseParams))._tag).toBe('Success')
    expect(deleteWorktree).toHaveBeenCalledWith(baseParams)
  })

  // A detached-HEAD worktree has no branch, so the sidebar sends an empty name. Rejecting it
  // left "Remove Worktree" failing with "RPC parameters failed validation".
  it.each([false, true])('accepts an empty branch name (archive: %s)', async (archive) => {
    const { deleteWorktree, run } = setup()
    const params = { ...baseParams, branchName: '', archive }

    expect((await run(params))._tag).toBe('Success')
    expect(deleteWorktree).toHaveBeenCalledWith(params)
  })

  it.each([
    ['an empty worktree path', { worktreePath: '' }],
    ['an empty worktree id', { worktreeId: '' }],
    ['an empty project path', { projectPath: '' }],
    ['a missing branch name', { branchName: undefined }],
    ['an unknown field', { force: true }]
  ])('rejects %s', async (_name, extra) => {
    const { deleteWorktree, run } = setup()

    const exit = await run({ ...baseParams, ...extra })

    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : null
    expect(failure?._tag === 'Some' ? failure.value : null).toBeInstanceOf(z.ZodError)
    expect(deleteWorktree).not.toHaveBeenCalled()
  })
})
