import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { markHiveOrgPolicySettled } from '@/api/hive-enterprise/client'

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

// Hosted-only gate: the shell's session seam must be installed for the cached organisation
// to count.
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
    ticketKeyDisplay: 'always',
    showModelProvider: false,
    usageIndicatorMode: 'current-agent',
    usageIndicatorProviders: [],
    defaultAgentSdk: 'opencode',
    availableAgentSdks: null,
    stripAtMentions: true,
    hiveOrganizationId: null,
    hiveOrganizationForceBoardMode: false,
    updateSetting: mockUpdateSetting,
    resetToDefaults: vi.fn(),
    ...overrides
  }
}

describe('SettingsGeneral › Ticket IDs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsState = baseState()
    markHiveOrgPolicySettled()
  })


  it('offers always / orchestrator only / never and reflects the stored choice', async () => {
    mockSettingsState = baseState({ ticketKeyDisplay: 'orchestrator' })
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    expect(screen.getByTestId('ticket-key-display-always')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('ticket-key-display-orchestrator')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('ticket-key-display-never')).toHaveAttribute('aria-checked', 'false')
  })

  it('writes the chosen mode to the settings store', async () => {
    const { SettingsGeneral } = await import('@/components/settings/SettingsGeneral')
    render(<SettingsGeneral />)

    await userEvent.click(screen.getByTestId('ticket-key-display-never'))
    expect(mockUpdateSetting).toHaveBeenCalledWith('ticketKeyDisplay', 'never')

    await userEvent.click(screen.getByTestId('ticket-key-display-orchestrator'))
    expect(mockUpdateSetting).toHaveBeenCalledWith('ticketKeyDisplay', 'orchestrator')
  })
})
