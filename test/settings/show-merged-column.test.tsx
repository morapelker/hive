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

describe('SettingsGeneral merged column toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsState = {
      autoStartSession: true,
      autoPullBeforeWorktree: true,
      boardMode: 'sticky-tab',
      followUpTriggerColumn: 'done',
      autoPinBaseWorktreeOnBoardPrompt: false,
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

  it('renders off by default and enables the merged column on click', async () => {
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    const toggle = screen.getByTestId('show-merged-column-toggle')

    expect(screen.getByText('Merged column')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(toggle)

    expect(mockUpdateSetting).toHaveBeenCalledWith('showMergedColumn', true)
  })

  it('renders on and disables the merged column on click', async () => {
    mockSettingsState.showMergedColumn = true
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    const toggle = screen.getByTestId('show-merged-column-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    expect(mockUpdateSetting).toHaveBeenCalledWith('showMergedColumn', false)
  })
})
