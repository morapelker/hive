/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import {
  ClaudeCodeImplementer,
  type ClaudeSessionState,
  type ClaudeQuery
} from '../../../src/main/services/claude-code-implementer'

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

function createMockQuery(overrides: Partial<ClaudeQuery> = {}): ClaudeQuery {
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    next: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    [Symbol.asyncIterator]: vi.fn() as any,
    ...overrides
  }
}

function getStreamEvents(window: BrowserWindow): any[] {
  const send = (window.webContents as any).send as ReturnType<typeof vi.fn>
  return send.mock.calls
    .filter((call: any[]) => call[0] === 'opencode:stream')
    .map((call: any[]) => call[1])
}

describe('ClaudeCodeImplementer – abort (Session 4)', () => {
  let impl: ClaudeCodeImplementer
  let sessions: Map<string, ClaudeSessionState>
  let mockWindow: BrowserWindow

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new ClaudeCodeImplementer()
    sessions = (impl as any).sessions
    mockWindow = createMockWindow()
    impl.setMainWindow(mockWindow)
  })

  it('returns false when session is not found', async () => {
    const result = await impl.abort('/proj', 'nonexistent')
    expect(result).toBe(false)
  })

  it('aborts the abort controller', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const key = (impl as any).getSessionKey('/proj', sessionId)
    const controller = sessions.get(key)!.abortController!

    expect(controller.signal.aborted).toBe(false)
    await impl.abort('/proj', sessionId)
    expect(controller.signal.aborted).toBe(true)
  })

  it('calls query.interrupt() if a query is active', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const key = (impl as any).getSessionKey('/proj', sessionId)
    const mockQ = createMockQuery()
    sessions.get(key)!.query = mockQ

    await impl.abort('/proj', sessionId)
    expect(mockQ.interrupt).toHaveBeenCalled()
  })

  it('emits session.status idle after abort', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')

    await impl.abort('/proj', sessionId)

    const events = getStreamEvents(mockWindow)

    expect(events.length).toBeGreaterThanOrEqual(1)
    const idleEvent = events.find(
      (e: any) => e.type === 'session.status' && e.statusPayload?.type === 'idle'
    )
    expect(idleEvent).toBeDefined()
  })

  it('returns true on successful abort', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const result = await impl.abort('/proj', sessionId)
    expect(result).toBe(true)
  })

  it('does not throw when query.interrupt() throws', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const key = (impl as any).getSessionKey('/proj', sessionId)
    const mockQ = createMockQuery({
      interrupt: vi.fn().mockRejectedValue(new Error('interrupt failed'))
    })
    sessions.get(key)!.query = mockQ

    const result = await impl.abort('/proj', sessionId)
    expect(result).toBe(true)
    expect(mockQ.interrupt).toHaveBeenCalled()
  })
})
