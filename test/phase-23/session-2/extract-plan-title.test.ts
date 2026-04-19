import { describe, expect, test } from 'vitest'

import { extractPlanTitle } from '../../../src/shared/types/branch-utils'

describe('extractPlanTitle', () => {
  test('returns H1 heading text', () => {
    expect(extractPlanTitle('# Add user authentication\n\nDetails')).toBe(
      'Add user authentication'
    )
  })

  test('returns lower-level heading text', () => {
    expect(extractPlanTitle('## Fix login redirect\n\nDetails')).toBe('Fix login redirect')
    expect(extractPlanTitle('### Handle OAuth callback\n\nDetails')).toBe('Handle OAuth callback')
  })

  test('trims a leading plan prefix from heading titles', () => {
    expect(extractPlanTitle('# Plan: Add `mul_998` function\n\nDetails')).toBe(
      'Add `mul_998` function'
    )
  })

  test('falls back to first non-empty line when no heading exists', () => {
    expect(extractPlanTitle('Add user authentication\n\n1. Build UI')).toBe(
      'Add user authentication'
    )
  })

  test('trims a leading plan prefix from first-line fallback titles', () => {
    expect(extractPlanTitle('Plan: Add `mul_998` function\n\n1. Build UI')).toBe(
      'Add `mul_998` function'
    )
  })

  test('skips leading blank lines for fallback', () => {
    expect(extractPlanTitle('\n\n  \nFix login redirect\n\nMore detail')).toBe('Fix login redirect')
  })

  test('returns null for empty or whitespace-only input', () => {
    expect(extractPlanTitle('')).toBeNull()
    expect(extractPlanTitle('   \n\t  ')).toBeNull()
  })

  test('returns raw heading text with formatting characters preserved', () => {
    expect(extractPlanTitle('# Fix **OAuth** [redirect](https://example.com) `flow` 🔐')).toBe(
      'Fix **OAuth** [redirect](https://example.com) `flow` 🔐'
    )
  })

  test('returns the first heading when multiple headings exist', () => {
    expect(extractPlanTitle('# First heading\n\n## Second heading')).toBe('First heading')
  })

  test('finds a heading after leading blank lines', () => {
    expect(extractPlanTitle('\n\n# Add audit logging\n\nMore detail')).toBe('Add audit logging')
  })

  test('ignores empty markdown headings and falls back when possible', () => {
    expect(extractPlanTitle('###\n\nFallback line')).toBe('Fallback line')
  })
})
