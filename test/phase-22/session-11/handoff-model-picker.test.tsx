import { beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockSettingsDb = {
  get: vi.fn().mockResolvedValue({ success: true, value: null }),
  set: vi.fn().mockResolvedValue({ success: true, value: undefined })
}

const claudeProviders = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'sonnet-4.6': {
        id: 'sonnet-4.6',
        name: 'Sonnet 4.6',
        variants: {
          high: {},
          xhigh: {}
        }
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
        name: 'GPT-5.5',
        variants: {
          high: {},
          xhigh: {}
        }
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        variants: {
          high: {},
          xhigh: {}
        }
      },
      'gpt-5.4-mini': {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 Mini'
      }
    }
  }
]

Object.defineProperty(window, 'db', {
  writable: true,
  configurable: true,
  value: {
    setting: mockSettingsDb
  }
})

Object.defineProperty(window, 'systemOps', {
  writable: true,
  configurable: true,
  value: {
    detectAgentSdks: vi.fn().mockResolvedValue({
      opencode: true,
      claude: true,
      codex: true
    })
  }
})

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  configurable: true,
  value: {
    listModels: vi.fn().mockImplementation(async ({ agentSdk }: { agentSdk?: string } = {}) => {
      if (agentSdk === 'codex') {
        return { success: true, value: { success: true, providers: codexProviders } }
      }

      return { success: true, value: { success: true, providers: claudeProviders } }
    })
  }
})

import {
  cacheHandoffModelCatalog,
  clearHandoffModelCatalogCache,
  getEffectiveHandoffSelection,
  resolveSessionCreationSelection
} from '@/lib/handoffSelection'
import { HandoffSplitButton } from '@/components/sessions/HandoffSplitButton'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

describe('handoff model picker', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    clearHandoffModelCatalogCache()
    localStorage.clear()

    useSettingsStore.setState({
      selectedModel: null,
      selectedModelByProvider: {
        'claude-code': {
          providerID: 'anthropic',
          modelID: 'sonnet-4.6',
          variant: 'high'
        },
        codex: {
          providerID: 'codex',
          modelID: 'gpt-5.5',
          variant: 'high'
        }
      },
      defaultModels: {
        build: {
          providerID: 'anthropic',
          modelID: 'sonnet-4.6',
          variant: 'high'
        },
        plan: null,
        ask: null,
        review: null
      },
      lastHandoffOverride: null,
      defaultAgentSdk: 'claude-code',
      availableAgentSdks: {
        opencode: true,
        claude: true,
        codex: true
      }
    })
    useWorktreeStore.setState({
      worktreesByProject: new Map()
    })
  })

  test('getEffectiveHandoffSelection returns the override when it is valid', () => {
    cacheHandoffModelCatalog('codex', codexProviders)
    useSettingsStore.setState({
      lastHandoffOverride: {
        agentSdk: 'codex',
        providerID: 'codex',
        modelID: 'gpt-5.5',
        variant: 'xhigh'
      }
    })

    const effective = getEffectiveHandoffSelection({})

    expect(effective.agentSdk).toBe('codex')
    expect(effective.model).toEqual({
      providerID: 'codex',
      modelID: 'gpt-5.5',
      variant: 'xhigh'
    })
    expect(effective.display).toEqual({
      sdkName: 'Codex',
      modelName: 'GPT-5.5',
      variant: 'xhigh'
    })
  })

  test('getEffectiveHandoffSelection falls back to the default when the override is stale', () => {
    cacheHandoffModelCatalog('codex', codexProviders)
    cacheHandoffModelCatalog('claude-code', claudeProviders)
    useSettingsStore.setState({
      lastHandoffOverride: {
        agentSdk: 'codex',
        providerID: 'codex',
        modelID: 'missing-model',
        variant: 'high'
      }
    })

    const effective = getEffectiveHandoffSelection({})

    expect(effective.agentSdk).toBe('claude-code')
    expect(effective.model).toEqual({
      providerID: 'anthropic',
      modelID: 'sonnet-4.6',
      variant: 'high'
    })
    expect(effective.display.modelName).toBe('Sonnet 4.6')
  })

  test('resolveSessionCreationSelection uses a mode default from a different SDK', () => {
    cacheHandoffModelCatalog('codex', codexProviders)
    useSettingsStore.setState({
      defaultAgentSdk: 'claude-code',
      defaultModels: {
        build: {
          agentSdk: 'codex',
          providerID: 'codex',
          modelID: 'gpt-5.5',
          variant: 'xhigh'
        },
        plan: null,
        ask: null,
        review: null
      }
    })

    const selection = resolveSessionCreationSelection({ initialMode: 'build' })

    expect(selection).toEqual({
      agentSdk: 'codex',
      model: {
        agentSdk: 'codex',
        providerID: 'codex',
        modelID: 'gpt-5.5',
        variant: 'xhigh'
      }
    })
  })

  test('resolveSessionCreationSelection keeps an explicit SDK when the mode default uses another SDK', () => {
    cacheHandoffModelCatalog('codex', codexProviders)
    useSettingsStore.setState({
      defaultAgentSdk: 'claude-code',
      defaultModels: {
        build: {
          agentSdk: 'claude-code',
          providerID: 'anthropic',
          modelID: 'sonnet-4.6',
          variant: 'high'
        },
        plan: null,
        ask: null,
        review: null
      }
    })

    const selection = resolveSessionCreationSelection({
      agentSdkOverride: 'codex',
      initialMode: 'build'
    })

    expect(selection).toEqual({
      agentSdk: 'codex',
      model: {
        providerID: 'codex',
        modelID: 'gpt-5.5',
        variant: 'high'
      }
    })
  })

  test('controlled model selector can choose a model from another SDK catalog', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()

    render(<ModelSelector value={null} onChange={onChange} allowAgentSdkSelection />)

    await waitFor(() => {
      expect(window.opencodeOps.listModels).toHaveBeenCalledWith({ agentSdk: 'claude-code' })
      expect(window.opencodeOps.listModels).toHaveBeenCalledWith({ agentSdk: 'codex' })
    })

    await user.click(screen.getByTestId('model-selector'))
    await user.click(await screen.findByTestId('model-item-gpt-5.5'))

    expect(onChange).toHaveBeenCalledWith({
      agentSdk: 'codex',
      providerID: 'codex',
      modelID: 'gpt-5.5',
      variant: 'high'
    })
  })

  test('controlled model selector can filter models by SDK provider', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()

    render(<ModelSelector value={null} onChange={onChange} allowAgentSdkSelection />)

    await waitFor(() => {
      expect(window.opencodeOps.listModels).toHaveBeenCalledWith({ agentSdk: 'claude-code' })
      expect(window.opencodeOps.listModels).toHaveBeenCalledWith({ agentSdk: 'codex' })
    })

    await user.click(await screen.findByTestId('model-provider-filter'))
    expect(await screen.findByTestId('model-provider-filter-option-claude-code')).toHaveTextContent(
      'Claude Code'
    )
    expect(screen.getByTestId('model-provider-filter-option-codex')).toHaveTextContent('Codex')
    expect(screen.queryByText('Claude Code / Anthropic')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('model-provider-filter-option-codex'))

    await user.click(screen.getByTestId('model-selector'))

    expect(await screen.findByTestId('model-item-gpt-5.5')).toBeInTheDocument()
    expect(screen.queryByTestId('model-item-sonnet-4.6')).not.toBeInTheDocument()
  })

  test('controlled model selector selects the remembered model when switching SDK provider', async () => {
    useSettingsStore.setState({
      selectedModelByProvider: {
        'claude-code': {
          providerID: 'anthropic',
          modelID: 'sonnet-4.6',
          variant: 'high'
        },
        codex: {
          providerID: 'codex',
          modelID: 'gpt-5.4',
          variant: 'xhigh'
        }
      }
    })
    const onChange = vi.fn()
    const user = userEvent.setup()

    render(<ModelSelector value={null} onChange={onChange} allowAgentSdkSelection />)

    await waitFor(() => {
      expect(window.opencodeOps.listModels).toHaveBeenCalledWith({ agentSdk: 'codex' })
    })

    await user.click(await screen.findByTestId('model-provider-filter'))
    await user.click(await screen.findByTestId('model-provider-filter-option-codex'))

    expect(onChange).toHaveBeenCalledWith({
      agentSdk: 'codex',
      providerID: 'codex',
      modelID: 'gpt-5.4',
      variant: 'xhigh'
    })
  })

  test('controlled model selector remembers the last model selected in the picker per SDK provider', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()

    render(<ModelSelector value={null} onChange={onChange} allowAgentSdkSelection />)

    await waitFor(() => {
      expect(window.opencodeOps.listModels).toHaveBeenCalledWith({ agentSdk: 'codex' })
    })

    await user.click(await screen.findByTestId('model-provider-filter'))
    await user.click(await screen.findByTestId('model-provider-filter-option-codex'))
    await user.click(screen.getByTestId('model-selector'))
    await user.click(await screen.findByTestId('model-item-gpt-5.4'))

    await user.click(screen.getByTestId('model-provider-filter'))
    await user.click(await screen.findByTestId('model-provider-filter-option-claude-code'))

    await user.click(screen.getByTestId('model-provider-filter'))
    await user.click(await screen.findByTestId('model-provider-filter-option-codex'))

    expect(onChange).toHaveBeenLastCalledWith({
      agentSdk: 'codex',
      providerID: 'codex',
      modelID: 'gpt-5.4',
      variant: 'high'
    })
  })

  test('controlled model selector keeps provider filter when Claude legacy and CLI are available', async () => {
    useSettingsStore.setState({
      availableAgentSdks: {
        opencode: false,
        claude: true,
        codex: false
      }
    })

    render(<ModelSelector value={null} onChange={vi.fn()} allowAgentSdkSelection />)

    await waitFor(() => {
      expect(window.opencodeOps.listModels).toHaveBeenCalledWith({ agentSdk: 'claude-code' })
    })

    expect(screen.getByTestId('model-provider-filter')).toBeInTheDocument()
  })

  test('button label rerenders when lastHandoffOverride changes', async () => {
    cacheHandoffModelCatalog('claude-code', claudeProviders)
    cacheHandoffModelCatalog('codex', codexProviders)

    render(<HandoffSplitButton onHandoff={vi.fn()} testIdPrefix="plan-ready" />)

    const handoffButton = await screen.findByTestId('plan-ready-handoff-fab')
    expect(handoffButton).toHaveTextContent('Claude Code /')
    expect(handoffButton).toHaveTextContent('Sonnet 4.6')

    act(() => {
      useSettingsStore.getState().setLastHandoffOverride({
        agentSdk: 'codex',
        providerID: 'codex',
        modelID: 'gpt-5.5',
        variant: 'xhigh'
      })
    })

    await waitFor(() => {
      expect(handoffButton).toHaveTextContent('Codex /')
      expect(handoffButton).toHaveTextContent('GPT-5.5')
      expect(handoffButton).toHaveTextContent('xhigh')
    })
  })

  test('Claude-only rendering keeps the chevron for legacy and CLI choices', async () => {
    cacheHandoffModelCatalog('claude-code', claudeProviders)
    useSettingsStore.setState({
      availableAgentSdks: {
        opencode: false,
        claude: true,
        codex: false
      }
    })

    render(<HandoffSplitButton onHandoff={vi.fn()} testIdPrefix="plan-ready" />)

    expect(await screen.findByTestId('plan-ready-handoff-chevron')).toBeInTheDocument()
  })

  test('picker only persists on confirm and switching SDK resets the model selection', async () => {
    cacheHandoffModelCatalog('claude-code', claudeProviders)
    cacheHandoffModelCatalog('codex', codexProviders)
    const onHandoff = vi.fn()
    const user = userEvent.setup()

    render(<HandoffSplitButton onHandoff={onHandoff} testIdPrefix="plan-ready" />)

    await user.click(await screen.findByTestId('plan-ready-handoff-chevron'))
    expect(await screen.findByRole('button', { name: 'Select handoff model' })).toHaveTextContent(
      'Sonnet 4.6'
    )

    await user.click(screen.getByRole('button', { name: 'Select handoff SDK' }))
    await user.click(await screen.findByText('Codex'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select handoff model' })).toHaveTextContent(
        'GPT-5.5'
      )
    })

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Select handoff model' })).not.toBeInTheDocument()
    })
    expect(useSettingsStore.getState().lastHandoffOverride).toBeNull()

    await user.click(screen.getByTestId('plan-ready-handoff-chevron'))
    expect(await screen.findByRole('button', { name: 'Select handoff model' })).toHaveTextContent(
      'Sonnet 4.6'
    )

    await user.click(screen.getByRole('button', { name: 'Select handoff SDK' }))
    await user.click(await screen.findByText('Codex'))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select handoff model' })).toHaveTextContent(
        'GPT-5.5'
      )
    })

    await user.click(screen.getByRole('button', { name: 'Handoff' }))

    await waitFor(() => {
      expect(useSettingsStore.getState().lastHandoffOverride).toEqual({
        agentSdk: 'codex',
        providerID: 'codex',
        modelID: 'gpt-5.5',
        variant: 'high'
      })
    })
    expect(onHandoff).toHaveBeenCalledWith({
      agentSdk: 'codex',
      goalMode: false,
      model: {
        providerID: 'codex',
        modelID: 'gpt-5.5',
        variant: 'high'
      }
    })
  })
})
