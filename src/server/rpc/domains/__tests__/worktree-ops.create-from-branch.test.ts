import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { RpcContext } from '../../router'
import { makeWorktreeOpsRpcHandlers, type WorktreeOpsRpcService } from '../worktree-ops'

const context = { eventBus: null } as unknown as RpcContext

const baseParams = {
  projectId: 'project-1',
  projectPath: '/repo',
  projectName: 'Hive',
  branchName: 'doc-factory'
}

function setup() {
  const createFromBranch = vi.fn(() => Effect.succeed({ success: true }))
  const service = { createFromBranch } as unknown as WorktreeOpsRpcService
  const handler = makeWorktreeOpsRpcHandlers(service).get('worktreeOps.createFromBranch')
  if (!handler) throw new Error('missing handler for worktreeOps.createFromBranch')
  return {
    createFromBranch,
    run: (params: unknown) => Effect.runPromiseExit(handler(params, context))
  }
}

describe('worktreeOps.createFromBranch params', () => {
  it('passes autoPull and baseRef through to the service', async () => {
    const { createFromBranch, run } = setup()
    // A ticket worktree cut from the integration branch tip: without these the op pulls into
    // the root checkout, or duplicates the integration worktree with its uncommitted files.
    const params = { ...baseParams, nameHint: 'a1-translation', autoPull: false, baseRef: 'abc123' }

    const exit = await run(params)

    expect(exit._tag).toBe('Success')
    expect(createFromBranch).toHaveBeenCalledWith(params)
  })

  it('still accepts a call without them', async () => {
    const { createFromBranch, run } = setup()

    expect((await run(baseParams))._tag).toBe('Success')
    expect(createFromBranch).toHaveBeenCalledWith(baseParams)
  })

  it.each([
    ['an empty baseRef', { baseRef: '' }],
    ['a non-boolean autoPull', { autoPull: 'no' }],
    ['an unknown field', { force: true }]
  ])('rejects %s', async (_name, extra) => {
    const { createFromBranch, run } = setup()

    const exit = await run({ ...baseParams, ...extra })

    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : null
    expect(failure?._tag === 'Some' ? failure.value : null).toBeInstanceOf(z.ZodError)
    expect(createFromBranch).not.toHaveBeenCalled()
  })
})
