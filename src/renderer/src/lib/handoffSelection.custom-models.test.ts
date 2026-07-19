import { beforeEach, describe, expect, it } from 'vitest'

import {
  getEffectiveHandoffSelection,
  resolveCustomProviderSelectedModel
} from '@/lib/handoffSelection'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { CustomClaudeProvider } from '@shared/types/custom-provider'

const initialSettingsState = useSettingsStore.getState()

// Second model's slug deliberately collides with a stock alias name: a legacy
// override's stock stamp must never accidentally "pick" it.
const provider: CustomClaudeProvider = {
  id: 'p1',
  name: 'Proxy',
  command: 'claudex',
  usageProvider: 'none',
  models: [
    { id: 'm1', name: 'GLM 4.6', slug: 'glm-4.6', efforts: ['low', 'high'] },
    { id: 'm2', name: 'Proxy Sonnet', slug: 'sonnet', efforts: ['high'] }
  ]
}

describe('custom provider model resolution vs legacy stock stamps', () => {
  beforeEach(() => {
    useSettingsStore.setState(initialSettingsState, true)
  })

  it('ignores a legacy handoff override whose stock modelID collides with a declared slug', () => {
    useSettingsStore.setState({
      customProviders: [provider],
      lastHandoffOverride: {
        agentSdk: 'claude-code-cli',
        customProviderId: 'p1',
        providerID: 'anthropic',
        modelID: 'sonnet',
        variant: 'high'
      }
    })

    const effective = getEffectiveHandoffSelection({})
    // Degrades to the provider default (first declared model), not 'sonnet'.
    expect(effective.customProviderId).toBe('p1')
    expect(effective.model).toEqual({ providerID: 'custom', modelID: 'glm-4.6', variant: 'low' })
    expect(effective.display.modelName).toBe('GLM 4.6')
  })

  it('honors an override that already carries the custom marker', () => {
    useSettingsStore.setState({
      customProviders: [provider],
      lastHandoffOverride: {
        agentSdk: 'claude-code-cli',
        customProviderId: 'p1',
        providerID: 'custom',
        modelID: 'sonnet',
        variant: 'high'
      }
    })

    const effective = getEffectiveHandoffSelection({})
    expect(effective.model).toEqual({ providerID: 'custom', modelID: 'sonnet', variant: 'high' })
    expect(effective.display.modelName).toBe('Proxy Sonnet')
  })

  it('resolveCustomProviderSelectedModel treats non-custom candidates as no pick', () => {
    expect(
      resolveCustomProviderSelectedModel(provider, {
        providerID: 'anthropic',
        modelID: 'sonnet',
        variant: 'high'
      })
    ).toEqual({ providerID: 'custom', modelID: 'glm-4.6', variant: 'low' })

    expect(
      resolveCustomProviderSelectedModel(provider, {
        providerID: 'custom',
        modelID: 'sonnet',
        variant: 'high'
      })
    ).toEqual({ providerID: 'custom', modelID: 'sonnet', variant: 'high' })
  })
})
