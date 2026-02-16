/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

const { mockQuery, mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn()
}))
vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn().mockResolvedValue({ query: mockQuery })
}))

vi.mock('fs/promises', () => ({
  default: { readFile: mockReadFile, writeFile: mockWriteFile },
  readFile: mockReadFile,
  writeFile: mockWriteFile
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
  encodePath: vi.fn().mockImplementation((p: string) => p.replace(/[/.]/g, '-')),
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
    mockQuery.mockReset()
    // Default: JSONL file does not exist (most tests don't need it)
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'))
    mockWriteFile.mockResolvedValue(undefined)
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

    const promptIter = createMockQueryIterator(sdkMessages, {
      rewindFiles: rewindFilesMock
    })
    mockQuery
      .mockImplementationOnce(() => promptIter)
      .mockImplementation(() =>
        createMockQueryIterator(
          [
            {
              type: 'system',
              subtype: 'init',
              session_id: 'sdk-session-1'
            }
          ],
          { rewindFiles: rewindFilesMock }
        )
      )

    await impl.prompt('/proj', sessionId, userPrompts[0] ?? 'initial prompt')

    // After prompt, session is materialized as 'sdk-session-1'
    const key = (impl as any).getSessionKey('/proj', 'sdk-session-1')
    const session = sessions.get(key)!

    return { session, sessionId: 'sdk-session-1', rewindFilesMock, iter: promptIter }
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
      expect(callArgs.options.extraArgs).toEqual({ 'replay-user-messages': null })
      expect(callArgs.options.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('1')
    })
  })

  // ── Task 2b: undo() ─────────────────────────────────────────────────

  describe('undo()', () => {
    it('replaces optimistic local user message with SDK user UUID', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-user-1'],
        userPrompts: ['first prompt']
      })

      const userMessages = session.messages.filter(
        (m) => (m as { role?: string }).role === 'user'
      ) as Array<{ id?: string; content?: string }>

      expect(userMessages).toHaveLength(1)
      expect(userMessages[0].id).toBe('uuid-user-1')
      expect(userMessages[0].content).toBe('first prompt')
    })

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

    it('targets the latest checkpoint across multiple prompt calls', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const prompt1 = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'first response' }]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'prompt one' }]
          }
        }
      ])

      const prompt2 = createMockQueryIterator([
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-2',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'prompt two' }]
          }
        }
      ])

      const prompt3 = createMockQueryIterator([
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-3',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'prompt three' }]
          }
        }
      ])

      const resumeRewindFilesMock = vi.fn().mockResolvedValue({ canRewind: true })
      const resumeIter = createMockQueryIterator(
        [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-1'
          }
        ],
        { rewindFiles: resumeRewindFilesMock }
      )

      mockQuery
        .mockReturnValueOnce(prompt1)
        .mockReturnValueOnce(prompt2)
        .mockReturnValueOnce(prompt3)
        .mockReturnValueOnce(resumeIter)

      await impl.prompt('/proj', sessionId, 'prompt one')
      await impl.prompt('/proj', 'sdk-session-1', 'prompt two')
      await impl.prompt('/proj', 'sdk-session-1', 'prompt three')

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      expect(resumeRewindFilesMock).toHaveBeenCalledWith('uuid-3')
    })

    it('captures first-seen checkpoint even when SDK marks message as replay', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const prompt1 = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'first response' }]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'prompt one' }]
          }
        }
      ])

      const prompt2 = createMockQueryIterator([
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-2',
          isReplay: true,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'prompt two' }]
          }
        }
      ])

      const resumeRewindFilesMock = vi.fn().mockResolvedValue({ canRewind: true })
      const resumeIter = createMockQueryIterator(
        [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-1'
          }
        ],
        { rewindFiles: resumeRewindFilesMock }
      )

      mockQuery
        .mockReturnValueOnce(prompt1)
        .mockReturnValueOnce(prompt2)
        .mockReturnValueOnce(resumeIter)

      await impl.prompt('/proj', sessionId, 'prompt one')
      await impl.prompt('/proj', 'sdk-session-1', 'prompt two')
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      expect(resumeRewindFilesMock).toHaveBeenCalledWith('uuid-2')
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

    it('throws when it cannot create a resumed query for rewinding', async () => {
      await impl.reconnect('/proj', 'orphan-session', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', 'orphan-session')
      const session = sessions.get(key)!
      // Manually add a checkpoint so we pass the "no checkpoints" check
      session.checkpoints.set('some-uuid', 0)
      session.messages.push({
        id: 'some-uuid',
        role: 'user',
        content: 'test',
        parts: [{ type: 'text', text: 'test' }]
      })
      // No mock query configured, so resume should fail.

      await expect(impl.undo('/proj', 'orphan-session', 'hive-1')).rejects.toThrow(
        /failed to resume session for rewinding/i
      )
    })

    it('throws when resumed query does not support rewindFiles', async () => {
      await impl.reconnect('/proj', 'no-rewind-session', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', 'no-rewind-session')
      const session = sessions.get(key)!
      session.checkpoints.set('some-uuid', 0)
      session.messages.push({
        id: 'some-uuid',
        role: 'user',
        content: 'test',
        parts: [{ type: 'text', text: 'test' }]
      })
      const noRewindIter = createMockQueryIterator([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'no-rewind-session'
        }
      ])
      delete (noRewindIter as { rewindFiles?: unknown }).rewindFiles
      mockQuery.mockReturnValue(noRewindIter)

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

    it('resumes with an empty prompt and rewinds on a new query when stream is complete', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const promptRewindFilesMock = vi.fn().mockResolvedValue({
        canRewind: true,
        filesChanged: ['src/a.ts'],
        insertions: 1,
        deletions: 1
      })
      const promptIter = createMockQueryIterator(
        [
          {
            type: 'assistant',
            session_id: 'sdk-session-1',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Response 1' }]
            }
          },
          {
            type: 'user',
            session_id: 'sdk-session-1',
            uuid: 'uuid-user-1',
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'first prompt' }]
            }
          },
          {
            type: 'assistant',
            session_id: 'sdk-session-1',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Response 2' }]
            }
          }
        ],
        {
          rewindFiles: promptRewindFilesMock
        }
      )

      const resumeRewindFilesMock = vi.fn().mockResolvedValue({
        canRewind: true,
        filesChanged: ['src/b.ts'],
        insertions: 2,
        deletions: 1
      })
      const resumeIter = createMockQueryIterator(
        [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-1'
          }
        ],
        { rewindFiles: resumeRewindFilesMock }
      )

      mockQuery.mockReturnValueOnce(promptIter).mockReturnValueOnce(resumeIter)

      await impl.prompt('/proj', sessionId, 'initial prompt')

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      expect(mockQuery).toHaveBeenCalledTimes(2)

      const resumeCall = mockQuery.mock.calls[1][0]
      expect(resumeCall.prompt).toBe('')
      expect(resumeCall.options.resume).toBe('sdk-session-1')
      expect(resumeCall.options.enableFileCheckpointing).toBe(true)

      expect(promptRewindFilesMock).not.toHaveBeenCalled()
      expect(resumeRewindFilesMock).toHaveBeenCalledWith('uuid-user-1')
    })

    it('accepts void rewindFiles return values', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const promptIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response 1' }]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-user-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'first prompt' }]
          }
        }
      ])

      const resumeRewindFilesMock = vi.fn().mockResolvedValue(undefined)
      const resumeIter = createMockQueryIterator(
        [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-1'
          }
        ],
        { rewindFiles: resumeRewindFilesMock }
      )

      mockQuery.mockReturnValueOnce(promptIter).mockReturnValueOnce(resumeIter)

      await impl.prompt('/proj', sessionId, 'initial prompt')

      const result = await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(resumeRewindFilesMock).toHaveBeenCalledWith('uuid-user-1')
      expect(result.revertDiff).toBeNull()
    })

    it('skips tool_result-only user UUIDs when selecting undo checkpoint', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const promptIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response 1' }]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-user-prompt',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'real prompt' }]
          }
        },
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { filePath: 'a.ts' } }]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-tool-result',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }]
          }
        }
      ])

      const resumeRewindFilesMock = vi.fn().mockResolvedValue({ canRewind: true })
      const resumeIter = createMockQueryIterator(
        [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-1'
          }
        ],
        { rewindFiles: resumeRewindFilesMock }
      )

      mockQuery.mockReturnValueOnce(promptIter).mockReturnValueOnce(resumeIter)

      await impl.prompt('/proj', sessionId, 'initial prompt')
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      expect(resumeRewindFilesMock).toHaveBeenCalledWith('uuid-user-prompt')
    })

    it('falls back to conversation-only undo when no file checkpoint exists for selected UUID', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const promptIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response 1' }]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-user-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'first prompt' }]
          }
        }
      ])

      const resumeIter = createMockQueryIterator(
        [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-1'
          }
        ],
        {
          rewindFiles: vi
            .fn()
            .mockRejectedValue(new Error('No file checkpoint found for this message.'))
        }
      )

      const postUndoPromptIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'post undo response' }]
          }
        }
      ])

      mockQuery
        .mockReturnValueOnce(promptIter)
        .mockReturnValueOnce(resumeIter)
        .mockReturnValueOnce(postUndoPromptIter)

      await impl.prompt('/proj', sessionId, 'initial prompt')

      const undoResult = await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(undoResult.revertMessageID).toBe('uuid-user-1')
      expect(undoResult.revertDiff).toBeNull()

      await impl.prompt('/proj', 'sdk-session-1', 'follow-up prompt')

      // When undoing the only prompt, there is no previous checkpoint to
      // resume at.  The session is de-materialized so the next prompt()
      // starts a fresh SDK conversation (no resume, no resumeSessionAt).
      const followUpCall = mockQuery.mock.calls[2][0]
      expect(followUpCall.options.resumeSessionAt).toBeUndefined()
      expect(followUpCall.options.resume).toBeUndefined()
    })

    it('sets resumeSessionAt to PREVIOUS checkpoint UUID (not the undone one)', async () => {
      // Two prompts: A (uuid-user-1) and B (uuid-user-2).
      // Undoing should target B and set resumeSessionAt to A.
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const prompt1Iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'first response' }]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-A',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'prompt A' }]
          }
        }
      ])

      const prompt2Iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'second response' }]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-B',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'prompt B' }]
          }
        }
      ])

      // Resume query used by rewindWithResumedQuery during undo
      const rewindResumeIter = createMockQueryIterator(
        [{ type: 'system', subtype: 'init', session_id: 'sdk-session-1' }],
        { rewindFiles: vi.fn().mockResolvedValue({ canRewind: true, filesChanged: [] }) }
      )

      const postUndoIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'post undo response' }]
          }
        }
      ])

      mockQuery
        .mockReturnValueOnce(prompt1Iter)
        .mockReturnValueOnce(prompt2Iter)
        .mockReturnValueOnce(rewindResumeIter) // undo's rewindWithResumedQuery
        .mockReturnValueOnce(postUndoIter)

      await impl.prompt('/proj', sessionId, 'prompt A')
      await impl.prompt('/proj', 'sdk-session-1', 'prompt B')

      // Undo: should target uuid-B (latest) and set resumeSessionAt to uuid-A
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      await impl.prompt('/proj', 'sdk-session-1', 'new prompt after undo')

      // The post-undo prompt should use forkSession: true (not resumeSessionAt)
      const postUndoCall = mockQuery.mock.calls[3][0]
      expect(postUndoCall.options.forkSession).toBe(true)
      expect(postUndoCall.options.resume).toBe('sdk-session-1')
    })

    it('de-materializes session when undoing the only prompt (no previous checkpoint)', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const promptIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'only response' }]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'uuid-only',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'only prompt' }]
          }
        }
      ])

      const postUndoIter = createMockQueryIterator([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sdk-session-2'
        },
        {
          type: 'assistant',
          session_id: 'sdk-session-2',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'fresh start response' }]
          }
        }
      ])

      // Resume query used by rewindWithResumedQuery during undo
      const rewindResumeIter = createMockQueryIterator(
        [{ type: 'system', subtype: 'init', session_id: 'sdk-session-1' }],
        { rewindFiles: vi.fn().mockResolvedValue({ canRewind: true, filesChanged: [] }) }
      )

      mockQuery
        .mockReturnValueOnce(promptIter)
        .mockReturnValueOnce(rewindResumeIter) // undo's rewindWithResumedQuery
        .mockReturnValueOnce(postUndoIter)

      await impl.prompt('/proj', sessionId, 'only prompt')
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Session should be de-materialized with no pending fork
      const key = (impl as any).getSessionKey('/proj', 'sdk-session-1')
      const session = (impl as any).sessions.get(key)
      expect(session.materialized).toBe(false)
      expect(session.pendingFork).toBe(false)

      await impl.prompt('/proj', 'sdk-session-1', 'fresh prompt')

      // No resume, no forkSession — it's a brand new session
      const freshCall = mockQuery.mock.calls[2][0]
      expect(freshCall.options.resume).toBeUndefined()
      expect(freshCall.options.forkSession).toBeUndefined()
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

    it('creates a resumed query for undo when no active query', async () => {
      const { session } = await setupSessionWithCheckpoints()

      const resumeRewindFilesMock = vi.fn().mockResolvedValue({ canRewind: true })
      const resumeIter = createMockQueryIterator(
        [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-1'
          }
        ],
        { rewindFiles: resumeRewindFilesMock }
      )
      mockQuery.mockReturnValueOnce(resumeIter)

      // Verify query is null (prompt completed) but lastQuery exists
      expect(session.query).toBeNull()
      expect(session.lastQuery).not.toBeNull()

      // undo should succeed using a resumed query
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(mockQuery).toHaveBeenCalledTimes(2)
      expect(resumeRewindFilesMock).toHaveBeenCalled()
    })
  })

  // ── Conversation state verification after undo ───────────────────

  describe('conversation state after undo', () => {
    it('does not splice in-memory messages on undo', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
        userPrompts: ['prompt A', 'prompt B', 'prompt C']
      })

      // Before undo: should have the injected user message + all streamed messages
      const messageCountBefore = session.messages.length
      expect(messageCountBefore).toBeGreaterThan(3)

      // Undo the last turn (uuid-3)
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // After undo: messages should NOT be truncated — the in-memory
      // array stays intact.  The renderer uses revertMessageID to hide
      // the reverted tail in the UI.
      expect(session.messages.length).toBe(messageCountBefore)

      // uuid-3 should still be in the array (not spliced)
      expect(session.messages.find((m: any) => m.id === 'uuid-3')).toBeDefined()
    })

    it('undo preserves all messages and checkpoints (non-destructive)', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
        userPrompts: ['prompt A', 'prompt B', 'prompt C']
      })

      const countAfterPrompt = session.messages.length
      const checkpointsBefore = session.checkpoints.size

      // First undo: messages array stays intact
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(session.messages.length).toBe(countAfterPrompt)
      expect(session.checkpoints.size).toBe(checkpointsBefore)
      // All messages still present
      expect(session.messages.find((m: any) => m.id === 'uuid-3')).toBeDefined()
      expect(session.messages.find((m: any) => m.id === 'uuid-2')).toBeDefined()
      expect(session.messages.find((m: any) => m.id === 'uuid-1')).toBeDefined()

      // Second undo: still non-destructive
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(session.messages.length).toBe(countAfterPrompt)
      expect(session.messages.find((m: any) => m.id === 'uuid-2')).toBeDefined()
      expect(session.messages.find((m: any) => m.id === 'uuid-1')).toBeDefined()
    })

    it('getMessages returns full conversation after undo (non-destructive)', async () => {
      await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2'],
        userPrompts: ['prompt A', 'prompt B']
      })

      // Before undo: getMessages should include messages for both prompts
      const messagesBefore = await impl.getMessages('/proj', 'sdk-session-1')
      const userMsgsBefore = messagesBefore.filter((m: any) => m.role === 'user')
      expect(userMsgsBefore.length).toBeGreaterThanOrEqual(2)

      // Undo the last turn
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // After undo: getMessages still returns all messages (non-destructive).
      // The renderer's visibleMessages filter uses revertMessageID to hide
      // the reverted tail.
      const messagesAfter = await impl.getMessages('/proj', 'sdk-session-1')
      expect(messagesAfter.find((m: any) => m.id === 'uuid-2')).toBeDefined()
      expect(messagesAfter.length).toBe(messagesBefore.length)
    })

    it('undo sets pendingFork = true for next prompt', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2'],
        userPrompts: ['prompt A', 'prompt B']
      })

      // Before undo: no pending fork
      expect(session.pendingFork).toBe(false)

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // After undo: pendingFork is set, no JSONL writes
      expect(session.pendingFork).toBe(true)
      expect(mockWriteFile).not.toHaveBeenCalled()
    })

    it('prompt() passes forkSession: true when pendingFork is set', async () => {
      await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2'],
        userPrompts: ['prompt A', 'prompt B']
      })

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Send a new prompt — should pass forkSession: true
      const nextIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Next response' }] }
        }
      ])
      mockQuery.mockReturnValueOnce(nextIter)
      await impl.prompt('/proj', 'sdk-session-1', 'new prompt after undo')

      // The post-undo prompt should have forkSession: true
      const postUndoCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1][0]
      expect(postUndoCall.options.forkSession).toBe(true)
      expect(postUndoCall.options.resume).toBe('sdk-session-1')
    })

    it('prompt() clears pendingFork after query starts', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2'],
        userPrompts: ['prompt A', 'prompt B']
      })

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(session.pendingFork).toBe(true)

      // Send a new prompt — pendingFork should be cleared after
      const nextIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Next' }] }
        }
      ])
      mockQuery.mockReturnValueOnce(nextIter)
      await impl.prompt('/proj', 'sdk-session-1', 'new prompt')

      // After prompt, flag should be cleared (one-shot)
      expect(session.pendingFork).toBe(false)
    })

    it('prompt() clears session.messages when pendingFork is true', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2'],
        userPrompts: ['prompt A', 'prompt B']
      })

      // Confirm messages exist before undo
      expect(session.messages.length).toBeGreaterThan(0)

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Messages should still be intact after undo (non-destructive)
      expect(session.messages.length).toBeGreaterThan(0)

      // Send a new prompt — messages should be cleared for the fork
      const nextIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Next' }] }
        }
      ])
      mockQuery.mockReturnValueOnce(nextIter)
      await impl.prompt('/proj', 'sdk-session-1', 'forked prompt')

      // After prompt starts, the old messages are replaced with the new
      // prompt's messages (the fork starts fresh).  We can't easily check
      // mid-prompt, but we can verify the final state has only the new
      // messages (the injected user prompt + streamed assistant response).
      const userMsgs = session.messages.filter((m: any) => m.role === 'user')
      expect(userMsgs.length).toBe(1)
      expect((userMsgs[0] as any).content).toBe('forked prompt')
    })

    it('does not truncate JSONL on undo', async () => {
      await setupSessionWithCheckpoints({
        userUuids: ['uuid-1'],
        userPrompts: ['prompt A']
      })

      // Should not throw and should not write to any JSONL file
      await expect(impl.undo('/proj', 'sdk-session-1', 'hive-1')).resolves.toBeDefined()
      expect(mockWriteFile).not.toHaveBeenCalled()
    })

    it('captures new session ID after fork', async () => {
      await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2'],
        userPrompts: ['prompt A', 'prompt B']
      })

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Send a new prompt after undo — the SDK returns a NEW session ID (fork creates new branch)
      const forkedIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-forked',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Forked response' }] }
        }
      ])
      mockQuery.mockReturnValueOnce(forkedIter)
      await impl.prompt('/proj', 'sdk-session-1', 'forked prompt')

      // The old session key should be gone
      const oldKey = (impl as any).getSessionKey('/proj', 'sdk-session-1')
      expect(sessions.has(oldKey)).toBe(false)

      // The new session key should exist with the forked ID
      const newKey = (impl as any).getSessionKey('/proj', 'sdk-session-forked')
      const forkedSession = sessions.get(newKey)!
      expect(forkedSession).toBeDefined()
      expect(forkedSession.claudeSessionId).toBe('sdk-session-forked')
      expect(forkedSession.materialized).toBe(true)

      // Checkpoints should be reset for the new fork
      expect(forkedSession.checkpoints.size).toBe(0)
      expect(forkedSession.checkpointCounter).toBe(0)

      // Renderer should have been notified about the new session ID
      const sendMock = mockWindow.webContents.send as ReturnType<typeof vi.fn>
      const materializeCalls = sendMock.mock.calls.filter(
        (call: any[]) =>
          call[0] === 'opencode:stream' &&
          call[1]?.type === 'session.materialized' &&
          call[1]?.data?.newSessionId === 'sdk-session-forked'
      )
      expect(materializeCalls.length).toBeGreaterThanOrEqual(1)
    })

    it('undo preserves checkpoints for old branch', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
        userPrompts: ['prompt A', 'prompt B', 'prompt C']
      })

      // Before undo: should have 3 checkpoints
      expect(session.checkpoints.size).toBe(3)
      expect(session.checkpoints.has('uuid-1')).toBe(true)
      expect(session.checkpoints.has('uuid-2')).toBe(true)
      expect(session.checkpoints.has('uuid-3')).toBe(true)

      // First undo
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Checkpoints should all still be present (non-destructive)
      expect(session.checkpoints.size).toBe(3)
      expect(session.checkpoints.has('uuid-1')).toBe(true)
      expect(session.checkpoints.has('uuid-2')).toBe(true)
      expect(session.checkpoints.has('uuid-3')).toBe(true)

      // Second undo
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Still all 3 checkpoints preserved
      expect(session.checkpoints.size).toBe(3)
      expect(session.checkpoints.has('uuid-1')).toBe(true)
      expect(session.checkpoints.has('uuid-2')).toBe(true)
      expect(session.checkpoints.has('uuid-3')).toBe(true)
    })

    it('de-materialized session (undo first prompt) sets pendingFork = false', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-only'],
        userPrompts: ['only prompt']
      })

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Should de-materialize and NOT set pendingFork (nothing to fork from)
      expect(session.materialized).toBe(false)
      expect(session.pendingFork).toBe(false)

      // writeFile should NOT have been called
      expect(mockWriteFile).not.toHaveBeenCalled()
    })
  })

  describe('subagent message filtering (Bug #5)', () => {
    it('should NOT capture checkpoints from subagent user messages (parent_tool_use_id set)', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      // Simulate a stream with:
      //   1. Main user prompt (no parent_tool_use_id) → should be captured
      //   2. Subagent user message (has parent_tool_use_id) → should be SKIPPED
      //   3. Another main user prompt → should be captured
      const sdkMessages = [
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Init' }] }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'main-user-1',
          message: { role: 'user', content: [{ type: 'text', text: 'First prompt' }] }
          // No parent_tool_use_id → main thread
        },
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Agent' }]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'subagent-user-1',
          parent_tool_use_id: 'tool-1',
          message: { role: 'user', content: [{ type: 'text', text: 'Subagent query' }] }
        },
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          parent_tool_use_id: 'tool-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Subagent response' }] }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'main-user-2',
          message: { role: 'user', content: [{ type: 'text', text: 'Second prompt' }] }
          // No parent_tool_use_id → main thread
        },
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response 2' }] }
        },
        {
          type: 'result',
          session_id: 'sdk-session-1',
          result: 'Done',
          is_error: false,
          uuid: 'result-uuid'
        }
      ]

      const iter = createMockQueryIterator(sdkMessages)
      mockQuery.mockReturnValueOnce(iter)

      await impl.prompt('/proj', sessionId, 'test prompt')

      const session = sessions.get('/proj::sdk-session-1')!
      expect(session).toBeDefined()

      // Only main-thread user messages should be checkpoints
      expect(session.checkpoints.has('main-user-1')).toBe(true)
      expect(session.checkpoints.has('main-user-2')).toBe(true)
      // Subagent user message should NOT be a checkpoint
      expect(session.checkpoints.has('subagent-user-1')).toBe(false)
      expect(session.checkpoints.size).toBe(2)
    })

    it('undo after subagent uses correct main-thread UUID for resumeSessionAt', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      // Stream with main prompts and a subagent in between
      const rewindFilesMock = vi.fn()
      const sdkMessages = [
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Init' }] }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'main-1',
          message: { role: 'user', content: [{ type: 'text', text: 'Prompt 1' }] }
        },
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response 1' }] }
        },
        // Subagent messages interleaved — these should NOT affect checkpoints
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'subagent-x',
          parent_tool_use_id: 'tool-sub',
          message: { role: 'user', content: [{ type: 'text', text: 'Subagent work' }] }
        },
        {
          type: 'user',
          session_id: 'sdk-session-1',
          uuid: 'main-2',
          message: { role: 'user', content: [{ type: 'text', text: 'Prompt 2' }] }
        },
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response 2' }] }
        },
        {
          type: 'result',
          session_id: 'sdk-session-1',
          result: 'Done',
          is_error: false,
          uuid: 'result-uuid'
        }
      ]

      const iter = createMockQueryIterator(sdkMessages, { rewindFiles: rewindFilesMock })
      mockQuery.mockReturnValueOnce(iter)

      await impl.prompt('/proj', sessionId, 'test prompt')

      const session = sessions.get('/proj::sdk-session-1')!
      // Should have exactly 2 checkpoints (main-1 and main-2), NOT subagent-x
      expect(session.checkpoints.size).toBe(2)
      expect(session.checkpoints.has('subagent-x')).toBe(false)

      // Set up resumed query for rewindWithResumedQuery (undo after stream completes)
      const resumeRewindFiles = vi.fn()
      const resumeIter = createMockQueryIterator(
        [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-1'
          }
        ],
        { rewindFiles: resumeRewindFiles }
      )
      mockQuery.mockReturnValueOnce(resumeIter)

      // Undo the last turn (main-2)
      const result = await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      expect(result.revertMessageID).toBe('main-2')

      // pendingFork should be true (previous main-thread checkpoint exists)
      // The fork will branch from the correct point, NOT subagent-x
      expect(session.pendingFork).toBe(true)
    })
  })
})
