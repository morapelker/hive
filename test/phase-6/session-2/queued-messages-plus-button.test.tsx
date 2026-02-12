import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueuedIndicator } from '../../../src/renderer/src/components/sessions/QueuedIndicator'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Session 2: Queued Messages & Plus Button', () => {
  describe('QueuedIndicator', () => {
    test('QueuedIndicator hidden when count is 0', () => {
      const { container } = render(<QueuedIndicator count={0} />)
      expect(container.innerHTML).toBe('')
    })

    test('QueuedIndicator shows singular message for count 1', () => {
      render(<QueuedIndicator count={1} />)
      expect(screen.getByText('1 message queued')).toBeDefined()
    })

    test('QueuedIndicator shows plural messages for count > 1', () => {
      render(<QueuedIndicator count={2} />)
      expect(screen.getByText('2 messages queued')).toBeDefined()
    })

    test('QueuedIndicator shows count of 5', () => {
      render(<QueuedIndicator count={5} />)
      expect(screen.getByText('5 messages queued')).toBeDefined()
    })

    test('QueuedIndicator updates when count changes', () => {
      const { rerender } = render(<QueuedIndicator count={1} />)
      expect(screen.getByText('1 message queued')).toBeDefined()

      rerender(<QueuedIndicator count={3} />)
      expect(screen.getByText('3 messages queued')).toBeDefined()
    })

    test('QueuedIndicator disappears when count goes to 0', () => {
      const { container, rerender } = render(<QueuedIndicator count={2} />)
      expect(screen.getByText('2 messages queued')).toBeDefined()

      rerender(<QueuedIndicator count={0} />)
      expect(container.innerHTML).toBe('')
    })
  })
})
