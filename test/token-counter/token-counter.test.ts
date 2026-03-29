import { describe, test, expect } from 'vitest'
import { formatTokenCount } from '@/lib/format-utils'

describe('formatTokenCount', () => {
  test('returns integer string for values below 1000', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(1)).toBe('1')
    expect(formatTokenCount(42)).toBe('42')
    expect(formatTokenCount(999)).toBe('999')
  })

  test('switches to k notation at exactly 1000', () => {
    expect(formatTokenCount(1000)).toBe('1.0k')
  })

  test('formats k notation with 1 decimal place', () => {
    expect(formatTokenCount(1100)).toBe('1.1k')
    expect(formatTokenCount(1500)).toBe('1.5k')
    expect(formatTokenCount(9999)).toBe('10.0k')
    expect(formatTokenCount(12500)).toBe('12.5k')
    expect(formatTokenCount(999900)).toBe('999.9k')
  })

  test('switches to m notation at 1,000,000', () => {
    expect(formatTokenCount(1000000)).toBe('1.0m')
  })

  test('formats m notation with 1 decimal place', () => {
    expect(formatTokenCount(1500000)).toBe('1.5m')
    expect(formatTokenCount(2300000)).toBe('2.3m')
  })
})
