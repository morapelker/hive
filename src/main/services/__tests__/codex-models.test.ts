import { describe, expect, it } from 'vitest'

import {
  CODEX_MODELS,
  getAvailableCodexModels,
  getCodexModelInfo,
  normalizeCodexModelSlug,
  resolveCodexModelSlug
} from '../codex-models'

describe('gpt-5.6 and gpt-6 models', () => {
  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-6-luna'])('%s is registered', (id) => {
    const model = CODEX_MODELS.find((m) => m.id === id)
    expect(model).toBeDefined()
    expect(model?.limit).toEqual({ context: 372000, output: 32000 })
  })

  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra'])('%s offers ultra through low efforts', (id) => {
    const model = CODEX_MODELS.find((m) => m.id === id)
    expect(Object.keys(model!.variants)).toEqual(['ultra', 'max', 'xhigh', 'high', 'medium', 'low'])
  })

  it('gpt-6-luna offers max through low efforts without ultra', () => {
    const model = CODEX_MODELS.find((m) => m.id === 'gpt-6-luna')
    expect(Object.keys(model!.variants)).toEqual(['max', 'xhigh', 'high', 'medium', 'low'])
  })

  it('exposes the 5.6 and 6 models to the renderer', () => {
    const [provider] = getAvailableCodexModels()
    expect(provider.models['gpt-6-astra']?.name).toBe('GPT-6 Astra')
    expect(provider.models['gpt-6-sol']?.name).toBe('GPT-6 Sol')
    expect(provider.models['gpt-5.6-terra']?.name).toBe('GPT-5.6 Terra')
    expect(provider.models['gpt-6-luna']?.name).toBe('GPT-6 Luna')
    expect(provider.models['gpt-5.6-sol']).toBeUndefined()
    expect(provider.models['gpt-5.6-luna']).toBeUndefined()
  })

  it('resolves shorthand aliases', () => {
    expect(normalizeCodexModelSlug('6-astra')).toBe('gpt-6-astra')
    expect(normalizeCodexModelSlug('gpt-6')).toBe('gpt-6-astra')
    expect(resolveCodexModelSlug('gpt-6-astra')).toBe('gpt-6-astra')
    expect(getCodexModelInfo('6-astra')?.id).toBe('gpt-6-astra')
    expect(normalizeCodexModelSlug('6-sol')).toBe('gpt-6-sol')
    expect(normalizeCodexModelSlug('5.6-terra')).toBe('gpt-5.6-terra')
    expect(normalizeCodexModelSlug('6-luna')).toBe('gpt-6-luna')
    expect(resolveCodexModelSlug('gpt-6-sol')).toBe('gpt-6-sol')
    expect(getCodexModelInfo('6-luna')?.id).toBe('gpt-6-luna')
  })

  it('migrates the retired gpt-5.6 sol and luna slugs to gpt-6', () => {
    expect(resolveCodexModelSlug('gpt-5.6-sol')).toBe('gpt-6-sol')
    expect(resolveCodexModelSlug('5.6-sol')).toBe('gpt-6-sol')
    expect(resolveCodexModelSlug('gpt-5.6-luna')).toBe('gpt-6-luna')
    expect(resolveCodexModelSlug('5.6-luna')).toBe('gpt-6-luna')
    expect(getCodexModelInfo('gpt-5.6-luna')?.id).toBe('gpt-6-luna')
  })

  it('lists gpt-6-astra first so it is the top codex pick', () => {
    expect(CODEX_MODELS[0]?.id).toBe('gpt-6-astra')
  })

  it('keeps gpt-5.5 as the default model', () => {
    expect(resolveCodexModelSlug(undefined)).toBe('gpt-5.5')
    expect(resolveCodexModelSlug('not-a-model')).toBe('gpt-5.5')
  })
})
