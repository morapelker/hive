import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { SavedAccountDTO } from '../../shared/types/usage'
import { makeEventBus } from '../events/event-bus'
import type { AccountOpsRpcService } from '../rpc/domains/account-ops'
import { makeRpcRouter } from '../rpc/router'

describe('account ops RPC mocked provider', () => {
  it('routes accountOps.getClaudeEmail to the injected provider service', async () => {
    const getClaudeEmail = vi.fn(() => Effect.succeed('claude@example.com'))
    const service = { getClaudeEmail } as unknown as AccountOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      accountOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'account-get-claude-email-1',
        method: 'accountOps.getClaudeEmail',
        params: {}
      })
    )

    expect(getClaudeEmail).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'account-get-claude-email-1',
      ok: true,
      value: 'claude@example.com'
    })
  })

  it('validates accountOps.getClaudeEmail params before calling the provider service', async () => {
    const getClaudeEmail = vi.fn(() => Effect.succeed(null))
    const service = { getClaudeEmail } as unknown as AccountOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      accountOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'account-get-claude-email-invalid',
        method: 'accountOps.getClaudeEmail',
        params: { unexpected: true }
      })
    )

    expect(getClaudeEmail).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'account-get-claude-email-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes accountOps.getOpenAIEmail to the injected provider service', async () => {
    const getOpenAIEmail = vi.fn(() => Effect.succeed('openai@example.com'))
    const service = { getOpenAIEmail } as unknown as AccountOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      accountOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'account-get-openai-email-1',
        method: 'accountOps.getOpenAIEmail',
        params: {}
      })
    )

    expect(getOpenAIEmail).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'account-get-openai-email-1',
      ok: true,
      value: 'openai@example.com'
    })
  })

  it('validates accountOps.getOpenAIEmail params before calling the provider service', async () => {
    const getOpenAIEmail = vi.fn(() => Effect.succeed(null))
    const service = { getOpenAIEmail } as unknown as AccountOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      accountOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'account-get-openai-email-invalid',
        method: 'accountOps.getOpenAIEmail',
        params: { unexpected: true }
      })
    )

    expect(getOpenAIEmail).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'account-get-openai-email-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes accountOps.listSaved to the injected provider service', async () => {
    const result: SavedAccountDTO[] = [
      {
        id: 'account-1',
        provider: 'openai',
        email: 'openai@example.com',
        last_usage: null,
        last_fetched_at: '2026-05-31T00:00:00.000Z',
        status: 'ok',
        last_error: null,
        created_at: '2026-05-30T00:00:00.000Z'
      }
    ]
    const listSaved = vi.fn(() => Effect.succeed(result))
    const service = { listSaved } as unknown as AccountOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      accountOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'account-list-saved-1',
        method: 'accountOps.listSaved',
        params: { provider: 'openai' }
      })
    )

    expect(listSaved).toHaveBeenCalledWith('openai')
    expect(response).toEqual({
      id: 'account-list-saved-1',
      ok: true,
      value: result
    })
  })

  it('validates accountOps.listSaved params before calling the provider service', async () => {
    const listSaved = vi.fn(() => Effect.succeed([]))
    const service = { listSaved } as unknown as AccountOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      accountOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'account-list-saved-invalid',
        method: 'accountOps.listSaved',
        params: { provider: 'other' }
      })
    )

    expect(listSaved).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'account-list-saved-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes accountOps.removeSaved to the injected provider service', async () => {
    const removeSaved = vi.fn(() => Effect.succeed(true))
    const service = { removeSaved } as unknown as AccountOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      accountOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'account-remove-saved-1',
        method: 'accountOps.removeSaved',
        params: { accountId: 'account-1' }
      })
    )

    expect(removeSaved).toHaveBeenCalledWith('account-1')
    expect(response).toEqual({
      id: 'account-remove-saved-1',
      ok: true,
      value: true
    })
  })

  it('validates accountOps.removeSaved params before calling the provider service', async () => {
    const removeSaved = vi.fn(() => Effect.succeed(false))
    const service = { removeSaved } as unknown as AccountOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      accountOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'account-remove-saved-invalid',
        method: 'accountOps.removeSaved',
        params: { accountId: 123 }
      })
    )

    expect(removeSaved).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'account-remove-saved-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
