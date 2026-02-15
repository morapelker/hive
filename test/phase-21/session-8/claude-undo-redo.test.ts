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

vi.mock('../../../src/main/services/claude-transcript-reader', () => ({
  readClaudeTranscript: vi.fn().mockResolvedValue([]),
  translateEntry: vi
    .fn()
    .mockImplementation(
      (
        entry: { type: string; uuid?: string; message?: { content?: unknown[] | string } },
        index: number
      ) => {
        if (entry.type !== 'user' && entry.type !== 'assistant') return null
        const content = Array.isArray(entry.message?.content)
          ? entry.message.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('')
          : ''
        return {
          id: entry.uuid ?? `entry-${index}`,
          role: entry.type,
          timestamp: new Date().toISOString(),
          content,
          parts: Array.isArray(entry.message?.content)
            ? entry.message.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => ({ type: 'text', text: b.text }))
            : []
        }
      }
    )
}))

import {
  ClaudeCodeImplementer,
  type ClaudeSessionState
} from '../../../src/main/services/claude-code-implementer'

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

/** Create a mock async iterator that yields SDK messages then completes */
function createMockQueryIterator(
  messages: Array<Record<string, unknown>>,
  extras?: { rewindFiles?: ReturnType<typeof vi.fn> }
) {
  let index = 0
  const iterator = {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    rewindFiles: extras?.rewindFiles ?? vi.fn(),
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

describe('ClaudeCodeImplementer - undo/redo/getSessionInfo (Session 8)', () => {
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

  // ── Helper: run a prompt that materializes the session and sets checkpoints ──

  async function setupSessionWithCheckpoints(opts?: {
    userUuids?: string[]
    userPrompts?: string[]
  }) {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const userUuids = opts?.userUuids ?? ['uuid-user-1', 'uuid-user-2']
    const userPrompts = opts?.userPrompts ?? ['first prompt', 'second prompt']

    const sdkMessages: Array<Record<string, unknown>> = []

    // First assistant message materializes the session
    sdkMessages.push({
      type: 'assistant',
      session_id: 'sdk-session-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Response 1' }]
      }
    })

    // Add user + assistant pairs for each checkpoint
    for (let i = 0; i < userUuids.length; i++) {
      sdkMessages.push({
        type: 'user',
        session_id: 'sdk-session-1',
        uuid: userUuids[i],
        message: {
          role: 'user',
          content: [{ type: 'text', text: userPrompts[i] ?? `prompt ${i}` }]
        }
      })
      sdkMessages.push({
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Response ${i + 2}` }]
        }
      })
    }

    const rewindFilesMock = vi.fn().mockResolvedValue({
      canRewind: true,
      filesChanged: ['src/a.ts', 'src/b.ts'],
      insertions: 10,
      deletions: 5
    })

    const iter = createMockQueryIterator(sdkMessages, {
      rewindFiles: rewindFilesMock
    })
    mockQuery.mockReturnValue(iter)

    await impl.prompt('/proj', sessionId, 'initial prompt')

    // After prompt, session is materialized as 'sdk-session-1'
    const key = (impl as any).getSessionKey('/proj', 'sdk-session-1')
    const session = sessions.get(key)!

    return { session, sessionId: 'sdk-session-1', rewindFilesMock, iter }
  }

  // ── Task 1: enableFileCheckpointing ─────────────────────────────────

  describe('enableFileCheckpointing', () => {
    it('passes enableFileCheckpointing: true in query options', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }]
          }
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'test')

      expect(mockQuery).toHaveBeenCalledTimes(1)
      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.enableFileCheckpointing).toBe(true)
    })
  })

  // ── Task 2b: undo() ─────────────────────────────────────────────────

  describe('undo()', () => {
    it('calls rewindFiles with the correct user message UUID', async () => {
      const { rewindFilesMock } = await setupSessionWithCheckpoints()

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      expect(rewindFilesMock).toHaveBeenCalledWith('uuid-user-2')
    })

    it('returns revertMessageID, restoredPrompt, and revertDiff', async () => {
      await setupSessionWithCheckpoints({
        userPrompts: ['first prompt', 'second prompt']
      })

      const result = await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      expect(result).toHaveProperty('revertMessageID')
      expect(typeof result.revertMessageID).toBe('string')
      expect(result).toHaveProperty('restoredPrompt')
      expect(result).toHaveProperty('revertDiff')
      expect(result.revertDiff).toContain('2 file(s) changed')
      expect(result.revertDiff).toContain('+10')
      expect(result.revertDiff).toContain('-5')
    })

    it('sets revertMessageID on the session (verified via getSessionInfo)', async () => {
      await setupSessionWithCheckpoints()

      // Before undo: no revert state
      const infoBefore = await impl.getSessionInfo('/proj', 'sdk-session-1')
      expect(infoBefore.revertMessageID).toBeNull()

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      const infoAfter = await impl.getSessionInfo('/proj', 'sdk-session-1')
      expect(infoAfter.revertMessageID).not.toBeNull()
      expect(typeof infoAfter.revertMessageID).toBe('string')
      expect(infoAfter.revertDiff).toContain('file(s) changed')
    })

    it('throws "Nothing to undo" when no checkpoints exist', async () => {
      await impl.reconnect('/proj', 'no-checkpoints-session', 'hive-1')

      await expect(impl.undo('/proj', 'no-checkpoints-session', 'hive-1')).rejects.toThrow(
        'Nothing to undo'
      )
    })

    it('throws when rewindFiles returns canRewind: false', async () => {
      const { rewindFilesMock } = await setupSessionWithCheckpoints()

      rewindFilesMock.mockResolvedValue({
        canRewind: false,
        error: 'File checkpointing not enabled'
      })

      await expect(impl.undo('/proj', 'sdk-session-1', 'hive-1')).rejects.toThrow(
        'File checkpointing not enabled'
      )
    })

    it('throws generic message when canRewind: false with no error', async () => {
      const { rewindFilesMock } = await setupSessionWithCheckpoints()

      rewindFilesMock.mockResolvedValue({ canRewind: false })

      await expect(impl.undo('/proj', 'sdk-session-1', 'hive-1')).rejects.toThrow(
        'Cannot rewind to this point'
      )
    })

    it('walks backward past already-reverted messages (multiple undo)', async () => {
      const { rewindFilesMock } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
        userPrompts: ['prompt A', 'prompt B', 'prompt C']
      })

      // First undo: should rewind to uuid-3 (most recent)
      const result1 = await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(rewindFilesMock).toHaveBeenLastCalledWith('uuid-3')

      // Second undo: should walk past the revert boundary and target uuid-2
      const result2 = await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(rewindFilesMock).toHaveBeenLastCalledWith('uuid-2')

      // Third undo: should target uuid-1
      const result3 = await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(rewindFilesMock).toHaveBeenLastCalledWith('uuid-1')

      // All results should have revertMessageID
      expect(result1.revertMessageID).toBeTruthy()
      expect(result2.revertMessageID).toBeTruthy()
      expect(result3.revertMessageID).toBeTruthy()
      // They should all be different
      expect(result1.revertMessageID).not.toBe(result2.revertMessageID)
      expect(result2.revertMessageID).not.toBe(result3.revertMessageID)
    })

    it('throws after exhausting all undo checkpoints', async () => {
      await setupSessionWithCheckpoints({
        userUuids: ['uuid-only'],
        userPrompts: ['only prompt']
      })

      // First undo succeeds
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Second undo should fail — no more checkpoints before the boundary
      await expect(impl.undo('/proj', 'sdk-session-1', 'hive-1')).rejects.toThrow('Nothing to undo')
    })

    it('throws when session not found', async () => {
      await expect(impl.undo('/proj', 'nonexistent', 'hive-1')).rejects.toThrow(
        /session not found/i
      )
    })

    it('throws when no query reference is available', async () => {
      await impl.reconnect('/proj', 'orphan-session', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', 'orphan-session')
      const session = sessions.get(key)!
      // Manually add a checkpoint so we pass the "no checkpoints" check
      session.checkpoints.set('some-uuid', 0)
      session.messages.push({
        id: 'msg-0',
        role: 'user',
        content: 'test',
        parts: [{ type: 'text', text: 'test' }]
      })
      // query and lastQuery are both null (default)

      await expect(impl.undo('/proj', 'orphan-session', 'hive-1')).rejects.toThrow(
        /no SDK query available/i
      )
    })

    it('throws when query does not support rewindFiles', async () => {
      await impl.reconnect('/proj', 'no-rewind-session', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', 'no-rewind-session')
      const session = sessions.get(key)!
      session.checkpoints.set('some-uuid', 0)
      session.messages.push({
        id: 'msg-0',
        role: 'user',
        content: 'test',
        parts: [{ type: 'text', text: 'test' }]
      })
      // Set lastQuery WITHOUT rewindFiles to test the type-safe check
      session.lastQuery = {
        interrupt: vi.fn(),
        close: vi.fn(),
        next: vi.fn(),
        [Symbol.asyncIterator]: vi.fn()
      } as any

      await expect(impl.undo('/proj', 'no-rewind-session', 'hive-1')).rejects.toThrow(
        /does not support rewindFiles/i
      )
    })

    it('stores revertCheckpointUuid as SDK UUID for boundary lookups', async () => {
      await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
        userPrompts: ['prompt A', 'prompt B', 'prompt C']
      })

      const key = (impl as any).getSessionKey('/proj', 'sdk-session-1')
      const session = sessions.get(key)!

      // Before undo: no revert checkpoint UUID
      expect(session.revertCheckpointUuid).toBeNull()

      // First undo targets uuid-3
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(session.revertCheckpointUuid).toBe('uuid-3')

      // Second undo targets uuid-2
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(session.revertCheckpointUuid).toBe('uuid-2')

      // Third undo targets uuid-1
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(session.revertCheckpointUuid).toBe('uuid-1')
    })

    it('returns null revertDiff when no files changed', async () => {
      const { rewindFilesMock } = await setupSessionWithCheckpoints()

      rewindFilesMock.mockResolvedValue({
        canRewind: true,
        filesChanged: [],
        insertions: 0,
        deletions: 0
      })

      const result = await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(result.revertDiff).toBeNull()
    })
  })

  // ── Task 2c: redo() ─────────────────────────────────────────────────

  describe('redo()', () => {
    it('throws "Redo is not supported for Claude Code sessions"', async () => {
      await expect(impl.redo('/proj', 'any-session', 'hive-1')).rejects.toThrow(
        'Redo is not supported for Claude Code sessions'
      )
    })
  })

  // ── Task 2d: getSessionInfo() ───────────────────────────────────────

  describe('getSessionInfo()', () => {
    it('returns null revert state by default', async () => {
      await impl.reconnect('/proj', 'test-session', 'hive-1')

      const info = await impl.getSessionInfo('/proj', 'test-session')
      expect(info).toEqual({
        revertMessageID: null,
        revertDiff: null
      })
    })

    it('returns tracked revert boundary after undo', async () => {
      await setupSessionWithCheckpoints()

      const undoResult = await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      const info = await impl.getSessionInfo('/proj', 'sdk-session-1')
      expect(info.revertMessageID).toBe(undoResult.revertMessageID)
      expect(info.revertDiff).toBe(undoResult.revertDiff)
    })

    it('returns null for nonexistent session', async () => {
      const info = await impl.getSessionInfo('/proj', 'nonexistent')
      expect(info).toEqual({
        revertMessageID: null,
        revertDiff: null
      })
    })
  })

  // ── Task 8: new prompt clears revert boundary ───────────────────────

  describe('new prompt clears revert boundary', () => {
    it('clears revertMessageID, revertCheckpointUuid, and revertDiff on new prompt', async () => {
      const { rewindFilesMock } = await setupSessionWithCheckpoints()

      // Undo sets revert state
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', 'sdk-session-1')
      const session = sessions.get(key)!
      expect(session.revertMessageID).not.toBeNull()
      expect(session.revertCheckpointUuid).not.toBeNull()

      // New prompt should clear it
      const iter2 = createMockQueryIterator(
        [
          {
            type: 'assistant',
            session_id: 'sdk-session-1',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'New response' }]
            }
          }
        ],
        { rewindFiles: rewindFilesMock }
      )
      mockQuery.mockReturnValue(iter2)

      await impl.prompt('/proj', 'sdk-session-1', 'a new prompt')

      const infoAfterPrompt = await impl.getSessionInfo('/proj', 'sdk-session-1')
      expect(infoAfterPrompt.revertMessageID).toBeNull()
      expect(infoAfterPrompt.revertDiff).toBeNull()
      expect(session.revertCheckpointUuid).toBeNull()
    })
  })

  // ── lastQuery preservation ──────────────────────────────────────────

  describe('lastQuery preservation', () => {
    it('preserves lastQuery after prompt completes', async () => {
      const { session } = await setupSessionWithCheckpoints()

      // After prompt completes: query should be null, lastQuery should be set
      expect(session.query).toBeNull()
      expect(session.lastQuery).not.toBeNull()
    })

    it('uses lastQuery for undo when no active query', async () => {
      const { session, rewindFilesMock } = await setupSessionWithCheckpoints()

      // Verify query is null (prompt completed) but lastQuery exists
      expect(session.query).toBeNull()
      expect(session.lastQuery).not.toBeNull()

      // undo should succeed using lastQuery
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(rewindFilesMock).toHaveBeenCalled()
    })
  })
})
