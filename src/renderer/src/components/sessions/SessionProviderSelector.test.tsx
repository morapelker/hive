import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProviderSelector } from './SessionProviderSelector'

const storeMocks = vi.hoisted(() => ({
  settingsState: {
    availableAgentSdks: {
      opencode: true,
      claude: true,
      codex: true
    } as { opencode: boolean; claude: boolean; codex: boolean } | null
  },
  sessionState: {
    changeBlankSessionProvider: vi.fn(async () => ({ success: true }))
  }
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: (
    selector: (state: typeof storeMocks.settingsState) => unknown
  ): unknown => selector(storeMocks.settingsState)
}))

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: (
    selector: (state: typeof storeMocks.sessionState) => unknown
  ): unknown => selector(storeMocks.sessionState)
}))

describe('SessionProviderSelector', () => {
  beforeEach(() => {
    storeMocks.settingsState.availableAgentSdks = {
      opencode: true,
      claude: true,
      codex: true
    }
    storeMocks.sessionState.changeBlankSessionProvider = vi.fn(async () => ({ success: true }))
  })

  afterEach(() => {
    cleanup()
  })

  it('renders static provider text when the session is not blank', () => {
    render(<SessionProviderSelector sessionId="session-1" agentSdk="codex" canChange={false} />)

    expect(screen.getByTestId('session-provider-label')).toHaveTextContent('CODEX')
    expect(screen.queryByTestId('session-provider-selector')).not.toBeInTheDocument()
  })

  it('lists only available AI providers and omits Terminal and All providers', async () => {
    storeMocks.settingsState.availableAgentSdks = {
      opencode: true,
      claude: false,
      codex: true
    }

    render(<SessionProviderSelector sessionId="session-1" agentSdk="opencode" canChange />)
    await userEvent.click(screen.getByTestId('session-provider-selector'))

    expect(await screen.findByTestId('session-provider-option-opencode')).toBeInTheDocument()
    expect(screen.getByTestId('session-provider-option-codex')).toBeInTheDocument()
    expect(screen.queryByTestId('session-provider-option-claude-code')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-provider-option-claude-code-cli')).not.toBeInTheDocument()
    expect(screen.queryByText('Terminal')).not.toBeInTheDocument()
    expect(screen.queryByText('All providers')).not.toBeInTheDocument()
  })

  it('renders static provider text while availability is unknown', () => {
    storeMocks.settingsState.availableAgentSdks = null

    render(<SessionProviderSelector sessionId="session-1" agentSdk="opencode" canChange />)

    expect(screen.getByTestId('session-provider-label')).toHaveTextContent('OPENCODE')
    expect(screen.queryByTestId('session-provider-selector')).not.toBeInTheDocument()
  })

  it('calls the store action when a different provider is selected', async () => {
    render(<SessionProviderSelector sessionId="session-1" agentSdk="opencode" canChange />)
    await userEvent.click(screen.getByTestId('session-provider-selector'))
    await userEvent.click(await screen.findByTestId('session-provider-option-claude-code'))

    await waitFor(() => {
      expect(storeMocks.sessionState.changeBlankSessionProvider).toHaveBeenCalledWith(
        'session-1',
        'claude-code'
      )
    })
  })
})
