import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useLoginStore } from '@/stores/useLoginStore'
import { LoginBanner } from './LoginBanner'

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
}))

describe('LoginBanner', () => {
  beforeEach(() => {
    useLoginStore.setState({
      activeLogin: {
        loginId: 'login-1',
        provider: 'anthropic',
        email: null,
        state: 'waiting',
        error: null
      }
    })
    const request: ReturnType<typeof vi.fn> = vi.fn(async () => null)
    setRendererRpcClient({ request, subscribe: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    resetRendererRpcClientForTests()
    useLoginStore.setState({ activeLogin: null })
  })

  it('opts the banner out of the header drag region so Cancel is clickable', () => {
    render(<LoginBanner />)

    // The banner floats over the title-bar drag region; without no-drag,
    // Electron swallows clicks before they reach the Cancel button.
    const pill = screen.getByRole('button', { name: 'Cancel' }).parentElement as HTMLElement
    expect(
      (pill.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion
    ).toBe('no-drag')
  })

  it('clears the active login when Cancel is clicked', () => {
    render(<LoginBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(useLoginStore.getState().activeLogin).toBeNull()
  })
})
