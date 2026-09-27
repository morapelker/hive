import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeUsageOpsRpcHandlers, type UsageOpsRpcService } from './usage-ops'

describe('usage reset RPC', () => {
  const listOpenaiResets = vi.fn(() => Effect.succeed({ available_count: 0, credits: [] }))
  const consumeOpenaiReset = vi.fn(() =>
    Effect.succeed({ code: 'reset' as const, windows_reset: 2 })
  )
  const handlers = makeUsageOpsRpcHandlers({
    listOpenaiResets,
    consumeOpenaiReset
  } as unknown as UsageOpsRpcService)
  it('routes listing and consuming the selected credit', async () => {
    const params = {
      accountId: 'account',
      redeemRequestId: 'fd0db1c2-9411-4fe5-b0fc-e32f0fe1df7b',
      creditId: 'credit'
    }
    expect(
      await Effect.runPromise(handlers.get('usageOps.listOpenaiResets')!({ accountId: 'account' }))
    ).toEqual({ available_count: 0, credits: [] })
    expect(await Effect.runPromise(handlers.get('usageOps.consumeOpenaiReset')!(params))).toEqual({
      code: 'reset',
      windows_reset: 2
    })
    expect(consumeOpenaiReset).toHaveBeenCalledWith(
      params.accountId,
      params.redeemRequestId,
      params.creditId
    )
  })
  it('rejects an invalid redemption ID before consuming a credit', async () => {
    consumeOpenaiReset.mockClear()
    await expect(
      Effect.runPromise(
        handlers.get('usageOps.consumeOpenaiReset')!({
          accountId: 'account',
          redeemRequestId: 'invalid'
        })
      )
    ).rejects.toThrow()
    expect(consumeOpenaiReset).not.toHaveBeenCalled()
  })
})
