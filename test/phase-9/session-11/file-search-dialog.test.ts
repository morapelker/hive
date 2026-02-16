import { describe, test, expect } from 'vitest'
import { flattenTree, scoreMatch } from '../../../src/renderer/src/lib/file-search-utils'

describe('Session 11: File Search Dialog', () => {
  describe('flattenTree', () => {
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
            },
            {
              name: 'utils',
              isDirectory: true,
              path: '/src/utils',
              relativePath: 'src/utils',
              extension: null,
              children: [
                {
                  name: 'helpers.ts',
                  isDirectory: false,
                  path: '/src/utils/helpers.ts',
                  relativePath: 'src/utils/helpers.ts',
                  extension: '.ts'
                }
              ]
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
      expect(flat).toHaveLength(3)
      expect(flat[0].name).toBe('index.ts')
      expect(flat[1].name).toBe('helpers.ts')
      expect(flat[2].name).toBe('README.md')
    })

    test('returns empty array for empty tree', () => {
      expect(flattenTree([])).toHaveLength(0)
    })

    test('skips directories in output', () => {
      const tree = [
        {
          name: 'src',
          isDirectory: true,
          path: '/src',
          relativePath: 'src',
          extension: null,
          children: []
        }
      ]
      const flat = flattenTree(tree)
      expect(flat).toHaveLength(0)
    })

    test('handles nodes without children (lazy loading)', () => {
      const tree = [
        {
          name: 'src',
          isDirectory: true,
          path: '/src',
          relativePath: 'src',
          extension: null
          // no children — lazy not loaded yet
        },
        {
          name: 'file.ts',
          isDirectory: false,
          path: '/file.ts',
          relativePath: 'file.ts',
          extension: '.ts'
        }
      ]
      const flat = flattenTree(tree)
      expect(flat).toHaveLength(1)
      expect(flat[0].name).toBe('file.ts')
    })

    test('preserves extension in output', () => {
      const tree = [
        {
          name: 'app.tsx',
          isDirectory: false,
          path: '/app.tsx',
          relativePath: 'app.tsx',
          extension: '.tsx'
        }
      ]
      const flat = flattenTree(tree)
      expect(flat[0].extension).toBe('.tsx')
    })
  })

  describe('scoreMatch', () => {
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

    test('returns 20 for subsequence match', () => {
      // 'sit' matches s-r-c-/-i-n-d-e-x-.-t-s: s...i...t
      expect(scoreMatch('sit', { name: 'index.ts', relativePath: 'src/index.ts' })).toBe(20)
    })

    test('returns 0 for no match', () => {
      expect(scoreMatch('xyz', { name: 'index.ts', relativePath: 'src/index.ts' })).toBe(0)
    })

    test('is case insensitive', () => {
      expect(scoreMatch('INDEX.TS', { name: 'index.ts', relativePath: 'src/index.ts' })).toBe(100)
    })

    test('matches dotfiles', () => {
      expect(scoreMatch('.env', { name: '.env', relativePath: '.env' })).toBe(100)
    })

    test('matches partial dotfile name', () => {
      expect(scoreMatch('.git', { name: '.gitignore', relativePath: '.gitignore' })).toBe(80)
    })

    test('prefers exact match over prefix', () => {
      const exactScore = scoreMatch('app', { name: 'app', relativePath: 'src/app' })
      const prefixScore = scoreMatch('app', { name: 'app.tsx', relativePath: 'src/app.tsx' })
      expect(exactScore).toBeGreaterThan(prefixScore)
    })

    test('prefers name match over path match', () => {
      const nameScore = scoreMatch('utils', {
        name: 'utils.ts',
        relativePath: 'src/lib/utils.ts'
      })
      const pathScore = scoreMatch('src/lib', {
        name: 'utils.ts',
        relativePath: 'src/lib/utils.ts'
      })
      expect(nameScore).toBeGreaterThan(pathScore)
    })
  })
})
