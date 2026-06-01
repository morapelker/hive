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
    getMessages: vi.fn().mockResolvedValue([{ id: 'oc-msg-1', role: 'user' }]),
    getSessionInfo: vi.fn().mockResolvedValue({ canUndo: true, canRedo: false })
  }
}))

vi.mock('../../../src/main/services/claude-code-implementer', () => ({
  ClaudeCodeImplementer: vi.fn()
}))

vi.mock('../../../src/main/services/codex-implementer', () => ({
  CodexImplementer: vi.fn()
}))

import {
  getOpenCodeSessionInfo,
  getOpenCodeSessionMessages
} from '../../../src/main/services/opencode-session-commands'
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

function createMockDbService(sdkId: 'opencode' | 'claude-code' | null): DatabaseService {
  return {
    getAgentSdkForSession: vi.fn().mockReturnValue(sdkId)
  } as unknown as DatabaseService
}

describe('OpenCode message SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('routes to Claude implementer for claude-code sessions', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('claude-code')

    const result = await getOpenCodeSessionMessages(
      '/project',
      'claude-session-1',
      sdkManager,
      dbService
    )

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

    const result = await getOpenCodeSessionMessages(
      '/project',
      'oc-session-1',
      sdkManager,
      dbService
    )

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('oc-session-1')
    expect(claudeImpl.getMessages).not.toHaveBeenCalled()
    expect(openCodeService.getMessages).toHaveBeenCalledWith('/project', 'oc-session-1')
    expect(result).toEqual({
      success: true,
      messages: [{ id: 'oc-msg-1', role: 'user' }]
    })
  })

  it('falls through to OpenCode when sdkManager is null', async () => {
    const result = await getOpenCodeSessionMessages('/project', 'any-session')

    expect(claudeImpl.getMessages).not.toHaveBeenCalled()
    expect(openCodeService.getMessages).toHaveBeenCalledWith('/project', 'any-session')
    expect(result).toEqual({
      success: true,
      messages: [{ id: 'oc-msg-1', role: 'user' }]
    })
  })
})

describe('OpenCode sessionInfo SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('routes to Claude implementer for claude-code sessions', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('claude-code')

    const result = await getOpenCodeSessionInfo(
      '/project',
      'claude-session-1',
      sdkManager,
      dbService
    )

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

    const result = await getOpenCodeSessionInfo('/project', 'oc-session-1', sdkManager, dbService)

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
