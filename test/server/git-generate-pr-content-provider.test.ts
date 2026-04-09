// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { gitMutationResolvers } from '../../src/server/resolvers/mutation/git.resolvers'

describe('gitGeneratePRContent provider validation', () => {
  it('rejects terminal as an unsupported PR content provider', async () => {
    const resolver = gitMutationResolvers.Mutation?.gitGeneratePRContent
    expect(resolver).toBeDefined()

    const result = await resolver!(
      {},
      { worktreePath: '/tmp/worktree', baseBranch: 'main', provider: 'terminal' },
      {},
      {} as never
    )

    expect(result).toEqual({
      success: false,
      error: "Provider 'terminal' does not support PR content generation"
    })
  })
})
