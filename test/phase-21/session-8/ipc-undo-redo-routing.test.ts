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
    undo: vi.fn().mockResolvedValue({ revertMessageID: 'oc-revert-1', restoredPrompt: 'hi' }),
    redo: vi.fn().mockResolvedValue({ revertMessageID: null })
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
      supportsUndo: true,
      supportsRedo: false,
      supportsCommands: true,
      supportsPermissionRequests: true,
      supportsQuestionPrompts: true,
      supportsModelSelection: true,
      supportsReconnect: true,
      supportsPartialStreaming: true
    },
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    cleanup: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getAvailableModels: vi.fn(),
    getModelInfo: vi.fn(),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn(),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    permissionReply: vi.fn(),
    permissionList: vi.fn(),
    undo: vi.fn().mockResolvedValue({
      revertMessageID: 'claude-revert-1',
      restoredPrompt: 'original prompt',
      revertDiff: '2 file(s) changed, +10 -5'
    }),
    redo: vi.fn().mockRejectedValue(new Error('Redo is not supported for Claude Code sessions')),
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

describe('IPC opencode:undo SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('routes to Claude implementer when dbService returns claude-code', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('claude-code')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:undo')!
    expect(handler).toBeDefined()

    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'claude-session-1'
    })

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('claude-session-1')
    expect(sdkManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.undo).toHaveBeenCalledWith('/project', 'claude-session-1', '')
    expect(openCodeService.undo).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: true,
      revertMessageID: 'claude-revert-1',
      restoredPrompt: 'original prompt',
      revertDiff: '2 file(s) changed, +10 -5'
    })
  })

  it('falls through to openCodeService when SDK is opencode', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('opencode')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:undo')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'oc-session-1'
    })

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('oc-session-1')
    expect(claudeImpl.undo).not.toHaveBeenCalled()
    expect(openCodeService.undo).toHaveBeenCalledWith('/project', 'oc-session-1')
    expect(result).toEqual({
      success: true,
      revertMessageID: 'oc-revert-1',
      restoredPrompt: 'hi'
    })
  })

  it('falls through to openCodeService when sdkManager is unavailable', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, undefined, undefined)

    const handler = handlers.get('opencode:undo')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'any-session'
    })

    expect(claudeImpl.undo).not.toHaveBeenCalled()
    expect(openCodeService.undo).toHaveBeenCalledWith('/project', 'any-session')
    expect(result).toEqual({
      success: true,
      revertMessageID: 'oc-revert-1',
      restoredPrompt: 'hi'
    })
  })

  it('falls through to openCodeService when dbService returns null SDK', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService(null)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:undo')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'unknown-session'
    })

    expect(claudeImpl.undo).not.toHaveBeenCalled()
    expect(openCodeService.undo).toHaveBeenCalledWith('/project', 'unknown-session')
    expect(result.success).toBe(true)
  })
})

describe('IPC opencode:redo SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('routes to Claude implementer which throws, caught as error response', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('claude-code')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:redo')!
    expect(handler).toBeDefined()

    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'claude-session-1'
    })

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('claude-session-1')
    expect(sdkManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.redo).toHaveBeenCalledWith('/project', 'claude-session-1', '')
    expect(openCodeService.redo).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: false,
      error: 'Redo is not supported for Claude Code sessions'
    })
  })

  it('falls through to openCodeService for opencode sessions', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('opencode')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:redo')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'oc-session-1'
    })

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('oc-session-1')
    expect(claudeImpl.redo).not.toHaveBeenCalled()
    expect(openCodeService.redo).toHaveBeenCalledWith('/project', 'oc-session-1')
    expect(result).toEqual({
      success: true,
      revertMessageID: null
    })
  })

  it('falls through to openCodeService when sdkManager is unavailable', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, undefined, undefined)

    const handler = handlers.get('opencode:redo')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'any-session'
    })

    expect(claudeImpl.redo).not.toHaveBeenCalled()
    expect(openCodeService.redo).toHaveBeenCalledWith('/project', 'any-session')
    expect(result).toEqual({
      success: true,
      revertMessageID: null
    })
  })
})
