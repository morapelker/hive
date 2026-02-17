/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn()
}))
vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn().mockResolvedValue({ query: mockQuery })
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

function createMockQueryIterator(messages: Array<Record<string, unknown>>) {
  let index = 0
  const iterator = {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    next: vi.fn().mockImplementation(async () => {
      if (index < messages.length) {
        return { done: false, value: messages[index++] }
      }
      return { done: true, value: undefined }
    }),
    return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator
  }
  return iterator
}

function getStreamEvents(mockWindow: BrowserWindow): Array<Record<string, unknown>> {
  const send = (mockWindow.webContents as any).send as ReturnType<typeof vi.fn>
  return send.mock.calls
    .filter((call: any[]) => call[0] === 'opencode:stream')
    .map((call: any[]) => call[1] as Record<string, unknown>)
}

describe('Session 4 – Integration smoke tests', () => {
  let impl: ClaudeCodeImplementer
  let mockWindow: BrowserWindow

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new ClaudeCodeImplementer()
    mockWindow = createMockWindow()
    impl.setMainWindow(mockWindow)
  })

  it('connect → prompt → stream events → idle lifecycle', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')

    const messages = [
      {
        type: 'assistant',
        session_id: 'sdk-real',
        content: [{ type: 'text', text: 'Hello world' }]
      },
      {
        type: 'result',
        session_id: 'sdk-real',
        is_error: false,
        content: 'done'
      }
    ]
    mockQuery.mockReturnValue(createMockQueryIterator(messages))

    await impl.prompt('/proj', sessionId, 'Hi')

    const events = getStreamEvents(mockWindow)
    const types = events.map((e) => e.type)

    // Must start with busy
    expect(types[0]).toBe('session.status')
    expect((events[0] as any).statusPayload.type).toBe('busy')

    // Must contain message events
    expect(types).toContain('message.part.updated')
    expect(types).toContain('message.updated')

    // Must end with idle
    const lastEvent = events[events.length - 1] as any
    expect(lastEvent.type).toBe('session.status')
    expect(lastEvent.statusPayload.type).toBe('idle')

    // All events have the correct hiveSessionId
    for (const evt of events) {
      expect(evt.sessionId).toBe('hive-1')
    }
  })

  it('connect → prompt → abort → idle lifecycle', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')

    // Create an iterator that completes after two messages
    const slowIterator = {
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      next: vi.fn().mockImplementation(async () => {
        // First call returns a message, second call ends the stream
        if (slowIterator.next.mock.calls.length === 1) {
          return {
            done: false,
            value: {
              type: 'assistant',
              session_id: 'sdk-1',
              content: [{ type: 'text', text: 'Partial' }]
            }
          }
        }
        return { done: true, value: undefined }
      }),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      [Symbol.asyncIterator]: () => slowIterator
    }
    mockQuery.mockReturnValue(slowIterator)

    await impl.prompt('/proj', sessionId, 'Think hard')

    // Now abort — should succeed even after streaming completed (no-op)
    await impl.abort('/proj', sessionId.startsWith('pending::') ? sessionId : 'sdk-1')

    const events = getStreamEvents(mockWindow)

    // Should have busy at start and idle at end
    expect((events[0] as any).statusPayload?.type).toBe('busy')
    const idleEvents = events.filter(
      (e: any) => e.type === 'session.status' && e.statusPayload?.type === 'idle'
    )
    expect(idleEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('reconnect → prompt uses resume option', async () => {
    await impl.reconnect('/proj', 'real-sdk-id-123', 'hive-2')

    const messages = [
      {
        type: 'assistant',
        session_id: 'real-sdk-id-123',
        content: [{ type: 'text', text: 'Resumed response' }]
      }
    ]
    mockQuery.mockReturnValue(createMockQueryIterator(messages))

    await impl.prompt('/proj', 'real-sdk-id-123', 'Continue where we left off')

    // Verify query was called with resume
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.resume).toBe('real-sdk-id-123')
    expect(callArgs.options.cwd).toBe('/proj')
  })

  it('full lifecycle: connect → prompt → materialization → second prompt with resume', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-3')
    expect(sessionId).toMatch(/^pending::/)

    // First prompt — materializes session
    const messages1 = [
      {
        type: 'assistant',
        session_id: 'materialized-id',
        content: [{ type: 'text', text: 'First response' }]
      }
    ]
    mockQuery.mockReturnValue(createMockQueryIterator(messages1))
    await impl.prompt('/proj', sessionId, 'First question')

    // Session should now be keyed under materialized ID
    const sessions = (impl as any).sessions as Map<string, any>
    expect(sessions.has('/proj::materialized-id')).toBe(true)
    expect(sessions.has(`/proj::${sessionId}`)).toBe(false)

    // Second prompt — should use resume with materialized ID
    const messages2 = [
      {
        type: 'assistant',
        session_id: 'materialized-id',
        content: [{ type: 'text', text: 'Second response' }]
      }
    ]
    mockQuery.mockReturnValue(createMockQueryIterator(messages2))
    await impl.prompt('/proj', 'materialized-id', 'Follow-up question')

    expect(mockQuery).toHaveBeenCalledTimes(2)
    const secondCallArgs = mockQuery.mock.calls[1][0]
    expect(secondCallArgs.options.resume).toBe('materialized-id')
  })

  it('error during streaming emits error and idle without throwing', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-err')

    // Create iterator that throws mid-stream
    const errorIterator = {
      interrupt: vi.fn(),
      close: vi.fn(),
      next: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: {
            type: 'assistant',
            session_id: 'sdk-err',
            content: [{ type: 'text', text: 'partial' }]
          }
        })
        .mockRejectedValueOnce(new Error('SDK stream failed')),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      [Symbol.asyncIterator]: () => errorIterator
    }
    mockQuery.mockReturnValue(errorIterator)

    // Should not throw
    await impl.prompt('/proj', sessionId, 'cause error')

    const events = getStreamEvents(mockWindow)
    const types = events.map((e) => e.type)

    expect(types).toContain('session.error')
    // Last event must be idle
    expect(events[events.length - 1]).toMatchObject({
      type: 'session.status',
      statusPayload: { type: 'idle' }
    })
  })
})
