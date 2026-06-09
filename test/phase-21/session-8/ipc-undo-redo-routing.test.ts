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
    undo: vi.fn().mockResolvedValue({ revertMessageID: 'oc-revert-1', restoredPrompt: 'hi' }),
    redo: vi.fn().mockResolvedValue({ revertMessageID: null })
  }
}))

vi.mock('../../../src/main/services/claude-code-implementer', () => ({
  ClaudeCodeImplementer: vi.fn()
}))

vi.mock('../../../src/main/services/codex-implementer', () => ({
  CodexImplementer: vi.fn()
}))

import { redoOpenCodeSession, undoOpenCodeSession } from '../../../src/main/services/opencode-session-commands'
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

describe('OpenCode undo SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('routes to Claude implementer when dbService returns claude-code', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('claude-code')

    const result = await undoOpenCodeSession('/project', 'claude-session-1', sdkManager, dbService)

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

    const result = await undoOpenCodeSession('/project', 'oc-session-1', sdkManager, dbService)

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
    const result = await undoOpenCodeSession('/project', 'any-session')

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

    const result = await undoOpenCodeSession('/project', 'unknown-session', sdkManager, dbService)

    expect(claudeImpl.undo).not.toHaveBeenCalled()
    expect(openCodeService.undo).toHaveBeenCalledWith('/project', 'unknown-session')
    expect(result.success).toBe(true)
  })
})

describe('OpenCode redo SDK-aware routing', () => {
  let claudeImpl: AgentSdkImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('routes to Claude implementer which throws, caught as error response', async () => {
    const sdkManager = createMockSdkManager(claudeImpl)
    const dbService = createMockDbService('claude-code')

    const result = await redoOpenCodeSession('/project', 'claude-session-1', sdkManager, dbService)

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

    const result = await redoOpenCodeSession('/project', 'oc-session-1', sdkManager, dbService)

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('oc-session-1')
    expect(claudeImpl.redo).not.toHaveBeenCalled()
    expect(openCodeService.redo).toHaveBeenCalledWith('/project', 'oc-session-1')
    expect(result).toEqual({
      success: true,
      revertMessageID: null
    })
  })

  it('falls through to openCodeService when sdkManager is unavailable', async () => {
    const result = await redoOpenCodeSession('/project', 'any-session')

    expect(claudeImpl.redo).not.toHaveBeenCalled()
    expect(openCodeService.redo).toHaveBeenCalledWith('/project', 'any-session')
    expect(result).toEqual({
      success: true,
      revertMessageID: null
    })
  })
})
