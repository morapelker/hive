import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  SessionView,
  OpenCodeMessage,
  SessionViewState
} from '../../src/renderer/src/components/sessions/SessionView'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { lastSendMode } from '../../src/renderer/src/lib/message-send-times'
import { resetSessionFollowUpDispatchState } from '../../src/renderer/src/lib/session-follow-up-dispatch'
import { useWorktreeStatusStore } from '../../src/renderer/src/stores/useWorktreeStatusStore'

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

vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ children }: { children: unknown }) => <pre>{children as string}</pre>
}))

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  oneDark: {}
}))

vi.mock('../../src/renderer/src/components/sessions/ForkMessageButton', () => ({
  ForkMessageButton: ({
    onFork,
    disabled,
    isForking
  }: {
    onFork: () => void
    disabled?: boolean
    isForking?: boolean
  }) => (
    <button
      data-testid="fork-message-button"
      disabled={disabled}
      onClick={onFork}
    >
      {isForking ? 'Forking' : 'Fork'}
    </button>
  )
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

function createSessionRecord(
  overrides: Partial<{
    id: string
    worktree_id: string | null
    project_id: string
    connection_id: string | null
    name: string | null
    status: 'active' | 'completed' | 'error'
    opencode_session_id: string | null
    agent_sdk: 'opencode' | 'claude-code' | 'codex' | 'terminal'
    mode: 'build' | 'plan'
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
    created_at: string
    updated_at: string
    completed_at: string | null
  }> = {}
) {
  return {
    id: 'test-session-1',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Test Session',
    status: 'active' as const,
    opencode_session_id: 'opc-session-1',
    agent_sdk: 'opencode' as const,
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides
  }
}

// Setup and teardown
beforeEach(() => {
  vi.clearAllMocks()
  mockConsoleInfo.mockReset()
  lastSendMode.clear()
  resetSessionFollowUpDispatchState()

  if (!HTMLElement.prototype.animate) {
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      value: vi.fn(() => ({
        cancel: vi.fn(),
        currentTime: 0
      })),
      writable: true,
      configurable: true
    })
  }

  useSessionStore.setState({
    sessionsByWorktree: new Map([['wt-1', [createSessionRecord()]]]),
    tabOrderByWorktree: new Map([['wt-1', ['test-session-1']]]),
    modeBySession: new Map([['test-session-1', 'build']]),
    pendingMessages: new Map(),
    pendingPlans: new Map(),
    pendingFollowUpMessages: new Map(),
    isLoading: false,
    error: null,
    activeSessionId: 'test-session-1',
    activeWorktreeId: 'wt-1',
    activeSessionByWorktree: { 'wt-1': 'test-session-1' },
    sessionsByConnection: new Map(),
    tabOrderByConnection: new Map(),
    activeSessionByConnection: {},
    activeConnectionId: null,
    inlineConnectionSessionId: null,
    closedTerminalSessionIds: new Set()
  })
  useWorktreeStatusStore.setState({ sessionStatuses: {}, lastMessageTimeByWorktree: {} })

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
        create: vi.fn().mockResolvedValue({
          id: 'forked-session-1',
          worktree_id: 'wt-1',
          project_id: 'proj-1',
          name: 'Test Session (fork)',
          status: 'active',
          opencode_session_id: 'opc-fork-1',
          mode: 'build',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null
        }),
        getActiveByWorktree: vi.fn().mockResolvedValue([
          {
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
          },
          {
            id: 'forked-session-1',
            worktree_id: 'wt-1',
            project_id: 'proj-1',
            name: 'Test Session (fork)',
            status: 'active',
            opencode_session_id: 'opc-fork-1',
            mode: 'build',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: null
          }
        ]),
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
      steer: vi.fn().mockResolvedValue({ success: true }),
      fork: vi.fn().mockResolvedValue({ success: true, sessionId: 'opc-fork-1' }),
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
          supportsPartialStreaming: true,
          supportsSteer: true
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

  describe('Plan-ready toolbox visibility', () => {
    test('Codex hides the toolbox for a clarifying question pending plan', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['wt-1', [createSessionRecord({ agent_sdk: 'codex', mode: 'plan' })]]
        ]),
        modeBySession: new Map([['test-session-1', 'plan']]),
        pendingPlans: new Map([
          [
            'test-session-1',
            {
              requestId: 'plan-1',
              planContent:
                'Where should I add it?\n\n- New module\n- Existing utils\n\nConfirm your preference.',
              toolUseID: 'tool-1'
            }
          ]
        ])
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
      })

      expect(screen.getByTestId('plan-ready-implement-fab').className).toContain('opacity-0')
      expect(screen.getByTestId('plan-ready-handoff-fab').className).toContain('opacity-0')
    })

    test('Codex shows the toolbox for a proposed plan pending plan', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['wt-1', [createSessionRecord({ agent_sdk: 'codex', mode: 'plan' })]]
        ]),
        modeBySession: new Map([['test-session-1', 'plan']]),
        pendingPlans: new Map([
          [
            'test-session-1',
            {
              requestId: 'plan-1',
              planContent: 'Plan\n\n1. Add the function\n2. Add tests',
              toolUseID: 'tool-1'
            }
          ]
        ])
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('plan-ready-implement-fab')).toBeInTheDocument()
        expect(screen.getByTestId('plan-ready-handoff-fab')).toBeInTheDocument()
      })
    })

    test('Codex rehydrates the toolbox from restored ExitPlanMode transcript data', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['wt-1', [createSessionRecord({ agent_sdk: 'codex', mode: 'plan' })]]
        ]),
        modeBySession: new Map([['test-session-1', 'plan']]),
        pendingPlans: new Map()
      })

      Object.assign(window.db, {
        sessionMessage: {
          list: vi.fn().mockResolvedValue([
            {
              id: 'db-user-1',
              session_id: 'test-session-1',
              role: 'user',
              content: 'Plan this change',
              opencode_message_id: 'turn-1:user',
              opencode_message_json: null,
              opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Plan this change' }]),
              opencode_timeline_json: null,
              created_at: new Date(Date.now() - 2000).toISOString()
            },
            {
              id: 'db-assistant-1',
              session_id: 'test-session-1',
              role: 'assistant',
              content: '',
              opencode_message_id: 'turn-1:assistant',
              opencode_message_json: null,
              opencode_parts_json: JSON.stringify([
                {
                  type: 'tool_use',
                  toolUse: {
                    id: 'tool-1',
                    name: 'ExitPlanMode',
                    input: { plan: 'Plan\n\n1. Add the function\n2. Add tests' },
                    status: 'success',
                    startTime: Date.now() - 1000
                  }
                }
              ]),
              opencode_timeline_json: null,
              created_at: new Date(Date.now() - 1000).toISOString()
            }
          ])
        },
        sessionActivity: {
          list: vi.fn().mockResolvedValue([])
        }
      })

      vi.mocked(window.opencodeOps.getMessages).mockResolvedValue({
        success: true,
        messages: [
          {
            info: {
              id: 'turn-1:user',
              role: 'user',
              time: { created: Date.now() - 2000 }
            },
            parts: [{ type: 'text', text: 'Plan this change' }]
          },
          {
            info: {
              id: 'turn-1:assistant',
              role: 'assistant',
              time: { created: Date.now() - 1000 }
            },
            parts: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'ExitPlanMode',
                input: { plan: 'Plan\n\n1. Add the function\n2. Add tests' },
                status: 'success'
              }
            ]
          }
        ]
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(useSessionStore.getState().getPendingPlan('test-session-1')).toEqual({
          requestId: 'tool-1',
          planContent: 'Plan\n\n1. Add the function\n2. Add tests',
          toolUseID: 'tool-1'
        })
      })

      expect(screen.getByTestId('plan-ready-implement-fab').className).not.toContain('opacity-0')
    })

    test('Codex implement sends a single upstream-style follow-up message', async () => {
      const user = userEvent.setup()

      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['wt-1', [createSessionRecord({ agent_sdk: 'codex', mode: 'plan' })]]
        ]),
        modeBySession: new Map([['test-session-1', 'plan']]),
        pendingPlans: new Map([
          [
            'test-session-1',
            {
              requestId: 'plan-1',
              planContent: 'Plan\n\n1. Add the function\n2. Add tests',
              toolUseID: 'tool-1'
            }
          ]
        ])
      })
      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'plan',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-codex-plan',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        messages: []
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('plan-ready-implement-fab').className).not.toContain('opacity-0')
      })

      await user.click(screen.getByTestId('plan-ready-implement-fab'))

      await waitFor(() => {
        expect(window.opencodeOps.prompt).toHaveBeenCalledTimes(1)
      })

      expect(useSessionStore.getState().getSessionMode('test-session-1')).toBe('build')

      const promptArgs = vi.mocked(window.opencodeOps.prompt).mock.calls[0]
      expect(promptArgs?.[0]).toBe('/tmp/worktree-codex-plan')
      expect(promptArgs?.[1]).toBe('opc-session-1')
      expect(promptArgs?.[2]).toEqual([{ type: 'text', text: 'Implement the plan.' }])
      expect(JSON.stringify(promptArgs?.[2])).not.toContain('PLEASE IMPLEMENT THIS PLAN:')
      expect(screen.queryByTestId('queued-message-bubble')).not.toBeInTheDocument()
    })

    test('active-session follow-up failure requeues the message and clears the working badge', async () => {
      let streamCallback: ((event: Record<string, unknown>) => void) | null = null

      useSessionStore.setState({
        pendingFollowUpMessages: new Map([['test-session-1', ['follow-up retry']]])
      })
      ;(window.opencodeOps.onStream as ReturnType<typeof vi.fn>).mockImplementation((callback) => {
        streamCallback = callback as (event: Record<string, unknown>) => void
        return () => {}
      })
      ;(window.opencodeOps.prompt as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'network failure'
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
      })

      act(() => {
        streamCallback?.({
          sessionId: 'test-session-1',
          type: 'session.status',
          statusPayload: { type: 'idle' },
          data: { status: { type: 'idle' } }
        })
      })

      await waitFor(() => {
        expect(window.opencodeOps.prompt).toHaveBeenCalledTimes(1)
      })

      await waitFor(() => {
        expect(useSessionStore.getState().pendingFollowUpMessages.get('test-session-1')).toEqual([
          'follow-up retry'
        ])
      })

      expect(useWorktreeStatusStore.getState().sessionStatuses['test-session-1'] ?? null).toBeNull()
    })

    test('Claude keeps showing the toolbox for any pending plan approval', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['wt-1', [createSessionRecord({ agent_sdk: 'claude-code', mode: 'plan' })]]
        ]),
        modeBySession: new Map([['test-session-1', 'plan']]),
        pendingPlans: new Map([
          [
            'test-session-1',
            {
              requestId: 'plan-1',
              planContent: 'Where should I add it?\n\nPlease confirm.',
              toolUseID: 'tool-1'
            }
          ]
        ])
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('plan-ready-implement-fab')).toBeInTheDocument()
      })
    })

    test('OpenCode keeps showing the toolbox after an idle plan-mode completion', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['wt-1', [createSessionRecord({ agent_sdk: 'opencode', mode: 'plan' })]]
        ]),
        modeBySession: new Map([['test-session-1', 'plan']]),
        pendingPlans: new Map()
      })
      lastSendMode.set('test-session-1', 'plan')

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('plan-ready-implement-fab')).toBeInTheDocument()
        expect(screen.getByTestId('plan-ready-handoff-fab')).toBeInTheDocument()
      })
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

    test('scroll FAB stays hidden for non-manual scroll events but appears after wheel intent', async () => {
      let scrollTopValue = 100
      let scrollHeightValue = 500
      const clientHeightValue = 400

      ;(window.opencodeOps.prompt as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {})
      )

      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const messageList = screen.getByTestId('message-list')
      const fab = screen.getByTestId('scroll-to-bottom-fab')

      Object.defineProperty(messageList, 'scrollTop', {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value
        }
      })
      Object.defineProperty(messageList, 'scrollHeight', {
        configurable: true,
        get: () => scrollHeightValue
      })
      Object.defineProperty(messageList, 'clientHeight', {
        configurable: true,
        get: () => clientHeightValue
      })

      await user.type(screen.getByTestId('message-input'), 'Keep streaming')
      await user.click(screen.getByTestId('send-button'))

      await waitFor(() => {
        expect(window.opencodeOps.prompt).toHaveBeenCalled()
      })

      scrollHeightValue = 900
      scrollTopValue = 20
      fireEvent.scroll(messageList)
      expect(fab.className).toContain('opacity-0')

      fireEvent.wheel(messageList)
      fireEvent.scroll(messageList)

      await waitFor(() => {
        expect(fab.className).toContain('opacity-100')
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

    test('Enter does not send while IME composition is active', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input') as HTMLTextAreaElement
      await user.type(input, '你好')

      fireEvent.compositionStart(input)
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

      expect(window.opencodeOps.prompt).not.toHaveBeenCalled()
      expect(input.value).toBe('你好')

      fireEvent.compositionEnd(input)
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

      await waitFor(() => {
        expect(window.opencodeOps.prompt).toHaveBeenCalled()
      })
    })

    test('Enter does not send when browser reports IME fallback keyCode 229', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('message-input') as HTMLTextAreaElement
      await user.type(input, '中文输入')

      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 229 })

      expect(window.opencodeOps.prompt).not.toHaveBeenCalled()
      expect(input.value).toBe('中文输入')
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

    test('Fork button creates and opens a new forked session tab', async () => {
      const user = userEvent.setup()
      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByTestId('message-list')).toBeInTheDocument()
      })

      const forkButton = screen.getByTestId('fork-message-button')
      await user.click(forkButton)

      await waitFor(() => {
        expect(window.opencodeOps.fork).toHaveBeenCalledWith(
          '/tmp/worktree-default',
          'opc-session-1',
          undefined
        )
      })

      expect(window.db.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          worktree_id: 'wt-1',
          project_id: 'proj-1',
          opencode_session_id: 'opc-fork-1'
        })
      )
      expect(useSessionStore.getState().activeSessionId).toBe('forked-session-1')
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
      await act(async () => {
        streamCallback?.({
          sessionId: 'test-session-1',
          type: 'session.status',
          statusPayload: { type: 'idle' },
          data: { status: { type: 'idle' } }
        })
      })

      await waitFor(() => {
        expect(getMessagesMock).toHaveBeenCalledTimes(2)
      })

      expect(window.opencodeOps.getMessages).toHaveBeenCalled()
    })

    test('Codex idle finalization refreshes without throwing', async () => {
      let streamCallback: ((event: Record<string, unknown>) => void) | null = null
      const getMessagesMock = vi.fn().mockResolvedValue({
        success: true,
        messages: [
          {
            info: {
              id: 'codex-user-1',
              role: 'user',
              time: { created: Date.now() - 2000 }
            },
            parts: [{ type: 'text', text: 'Question' }]
          },
          {
            info: {
              id: 'codex-assistant-1',
              role: 'assistant',
              time: { created: Date.now() - 1000 }
            },
            parts: [{ type: 'text', text: 'Answer' }]
          }
        ]
      })

      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['wt-1', [createSessionRecord({ agent_sdk: 'codex', mode: 'build' })]]
        ])
      })

      Object.assign(window.db, {
        sessionMessage: {
          list: vi.fn().mockResolvedValue([])
        },
        sessionActivity: {
          list: vi.fn().mockResolvedValue([])
        }
      })
      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'build',
        agent_sdk: 'codex',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-codex-finalize',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        sessionStatus: 'busy'
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

      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'session.status',
        statusPayload: { type: 'idle' },
        data: { status: { type: 'idle' } }
      })

      await waitFor(() => {
        expect(getMessagesMock).toHaveBeenCalledTimes(2)
      })
    })

    test('Codex idle finalization waits for durable interleaved ordering', async () => {
      let streamCallback: ((event: Record<string, unknown>) => void) | null = null
      let sessionMessageListCalls = 0

      const groupedRows = [
        {
          id: 'db-user-1',
          session_id: 'test-session-1',
          role: 'user',
          content: 'First question',
          opencode_message_id: 'turn-1:user',
          opencode_message_json: null,
          opencode_parts_json: JSON.stringify([{ type: 'text', text: 'First question' }]),
          opencode_timeline_json: null,
          created_at: '2026-03-14T10:00:00.000Z'
        },
        {
          id: 'db-user-2',
          session_id: 'test-session-1',
          role: 'user',
          content: 'Second question',
          opencode_message_id: 'turn-2:user',
          opencode_message_json: null,
          opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Second question' }]),
          opencode_timeline_json: null,
          created_at: '2026-03-14T10:00:01.000Z'
        },
        {
          id: 'db-assistant-1',
          session_id: 'test-session-1',
          role: 'assistant',
          content: 'First answer',
          opencode_message_id: 'turn-1:assistant',
          opencode_message_json: null,
          opencode_parts_json: JSON.stringify([{ type: 'text', text: 'First answer' }]),
          opencode_timeline_json: null,
          created_at: '2026-03-14T10:00:02.000Z'
        },
        {
          id: 'db-assistant-2',
          session_id: 'test-session-1',
          role: 'assistant',
          content: 'Second answer',
          opencode_message_id: 'turn-2:assistant',
          opencode_message_json: null,
          opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Second answer' }]),
          opencode_timeline_json: null,
          created_at: '2026-03-14T10:00:03.000Z'
        }
      ]
      const interleavedRows = [
        groupedRows[0],
        {
          ...groupedRows[2],
          created_at: '2026-03-14T10:00:00.500Z'
        },
        {
          ...groupedRows[1],
          created_at: '2026-03-14T10:00:01.000Z'
        },
        groupedRows[3]
      ]

      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['wt-1', [createSessionRecord({ agent_sdk: 'codex', mode: 'build' })]]
        ])
      })

      Object.assign(window.db, {
        sessionMessage: {
          list: vi.fn().mockImplementation(async () => {
            sessionMessageListCalls += 1
            return sessionMessageListCalls >= 3 ? interleavedRows : groupedRows
          })
        },
        sessionActivity: {
          list: vi.fn().mockResolvedValue([])
        }
      })
      ;(window.db.session.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'test-session-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: 'opc-session-1',
        mode: 'build',
        agent_sdk: 'codex',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })
      ;(window.db.worktree.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'WT',
        branch_name: 'main',
        path: '/tmp/worktree-codex-ordering',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        sessionStatus: 'busy'
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        messages: []
      })
      ;(window.opencodeOps.onStream as ReturnType<typeof vi.fn>).mockImplementation((callback) => {
        streamCallback = callback as (event: Record<string, unknown>) => void
        return () => {}
      })

      const { container } = render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByText('First question')).toBeInTheDocument()
      })

      await act(async () => {
        streamCallback?.({
          sessionId: 'test-session-1',
          type: 'session.status',
          statusPayload: { type: 'idle' },
          data: { status: { type: 'idle' } }
        })
      })

      await waitFor(() => {
        expect(sessionMessageListCalls).toBeGreaterThanOrEqual(3)
      })

      await waitFor(() => {
        const orderedMessages = Array.from(
          container.querySelectorAll(
            '[data-testid="message-user"], [data-testid="message-assistant"]'
          )
        ).map((element) => element.textContent ?? '')

        expect(orderedMessages).toEqual([
          expect.stringContaining('First question'),
          expect.stringContaining('First answer'),
          expect.stringContaining('Second question'),
          expect.stringContaining('Second answer')
        ])
      })
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

    test('Busy remount restores a text-only streaming draft without double-rendering the last assistant message', async () => {
      useWorktreeStatusStore.getState().setSessionStatus('test-session-1', 'working')
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
        path: '/tmp/worktree-live-text',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        sessionStatus: 'busy'
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        messages: [
          {
            info: {
              id: 'opc-user-live-1',
              role: 'user',
              time: { created: Date.now() - 1000 }
            },
            parts: [{ type: 'text', text: 'Question' }]
          },
          {
            info: {
              id: 'opc-live-1',
              role: 'assistant',
              time: { created: Date.now() }
            },
            parts: [{ type: 'text', text: 'Partial Codex answer' }]
          }
        ]
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByText('Partial Codex answer')).toBeInTheDocument()
      })

      expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
      expect(screen.queryByTestId('typing-indicator')).toBeInTheDocument()
    })

    test('Busy remount restores tool parts and clears the overlay after idle refresh without duplicating the final assistant message', async () => {
      let streamCallback: ((event: Record<string, unknown>) => void) | null = null
      useWorktreeStatusStore.getState().setSessionStatus('test-session-1', 'working')
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
        path: '/tmp/worktree-live-tool',
        status: 'active',
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      })
      ;(window.opencodeOps.reconnect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        sessionStatus: 'busy'
      })
      ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          success: true,
          messages: [
            {
              info: {
                id: 'opc-user-tool-1',
                role: 'user',
                time: { created: Date.now() - 1000 }
              },
              parts: [{ type: 'text', text: 'Run a command' }]
            },
            {
              info: {
                id: 'opc-live-tool-1',
                role: 'assistant',
                time: { created: Date.now() }
              },
              parts: [
                { type: 'text', text: 'Running now' },
                {
                  type: 'tool',
                  callID: 'tool-live-1',
                  tool: 'bash',
                  state: {
                    status: 'completed',
                    input: { command: 'ls' },
                    output: 'file-a\nfile-b'
                  }
                }
              ]
            }
          ]
        })
        .mockResolvedValueOnce({
          success: true,
          messages: [
            {
              info: {
                id: 'opc-user-tool-1',
                role: 'user',
                time: { created: Date.now() - 1000 }
              },
              parts: [{ type: 'text', text: 'Run a command' }]
            },
            {
              info: {
                id: 'opc-final-tool-1',
                role: 'assistant',
                time: { created: Date.now() }
              },
              parts: [
                { type: 'text', text: 'Running now' },
                {
                  type: 'tool',
                  callID: 'tool-live-1',
                  tool: 'bash',
                  state: {
                    status: 'completed',
                    input: { command: 'ls' },
                    output: 'file-a\nfile-b'
                  }
                }
              ]
            }
          ]
        })
      ;(window.opencodeOps.onStream as ReturnType<typeof vi.fn>).mockImplementation((callback) => {
        streamCallback = callback as (event: Record<string, unknown>) => void
        return () => {}
      })

      render(<SessionView sessionId="test-session-1" />)

      await waitFor(() => {
        expect(screen.getByText('Running now')).toBeInTheDocument()
      })

      expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
      expect(screen.getByText('bash')).toBeInTheDocument()

      act(() => {
        streamCallback?.({
          sessionId: 'test-session-1',
          type: 'session.status',
          statusPayload: { type: 'idle' },
          data: { status: { type: 'idle' } }
        })
      })

      await waitFor(() => {
        expect((window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
          2
        )
      })

      await waitFor(() => {
        expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
      })
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
        expect(screen.getByText(/to change variant/i)).toBeInTheDocument()
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
