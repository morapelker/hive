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

describe('SettingsGeneral warn before quitting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsState = {
      autoStartSession: true,
      autoPullBeforeWorktree: true,
      boardMode: 'sticky-tab',
      followUpTriggerColumn: 'done',
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

  it('renders and toggles the warn before quitting setting', async () => {
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    const toggle = screen.getByTestId('warn-before-quitting-toggle')

    expect(screen.getByText('Warn before quitting (⌘Q)')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    expect(mockUpdateSetting).toHaveBeenCalledWith('warnBeforeQuitting', false)
  })
})
