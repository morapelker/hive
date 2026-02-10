import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { SessionView } from '../../../src/renderer/src/components/sessions/SessionView'

type StreamEvent = {
  type: string
  sessionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

type MessageRow = {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  opencode_message_id?: string | null
  opencode_message_json?: string | null
  opencode_parts_json?: string | null
  opencode_timeline_json?: string | null
  created_at: string
}

let streamCallback: ((event: StreamEvent) => void) | null = null

const mockDbMessage = {
  create: vi.fn(),
  getBySession: vi.fn(),
  delete: vi.fn()
}

function makeSavedMessage(data: {
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}): MessageRow {
  return {
    id: `${data.role}-${Math.random().toString(16).slice(2)}`,
    session_id: data.session_id,
    role: data.role,
    content: data.content,
    created_at: new Date().toISOString()
  }
}

function makeAssistantMessage(content: string, messageId: string): MessageRow {
  return {
    id: `assistant-row-${messageId}`,
    session_id: 'test-session-1',
    role: 'assistant',
    content,
    opencode_message_id: messageId,
    opencode_parts_json: JSON.stringify([{ id: `${messageId}-text`, type: 'text', text: content }]),
    created_at: new Date().toISOString()
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

  mockDbMessage.getBySession.mockResolvedValue([])
  mockDbMessage.delete.mockResolvedValue(true)
  mockDbMessage.create.mockImplementation(
    (data: { session_id: string; role: 'user' | 'assistant' | 'system'; content: string }) => {
      return Promise.resolve(makeSavedMessage(data))
    }
  )

  Object.defineProperty(window, 'db', {
    value: {
      message: mockDbMessage,
      session: {
        get: vi.fn().mockResolvedValue({
          id: 'test-session-1',
          worktree_id: null,
          project_id: 'project-1',
          name: 'Test Session',
          status: 'active',
          opencode_session_id: null,
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
        get: vi.fn().mockResolvedValue(null)
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
      reconnect: vi.fn().mockResolvedValue({ success: false }),
      prompt: vi.fn().mockResolvedValue({ success: true }),
      disconnect: vi.fn().mockResolvedValue({ success: true }),
      getMessages: vi.fn().mockResolvedValue({ success: true, messages: [] }),
      listModels: vi.fn().mockResolvedValue({ success: true, providers: [] }),
      setModel: vi.fn().mockResolvedValue({ success: true }),
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
    expect(mockDbMessage.getBySession).toHaveBeenCalledTimes(1)
  })

  test('User message.updated events are skipped', async () => {
    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
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

    expect(mockDbMessage.getBySession).toHaveBeenCalledTimes(1)
    expect(screen.queryAllByTestId('message-assistant')).toHaveLength(0)
  })

  test('message.updated followed by session.idle renders assistant message exactly once', async () => {
    const assistantMessage = makeAssistantMessage('Hello from assistant', 'assistant-msg-1')
    mockDbMessage.getBySession
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([assistantMessage])
      .mockResolvedValue([assistantMessage])

    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
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

    await waitFor(() => {
      expect(screen.getByText('Hello from assistant')).toBeInTheDocument()
      expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
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
    expect(mockDbMessage.getBySession).toHaveBeenCalledTimes(2)
  })

  test('duplicate message.updated events for same message ID are deduplicated', async () => {
    const assistantMessage = makeAssistantMessage('Deduped reply', 'assistant-msg-2')
    mockDbMessage.getBySession
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([assistantMessage])
      .mockResolvedValue([assistantMessage])

    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
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

    await waitFor(() => {
      expect(screen.getByText('Deduped reply')).toBeInTheDocument()
      expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    })

    expect(mockDbMessage.getBySession).toHaveBeenCalledTimes(2)
  })

  test('session.idle finalizes streamed content when message.updated is not received', async () => {
    const assistantMessage = makeAssistantMessage('Idle finalized reply', 'assistant-msg-3')
    mockDbMessage.getBySession
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([assistantMessage])
      .mockResolvedValue([assistantMessage])

    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
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

    emitStream({
      type: 'session.idle',
      sessionId: 'test-session-1',
      data: {}
    })

    await waitFor(() => {
      expect(screen.getByText('Idle finalized reply')).toBeInTheDocument()
      expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    })

    expect(mockDbMessage.getBySession).toHaveBeenCalledTimes(2)
  })
})
