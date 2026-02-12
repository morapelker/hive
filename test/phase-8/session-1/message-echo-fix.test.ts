import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockDb = {
  getSessionMessageByOpenCodeId: vi.fn(),
  upsertSessionMessageByOpenCodeId: vi.fn(),
  updateSession: vi.fn(),
  getWorktreeBySessionId: vi.fn(),
  updateWorktree: vi.fn(),
  getSession: vi.fn(),
  getProject: vi.fn()
}

const mockBranchExists = vi.fn().mockResolvedValue(false)
const mockRenameBranch = vi.fn().mockResolvedValue({ success: true })
const mockCanonicalizeBranchName = vi.fn().mockReturnValue('add-login-screen')

vi.mock('../../../src/main/db', () => ({
  getDatabase: () => mockDb
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/notification-service', () => ({
  notificationService: {
    showSessionComplete: vi.fn()
  }
}))

vi.mock('../../../src/main/services/git-service', () => ({
  canonicalizeBranchName: (...args: unknown[]) => mockCanonicalizeBranchName(...args),
  createGitService: () => ({
    branchExists: mockBranchExists,
    renameBranch: mockRenameBranch
  })
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let service: any

function createInstance() {
  return {
    client: {
      session: {
        get: vi.fn().mockResolvedValue({ data: {} })
      }
    },
    server: { url: 'http://localhost', close: vi.fn() },
    sessionMap: new Map<string, string>([['/repo/a::opc-session-1', 'hive-session-a']]),
    sessionDirectories: new Map<string, string>(),
    directorySubscriptions: new Map(),
    childToParentMap: new Map<string, string>()
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockDb.getSessionMessageByOpenCodeId.mockReturnValue(null)
  mockDb.getWorktreeBySessionId.mockReturnValue(null)

  const mod = await import('../../../src/main/services/opencode-service')
  service = mod.openCodeService
})

describe('Session 1: Message Echo Fix', () => {
  test('message.part.updated forwards to renderer without DB transcript persistence', async () => {
    const send = vi.fn()
    service.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send }
    })

    const instance = createInstance()

    await (
      service as never as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handleEvent: (instance: any, rawEvent: any, directory?: string) => Promise<void>
      }
    ).handleEvent(
      instance,
      {
        data: {
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'opc-session-1',
              id: 'part-1',
              type: 'text',
              text: 'hello'
            },
            message: { id: 'msg-1', role: 'assistant' },
            delta: 'hello'
          }
        }
      },
      '/repo/a'
    )

    expect(send).toHaveBeenCalledWith(
      'opencode:stream',
      expect.objectContaining({
        type: 'message.part.updated',
        sessionId: 'hive-session-a'
      })
    )
    expect(mockDb.getSessionMessageByOpenCodeId).not.toHaveBeenCalled()
    expect(mockDb.upsertSessionMessageByOpenCodeId).not.toHaveBeenCalled()
  })

  test('message.updated forwards to renderer without DB transcript persistence', async () => {
    const send = vi.fn()
    service.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send }
    })

    const instance = createInstance()

    await (
      service as never as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handleEvent: (instance: any, rawEvent: any, directory?: string) => Promise<void>
      }
    ).handleEvent(
      instance,
      {
        data: {
          type: 'message.updated',
          properties: {
            sessionID: 'opc-session-1',
            info: { messageID: 'msg-1' },
            message: { id: 'msg-1', role: 'assistant' },
            parts: [{ type: 'text', text: 'hello world' }]
          }
        }
      },
      '/repo/a'
    )

    expect(send).toHaveBeenCalledWith(
      'opencode:stream',
      expect.objectContaining({
        type: 'message.updated',
        sessionId: 'hive-session-a'
      })
    )
    expect(mockDb.getSessionMessageByOpenCodeId).not.toHaveBeenCalled()
    expect(mockDb.upsertSessionMessageByOpenCodeId).not.toHaveBeenCalled()
  })

  test('session.updated still persists title and worktree metadata updates', async () => {
    const send = vi.fn()
    service.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send }
    })

    mockDb.getWorktreeBySessionId.mockReturnValue({
      id: 'wt-1',
      path: '/repo/a',
      branch_name: 'paris',
      branch_renamed: 0
    })

    const instance = createInstance()

    await (
      service as never as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handleEvent: (instance: any, rawEvent: any, directory?: string) => Promise<void>
      }
    ).handleEvent(
      instance,
      {
        data: {
          type: 'session.updated',
          properties: {
            info: {
              id: 'opc-session-1',
              title: 'Add login screen'
            }
          }
        }
      },
      '/repo/a'
    )

    expect(mockDb.updateSession).toHaveBeenCalledWith('hive-session-a', {
      name: 'Add login screen'
    })
    expect(mockCanonicalizeBranchName).toHaveBeenCalledWith('Add login screen')
    expect(mockRenameBranch).toHaveBeenCalledWith('/repo/a', 'paris', 'add-login-screen')
    expect(mockDb.updateWorktree).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        name: 'add-login-screen',
        branch_name: 'add-login-screen',
        branch_renamed: 1
      })
    )
    expect(send).toHaveBeenCalledWith(
      'worktree:branchRenamed',
      expect.objectContaining({
        worktreeId: 'wt-1',
        newBranch: 'add-login-screen'
      })
    )
  })
})
