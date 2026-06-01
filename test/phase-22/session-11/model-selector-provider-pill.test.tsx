import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const claudeProviders = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'opus-4.5': {
        id: 'opus-4.5',
        name: 'Opus 4.5'
      }
    }
  }
]

const codexProviders = [
  {
    id: 'codex',
    name: 'Codex',
    models: {
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5'
      }
    }
  }
]

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    setting: {
      get: vi.fn(),
      set: vi.fn()
    }
  },
  opencodeApi: {
    listModels: vi.fn()
  },
  petApi: {
    hide: vi.fn(),
    show: vi.fn(),
    updateSettings: vi.fn()
  },
  settingsApi: {
    onSettingsUpdated: vi.fn()
  },
  systemApi: {
    detectAgentSdks: vi.fn()
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: apiMocks.dbApi
}))

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: apiMocks.opencodeApi
}))

vi.mock('@/api/pet-api', () => ({
  petApi: apiMocks.petApi
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

vi.mock('@/api/system-api', () => ({
  systemApi: apiMocks.systemApi
}))

function mockListModelsForAgentSdk({ agentSdk }: { agentSdk?: string } = {}) {
  if (agentSdk === 'codex') {
    return { success: true, value: { success: true, providers: codexProviders } }
  }

  return { success: true, value: { success: true, providers: claudeProviders } }
}

import { ModelSelector } from '@/components/sessions/ModelSelector'
import { useSettingsStore } from '@/stores/useSettingsStore'

describe('ModelSelector provider filter pill', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    apiMocks.dbApi.setting.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.set.mockResolvedValue(true)
    apiMocks.opencodeApi.listModels.mockImplementation(mockListModelsForAgentSdk)
    apiMocks.petApi.hide.mockResolvedValue(undefined)
    apiMocks.petApi.show.mockResolvedValue(undefined)
    apiMocks.petApi.updateSettings.mockResolvedValue({ success: true })
    apiMocks.settingsApi.onSettingsUpdated.mockReturnValue(vi.fn())
    apiMocks.systemApi.detectAgentSdks.mockResolvedValue({
      opencode: false,
      claude: true,
      codex: true
    })

    useSettingsStore.setState({
      defaultAgentSdk: 'claude-code',
      selectedModel: null,
      selectedModelByProvider: {
        'claude-code': {
          providerID: 'anthropic',
          modelID: 'opus-4.5'
        },
        codex: {
          providerID: 'codex',
          modelID: 'gpt-5.5'
        }
      },
      availableAgentSdks: {
        opencode: false,
        claude: true,
        codex: true
      }
    })
  })

  test('shows the controlled SDK label on first paint', async () => {
    render(
      <ModelSelector
        value={{ agentSdk: 'codex', providerID: 'codex', modelID: 'gpt-5.5' }}
        onChange={vi.fn()}
        allowAgentSdkSelection
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('model-provider-filter')).toHaveTextContent('Codex')
    })
  })

  test('updates the provider pill when the controlled SDK changes', async () => {
    const { rerender } = render(
      <ModelSelector
        value={{ agentSdk: 'codex', providerID: 'codex', modelID: 'gpt-5.5' }}
        onChange={vi.fn()}
        allowAgentSdkSelection
      />
    )

    expect(await screen.findByTestId('model-provider-filter')).toHaveTextContent('Codex')

    rerender(
      <ModelSelector
        value={{ agentSdk: 'claude-code', providerID: 'anthropic', modelID: 'opus-4.5' }}
        onChange={vi.fn()}
        allowAgentSdkSelection
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('model-provider-filter')).toHaveTextContent('Claude Code')
    })
  })

  test('does not render the provider filter without agent SDK selection', async () => {
    render(
      <ModelSelector
        value={{ agentSdk: 'codex', providerID: 'codex', modelID: 'gpt-5.5' }}
        onChange={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(apiMocks.opencodeApi.listModels).toHaveBeenCalled()
    })

    expect(screen.queryByTestId('model-provider-filter')).not.toBeInTheDocument()
  })
})
