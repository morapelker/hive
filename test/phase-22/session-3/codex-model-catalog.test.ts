import { describe, it, expect } from 'vitest'

import {
  CODEX_MODELS,
  CODEX_DEFAULT_MODEL,
  CODEX_REASONING_EFFORTS,
  getAvailableCodexModels,
  getCodexModelInfo
} from '../../../src/main/services/codex-models'

describe('codex-models', () => {
  // ── CODEX_MODELS constant ──────────────────────────────────────

  describe('CODEX_MODELS', () => {
    it('contains exactly 4 models', () => {
      expect(CODEX_MODELS).toHaveLength(4)
    })

    it('includes gpt-5.4', () => {
      const model = CODEX_MODELS.find((m) => m.id === 'gpt-5.4')
      expect(model).toBeDefined()
      expect(model!.name).toBe('GPT-5.4')
    })

    it('includes gpt-5.3-codex', () => {
      const model = CODEX_MODELS.find((m) => m.id === 'gpt-5.3-codex')
      expect(model).toBeDefined()
      expect(model!.name).toBe('GPT-5.3 Codex')
    })

    it('includes gpt-5.3-codex-spark', () => {
      const model = CODEX_MODELS.find((m) => m.id === 'gpt-5.3-codex-spark')
      expect(model).toBeDefined()
      expect(model!.name).toBe('GPT-5.3 Codex Spark')
    })

    it('includes gpt-5.2-codex', () => {
      const model = CODEX_MODELS.find((m) => m.id === 'gpt-5.2-codex')
      expect(model).toBeDefined()
      expect(model!.name).toBe('GPT-5.2 Codex')
    })

    it('all models have context limits', () => {
      for (const model of CODEX_MODELS) {
        expect(model.limit.context).toBeGreaterThan(0)
        expect(model.limit.output).toBeGreaterThan(0)
      }
    })

    it('all models have variant objects with reasoning efforts', () => {
      for (const model of CODEX_MODELS) {
        expect(model.variants).toHaveProperty('xhigh')
        expect(model.variants).toHaveProperty('high')
        expect(model.variants).toHaveProperty('medium')
        expect(model.variants).toHaveProperty('low')
      }
    })

    it('all models have a default variant', () => {
      for (const model of CODEX_MODELS) {
        expect(model.defaultVariant).toBeDefined()
        expect(Object.keys(model.variants)).toContain(model.defaultVariant)
      }
    })
  })

  // ── CODEX_DEFAULT_MODEL ────────────────────────────────────────

  describe('CODEX_DEFAULT_MODEL', () => {
    it('is gpt-5.4', () => {
      expect(CODEX_DEFAULT_MODEL).toBe('gpt-5.4')
    })

    it('exists in the model catalog', () => {
      const model = CODEX_MODELS.find((m) => m.id === CODEX_DEFAULT_MODEL)
      expect(model).toBeDefined()
    })
  })

  // ── CODEX_REASONING_EFFORTS ────────────────────────────────────

  describe('CODEX_REASONING_EFFORTS', () => {
    it('contains xhigh, high, medium, low', () => {
      expect(CODEX_REASONING_EFFORTS).toEqual(['xhigh', 'high', 'medium', 'low'])
    })
  })

  // ── getAvailableCodexModels ────────────────────────────────────

  describe('getAvailableCodexModels', () => {
    it('returns an array with a single provider entry', () => {
      const result = getAvailableCodexModels()
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('codex')
      expect(result[0].name).toBe('Codex')
    })

    it('provider entry contains all 4 models keyed by id', () => {
      const result = getAvailableCodexModels()
      const models = result[0].models
      expect(Object.keys(models)).toHaveLength(4)
      expect(models['gpt-5.4']).toBeDefined()
      expect(models['gpt-5.3-codex']).toBeDefined()
      expect(models['gpt-5.3-codex-spark']).toBeDefined()
      expect(models['gpt-5.2-codex']).toBeDefined()
    })

    it('each model in the result has id, name, limit, and variants', () => {
      const result = getAvailableCodexModels()
      for (const model of Object.values(result[0].models)) {
        expect(model).toHaveProperty('id')
        expect(model).toHaveProperty('name')
        expect(model).toHaveProperty('limit')
        expect(model.limit).toHaveProperty('context')
        expect(model.limit).toHaveProperty('output')
        expect(model).toHaveProperty('variants')
      }
    })

    it('matches the shape returned by ClaudeCodeImplementer.getAvailableModels', () => {
      const result = getAvailableCodexModels()
      // Should be an array of providers, each with id, name, models
      expect(Array.isArray(result)).toBe(true)
      const provider = result[0]
      expect(typeof provider.id).toBe('string')
      expect(typeof provider.name).toBe('string')
      expect(typeof provider.models).toBe('object')
    })
  })

  // ── getCodexModelInfo ──────────────────────────────────────────

  describe('getCodexModelInfo', () => {
    it('returns model info for gpt-5.4', () => {
      const info = getCodexModelInfo('gpt-5.4')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.4')
      expect(info!.name).toBe('GPT-5.4')
      expect(info!.limit.context).toBe(200000)
    })

    it('returns model info for gpt-5.3-codex', () => {
      const info = getCodexModelInfo('gpt-5.3-codex')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.3-codex')
      expect(info!.name).toBe('GPT-5.3 Codex')
    })

    it('returns model info for gpt-5.2 (resolves alias to gpt-5.2-codex)', () => {
      const info = getCodexModelInfo('gpt-5.2')
      expect(info).not.toBeNull()
      // gpt-5.2 is an alias for gpt-5.2-codex via CODEX_MODEL_ALIASES
      expect(info!.id).toBe('gpt-5.2-codex')
      expect(info!.name).toBe('GPT-5.2 Codex')
    })

    it('returns null for unknown model', () => {
      const info = getCodexModelInfo('nonexistent-model')
      expect(info).toBeNull()
    })

    it('returns null for empty string', () => {
      const info = getCodexModelInfo('')
      expect(info).toBeNull()
    })

    it('returned info has id, name, and limit', () => {
      const info = getCodexModelInfo('gpt-5.2-codex')
      expect(info).not.toBeNull()
      expect(info).toHaveProperty('id')
      expect(info).toHaveProperty('name')
      expect(info).toHaveProperty('limit')
      expect(info!.limit).toHaveProperty('context')
      expect(info!.limit).toHaveProperty('output')
    })
  })
})
