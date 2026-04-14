import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef } from 'react'

import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'
import { resetSessionFollowUpDispatchState } from '../../../src/renderer/src/lib/session-follow-up-dispatch'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}))

vi.mock('../../../src/renderer/src/components/sessions/ForkMessageButton', () => ({
  ForkMessageButton: () => null
}))

vi.mock('../../../src/renderer/src/components/sessions/VirtualizedMessageList', () => ({
  VirtualizedMessageList: forwardRef(function MockVirtualizedMessageList(
    {
      messages,
      queuedMessages,
      canSteer,
      onSteerMessage
    }: {
      messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; steered?: boolean }>
      queuedMessages: Array<{ id: string; content: string }>
      canSteer: boolean
      onSteerMessage: (messageId: string, content: string) => void | Promise<void>
    },
    _ref
  ) {
    return (
      <div data-testid="message-list">
        {messages.map((message) => (
          <div
            key={message.id}
            data-testid={message.role === 'user' ? 'message-user' : 'message-assistant'}
          >
            {message.steered && <span data-testid="steered-mode-badge">STEERED</span>}
            <span>{message.content}</span>
          </div>
        ))}
        {queuedMessages.map((message) => (
          <button
            key={message.id}
            data-testid="queued-message-bubble"
            disabled={!canSteer}
            onClick={() => onSteerMessage(message.id, message.content)}
            title="Steer — inject into active turn"
          >
            {message.content}
          </button>
        ))}
      </div>
    )
  })
}))

import { SessionView } from '../../../src/renderer/src/components/sessions/SessionView'

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
    agent_sdk: 'codex' as const,
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

describe('Codex steer boundary ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionFollowUpDispatchState()

    if (!HTMLElement.prototype.animate) {
      Object.defineProperty(HTMLElement.prototype, 'animate', {
        value: vi.fn(() => ({ cancel: vi.fn(), currentTime: 0 })),
        writable: true,
        configurable: true
      })
    }

    Element.prototype.scrollIntoView = vi.fn()

    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt-1', [createSessionRecord()]]]),
      tabOrderByWorktree: new Map([['wt-1', ['test-session-1']]]),
      modeBySession: new Map([['test-session-1', 'build']]),
      pendingMessages: new Map(),
      pendingPlans: new Map(),
      pendingFollowUpMessages: new Map([['test-session-1', ['Follow-up steer']]]),
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
            agent_sdk: 'codex',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: null
          }),
          getDraft: vi.fn().mockResolvedValue(null),
          updateDraft: vi.fn().mockResolvedValue(undefined)
        },
        worktree: {
          get: vi.fn().mockResolvedValue({
            id: 'wt-1',
            project_id: 'proj-1',
            name: 'WT',
            branch_name: 'main',
            path: '/tmp/worktree-codex-steer',
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

    Object.defineProperty(window, 'opencodeOps', {
      value: {
        reconnect: vi.fn().mockResolvedValue({ success: true }),
        connect: vi.fn().mockResolvedValue({ success: false }),
        prompt: vi.fn().mockResolvedValue({ success: true }),
        steer: vi.fn().mockResolvedValue({
          success: true,
          insertedMessageId: 'turn-1:user:2',
          nextAssistantMessageId: 'turn-1:assistant:2',
          turnId: 'turn-1'
        }),
        command: vi.fn().mockResolvedValue({ success: true }),
        fork: vi.fn().mockResolvedValue({ success: true }),
        sessionInfo: vi
          .fn()
          .mockResolvedValue({ success: true, revertMessageID: null, revertDiff: null }),
        undo: vi.fn().mockResolvedValue({ success: true }),
        redo: vi.fn().mockResolvedValue({ success: true }),
        disconnect: vi.fn().mockResolvedValue({ success: true }),
        abort: vi.fn().mockResolvedValue({ success: true }),
        getMessages: vi.fn().mockResolvedValue({
          success: true,
          messages: [
            {
              info: {
                id: 'turn-1:user',
                role: 'user',
                time: { created: Date.now() - 2000 }
              },
              parts: [{ type: 'text', text: 'First question' }]
            },
            {
              info: {
                id: 'turn-1:assistant',
                role: 'assistant',
                time: { created: Date.now() - 1000 }
              },
              parts: [{ type: 'text', text: 'First answer' }]
            }
          ]
        }),
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
        onStream: vi.fn().mockImplementation((callback: (event: Record<string, unknown>) => void) => {
          ;(window as Window & { __testStreamCallback?: typeof callback }).__testStreamCallback = callback
          return () => {}
        })
      },
      writable: true,
      configurable: true
    })

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

  test('pins the steered user message at the current boundary and streams new assistant text below it', async () => {
    const user = userEvent.setup()
    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByText('First answer')).toBeInTheDocument()
    })

    const streamCallback = (window as Window & {
      __testStreamCallback?: (event: Record<string, unknown>) => void
    }).__testStreamCallback

    await act(async () => {
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'session.status',
        statusPayload: { type: 'busy' },
        data: { status: { type: 'busy' } }
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('queued-message-bubble')).toBeInTheDocument()
    })

    await user.click(screen.getByTitle('Steer — inject into active turn'))

    await waitFor(() => {
      expect(window.opencodeOps.steer).toHaveBeenCalledWith(
        '/tmp/worktree-codex-steer',
        'opc-session-1',
        'Follow-up steer'
      )
      expect(screen.getByTestId('steered-mode-badge')).toBeInTheDocument()
    })

    await act(async () => {
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'message.part.updated',
        data: {
          delta: 'Continued answer',
          part: { type: 'text', text: 'Continued answer' }
        }
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Continued answer')).toBeInTheDocument()
    })

    const orderedMessages = screen
      .getAllByTestId(/message-(user|assistant)/)
      .map((element) => element.textContent ?? '')

    expect(orderedMessages).toEqual([
      expect.stringContaining('First question'),
      expect.stringContaining('First answer'),
      expect.stringContaining('STEEREDFollow-up steer'),
      expect.stringContaining('Continued answer')
    ])
  })
})
