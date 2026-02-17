/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))

vi.mock('../../../src/main/services/claude-transcript-reader', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    readClaudeTranscript: vi.fn().mockResolvedValue([])
  }
})

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'
import type { ClaudeSessionState } from '../../../src/main/services/claude-code-implementer'
import { readClaudeTranscript } from '../../../src/main/services/claude-transcript-reader'

const mockReadClaudeTranscript = vi.mocked(readClaudeTranscript)

describe('ClaudeCodeImplementer.getMessages', () => {
  let implementer: ClaudeCodeImplementer

  beforeEach(() => {
    vi.resetAllMocks()
    implementer = new ClaudeCodeImplementer()
    mockReadClaudeTranscript.mockResolvedValue([])
  })

  // 1. Returns in-memory cache when available
  it('returns in-memory cache when session has messages', async () => {
    const { sessionId } = await implementer.connect('/test/project', 'hive-session-1')

    // Access the internal session and inject messages
    const session = (implementer as any).getSession(
      '/test/project',
      sessionId
    ) as ClaudeSessionState
    expect(session).toBeDefined()

    const cachedMessages = [
      { id: 'msg-1', role: 'user', content: 'Hello', parts: [] },
      { id: 'msg-2', role: 'assistant', content: 'Hi there', parts: [] }
    ]
    session.messages = cachedMessages

    const result = await implementer.getMessages('/test/project', sessionId)
    expect(result).toBe(cachedMessages) // Same reference
    expect(result).toHaveLength(2)
    expect(mockReadClaudeTranscript).not.toHaveBeenCalled()
  })

  // 2. Falls back to JSONL when no in-memory cache
  it('falls back to JSONL transcript when no in-memory messages', async () => {
    const transcriptMessages = [{ id: 'disk-1', role: 'user', content: 'From disk', parts: [] }]
    mockReadClaudeTranscript.mockResolvedValue(transcriptMessages)

    // No connect — session doesn't exist, should fall through to transcript reader
    const result = await implementer.getMessages('/some/path', 'unknown-session')
    expect(result).toEqual(transcriptMessages)
    expect(mockReadClaudeTranscript).toHaveBeenCalledWith('/some/path', 'unknown-session')
  })

  // 3. Falls back to JSONL when session exists but messages array is empty
  it('falls back to JSONL when session exists but messages are empty', async () => {
    const { sessionId } = await implementer.connect('/test/project', 'hive-session-2')

    const transcriptMessages = [
      { id: 'disk-1', role: 'assistant', content: 'Transcript data', parts: [] }
    ]
    mockReadClaudeTranscript.mockResolvedValue(transcriptMessages)

    const result = await implementer.getMessages('/test/project', sessionId)
    expect(result).toEqual(transcriptMessages)
    expect(mockReadClaudeTranscript).toHaveBeenCalledWith('/test/project', sessionId)
  })

  // 4. Returns [] for unknown sessions with no transcript
  it('returns empty array when both in-memory and transcript are empty', async () => {
    mockReadClaudeTranscript.mockResolvedValue([])

    const result = await implementer.getMessages('/nonexistent', 'no-session')
    expect(result).toEqual([])
  })

  // 5. In-memory messages persist across prompt turns (not cleared)
  it('does not clear messages array between calls', async () => {
    const { sessionId } = await implementer.connect('/test/project', 'hive-session-3')
    const session = (implementer as any).getSession(
      '/test/project',
      sessionId
    ) as ClaudeSessionState

    // Simulate accumulated messages from prior prompt turns
    session.messages.push(
      { id: 'msg-1', role: 'user', content: 'First', parts: [] },
      { id: 'msg-2', role: 'assistant', content: 'Second', parts: [] }
    )

    const result = await implementer.getMessages('/test/project', sessionId)
    expect(result).toHaveLength(2)

    // Add more messages
    session.messages.push({ id: 'msg-3', role: 'user', content: 'Third', parts: [] })

    const result2 = await implementer.getMessages('/test/project', sessionId)
    expect(result2).toHaveLength(3)
  })
})
