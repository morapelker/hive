import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'
import { subsequenceMatch } from '../../../src/renderer/src/lib/subsequence-match'

// ---------------------------------------------------------------------------
// subsequenceMatch tests
// ---------------------------------------------------------------------------
describe('Session 2: Project Filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
  })

  describe('subsequenceMatch', () => {
    test('exact match returns indices', () => {
      const result = subsequenceMatch('abc', 'abc')
      expect(result.matched).toBe(true)
      expect(result.indices).toEqual([0, 1, 2])
      expect(result.score).toBe(0)
    })

    test('subsequence match with gaps', () => {
      const result = subsequenceMatch('ace', 'abcde')
      expect(result.matched).toBe(true)
      expect(result.indices).toEqual([0, 2, 4])
      expect(result.score).toBe(2) // gaps: (2-0-1) + (4-2-1) = 1+1
    })

    test('no match returns matched=false', () => {
      const result = subsequenceMatch('xyz', 'abcde')
      expect(result.matched).toBe(false)
      expect(result.indices).toEqual([])
    })

    test('case insensitive', () => {
      const result = subsequenceMatch('ABC', 'abcdef')
      expect(result.matched).toBe(true)
      expect(result.indices).toEqual([0, 1, 2])
    })

    test('"orders" matches "tedooo-orders"', () => {
      const result = subsequenceMatch('orders', 'tedooo-orders')
      expect(result.matched).toBe(true)
    })

    test('"orders" matches "ordjjrekekqerjskjs"', () => {
      const result = subsequenceMatch('orders', 'ordjjrekekqerjskjs')
      expect(result.matched).toBe(true)
    })

    test('"xyz" does NOT match "tedooo-orders"', () => {
      const result = subsequenceMatch('xyz', 'tedooo-orders')
      expect(result.matched).toBe(false)
    })

    test('empty query matches everything', () => {
      const result = subsequenceMatch('', 'anything')
      expect(result.matched).toBe(true)
      expect(result.indices).toEqual([])
      expect(result.score).toBe(0)
    })

    test('query longer than target does not match', () => {
      const result = subsequenceMatch('abcdef', 'abc')
      expect(result.matched).toBe(false)
    })

    test('contiguous match scores lower than spread match', () => {
      const contiguous = subsequenceMatch('abc', 'xabcx')
      const spread = subsequenceMatch('abc', 'xaxbxcx')
      expect(contiguous.score).toBeLessThan(spread.score)
    })
  })

  // ---------------------------------------------------------------------------
  // HighlightedText tests
  // ---------------------------------------------------------------------------
  describe('HighlightedText', () => {
    test('renders highlighted characters at correct indices', async () => {
      const { HighlightedText } = await import(
        '../../../src/renderer/src/components/projects/HighlightedText'
      )
      const { container } = render(
        React.createElement(HighlightedText, {
          text: 'hello',
          indices: [1, 3]
        })
      )

      const spans = container.querySelectorAll('span > span')
      // Index 1 ('e') and index 3 ('l') should have text-primary class
      expect(spans[1].className).toContain('text-primary')
      expect(spans[3].className).toContain('text-primary')
      // Others should not
      expect(spans[0].className).not.toContain('text-primary')
      expect(spans[2].className).not.toContain('text-primary')
      expect(spans[4].className).not.toContain('text-primary')
    })

    test('renders all chars normal when indices empty', async () => {
      const { HighlightedText } = await import(
        '../../../src/renderer/src/components/projects/HighlightedText'
      )
      const { container } = render(
        React.createElement(HighlightedText, {
          text: 'hello',
          indices: []
        })
      )

      const highlighted = container.querySelectorAll('.text-primary')
      expect(highlighted.length).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // ProjectFilter tests
  // ---------------------------------------------------------------------------
  describe('ProjectFilter', () => {
    test('renders search input with placeholder', async () => {
      const { ProjectFilter } = await import(
        '../../../src/renderer/src/components/projects/ProjectFilter'
      )
      render(
        React.createElement(ProjectFilter, {
          value: '',
          onChange: vi.fn()
        })
      )

      const input = screen.getByTestId('project-filter-input')
      expect(input).toBeTruthy()
      expect(input.getAttribute('placeholder')).toBe('Filter projects...')
    })

    test('calls onChange on input', async () => {
      const onChange = vi.fn()
      const { ProjectFilter } = await import(
        '../../../src/renderer/src/components/projects/ProjectFilter'
      )
      render(
        React.createElement(ProjectFilter, {
          value: '',
          onChange
        })
      )

      const input = screen.getByTestId('project-filter-input')
      fireEvent.change(input, { target: { value: 'test' } })
      expect(onChange).toHaveBeenCalledWith('test')
    })

    test('Escape clears input', async () => {
      const onChange = vi.fn()
      const { ProjectFilter } = await import(
        '../../../src/renderer/src/components/projects/ProjectFilter'
      )
      render(
        React.createElement(ProjectFilter, {
          value: 'test',
          onChange
        })
      )

      const input = screen.getByTestId('project-filter-input')
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(onChange).toHaveBeenCalledWith('')
    })

    test('clear button visible when value is non-empty', async () => {
      const { ProjectFilter } = await import(
        '../../../src/renderer/src/components/projects/ProjectFilter'
      )
      render(
        React.createElement(ProjectFilter, {
          value: 'test',
          onChange: vi.fn()
        })
      )

      expect(screen.getByTestId('project-filter-clear')).toBeTruthy()
    })

    test('clear button not visible when value is empty', async () => {
      const { ProjectFilter } = await import(
        '../../../src/renderer/src/components/projects/ProjectFilter'
      )
      render(
        React.createElement(ProjectFilter, {
          value: '',
          onChange: vi.fn()
        })
      )

      expect(screen.queryByTestId('project-filter-clear')).toBeNull()
    })
  })
})
