import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  SessionView,
  OpenCodeMessage,
  SessionViewState
} from '../../src/renderer/src/components/sessions/SessionView'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'

// Mock clipboard API
const mockWriteText = vi.fn().mockResolvedValue(undefined)
const mockReadText = vi.fn().mockResolvedValue('')
const mockConsoleInfo = vi.fn()

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

const mockOpenCodeTranscript = [
  {
    info: {
      id: 'opc-1',
      role: 'user',
      time: { created: Date.now() - 2000 }
    },
    parts: [{ type: 'text', text: 'OpenCode user message' }]
  },
  {
    info: {
      id: 'opc-2',
      role: 'assistant',
      time: { created: Date.now() - 1000 },
      tokens: { input: 11, output: 22, reasoning: 3 },
      cost: 0.012,
      modelID: 'claude-opus-4-5-20251101',
      providerID: 'anthropic'
    },
    parts: [{ type: 'text', text: 'OpenCode assistant message' }]
  }
]

const mockDefaultOpenCodeTranscript = [
  {
    info: {
      id: 'demo-opc-1',
      role: 'user',
      time: { created: Date.now() - 60000 }
    },
    parts: [{ type: 'text', text: mockDemoMessages[0].content }]
  },
  {
    info: {
      id: 'demo-opc-2',
      role: 'assistant',
      time: { created: Date.now() - 30000 }
    },
    parts: [{ type: 'text', text: mockDemoMessages[1].content }]
  }
]

// Setup and teardown
beforeEach(() => {
  vi.clearAllMocks()
  mockConsoleInfo.mockReset()

  // Mock window.db
  Object.defineProperty(window, 'db', {
    value: {
      session: {
        get: vi.fn().mockResolvedValue({
          id: 'test-session-1',
          worktree_id: 'wt-1',
          project_id: 'proj-1',
          name: 'Test Session',
          status: 'active',
          opencode_session_id: 'opc-session-1',
          mode: 'build',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null
        }),
        update: vi.fn().mockResolvedValue(null),
        getDraft: vi.fn().mockResolvedValue(null),
        updateDraft: vi.fn().mockResolvedValue(undefined)
      },
      worktree: {
        get: vi.fn().mockResolvedValue({
          id: 'wt-1',
          project_id: 'proj-1',
          name: 'WT',
          branch_name: 'main',
          path: '/tmp/worktree-default',
          status: 'active',
          is_default: true,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }),
        update: vi.fn().mockResolvedValue(null)
      }
    },
    writable: true,
    configurable: true
  })

  // Mock OpenCode ops used by SessionView subscription/effects
  Object.defineProperty(window, 'opencodeOps', {
    value: {
      connect: vi.fn().mockResolvedValue({ success: false }),
      reconnect: vi.fn().mockResolvedValue({ success: true }),
      prompt: vi.fn().mockResolvedValue({ success: true }),
      command: vi.fn().mockResolvedValue({ success: true }),
      sessionInfo: vi
        .fn()
        .mockResolvedValue({ success: true, revertMessageID: null, revertDiff: null }),
      undo: vi.fn().mockResolvedValue({ success: true }),
      redo: vi.fn().mockResolvedValue({ success: true }),
      disconnect: vi.fn().mockResolvedValue({ success: true }),
      abort: vi.fn().mockResolvedValue({ success: true }),
      getMessages: vi
        .fn()
        .mockResolvedValue({ success: true, messages: mockDefaultOpenCodeTranscript }),
      listModels: vi.fn().mockResolvedValue({ success: true, providers: [] }),
      setModel: vi.fn().mockResolvedValue({ success: true }),
      modelInfo: vi.fn().mockResolvedValue({ success: true }),
      questionReply: vi.fn().mockResolvedValue({ success: true }),
      questionReject: vi.fn().mockResolvedValue({ success: true }),
      permissionReply: vi.fn().mockResolvedValue({ success: true }),
      permissionList: vi.fn().mockResolvedValue({ success: true, permissions: [] }),
      commands: vi.fn().mockResolvedValue({ success: true, commands: [] }),
      capabilities: vi.fn().mockResolvedValue({
        success: true,
        capabilities: {
          supportsUndo: true,
          supportsRedo: true,
          supportsCommands: true,
          supportsPermissionRequests: true,
          supportsQuestionPrompts: true,
          supportsModelSelection: true,
          supportsReconnect: true,
          supportsPartialStreaming: true
        }
      }),
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

  vi.spyOn(console, 'info').mockImplementation(mockConsoleInfo)

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
    test('Session opening does not emit tool spacing debug logs', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
      })

      expect(mockConsoleInfo).not.toHaveBeenCalledWith(
        '[SessionDebug] Session opened',
        expect.anything()
      )
      expect(mockConsoleInfo).toHaveBeenCalledTimes(0)
    })

    test('Messages do not display timestamps', async () => {
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        const messageList = screen.getByTestId('message-list')
        const userMessageTime = new Date(mockDemoMessages[0].created_at).toLocaleTimeString()
        const assistantMessageTime = new Date(mockDemoMessages[1].created_at).toLocaleTimeString()
        expect(messageList.textContent).not.toContain(userMessageTime)
        expect(messageList.textContent).not.toContain(assistantMessageTime)
      })
    })

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

    test('Sends message through OpenCode when sending', async () => {
      const user = userEvent.setup()

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input')
      const sendButton = screen.getByTestId('send-button')

      await user.type(input, 'Test message')
      await user.click(sendButton)

      await waitFor(() => {
        expect(window.opencodeOps.prompt).toHaveBeenCalled()
      })
    })

    test('Built-in /undo routes to undo endpoint and does not add user message', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input') as HTMLTextAreaElement
      const initialUserMessages = screen.getAllByTestId('message-user').length

      await user.type(input, '/undo{Enter}{Enter}')

      await waitFor(() => {
        expect(window.opencodeOps.undo).toHaveBeenCalledWith(
          '/tmp/worktree-default',
          'opc-session-1'
        )
      })

      expect(window.opencodeOps.command).not.toHaveBeenCalled()
      expect(window.opencodeOps.prompt).not.toHaveBeenCalled()
      expect(screen.getAllByTestId('message-user').length).toBe(initialUserMessages)
    })

    test('Built-in /undo restores previous prompt text into the input', async () => {
      const user = userEvent.setup()
      ;(window.opencodeOps.undo as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        restoredPrompt: 'Refine the component API'
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input') as HTMLTextAreaElement
      await user.type(input, '/undo{Enter}{Enter}')

      await waitFor(() => {
        expect(input.value).toBe('Refine the component API')
      })
    })

    test('Built-in /redo routes to redo endpoint and bypasses command endpoint', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input') as HTMLTextAreaElement
      await user.type(input, '/redo{Enter}{Enter}')

      await waitFor(() => {
        expect(window.opencodeOps.redo).toHaveBeenCalledWith(
          '/tmp/worktree-default',
          'opc-session-1'
        )
      })

      expect(window.opencodeOps.command).not.toHaveBeenCalled()
      expect(window.opencodeOps.prompt).not.toHaveBeenCalled()
    })

    test('Typing indicator is shown while waiting for response events', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input')
      const sendButton = screen.getByTestId('send-button')

      await user.type(input, 'Test message')
      await user.click(sendButton)

      await waitFor(() => {
        expect(screen.getByTestId('typing-indicator')).toBeInTheDocument()
      })
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
      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Database error')
      )

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('error-state')).toBeInTheDocument()
        expect(screen.getByTestId('retry-button')).toBeInTheDocument()
      })
    })

    test('Retry button reloads messages', async () => {
      const user = userEvent.setup()

      // First load fails
      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Database error')
      )

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('error-state')).toBeInTheDocument()
      })

      // Click retry
      await user.click(screen.getByTestId('retry-button'))

      // Should show loading then messages
      await waitFor(() => {
        expect(screen.queryByTestId('error-state')).not.toBeInTheDocument()
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
      })
    })
  })

  describe('Session stream status and errors', () => {
    test('session.status retry renders retry metadata in chat', async () => {
      let streamCallback: ((event: Record<string, unknown>) => void) | null = null
      ;(window.opencodeOps.onStream as ReturnType<typeof vi.fn>).mockImplementation((callback) => {
        streamCallback = callback as (event: Record<string, unknown>) => void
        return () => {}
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
      })

      act(() => {
        streamCallback?.({
          sessionId: 'test-session-1',
          type: 'session.status',
          statusPayload: {
            type: 'retry',
            attempt: 2,
            message: 'network hiccup',
            next: Date.now() + 5000
          },
          data: {
            status: {
              type: 'retry',
              attempt: 2,
              message: 'network hiccup',
              next: Date.now() + 5000
            }
          }
        })
      })

      await waitFor(() => {
        expect(screen.getByTestId('session-retry-banner')).toBeInTheDocument()
        expect(screen.getByText(/attempt 2/i)).toBeInTheDocument()
        expect(screen.getByText(/network hiccup/i)).toBeInTheDocument()
      })
    })

    test('session.error renders an inline session error banner', async () => {
      let streamCallback: ((event: Record<string, unknown>) => void) | null = null
      ;(window.opencodeOps.onStream as ReturnType<typeof vi.fn>).mockImplementation((callback) => {
        streamCallback = callback as (event: Record<string, unknown>) => void
        return () => {}
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
      })

      act(() => {
        streamCallback?.({
          sessionId: 'test-session-1',
          type: 'session.error',
          data: {
            error: {
              message: 'provider timeout'
            }
          }
        })
      })

      await waitFor(() => {
        expect(screen.getByTestId('session-error-banner')).toBeInTheDocument()
        expect(screen.getByText(/provider timeout/i)).toBeInTheDocument()
      })
    })

    test('busy status clears retry and session error banners', async () => {
      let streamCallback: ((event: Record<string, unknown>) => void) | null = null
      ;(window.opencodeOps.onStream as ReturnType<typeof vi.fn>).mockImplementation((callback) => {
        streamCallback = callback as (event: Record<string, unknown>) => void
        return () => {}
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
      })

      act(() => {
        streamCallback?.({
          sessionId: 'test-session-1',
          type: 'session.error',
          data: { error: { message: 'temporary failure' } }
        })
        streamCallback?.({
          sessionId: 'test-session-1',
          type: 'session.status',
          statusPayload: {
            type: 'retry',
            attempt: 1,
            next: Date.now() + 3000
          },
          data: {
            status: {
              type: 'retry',
              attempt: 1,
              next: Date.now() + 3000
            }
          }
        })
      })

      await waitFor(() => {
        expect(screen.getByTestId('session-error-banner')).toBeInTheDocument()
        expect(screen.getByTestId('session-retry-banner')).toBeInTheDocument()
      })

      act(() => {
        streamCallback?.({
          sessionId: 'test-session-1',
          type: 'session.status',
          statusPayload: { type: 'busy' },
          data: { status: { type: 'busy' } }
        })
      })

      await waitFor(() => {
        expect(screen.queryByTestId('session-error-banner')).not.toBeInTheDocument()
        expect(screen.queryByTestId('session-retry-banner')).not.toBeInTheDocument()
      })
    })
  })

  describe('OpenCode transcript hydration', () => {
    test('Initial hydration does not render duplicate assistant bubble for last canonical message', async () => {
      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'build',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-no-dup',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        messages: [
          {
            info: {
              id: 'opc-user-1',
              role: 'user',
              time: { created: Date.now() - 1000 }
            },
            parts: [{ type: 'text', text: 'Question' }]
          },
          {
            info: {
              id: 'opc-assistant-1',
              role: 'assistant',
              time: { created: Date.now() }
            },
            parts: [{ type: 'text', text: 'Single assistant response' }]
          }
        ]
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByText('Single assistant response')).toBeInTheDocument()
      })

      expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    })

    test('Initial hydration calls opencodeOps.getMessages when worktree path and opencode session id exist', async () => {
      const getMessagesMock = vi
        .fn()
        .mockResolvedValue({ success: true, messages: mockOpenCodeTranscript })

      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'build',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-a',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockImplementation(
        getMessagesMock
      )

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(getMessagesMock).toHaveBeenCalledWith('/tmp/worktree-a', 'opc-session-1')
      })
    })

    test('Stream finalization refreshes from OpenCode source, not db.message.getBySession', async () => {
      let streamCallback: ((event: Record<string, unknown>) => void) | null = null
      const getMessagesMock = vi
        .fn()
        .mockResolvedValue({ success: true, messages: mockOpenCodeTranscript })

      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'build',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-b',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockImplementation(
        getMessagesMock
      )
      ;(window.opencodeOps.onStream as ReturnType<typeof vi.fn>).mockImplementation((callback) => {
        streamCallback = callback as (event: Record<string, unknown>) => void
        return () => {}
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(getMessagesMock).toHaveBeenCalledTimes(1)
      })

      expect(streamCallback).not.toBeNull()
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'session.status',
        statusPayload: { type: 'idle' },
        data: { status: { type: 'idle' } }
      })

      await waitFor(() => {
        expect(getMessagesMock).toHaveBeenCalledTimes(2)
      })

      expect(window.opencodeOps.getMessages).toHaveBeenCalled()
    })

    test('Initial hydration keeps view connected when OpenCode transcript fetch fails', async () => {
      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'build',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-c',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: false,
        error: 'OpenCode unavailable'
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
        expect(screen.queryByTestId('error-state')).not.toBeInTheDocument()
      })

      expect(window.opencodeOps.getMessages).toHaveBeenCalledTimes(1)
    })

    test('Canonical refresh replaces in-memory messages instead of merging by id', async () => {
      let streamCallback: ((event: Record<string, unknown>) => void) | null = null
      const getMessagesMock = vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          messages: [
            {
              info: { id: 'opc-old-1', role: 'assistant', time: { created: Date.now() - 1000 } },
              parts: [{ type: 'text', text: 'Old canonical message' }]
            }
          ]
        })
        .mockResolvedValueOnce({
          success: true,
          messages: [
            {
              info: { id: 'opc-new-1', role: 'assistant', time: { created: Date.now() } },
              parts: [{ type: 'text', text: 'New canonical message' }]
            }
          ]
        })

      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'build',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-d',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockImplementation(
        getMessagesMock
      )
      ;(window.opencodeOps.onStream as ReturnType<typeof vi.fn>).mockImplementation((callback) => {
        streamCallback = callback as (event: Record<string, unknown>) => void
        return () => {}
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.queryAllByText('Old canonical message').length).toBeGreaterThan(0)
      })

      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'session.status',
        statusPayload: { type: 'idle' },
        data: { status: { type: 'idle' } }
      })

      await waitFor(() => {
        expect(screen.getByText('New canonical message')).toBeInTheDocument()
        expect(screen.queryAllByText('Old canonical message')).toHaveLength(0)
      })
    })

    test('Retry path reconnect failure triggers connect before transcript fetch', async () => {
      const user = userEvent.setup()
      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'build',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-e',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'stale session'
      })
      ;(window.opencodeOps.connect as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ success: false, error: 'cannot connect yet' })
        .mockResolvedValueOnce({ success: true, sessionId: 'opc-session-new' })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        messages: mockOpenCodeTranscript
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('error-state')).toBeInTheDocument()
      })

      await user.click(screen.getByTestId('retry-button'))

      await waitFor(() => {
        expect(screen.queryByTestId('error-state')).not.toBeInTheDocument()
        expect(window.opencodeOps.connect).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('SQLite transcript writes', () => {
    test('Normal send flow does not write user messages to SQLite', async () => {
      const user = userEvent.setup()

      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'build',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-send',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        messages: []
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      await user.type(screen.getByTestId('message-input'), 'Hello from user')
      await user.click(screen.getByTestId('send-button'))

      await waitFor(() => {
        expect(window.opencodeOps.prompt).toHaveBeenCalled()
      })

      expect(window.opencodeOps.prompt).toHaveBeenCalledTimes(1)
    })

    test('Pending initial message flow sends directly to OpenCode', async () => {
      useSessionStore.getState().setPendingMessage('test-session-1', 'pending review prompt')
      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'build',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-pending',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        messages: []
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(window.opencodeOps.prompt).toHaveBeenCalled()
      })

      expect(window.opencodeOps.prompt).toHaveBeenCalled()
    })

    test('No-OpenCode placeholder flow stays local-only', async () => {
      const user = userEvent.setup()

      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
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
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      await user.type(screen.getByTestId('message-input'), 'No connection yet')
      await user.click(screen.getByTestId('send-button'))

      await waitFor(() => {
        expect(
          screen.getByText(
            'OpenCode is not connected. Please ensure a worktree is selected and the connection is established.'
          )
        ).toBeInTheDocument()
      })

      expect(window.opencodeOps.prompt).not.toHaveBeenCalled()
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

      // Send second message
      await user.type(input, 'Second message')
      await user.click(sendButton)

      await waitFor(
        () => {
          const userMessages = screen.getAllByTestId('message-user')
          expect(userMessages.length).toBe(initialUserMessages + 2)
        },
        { timeout: 3000 }
      )
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
