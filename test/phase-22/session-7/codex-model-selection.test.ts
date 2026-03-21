/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Mock child_process
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn()
  }
})

import {
  normalizeCodexModelSlug,
  resolveCodexModelSlug,
  CODEX_DEFAULT_MODEL,
  CODEX_MODEL_ALIASES,
  CODEX_MODELS,
  getCodexModelInfo,
  getAvailableCodexModels
} from '../../../src/main/services/codex-models'

// ── Tests ───────────────────────────────────────────────────────────

describe('Codex Model Selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── normalizeCodexModelSlug ───────────────────────────────────────

  describe('normalizeCodexModelSlug', () => {
    it('returns null for null/undefined/empty input', () => {
      expect(normalizeCodexModelSlug(null)).toBeNull()
      expect(normalizeCodexModelSlug(undefined)).toBeNull()
      expect(normalizeCodexModelSlug('')).toBeNull()
      expect(normalizeCodexModelSlug('  ')).toBeNull()
    })

    it('resolves all known aliases', () => {
      expect(normalizeCodexModelSlug('5.4')).toBe('gpt-5.4')
      expect(normalizeCodexModelSlug('5.3')).toBe('gpt-5.3-codex')
      expect(normalizeCodexModelSlug('gpt-5.3')).toBe('gpt-5.3-codex')
      expect(normalizeCodexModelSlug('5.3-spark')).toBe('gpt-5.3-codex-spark')
      expect(normalizeCodexModelSlug('gpt-5.3-spark')).toBe('gpt-5.3-codex-spark')
      expect(normalizeCodexModelSlug('5.2')).toBe('gpt-5.2-codex')
      expect(normalizeCodexModelSlug('gpt-5.2')).toBe('gpt-5.2-codex')
    })

    it('passes through canonical model IDs unchanged', () => {
      expect(normalizeCodexModelSlug('gpt-5.4')).toBe('gpt-5.4')
      expect(normalizeCodexModelSlug('gpt-5.3-codex')).toBe('gpt-5.3-codex')
      expect(normalizeCodexModelSlug('gpt-5.2-codex')).toBe('gpt-5.2-codex')
    })

    it('passes through unknown model names unchanged', () => {
      expect(normalizeCodexModelSlug('gpt-99')).toBe('gpt-99')
      expect(normalizeCodexModelSlug('custom-model')).toBe('custom-model')
    })

    it('trims whitespace', () => {
      expect(normalizeCodexModelSlug('  5.4  ')).toBe('gpt-5.4')
      expect(normalizeCodexModelSlug('  gpt-5.4  ')).toBe('gpt-5.4')
    })
  })

  // ── resolveCodexModelSlug ─────────────────────────────────────────

  describe('resolveCodexModelSlug', () => {
    it('returns default model for null/undefined/empty input', () => {
      expect(resolveCodexModelSlug(null)).toBe(CODEX_DEFAULT_MODEL)
      expect(resolveCodexModelSlug(undefined)).toBe(CODEX_DEFAULT_MODEL)
      expect(resolveCodexModelSlug('')).toBe(CODEX_DEFAULT_MODEL)
    })

    it('resolves aliases to valid model IDs', () => {
      expect(resolveCodexModelSlug('5.4')).toBe('gpt-5.4')
      expect(resolveCodexModelSlug('5.3')).toBe('gpt-5.3-codex')
      expect(resolveCodexModelSlug('gpt-5.3')).toBe('gpt-5.3-codex')
    })

    it('falls back to default for unknown/invalid models', () => {
      expect(resolveCodexModelSlug('gpt-99')).toBe(CODEX_DEFAULT_MODEL)
      expect(resolveCodexModelSlug('custom-model')).toBe(CODEX_DEFAULT_MODEL)
    })

    it('returns canonical IDs unchanged', () => {
      expect(resolveCodexModelSlug('gpt-5.4')).toBe('gpt-5.4')
      expect(resolveCodexModelSlug('gpt-5.3-codex')).toBe('gpt-5.3-codex')
      expect(resolveCodexModelSlug('gpt-5.3-codex-spark')).toBe('gpt-5.3-codex-spark')
      expect(resolveCodexModelSlug('gpt-5.2-codex')).toBe('gpt-5.2-codex')
    })

    it('resolves "gpt-5.2" alias to gpt-5.2-codex', () => {
      // gpt-5.2 is an alias for gpt-5.2-codex
      expect(resolveCodexModelSlug('gpt-5.2')).toBe('gpt-5.2-codex')
    })
  })

  // ── getCodexModelInfo with normalization ───────────────────────────

  describe('getCodexModelInfo with normalization', () => {
    it('looks up by canonical ID', () => {
      const info = getCodexModelInfo('gpt-5.4')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.4')
      expect(info!.name).toBe('GPT-5.4')
    })

    it('looks up by alias', () => {
      const info = getCodexModelInfo('5.3')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.3-codex')
    })

    it('returns null for unknown model', () => {
      const info = getCodexModelInfo('gpt-99')
      expect(info).toBeNull()
    })
  })

  // ── getAvailableCodexModels ───────────────────────────────────────

  describe('getAvailableCodexModels', () => {
    it('returns a provider array with codex models', () => {
      const providers = getAvailableCodexModels()
      expect(providers).toHaveLength(1)
      expect(providers[0].id).toBe('codex')
      expect(providers[0].name).toBe('Codex')
      expect(Object.keys(providers[0].models).length).toBeGreaterThan(0)
    })

    it('includes all expected models', () => {
      const providers = getAvailableCodexModels()
      const modelIds = Object.keys(providers[0].models)
      expect(modelIds).toContain('gpt-5.4')
      expect(modelIds).toContain('gpt-5.3-codex')
      expect(modelIds).toContain('gpt-5.3-codex-spark')
      expect(modelIds).toContain('gpt-5.2-codex')
    })
  })

  // ── CodexImplementer model selection ──────────────────────────────

  describe('CodexImplementer model selection', () => {
    it('setSelectedModel resolves aliases', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      impl.setSelectedModel({ providerID: 'codex', modelID: '5.3' })
      expect(impl.getSelectedModel()).toBe('gpt-5.3-codex')
    })

    it('setSelectedModel falls back to default for invalid model', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      impl.setSelectedModel({ providerID: 'codex', modelID: 'nonexistent' })
      expect(impl.getSelectedModel()).toBe(CODEX_DEFAULT_MODEL)
    })

    it('setSelectedModel accepts canonical IDs', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.3-codex-spark' })
      expect(impl.getSelectedModel()).toBe('gpt-5.3-codex-spark')
    })

    it('setSelectedModel stores variant', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      impl.setSelectedModel({
        providerID: 'codex',
        modelID: 'gpt-5.4',
        variant: 'xhigh'
      })
      expect(impl.getSelectedVariant()).toBe('xhigh')
    })

    it('getAvailableModels returns codex provider', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      const models = await impl.getAvailableModels()
      expect(models).toHaveLength(1)
      expect((models as any[])[0].id).toBe('codex')
    })

    it('getModelInfo returns model metadata', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      const info = await impl.getModelInfo('/test', 'gpt-5.4')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.4')
      expect(info!.name).toBe('GPT-5.4')
      expect(info!.limit.context).toBe(200000)
    })

    it('getModelInfo resolves aliases', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      const info = await impl.getModelInfo('/test', '5.3')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.3-codex')
    })

    it('getModelInfo returns null for unknown model', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      const info = await impl.getModelInfo('/test', 'gpt-99')
      expect(info).toBeNull()
    })
  })

  // ── CODEX_MODEL_ALIASES completeness ──────────────────────────────

  describe('CODEX_MODEL_ALIASES', () => {
    it('all alias targets are valid model IDs', () => {
      const validIds = new Set(CODEX_MODELS.map((m: any) => m.id))

      for (const [alias, target] of Object.entries(CODEX_MODEL_ALIASES)) {
        expect(validIds.has(target), `Alias "${alias}" -> "${target}" not in CODEX_MODELS`).toBe(
          true
        )
      }
    })
  })
})
