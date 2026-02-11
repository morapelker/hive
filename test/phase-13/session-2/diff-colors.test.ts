import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'

describe('Session 2: Diff Colors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
  })

  describe('EditToolView', () => {
    test('added lines use text-green-400', async () => {
      const { EditToolView } =
        await import('../../../src/renderer/src/components/sessions/tools/EditToolView')

      render(
        React.createElement(EditToolView, {
          name: 'Edit',
          input: { oldString: 'old line', newString: 'new line' },
          status: 'success'
        })
      )

      const addedLines = screen.getAllByTestId('diff-added')
      expect(addedLines.length).toBeGreaterThan(0)
      const contentSpan = addedLines[0].querySelector('span:last-child')
      expect(contentSpan).toHaveClass('text-green-400')
    })

    test('removed lines use text-red-400', async () => {
      const { EditToolView } =
        await import('../../../src/renderer/src/components/sessions/tools/EditToolView')

      render(
        React.createElement(EditToolView, {
          name: 'Edit',
          input: { oldString: 'old line', newString: 'new line' },
          status: 'success'
        })
      )

      const removedLines = screen.getAllByTestId('diff-removed')
      expect(removedLines.length).toBeGreaterThan(0)
      const contentSpan = removedLines[0].querySelector('span:last-child')
      expect(contentSpan).toHaveClass('text-red-400')
    })

    test('added lines do NOT use text-green-300', async () => {
      const { EditToolView } =
        await import('../../../src/renderer/src/components/sessions/tools/EditToolView')

      render(
        React.createElement(EditToolView, {
          name: 'Edit',
          input: { oldString: 'old line', newString: 'new line' },
          status: 'success'
        })
      )

      const addedLines = screen.getAllByTestId('diff-added')
      const contentSpan = addedLines[0].querySelector('span:last-child')
      expect(contentSpan).not.toHaveClass('text-green-300')
    })

    test('removed lines do NOT use text-red-300', async () => {
      const { EditToolView } =
        await import('../../../src/renderer/src/components/sessions/tools/EditToolView')

      render(
        React.createElement(EditToolView, {
          name: 'Edit',
          input: { oldString: 'old line', newString: 'new line' },
          status: 'success'
        })
      )

      const removedLines = screen.getAllByTestId('diff-removed')
      const contentSpan = removedLines[0].querySelector('span:last-child')
      expect(contentSpan).not.toHaveClass('text-red-300')
    })

    test('sign spans use correct colors (red-400 for minus, green-400 for plus)', async () => {
      const { EditToolView } =
        await import('../../../src/renderer/src/components/sessions/tools/EditToolView')

      render(
        React.createElement(EditToolView, {
          name: 'Edit',
          input: { oldString: 'old line', newString: 'new line' },
          status: 'success'
        })
      )

      // Removed line sign span (second span — after line number)
      const removedLines = screen.getAllByTestId('diff-removed')
      const removedSignSpan = removedLines[0].querySelectorAll('span')[1]
      expect(removedSignSpan).toHaveClass('text-red-400')

      // Added line sign span
      const addedLines = screen.getAllByTestId('diff-added')
      const addedSignSpan = addedLines[0].querySelectorAll('span')[1]
      expect(addedSignSpan).toHaveClass('text-green-400')
    })

    test('renders empty state when no old or new string', async () => {
      const { EditToolView } =
        await import('../../../src/renderer/src/components/sessions/tools/EditToolView')

      render(
        React.createElement(EditToolView, {
          name: 'Edit',
          input: { oldString: '', newString: '' },
          status: 'success'
        })
      )

      expect(screen.getByText('No changes')).toBeInTheDocument()
    })

    test('renders error state when error prop provided', async () => {
      const { EditToolView } =
        await import('../../../src/renderer/src/components/sessions/tools/EditToolView')

      render(
        React.createElement(EditToolView, {
          name: 'Edit',
          input: { oldString: 'old', newString: 'new' },
          error: 'Something went wrong',
          status: 'error'
        })
      )

      expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    })
  })
})
