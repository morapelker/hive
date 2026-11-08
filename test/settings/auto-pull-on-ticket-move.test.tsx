import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockUpdateSetting = vi.fn()
let mockSettingsState: Record<string, unknown> = {}

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      return selector ? selector(mockSettingsState) : mockSettingsState
    },
    {
      getState: () => mockSettingsState
    }
  )
}))

vi.mock('@/stores/useThemeStore', () => ({
  useThemeStore: () => ({ setTheme: vi.fn() })
}))

vi.mock('@/stores/useShortcutStore', () => ({
  useShortcutStore: () => ({ resetToDefaults: vi.fn() })
}))

vi.mock('@/lib/themes', () => ({
  DEFAULT_THEME_ID: 'default'
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('SettingsGeneral pull-before-moving-tickets toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsState = {
      autoStartSession: true,
      autoPullBeforeWorktree: true,
      autoPullOnTicketMove: true,
      boardMode: 'sticky-tab',
      followUpTriggerColumn: 'done',
      autoPinOnBoardPrompt: 'off',
      automaticallyCreateTicket: false,
      showMergedColumn: false,
      vimModeEnabled: false,
      keepAwakeEnabled: false,
      mergeConflictMode: 'always-ask',
      tipsEnabled: true,
      warnBeforeQuitting: true,
      breedType: 'dogs',
      showModelIcons: false,
      showModelProvider: false,
      usageIndicatorMode: 'current-agent',
      usageIndicatorProviders: [],
      defaultAgentSdk: 'opencode',
      availableAgentSdks: null,
      stripAtMentions: true,
      updateSetting: mockUpdateSetting,
      resetToDefaults: vi.fn()
    }
  })

  it('renders on by default and turns the pull off on click', async () => {
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    const toggle = screen.getByTestId('auto-pull-on-ticket-move-toggle')

    expect(screen.getByText('Pull before moving tickets')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    expect(mockUpdateSetting).toHaveBeenCalledWith('autoPullOnTicketMove', false)
  })

  it('renders off and turns the pull back on on click', async () => {
    mockSettingsState.autoPullOnTicketMove = false
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    const toggle = screen.getByTestId('auto-pull-on-ticket-move-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(toggle)

    expect(mockUpdateSetting).toHaveBeenCalledWith('autoPullOnTicketMove', true)
  })
})
