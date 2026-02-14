/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture registered IPC handlers
const handlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    })
  },
  app: {
    getPath: vi.fn(() => '/tmp')
  }
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/opencode-service', () => ({
  openCodeService: {
    setMainWindow: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([{ id: 'oc-msg-1', role: 'user' }]),
    getSessionInfo: vi.fn().mockResolvedValue({ canUndo: true, canRedo: false })
  }
}))

import { registerOpenCodeHandlers } from '../../../src/main/ipc/opencode-handlers'
import { openCodeService } from '../../../src/main/services/opencode-service'
import type { AgentSdkManager } from '../../../src/main/services/agent-sdk-manager'
import type { DatabaseService } from '../../../src/main/db/database'
import type { AgentSdkImplementer } from '../../../src/main/services/agent-sdk-types'

function createMockClaudeImpl(): AgentSdkImplementer {
  return {
    id: 'claude-code' as const,
    capabilities: {
      supportsUndo: false,
      supportsRedo: false,
      supportsCommands: false,
      supportsPermissionRequests: false,
      supportsQuestionPrompts: false,
      supportsModelSelection: false,
      supportsReconnect: false,
      supportsPartialStreaming: false
    },
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    cleanup: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([{ id: 'claude-msg-1', role: 'assistant' }]),
    getAvailableModels: vi.fn(),
    getModelInfo: vi.fn(),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn().mockResolvedValue({ canUndo: false, canRedo: false }),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    permissionReply: vi.fn(),
    permissionList: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    listCommands: vi.fn(),
    sendCommand: vi.fn(),
    renameSession: vi.fn(),
    setMainWindow: vi.fn()
  }
}

function createMockSdkManager(claudeImpl: AgentSdkImplementer): AgentSdkManager {
  return {
    getImplementer: vi.fn((id: string) => {
      if (id === 'claude-code') return claudeImpl
      throw new Error(`Unknown agent SDK: ${id}`)
    }),
    getCapabilities: vi.fn(),
    cleanup: vi.fn()
  } as unknown as AgentSdkManager
}

function createMockDbService(sdkId: 'opencode' | 'claude-code' | null): DatabaseService {
  return {
    getAgentSdkForSession: vi.fn().mockReturnValue(sdkId)
  } as unknown as DatabaseService
}

const mockEvent = {} as any

describe('IPC opencode:messages SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('routes to Claude implementer for claude-code sessions', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('claude-code')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:messages')!
    expect(handler).toBeDefined()

    const result = await handler(mockEvent, '/project', 'claude-session-1')

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('claude-session-1')
    expect(sdkManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.getMessages).toHaveBeenCalledWith('/project', 'claude-session-1')
    expect(openCodeService.getMessages).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: true,
      messages: [{ id: 'claude-msg-1', role: 'assistant' }]
    })
  })

  it('falls through to OpenCode for opencode sessions', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('opencode')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:messages')!
    const result = await handler(mockEvent, '/project', 'oc-session-1')

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('oc-session-1')
    expect(claudeImpl.getMessages).not.toHaveBeenCalled()
    expect(openCodeService.getMessages).toHaveBeenCalledWith('/project', 'oc-session-1')
    expect(result).toEqual({
      success: true,
      messages: [{ id: 'oc-msg-1', role: 'user' }]
    })
  })

  it('falls through to OpenCode when sdkManager is null', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, undefined, undefined)

    const handler = handlers.get('opencode:messages')!
    const result = await handler(mockEvent, '/project', 'any-session')

    expect(claudeImpl.getMessages).not.toHaveBeenCalled()
    expect(openCodeService.getMessages).toHaveBeenCalledWith('/project', 'any-session')
    expect(result).toEqual({
      success: true,
      messages: [{ id: 'oc-msg-1', role: 'user' }]
    })
  })
})

describe('IPC opencode:sessionInfo SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('routes to Claude implementer for claude-code sessions', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('claude-code')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:sessionInfo')!
    expect(handler).toBeDefined()

    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'claude-session-1'
    })

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('claude-session-1')
    expect(sdkManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.getSessionInfo).toHaveBeenCalledWith('/project', 'claude-session-1')
    expect(openCodeService.getSessionInfo).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: true,
      canUndo: false,
      canRedo: false
    })
  })

  it('falls through to OpenCode for opencode sessions', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('opencode')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:sessionInfo')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'oc-session-1'
    })

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('oc-session-1')
    expect(claudeImpl.getSessionInfo).not.toHaveBeenCalled()
    expect(openCodeService.getSessionInfo).toHaveBeenCalledWith('/project', 'oc-session-1')
    expect(result).toEqual({
      success: true,
      canUndo: true,
      canRedo: false
    })
  })
})
