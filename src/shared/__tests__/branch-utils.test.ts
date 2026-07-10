import { describe, expect, it } from 'vitest'
import { canonicalizeModelSlug, normalizeFilename } from '../types/branch-utils'

describe('normalizeFilename', () => {
  it('converts spaces to underscores', () => {
    expect(normalizeFilename('save plan as md file')).toBe('save_plan_as_md_file')
  })

  it('preserves case', () => {
    expect(normalizeFilename('Save Plan As MD File')).toBe('Save_Plan_As_MD_File')
  })

  it('strips filesystem-unsafe characters', () => {
    expect(normalizeFilename('fix: auth/login (v2)!')).toBe('fix_authlogin_v2')
  })

  it('collapses consecutive underscores', () => {
    expect(normalizeFilename('a  -  b')).toBe('a_-_b')
    expect(normalizeFilename('a __ b')).toBe('a_b')
  })

  it('strips leading and trailing separators', () => {
    expect(normalizeFilename('...plan title...')).toBe('plan_title')
    expect(normalizeFilename('__plan__')).toBe('plan')
  })

  it('caps length at 64 characters without trailing separators', () => {
    const long = 'word '.repeat(20).trim()
    const result = normalizeFilename(long)
    expect(result.length).toBeLessThanOrEqual(64)
    expect(result).not.toMatch(/[._-]$/)
  })

  it('returns an empty string for all-unsafe input', () => {
    expect(normalizeFilename('!@#$%^&*()')).toBe('')
    expect(normalizeFilename('   ')).toBe('')
  })
})

describe('canonicalizeModelSlug', () => {
  it('drops a trailing segment that would push past the cap, instead of cutting mid-segment', () => {
    expect(canonicalizeModelSlug('claude-opus-4-5-20251101')).toBe('claude-opus-4-5')
  })

  it('converts dots to dashes and lowercases', () => {
    expect(canonicalizeModelSlug('gpt-5.5-codex')).toBe('gpt-5-5-codex')
  })

  it('leaves short slugs under the cap untouched', () => {
    expect(canonicalizeModelSlug('sonnet')).toBe('sonnet')
  })

  it('uppercases and underscores are normalized like canonicalizeTicketTitle', () => {
    expect(canonicalizeModelSlug('GPT_5_Turbo')).toBe('gpt-5-turbo')
  })

  it('keeps a whole segment that lands exactly at the cap', () => {
    // "aaaaaaaaaa-bbbbb" is exactly 16 chars — must be kept whole.
    expect(canonicalizeModelSlug('aaaaaaaaaa-bbbbb-cccccccc')).toBe('aaaaaaaaaa-bbbbb')
  })

  it('falls back to a raw sanitized prefix when a single segment alone exceeds the cap', () => {
    const result = canonicalizeModelSlug('supercalifragilisticexpialidocious')
    expect(result).toBe('supercalifragili')
    expect(result.length).toBeLessThanOrEqual(16)
  })

  it('never cuts mid-word: no result ends mid-token relative to input segments', () => {
    const result = canonicalizeModelSlug('claude-opus-4-5-20251101')
    expect(['claude', 'opus', '4', '5', '20251101']).toContain(result.split('-').pop())
  })

  it('returns an empty string for empty input', () => {
    expect(canonicalizeModelSlug('')).toBe('')
  })

  it('falls back to "model" for symbol-only input that sanitizes to empty', () => {
    expect(canonicalizeModelSlug('!!!___$$$')).toBe('model')
  })

  it('falls back to "model" for non-ASCII/unicode-only input that sanitizes to empty', () => {
    expect(canonicalizeModelSlug('你好')).toBe('model')
  })
})
