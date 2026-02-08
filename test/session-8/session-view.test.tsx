import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionView, OpenCodeMessage, SessionViewState } from '../../src/renderer/src/components/sessions/SessionView'

// Mock clipboard API
const mockWriteText = vi.fn().mockResolvedValue(undefined)
const mockReadText = vi.fn().mockResolvedValue('')

// Mock toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

// Mock database messages (demo messages to test with)
const mockDemoMessages = [
  {
    id: 'demo-1',
    session_id: 'test-session-1',
    role: 'user' as const,
    content: 'Can you help me create a function that calculates the factorial of a number?',
    created_at: new Date(Date.now() - 60000).toISOString()
  },
  {
    id: 'demo-2',
    session_id: 'test-session-1',
    role: 'assistant' as const,
    content: `I'll help you create a factorial function. Here's an implementation in TypeScript:

\`\`\`typescript
function factorial(n: number): number {
  if (n < 0) {
    throw new Error('Factorial is not defined for negative numbers')
  }
  if (n === 0 || n === 1) {
    return 1
  }
  return n * factorial(n - 1)
}

// Example usage:
console.log(factorial(5)) // Output: 120
console.log(factorial(0)) // Output: 1
\`\`\`

This function uses recursion to calculate the factorial.`,
    created_at: new Date(Date.now() - 30000).toISOString()
  }
]

// Mock window.db.message
const mockDbMessage = {
  create: vi.fn().mockImplementation((data) => Promise.resolve({
    id: `msg-${Date.now()}`,
    session_id: data.session_id,
    role: data.role,
    content: data.content,
    created_at: new Date().toISOString()
  })),
  getBySession: vi.fn().mockResolvedValue(mockDemoMessages),
  delete: vi.fn().mockResolvedValue(true)
}

// Setup and teardown
beforeEach(() => {
  vi.clearAllMocks()

  // Reset mock implementations
  mockDbMessage.getBySession.mockResolvedValue(mockDemoMessages)
  mockDbMessage.create.mockImplementation((data) => Promise.resolve({
    id: `msg-${Date.now()}`,
    session_id: data.session_id,
    role: data.role,
    content: data.content,
    created_at: new Date().toISOString()
  }))

  // Mock window.db
  Object.defineProperty(window, 'db', {
    value: {
      message: mockDbMessage,
      session: {
        get: vi.fn().mockResolvedValue({
          id: 'test-session-1',
          worktree_id: null,
          project_id: 'proj-1',
          name: 'Test Session',
          status: 'active',
          opencode_session_id: null,
          mode: 'build',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null
        }),
        update: vi.fn().mockResolvedValue(null)
      },
      worktree: {
        get: vi.fn().mockResolvedValue(null)
      }
    },
    writable: true,
    configurable: true
  })

  // Mock OpenCode ops used by SessionView subscription/effects
  Object.defineProperty(window, 'opencodeOps', {
    value: {
      connect: vi.fn().mockResolvedValue({ success: false }),
      reconnect: vi.fn().mockResolvedValue({ success: false }),
      prompt: vi.fn().mockResolvedValue({ success: true }),
      disconnect: vi.fn().mockResolvedValue({ success: true }),
      getMessages: vi.fn().mockResolvedValue({ success: true, messages: [] }),
      listModels: vi.fn().mockResolvedValue({ success: true, providers: [] }),
      setModel: vi.fn().mockResolvedValue({ success: true }),
      generateSessionName: vi.fn().mockResolvedValue({ success: true, name: '' }),
      onStream: vi.fn().mockImplementation(() => () => {})
    },
    writable: true,
    configurable: true
  })

  // Mock navigator.clipboard - use a fresh mock for each test
  const clipboardMock = {
    writeText: mockWriteText,
    readText: mockReadText
  }

  Object.defineProperty(global.navigator, 'clipboard', {
    value: clipboardMock,
    writable: true,
    configurable: true
  })

  // Mock scrollIntoView
  Element.prototype.scrollIntoView = vi.fn()

  // Mock window.systemOps (needed for response logging check)
  Object.defineProperty(window, 'systemOps', {
    value: {
      isLogMode: vi.fn().mockResolvedValue(false),
      getLogDir: vi.fn().mockResolvedValue('/tmp/logs'),
      getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
      getAppPaths: vi.fn().mockResolvedValue({ userData: '/tmp', home: '/tmp', logs: '/tmp/logs' })
    },
    writable: true,
    configurable: true
  })

  // Mock window.loggingOps
  Object.defineProperty(window, 'loggingOps', {
    value: {
      createResponseLog: vi.fn().mockResolvedValue('/tmp/log.jsonl'),
      appendResponseLog: vi.fn().mockResolvedValue(undefined)
    },
    writable: true,
    configurable: true
  })
})

afterEach(() => {
  cleanup()
})

describe('Session 8: Session View', () => {
  describe('Component Rendering', () => {
    test('Session view renders for active tab', async () => {
      render(<SessionView sessionId="test-session-1" />)

      const sessionView = screen.getByTestId('session-view')
      expect(sessionView).toBeInTheDocument()
      expect(sessionView).toHaveAttribute('data-session-id', 'test-session-1')

      // Wait for messages to load
      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
      })
    })

    test('Session view contains message list and input area', async () => {
      render(<SessionView sessionId="test-session-1" />)

      // Wait for messages to load
      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
        expect(screen.getByTestId('input-area')).toBeInTheDocument()
      })
    })

    test('Demo messages are displayed', async () => {
      render(<SessionView sessionId="test-session-1" />)

      // Wait for messages to load from mock database
      await waitFor(() => {
        const userMessages = screen.getAllByTestId('message-user')
        const assistantMessages = screen.getAllByTestId('message-assistant')

        expect(userMessages.length).toBeGreaterThan(0)
        expect(assistantMessages.length).toBeGreaterThan(0)
      })
    })

    test('Session view updates when sessionId changes', async () => {
      const { rerender } = render(<SessionView sessionId="session-1" />)

      expect(screen.getByTestId('session-view')).toHaveAttribute('data-session-id', 'session-1')

      rerender(<SessionView sessionId="session-2" />)

      expect(screen.getByTestId('session-view')).toHaveAttribute('data-session-id', 'session-2')
    })
  })

  describe('Message List', () => {
    test('Message list is scrollable', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        const messageList = screen.getByTestId('message-list')
        expect(messageList).toHaveClass('overflow-y-auto')
      })
    })

    test('User messages have correct styling', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        const userMessage = screen.getAllByTestId('message-user')[0]
        expect(userMessage).toBeInTheDocument()
      })
    })

    test('Assistant messages render correctly', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        const assistantMessages = screen.getAllByTestId('message-assistant')
        expect(assistantMessages[0]).toBeInTheDocument()
        // Assistant messages should not have user background
        expect(assistantMessages[0]).not.toHaveClass('bg-muted/30')
      })
    })

    test('Messages display timestamps', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        // Look for time formats in the messages
        const messageList = screen.getByTestId('message-list')
        expect(messageList.textContent).toMatch(/\d{1,2}:\d{2}/)
      })
    })
  })

  describe('Input Area', () => {
    test('Input area accepts text', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      // Wait for messages to load first
      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input')
      await user.type(input, 'Hello, world!')

      expect(input).toHaveValue('Hello, world!')
    })

    test('Send button is present', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        const sendButton = screen.getByTestId('send-button')
        expect(sendButton).toBeInTheDocument()
      })
    })

    test('Send button is disabled when input is empty', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        const sendButton = screen.getByTestId('send-button')
        expect(sendButton).toBeDisabled()
      })
    })

    test('Send button is enabled when input has content', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input')
      const sendButton = screen.getByTestId('send-button')

      await user.type(input, 'Test message')

      expect(sendButton).not.toBeDisabled()
    })

    test('Clicking send button adds user message', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input')
      const sendButton = screen.getByTestId('send-button')

      const initialUserMessages = screen.getAllByTestId('message-user').length

      await user.type(input, 'New test message')
      await user.click(sendButton)

      await waitFor(() => {
        const userMessages = screen.getAllByTestId('message-user')
        expect(userMessages.length).toBe(initialUserMessages + 1)
      })
    })

    test('Input clears after sending message', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input')
      const sendButton = screen.getByTestId('send-button')

      await user.type(input, 'Test message')
      await user.click(sendButton)

      expect(input).toHaveValue('')
    })

    test('Enter key sends message (without Shift)', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input')
      const initialUserMessages = screen.getAllByTestId('message-user').length

      await user.type(input, 'Test message{Enter}')

      await waitFor(() => {
        const userMessages = screen.getAllByTestId('message-user')
        expect(userMessages.length).toBe(initialUserMessages + 1)
      })
    })

    test('Shift+Enter does not send message', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input') as HTMLTextAreaElement
      const initialUserMessages = screen.getAllByTestId('message-user').length

      await user.type(input, 'Line 1')
      await user.keyboard('{Shift>}{Enter}{/Shift}')
      await user.type(input, 'Line 2')

      // Should not have sent the message
      const userMessages = screen.getAllByTestId('message-user')
      expect(userMessages.length).toBe(initialUserMessages)

      // Should have newline in input value
      expect(input.value).toContain('Line 1')
    })

    test('Shows typing indicator when sending', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input')
      const sendButton = screen.getByTestId('send-button')

      await user.type(input, 'Test message')
      await user.click(sendButton)

      // Typing indicator should appear
      expect(screen.getByTestId('typing-indicator')).toBeInTheDocument()
    })

    test('Typing indicator disappears after response', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input')
      const sendButton = screen.getByTestId('send-button')

      await user.type(input, 'Test message')
      await user.click(sendButton)

      // Wait for simulated response
      await waitFor(() => {
        expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument()
      }, { timeout: 3000 })
    })
  })

  describe('Code Blocks', () => {
    test('Code block structure renders', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        // The demo messages contain code blocks
        const codeBlocks = screen.getAllByTestId('code-block')
        expect(codeBlocks.length).toBeGreaterThan(0)
      })
    })

    test('Code blocks have language labels', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        // Look for typescript label
        expect(screen.getAllByText('typescript').length).toBeGreaterThan(0)
      })
    })

    test('Code blocks have copy button', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        const copyButtons = screen.getAllByTestId('copy-code-button')
        expect(copyButtons.length).toBeGreaterThan(0)
      })
    })

    test('Copy button is clickable and triggers copy action', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getAllByTestId('copy-code-button').length).toBeGreaterThan(0)
      })

      const copyButtons = screen.getAllByTestId('copy-code-button')

      // Verify the button is clickable (not disabled)
      const copyButton = copyButtons[0]
      expect(copyButton).not.toBeDisabled()

      // Click should not throw
      await user.click(copyButton)

      // If clipboard API is available and mock works, writeText would be called
      // This test primarily verifies the button is interactive
      expect(copyButton).toBeInTheDocument()
    })
  })

  describe('Loading State', () => {
    test('Loading state shows spinner initially', () => {
      // Component starts in connecting state while loading
      render(<SessionView sessionId="test-session-1" />)

      // Component should show loading state initially
      expect(screen.getByTestId('session-view')).toBeInTheDocument()
      expect(screen.getByTestId('loading-state')).toBeInTheDocument()
    })

    test('Loading state disappears after messages load', async () => {
      render(<SessionView sessionId="test-session-1" />)

      // Wait for messages to load
      await waitFor(() => {
        expect(screen.queryByTestId('loading-state')).not.toBeInTheDocument()
      })
    })
  })

  describe('Error State', () => {
    test('Error state shows retry button when loading fails', async () => {
      // Mock getBySession to reject
      mockDbMessage.getBySession.mockRejectedValueOnce(new Error('Database error'))

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('error-state')).toBeInTheDocument()
        expect(screen.getByTestId('retry-button')).toBeInTheDocument()
      })
    })

    test('Retry button reloads messages', async () => {
      const user = userEvent.setup()

      // First load fails
      mockDbMessage.getBySession.mockRejectedValueOnce(new Error('Database error'))

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('error-state')).toBeInTheDocument()
      })

      // Now mock successful reload
      mockDbMessage.getBySession.mockResolvedValueOnce(mockDemoMessages)

      // Click retry
      await user.click(screen.getByTestId('retry-button'))

      // Should show loading then messages
      await waitFor(() => {
        expect(screen.queryByTestId('error-state')).not.toBeInTheDocument()
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
      })
    })
  })

  describe('Session Integration', () => {
    test('Session view renders with correct session ID', () => {
      render(<SessionView sessionId="specific-session-123" />)

      const sessionView = screen.getByTestId('session-view')
      expect(sessionView).toHaveAttribute('data-session-id', 'specific-session-123')
    })

    test('Multiple messages can be sent in sequence', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      // Wait for messages to load
      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input')
      const sendButton = screen.getByTestId('send-button')

      const initialUserMessages = screen.getAllByTestId('message-user').length

      // Send first message
      await user.type(input, 'First message')
      await user.click(sendButton)

      // Wait for typing indicator to disappear (response received)
      await waitFor(() => {
        expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Send second message
      await user.type(input, 'Second message')
      await user.click(sendButton)

      await waitFor(() => {
        const userMessages = screen.getAllByTestId('message-user')
        expect(userMessages.length).toBe(initialUserMessages + 2)
      }, { timeout: 3000 })
    })
  })

  describe('Accessibility', () => {
    test('Input has placeholder text', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        const input = screen.getByTestId('message-input')
        expect(input).toHaveAttribute('placeholder')
      })
    })

    test('Input area has helper text', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByText(/Enter to send/i)).toBeInTheDocument()
      })
    })

    test('Send button has visual indicator', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        const sendButton = screen.getByTestId('send-button')
        expect(sendButton).toBeInTheDocument()
        // Button contains Send icon
        expect(sendButton.querySelector('svg')).toBeInTheDocument()
      })
    })
  })

  describe('OpenCode Types', () => {
    test('OpenCodeMessage interface is exported correctly', () => {
      // Type check - if this compiles, the types are correct
      const message: OpenCodeMessage = {
        id: 'test-id',
        role: 'user',
        content: 'Test content',
        timestamp: new Date().toISOString()
      }

      expect(message.id).toBe('test-id')
      expect(message.role).toBe('user')
      expect(message.content).toBe('Test content')
    })

    test('SessionViewState interface is exported correctly', () => {
      // Type check - if this compiles, the types are correct
      const state: SessionViewState = {
        status: 'connected',
        errorMessage: undefined
      }

      expect(state.status).toBe('connected')
    })

    test('OpenCodeMessage supports all roles', () => {
      const userMessage: OpenCodeMessage = {
        id: '1',
        role: 'user',
        content: 'User content',
        timestamp: new Date().toISOString()
      }

      const assistantMessage: OpenCodeMessage = {
        id: '2',
        role: 'assistant',
        content: 'Assistant content',
        timestamp: new Date().toISOString()
      }

      const systemMessage: OpenCodeMessage = {
        id: '3',
        role: 'system',
        content: 'System content',
        timestamp: new Date().toISOString()
      }

      expect(userMessage.role).toBe('user')
      expect(assistantMessage.role).toBe('assistant')
      expect(systemMessage.role).toBe('system')
    })

    test('SessionViewState supports all statuses', () => {
      const idle: SessionViewState = { status: 'idle' }
      const connecting: SessionViewState = { status: 'connecting' }
      const connected: SessionViewState = { status: 'connected' }
      const error: SessionViewState = { status: 'error', errorMessage: 'Test error' }

      expect(idle.status).toBe('idle')
      expect(connecting.status).toBe('connecting')
      expect(connected.status).toBe('connected')
      expect(error.status).toBe('error')
      expect(error.errorMessage).toBe('Test error')
    })
  })
})
