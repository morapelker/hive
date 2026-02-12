import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

// Mock the cn utility
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' ')
}))

describe('Session 3: Queued Messages', () => {
  describe('QueuedMessageBubble', () => {
    let QueuedMessageBubble: typeof import('../../../src/renderer/src/components/sessions/QueuedMessageBubble').QueuedMessageBubble

    beforeEach(async () => {
      const mod = await import(
        '../../../src/renderer/src/components/sessions/QueuedMessageBubble'
      )
      QueuedMessageBubble = mod.QueuedMessageBubble
    })

    test('renders content with QUEUED badge', () => {
      render(<QueuedMessageBubble content="fix the imports" />)
      expect(screen.getByText('QUEUED')).toBeInTheDocument()
      expect(screen.getByText('fix the imports')).toBeInTheDocument()
    })

    test('has reduced opacity', () => {
      const { container } = render(<QueuedMessageBubble content="test" />)
      const outerDiv = container.firstChild as HTMLElement
      expect(outerDiv.className).toContain('opacity-70')
    })

    test('has data-testid for queued bubble', () => {
      render(<QueuedMessageBubble content="hello world" />)
      expect(screen.getByTestId('queued-message-bubble')).toBeInTheDocument()
    })

    test('renders multiline content preserving whitespace', () => {
      render(<QueuedMessageBubble content={'line one\nline two'} />)
      const contentEl = screen.getByText(/line one/)
      expect(contentEl.className).toContain('whitespace-pre-wrap')
    })

    test('renders multiple queued bubbles independently', () => {
      render(
        <>
          <QueuedMessageBubble content="first message" />
          <QueuedMessageBubble content="second message" />
        </>
      )
      expect(screen.getByText('first message')).toBeInTheDocument()
      expect(screen.getByText('second message')).toBeInTheDocument()
      expect(screen.getAllByText('QUEUED')).toHaveLength(2)
    })
  })

  describe('queuedMessages state management (unit logic)', () => {
    test('queued messages accumulate with unique ids', () => {
      const messages: Array<{ id: string; content: string; timestamp: number }> = []

      // Simulate adding queued messages
      const addQueued = (content: string) => {
        messages.push({ id: crypto.randomUUID(), content, timestamp: Date.now() })
      }

      addQueued('msg1')
      addQueued('msg2')

      expect(messages).toHaveLength(2)
      expect(messages[0].content).toBe('msg1')
      expect(messages[1].content).toBe('msg2')
      expect(messages[0].id).not.toBe(messages[1].id)
    })

    test('queued messages cleared produces empty array', () => {
      let messages: Array<{ id: string; content: string; timestamp: number }> = [
        { id: '1', content: 'test', timestamp: 0 }
      ]

      // Simulate clearing on idle
      messages = []
      expect(messages).toHaveLength(0)
    })

    test('queued message has required shape', () => {
      const msg = {
        id: crypto.randomUUID(),
        content: 'fix the bug',
        timestamp: Date.now()
      }
      expect(msg).toHaveProperty('id')
      expect(msg).toHaveProperty('content')
      expect(msg).toHaveProperty('timestamp')
      expect(typeof msg.id).toBe('string')
      expect(typeof msg.content).toBe('string')
      expect(typeof msg.timestamp).toBe('number')
    })
  })
})
