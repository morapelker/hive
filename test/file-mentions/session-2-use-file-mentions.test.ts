import { describe, test, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFileMentions } from '../../src/renderer/src/hooks/useFileMentions'
import type { FileTreeNode } from '../../src/renderer/src/lib/file-search-utils'

const sampleTree: FileTreeNode[] = [
  {
    name: 'src',
    path: '/project/src',
    relativePath: 'src',
    isDirectory: true,
    extension: null,
    children: [
      {
        name: 'utils',
        path: '/project/src/utils',
        relativePath: 'src/utils',
        isDirectory: true,
        extension: null,
        children: [
          {
            name: 'helpers.ts',
            path: '/project/src/utils/helpers.ts',
            relativePath: 'src/utils/helpers.ts',
            isDirectory: false,
            extension: '.ts'
          },
          {
            name: 'format.ts',
            path: '/project/src/utils/format.ts',
            relativePath: 'src/utils/format.ts',
            isDirectory: false,
            extension: '.ts'
          }
        ]
      },
      {
        name: 'index.ts',
        path: '/project/src/index.ts',
        relativePath: 'src/index.ts',
        isDirectory: false,
        extension: '.ts'
      },
      {
        name: 'app.tsx',
        path: '/project/src/app.tsx',
        relativePath: 'src/app.tsx',
        isDirectory: false,
        extension: '.tsx'
      }
    ]
  },
  {
    name: 'README.md',
    path: '/project/README.md',
    relativePath: 'README.md',
    isDirectory: false,
    extension: '.md'
  },
  {
    name: 'package.json',
    path: '/project/package.json',
    relativePath: 'package.json',
    isDirectory: false,
    extension: '.json'
  },
  {
    name: 'tsconfig.json',
    path: '/project/tsconfig.json',
    relativePath: 'tsconfig.json',
    isDirectory: false,
    extension: '.json'
  }
]

describe('Session 2: useFileMentions Hook', () => {
  describe('Trigger detection', () => {
    test("'@' at position 0 opens popover", () => {
      const { result } = renderHook(() => useFileMentions('@', 1, sampleTree))
      expect(result.current.isOpen).toBe(true)
    })

    test("' @' (space then @) opens popover", () => {
      const { result } = renderHook(() => useFileMentions('hello @', 7, sampleTree))
      expect(result.current.isOpen).toBe(true)
    })

    test("'\\n@' (newline then @) opens popover", () => {
      const { result } = renderHook(() => useFileMentions('hello\n@', 7, sampleTree))
      expect(result.current.isOpen).toBe(true)
    })

    test("'user@' (mid-word) does NOT open popover", () => {
      const { result } = renderHook(() => useFileMentions('user@', 5, sampleTree))
      expect(result.current.isOpen).toBe(false)
    })

    test("'a@b' does NOT open popover", () => {
      const { result } = renderHook(() => useFileMentions('a@b', 3, sampleTree))
      expect(result.current.isOpen).toBe(false)
    })

    test("'@' followed by space closes popover", () => {
      const { result } = renderHook(() => useFileMentions('@ ', 2, sampleTree))
      expect(result.current.isOpen).toBe(false)
    })
  })

  describe('Filtering', () => {
    test('empty query returns first 5 files alphabetically', () => {
      const { result } = renderHook(() => useFileMentions('@', 1, sampleTree))

      expect(result.current.isOpen).toBe(true)
      expect(result.current.suggestions.length).toBeLessThanOrEqual(5)

      // Should be sorted alphabetically by relativePath (using localeCompare)
      const paths = result.current.suggestions.map((s) => s.relativePath)
      const sorted = [...paths].sort((a, b) => a.localeCompare(b))
      expect(paths).toEqual(sorted)
    })

    test("query 'help' matches 'helpers.ts' with filename-contains score", () => {
      const { result } = renderHook(() => useFileMentions('@help', 5, sampleTree))

      expect(result.current.isOpen).toBe(true)
      expect(result.current.suggestions.length).toBeGreaterThan(0)
      expect(result.current.suggestions[0].name).toBe('helpers.ts')
    })

    test("query 'src/u' matches 'src/utils/helpers.ts' with path-contains score", () => {
      const { result } = renderHook(() => useFileMentions('@src/u', 6, sampleTree))

      expect(result.current.isOpen).toBe(true)
      const paths = result.current.suggestions.map((s) => s.relativePath)
      expect(paths).toContain('src/utils/helpers.ts')
    })

    test('exact filename match scores highest', () => {
      const { result } = renderHook(() => useFileMentions('@helpers.ts', 11, sampleTree))

      expect(result.current.isOpen).toBe(true)
      expect(result.current.suggestions[0].name).toBe('helpers.ts')
    })

    test('max 5 results returned', () => {
      // Even with a query that matches everything via subsequence
      const { result } = renderHook(() => useFileMentions('@', 1, sampleTree))

      expect(result.current.suggestions.length).toBeLessThanOrEqual(5)
    })
  })

  describe('Selection', () => {
    test("selectFile replaces '@que' with '@src/utils/helpers.ts ' and returns correct mention", () => {
      const { result } = renderHook(() => useFileMentions('@help', 5, sampleTree))

      const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
      expect(file).toBeDefined()

      let selectResult: ReturnType<typeof result.current.selectFile> | undefined
      act(() => {
        selectResult = result.current.selectFile(file)
      })

      expect(selectResult!.newValue).toBe('@src/utils/helpers.ts ')
      expect(selectResult!.mention.relativePath).toBe('src/utils/helpers.ts')
    })

    test('selectFile appends trailing space after path', () => {
      const { result } = renderHook(() => useFileMentions('@help', 5, sampleTree))

      const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!

      let selectResult: ReturnType<typeof result.current.selectFile> | undefined
      act(() => {
        selectResult = result.current.selectFile(file)
      })

      expect(selectResult!.newValue).toMatch(/ $/)
    })

    test('mention has correct startIndex and endIndex', () => {
      const { result } = renderHook(() => useFileMentions('check @help', 11, sampleTree))

      const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!

      let selectResult: ReturnType<typeof result.current.selectFile> | undefined
      act(() => {
        selectResult = result.current.selectFile(file)
      })

      const mention = selectResult!.mention
      // @ is at index 6, mention text is '@src/utils/helpers.ts'
      expect(mention.startIndex).toBe(6)
      // endIndex is the last character of '@src/utils/helpers.ts' (before trailing space)
      const expectedText = '@src/utils/helpers.ts'
      expect(mention.endIndex).toBe(6 + expectedText.length - 1)

      // Verify the text at those indices matches
      const newValue = selectResult!.newValue
      expect(newValue.substring(mention.startIndex, mention.endIndex + 1)).toBe(
        '@src/utils/helpers.ts'
      )
    })
  })

  describe('Navigation', () => {
    test("moveSelection('down') increments selectedIndex", () => {
      const { result } = renderHook(() => useFileMentions('@', 1, sampleTree))

      expect(result.current.selectedIndex).toBe(0)
      act(() => {
        result.current.moveSelection('down')
      })
      expect(result.current.selectedIndex).toBe(1)
    })

    test("moveSelection('down') wraps from last to 0", () => {
      const { result } = renderHook(() => useFileMentions('@', 1, sampleTree))

      const count = result.current.suggestions.length
      // Move to last index
      for (let i = 0; i < count - 1; i++) {
        act(() => {
          result.current.moveSelection('down')
        })
      }
      expect(result.current.selectedIndex).toBe(count - 1)

      // One more should wrap to 0
      act(() => {
        result.current.moveSelection('down')
      })
      expect(result.current.selectedIndex).toBe(0)
    })

    test("moveSelection('up') wraps from 0 to last", () => {
      const { result } = renderHook(() => useFileMentions('@', 1, sampleTree))

      const count = result.current.suggestions.length
      expect(result.current.selectedIndex).toBe(0)

      act(() => {
        result.current.moveSelection('up')
      })
      expect(result.current.selectedIndex).toBe(count - 1)
    })

    test('selectedIndex resets to 0 when query changes', () => {
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
        { initialProps: { input: '@', cursor: 1 } }
      )

      // Move selection down
      act(() => {
        result.current.moveSelection('down')
      })
      expect(result.current.selectedIndex).toBe(1)

      // Change the query by rerendering with different input
      rerender({ input: '@h', cursor: 2 })
      expect(result.current.selectedIndex).toBe(0)
    })
  })
})
