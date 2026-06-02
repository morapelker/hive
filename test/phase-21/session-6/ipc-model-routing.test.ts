/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0'),
    isPackaged: false
  },
  BrowserWindow: vi.fn(),
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }))
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    logger: null,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
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
    getAvailableModels: vi.fn().mockResolvedValue([{ id: 'anthropic', models: {} }]),
    getModelInfo: vi.fn().mockResolvedValue({
      id: 'opus',
      name: 'Opus',
      limit: { context: 200000 }
    }),
    setSelectedModel: vi.fn()
  }
}))

vi.mock('../../../src/main/services/claude-code-implementer', () => ({
  ClaudeCodeImplementer: vi.fn()
}))

vi.mock('../../../src/main/services/codex-implementer', () => ({
  CodexImplementer: vi.fn()
}))

import {
  getOpenCodeModelInfo,
  listOpenCodeModels,
  setOpenCodeSelectedModel
} from '../../../src/main/services/opencode-session-commands'
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
      limit: { context: 1000000, output: 32000 }
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
    renameSession: vi.fn()
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

describe('OpenCode model SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('opencode:models without agentSdk routes to OpenCode', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)

    await listOpenCodeModels(undefined, sdkManager)

    expect(openCodeService.getAvailableModels).toHaveBeenCalled()
    expect(claudeImpl.getAvailableModels).not.toHaveBeenCalled()
  })

  it('opencode:models with agentSdk claude-code routes to Claude', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)

    await listOpenCodeModels({ agentSdk: 'claude-code' }, sdkManager)

    expect(sdkManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.getAvailableModels).toHaveBeenCalled()
    expect(openCodeService.getAvailableModels).not.toHaveBeenCalled()
  })
})

describe('OpenCode setModel SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('opencode:setModel without agentSdk routes to OpenCode', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)

    await setOpenCodeSelectedModel({ providerID: 'anthropic', modelID: 'opus' }, sdkManager)

    expect(openCodeService.setSelectedModel).toHaveBeenCalledWith({
      providerID: 'anthropic',
      modelID: 'opus'
    })
    expect(claudeImpl.setSelectedModel).not.toHaveBeenCalled()
  })

  it('opencode:setModel with agentSdk claude-code routes to Claude', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)

    await setOpenCodeSelectedModel(
      {
        providerID: 'claude-code',
        modelID: 'opus',
        agentSdk: 'claude-code'
      },
      sdkManager
    )

    expect(sdkManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.setSelectedModel).toHaveBeenCalledWith({
      providerID: 'claude-code',
      modelID: 'opus',
      agentSdk: 'claude-code'
    })
    expect(openCodeService.setSelectedModel).not.toHaveBeenCalled()
  })
})

describe('OpenCode modelInfo SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('opencode:modelInfo without agentSdk routes to OpenCode', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)

    await getOpenCodeModelInfo('/path', 'opus', undefined, sdkManager)

    expect(openCodeService.getModelInfo).toHaveBeenCalledWith('/path', 'opus')
    expect(claudeImpl.getModelInfo).not.toHaveBeenCalled()
  })

  it('opencode:modelInfo with agentSdk claude-code routes to Claude', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)

    await getOpenCodeModelInfo('/path', 'opus', 'claude-code', sdkManager)

    expect(sdkManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.getModelInfo).toHaveBeenCalledWith('/path', 'opus')
    expect(openCodeService.getModelInfo).not.toHaveBeenCalled()
  })
})

describe('OpenCode model fallback when sdkManager is null', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('opencode:models falls through to OpenCode when sdkManager is null', async () => {
    await listOpenCodeModels({ agentSdk: 'claude-code' })

    expect(claudeImpl.getAvailableModels).not.toHaveBeenCalled()
    expect(openCodeService.getAvailableModels).toHaveBeenCalled()
  })
})
