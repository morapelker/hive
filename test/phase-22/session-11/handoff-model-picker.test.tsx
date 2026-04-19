import { beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockSettingsDb = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined)
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
        return { success: true, providers: codexProviders }
      }

      return { success: true, providers: claudeProviders }
    })
  }
})

import {
  cacheHandoffModelCatalog,
  clearHandoffModelCatalogCache,
  getEffectiveHandoffSelection
} from '@/lib/handoffSelection'
import { HandoffSplitButton } from '@/components/sessions/HandoffSplitButton'
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
          modelID: 'gpt-5.4',
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
        ask: null
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
        modelID: 'gpt-5.4',
        variant: 'xhigh'
      }
    })

    const effective = getEffectiveHandoffSelection({})

    expect(effective.agentSdk).toBe('codex')
    expect(effective.model).toEqual({
      providerID: 'codex',
      modelID: 'gpt-5.4',
      variant: 'xhigh'
    })
    expect(effective.display).toEqual({
      sdkName: 'Codex',
      modelName: 'GPT-5.4',
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
        modelID: 'gpt-5.4',
        variant: 'xhigh'
      })
    })

    await waitFor(() => {
      expect(handoffButton).toHaveTextContent('Codex /')
      expect(handoffButton).toHaveTextContent('GPT-5.4')
      expect(handoffButton).toHaveTextContent('xhigh')
    })
  })

  test('single-sdk rendering hides the chevron control', async () => {
    cacheHandoffModelCatalog('claude-code', claudeProviders)
    useSettingsStore.setState({
      availableAgentSdks: {
        opencode: false,
        claude: true,
        codex: false
      }
    })

    render(<HandoffSplitButton onHandoff={vi.fn()} testIdPrefix="plan-ready" />)

    await waitFor(() => {
      expect(screen.queryByTestId('plan-ready-handoff-chevron')).not.toBeInTheDocument()
    })
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
        'GPT-5.4'
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
        'GPT-5.4'
      )
    })

    await user.click(screen.getByRole('button', { name: 'Handoff' }))

    await waitFor(() => {
      expect(useSettingsStore.getState().lastHandoffOverride).toEqual({
        agentSdk: 'codex',
        providerID: 'codex',
        modelID: 'gpt-5.4',
        variant: 'high'
      })
    })
    expect(onHandoff).toHaveBeenCalledWith({
      agentSdk: 'codex',
      model: {
        providerID: 'codex',
        modelID: 'gpt-5.4',
        variant: 'high'
      }
    })
  })
})
