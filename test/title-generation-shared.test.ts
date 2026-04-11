import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { sanitizeTitle, extractTitleFromJSON } from '../src/main/services/title-generation-shared'

// ── sanitizeTitle ────────────────────────────────────────────────────

describe('sanitizeTitle', () => {
  it('returns trimmed single-line title as-is', () => {
    expect(sanitizeTitle('Fix auth bug')).toBe('Fix auth bug')
  })

  it('takes only first line from multiline input', () => {
    expect(sanitizeTitle('First line\nSecond line\nThird line')).toBe('First line')
  })

  it('strips surrounding double quotes', () => {
    expect(sanitizeTitle('"Fix auth bug"')).toBe('Fix auth bug')
  })

  it('strips surrounding single quotes', () => {
    expect(sanitizeTitle("'Fix auth bug'")).toBe('Fix auth bug')
  })

  it('strips surrounding backticks', () => {
    expect(sanitizeTitle('`Fix auth bug`')).toBe('Fix auth bug')
  })

  it('collapses internal whitespace', () => {
    expect(sanitizeTitle('Fix   auth    bug')).toBe('Fix auth bug')
  })

  it('returns null for empty string', () => {
    expect(sanitizeTitle('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(sanitizeTitle('   \t  \n  ')).toBeNull()
  })

  it('truncates at 50 chars with ellipsis', () => {
    const long = 'A'.repeat(60)
    const result = sanitizeTitle(long)
    expect(result).toBe('A'.repeat(50) + '...')
    expect(result!.length).toBe(53)
  })

  it('returns full title when exactly 50 chars', () => {
    const exact = 'A'.repeat(50)
    expect(sanitizeTitle(exact)).toBe(exact)
  })

  it('returns full title when under 50 chars', () => {
    const short = 'A'.repeat(30)
    expect(sanitizeTitle(short)).toBe(short)
  })

  it('extracts title from double-wrapped JSON (the bug case)', () => {
    expect(sanitizeTitle('{"title": "Codex vs t3"}')).toBe('Codex vs t3')
  })

  it('extracts title from double-wrapped JSON with extra fields', () => {
    expect(sanitizeTitle('{"title": "Fix auth bug", "confidence": 0.9}')).toBe('Fix auth bug')
  })

  it('passes through JSON without title field unchanged', () => {
    expect(sanitizeTitle('{"other": "value"}')).toBe('{"other": "value"}')
  })
})

// ── extractTitleFromJSON ─────────────────────────────────────────────

describe('extractTitleFromJSON', () => {
  it('extracts from Claude -p envelope (structured_output)', () => {
    const input = JSON.stringify({ structured_output: { title: 'Fix auth bug' } })
    expect(extractTitleFromJSON(input)).toBe('Fix auth bug')
  })

  it('extracts from direct JSON', () => {
    const input = JSON.stringify({ title: 'Fix auth bug' })
    expect(extractTitleFromJSON(input)).toBe('Fix auth bug')
  })

  it('extracts from nested result string', () => {
    const input = JSON.stringify({ result: JSON.stringify({ title: 'Fix auth bug' }) })
    expect(extractTitleFromJSON(input)).toBe('Fix auth bug')
  })

  it('extracts from text with embedded JSON', () => {
    const input = 'Some text {"title":"Fix auth bug"} more text'
    expect(extractTitleFromJSON(input)).toBe('Fix auth bug')
  })

  it('returns null for empty string', () => {
    expect(extractTitleFromJSON('')).toBeNull()
  })

  it('returns null for non-JSON text', () => {
    expect(extractTitleFromJSON('just some plain text')).toBeNull()
  })

  it('returns null for JSON without title key', () => {
    const input = JSON.stringify({ other: 'value' })
    expect(extractTitleFromJSON(input)).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(extractTitleFromJSON('{not valid json')).toBeNull()
  })

  it('returns null for whitespace-only input', () => {
    expect(extractTitleFromJSON('   \t\n  ')).toBeNull()
  })
})
