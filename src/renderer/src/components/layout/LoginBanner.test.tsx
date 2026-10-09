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
        error: null,
        stage: null,
        stageDetail: null
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
    expect((pill.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion).toBe(
      'no-drag'
    )
  })

  it('clears the active login when Cancel is clicked', () => {
    render(<LoginBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(useLoginStore.getState().activeLogin).toBeNull()
  })
})

describe('LoginBanner automated sign-in stages', () => {
  afterEach(() => {
    cleanup()
    useLoginStore.setState({ activeLogin: null })
  })

  it('describes the automation stage instead of the Chrome hint', () => {
    useLoginStore.setState({
      activeLogin: {
        loginId: 'login-2',
        provider: 'anthropic',
        email: 'a@b.com',
        state: 'waiting',
        error: null,
        stage: 'waiting-for-code',
        stageDetail: null
      }
    })
    render(<LoginBanner />)

    expect(screen.getByTestId('login-banner-text').textContent).toBe(
      'Signing in to Claude — waiting for the sign-in code…'
    )
  })

  it("shows the driver's own reason when it needs the user to finish", () => {
    useLoginStore.setState({
      activeLogin: {
        loginId: 'login-3',
        provider: 'anthropic',
        email: 'a@b.com',
        state: 'waiting',
        error: null,
        stage: 'needs-human',
        stageDetail: 'Cloudflare verification is required — complete it in the Chrome window'
      }
    })
    render(<LoginBanner />)

    expect(screen.getByTestId('login-banner-text').textContent).toBe(
      'Cloudflare verification is required — complete it in the Chrome window'
    )
  })
})
