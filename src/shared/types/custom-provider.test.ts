import { describe, expect, it } from 'vitest'
import {
  getLaunchableCustomProviderModels,
  matchCustomProviderModel,
  resolveCustomProviderEffort,
  resolveCustomProviderModelSelection,
  sanitizeCustomProviders,
  type CustomProviderModel
} from './custom-provider'

const MODEL: CustomProviderModel = {
  id: 'm1',
  name: 'GLM 4.6',
  slug: 'glm-4.6',
  efforts: ['low', 'high']
}

describe('sanitizeCustomProviders', () => {
  it('keeps legacy providers without models and defaults models to []', () => {
    const result = sanitizeCustomProviders([
      { id: 'p1', name: 'Proxy', command: 'claudex', usageProvider: 'claude' }
    ])
    expect(result).toEqual([
      { id: 'p1', name: 'Proxy', command: 'claudex', usageProvider: 'claude', models: [] }
    ])
  })

  it('round-trips declared models and drops unknown effort values', () => {
    const result = sanitizeCustomProviders([
      {
        id: 'p1',
        name: 'Proxy',
        command: 'claudex',
        usageProvider: 'none',
        models: [
          { id: 'm1', name: 'GLM 4.6', slug: 'glm-4.6', efforts: ['high', 'ultracode', 'low', 'nope'] }
        ]
      }
    ])
    // Canonical order (low → max), unknown values dropped — ultracode is not an effort.
    expect(result[0].models).toEqual([
      { id: 'm1', name: 'GLM 4.6', slug: 'glm-4.6', efforts: ['low', 'high'] }
    ])
  })

  it('drops malformed model rows but keeps the provider', () => {
    const result = sanitizeCustomProviders([
      {
        id: 'p1',
        name: 'Proxy',
        command: 'claudex',
        usageProvider: 'none',
        models: [
          { id: 'm1', name: 'ok', slug: 'ok', efforts: [] },
          { id: '', name: 'no id', slug: 'x', efforts: [] },
          { id: 'm3', name: 42, slug: 'x', efforts: [] },
          'not-an-object'
        ]
      }
    ])
    expect(result[0].models).toEqual([{ id: 'm1', name: 'ok', slug: 'ok', efforts: [] }])
  })

  it('treats a non-array models value as no models', () => {
    const result = sanitizeCustomProviders([
      { id: 'p1', name: 'Proxy', command: 'claudex', usageProvider: 'none', models: 'nope' }
    ])
    expect(result[0].models).toEqual([])
  })
})

describe('model matching and resolution', () => {
  it('ignores models with blank slugs', () => {
    expect(
      getLaunchableCustomProviderModels([MODEL, { id: 'm2', name: 'Draft', slug: '  ', efforts: [] }])
    ).toEqual([MODEL])
  })

  it('matches by trimmed slug only', () => {
    expect(matchCustomProviderModel([MODEL], 'glm-4.6')).toEqual(MODEL)
    expect(matchCustomProviderModel([MODEL], ' glm-4.6 ')).toEqual(MODEL)
    expect(matchCustomProviderModel([MODEL], 'sonnet')).toBeNull()
    expect(matchCustomProviderModel([MODEL], null)).toBeNull()
    expect(matchCustomProviderModel(undefined, 'glm-4.6')).toBeNull()
  })

  it('resolves declared efforts and rejects undeclared ones', () => {
    expect(resolveCustomProviderEffort(MODEL, 'high')).toBe('high')
    expect(resolveCustomProviderEffort(MODEL, 'max')).toBeNull()
    expect(resolveCustomProviderEffort(MODEL, 'ultracode')).toBeNull()
    expect(resolveCustomProviderEffort(MODEL, null)).toBeNull()
  })

  it('resolveCustomProviderModelSelection honors a valid candidate', () => {
    const provider = { models: [MODEL, { id: 'm2', name: 'Air', slug: 'glm-air', efforts: [] }] }
    expect(resolveCustomProviderModelSelection(provider, 'glm-air', 'high')).toEqual({
      model: provider.models[1],
      effort: null
    })
  })

  it('falls back to the first model and first effort for invalid candidates', () => {
    const provider = { models: [MODEL] }
    expect(resolveCustomProviderModelSelection(provider, 'sonnet', 'ultracode')).toEqual({
      model: MODEL,
      effort: 'low'
    })
  })

  it('returns null when the provider declares no launchable models', () => {
    expect(resolveCustomProviderModelSelection({ models: [] }, 'x', 'low')).toBeNull()
    expect(resolveCustomProviderModelSelection({ models: undefined }, 'x', 'low')).toBeNull()
    expect(
      resolveCustomProviderModelSelection({ models: [{ id: 'm', name: 'n', slug: ' ', efforts: [] }] })
    ).toBeNull()
  })
})
