import { describe, test, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useFileMentions,
  applyStripping,
  type FileMention
} from '../../src/renderer/src/hooks/useFileMentions'
import type { FlatFile } from '../../src/renderer/src/lib/file-search-utils'

const sampleFiles: FlatFile[] = [
  { name: 'helpers.ts', path: '/project/src/utils/helpers.ts', relativePath: 'src/utils/helpers.ts', extension: '.ts' },
  { name: 'index.ts', path: '/project/src/index.ts', relativePath: 'src/index.ts', extension: '.ts' },
  { name: 'app.tsx', path: '/project/src/app.tsx', relativePath: 'src/app.tsx', extension: '.tsx' },
  { name: 'README.md', path: '/project/README.md', relativePath: 'README.md', extension: '.md' }
]

describe('Session 3: Mention Tracking', () => {
  describe('Mention adjustment', () => {
    test('typing text BEFORE a mention shifts its indices forward', () => {
      // Start: select a file to create a mention
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleFiles),
        { initialProps: { input: '@help', cursor: 5 } }
      )

      // Select the helpers.ts file
      const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
      expect(file).toBeDefined()

      let selectResult: ReturnType<typeof result.current.selectFile>
      act(() => {
        selectResult = result.current.selectFile(file)
      })

      // Input is now: '@src/utils/helpers.ts '
      const afterSelect = selectResult!.newValue
      expect(afterSelect).toBe('@src/utils/helpers.ts ')
      expect(result.current.mentions).toHaveLength(1)
      expect(result.current.mentions[0].startIndex).toBe(0)

      // User types 'Check ' before the mention
      const newValue = 'Check ' + afterSelect
      act(() => {
        result.current.updateMentions(afterSelect, newValue)
      })

      // Rerender with the new input so the hook state is consistent
      rerender({ input: newValue, cursor: newValue.length })

      expect(result.current.mentions).toHaveLength(1)
      expect(result.current.mentions[0].startIndex).toBe(6) // shifted by 'Check '.length
      expect(result.current.mentions[0].endIndex).toBe(6 + '@src/utils/helpers.ts'.length - 1)
    })

    test('typing text AFTER a mention does not change its indices', () => {
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleFiles),
        { initialProps: { input: '@help', cursor: 5 } }
      )

      const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
      let selectResult: ReturnType<typeof result.current.selectFile>
      act(() => {
        selectResult = result.current.selectFile(file)
      })

      const afterSelect = selectResult!.newValue // '@src/utils/helpers.ts '
      const originalStart = result.current.mentions[0].startIndex
      const originalEnd = result.current.mentions[0].endIndex

      // User types ' is great' at the end
      const newValue = afterSelect + 'is great'
      act(() => {
        result.current.updateMentions(afterSelect, newValue)
      })

      rerender({ input: newValue, cursor: newValue.length })

      expect(result.current.mentions).toHaveLength(1)
      expect(result.current.mentions[0].startIndex).toBe(originalStart)
      expect(result.current.mentions[0].endIndex).toBe(originalEnd)
    })

    test('deleting text BEFORE a mention shifts its indices backward', () => {
      // Start with 'Hello @help'
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleFiles),
        { initialProps: { input: 'Hello @help', cursor: 11 } }
      )

      const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
      let selectResult: ReturnType<typeof result.current.selectFile>
      act(() => {
        selectResult = result.current.selectFile(file)
      })

      // Input is now: 'Hello @src/utils/helpers.ts '
      const afterSelect = selectResult!.newValue
      expect(afterSelect).toBe('Hello @src/utils/helpers.ts ')
      expect(result.current.mentions[0].startIndex).toBe(6) // @ at index 6

      // User deletes 'Hello ' (6 chars) from the beginning
      const newValue = '@src/utils/helpers.ts '
      act(() => {
        result.current.updateMentions(afterSelect, newValue)
      })

      rerender({ input: newValue, cursor: newValue.length })

      expect(result.current.mentions).toHaveLength(1)
      expect(result.current.mentions[0].startIndex).toBe(0) // shifted back by 6
    })

    test('editing text INSIDE a mention removes it from tracking', () => {
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleFiles),
        { initialProps: { input: '@help', cursor: 5 } }
      )

      const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
      act(() => {
        result.current.selectFile(file)
      })

      // Input: '@src/utils/helpers.ts '
      const afterSelect = '@src/utils/helpers.ts '
      expect(result.current.mentions).toHaveLength(1)

      // User edits inside the mention: '@src/utils/CHANGED.ts '
      const newValue = '@src/utils/CHANGED.ts '
      act(() => {
        result.current.updateMentions(afterSelect, newValue)
      })

      rerender({ input: newValue, cursor: newValue.length })

      // Mention should be removed because text no longer matches
      expect(result.current.mentions).toHaveLength(0)
    })

    test('multiple mentions adjust independently', () => {
      // Build up two mentions manually
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleFiles),
        { initialProps: { input: '@help', cursor: 5 } }
      )

      // Select first mention
      const helpersFile = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
      let firstResult: ReturnType<typeof result.current.selectFile>
      act(() => {
        firstResult = result.current.selectFile(helpersFile)
      })

      // Input is now: '@src/utils/helpers.ts '
      const afterFirst = firstResult!.newValue

      // Now type ' @app' to trigger another mention
      const typingSecond = afterFirst + '@app'
      rerender({ input: typingSecond, cursor: typingSecond.length })

      const appFile = result.current.suggestions.find((s) => s.name === 'app.tsx')!
      expect(appFile).toBeDefined()

      let secondResult: ReturnType<typeof result.current.selectFile>
      act(() => {
        secondResult = result.current.selectFile(appFile)
      })

      // Input: '@src/utils/helpers.ts @src/app.tsx '
      const afterSecond = secondResult!.newValue
      expect(result.current.mentions).toHaveLength(2)

      // Type 'See ' at the very beginning (before first mention)
      const newValue = 'See ' + afterSecond
      act(() => {
        result.current.updateMentions(afterSecond, newValue)
      })

      rerender({ input: newValue, cursor: newValue.length })

      // Both mentions should shift forward by 4
      expect(result.current.mentions).toHaveLength(2)
      expect(result.current.mentions[0].startIndex).toBe(4)
      expect(result.current.mentions[1].startIndex).toBe(4 + '@src/utils/helpers.ts '.length)
    })
  })

  describe('applyStripping', () => {
    test("strips '@' from a single mention: '@src/foo.ts' -> 'src/foo.ts'", () => {
      const text = '@src/foo.ts'
      const mentions: FileMention[] = [{ relativePath: 'src/foo.ts', startIndex: 0, endIndex: 10 }]
      expect(applyStripping(text, mentions)).toBe('src/foo.ts')
    })

    test("strips '@' from multiple mentions preserving positions", () => {
      // 'Check @src/a.ts and @src/b.ts please'
      //  0123456789...
      // '@src/a.ts' starts at 6, length 9, endIndex=14 (inclusive)
      // ' and ' spans 15-19
      // '@src/b.ts' starts at 20, length 9, endIndex=28 (inclusive)
      const text = 'Check @src/a.ts and @src/b.ts please'
      const mentions: FileMention[] = [
        { relativePath: 'src/a.ts', startIndex: 6, endIndex: 14 },
        { relativePath: 'src/b.ts', startIndex: 20, endIndex: 28 }
      ]
      expect(applyStripping(text, mentions)).toBe('Check src/a.ts and src/b.ts please')
    })

    test("does NOT strip manually typed '@' (e.g. '@manual' not in mentions list)", () => {
      const text = 'Contact @manual for help'
      const mentions: FileMention[] = []
      expect(applyStripping(text, mentions)).toBe('Contact @manual for help')
    })

    test("mixed: 'Check @src/a.ts and @manual' with only first tracked -> 'Check src/a.ts and @manual'", () => {
      const text = 'Check @src/a.ts and @manual'
      const mentions: FileMention[] = [{ relativePath: 'src/a.ts', startIndex: 6, endIndex: 14 }]
      expect(applyStripping(text, mentions)).toBe('Check src/a.ts and @manual')
    })

    test('empty mentions array returns text unchanged', () => {
      const text = 'No mentions here'
      expect(applyStripping(text, [])).toBe('No mentions here')
    })

    test('handles mention at start of string', () => {
      const text = '@src/index.ts is the entry point'
      const mentions: FileMention[] = [
        { relativePath: 'src/index.ts', startIndex: 0, endIndex: 12 }
      ]
      expect(applyStripping(text, mentions)).toBe('src/index.ts is the entry point')
    })

    test('handles mention at end of string', () => {
      // 'Look at @src/index.ts'
      // '@src/index.ts' starts at 8, length 13, endIndex=20 (inclusive)
      const text = 'Look at @src/index.ts'
      const mentions: FileMention[] = [
        { relativePath: 'src/index.ts', startIndex: 8, endIndex: 20 }
      ]
      expect(applyStripping(text, mentions)).toBe('Look at src/index.ts')
    })
  })

  describe('getTextForSend', () => {
    test('with stripAtMentions=true, strips tracked mentions', () => {
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleFiles),
        { initialProps: { input: '@help', cursor: 5 } }
      )

      const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
      let selectResult: ReturnType<typeof result.current.selectFile>
      act(() => {
        selectResult = result.current.selectFile(file)
      })

      // Input: '@src/utils/helpers.ts '
      rerender({ input: selectResult!.newValue, cursor: selectResult!.newCursorPosition })

      const textToSend = result.current.getTextForSend(true)
      expect(textToSend).toBe('src/utils/helpers.ts ')
    })

    test('with stripAtMentions=false, returns text unchanged', () => {
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleFiles),
        { initialProps: { input: '@help', cursor: 5 } }
      )

      const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
      let selectResult: ReturnType<typeof result.current.selectFile>
      act(() => {
        selectResult = result.current.selectFile(file)
      })

      // Input: '@src/utils/helpers.ts '
      rerender({ input: selectResult!.newValue, cursor: selectResult!.newCursorPosition })

      const textToSend = result.current.getTextForSend(false)
      expect(textToSend).toBe('@src/utils/helpers.ts ')
    })
  })
})
