import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { SessionView } from '../../../src/renderer/src/components/sessions/SessionView'

type StreamEvent = {
  type: string
  sessionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

let streamCallback: ((event: StreamEvent) => void) | null = null
let canonicalTranscript: Array<Record<string, unknown>> = []
let mockGetMessages: ReturnType<typeof vi.fn>

function makeTranscriptAssistantMessage(
  content: string,
  messageId: string
): Record<string, unknown> {
  return {
    info: {
      id: messageId,
      role: 'assistant',
      time: { created: new Date().toISOString() }
    },
    parts: [{ type: 'text', text: content }]
  }
}

function emitStream(event: StreamEvent): void {
  if (!streamCallback) {
    throw new Error('Stream callback was not registered')
  }

  act(() => {
    streamCallback!(event)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  streamCallback = null
  canonicalTranscript = []
  mockGetMessages = vi
    .fn()
    .mockImplementation(() => Promise.resolve({ success: true, messages: canonicalTranscript }))

  Object.defineProperty(window, 'db', {
    value: {
      session: {
        get: vi.fn().mockResolvedValue({
          id: 'test-session-1',
          worktree_id: 'wt-1',
          project_id: 'project-1',
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
          project_id: 'project-1',
          name: 'WT',
          branch_name: 'main',
          path: '/tmp/worktree-streaming-bug-fix',
          status: 'active',
          is_default: true,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        })
      },
      setting: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(true)
      }
    },
    writable: true,
    configurable: true
  })

  Object.defineProperty(window, 'opencodeOps', {
    value: {
      connect: vi.fn().mockResolvedValue({ success: false }),
      reconnect: vi.fn().mockResolvedValue({ success: true }),
      prompt: vi.fn().mockResolvedValue({ success: true }),
      command: vi.fn().mockResolvedValue({ success: true }),
      disconnect: vi.fn().mockResolvedValue({ success: true }),
      getMessages: mockGetMessages,
      listModels: vi.fn().mockResolvedValue({ success: true, providers: [] }),
      setModel: vi.fn().mockResolvedValue({ success: true }),
      modelInfo: vi.fn().mockResolvedValue({ success: true }),
      questionReply: vi.fn().mockResolvedValue({ success: true }),
      questionReject: vi.fn().mockResolvedValue({ success: true }),
      permissionReply: vi.fn().mockResolvedValue({ success: true }),
      permissionList: vi.fn().mockResolvedValue({ success: true, permissions: [] }),
      commands: vi.fn().mockResolvedValue({ success: true, commands: [] }),
      onStream: vi.fn().mockImplementation((callback: (event: StreamEvent) => void) => {
        streamCallback = callback
        return () => {
          if (streamCallback === callback) {
            streamCallback = null
          }
        }
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

  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
})

describe('Session 9: Streaming Bug Fix', () => {
  test('User message.part.updated events are skipped', async () => {
    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledTimes(1)
    })

    emitStream({
      type: 'message.part.updated',
      sessionId: 'test-session-1',
      data: {
        role: 'user',
        part: { type: 'text', text: 'hello world' },
        delta: 'hello world'
      }
    })

    expect(screen.queryAllByTestId('message-assistant')).toHaveLength(0)
    expect(mockGetMessages).toHaveBeenCalledTimes(1)
  })

  test('User message.updated events are skipped', async () => {
    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledTimes(1)
    })

    emitStream({
      type: 'message.updated',
      sessionId: 'test-session-1',
      data: {
        info: {
          role: 'user',
          time: { completed: new Date().toISOString() }
        }
      }
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockGetMessages).toHaveBeenCalledTimes(1)
    expect(screen.queryAllByTestId('message-assistant')).toHaveLength(0)
  })

  test('message.updated followed by session.idle renders assistant message exactly once', async () => {
    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledTimes(1)
    })

    emitStream({
      type: 'message.part.updated',
      sessionId: 'test-session-1',
      data: {
        role: 'assistant',
        part: { id: 'p1', type: 'text', text: 'Hello' },
        delta: 'Hello'
      }
    })

    emitStream({
      type: 'message.updated',
      sessionId: 'test-session-1',
      data: {
        info: {
          role: 'assistant',
          messageID: 'assistant-msg-1',
          time: { completed: new Date().toISOString() }
        }
      }
    })

    canonicalTranscript = [
      makeTranscriptAssistantMessage('Hello from assistant', 'assistant-msg-1')
    ]

    emitStream({
      type: 'session.idle',
      sessionId: 'test-session-1',
      data: {}
    })

    await waitFor(() => {
      expect(screen.getByText('Hello from assistant')).toBeInTheDocument()
      expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
      expect(mockGetMessages).toHaveBeenCalledTimes(2)
    })

    emitStream({
      type: 'session.idle',
      sessionId: 'test-session-1',
      data: {}
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    expect(mockGetMessages).toHaveBeenCalledTimes(2)
  })

  test('duplicate message.updated events for same message ID are deduplicated', async () => {
    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledTimes(1)
    })

    const updatedEvent: StreamEvent = {
      type: 'message.updated',
      sessionId: 'test-session-1',
      data: {
        info: {
          role: 'assistant',
          messageID: 'assistant-msg-2',
          time: { completed: new Date().toISOString() }
        }
      }
    }

    emitStream(updatedEvent)
    emitStream(updatedEvent)

    canonicalTranscript = [makeTranscriptAssistantMessage('Deduped reply', 'assistant-msg-2')]

    emitStream({
      type: 'session.idle',
      sessionId: 'test-session-1',
      data: {}
    })

    await waitFor(() => {
      expect(screen.getByText('Deduped reply')).toBeInTheDocument()
      expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
      expect(mockGetMessages).toHaveBeenCalledTimes(2)
    })
  })

  test('session.idle finalizes streamed content when message.updated is not received', async () => {
    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledTimes(1)
    })

    emitStream({
      type: 'message.part.updated',
      sessionId: 'test-session-1',
      data: {
        role: 'assistant',
        part: { id: 'p-idle', type: 'text', text: 'Idle' },
        delta: 'Idle'
      }
    })

    canonicalTranscript = [
      makeTranscriptAssistantMessage('Idle finalized reply', 'assistant-msg-3')
    ]

    emitStream({
      type: 'session.idle',
      sessionId: 'test-session-1',
      data: {}
    })

    await waitFor(() => {
      expect(screen.getByText('Idle finalized reply')).toBeInTheDocument()
      expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
      expect(mockGetMessages).toHaveBeenCalledTimes(2)
    })
  })
})
