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

vi.mock('../../../src/main/services/claude-transcript-reader', () => ({
  readClaudeTranscript: vi.fn().mockResolvedValue([]),
  translateEntry: vi.fn().mockReturnValue(null)
}))

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'
import { loadClaudeSDK } from '../../../src/main/services/claude-sdk-loader'

function createMockSDK() {
  const queryFn = vi.fn().mockImplementation(() => ({
    [Symbol.asyncIterator]: () => ({
      next: vi.fn().mockResolvedValue({ done: true, value: undefined })
    }),
    interrupt: vi.fn(),
    close: vi.fn()
  }))
  return { query: queryFn }
}

function createMockWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as any
}

describe('ClaudeCodeImplementer prompt model selection', () => {
  let impl: ClaudeCodeImplementer
  let mockSDK: ReturnType<typeof createMockSDK>

  beforeEach(async () => {
    vi.resetAllMocks()
    mockSDK = createMockSDK()
    vi.mocked(loadClaudeSDK).mockResolvedValue(mockSDK as any)

    impl = new ClaudeCodeImplementer()
    impl.setMainWindow(createMockWindow())
  })

  it('prompt passes model in options when modelOverride provided', async () => {
    const { sessionId } = await impl.connect('/test/path', 'hive-session-1')

    await impl.prompt('/test/path', sessionId, 'hello', {
      providerID: 'claude-code',
      modelID: 'opus'
    })

    expect(mockSDK.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: 'opus' })
      })
    )
  })

  it('prompt uses selectedModel default when no override', async () => {
    const { sessionId } = await impl.connect('/test/path', 'hive-session-2')

    await impl.prompt('/test/path', sessionId, 'hello')

    expect(mockSDK.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: 'sonnet' })
      })
    )
  })

  it('prompt uses model set via setSelectedModel', async () => {
    impl.setSelectedModel({ providerID: 'claude-code', modelID: 'haiku' })

    const { sessionId } = await impl.connect('/test/path', 'hive-session-3')

    await impl.prompt('/test/path', sessionId, 'hello')

    expect(mockSDK.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: 'haiku' })
      })
    )
  })
})
