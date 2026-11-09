import { describe, expect, it } from 'vitest'
import {
  claudeCliFallbackModelName,
  isClaudeCliFallbackModelId,
  resolveClaudeCliFallbackModel
} from './claude-cli-fallback-models'

describe('resolveClaudeCliFallbackModel', () => {
  it('maps an Opus 4.x raw transcript model to its fallback id + name', () => {
    expect(resolveClaudeCliFallbackModel('claude-opus-4-8')).toEqual({
      id: 'opus-4-8',
      name: 'Opus 4.8'
    })
    expect(resolveClaudeCliFallbackModel('claude-opus-4-5-20251101')).toEqual({
      id: 'opus-4-5',
      name: 'Opus 4.5'
    })
  })

  it('also resolves an already-stored fallback id (idempotent canonicalization)', () => {
    expect(resolveClaudeCliFallbackModel('opus-4-8')).toEqual({ id: 'opus-4-8', name: 'Opus 4.8' })
  })

  it('returns null for selectable models and empty input', () => {
    expect(resolveClaudeCliFallbackModel('claude-opus-5-5-20260101')).toBeNull()
    expect(resolveClaudeCliFallbackModel('claude-fable-5-2')).toBeNull()
    expect(resolveClaudeCliFallbackModel('opus')).toBeNull()
    expect(resolveClaudeCliFallbackModel(null)).toBeNull()
    expect(resolveClaudeCliFallbackModel(undefined)).toBeNull()
  })
})

describe('isClaudeCliFallbackModelId / claudeCliFallbackModelName', () => {
  it('recognizes stored fallback ids', () => {
    expect(isClaudeCliFallbackModelId('opus-4-8')).toBe(true)
    expect(isClaudeCliFallbackModelId('opus-4-5')).toBe(true)
    expect(isClaudeCliFallbackModelId('opus')).toBe(false)
    expect(isClaudeCliFallbackModelId('claude-opus-4-8')).toBe(false)
    expect(isClaudeCliFallbackModelId(null)).toBe(false)
  })

  it('gives display names only for fallback ids', () => {
    expect(claudeCliFallbackModelName('opus-4-8')).toBe('Opus 4.8')
    expect(claudeCliFallbackModelName('opus')).toBeNull()
    expect(claudeCliFallbackModelName(undefined)).toBeNull()
  })
})
