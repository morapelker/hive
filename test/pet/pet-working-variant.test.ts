import { describe, expect, it } from 'vitest'
import { workingVariantIndex } from '@/pet/workingVariant'

describe('workingVariantIndex', () => {
  const variants = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const corgi = {
    workingLottieVariants: variants,
    workingLottieVariantSessions: [1, 2, 3, 4, 5, 10, 15, 20]
  }

  it('picks the last style whose minimum the count reaches', () => {
    const counts = [0, 1, 2, 4, 5, 9, 10, 14, 15, 19, 20, 123456]
    expect(counts.map((n) => workingVariantIndex(corgi, n))).toEqual([
      0, 0, 1, 3, 4, 4, 5, 5, 6, 6, 7, 7
    ])
  })

  it('defaults each entry to its 1-based index when no minimums are listed', () => {
    const pet = { workingLottieVariants: variants.slice(0, 5) }
    expect([0, 1, 3, 5, 8].map((n) => workingVariantIndex(pet, n))).toEqual([0, 0, 2, 4, 4])
  })

  it('fills in missing minimums and floors fractional counts', () => {
    const pet = { workingLottieVariants: ['a', 'b', 'c'], workingLottieVariantSessions: [1, 2] }
    expect(workingVariantIndex(pet, 2.9)).toBe(1)
    expect(workingVariantIndex(pet, 3)).toBe(2)
  })

  it('falls back to the first style for pets without variants or odd counts', () => {
    expect(workingVariantIndex({}, 7)).toBe(0)
    expect(workingVariantIndex(corgi, Number.NaN)).toBe(0)
    expect(workingVariantIndex(corgi, Number.POSITIVE_INFINITY)).toBe(0)
  })
})
