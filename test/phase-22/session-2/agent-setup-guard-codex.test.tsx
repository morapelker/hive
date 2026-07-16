import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const apiMocks = vi.hoisted(() => ({
  systemApi: {
    detectAgentSdks: vi.fn(),
    quitApp: vi.fn()
  },
  analyticsApi: {
    track: vi.fn()
  }
}))

// Mutable store state for settings
let mockSettingsState: {
  initialSetupComplete: boolean
  isLoading: boolean
  updateSetting: ReturnType<typeof vi.fn>
}

// Mock useSettingsStore
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

vi.mock('@/api/system-api', () => ({
  systemApi: apiMocks.systemApi
}))

vi.mock('@/api/analytics-api', () => ({
  analyticsApi: apiMocks.analyticsApi
}))

// Mock AgentNotFoundDialog
vi.mock('@/components/setup/AgentNotFoundDialog', () => ({
  AgentNotFoundDialog: () => <div data-testid="agent-not-found-dialog">No Agent Found</div>
}))

// Mock AgentPickerDialog — respects availableSdks to only show installed providers
vi.mock('@/components/setup/AgentPickerDialog', () => ({
  AgentPickerDialog: ({
    onSelect,
    availableSdks
  }: {
    onSelect: (sdk: string) => void
    availableSdks: { opencode: boolean; claude: boolean; codex: boolean; codexCli?: boolean }
  }) => (
    <div data-testid="agent-picker-dialog">
      {availableSdks.codexCli && (
        <button data-testid="pick-codex-cli" onClick={() => onSelect('codex-cli')}>
          Codex (CLI)
        </button>
      )}
      {availableSdks.opencode && (
        <button data-testid="pick-opencode" onClick={() => onSelect('opencode')}>
          OpenCode
        </button>
      )}
      {availableSdks.claude && (
        <button data-testid="pick-claude-code" onClick={() => onSelect('claude-code')}>
          Claude Code
        </button>
      )}
      {availableSdks.codex && (
        <button data-testid="pick-codex" onClick={() => onSelect('codex')}>
          Codex
        </button>
      )}
    </div>
  )
}))

const mockDetectAgentSdks = apiMocks.systemApi.detectAgentSdks
const mockTrack = apiMocks.analyticsApi.track

describe('AgentSetupGuard with Codex support', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockSettingsState = {
      initialSetupComplete: false,
      isLoading: false,
      updateSetting: vi.fn()
    }
  })

  it('auto-selects codex when it is the only installed provider', async () => {
    mockDetectAgentSdks.mockResolvedValue({ opencode: false, claude: false, codex: true })

    const { AgentSetupGuard } = await import(
      '@/components/setup/AgentSetupGuard'
    )
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('defaultAgentSdk', 'codex')
      expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('initialSetupComplete', true)
    })

    expect(mockTrack).toHaveBeenCalledWith('onboarding_completed', {
      sdk: 'codex',
      auto_selected: true
    })
  })

  it('shows picker with only installed providers (no claude when uninstalled)', async () => {
    mockDetectAgentSdks.mockResolvedValue({ opencode: true, claude: false, codex: true })

    const { AgentSetupGuard } = await import(
      '@/components/setup/AgentSetupGuard'
    )
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(screen.getByTestId('agent-picker-dialog')).toBeInTheDocument()
    })

    // Only opencode and codex buttons should be present
    expect(screen.getByTestId('pick-opencode')).toBeInTheDocument()
    expect(screen.getByTestId('pick-codex')).toBeInTheDocument()
    // Claude should NOT be shown since it's not installed
    expect(screen.queryByTestId('pick-claude-code')).not.toBeInTheDocument()
  })

  it('shows picker dialog when all three are installed', async () => {
    mockDetectAgentSdks.mockResolvedValue({ opencode: true, claude: true, codex: true })

    const { AgentSetupGuard } = await import(
      '@/components/setup/AgentSetupGuard'
    )
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(screen.getByTestId('agent-picker-dialog')).toBeInTheDocument()
    })

    // Verify Codex button is available in the picker
    expect(screen.getByTestId('pick-codex')).toBeInTheDocument()
  })

  it('shows none-found dialog when no agents are installed', async () => {
    mockDetectAgentSdks.mockResolvedValue({ opencode: false, claude: false, codex: false })

    const { AgentSetupGuard } = await import(
      '@/components/setup/AgentSetupGuard'
    )
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(screen.getByTestId('agent-not-found-dialog')).toBeInTheDocument()
    })
  })

  it('auto-selects codex-cli when the codex binary is present but app-server is unavailable', async () => {
    // codex false (no app-server), codexCli true (binary present) — the only usable provider.
    mockDetectAgentSdks.mockResolvedValue({
      opencode: false,
      claude: false,
      codex: false,
      codexCli: true
    })

    const { AgentSetupGuard } = await import('@/components/setup/AgentSetupGuard')
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('defaultAgentSdk', 'codex-cli')
      expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('initialSetupComplete', true)
    })
    // Must NOT be treated as "no agent found".
    expect(screen.queryByTestId('agent-not-found-dialog')).not.toBeInTheDocument()
  })

  it('offers Codex (CLI) as a distinct pick when combined with another provider', async () => {
    mockDetectAgentSdks.mockResolvedValue({
      opencode: true,
      claude: false,
      codex: false,
      codexCli: true
    })

    const { AgentSetupGuard } = await import('@/components/setup/AgentSetupGuard')
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(screen.getByTestId('agent-picker-dialog')).toBeInTheDocument()
    })
    expect(screen.getByTestId('pick-opencode')).toBeInTheDocument()
    expect(screen.getByTestId('pick-codex-cli')).toBeInTheDocument()
    // The SDK-backed Codex isn't available, so it must not be offered.
    expect(screen.queryByTestId('pick-codex')).not.toBeInTheDocument()
  })

  it('does not double up Codex and Codex (CLI) when both flags are set', async () => {
    // codex true implies codexCli true; only the richer SDK Codex should show.
    mockDetectAgentSdks.mockResolvedValue({
      opencode: true,
      claude: false,
      codex: true,
      codexCli: true
    })

    const { AgentSetupGuard } = await import('@/components/setup/AgentSetupGuard')
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(screen.getByTestId('agent-picker-dialog')).toBeInTheDocument()
    })
    expect(screen.getByTestId('pick-codex')).toBeInTheDocument()
    expect(screen.queryByTestId('pick-codex-cli')).not.toBeInTheDocument()
  })

  it('auto-selects opencode when only opencode is installed (codex false)', async () => {
    mockDetectAgentSdks.mockResolvedValue({ opencode: true, claude: false, codex: false })

    const { AgentSetupGuard } = await import(
      '@/components/setup/AgentSetupGuard'
    )
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('defaultAgentSdk', 'opencode')
      expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('initialSetupComplete', true)
    })
  })

  it('auto-selects claude-code when only claude is installed (codex false)', async () => {
    mockDetectAgentSdks.mockResolvedValue({ opencode: false, claude: true, codex: false })

    const { AgentSetupGuard } = await import(
      '@/components/setup/AgentSetupGuard'
    )
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('defaultAgentSdk', 'claude-code')
      expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('initialSetupComplete', true)
    })
  })

  it('renders nothing when setup is already complete', async () => {
    mockSettingsState.initialSetupComplete = true

    const { AgentSetupGuard } = await import(
      '@/components/setup/AgentSetupGuard'
    )
    const { container } = render(<AgentSetupGuard />)

    expect(container.innerHTML).toBe('')
    expect(mockDetectAgentSdks).not.toHaveBeenCalled()
  })
})
