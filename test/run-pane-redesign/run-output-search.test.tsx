import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { RunOutputSearch } from '../../src/renderer/src/components/layout/RunOutputSearch'
import { OutputRingBuffer } from '../../src/renderer/src/lib/output-ring-buffer'

describe('RunOutputSearch', () => {
  let onMatchesChange: ReturnType<typeof vi.fn>
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    onMatchesChange = vi.fn()
    onClose = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createBuffer(lines: string[]): OutputRingBuffer {
    const buf = new OutputRingBuffer()
    for (const line of lines) {
      buf.append(line)
    }
    return buf
  }

  function renderSearch(
    buffer: OutputRingBuffer,
    outputVersion = 0
  ): ReturnType<typeof render> {
    return render(
      <RunOutputSearch
        buffer={buffer}
        outputVersion={outputVersion}
        onMatchesChange={onMatchesChange}
        onClose={onClose}
      />
    )
  }

  describe('rendering', () => {
    test('renders search input, match counter, prev/next/close buttons', () => {
      const buf = createBuffer([])
      renderSearch(buf)

      expect(screen.getByTestId('run-search-input')).toBeDefined()
      expect(screen.getByTestId('run-search-count')).toBeDefined()
      expect(screen.getByTestId('run-search-prev')).toBeDefined()
      expect(screen.getByTestId('run-search-next')).toBeDefined()
      expect(screen.getByTestId('run-search-close')).toBeDefined()
    })

    test('focuses input on mount', () => {
      const buf = createBuffer([])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      expect(document.activeElement).toBe(input)
    })
  })

  describe('search behavior', () => {
    test('finds matches in plain text', () => {
      const buf = createBuffer(['hello world', 'hello again', 'goodbye'])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'hello' } })
      act(() => { vi.advanceTimersByTime(150) })

      expect(onMatchesChange).toHaveBeenCalledWith(
        [
          { lineIndex: 0, matchStart: 0, matchEnd: 5 },
          { lineIndex: 1, matchStart: 0, matchEnd: 5 }
        ],
        0
      )
    })

    test('case-insensitive matching', () => {
      const buf = createBuffer(['Hello World', 'HELLO', 'hello'])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'hello' } })
      act(() => { vi.advanceTimersByTime(150) })

      expect(onMatchesChange).toHaveBeenCalledWith(
        [
          { lineIndex: 0, matchStart: 0, matchEnd: 5 },
          { lineIndex: 1, matchStart: 0, matchEnd: 5 },
          { lineIndex: 2, matchStart: 0, matchEnd: 5 }
        ],
        0
      )
    })

    test('skips marker lines (\\x00CMD:, \\x00ERR:, \\x00TRUNC:)', () => {
      const buf = createBuffer([
        '\x00CMD:npm test',
        'test output hello',
        '\x00ERR:test failed hello',
        'hello again',
        '\x00TRUNC:truncated hello'
      ])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'hello' } })
      act(() => { vi.advanceTimersByTime(150) })

      // Only lines 1 and 3 (non-marker) should match
      expect(onMatchesChange).toHaveBeenCalledWith(
        [
          { lineIndex: 1, matchStart: 12, matchEnd: 17 },
          { lineIndex: 3, matchStart: 0, matchEnd: 5 }
        ],
        0
      )
    })

    test('strips ANSI codes before matching', () => {
      const buf = createBuffer([
        '\x1b[31mred hello\x1b[0m world',
        'plain hello'
      ])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'hello' } })
      act(() => { vi.advanceTimersByTime(150) })

      expect(onMatchesChange).toHaveBeenCalledWith(
        [
          { lineIndex: 0, matchStart: 4, matchEnd: 9 },
          { lineIndex: 1, matchStart: 6, matchEnd: 11 }
        ],
        0
      )
    })

    test('reports matches via onMatchesChange callback', () => {
      const buf = createBuffer(['foo bar foo'])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'foo' } })
      act(() => { vi.advanceTimersByTime(150) })

      expect(onMatchesChange).toHaveBeenCalledWith(
        [
          { lineIndex: 0, matchStart: 0, matchEnd: 3 },
          { lineIndex: 0, matchStart: 8, matchEnd: 11 }
        ],
        0
      )
    })

    test('handles empty buffer', () => {
      const buf = createBuffer([])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'test' } })
      act(() => { vi.advanceTimersByTime(150) })

      expect(onMatchesChange).toHaveBeenCalledWith([], 0)
    })
  })

  describe('keyboard navigation', () => {
    test('Enter navigates to next match', () => {
      const buf = createBuffer(['aaa', 'aaa', 'aaa'])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'aaa' } })
      act(() => { vi.advanceTimersByTime(150) })

      // Initial call is at index 0
      onMatchesChange.mockClear()

      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onMatchesChange).toHaveBeenCalledWith(
        expect.any(Array),
        1
      )
    })

    test('Shift+Enter navigates to previous match', () => {
      const buf = createBuffer(['aaa', 'aaa', 'aaa'])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'aaa' } })
      act(() => { vi.advanceTimersByTime(150) })

      // Move to index 1 first
      fireEvent.keyDown(input, { key: 'Enter' })
      onMatchesChange.mockClear()

      // Shift+Enter goes back to 0
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

      expect(onMatchesChange).toHaveBeenCalledWith(
        expect.any(Array),
        0
      )
    })

    test('Escape calls onClose', () => {
      const buf = createBuffer([])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('button navigation', () => {
    test('prev/next buttons cycle through matches with wrapping', () => {
      const buf = createBuffer(['x', 'x', 'x'])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'x' } })
      act(() => { vi.advanceTimersByTime(150) })

      // We start at index 0 with 3 matches
      onMatchesChange.mockClear()

      // Click next: 0 -> 1
      fireEvent.click(screen.getByTestId('run-search-next'))
      expect(onMatchesChange).toHaveBeenLastCalledWith(
        expect.any(Array),
        1
      )

      // Click next: 1 -> 2
      fireEvent.click(screen.getByTestId('run-search-next'))
      expect(onMatchesChange).toHaveBeenLastCalledWith(
        expect.any(Array),
        2
      )

      // Click next: 2 -> 0 (wrap)
      fireEvent.click(screen.getByTestId('run-search-next'))
      expect(onMatchesChange).toHaveBeenLastCalledWith(
        expect.any(Array),
        0
      )

      // Click prev: 0 -> 2 (wrap backward)
      fireEvent.click(screen.getByTestId('run-search-prev'))
      expect(onMatchesChange).toHaveBeenLastCalledWith(
        expect.any(Array),
        2
      )
    })

    test('close button calls onClose', () => {
      const buf = createBuffer([])
      renderSearch(buf)

      fireEvent.click(screen.getByTestId('run-search-close'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('display', () => {
    test('shows "No results" when query has no matches', () => {
      const buf = createBuffer(['hello world'])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'zzzzz' } })
      act(() => { vi.advanceTimersByTime(150) })

      const count = screen.getByTestId('run-search-count')
      expect(count.textContent).toBe('No results')
    })

    test('shows match count "N of M" format', () => {
      const buf = createBuffer(['ab ab ab'])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'ab' } })
      act(() => { vi.advanceTimersByTime(150) })

      const count = screen.getByTestId('run-search-count')
      expect(count.textContent).toBe('1 of 3')
    })

    test('shows empty string when no query entered', () => {
      const buf = createBuffer(['hello'])
      renderSearch(buf)

      const count = screen.getByTestId('run-search-count')
      expect(count.textContent).toBe('')
    })
  })

  describe('debounce', () => {
    test('debounces search (150ms)', () => {
      const buf = createBuffer(['hello world'])
      renderSearch(buf)

      // Clear any mount-time calls (empty-query clear)
      onMatchesChange.mockClear()

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'hello' } })

      // Search should not fire immediately (debounced)
      expect(onMatchesChange).not.toHaveBeenCalled()

      // Advance less than 150ms — should not have fired yet
      act(() => { vi.advanceTimersByTime(100) })
      expect(onMatchesChange).not.toHaveBeenCalled()

      // Complete the remaining time
      act(() => { vi.advanceTimersByTime(50) })
      expect(onMatchesChange).toHaveBeenCalledWith(
        [{ lineIndex: 0, matchStart: 0, matchEnd: 5 }],
        0
      )
    })

    test('cancels previous debounce when query changes rapidly', () => {
      const buf = createBuffer(['hello world'])
      renderSearch(buf)

      const input = screen.getByTestId('run-search-input')

      // Type 'hel' then quickly change to 'world'
      fireEvent.change(input, { target: { value: 'hel' } })
      act(() => { vi.advanceTimersByTime(100) })
      fireEvent.change(input, { target: { value: 'world' } })
      act(() => { vi.advanceTimersByTime(150) })

      // Should only find 'world', not 'hel'
      const lastCall = onMatchesChange.mock.calls[
        onMatchesChange.mock.calls.length - 1
      ]
      expect(lastCall[0]).toEqual([
        { lineIndex: 0, matchStart: 6, matchEnd: 11 }
      ])
    })
  })

  describe('re-search on outputVersion change', () => {
    test('re-searches when outputVersion changes', () => {
      const buf = createBuffer(['hello'])
      const { rerender } = renderSearch(buf, 0)

      const input = screen.getByTestId('run-search-input')
      fireEvent.change(input, { target: { value: 'hello' } })
      act(() => { vi.advanceTimersByTime(150) })

      // Verify search found the match (ignoring any mount-time calls)
      expect(onMatchesChange).toHaveBeenCalledWith(
        [{ lineIndex: 0, matchStart: 0, matchEnd: 5 }],
        0
      )

      // Add new line to buffer and bump version
      buf.append('hello again')
      onMatchesChange.mockClear()

      rerender(
        <RunOutputSearch
          buffer={buf}
          outputVersion={1}
          onMatchesChange={onMatchesChange}
          onClose={onClose}
        />
      )

      act(() => { vi.advanceTimersByTime(150) })

      // Should now find 2 matches
      expect(onMatchesChange).toHaveBeenCalledWith(
        [
          { lineIndex: 0, matchStart: 0, matchEnd: 5 },
          { lineIndex: 1, matchStart: 0, matchEnd: 5 }
        ],
        0
      )
    })
  })
})
