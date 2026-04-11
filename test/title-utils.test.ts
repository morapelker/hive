import { describe, it, expect } from 'vitest'
import { maybeExtractJsonTitle } from '../src/shared/title-utils'

describe('maybeExtractJsonTitle', () => {
  it('extracts title from JSON object (the bug case)', () => {
    expect(maybeExtractJsonTitle('{"title": "Codex vs t3"}')).toBe('Codex vs t3')
  })

  it('trims whitespace from extracted title', () => {
    expect(maybeExtractJsonTitle('{"title": "  spaced  "}')).toBe('spaced')
  })

  it('returns plain string titles unchanged', () => {
    expect(maybeExtractJsonTitle('Plain title')).toBe('Plain title')
  })

  it('returns JSON without title field unchanged', () => {
    const input = '{"other": "value"}'
    expect(maybeExtractJsonTitle(input)).toBe(input)
  })

  it('returns invalid JSON starting with { unchanged', () => {
    expect(maybeExtractJsonTitle('{not json')).toBe('{not json')
  })

  it('returns empty string unchanged', () => {
    expect(maybeExtractJsonTitle('')).toBe('')
  })

  it('handles whitespace around JSON', () => {
    expect(maybeExtractJsonTitle('  { "title": "padded" }  ')).toBe('padded')
  })

  it('returns JSON with empty title field unchanged', () => {
    const input = '{"title": ""}'
    expect(maybeExtractJsonTitle(input)).toBe(input)
  })

  it('returns JSON with whitespace-only title field unchanged', () => {
    const input = '{"title": "   "}'
    expect(maybeExtractJsonTitle(input)).toBe(input)
  })

  it('handles title with extra JSON fields', () => {
    expect(maybeExtractJsonTitle('{"title": "Fix auth bug", "confidence": 0.9}')).toBe('Fix auth bug')
  })

  it('does not try to parse strings that do not start with {', () => {
    expect(maybeExtractJsonTitle('title: Fix auth bug')).toBe('title: Fix auth bug')
  })

  it('handles numeric title values gracefully (returns original)', () => {
    const input = '{"title": 42}'
    expect(maybeExtractJsonTitle(input)).toBe(input)
  })
})
