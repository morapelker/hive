// The claim of the notice that live usage in Code Mode is switched off for the installed
// version of the Claude CLI (Code Mode T19): the windows ask the server for it, and the
// first one that asks gets it.
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeCodeModeUsageUnavailablePayload } from '@shared/types/claude-live-usage'
import { makeUsageOpsRpcHandlers, type UsageOpsRpcService } from './usage-ops'

const METHOD = 'usageOps.claimCodeModeUsageUnavailableNotice'

describe('the claim of the Code Mode live-usage notice', () => {
  const notice: ClaudeCodeModeUsageUnavailablePayload = {
    provider: 'anthropic',
    cliVersion: '2.1.326'
  }
  const claim = vi.fn<() => Effect.Effect<ClaudeCodeModeUsageUnavailablePayload | null>>()
  const handlers = makeUsageOpsRpcHandlers({
    claimCodeModeUsageUnavailableNotice: claim
  } as unknown as UsageOpsRpcService)
  const call = (params: unknown): Promise<unknown> =>
    Effect.runPromise(
      (handlers.get(METHOD) as unknown as (params: unknown) => Effect.Effect<unknown, unknown>)(
        params
      )
    )

  it('answers with the notice, and with null once it has been given out', async () => {
    claim.mockReturnValueOnce(Effect.succeed(notice)).mockReturnValue(Effect.succeed(null))

    expect(await call({})).toEqual(notice)
    expect(await call({})).toBeNull()
    expect(await call(undefined)).toBeNull()
    expect(claim).toHaveBeenCalledTimes(3)
  })

  it('takes no parameters', async () => {
    claim.mockClear()

    await expect(call({ cliVersion: '2.1.326' })).rejects.toThrow()

    expect(claim).not.toHaveBeenCalled()
  })
})
