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

      // The post-undo prompt should use resumeSessionAt=uuid-A (previous checkpoint)
      const postUndoCall = mockQuery.mock.calls[3][0]
      expect(postUndoCall.options.resumeSessionAt).toBe('uuid-A')
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

      // Session should be de-materialized
      const key = (impl as any).getSessionKey('/proj', 'sdk-session-1')
      const session = (impl as any).sessions.get(key)
      expect(session.materialized).toBe(false)
      expect(session.resumeSessionAt).toBeNull()

      await impl.prompt('/proj', 'sdk-session-1', 'fresh prompt')

      // No resume, no resumeSessionAt — it's a brand new session
      const freshCall = mockQuery.mock.calls[2][0]
      expect(freshCall.options.resume).toBeUndefined()
      expect(freshCall.options.resumeSessionAt).toBeUndefined()
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
    it('truncates in-memory messages at the revert boundary', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
        userPrompts: ['prompt A', 'prompt B', 'prompt C']
      })

      // Before undo: should have the injected user message + all streamed messages
      // (1 injected user + 1 assistant materialization + 3 user/assistant pairs = multiple)
      const messageCountBefore = session.messages.length
      expect(messageCountBefore).toBeGreaterThan(3)

      // Undo the last turn (uuid-3)
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // After undo: messages at and after uuid-3 should be removed
      const messagesAfter = session.messages.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content
      }))

      // uuid-3 should NOT be in the remaining messages
      expect(messagesAfter.find((m: any) => m.id === 'uuid-3')).toBeUndefined()

      // Messages should be fewer
      expect(session.messages.length).toBeLessThan(messageCountBefore)

      // All remaining messages should have valid content (no empty text blocks)
      for (const msg of session.messages) {
        const m = msg as any
        if (m.parts && Array.isArray(m.parts)) {
          for (const part of m.parts) {
            if (part.type === 'text') {
              // Text parts should not have empty text (this causes the cache_control bug)
              expect(part.text).toBeDefined()
            }
          }
        }
      }
    })

    it('progressive undo removes messages incrementally', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2', 'uuid-3'],
        userPrompts: ['prompt A', 'prompt B', 'prompt C']
      })

      const countAfterPrompt = session.messages.length

      // First undo: removes uuid-3 and its response
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      const countAfterUndo1 = session.messages.length
      expect(countAfterUndo1).toBeLessThan(countAfterPrompt)
      expect(session.messages.find((m: any) => m.id === 'uuid-3')).toBeUndefined()
      // uuid-2 and uuid-1 should still be present
      expect(session.messages.find((m: any) => m.id === 'uuid-2')).toBeDefined()
      expect(session.messages.find((m: any) => m.id === 'uuid-1')).toBeDefined()

      // Second undo: removes uuid-2 and its response
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      const countAfterUndo2 = session.messages.length
      expect(countAfterUndo2).toBeLessThan(countAfterUndo1)
      expect(session.messages.find((m: any) => m.id === 'uuid-2')).toBeUndefined()
      expect(session.messages.find((m: any) => m.id === 'uuid-1')).toBeDefined()

      // Third undo: removes uuid-1
      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      const countAfterUndo3 = session.messages.length
      expect(countAfterUndo3).toBeLessThan(countAfterUndo2)
      expect(session.messages.find((m: any) => m.id === 'uuid-1')).toBeUndefined()
    })

    it('getMessages returns only the rewound conversation after undo', async () => {
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

      // After undo: getMessages should NOT include uuid-2 or its response
      const messagesAfter = await impl.getMessages('/proj', 'sdk-session-1')
      expect(messagesAfter.find((m: any) => m.id === 'uuid-2')).toBeUndefined()
    })

    it('undo sets pendingJsonlTruncateUuid instead of truncating immediately', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2'],
        userPrompts: ['prompt A', 'prompt B']
      })

      // Before undo: no pending truncation
      expect(session.pendingJsonlTruncateUuid).toBeNull()

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // After undo: truncation is deferred — flag is set, writeFile NOT called
      expect(session.pendingJsonlTruncateUuid).toBe('uuid-2')
      expect(mockWriteFile).not.toHaveBeenCalled()
    })

    it('deferred truncation runs at next prompt and cleans JSONL', async () => {
      const jsonlEntries = [
        {
          type: 'user',
          uuid: 'uuid-1',
          message: { role: 'user', content: [{ type: 'text', text: 'prompt A' }] }
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response A' }] }
        },
        {
          type: 'user',
          uuid: 'uuid-2',
          message: { role: 'user', content: [{ type: 'text', text: 'prompt B' }] }
        },
        {
          type: 'assistant',
          uuid: 'asst-2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response B' }] }
        }
      ]
      const jsonlContent = jsonlEntries.map((e) => JSON.stringify(e)).join('\n') + '\n'

      mockReadFile.mockResolvedValue(jsonlContent)
      mockWriteFile.mockResolvedValue(undefined)

      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2'],
        userPrompts: ['prompt A', 'prompt B']
      })

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Flag is set, no write yet
      expect(session.pendingJsonlTruncateUuid).toBe('uuid-2')
      expect(mockWriteFile).not.toHaveBeenCalled()

      // Now send a new prompt — this triggers the deferred truncation
      const nextIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Next response' }] }
        }
      ])
      mockQuery.mockReturnValueOnce(nextIter)

      await impl.prompt('/proj', 'sdk-session-1', 'new prompt after undo')

      // writeFile should have been called by the deferred truncation
      expect(mockWriteFile).toHaveBeenCalled()
      const writtenContent = mockWriteFile.mock.calls[0][1] as string
      const writtenEntries = writtenContent
        .split('\n')
        .filter((l: string) => l.trim())
        .map((l: string) => JSON.parse(l))

      // uuid-2 and its response should be gone
      expect(writtenEntries.find((e: any) => e.uuid === 'uuid-2')).toBeUndefined()
      expect(writtenEntries.find((e: any) => e.uuid === 'asst-2')).toBeUndefined()

      // uuid-1 and its response should still be present
      expect(writtenEntries.find((e: any) => e.uuid === 'uuid-1')).toBeDefined()
      expect(writtenEntries.find((e: any) => e.uuid === 'asst-1')).toBeDefined()

      // Flag should be cleared after prompt
      expect(session.pendingJsonlTruncateUuid).toBeNull()
    })

    it('deferred truncation removes empty text blocks from JSONL', async () => {
      // Simulate a dirty JSONL with junk from rewindWithResumedQuery
      const jsonlEntries = [
        {
          type: 'user',
          uuid: 'uuid-1',
          message: { role: 'user', content: [{ type: 'text', text: 'prompt A' }] }
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response A' }] }
        },
        // Junk from rewindWithResumedQuery
        {
          type: 'user',
          uuid: 'uuid-junk',
          message: { role: 'user', content: [{ type: 'text', text: '' }] }
        },
        {
          type: 'user',
          uuid: 'uuid-2',
          message: { role: 'user', content: [{ type: 'text', text: 'prompt B' }] }
        },
        {
          type: 'assistant',
          uuid: 'asst-2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response B' }] }
        }
      ]
      const jsonlContent = jsonlEntries.map((e) => JSON.stringify(e)).join('\n') + '\n'

      mockReadFile.mockResolvedValue(jsonlContent)
      mockWriteFile.mockResolvedValue(undefined)

      await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2'],
        userPrompts: ['prompt A', 'prompt B']
      })

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Trigger deferred truncation via a new prompt
      const nextIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Next' }] }
        }
      ])
      mockQuery.mockReturnValueOnce(nextIter)
      await impl.prompt('/proj', 'sdk-session-1', 'new prompt')

      expect(mockWriteFile).toHaveBeenCalled()
      const writtenContent = mockWriteFile.mock.calls[0][1] as string
      const writtenEntries = writtenContent
        .split('\n')
        .filter((l: string) => l.trim())
        .map((l: string) => JSON.parse(l))

      // No empty text blocks should remain
      expect(writtenEntries.find((e: any) => e.uuid === 'uuid-junk')).toBeUndefined()
      // uuid-2 should also be gone (it's the undone turn)
      expect(writtenEntries.find((e: any) => e.uuid === 'uuid-2')).toBeUndefined()
      // uuid-1 should remain
      expect(writtenEntries.find((e: any) => e.uuid === 'uuid-1')).toBeDefined()
    })

    it('JSONL truncation does not break when file is missing', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'))

      await setupSessionWithCheckpoints({
        userUuids: ['uuid-1'],
        userPrompts: ['prompt A']
      })

      // Should not throw even if the JSONL file doesn't exist
      await expect(impl.undo('/proj', 'sdk-session-1', 'hive-1')).resolves.toBeDefined()
    })

    it('deferred truncation preserves non-message entries (queue-operation, file-history-snapshot)', async () => {
      const jsonlEntries = [
        { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-01-01T00:00:00Z' },
        { type: 'file-history-snapshot', timestamp: '2026-01-01T00:00:01Z' },
        {
          type: 'user',
          uuid: 'uuid-1',
          message: { role: 'user', content: [{ type: 'text', text: 'prompt A' }] }
        },
        {
          type: 'assistant',
          uuid: 'asst-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response A' }] }
        },
        {
          type: 'user',
          uuid: 'uuid-2',
          message: { role: 'user', content: [{ type: 'text', text: 'prompt B' }] }
        },
        {
          type: 'assistant',
          uuid: 'asst-2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response B' }] }
        }
      ]
      const jsonlContent = jsonlEntries.map((e) => JSON.stringify(e)).join('\n') + '\n'

      mockReadFile.mockResolvedValue(jsonlContent)
      mockWriteFile.mockResolvedValue(undefined)

      await setupSessionWithCheckpoints({
        userUuids: ['uuid-1', 'uuid-2'],
        userPrompts: ['prompt A', 'prompt B']
      })

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Trigger deferred truncation via a new prompt
      const nextIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Next' }] }
        }
      ])
      mockQuery.mockReturnValueOnce(nextIter)
      await impl.prompt('/proj', 'sdk-session-1', 'new prompt')

      expect(mockWriteFile).toHaveBeenCalled()
      const writtenContent = mockWriteFile.mock.calls[0][1] as string
      const writtenEntries = writtenContent
        .split('\n')
        .filter((l: string) => l.trim())
        .map((l: string) => JSON.parse(l))

      // Non-message entries before the undo point should be preserved
      expect(writtenEntries.find((e: any) => e.type === 'queue-operation')).toBeDefined()
      expect(writtenEntries.find((e: any) => e.type === 'file-history-snapshot')).toBeDefined()

      // uuid-1 should still be there (only uuid-2 was undone)
      expect(writtenEntries.find((e: any) => e.uuid === 'uuid-1')).toBeDefined()
    })

    it('de-materialized session (undo first prompt) sets pending truncation', async () => {
      const { session } = await setupSessionWithCheckpoints({
        userUuids: ['uuid-only'],
        userPrompts: ['only prompt']
      })

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')

      // Should de-materialize and set pending truncation
      expect(session.materialized).toBe(false)
      expect(session.pendingJsonlTruncateUuid).toBe('uuid-only')

      // writeFile should NOT have been called during undo (deferred)
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

      // resumeSessionAt should be main-1 (previous main-thread checkpoint)
      // NOT subagent-x
      expect(session.resumeSessionAt).toBe('main-1')
    })
  })
})
