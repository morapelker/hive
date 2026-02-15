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
    getAvailableModels: vi.fn().mockResolvedValue([{ id: 'anthropic', models: {} }]),
    getModelInfo: vi.fn().mockResolvedValue({
      id: 'opus',
      name: 'Opus',
      limit: { context: 200000 }
    }),
    setSelectedModel: vi.fn()
  }
}))

import { registerOpenCodeHandlers } from '../../../src/main/ipc/opencode-handlers'
import { openCodeService } from '../../../src/main/services/opencode-service'
import type { AgentSdkManager } from '../../../src/main/services/agent-sdk-manager'
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
      supportsModelSelection: true,
      supportsReconnect: false,
      supportsPartialStreaming: false
    },
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    cleanup: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getAvailableModels: vi.fn().mockResolvedValue([{ id: 'claude-code', models: {} }]),
    getModelInfo: vi.fn().mockResolvedValue({
      id: 'opus',
      name: 'Claude Opus 4',
      limit: { context: 200000, output: 32000 }
    }),
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

const mockEvent = {} as any

describe('IPC opencode:models SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('opencode:models without agentSdk routes to OpenCode', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager)

    const handler = handlers.get('opencode:models')!
    expect(handler).toBeDefined()

    await handler(mockEvent, undefined)

    expect(openCodeService.getAvailableModels).toHaveBeenCalled()
    expect(claudeImpl.getAvailableModels).not.toHaveBeenCalled()
  })

  it('opencode:models with agentSdk claude-code routes to Claude', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager)

    const handler = handlers.get('opencode:models')!
    await handler(mockEvent, { agentSdk: 'claude-code' })

    expect(sdkManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.getAvailableModels).toHaveBeenCalled()
    expect(openCodeService.getAvailableModels).not.toHaveBeenCalled()
  })
})

describe('IPC opencode:setModel SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('opencode:setModel without agentSdk routes to OpenCode', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager)

    const handler = handlers.get('opencode:setModel')!
    expect(handler).toBeDefined()

    await handler(mockEvent, { providerID: 'anthropic', modelID: 'opus' })

    expect(openCodeService.setSelectedModel).toHaveBeenCalledWith({
      providerID: 'anthropic',
      modelID: 'opus'
    })
    expect(claudeImpl.setSelectedModel).not.toHaveBeenCalled()
  })

  it('opencode:setModel with agentSdk claude-code routes to Claude', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager)

    const handler = handlers.get('opencode:setModel')!
    await handler(mockEvent, {
      providerID: 'claude-code',
      modelID: 'opus',
      agentSdk: 'claude-code'
    })

    expect(sdkManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.setSelectedModel).toHaveBeenCalledWith({
      providerID: 'claude-code',
      modelID: 'opus',
      agentSdk: 'claude-code'
    })
    expect(openCodeService.setSelectedModel).not.toHaveBeenCalled()
  })
})

describe('IPC opencode:modelInfo SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('opencode:modelInfo without agentSdk routes to OpenCode', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager)

    const handler = handlers.get('opencode:modelInfo')!
    expect(handler).toBeDefined()

    await handler(mockEvent, { worktreePath: '/path', modelId: 'opus' })

    expect(openCodeService.getModelInfo).toHaveBeenCalledWith('/path', 'opus')
    expect(claudeImpl.getModelInfo).not.toHaveBeenCalled()
  })

  it('opencode:modelInfo with agentSdk claude-code routes to Claude', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager)

    const handler = handlers.get('opencode:modelInfo')!
    await handler(mockEvent, {
      worktreePath: '/path',
      modelId: 'opus',
      agentSdk: 'claude-code'
    })

    expect(sdkManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.getModelInfo).toHaveBeenCalledWith('/path', 'opus')
    expect(openCodeService.getModelInfo).not.toHaveBeenCalled()
  })
})

describe('IPC opencode:models fallback when sdkManager is null', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('opencode:models falls through to OpenCode when sdkManager is null', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, undefined, undefined)

    const handler = handlers.get('opencode:models')!
    await handler(mockEvent, { agentSdk: 'claude-code' })

    expect(claudeImpl.getAvailableModels).not.toHaveBeenCalled()
    expect(openCodeService.getAvailableModels).toHaveBeenCalled()
  })
})
