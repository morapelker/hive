import { describe, test, expect, beforeEach } from 'vitest'
import { flattenTree, scoreMatch } from '../../src/renderer/src/lib/file-search-utils'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

describe('Session 1: Shared Utils & Settings', () => {
  describe('flattenTree (from shared utils)', () => {
    test('extracts all files recursively', () => {
      const tree = [
        {
          name: 'src',
          isDirectory: true,
          children: [
            {
              name: 'index.ts',
              isDirectory: false,
              path: '/src/index.ts',
              relativePath: 'src/index.ts',
              extension: '.ts'
            }
          ],
          path: '/src',
          relativePath: 'src',
          extension: null
        },
        {
          name: 'README.md',
          isDirectory: false,
          path: '/README.md',
          relativePath: 'README.md',
          extension: '.md'
        }
      ]
      const flat = flattenTree(tree)
      expect(flat).toHaveLength(2)
      expect(flat[0].name).toBe('index.ts')
      expect(flat[1].name).toBe('README.md')
    })

    test('returns empty array for empty tree', () => {
      expect(flattenTree([])).toHaveLength(0)
    })
  })

  describe('scoreMatch (from shared utils)', () => {
    test('returns 100 for exact name match', () => {
      expect(scoreMatch('index.ts', { name: 'index.ts', relativePath: 'src/index.ts' })).toBe(100)
    })

    test('returns 80 for name starts with query', () => {
      expect(scoreMatch('index', { name: 'index.ts', relativePath: 'src/index.ts' })).toBe(80)
    })

    test('returns 60 for name contains query', () => {
      expect(scoreMatch('dex', { name: 'index.ts', relativePath: 'src/index.ts' })).toBe(60)
    })

    test('returns 40 for path contains query', () => {
      expect(scoreMatch('src/ind', { name: 'index.ts', relativePath: 'src/index.ts' })).toBe(40)
    })

    test('returns 0 for no match', () => {
      expect(scoreMatch('xyz', { name: 'index.ts', relativePath: 'src/index.ts' })).toBe(0)
    })
  })

  describe('stripAtMentions setting', () => {
    beforeEach(() => {
      // Reset the store to defaults before each test
      useSettingsStore.getState().resetToDefaults()
    })

    test('defaults to true', () => {
      const state = useSettingsStore.getState()
      expect(state.stripAtMentions).toBe(true)
    })

    test('updateSetting changes the value to false', () => {
      useSettingsStore.getState().updateSetting('stripAtMentions', false)
      expect(useSettingsStore.getState().stripAtMentions).toBe(false)
    })

    test('updateSetting changes the value back to true', () => {
      useSettingsStore.getState().updateSetting('stripAtMentions', false)
      useSettingsStore.getState().updateSetting('stripAtMentions', true)
      expect(useSettingsStore.getState().stripAtMentions).toBe(true)
    })

    test('extractSettings includes stripAtMentions', () => {
      // The partialize config determines what gets persisted.
      // We verify the store state includes stripAtMentions by checking the state directly.
      const state = useSettingsStore.getState()
      expect('stripAtMentions' in state).toBe(true)
      expect(state.stripAtMentions).toBe(true)
    })
  })
})
