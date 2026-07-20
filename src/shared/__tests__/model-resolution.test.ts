import { describe, expect, it } from 'vitest'
import {
  FALLBACK_MODELS,
  getModeDefaultKey,
  normalizeAgentSdk,
  resolveModelForSdk,
  resolveSessionCreation,
  type ModelResolutionSettings
} from '../model-resolution'

describe('model-resolution', () => {
  it('maps session modes to mode default keys', () => {
    expect(getModeDefaultKey('plan')).toBe('plan')
    expect(getModeDefaultKey('super-plan')).toBe('plan')
    expect(getModeDefaultKey('ask')).toBe('ask')
    expect(getModeDefaultKey('review')).toBe('review')
    expect(getModeDefaultKey('build')).toBe('build')
    expect(getModeDefaultKey(undefined)).toBe('build')
  })

  it('normalizes handoff SDKs for session creation', () => {
    expect(normalizeAgentSdk('opencode')).toBe('opencode')
    expect(normalizeAgentSdk('claude-code')).toBe('claude-code')
    expect(normalizeAgentSdk('claude-code-cli')).toBe('claude-code-cli')
    expect(normalizeAgentSdk('codex')).toBe('codex')
    expect(normalizeAgentSdk('terminal')).toBe('opencode')
    expect(normalizeAgentSdk('unknown')).toBe('opencode')
    expect(normalizeAgentSdk(null)).toBe('opencode')
  })

  it('uses an untagged mode default without changing SDK', () => {
    const settings: ModelResolutionSettings = {
      defaultAgentSdk: 'opencode',
      defaultModels: {
        plan: { providerID: 'anthropic', modelID: 'plan-opus' }
      }
    }

    expect(resolveSessionCreation({ settings, mode: 'plan' })).toEqual({
      agentSdk: 'opencode',
      model: { providerID: 'anthropic', modelID: 'plan-opus' }
    })
  })

  it('uses an opencode-tagged mode default without changing SDK', () => {
    const settings: ModelResolutionSettings = {
      defaultAgentSdk: 'opencode',
      defaultModels: {
        build: { providerID: 'openai', modelID: 'gpt-5.5', agentSdk: 'opencode' }
      }
    }

    expect(resolveSessionCreation({ settings, mode: 'build' })).toEqual({
      agentSdk: 'opencode',
      model: { providerID: 'openai', modelID: 'gpt-5.5', agentSdk: 'opencode' }
    })
  })

  it('switches SDK when a mode default is tagged for another SDK', () => {
    const settings: ModelResolutionSettings = {
      defaultAgentSdk: 'opencode',
      defaultModels: {
        plan: {
          providerID: 'anthropic',
          modelID: 'sonnet',
          variant: 'high',
          agentSdk: 'claude-code-cli'
        }
      }
    }

    expect(resolveSessionCreation({ settings, mode: 'super-plan' })).toEqual({
      agentSdk: 'claude-code-cli',
      model: {
        providerID: 'anthropic',
        modelID: 'sonnet',
        variant: 'high',
        agentSdk: 'claude-code-cli'
      }
    })
  })

  it('prefers per-SDK selected model over legacy selected model', () => {
    const settings: ModelResolutionSettings = {
      defaultAgentSdk: 'codex',
      selectedModel: { providerID: 'legacy', modelID: 'legacy-model' },
      selectedModelByProvider: {
        codex: { providerID: 'codex', modelID: 'gpt-5.5' }
      }
    }

    expect(resolveModelForSdk('codex', settings)).toEqual({
      providerID: 'codex',
      modelID: 'gpt-5.5'
    })
    expect(resolveSessionCreation({ settings, mode: 'build' })).toEqual({
      agentSdk: 'codex',
      model: { providerID: 'codex', modelID: 'gpt-5.5' }
    })
  })

  it('does not use legacy selected model when any per-SDK key exists for a different SDK', () => {
    const settings: ModelResolutionSettings = {
      defaultAgentSdk: 'claude-code',
      selectedModel: { providerID: 'legacy', modelID: 'legacy-model' },
      selectedModelByProvider: {
        opencode: { providerID: 'openai', modelID: 'gpt-5.5' }
      }
    }

    expect(resolveModelForSdk('claude-code', settings)).toBeNull()
    expect(resolveSessionCreation({ settings, mode: 'build' })).toEqual({
      agentSdk: 'claude-code',
      model: FALLBACK_MODELS['claude-code']
    })
  })

  it('uses legacy selected model when no per-SDK selections exist', () => {
    const settings: ModelResolutionSettings = {
      selectedModel: { providerID: 'legacy', modelID: 'legacy-model', variant: 'low' },
      selectedModelByProvider: {}
    }

    expect(resolveSessionCreation({ settings, mode: 'build' })).toEqual({
      agentSdk: 'opencode',
      model: { providerID: 'legacy', modelID: 'legacy-model', variant: 'low' }
    })
  })

  it('falls back to hardcoded SDK defaults when settings are empty', () => {
    expect(resolveSessionCreation({ settings: {}, mode: 'build' })).toEqual({
      agentSdk: 'opencode',
      model: FALLBACK_MODELS.opencode
    })
  })

  it('keeps grok sessions on grok-family models and vice versa', () => {
    // A foreign legacy global must not stamp a grok session…
    const foreignLegacy: ModelResolutionSettings = {
      defaultAgentSdk: 'grok-cli',
      selectedModel: { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' },
      selectedModelByProvider: {}
    }
    expect(resolveSessionCreation({ settings: foreignLegacy, mode: 'build' })).toEqual({
      agentSdk: 'grok-cli',
      model: FALLBACK_MODELS['grok-cli']
    })

    // …and an unstamped grok legacy global must not ride into another SDK
    // (e.g. the Discord fallback re-resolving for opencode).
    const grokLegacy: ModelResolutionSettings = {
      selectedModel: { providerID: 'xai', modelID: 'grok-4.5' },
      selectedModelByProvider: {}
    }
    expect(
      resolveSessionCreation({ settings: grokLegacy, mode: 'build', defaultAgentSdk: 'opencode' })
    ).toEqual({
      agentSdk: 'opencode',
      model: FALLBACK_MODELS.opencode
    })

    // An explicit non-grok stamp is trusted (OpenCode-catalog xAI model).
    const stampedXai: ModelResolutionSettings = {
      selectedModel: { providerID: 'xai', modelID: 'grok-4.5', agentSdk: 'opencode' },
      selectedModelByProvider: {}
    }
    expect(
      resolveSessionCreation({ settings: stampedXai, mode: 'build', defaultAgentSdk: 'opencode' })
        .model.modelID
    ).toBe('grok-4.5')

    // A per-SDK map entry is trusted provenance even when unstamped — the
    // user selected this xAI model FOR opencode from opencode's own catalog.
    const perSdkXai: ModelResolutionSettings = {
      selectedModelByProvider: {
        opencode: { providerID: 'xai', modelID: 'grok-4-fast' }
      }
    }
    expect(
      resolveSessionCreation({ settings: perSdkXai, mode: 'build', defaultAgentSdk: 'opencode' })
        .model.modelID
    ).toBe('grok-4-fast')
  })
})
