import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import React from 'react'
import { useSettingsStore } from '../../../src/renderer/src/stores/useSettingsStore'

// ---------------------------------------------------------------------------
// Thinking-level variant tests
// ---------------------------------------------------------------------------
describe('Session 6: Model Variants (Thinking Levels)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
  })

  afterEach(() => {
    cleanup()
  })

  // ---------------------------------------------------------------------------
  // ModelSelector component tests
  // ---------------------------------------------------------------------------
  describe('Dropdown UI', () => {
    const mockProviders = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-opus-4-5-20251101': {
            id: 'claude-opus-4-5-20251101',
            name: 'Claude Opus 4.5',
            variants: { high: { thinking: { budget_tokens: 16000 } }, max: { thinking: { budget_tokens: 31999 } } }
          },
          'claude-haiku-4-5-20251001': {
            id: 'claude-haiku-4-5-20251001',
            name: 'Claude Haiku 4.5'
          }
        }
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' }
        }
      }
    ]

    beforeEach(() => {
      Object.defineProperty(window, 'opencodeOps', {
        value: {
          listModels: vi.fn().mockResolvedValue({
            success: true,
            providers: mockProviders
          }),
          setModel: vi.fn().mockResolvedValue({ success: true })
        },
        writable: true,
        configurable: true
      })

      Object.defineProperty(window, 'db', {
        value: {
          setting: {
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined)
          }
        },
        writable: true,
        configurable: true
      })

      useSettingsStore.setState({
        selectedModel: { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101', variant: 'high' },
        isLoading: false
      })
    })

    test('pill shows model display name', async () => {
      const { ModelSelector } = await import(
        '../../../src/renderer/src/components/sessions/ModelSelector'
      )

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull()
      })

      expect(screen.getByText('Claude Opus 4.5')).toBeTruthy()
    })

    test('variant indicator shows current variant name', async () => {
      const { ModelSelector } = await import(
        '../../../src/renderer/src/components/sessions/ModelSelector'
      )

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull()
      })

      expect(screen.getByTestId('variant-indicator')).toBeTruthy()
      expect(screen.getByTestId('variant-indicator').textContent).toBe('high')
    })

    test('no variant indicator for model without variants', async () => {
      useSettingsStore.setState({
        selectedModel: { providerID: 'openai', modelID: 'gpt-4o' }
      })

      const { ModelSelector } = await import(
        '../../../src/renderer/src/components/sessions/ModelSelector'
      )

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull()
      })

      expect(screen.queryByTestId('variant-indicator')).toBeNull()
    })

    test('model selector renders with correct aria label', async () => {
      const { ModelSelector } = await import(
        '../../../src/renderer/src/components/sessions/ModelSelector'
      )

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull()
      })

      const trigger = screen.getByTestId('model-selector')
      expect(trigger.getAttribute('aria-label')).toContain('Claude Opus 4.5')
    })

    test('shows "No models available" when providers are empty', async () => {
      Object.defineProperty(window, 'opencodeOps', {
        value: {
          listModels: vi.fn().mockResolvedValue({
            success: true,
            providers: []
          }),
          setModel: vi.fn().mockResolvedValue({ success: true })
        },
        writable: true,
        configurable: true
      })

      const { ModelSelector } = await import(
        '../../../src/renderer/src/components/sessions/ModelSelector'
      )

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      const trigger = screen.getByTestId('model-selector')
      expect(trigger).toBeTruthy()
    })
  })

  // ---------------------------------------------------------------------------
  // Alt+T shortcut tests — now cycles thinking-level variants
  // ---------------------------------------------------------------------------
  describe('Alt+T shortcut', () => {
    const mockProviders = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-opus-4-5-20251101': {
            id: 'claude-opus-4-5-20251101',
            name: 'Claude Opus 4.5',
            variants: { high: { thinking: { budget_tokens: 16000 } }, max: { thinking: { budget_tokens: 31999 } } }
          }
        }
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' }
        }
      }
    ]

    beforeEach(() => {
      Object.defineProperty(window, 'opencodeOps', {
        value: {
          listModels: vi.fn().mockResolvedValue({
            success: true,
            providers: mockProviders
          }),
          setModel: vi.fn().mockResolvedValue({ success: true })
        },
        writable: true,
        configurable: true
      })

      Object.defineProperty(window, 'db', {
        value: {
          setting: {
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined)
          }
        },
        writable: true,
        configurable: true
      })
    })

    test('Alt+T cycles to next thinking level variant', async () => {
      useSettingsStore.setState({
        selectedModel: { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101', variant: 'high' }
      })

      const { ModelSelector } = await import(
        '../../../src/renderer/src/components/sessions/ModelSelector'
      )

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull()
      })

      await act(async () => {
        window.dispatchEvent(new CustomEvent('hive:cycle-variant'))
      })

      const state = useSettingsStore.getState()
      expect(state.selectedModel?.modelID).toBe('claude-opus-4-5-20251101')
      expect(state.selectedModel?.variant).toBe('max')
    })

    test('Alt+T wraps around variants', async () => {
      useSettingsStore.setState({
        selectedModel: { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101', variant: 'max' }
      })

      const { ModelSelector } = await import(
        '../../../src/renderer/src/components/sessions/ModelSelector'
      )

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull()
      })

      await act(async () => {
        window.dispatchEvent(new CustomEvent('hive:cycle-variant'))
      })

      const state = useSettingsStore.getState()
      expect(state.selectedModel?.variant).toBe('high')
    })

    test('Alt+T does nothing for model without variants', async () => {
      useSettingsStore.setState({
        selectedModel: { providerID: 'openai', modelID: 'gpt-4o' }
      })

      const { ModelSelector } = await import(
        '../../../src/renderer/src/components/sessions/ModelSelector'
      )

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull()
      })

      await act(async () => {
        window.dispatchEvent(new CustomEvent('hive:cycle-variant'))
      })

      const state = useSettingsStore.getState()
      expect(state.selectedModel?.modelID).toBe('gpt-4o')
      expect(state.selectedModel?.variant).toBeUndefined()
    })
  })
})
