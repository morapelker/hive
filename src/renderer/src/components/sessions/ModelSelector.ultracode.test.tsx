import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelSelector } from './ModelSelector'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'

// Catalog returned by listModels for the claude-code provider (shared by the CLI).
// Opus exposes xhigh (ultracode-eligible); Sonnet caps at high (not eligible).
const PROVIDERS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    models: {
      opus: { id: 'opus', name: 'Opus 5', variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} } },
      sonnet: { id: 'sonnet', name: 'Sonnet 4.6', variants: { low: {}, medium: {}, high: {} } }
    }
  }
]

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: {
    listModels: vi.fn(async () => ({ success: true, providers: PROVIDERS }))
  }
}))

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()

beforeAll(() => {
  // Radix DropdownMenu relies on these in a real browser; jsdom lacks them.
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  useSettingsStore.setState({
    defaultAgentSdk: 'codex',
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    showModelProvider: false,
    favoriteModels: []
  })
  useSessionStore.setState({
    sessionsByWorktree: new Map(),
    sessionsByConnection: new Map()
  })
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(initialSettingsState, true)
  useSessionStore.setState(initialSessionState, true)
})

async function openPicker(agentSdkOverride: 'claude-code' | 'claude-code-cli'): Promise<void> {
  render(<ModelSelector agentSdkOverride={agentSdkOverride} />)
  // Open the dropdown once models have loaded.
  await userEvent.click(await screen.findByTestId('model-selector'))
  await waitFor(() => expect(screen.getByTestId('variant-chips-opus')).toBeInTheDocument())
}

describe('ModelSelector ultracode chip', () => {
  it('shows the ULTRACODE chip on Opus under claude-code-cli, but not on Sonnet', async () => {
    await openPicker('claude-code-cli')

    const opusChips = screen.getByTestId('variant-chips-opus')
    expect(within(opusChips).getByTestId('variant-chip-ultracode')).toBeInTheDocument()

    const sonnetChips = screen.getByTestId('variant-chips-sonnet')
    expect(within(sonnetChips).queryByTestId('variant-chip-ultracode')).toBeNull()
  })

  it('does not show the ULTRACODE chip under the non-CLI claude-code SDK', async () => {
    await openPicker('claude-code')

    const opusChips = screen.getByTestId('variant-chips-opus')
    expect(within(opusChips).queryByTestId('variant-chip-ultracode')).toBeNull()
  })
})
