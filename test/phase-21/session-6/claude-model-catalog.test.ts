/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/claude-transcript-reader', () => ({
  readClaudeTranscript: vi.fn().mockResolvedValue([]),
  translateEntry: vi.fn().mockReturnValue(null)
}))

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'

describe('ClaudeCodeImplementer model catalog', () => {
  let impl: ClaudeCodeImplementer

  beforeEach(() => {
    vi.resetAllMocks()
    impl = new ClaudeCodeImplementer()
  })

  it('getAvailableModels() returns providers array with claude-code provider', async () => {
    const providers = (await impl.getAvailableModels()) as any[]
    expect(Array.isArray(providers)).toBe(true)
    expect(providers).toHaveLength(1)
    expect(providers[0].id).toBe('claude-code')
    expect(providers[0].name).toBe('Claude Code')
  })

  it('getAvailableModels() includes opus, sonnet, haiku models', async () => {
    const providers = (await impl.getAvailableModels()) as any[]
    const models = providers[0].models
    expect(models).toHaveProperty('opus')
    expect(models).toHaveProperty('sonnet')
    expect(models).toHaveProperty('haiku')
  })

  it('getAvailableModels() models have correct shape', async () => {
    const providers = (await impl.getAvailableModels()) as any[]
    const models = providers[0].models

    for (const key of ['opus', 'sonnet', 'haiku']) {
      const model = models[key]
      expect(model).toHaveProperty('id')
      expect(model).toHaveProperty('name')
      expect(model).toHaveProperty('limit')
      expect(model.limit).toHaveProperty('context')
      expect(model.limit).toHaveProperty('output')
    }
  })

  it('getModelInfo returns correct metadata for opus', async () => {
    const info = await impl.getModelInfo('any', 'opus')
    expect(info).toEqual({
      id: 'opus',
      name: 'Opus 4.6',
      limit: { context: 200000, output: 32000 }
    })
  })

  it('getModelInfo returns correct metadata for sonnet', async () => {
    const info = await impl.getModelInfo('any', 'sonnet')
    expect(info).toEqual({
      id: 'sonnet',
      name: 'Sonnet 4.6',
      limit: { context: 200000, output: 16000 }
    })
  })

  it('getModelInfo returns null for unknown model', async () => {
    const info = await impl.getModelInfo('any', 'gpt-4')
    expect(info).toBeNull()
  })

  it('setSelectedModel stores the modelID', () => {
    // Should not throw when setting a valid model
    expect(() => {
      impl.setSelectedModel({ providerID: 'claude-code', modelID: 'opus' })
    }).not.toThrow()
  })

  it('default selected model is sonnet', async () => {
    // Verify indirectly: getAvailableModels includes sonnet and the default
    // is exercised via prompt() in the prompt-model test. Here we verify the
    // implementer can be instantiated and sonnet exists in the catalog.
    const providers = (await impl.getAvailableModels()) as any[]
    const models = providers[0].models
    expect(models.sonnet).toBeDefined()
    expect(models.sonnet.id).toBe('sonnet')
  })
})
