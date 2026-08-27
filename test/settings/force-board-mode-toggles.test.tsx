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

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    autoStartSession: true,
    autoPullBeforeWorktree: true,
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
    hiveAuthToken: null,
    hiveOrganizationId: null,
    hiveOrganizationForceBoardMode: false,
    updateSetting: mockUpdateSetting,
    resetToDefaults: vi.fn(),
    ...overrides
  }
}

describe('SettingsGeneral under org Force board mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsState = baseState()
  })

  it('keeps both controls interactive when the policy is off', async () => {
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    const autoStart = screen.getByTestId('auto-start-session-toggle')
    const off = screen.getByTestId('auto-pin-mode-off')
    const rootBranch = screen.getByTestId('auto-pin-mode-root-branch')
    const currentBranch = screen.getByTestId('auto-pin-mode-current-branch')

    expect(autoStart).toHaveAttribute('aria-checked', 'true')
    expect(autoStart).not.toBeDisabled()
    expect(off).toHaveAttribute('aria-checked', 'true')
    expect(rootBranch).toHaveAttribute('aria-checked', 'false')
    expect(currentBranch).toHaveAttribute('aria-checked', 'false')
    for (const button of [off, rootBranch, currentBranch]) {
      expect(button).not.toBeDisabled()
    }

    await userEvent.click(rootBranch)
    expect(mockUpdateSetting).toHaveBeenCalledWith('autoPinOnBoardPrompt', 'root-branch')
    await userEvent.click(currentBranch)
    expect(mockUpdateSetting).toHaveBeenCalledWith('autoPinOnBoardPrompt', 'current-branch')
  })

  it('reflects the persisted auto-pin mode', async () => {
    mockSettingsState = baseState({ autoPinOnBoardPrompt: 'current-branch' })
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    expect(screen.getByTestId('auto-pin-mode-off')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('auto-pin-mode-root-branch')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('auto-pin-mode-current-branch')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('locks auto-start off and auto-pin to Root branch when the policy is on', async () => {
    mockSettingsState = baseState({
      // A local 'current-branch' choice is overridden, not just 'off'
      autoPinOnBoardPrompt: 'current-branch',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1',
      hiveOrganizationForceBoardMode: true
    })
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    const autoStart = screen.getByTestId('auto-start-session-toggle')
    const off = screen.getByTestId('auto-pin-mode-off')
    const rootBranch = screen.getByTestId('auto-pin-mode-root-branch')
    const currentBranch = screen.getByTestId('auto-pin-mode-current-branch')

    expect(autoStart).toHaveAttribute('aria-checked', 'false')
    expect(autoStart).toBeDisabled()
    expect(off).toHaveAttribute('aria-checked', 'false')
    expect(rootBranch).toHaveAttribute('aria-checked', 'true')
    expect(currentBranch).toHaveAttribute('aria-checked', 'false')
    for (const button of [off, rootBranch, currentBranch]) {
      expect(button).toBeDisabled()
    }

    expect(screen.getByText('Disabled by your organization (Force board mode)')).toBeInTheDocument()
    expect(
      screen.getByText('Set to Root branch by your organization (Force board mode)')
    ).toBeInTheDocument()

    await userEvent.click(autoStart)
    await userEvent.click(off)
    await userEvent.click(currentBranch)
    expect(mockUpdateSetting).not.toHaveBeenCalled()
  })
})
