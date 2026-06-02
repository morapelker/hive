/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Track event listeners registered on the mock manager
let eventListeners: Array<(event: any) => void> = []

// Mock the CodexAppServerManager
vi.mock('../../../src/main/services/codex-app-server-manager', () => {
  const MockManager = vi.fn().mockImplementation(() => ({
    startSession: vi.fn(),
    stopSession: vi.fn(),
    stopAll: vi.fn(),
    hasSession: vi.fn().mockReturnValue(false),
    getSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    sendTurn: vi.fn(),
    on: vi.fn().mockImplementation((_event: string, handler: any) => {
      eventListeners.push(handler)
    }),
    emit: vi.fn(),
    removeListener: vi.fn().mockImplementation((_event: string, handler: any) => {
      eventListeners = eventListeners.filter((h) => h !== handler)
    }),
    removeAllListeners: vi.fn()
  }))
  return {
    CodexAppServerManager: MockManager
  }
})

import {
  CodexImplementer,
  type CodexSessionState
} from '../../../src/main/services/codex-implementer'

describe('Codex child session routing', () => {
  let impl: CodexImplementer
  let mockManager: any
  let mockWindow: any

  beforeEach(() => {
    vi.clearAllMocks()
    eventListeners = []
    impl = new CodexImplementer()
    mockManager = impl.getManager()
    mockWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    }
    impl.setMainWindow(mockWindow)
  })

  function seedSession(
    worktreePath: string,
    threadId: string,
    hiveSessionId: string
  ): CodexSessionState {
    const session: CodexSessionState = {
      threadId,
      hiveSessionId,
      worktreePath,
      status: 'ready',
      messages: [],
      currentTurnId: null,
      currentAssistantMessageId: null,
      revertMessageID: null,
      revertDiff: null,
      titleGenerated: false,
      titleGenerationStarted: false,
      persistDebounceTimer: null,
      liveAssistantDraft: null
    }
    impl.getSessions().set(`${worktreePath}::${threadId}`, session)
    return session
  }

  function simulateEvents(events: any[]) {
    mockManager.sendTurn.mockImplementation(async () => {
      setTimeout(() => {
        for (const event of events) {
          for (const listener of [...eventListeners]) {
            listener(event)
          }
        }
      }, 5)
      return { turnId: 'turn-1', threadId: events[0]?.threadId ?? 'thread-1' }
    })
  }

  // ── Prompt routes to correct session ────────────────────────

  describe('prompt routing', () => {
    it('routes prompt to correct session by worktreePath and agentSessionId', async () => {
      seedSession('/project-a', 'thread-a', 'hive-a')
      seedSession('/project-b', 'thread-b', 'hive-b')

      simulateEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-a',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/project-a', 'thread-a', 'Hello A')

      expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-a', {
        text: 'Hello A',
        model: expect.any(String),
        interactionMode: 'default'
      })

      // Verify only session A got the user message
      const sessionA = impl.getSessions().get('/project-a::thread-a')!
      const sessionB = impl.getSessions().get('/project-b::thread-b')!

      expect(sessionA.messages.length).toBeGreaterThan(0)
      expect(sessionB.messages.length).toBe(0)
    })

    it('does not cross-pollinate events between sessions', async () => {
      seedSession('/project-a', 'thread-a', 'hive-a')
      seedSession('/project-b', 'thread-b', 'hive-b')

      // Events for thread-a
      simulateEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-a',
          createdAt: new Date().toISOString(),
          method: 'content.delta',
          payload: { delta: { type: 'text', text: 'Response A' } }
        },
        {
          id: 'e2',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-b',
          createdAt: new Date().toISOString(),
          method: 'content.delta',
          payload: { delta: { type: 'text', text: 'Response B should be ignored' } }
        },
        {
          id: 'e3',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-a',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/project-a', 'thread-a', 'test')

      // Check that events sent to renderer use hive-a session ID
      const sendCalls = mockWindow.webContents.send.mock.calls
      const textEvents = sendCalls
        .filter((c: any[]) => c[0] === 'opencode:stream')
        .map((c: any[]) => c[1])
        .filter((e: any) => e.type === 'message.part.updated' && e.data?.type === 'text')

      // Only thread-a events should produce text updates for hive-a
      for (const evt of textEvents) {
        expect(evt.sessionId).toBe('hive-a')
      }

      // Session A should only have accumulated thread-a text
      const sessionA = impl.getSessions().get('/project-a::thread-a')!
      const assistantMsg = sessionA.messages.find((m: any) => m.role === 'assistant') as any
      if (assistantMsg) {
        const textPart = assistantMsg.parts.find((p: any) => p.type === 'text')
        expect(textPart.text).not.toContain('Response B')
      }
    })

    it('routes child-thread text into a subtask instead of leaking it into the parent assistant text', async () => {
      const session = seedSession('/project-a', 'thread-a', 'hive-a')

      simulateEvents([
        {
          id: 'turn-start',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-a',
          createdAt: new Date().toISOString(),
          method: 'turn/started',
          turnId: 'turn-1',
          payload: { turn: { id: 'turn-1', status: 'running' } }
        },
        {
          id: 'child-text',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-a',
          childThreadId: 'child-1',
          turnId: 'turn-1',
          createdAt: new Date().toISOString(),
          method: 'item/agentMessage/delta',
          textDelta: 'Child analysis',
          payload: { delta: 'Child analysis' }
        },
        {
          id: 'turn-complete',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-a',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          turnId: 'turn-1',
          payload: { turn: { id: 'turn-1', status: 'completed' } }
        }
      ])

      await impl.prompt('/project-a', 'thread-a', 'Investigate')

      const assistantMessage = session.messages.find(
        (message: any) => message.role === 'assistant'
      ) as any
      expect(assistantMessage).toBeTruthy()
      expect(assistantMessage.parts).toEqual([
        {
          type: 'subtask',
          id: 'child-1',
          sessionID: 'child-1',
          prompt: '',
          description: '',
          agent: 'task',
          parts: [{ type: 'text', text: 'Child analysis' }],
          status: 'running'
        }
      ])
    })
  })

  // ── Context injection compatibility ─────────────────────────

  describe('context injection compatibility', () => {
    it('accepts string message with context prefix (IPC handler style)', async () => {
      seedSession('/project', 'thread-ctx', 'hive-ctx')

      simulateEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-ctx',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      // IPC handler prepends context like this
      const contextMessage =
        '[Worktree Context]\nThis is a React project\n\n[User Message]\nFix the bug'

      await impl.prompt('/project', 'thread-ctx', contextMessage)

      expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-ctx', {
        text: contextMessage,
        model: expect.any(String),
        interactionMode: 'default'
      })
    })

    it('accepts parts array with context prefix in text part', async () => {
      seedSession('/project', 'thread-ctx2', 'hive-ctx2')

      // Reset the session key
      impl.getSessions().delete('/project::thread-ctx2')
      seedSession('/project', 'thread-ctx2', 'hive-ctx2')

      simulateEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-ctx2',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      const parts = [
        {
          type: 'text' as const,
          text: '[Worktree Context]\nContext here\n\n[User Message]\nDo something'
        }
      ]

      await impl.prompt('/project', 'thread-ctx2', parts)

      expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-ctx2', {
        text: '[Worktree Context]\nContext here\n\n[User Message]\nDo something',
        model: expect.any(String),
        interactionMode: 'default'
      })
    })
  })

  // ── Multiple concurrent sessions ────────────────────────────

  describe('multiple concurrent sessions', () => {
    it('maintains separate message histories per session', async () => {
      const sessionA = seedSession('/project-a', 'thread-a', 'hive-a')
      const sessionB = seedSession('/project-b', 'thread-b', 'hive-b')

      // Prompt session A
      simulateEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-a',
          createdAt: new Date().toISOString(),
          method: 'item/agentMessage/delta',
          textDelta: 'Answer A',
          payload: { delta: 'Answer A' }
        },
        {
          id: 'e2',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-a',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/project-a', 'thread-a', 'Question A')

      // Now prompt session B
      eventListeners = []
      simulateEvents([
        {
          id: 'e3',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-b',
          createdAt: new Date().toISOString(),
          method: 'item/agentMessage/delta',
          textDelta: 'Answer B',
          payload: { delta: 'Answer B' }
        },
        {
          id: 'e4',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-b',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/project-b', 'thread-b', 'Question B')

      // Session A should have its own messages
      expect(sessionA.messages.length).toBe(2) // user + assistant
      const aAssistant = sessionA.messages[1] as any
      expect(aAssistant.parts[0].text).toBe('Answer A')

      // Session B should have its own messages
      expect(sessionB.messages.length).toBe(2) // user + assistant
      const bAssistant = sessionB.messages[1] as any
      expect(bAssistant.parts[0].text).toBe('Answer B')
    })

    it('getMessages returns correct history for each session', async () => {
      const sessionA = seedSession('/project-a', 'thread-a', 'hive-a')
      const sessionB = seedSession('/project-b', 'thread-b', 'hive-b')

      sessionA.messages = [
        { role: 'user', parts: [{ type: 'text', text: 'Q-A' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'A-A' }] }
      ]
      sessionB.messages = [{ role: 'user', parts: [{ type: 'text', text: 'Q-B' }] }]

      const messagesA = await impl.getMessages('/project-a', 'thread-a')
      const messagesB = await impl.getMessages('/project-b', 'thread-b')

      expect(messagesA).toHaveLength(2)
      expect(messagesB).toHaveLength(1)
      expect((messagesA[0] as any).parts[0].text).toBe('Q-A')
      expect((messagesB[0] as any).parts[0].text).toBe('Q-B')
    })
  })

  // ── Session status tracking ─────────────────────────────────

  describe('session status tracking', () => {
    it('sets status to running during prompt', async () => {
      const session = seedSession('/project', 'thread-status', 'hive-status')

      let statusDuringTurn: string | undefined
      mockManager.sendTurn.mockImplementation(async () => {
        statusDuringTurn = session.status
        setTimeout(() => {
          for (const listener of [...eventListeners]) {
            listener({
              id: 'e1',
              kind: 'notification',
              provider: 'codex',
              threadId: 'thread-status',
              createdAt: new Date().toISOString(),
              method: 'turn/completed',
              payload: { turn: { status: 'completed' } }
            })
          }
        }, 5)
        return { turnId: 'turn-1', threadId: 'thread-status' }
      })

      await impl.prompt('/project', 'thread-status', 'test')

      expect(statusDuringTurn).toBe('running')
      expect(session.status).toBe('ready')
    })

    it('sets status to error when turn fails', async () => {
      seedSession('/project', 'thread-err', 'hive-err')
      mockManager.sendTurn.mockRejectedValue(new Error('Network error'))

      impl.getSessions().delete('/project::thread-err')
      seedSession('/project', 'thread-err', 'hive-err')
      const updatedSession = impl.getSessions().get('/project::thread-err')!

      mockManager.sendTurn.mockRejectedValue(new Error('Network error'))

      await impl.prompt('/project', 'thread-err', 'test')

      expect(updatedSession.status).toBe('error')
    })
  })

  // ── Events reach renderer on opencode:stream channel ────────

  describe('renderer event delivery', () => {
    it('all events are sent on opencode:stream channel', async () => {
      seedSession('/project', 'thread-ch', 'hive-ch')

      simulateEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-ch',
          createdAt: new Date().toISOString(),
          method: 'content.delta',
          payload: { delta: { type: 'text', text: 'hi' } }
        },
        {
          id: 'e2',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-ch',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/project', 'thread-ch', 'test')

      const allCalls = mockWindow.webContents.send.mock.calls
      // All calls should be on the opencode:stream channel
      for (const call of allCalls) {
        expect(call[0]).toBe('opencode:stream')
      }
    })

    it('does not send events when window is destroyed', async () => {
      seedSession('/project', 'thread-nowin', 'hive-nowin')

      const destroyedWindow = {
        isDestroyed: () => true,
        webContents: { send: vi.fn() }
      } as any
      impl.setMainWindow(destroyedWindow)

      simulateEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-nowin',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/project', 'thread-nowin', 'test')

      expect(destroyedWindow.webContents.send).not.toHaveBeenCalled()
    })
  })
})
