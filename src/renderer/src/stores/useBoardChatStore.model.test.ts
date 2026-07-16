import { describe, expect, it } from 'vitest'
import { resolveBoardChatDefaultModel } from './useBoardChatStore'
import type { SelectedModel } from '@/stores/useSettingsStore'

type Settings = Parameters<typeof resolveBoardChatDefaultModel>[0]

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultAgentSdk: 'opencode',
    selectedModel: null,
    selectedModelByProvider: {},
    getModelForMode: () => null,
    ...overrides
  }
}

describe('resolveBoardChatDefaultModel grok provenance', () => {
  it('trusts an unstamped xAI model selected FOR opencode in the per-SDK map', () => {
    // OpenCode's own catalog can expose xAI models; the per-SDK entry is
    // stored without an agentSdk stamp but its map slot IS its provenance.
    const xai: SelectedModel = { providerID: 'xai', modelID: 'grok-4.5' }
    const model = resolveBoardChatDefaultModel(
      makeSettings({ selectedModelByProvider: { opencode: xai } })
    )
    expect(model).toEqual(xai)
  })

  it('still drops an unstamped grok model from the legacy global selectedModel', () => {
    // With an empty per-SDK map, resolveModelForSdk falls back to the legacy
    // global — ambiguous provenance, so grok-family models are skipped.
    const model = resolveBoardChatDefaultModel(
      makeSettings({ selectedModel: { providerID: 'xai', modelID: 'grok-4.5' } })
    )
    expect(model).toBeNull()
  })

  it('drops a grok-cli-stamped model even from the per-SDK map', () => {
    // An explicit grok-cli stamp beats per-SDK trust: the streaming
    // implementers cannot serve a grok-cli session.
    const model = resolveBoardChatDefaultModel(
      makeSettings({
        selectedModelByProvider: {
          opencode: { providerID: 'xai', modelID: 'grok-4.5', agentSdk: 'grok-cli' }
        }
      })
    )
    expect(model).toBeNull()
  })

  it('prefers a usable ask-mode default over the per-SDK entry', () => {
    const askDefault: SelectedModel = {
      providerID: 'anthropic',
      modelID: 'claude-opus-4-5-20251101',
      agentSdk: 'opencode'
    }
    const model = resolveBoardChatDefaultModel(
      makeSettings({
        getModelForMode: () => askDefault,
        selectedModelByProvider: { opencode: { providerID: 'xai', modelID: 'grok-4.5' } }
      })
    )
    expect(model).toEqual(askDefault)
  })

  it('restamps claude-code-cli models to claude-code', () => {
    const model = resolveBoardChatDefaultModel(
      makeSettings({
        defaultAgentSdk: 'claude-code-cli',
        selectedModelByProvider: {
          'claude-code': { providerID: 'anthropic', modelID: 'sonnet', agentSdk: 'claude-code-cli' }
        }
      })
    )
    expect(model).toEqual({ providerID: 'anthropic', modelID: 'sonnet', agentSdk: 'claude-code' })
  })
})
