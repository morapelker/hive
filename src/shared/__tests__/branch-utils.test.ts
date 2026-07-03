import { describe, expect, it } from 'vitest'
import { normalizeFilename } from '../types/branch-utils'

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
