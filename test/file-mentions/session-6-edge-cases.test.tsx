import { describe, test, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { render, screen } from '@testing-library/react'
import { useFileMentions } from '../../src/renderer/src/hooks/useFileMentions'
import { flattenTree } from '../../src/renderer/src/lib/file-search-utils'
import { FileMentionPopover } from '../../src/renderer/src/components/sessions/FileMentionPopover'
import type { FileTreeNode, FlatFile } from '../../src/renderer/src/lib/file-search-utils'

/**
 * Session 6: Edge Cases, Polish & Final Verification
 *
 * Tests edge cases for paste handling, backspace behavior, empty file tree,
 * long path truncation, and accessibility attributes.
 */

// Mock FileIcon since it depends on file-icons module with SVG assets
vi.mock('../../src/renderer/src/components/file-tree/FileIcon', () => ({
  FileIcon: ({ name }: { name: string }) => <span data-testid="file-icon">{name}</span>
}))

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
          }
        ]
      },
      {
        name: 'index.ts',
        path: '/project/src/index.ts',
        relativePath: 'src/index.ts',
        isDirectory: false,
        extension: '.ts'
      }
    ]
  }
]

describe('Session 6: Edge Cases, Polish & Final Verification', () => {
  describe('Paste handling', () => {
    test('pasted text containing "@" does NOT open popover when updateMentions is skipped', () => {
      // Simulate what SessionView does: when pasting, isPastingRef is set to true
      // and updateMentions is NOT called, so the trigger detection still runs based
      // on the new inputValue — but since the paste flag prevents updateMentions
      // from being called, the existing mentions are preserved.
      //
      // At the hook level, we test that if the input suddenly contains '@' without
      // going through the normal typing flow (i.e. updateMentions is NOT called),
      // the hook's trigger detection still operates purely on inputValue/cursorPosition.
      //
      // The key behavior is that in SessionView, pasted '@' doesn't cause mention
      // tracking issues because updateMentions is skipped during paste.
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
        { initialProps: { input: '', cursor: 0 } }
      )

      expect(result.current.isOpen).toBe(false)

      // Simulate paste: text changes to include '@' but we do NOT call updateMentions
      // (this mirrors how SessionView skips updateMentions when isPastingRef is true)
      rerender({ input: 'pasted @text here', cursor: 17 })

      // The hook will detect the '@' via trigger detection, but since it's mid-word
      // ('d @t' — the cursor is at end, scanning back finds '@' preceded by space,
      // but query is 'text here' which contains a space → popover closes).
      // The key point: even if detection runs, the space in "text here" closes it.
      expect(result.current.isOpen).toBe(false)
    })

    test('pasted text with "@" at word boundary but with trailing content stays closed due to spaces in query', () => {
      const { result } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
        { initialProps: { input: 'see @file path here', cursor: 19 } }
      )

      // Query from '@' at index 4 to cursor at 19 = 'file path here' which has spaces
      // → popover should be closed
      expect(result.current.isOpen).toBe(false)
    })
  })

  describe('Backspace closing popover', () => {
    test('backspace on empty query (just "@") closes popover when "@" is deleted', () => {
      // Start with '@' at position 0 → popover opens
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
        { initialProps: { input: '@', cursor: 1 } }
      )

      expect(result.current.isOpen).toBe(true)
      expect(result.current.query).toBe('')

      // User presses backspace — '@' is deleted, input becomes empty
      rerender({ input: '', cursor: 0 })

      expect(result.current.isOpen).toBe(false)
    })

    test('backspace on "@" after text closes popover when "@" is deleted', () => {
      // Start with 'Hello @' → popover opens
      const { result, rerender } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, sampleTree),
        { initialProps: { input: 'Hello @', cursor: 7 } }
      )

      expect(result.current.isOpen).toBe(true)

      // User presses backspace — '@' is deleted
      rerender({ input: 'Hello ', cursor: 6 })

      expect(result.current.isOpen).toBe(false)
    })
  })

  describe('Empty file tree', () => {
    test('flattenTree([]) returns empty array gracefully', () => {
      const result = flattenTree([])
      expect(result).toEqual([])
    })

    test('empty file tree shows "No files found" in popover', () => {
      render(
        <FileMentionPopover
          suggestions={[]}
          selectedIndex={0}
          visible={true}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />
      )

      expect(screen.getByText('No files found')).toBeTruthy()
    })

    test('hook with empty file tree returns empty suggestions when popover opens', () => {
      const { result } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, []),
        { initialProps: { input: '@', cursor: 1 } }
      )

      expect(result.current.isOpen).toBe(true)
      expect(result.current.suggestions).toEqual([])
    })
  })

  describe('Very long paths', () => {
    test('very long path is truncated in display but fully inserted on select', () => {
      const longPathFile: FlatFile = {
        name: 'deeply-nested-component-with-very-long-name.tsx',
        path: '/project/src/components/features/dashboard/widgets/charts/analytics/deeply-nested-component-with-very-long-name.tsx',
        relativePath:
          'src/components/features/dashboard/widgets/charts/analytics/deeply-nested-component-with-very-long-name.tsx',
        extension: '.tsx'
      }

      // Test that the popover renders the item (it should have truncate CSS class)
      render(
        <FileMentionPopover
          suggestions={[longPathFile]}
          selectedIndex={0}
          visible={true}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />
      )

      // The file name should be displayed
      const nameElements = screen.getAllByText(longPathFile.name)
      expect(nameElements.length).toBeGreaterThanOrEqual(1)

      // The relative path should be displayed
      expect(screen.getByText(longPathFile.relativePath)).toBeTruthy()

      // The item container should have overflow-hidden for truncation
      const item = screen.getByTestId('file-mention-item')
      expect(item.className).toContain('overflow-hidden')
    })

    test('selecting a long path file inserts the full path', () => {
      const longPathTree: FileTreeNode[] = [
        {
          name: 'very-long-component-name.tsx',
          path: '/project/src/deep/nested/path/to/very-long-component-name.tsx',
          relativePath: 'src/deep/nested/path/to/very-long-component-name.tsx',
          isDirectory: false,
          extension: '.tsx'
        }
      ]

      const { result } = renderHook(
        ({ input, cursor }) => useFileMentions(input, cursor, longPathTree),
        { initialProps: { input: '@very', cursor: 5 } }
      )

      expect(result.current.suggestions).toHaveLength(1)

      let selectResult: ReturnType<typeof result.current.selectFile>
      act(() => {
        selectResult = result.current.selectFile(result.current.suggestions[0])
      })

      // Full path should be inserted, not truncated
      expect(selectResult!.newValue).toBe(
        '@src/deep/nested/path/to/very-long-component-name.tsx '
      )
    })
  })

  describe('Accessibility', () => {
    test('popover has role="listbox"', () => {
      render(
        <FileMentionPopover
          suggestions={[
            {
              name: 'index.ts',
              path: '/project/src/index.ts',
              relativePath: 'src/index.ts',
              extension: '.ts'
            }
          ]}
          selectedIndex={0}
          visible={true}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />
      )

      expect(screen.getByRole('listbox')).toBeTruthy()
    })

    test('suggestion items have role="option" and aria-selected', () => {
      const suggestions: FlatFile[] = [
        {
          name: 'index.ts',
          path: '/project/src/index.ts',
          relativePath: 'src/index.ts',
          extension: '.ts'
        },
        {
          name: 'app.tsx',
          path: '/project/src/app.tsx',
          relativePath: 'src/app.tsx',
          extension: '.tsx'
        }
      ]

      render(
        <FileMentionPopover
          suggestions={suggestions}
          selectedIndex={0}
          visible={true}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />
      )

      const options = screen.getAllByRole('option')
      expect(options).toHaveLength(2)

      // First item should be selected
      expect(options[0].getAttribute('aria-selected')).toBe('true')
      // Second item should not be selected
      expect(options[1].getAttribute('aria-selected')).toBe('false')
    })
  })
})
