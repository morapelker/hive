import { describe, expect, it } from 'vitest'
import { FALLBACK_MODELS, normalizeAgentSdk, resolveModelForSdk } from './model-resolution'

describe('model-resolution: codex-cli', () => {
  it('normalizes codex-cli as a handoff SDK', () => {
    expect(normalizeAgentSdk('codex-cli')).toBe('codex-cli')
    expect(normalizeAgentSdk('terminal')).toBe('opencode')
    expect(FALLBACK_MODELS['codex-cli']).toMatchObject({ providerID: 'codex' })
  })

  it('inherits the codex model selection until codex-cli has its own', () => {
    const codexPick = { providerID: 'codex', modelID: 'gpt-6-astra', variant: 'high' }
    expect(
      resolveModelForSdk('codex-cli', { selectedModelByProvider: { codex: codexPick } })
    ).toEqual(codexPick)
    const own = { providerID: 'codex', modelID: 'gpt-6-luna', variant: 'medium' }
    expect(
      resolveModelForSdk('codex-cli', {
        selectedModelByProvider: { codex: codexPick, 'codex-cli': own }
      })
    ).toEqual(own)
    // Other providers' picks never leak into codex-cli.
    expect(
      resolveModelForSdk('codex-cli', {
        selectedModelByProvider: { 'claude-code': { providerID: 'anthropic', modelID: 'sonnet' } }
      })
    ).toBeNull()
  })

  it('applies a global default only to the SDK it was stamped for', () => {
    const globalPick = {
      providerID: 'codex',
      modelID: 'gpt-5.5',
      variant: 'high',
      agentSdk: 'codex'
    }
    const settings = {
      selectedModel: globalPick,
      selectedModelByProvider: { 'claude-code': { providerID: 'anthropic', modelID: 'sonnet' } }
    }
    expect(resolveModelForSdk('codex', settings)).toEqual(globalPick)
    // codex-cli shares codex's catalog, so it inherits a codex-stamped global too.
    expect(resolveModelForSdk('codex-cli', settings)).toEqual(globalPick)
    expect(resolveModelForSdk('opencode', settings)).toBeNull()
    expect(resolveModelForSdk('claude-code-cli', settings)).toBeNull()
  })

  it('prefers the provider default over a global default stamped for the same SDK', () => {
    const providerPick = { providerID: 'codex', modelID: 'gpt-6-luna', variant: 'medium' }
    expect(
      resolveModelForSdk('codex', {
        selectedModel: { providerID: 'codex', modelID: 'gpt-5.5', agentSdk: 'codex' },
        selectedModelByProvider: { codex: providerPick }
      })
    ).toEqual(providerPick)
  })

  it('ignores a cleared (null) provider entry when deciding whether legacy globals apply', () => {
    const legacy = { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' }
    expect(
      resolveModelForSdk('opencode', {
        selectedModel: legacy,
        selectedModelByProvider: { codex: null }
      })
    ).toEqual(legacy)
  })
})
