import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoginStatusDTO, SavedAccountDTO } from '@shared/types/usage'
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

  it('routes loginStart through the renderer RPC client with an email hint', async () => {
    const request = vi.fn().mockResolvedValue({ loginId: 'login-1' })
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(accountApi.loginStart('anthropic', 'user@example.com')).resolves.toEqual({
      loginId: 'login-1'
    })
    expect(request).toHaveBeenCalledWith('accountOps.loginStart', {
      provider: 'anthropic',
      email: 'user@example.com'
    })
  })

  it('routes loginStart through the renderer RPC client without an email hint', async () => {
    const request = vi.fn().mockResolvedValue({ loginId: 'login-2' })
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(accountApi.loginStart('openai')).resolves.toEqual({ loginId: 'login-2' })
    expect(request).toHaveBeenCalledWith('accountOps.loginStart', {
      provider: 'openai',
      email: undefined
    })
  })

  it('routes loginStatus through the renderer RPC client', async () => {
    const status: LoginStatusDTO = {
      loginId: 'login-1',
      provider: 'anthropic',
      state: 'waiting',
      email: null,
      error: null
    }
    const request = vi.fn().mockResolvedValue(status)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(accountApi.loginStatus('login-1')).resolves.toEqual(status)
    expect(request).toHaveBeenCalledWith('accountOps.loginStatus', { loginId: 'login-1' })
  })

  it('routes loginCancel through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(accountApi.loginCancel('login-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('accountOps.loginCancel', { loginId: 'login-1' })
  })
})
