import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useUsageStore } from '@/stores/useUsageStore'
import { useAccountStore } from '@/stores/useAccountStore'
import { useLoginStore } from '@/stores/useLoginStore'
import { SettingsAccounts } from './SettingsAccounts'
import type { SavedAccountDTO } from '@shared/types/usage'

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('@/lib/platform', () => ({
  isMac: () => true
}))

const anthropicAccounts: SavedAccountDTO[] = [
  {
    id: 'acc-active',
    provider: 'anthropic',
    email: 'active@example.com',
    last_usage: null,
    last_fetched_at: null,
    status: 'ok',
    last_error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    plan: 'Max'
  },
  {
    id: 'acc-expired',
    provider: 'anthropic',
    email: 'expired@example.com',
    last_usage: null,
    last_fetched_at: null,
    status: 'stale',
    last_error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    plan: null
  }
]

// Render and flush the mount effect's async loadSavedAccounts/fetchEmail so
// their state updates land inside act().
async function renderSettingsAccounts(): Promise<void> {
  render(<SettingsAccounts />)
  await act(async () => {})
}

describe('SettingsAccounts', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    request = vi.fn(async (method: string) => {
      if (method === 'accountOps.listSaved') return anthropicAccounts
      if (method === 'accountOps.getClaudeEmail') return 'active@example.com'
      if (method === 'accountOps.getOpenAIEmail') return null
      if (method === 'accountOps.removeSaved') return true
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    useUsageStore.setState({
      savedAccounts: { anthropic: anthropicAccounts, openai: [] },
      savedAccountLoadErrors: { anthropic: null, openai: null },
      refreshingAccountIds: new Set<string>(),
      removingAccountIds: new Set<string>(),
      switchingAccountIds: new Set<string>()
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    useAccountStore.setState({ anthropicEmail: 'active@example.com', openaiEmail: null })
    useLoginStore.setState({ activeLogin: null })
  })

  afterEach(() => {
    cleanup()
    resetRendererRpcClientForTests()
  })

  it('renders account rows with Active, plan, and Expired badges', async () => {
    await renderSettingsAccounts()

    expect(screen.getByText('active@example.com')).not.toBeNull()
    expect(screen.getByText('expired@example.com')).not.toBeNull()
    expect(screen.getByText('Active')).not.toBeNull()
    expect(screen.getByText('Max')).not.toBeNull()
    expect(screen.getByText('Expired')).not.toBeNull()
  })

  it('hides Switch on the active account and shows it on others', async () => {
    await renderSettingsAccounts()

    expect(screen.queryByRole('button', { name: /^switch to active@example.com$/i })).toBeNull()
    expect(
      screen.getByRole('button', { name: /^switch to expired@example.com$/i })
    ).not.toBeNull()
  })

  it('shows Sign in again only for expired accounts', async () => {
    await renderSettingsAccounts()

    const signInButtons = screen.getAllByRole('button', { name: /sign in again/i })
    expect(signInButtons).toHaveLength(1)
  })

  it('requires confirmation before removing an account', async () => {
    const user = userEvent.setup()
    await renderSettingsAccounts()

    await user.click(screen.getByRole('button', { name: /remove expired@example.com/i }))

    // No RPC call before confirming
    expect(request).not.toHaveBeenCalledWith('accountOps.removeSaved', expect.anything())
    expect(screen.getByText('Remove account?')).not.toBeNull()

    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(request).toHaveBeenCalledWith('accountOps.removeSaved', { accountId: 'acc-expired' })
    // Flush the store's post-remove reload chain inside act
    await act(async () => {})
  })

  it('disables Add account while a login is active', async () => {
    useLoginStore.setState({
      activeLogin: {
        loginId: 'login-1',
        provider: 'anthropic',
        email: null,
        state: 'waiting',
        error: null
      }
    })

    await renderSettingsAccounts()

    const addButton = screen.getByTestId('add-account-anthropic') as HTMLButtonElement
    expect(addButton.disabled).toBe(true)
  })

  it('starts a login when Add account is clicked', async () => {
    const user = userEvent.setup()
    request.mockImplementation(async (method: string) => {
      if (method === 'accountOps.loginStart') return { loginId: 'login-2' }
      if (method === 'accountOps.listSaved') return anthropicAccounts
      if (method === 'accountOps.getClaudeEmail') return 'active@example.com'
      if (method === 'accountOps.getOpenAIEmail') return null
      return null
    })
    await renderSettingsAccounts()

    await user.click(screen.getByTestId('add-account-anthropic'))

    expect(request).toHaveBeenCalledWith('accountOps.loginStart', {
      provider: 'anthropic',
      email: undefined
    })
    // Clean up the poll the real store schedules
    await act(async () => {
      await useLoginStore.getState().cancelLogin()
    })
  })
})
