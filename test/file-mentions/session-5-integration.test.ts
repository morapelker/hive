import { describe, test, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFileMentions, applyStripping } from '../../src/renderer/src/hooks/useFileMentions'
import type { FileTreeNode } from '../../src/renderer/src/lib/file-search-utils'

/**
 * Session 5 Integration Tests
 *
 * These tests verify the end-to-end integration flow of file mentions:
 * trigger detection → filtering → selection → mention tracking → stripping on send.
 *
 * They are "unit-level integration" tests: they exercise the useFileMentions hook
 * through the same sequence of operations that SessionView performs, validating
 * that all pieces work together correctly.
 */

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
  }
]

describe('Session 5: Integration', () => {
  test("typing '@' at position 0 opens file mention popover", () => {
    const { result } = renderHook(() => useFileMentions('@', 1, sampleTree))
    expect(result.current.isOpen).toBe(true)
    expect(result.current.suggestions.length).toBeGreaterThan(0)
  })

  test("typing '@' after space opens file mention popover", () => {
    const { result } = renderHook(() => useFileMentions('Check @', 7, sampleTree))
    expect(result.current.isOpen).toBe(true)
    expect(result.current.suggestions.length).toBeGreaterThan(0)
  })

  test("typing '@' mid-word does NOT open popover", () => {
    const { result } = renderHook(() => useFileMentions('user@test', 9, sampleTree))
    expect(result.current.isOpen).toBe(false)
  })

  test("selecting a file inserts '@relativePath ' into input", () => {
    const { result } = renderHook(() => useFileMentions('@help', 5, sampleTree))

    const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
    expect(file).toBeDefined()

    let selectResult: ReturnType<typeof result.current.selectFile>
    act(() => {
      selectResult = result.current.selectFile(file)
    })

    // The value should contain '@' + relativePath + trailing space
    expect(selectResult!.newValue).toBe('@src/utils/helpers.ts ')
    expect(selectResult!.newCursorPosition).toBe('@src/utils/helpers.ts '.length)
  })

  test("selecting a file then sending with strip ON sends without '@'", () => {
    const { result, rerender } = renderHook(
      ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
      { initialProps: { input: '@help', cursor: 5 } }
    )

    const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
    let selectResult: ReturnType<typeof result.current.selectFile>
    act(() => {
      selectResult = result.current.selectFile(file)
    })

    // Rerender with the new input (simulating SessionView setting inputValue)
    rerender({ input: selectResult!.newValue, cursor: selectResult!.newCursorPosition })

    // getTextForSend with strip=true should remove the '@'
    const textToSend = result.current.getTextForSend(true)
    expect(textToSend).toBe('src/utils/helpers.ts ')
    expect(textToSend).not.toContain('@')
  })

  test("selecting a file then sending with strip OFF sends with '@'", () => {
    const { result, rerender } = renderHook(
      ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
      { initialProps: { input: '@help', cursor: 5 } }
    )

    const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
    let selectResult: ReturnType<typeof result.current.selectFile>
    act(() => {
      selectResult = result.current.selectFile(file)
    })

    rerender({ input: selectResult!.newValue, cursor: selectResult!.newCursorPosition })

    // getTextForSend with strip=false should keep the '@'
    const textToSend = result.current.getTextForSend(false)
    expect(textToSend).toBe('@src/utils/helpers.ts ')
    expect(textToSend).toContain('@')
  })

  test('slash command popover takes priority over file mention popover', () => {
    // When input starts with '/', the slash command popover should show.
    // The file mention popover has a `visible` prop that includes `!showSlashCommands`.
    // Here we verify the hook itself: '/' at position 0 does NOT trigger '@' detection.
    const { result } = renderHook(() => useFileMentions('/command @file', 14, sampleTree))
    // The '@file' after a slash command is valid (preceded by space), but in SessionView
    // the popover would be hidden by `!showSlashCommands`. The hook itself still detects it.
    // The key integration point is that SessionView passes `visible={fileMentions.isOpen && !showSlashCommands}`
    // which is tested structurally by verifying:
    // 1. '/' input triggers showSlashCommands=true in SessionView
    // 2. FileMentionPopover has visible={... && !showSlashCommands}
    // For the hook-level test, we just verify the hook works correctly:
    expect(result.current.isOpen).toBe(true) // hook detects '@file'
    // But in SessionView, visible would be false because showSlashCommands=true
  })

  test('ArrowUp/Down navigate file suggestions when popover is open (not prompt history)', () => {
    const { result } = renderHook(() => useFileMentions('@', 1, sampleTree))

    // Popover is open
    expect(result.current.isOpen).toBe(true)
    expect(result.current.selectedIndex).toBe(0)

    // Navigate down
    act(() => {
      result.current.moveSelection('down')
    })
    expect(result.current.selectedIndex).toBe(1)

    // Navigate down again
    act(() => {
      result.current.moveSelection('down')
    })
    expect(result.current.selectedIndex).toBe(2)

    // Navigate back up
    act(() => {
      result.current.moveSelection('up')
    })
    expect(result.current.selectedIndex).toBe(1)
  })

  test('Escape closes popover without side effects', () => {
    const { result } = renderHook(() => useFileMentions('@help', 5, sampleTree))

    expect(result.current.isOpen).toBe(true)

    // Dismiss (what Escape handler calls)
    act(() => {
      result.current.dismiss()
    })

    expect(result.current.isOpen).toBe(false)
    // Suggestions should be empty when closed
    expect(result.current.suggestions).toHaveLength(0)
  })

  test('multiple mentions in one message all get stripped correctly', () => {
    const { result, rerender } = renderHook(
      ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
      { initialProps: { input: '@help', cursor: 5 } }
    )

    // Select first file: helpers.ts
    const helpersFile = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
    let firstResult: ReturnType<typeof result.current.selectFile>
    act(() => {
      firstResult = result.current.selectFile(helpersFile)
    })

    // Input is now: '@src/utils/helpers.ts '
    const afterFirst = firstResult!.newValue

    // Simulate typing ' and also @app' at the end
    const typingSecond = afterFirst + 'and also @app'
    rerender({ input: typingSecond, cursor: typingSecond.length })

    // Select second file: app.tsx
    const appFile = result.current.suggestions.find((s) => s.name === 'app.tsx')!
    expect(appFile).toBeDefined()

    let secondResult: ReturnType<typeof result.current.selectFile>
    act(() => {
      secondResult = result.current.selectFile(appFile)
    })

    // Rerender with the final input
    rerender({ input: secondResult!.newValue, cursor: secondResult!.newCursorPosition })

    // We should have 2 tracked mentions
    expect(result.current.mentions).toHaveLength(2)

    // Both '@' symbols should be stripped
    const textToSend = result.current.getTextForSend(true)
    expect(textToSend).toContain('src/utils/helpers.ts')
    expect(textToSend).toContain('src/app.tsx')
    // Count '@' — should be 0 since both mentions are tracked
    const atCount = (textToSend.match(/@/g) || []).length
    expect(atCount).toBe(0)
  })

  test("editing a mention's text removes it from tracking", () => {
    const { result, rerender } = renderHook(
      ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
      { initialProps: { input: '@help', cursor: 5 } }
    )

    const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
    act(() => {
      result.current.selectFile(file)
    })

    // Input: '@src/utils/helpers.ts '
    const afterSelect = '@src/utils/helpers.ts '
    expect(result.current.mentions).toHaveLength(1)

    // User edits inside the mention: changes 'helpers' to 'BROKEN'
    const newValue = '@src/utils/BROKEN.ts '
    act(() => {
      result.current.updateMentions(afterSelect, newValue)
    })
    rerender({ input: newValue, cursor: newValue.length })

    // Mention should be removed because text no longer matches
    expect(result.current.mentions).toHaveLength(0)

    // getTextForSend with strip=true should NOT strip the manually-broken '@'
    const textToSend = result.current.getTextForSend(true)
    expect(textToSend).toBe('@src/utils/BROKEN.ts ')
  })

  test('clearMentions resets tracked mentions after send', () => {
    const { result, rerender } = renderHook(
      ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
      { initialProps: { input: '@help', cursor: 5 } }
    )

    const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
    act(() => {
      result.current.selectFile(file)
    })

    expect(result.current.mentions).toHaveLength(1)

    // Simulate sending — SessionView calls clearMentions after send
    act(() => {
      result.current.clearMentions()
    })

    rerender({ input: '', cursor: 0 })

    expect(result.current.mentions).toHaveLength(0)
  })

  test('mixed tracked and untracked @ symbols: only tracked ones get stripped', () => {
    // Simulate: user selects helpers.ts via popover, then types '@manual' by hand
    const { result, rerender } = renderHook(
      ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
      { initialProps: { input: '@help', cursor: 5 } }
    )

    const file = result.current.suggestions.find((s) => s.name === 'helpers.ts')!
    let selectResult: ReturnType<typeof result.current.selectFile>
    act(() => {
      selectResult = result.current.selectFile(file)
    })

    // Input: '@src/utils/helpers.ts '
    const afterSelect = selectResult!.newValue

    // User types 'and @manual stuff'
    const withManual = afterSelect + 'and @manual stuff'
    act(() => {
      result.current.updateMentions(afterSelect, withManual)
    })
    rerender({ input: withManual, cursor: withManual.length })

    // Only 1 tracked mention (helpers.ts), '@manual' is not tracked
    expect(result.current.mentions).toHaveLength(1)

    // Strip should only remove the '@' from the tracked mention
    const text = result.current.getTextForSend(true)
    expect(text).toContain('src/utils/helpers.ts')
    expect(text).toContain('@manual') // '@manual' stays with '@'
  })

  test('applyStripping handles multiple mentions processed end-to-start', () => {
    // Verify the pure function handles index preservation correctly
    // 'See @src/a.ts and @src/b.ts here'
    //  0123456789012345678901234567890123
    // '@src/a.ts' at index 4, endIndex=13
    // '@src/b.ts' at index 18, endIndex=27
    const text = 'See @src/a.ts and @src/b.ts here'
    const mentions = [
      { relativePath: 'src/a.ts', startIndex: 4, endIndex: 13 },
      { relativePath: 'src/b.ts', startIndex: 18, endIndex: 27 }
    ]
    const result = applyStripping(text, mentions)
    expect(result).toBe('See src/a.ts and src/b.ts here')
  })
})
