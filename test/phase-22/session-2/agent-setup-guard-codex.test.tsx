import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

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
    availableSdks: { opencode: boolean; claude: boolean; codex: boolean }
  }) => (
    <div data-testid="agent-picker-dialog">
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

// Mock window APIs
const mockDetectAgentSdks = vi.fn()
const mockTrack = vi.fn()

describe('AgentSetupGuard with Codex support', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockSettingsState = {
      initialSetupComplete: false,
      isLoading: false,
      updateSetting: vi.fn()
    }

    Object.defineProperty(window, 'systemOps', {
      writable: true,
      configurable: true,
      value: {
        detectAgentSdks: mockDetectAgentSdks,
        quitApp: vi.fn()
      }
    })

    Object.defineProperty(window, 'analyticsOps', {
      writable: true,
      configurable: true,
      value: {
        track: mockTrack
      }
    })
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
