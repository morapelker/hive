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

const ok = <T,>(value: T) => ({ success: true as const, value })

const mockListModels = vi.fn().mockImplementation(async ({ agentSdk }: { agentSdk?: string } = {}) => {
  if (agentSdk === 'codex') {
    return ok({ success: true, providers: codexProviders })
  }

  return ok({ success: true, providers: claudeProviders })
})

import { ModelSelector } from '@/components/sessions/ModelSelector'
import { useSettingsStore } from '@/stores/useSettingsStore'

describe('ModelSelector provider filter pill', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mockListModels.mockImplementation(async ({ agentSdk }: { agentSdk?: string } = {}) => {
      if (agentSdk === 'codex') {
        return ok({ success: true, providers: codexProviders })
      }

      return ok({ success: true, providers: claudeProviders })
    })
    Object.defineProperty(window, 'opencodeOps', {
      writable: true,
      configurable: true,
      value: {
        listModels: mockListModels
      }
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

    await waitFor(() => {
      expect(screen.getByTestId('model-provider-filter')).toHaveTextContent('Codex')
    })

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
      expect(window.opencodeOps.listModels).toHaveBeenCalled()
    })

    expect(screen.queryByTestId('model-provider-filter')).not.toBeInTheDocument()
  })
})
