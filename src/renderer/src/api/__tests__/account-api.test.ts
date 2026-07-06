import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SavedAccountDTO } from '@shared/types/usage'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { accountApi } from '../account-api'

describe('accountApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes getClaudeEmail through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('claude@example.com')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(accountApi.getClaudeEmail()).resolves.toBe('claude@example.com')
    expect(request).toHaveBeenCalledWith('accountOps.getClaudeEmail', {})
  })

  it('routes getOpenAIEmail through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('openai@example.com')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(accountApi.getOpenAIEmail()).resolves.toBe('openai@example.com')
    expect(request).toHaveBeenCalledWith('accountOps.getOpenAIEmail', {})
  })

  it('routes listSaved through the renderer RPC client', async () => {
    const accounts: SavedAccountDTO[] = [
      {
        id: 'account-1',
        provider: 'openai',
        email: 'openai-user@example.com',
        last_usage: null,
        last_fetched_at: '2026-05-25T00:00:00.000Z',
        status: 'ok',
        last_error: null,
        created_at: '2026-05-24T00:00:00.000Z',
        plan: null
      }
    ]
    const request = vi.fn().mockResolvedValue(accounts)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(accountApi.listSaved('openai')).resolves.toBe(accounts)
    expect(request).toHaveBeenCalledWith('accountOps.listSaved', { provider: 'openai' })
  })

  it('routes removeSaved through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(accountApi.removeSaved('account-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('accountOps.removeSaved', { accountId: 'account-1' })
  })

  it('routes switchAccount through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue({ success: true })
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(accountApi.switchAccount('account-1')).resolves.toEqual({ success: true })
    expect(request).toHaveBeenCalledWith('accountOps.switchAccount', { accountId: 'account-1' })
  })

  it('routes a switchAccount failure result through unchanged', async () => {
    const request = vi.fn().mockResolvedValue({ success: false, error: 'account no longer in store' })
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(accountApi.switchAccount('account-1')).resolves.toEqual({
      success: false,
      error: 'account no longer in store'
    })
  })
})
