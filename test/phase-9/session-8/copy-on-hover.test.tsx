import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CopyMessageButton } from '@/components/sessions/CopyMessageButton'
import { MessageRenderer } from '@/components/sessions/MessageRenderer'

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

// Mock navigator.clipboard
const writeTextMock = vi.fn().mockResolvedValue(undefined)
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  writable: true
})

describe('Session 8: Copy on Hover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('CopyMessageButton', () => {
    test('renders for non-empty content', () => {
      render(<CopyMessageButton content="Hello world" />)
      const button = screen.getByTestId('copy-message-button')
      expect(button).toBeInTheDocument()
    })

    test('hidden for empty content', () => {
      const { container } = render(<CopyMessageButton content="" />)
      expect(container.innerHTML).toBe('')
    })

    test('hidden for whitespace-only content', () => {
      const { container } = render(<CopyMessageButton content="   " />)
      expect(container.innerHTML).toBe('')
    })

    test('clicking copy writes to clipboard', async () => {
      const { toast } = await import('sonner')
      render(<CopyMessageButton content="Hello world" />)
      const button = screen.getByTestId('copy-message-button')

      fireEvent.click(button)

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith('Hello world')
        expect(toast.success).toHaveBeenCalledWith('Copied to clipboard', expect.any(Object))
      })
    })

    test('shows check icon after copy', async () => {
      render(<CopyMessageButton content="Hello world" />)
      const button = screen.getByTestId('copy-message-button')

      fireEvent.click(button)

      await waitFor(() => {
        expect(button.querySelector('svg')).toBeInTheDocument()
      })
    })

    test('shows error toast on clipboard failure', async () => {
      writeTextMock.mockRejectedValueOnce(new Error('Clipboard blocked'))
      const { toast } = await import('sonner')
      render(<CopyMessageButton content="Hello world" />)
      const button = screen.getByTestId('copy-message-button')

      fireEvent.click(button)

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to copy', expect.any(Object))
      })
    })

    test('has opacity-0 class for hover reveal', () => {
      render(<CopyMessageButton content="Hello world" />)
      const button = screen.getByTestId('copy-message-button')
      expect(button.className).toContain('opacity-0')
      expect(button.className).toContain('group-hover:opacity-100')
    })

    test('has absolute positioning', () => {
      render(<CopyMessageButton content="Hello world" />)
      const button = screen.getByTestId('copy-message-button')
      expect(button.className).toContain('absolute')
    })
  })

  describe('MessageRenderer', () => {
    test('wraps with group class for user messages', () => {
      const message = {
        id: 'msg-1',
        role: 'user' as const,
        content: 'Hello',
        timestamp: new Date().toISOString()
      }
      const { container } = render(<MessageRenderer message={message} />)
      const wrapper = container.firstElementChild
      expect(wrapper?.classList.contains('group')).toBe(true)
      expect(wrapper?.classList.contains('relative')).toBe(true)
    })

    test('wraps with group class for assistant messages', () => {
      const message = {
        id: 'msg-2',
        role: 'assistant' as const,
        content: 'Hi there!',
        timestamp: new Date().toISOString()
      }
      const { container } = render(<MessageRenderer message={message} />)
      const wrapper = container.firstElementChild
      expect(wrapper?.classList.contains('group')).toBe(true)
      expect(wrapper?.classList.contains('relative')).toBe(true)
    })

    test('renders CopyMessageButton inside wrapper', () => {
      const message = {
        id: 'msg-3',
        role: 'user' as const,
        content: 'Test message',
        timestamp: new Date().toISOString()
      }
      render(<MessageRenderer message={message} />)
      expect(screen.getByTestId('copy-message-button')).toBeInTheDocument()
    })

    test('does not render CopyMessageButton for empty content', () => {
      const message = {
        id: 'msg-4',
        role: 'user' as const,
        content: '',
        timestamp: new Date().toISOString()
      }
      render(<MessageRenderer message={message} />)
      expect(screen.queryByTestId('copy-message-button')).not.toBeInTheDocument()
    })

    test('renders fork button for assistant messages', () => {
      const onFork = vi.fn()
      const message = {
        id: 'assistant-msg-1',
        role: 'assistant' as const,
        content: 'Assistant response',
        timestamp: new Date().toISOString()
      }

      render(<MessageRenderer message={message} onForkAssistantMessage={onFork} />)

      expect(screen.getByTestId('fork-message-button')).toBeInTheDocument()
    })

    test('does not render fork button for user messages', () => {
      const onFork = vi.fn()
      const message = {
        id: 'user-msg-1',
        role: 'user' as const,
        content: 'User message',
        timestamp: new Date().toISOString()
      }

      render(<MessageRenderer message={message} onForkAssistantMessage={onFork} />)

      expect(screen.queryByTestId('fork-message-button')).not.toBeInTheDocument()
    })

    test('calls fork callback with message when clicking fork button', () => {
      const onFork = vi.fn()
      const message = {
        id: 'assistant-msg-2',
        role: 'assistant' as const,
        content: 'Assistant response',
        timestamp: new Date().toISOString()
      }

      render(<MessageRenderer message={message} onForkAssistantMessage={onFork} />)

      fireEvent.click(screen.getByTestId('fork-message-button'))
      expect(onFork).toHaveBeenCalledWith(message)
    })
  })
})
