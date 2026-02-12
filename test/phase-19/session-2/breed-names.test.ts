import { describe, test, expect, vi } from 'vitest'

// Mock electron's app module so importing git-service doesn't crash in jsdom
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/mock-home')
  }
}))

// Mock simple-git so the module can load without real git
vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue({
    branch: vi.fn(),
    raw: vi.fn()
  })
}))

import {
  ALL_BREED_NAMES,
  DOG_BREEDS,
  LEGACY_CITY_NAMES,
  getRandomBreedName,
  selectUniqueBreedName
} from '../../../src/main/services/breed-names'

describe('Session 2: Dog Breed Names', () => {
  test('ALL_BREED_NAMES contains 100+ entries', () => {
    expect(ALL_BREED_NAMES.length).toBeGreaterThanOrEqual(100)
  })

  test('all breed names are valid git branch names', () => {
    for (const name of ALL_BREED_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(name).not.toContain(' ')
      expect(name).not.toContain('_')
      expect(name).not.toMatch(/\.\./)
      expect(name).not.toMatch(/\.$/)
      expect(name).not.toMatch(/\.lock$/)
    }
  })

  test('no duplicate breed names', () => {
    const uniqueNames = new Set(ALL_BREED_NAMES)
    expect(uniqueNames.size).toBe(ALL_BREED_NAMES.length)
  })

  test('getRandomBreedName returns a name from the dog breeds list', () => {
    const name = getRandomBreedName()
    expect(DOG_BREEDS).toContain(name)
  })

  test('selectUniqueBreedName avoids existing names', () => {
    const existing = new Set(DOG_BREEDS.slice(0, 55))
    const name = selectUniqueBreedName(existing)
    expect(existing.has(name)).toBe(false)
  })

  test('selectUniqueBreedName falls back to suffix when all names taken', () => {
    const existing = new Set(DOG_BREEDS)
    const name = selectUniqueBreedName(existing)
    expect(name).toMatch(/-v\d+$/)
  })

  test('LEGACY_CITY_NAMES is exported for backward compatibility', () => {
    expect(LEGACY_CITY_NAMES).toBeDefined()
    expect(LEGACY_CITY_NAMES.length).toBeGreaterThan(100)
    expect(LEGACY_CITY_NAMES).toContain('tokyo')
    expect(LEGACY_CITY_NAMES).toContain('chicago')
  })

  test('auto-rename detection recognizes breed names', () => {
    const isAutoName = ALL_BREED_NAMES.some(
      (b) => 'golden-retriever' === b || 'golden-retriever'.startsWith(`${b}-v`)
    )
    expect(isAutoName).toBe(true)
  })

  test('auto-rename detection recognizes legacy city names', () => {
    const isAutoName = LEGACY_CITY_NAMES.some((c) => 'tokyo' === c || 'tokyo'.startsWith(`${c}-v`))
    expect(isAutoName).toBe(true)
  })

  test('auto-rename detection recognizes versioned breed names', () => {
    const branchName = 'golden-retriever-v2'
    const isAutoName = ALL_BREED_NAMES.some(
      (b) => branchName === b || branchName.startsWith(`${b}-v`)
    )
    expect(isAutoName).toBe(true)
  })

  test('auto-rename detection recognizes versioned legacy city names', () => {
    const branchName = 'tokyo-v3'
    const isAutoName = LEGACY_CITY_NAMES.some(
      (c) => branchName === c || branchName.startsWith(`${c}-v`)
    )
    expect(isAutoName).toBe(true)
  })

  test('auto-rename detection does not match arbitrary branch names', () => {
    const branchName = 'my-feature-branch'
    const isAutoName =
      ALL_BREED_NAMES.some((b) => branchName === b || branchName.startsWith(`${b}-v`)) ||
      LEGACY_CITY_NAMES.some((c) => branchName === c || branchName.startsWith(`${c}-v`))
    expect(isAutoName).toBe(false)
  })

  test('no overlap between breed names and legacy city names', () => {
    const breedSet = new Set(ALL_BREED_NAMES)
    for (const city of LEGACY_CITY_NAMES) {
      expect(breedSet.has(city)).toBe(false)
    }
  })
})
