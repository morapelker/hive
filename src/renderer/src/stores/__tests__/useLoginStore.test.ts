import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { toast } from '@/lib/toast'

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
}))

const mocks = vi.hoisted(() => ({
  loadSavedAccounts: vi.fn(async () => {}),
  fetchEmail: vi.fn(async () => {})
}))

vi.mock('../useUsageStore', () => ({
  useUsageStore: { getState: () => ({ loadSavedAccounts: mocks.loadSavedAccounts }) }
}))

vi.mock('../useAccountStore', () => ({
  useAccountStore: { getState: () => ({ fetchEmail: mocks.fetchEmail }) }
}))

import { useLoginStore } from '../useLoginStore'

describe('useLoginStore', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.loadSavedAccounts.mockClear()
    mocks.fetchEmail.mockClear()
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.info).mockClear()

    useLoginStore.setState({ activeLogin: null })

    request = vi.fn(async () => null)
    setRendererRpcClient({ request, subscribe: vi.fn() })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.useRealTimers()
  })

  it('starts a login, polls, and clears on done with success toast + account reload', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'accountOps.loginStart') return { loginId: 'login-1' }
      if (method === 'accountOps.loginStatus') {
        return { loginId: 'login-1', provider: 'anthropic', state: 'done', email: 'a@b.com', error: null }
      }
      return null
    })

    await useLoginStore.getState().startLogin('anthropic')
    expect(useLoginStore.getState().activeLogin).toMatchObject({
      loginId: 'login-1',
      provider: 'anthropic',
      state: 'launching'
    })

    await vi.advanceTimersByTimeAsync(1500)

    expect(useLoginStore.getState().activeLogin).toBeNull()
    expect(toast.success).toHaveBeenCalledWith('Signed in as a@b.com')
    expect(mocks.loadSavedAccounts).toHaveBeenCalledWith('anthropic')
    expect(mocks.fetchEmail).toHaveBeenCalledWith('anthropic')
  })

  it('keeps polling through non-terminal states before reaching done', async () => {
    let call = 0
    request.mockImplementation(async (method: string) => {
      if (method === 'accountOps.loginStart') return { loginId: 'login-2' }
      if (method === 'accountOps.loginStatus') {
        call += 1
        if (call === 1) {
          return { loginId: 'login-2', provider: 'anthropic', state: 'waiting', email: null, error: null }
        }
        return { loginId: 'login-2', provider: 'anthropic', state: 'done', email: 'x@y.com', error: null }
      }
      return null
    })

    await useLoginStore.getState().startLogin('anthropic')
    await vi.advanceTimersByTimeAsync(1500)
    expect(useLoginStore.getState().activeLogin?.state).toBe('waiting')

    await vi.advanceTimersByTimeAsync(1500)
    expect(useLoginStore.getState().activeLogin).toBeNull()
    expect(toast.success).toHaveBeenCalledWith('Signed in as x@y.com')
  })

  it('treats a login as failed after 5 consecutive poll rejections', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'accountOps.loginStart') return { loginId: 'login-3' }
      if (method === 'accountOps.loginStatus') throw new Error('ws disconnected')
      return null
    })

    await useLoginStore.getState().startLogin('anthropic')

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(1500)
      expect(useLoginStore.getState().activeLogin).not.toBeNull()
    }

    await vi.advanceTimersByTimeAsync(1500)
    expect(useLoginStore.getState().activeLogin).toBeNull()
    expect(toast.error).toHaveBeenCalledWith('Sign-in failed')
  })

  it('resets the failure counter on a successful poll, so fewer-than-5 failures keep polling', async () => {
    let call = 0
    request.mockImplementation(async (method: string) => {
      if (method === 'accountOps.loginStart') return { loginId: 'login-4' }
      if (method === 'accountOps.loginStatus') {
        call += 1
        // Fail 3 times, succeed, fail 3 more times (never 5 in a row) -> still polling
        if (call === 4) {
          return { loginId: 'login-4', provider: 'anthropic', state: 'waiting', email: null, error: null }
        }
        throw new Error('ws disconnected')
      }
      return null
    })

    await useLoginStore.getState().startLogin('anthropic')

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1500)
    }

    // Still active — never hit 5 CONSECUTIVE failures because call 4 succeeded
    expect(useLoginStore.getState().activeLogin).not.toBeNull()
    expect(toast.error).not.toHaveBeenCalledWith('Sign-in failed')
  })

  it('surfaces the terminal failed state from the server with its error message', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'accountOps.loginStart') return { loginId: 'login-5' }
      if (method === 'accountOps.loginStatus') {
        return {
          loginId: 'login-5',
          provider: 'anthropic',
          state: 'failed',
          email: null,
          error: 'Token exchange failed'
        }
      }
      return null
    })

    await useLoginStore.getState().startLogin('anthropic')
    await vi.advanceTimersByTimeAsync(1500)

    expect(useLoginStore.getState().activeLogin).toBeNull()
    expect(toast.error).toHaveBeenCalledWith('Token exchange failed')
  })

  it('cancelLogin calls the cancel API and clears local state immediately', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'accountOps.loginStart') return { loginId: 'login-6' }
      if (method === 'accountOps.loginCancel') return true
      if (method === 'accountOps.loginStatus') {
        return { loginId: 'login-6', provider: 'anthropic', state: 'waiting', email: null, error: null }
      }
      return null
    })

    await useLoginStore.getState().startLogin('anthropic')
    await useLoginStore.getState().cancelLogin()

    expect(useLoginStore.getState().activeLogin).toBeNull()
    expect(request).toHaveBeenCalledWith('accountOps.loginCancel', { loginId: 'login-6' })
    expect(toast.info).toHaveBeenCalledWith('Sign-in cancelled')

    // Any poll already scheduled before cancel must not resurrect activeLogin.
    await vi.advanceTimersByTimeAsync(3000)
    expect(useLoginStore.getState().activeLogin).toBeNull()
  })

  it('does not clobber the existing activeLogin when the server rejects a concurrent login', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'accountOps.loginStart') return { loginId: 'login-7' }
      if (method === 'accountOps.loginStatus') {
        return { loginId: 'login-7', provider: 'anthropic', state: 'waiting', email: null, error: null }
      }
      return null
    })
    await useLoginStore.getState().startLogin('anthropic')
    const before = useLoginStore.getState().activeLogin

    request.mockImplementationOnce(async () => {
      throw new Error('A login is already in progress')
    })
    await useLoginStore.getState().startLogin('openai')

    expect(useLoginStore.getState().activeLogin).toEqual(before)
    expect(toast.error).toHaveBeenCalledWith('A login is already in progress')
  })
})
