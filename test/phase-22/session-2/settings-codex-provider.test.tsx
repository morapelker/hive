import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mutable store state
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
  useThemeStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const state = { setTheme: vi.fn() }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({ setTheme: vi.fn() })
    }
  )
}))

vi.mock('@/stores/useShortcutStore', () => ({
  useShortcutStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const state = { resetToDefaults: vi.fn() }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({ resetToDefaults: vi.fn() })
    }
  )
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

describe('SettingsGeneral: Codex provider button', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockSettingsState = {
      autoStartSession: true,
      breedType: 'dogs',
      showModelIcons: false,
      showUsageIndicator: true,
      defaultAgentSdk: 'opencode',
      availableAgentSdks: null,
      stripAtMentions: true,
      updateSetting: mockUpdateSetting,
      resetToDefaults: vi.fn()
    }
  })

  it('renders the Codex button', async () => {
    const { SettingsGeneral } = await import(
      '@/components/settings/SettingsGeneral'
    )
    render(<SettingsGeneral />)

    const codexButton = screen.getByTestId('agent-sdk-codex')
    expect(codexButton).toBeInTheDocument()
    expect(codexButton).toHaveTextContent('Codex')
  })

  it('renders all four provider buttons (OpenCode, Claude Code, Codex, Terminal)', async () => {
    const { SettingsGeneral } = await import(
      '@/components/settings/SettingsGeneral'
    )
    render(<SettingsGeneral />)

    expect(screen.getByTestId('agent-sdk-opencode')).toBeInTheDocument()
    expect(screen.getByTestId('agent-sdk-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('agent-sdk-codex')).toBeInTheDocument()
    expect(screen.getByTestId('agent-sdk-terminal')).toBeInTheDocument()
  })

  it('clicking Codex button calls updateSetting with codex', async () => {
    const { SettingsGeneral } = await import(
      '@/components/settings/SettingsGeneral'
    )
    render(<SettingsGeneral />)

    const codexButton = screen.getByTestId('agent-sdk-codex')
    await userEvent.click(codexButton)

    expect(mockUpdateSetting).toHaveBeenCalledWith('defaultAgentSdk', 'codex')
  })

  it('Codex button has active styling when defaultAgentSdk is codex', async () => {
    mockSettingsState.defaultAgentSdk = 'codex'

    const { SettingsGeneral } = await import(
      '@/components/settings/SettingsGeneral'
    )
    render(<SettingsGeneral />)

    const codexButton = screen.getByTestId('agent-sdk-codex')
    // Active button has bg-primary class
    expect(codexButton.className).toContain('bg-primary')
  })

  it('Codex button has inactive styling when another SDK is default', async () => {
    mockSettingsState.defaultAgentSdk = 'opencode'

    const { SettingsGeneral } = await import(
      '@/components/settings/SettingsGeneral'
    )
    render(<SettingsGeneral />)

    const codexButton = screen.getByTestId('agent-sdk-codex')
    // Inactive button has bg-muted/50 class
    expect(codexButton.className).toContain('bg-muted/50')
  })

  it('disables unavailable providers when availability is known', async () => {
    mockSettingsState.availableAgentSdks = {
      opencode: false,
      claude: true,
      codex: true
    }

    const { SettingsGeneral } = await import(
      '@/components/settings/SettingsGeneral'
    )
    render(<SettingsGeneral />)

    const opencodeButton = screen.getByTestId('agent-sdk-opencode')
    expect(opencodeButton).toBeDisabled()

    await userEvent.click(opencodeButton)
    expect(mockUpdateSetting).not.toHaveBeenCalledWith('defaultAgentSdk', 'opencode')
  })
})
