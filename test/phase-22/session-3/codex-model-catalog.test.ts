import { describe, expect, it } from 'vitest'

import {
  CODEX_DEFAULT_MODEL,
  CODEX_MODELS,
  getAvailableCodexModels,
  getCodexModelInfo,
  normalizeCodexModelSlug,
  resolveCodexModelSlug
} from '../../../src/main/services/codex-models'

describe('codex model catalog', () => {
  it('includes gpt-5.5 with the same effort variants as gpt-5.4', () => {
    const gpt55 = CODEX_MODELS.find((model) => model.id === 'gpt-5.5')
    const gpt54 = CODEX_MODELS.find((model) => model.id === 'gpt-5.4')

    expect(gpt55).toBeDefined()
    expect(gpt54).toBeDefined()
    expect(gpt55?.variants).toEqual(gpt54?.variants)
    expect(gpt55?.defaultVariant).toBe('high')
  })

  it('uses gpt-5.5 as the default codex model', () => {
    expect(CODEX_DEFAULT_MODEL).toBe('gpt-5.5')
  })

  it('normalizes the 5.5 shorthand slug', () => {
    expect(normalizeCodexModelSlug('5.5')).toBe('gpt-5.5')
    expect(resolveCodexModelSlug('5.5')).toBe('gpt-5.5')
  })

  it('returns gpt-5.5 model info through the shared lookup', () => {
    expect(getCodexModelInfo('5.5')).toEqual({
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      limit: { context: 400000, output: 32000 }
    })
  })

  it('publishes gpt-5.5 in the renderer-facing provider catalog', () => {
    const providers = getAvailableCodexModels()
    expect(providers).toHaveLength(1)
    expect(providers[0]?.models['gpt-5.5']).toMatchObject({
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      limit: { context: 400000, output: 32000 },
      variants: {
        xhigh: {},
        high: {},
        medium: {},
        low: {}
      }
    })
  })
})
