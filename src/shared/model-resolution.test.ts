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
    const own = { providerID: 'codex', modelID: 'gpt-5.6-luna', variant: 'medium' }
    expect(
      resolveModelForSdk('codex-cli', { selectedModelByProvider: { codex: codexPick, 'codex-cli': own } })
    ).toEqual(own)
    // Other providers' picks never leak into codex-cli.
    expect(
      resolveModelForSdk('codex-cli', {
        selectedModelByProvider: { 'claude-code': { providerID: 'anthropic', modelID: 'sonnet' } }
      })
    ).toBeNull()
  })
})
