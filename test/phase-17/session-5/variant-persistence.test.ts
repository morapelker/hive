import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import React from 'react'
import { useSettingsStore } from '../../../src/renderer/src/stores/useSettingsStore'

// ---------------------------------------------------------------------------
// Variant persistence tests
// ---------------------------------------------------------------------------
describe('Session 5: Variant Persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()

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

    // Reset store state
    useSettingsStore.setState({
      selectedModel: null,
      modelVariantDefaults: {},
      favoriteModels: [],
      isLoading: false
    })
  })

  afterEach(() => {
    cleanup()
  })

  const mockProviders = [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: {
        'claude-opus-4-5-20251101': {
          id: 'claude-opus-4-5-20251101',
          name: 'Claude Opus 4.5',
          variants: {
            high: { thinking: { budget_tokens: 16000 } },
            max: { thinking: { budget_tokens: 31999 } }
          }
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

  // ---------------------------------------------------------------------------
  // Store-level tests
  // ---------------------------------------------------------------------------
  describe('useSettingsStore modelVariantDefaults', () => {
    test('setModelVariantDefault stores variant for model key', () => {
      const store = useSettingsStore.getState()
      store.setModelVariantDefault('anthropic', 'claude-opus-4-5-20251101', 'high')
      expect(
        useSettingsStore.getState().getModelVariantDefault('anthropic', 'claude-opus-4-5-20251101')
      ).toBe('high')
    })

    test('getModelVariantDefault returns undefined for unknown model', () => {
      expect(useSettingsStore.getState().getModelVariantDefault('x', 'y')).toBeUndefined()
    })

    test('setModelVariantDefault overwrites previous variant for same model', () => {
      const store = useSettingsStore.getState()
      store.setModelVariantDefault('anthropic', 'claude-opus-4-5-20251101', 'high')
      store.setModelVariantDefault('anthropic', 'claude-opus-4-5-20251101', 'max')
      expect(
        useSettingsStore.getState().getModelVariantDefault('anthropic', 'claude-opus-4-5-20251101')
      ).toBe('max')
    })

    test('setModelVariantDefault preserves variants for other models', () => {
      const store = useSettingsStore.getState()
      store.setModelVariantDefault('anthropic', 'claude-opus-4-5-20251101', 'high')
      store.setModelVariantDefault('openai', 'gpt-4o', 'standard')
      expect(
        useSettingsStore.getState().getModelVariantDefault('anthropic', 'claude-opus-4-5-20251101')
      ).toBe('high')
      expect(useSettingsStore.getState().getModelVariantDefault('openai', 'gpt-4o')).toBe(
        'standard'
      )
    })

    test('setModelVariantDefault persists to database via saveToDatabase', () => {
      const store = useSettingsStore.getState()
      store.setModelVariantDefault('anthropic', 'claude-opus-4-5-20251101', 'high')
      // saveToDatabase calls window.db.setting.set
      expect(window.db.setting.set).toHaveBeenCalled()
      const callArgs = (window.db.setting.set as ReturnType<typeof vi.fn>).mock.calls
      const lastCall = callArgs[callArgs.length - 1]
      const savedSettings = JSON.parse(lastCall[1])
      expect(savedSettings.modelVariantDefaults).toEqual({
        'anthropic::claude-opus-4-5-20251101': 'high'
      })
    })

    test('modelVariantDefaults defaults to empty object', () => {
      expect(useSettingsStore.getState().modelVariantDefaults).toEqual({})
    })

    test('modelVariantDefaults is included in extractSettings output', () => {
      const store = useSettingsStore.getState()
      store.setModelVariantDefault('anthropic', 'claude-opus-4-5-20251101', 'max')
      // Verify the saved JSON includes modelVariantDefaults
      const callArgs = (window.db.setting.set as ReturnType<typeof vi.fn>).mock.calls
      const lastCall = callArgs[callArgs.length - 1]
      const savedSettings = JSON.parse(lastCall[1])
      expect(savedSettings).toHaveProperty('modelVariantDefaults')
      expect(savedSettings.modelVariantDefaults['anthropic::claude-opus-4-5-20251101']).toBe('max')
    })

    test('multiple models can each have their own remembered variant', () => {
      const store = useSettingsStore.getState()
      store.setModelVariantDefault('anthropic', 'claude-opus-4-5-20251101', 'max')
      store.setModelVariantDefault('anthropic', 'claude-haiku-4-5-20251001', 'low')

      const state = useSettingsStore.getState()
      expect(state.getModelVariantDefault('anthropic', 'claude-opus-4-5-20251101')).toBe('max')
      expect(state.getModelVariantDefault('anthropic', 'claude-haiku-4-5-20251001')).toBe('low')
    })
  })

  // ---------------------------------------------------------------------------
  // ModelSelector integration tests (via Alt+T / custom events that work in jsdom)
  // ---------------------------------------------------------------------------
  describe('ModelSelector variant persistence via Alt+T', () => {
    test('Alt+T cycling persists the variant choice', async () => {
      useSettingsStore.setState({
        selectedModel: {
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5-20251101',
          variant: 'high'
        }
      })

      const { ModelSelector } =
        await import('../../../src/renderer/src/components/sessions/ModelSelector')

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull()
      })

      // Cycle variant via Alt+T event
      await act(async () => {
        window.dispatchEvent(new CustomEvent('hive:cycle-variant'))
      })

      // Verify it cycled to 'max' and persisted
      const state = useSettingsStore.getState()
      expect(state.selectedModel?.variant).toBe('max')
      expect(state.getModelVariantDefault('anthropic', 'claude-opus-4-5-20251101')).toBe('max')
    })

    test('Alt+T cycling wraps and persists', async () => {
      useSettingsStore.setState({
        selectedModel: {
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5-20251101',
          variant: 'max'
        }
      })

      const { ModelSelector } =
        await import('../../../src/renderer/src/components/sessions/ModelSelector')

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull()
      })

      await act(async () => {
        window.dispatchEvent(new CustomEvent('hive:cycle-variant'))
      })

      // Should wrap to 'high' and persist
      const state = useSettingsStore.getState()
      expect(state.selectedModel?.variant).toBe('high')
      expect(state.getModelVariantDefault('anthropic', 'claude-opus-4-5-20251101')).toBe('high')
    })

    test('Alt+T on model without variants does not persist anything', async () => {
      useSettingsStore.setState({
        selectedModel: { providerID: 'openai', modelID: 'gpt-4o' }
      })

      const { ModelSelector } =
        await import('../../../src/renderer/src/components/sessions/ModelSelector')

      await act(async () => {
        render(React.createElement(ModelSelector))
      })

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull()
      })

      await act(async () => {
        window.dispatchEvent(new CustomEvent('hive:cycle-variant'))
      })

      // No variant set, no defaults persisted
      const state = useSettingsStore.getState()
      expect(state.selectedModel?.variant).toBeUndefined()
      expect(state.modelVariantDefaults).toEqual({})
    })
  })

  // ---------------------------------------------------------------------------
  // Variant selection logic tests (testing the logic directly via store)
  // ---------------------------------------------------------------------------
  describe('Variant selection logic', () => {
    test('remembered variant is used when valid', () => {
      // Simulate what handleSelectModel does internally
      useSettingsStore
        .getState()
        .setModelVariantDefault('anthropic', 'claude-opus-4-5-20251101', 'max')

      const remembered = useSettingsStore
        .getState()
        .getModelVariantDefault('anthropic', 'claude-opus-4-5-20251101')
      const variantKeys = ['high', 'max']

      const variant =
        remembered && variantKeys.includes(remembered)
          ? remembered
          : variantKeys.length > 0
            ? variantKeys[0]
            : undefined

      expect(variant).toBe('max')
    })

    test('falls back to first variant when remembered is invalid', () => {
      useSettingsStore
        .getState()
        .setModelVariantDefault('anthropic', 'claude-opus-4-5-20251101', 'deleted')

      const remembered = useSettingsStore
        .getState()
        .getModelVariantDefault('anthropic', 'claude-opus-4-5-20251101')
      const variantKeys = ['high', 'max']

      const variant =
        remembered && variantKeys.includes(remembered)
          ? remembered
          : variantKeys.length > 0
            ? variantKeys[0]
            : undefined

      expect(variant).toBe('high')
    })

    test('returns undefined for model without variants and no remembered', () => {
      const remembered = useSettingsStore.getState().getModelVariantDefault('openai', 'gpt-4o')
      const variantKeys: string[] = []

      const variant =
        remembered && variantKeys.includes(remembered)
          ? remembered
          : variantKeys.length > 0
            ? variantKeys[0]
            : undefined

      expect(variant).toBeUndefined()
    })

    test('returns first variant when no remembered default exists', () => {
      const remembered = useSettingsStore
        .getState()
        .getModelVariantDefault('anthropic', 'claude-opus-4-5-20251101')
      const variantKeys = ['high', 'max']

      const variant =
        remembered && variantKeys.includes(remembered)
          ? remembered
          : variantKeys.length > 0
            ? variantKeys[0]
            : undefined

      expect(variant).toBe('high')
    })
  })
})
