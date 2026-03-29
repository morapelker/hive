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

const mockStartSession = vi.fn()
const mockSendTurn = vi.fn()
const mockReadThread = vi.fn()
const mockStopSession = vi.fn()
const mockStopAll = vi.fn()
const mockOn = vi.fn()
const mockRemoveListener = vi.fn()
const mockRemoveAllListeners = vi.fn()

vi.mock('../../../src/main/services/codex-app-server-manager', () => ({
  CodexAppServerManager: vi.fn().mockImplementation(() => ({
    startSession: mockStartSession,
    sendTurn: mockSendTurn,
    readThread: mockReadThread,
    stopSession: mockStopSession,
    stopAll: mockStopAll,
    on: mockOn,
    removeListener: mockRemoveListener,
    removeAllListeners: mockRemoveAllListeners
  }))
}))

describe('generateCodexSessionTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockStartSession.mockResolvedValue({
      provider: 'codex',
      status: 'ready',
      threadId: 'thread-title-1',
      cwd: '/test',
      model: 'gpt-5.4',
      activeTurnId: null,
      resumeCursor: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })

    mockOn.mockImplementation((_event: string, handler: any) => {
      setTimeout(() => {
        handler({
          id: 'evt-1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-title-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        })
      }, 0)
    })

    mockSendTurn.mockResolvedValue({ turnId: 'turn-title-1', threadId: 'thread-title-1' })
    mockReadThread.mockResolvedValue({
      thread: {
        turns: [
          {
            id: 'turn-title-1',
            outputText: '<think>hidden</think>\nAuth refresh fix'
          }
        ]
      }
    })
  })

  it('uses gpt-5.4 with low effort and opencode-style prompt shape', async () => {
    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    const title = await generateCodexSessionTitle('Fix auth refresh token bug', '/test')

    expect(title).toBe('Auth refresh fix')
    expect(mockSendTurn).toHaveBeenCalledWith('thread-title-1', {
      model: 'gpt-5.4',
      reasoningEffort: 'low',
      developerInstructions: expect.stringContaining('You are a title generator'),
      input: [
        { type: 'text', text: 'Generate a title for this conversation:\n' },
        { type: 'text', text: 'Fix auth refresh token bug' }
      ]
    })
    expect(mockStopSession).toHaveBeenCalledWith('thread-title-1')
  })

  it('post-processes think tags and truncates long titles', async () => {
    const { __testing__ } = await import('../../../src/main/services/codex-session-title')

    const longTitle =
      '<think>internal</think>\n' +
      'A'.repeat(105)

    expect(__testing__.postProcessTitle(longTitle)).toBe(`${'A'.repeat(97)}...`)
  })
})
