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
    prompt: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('../../../src/main/services/claude-code-implementer', () => ({
  ClaudeCodeImplementer: vi.fn()
}))

vi.mock('../../../src/main/services/codex-implementer', () => ({
  CodexImplementer: vi.fn()
}))

import { promptOpenCodeSession } from '../../../src/main/services/opencode-session-commands'
import { openCodeService } from '../../../src/main/services/opencode-service'
import type { AgentSdkManager } from '../../../src/main/services/agent-sdk-manager'
import type { AgentSdkImplementer } from '../../../src/main/services/agent-sdk-types'

function createMockCodexImpl(): AgentSdkImplementer {
  return {
    id: 'codex',
    capabilities: {
      supportsUndo: true,
      supportsRedo: false,
      supportsCommands: false,
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
    getAvailableModels: vi.fn().mockResolvedValue([]),
    getModelInfo: vi.fn().mockResolvedValue(null),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn().mockResolvedValue({ revertMessageID: null, revertDiff: null }),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    permissionReply: vi.fn(),
    permissionList: vi.fn().mockResolvedValue([]),
    undo: vi.fn(),
    redo: vi.fn(),
    listCommands: vi.fn().mockResolvedValue([]),
    sendCommand: vi.fn(),
    renameSession: vi.fn()
  }
}

function createMockSdkManager(codexImpl: AgentSdkImplementer): AgentSdkManager {
  return {
    getImplementer: vi.fn((id: string) => {
      if (id === 'codex') return codexImpl
      throw new Error(`Unknown agent SDK: ${id}`)
    }),
    getCapabilities: vi.fn(),
    cleanup: vi.fn()
  } as unknown as AgentSdkManager
}

describe('OpenCode prompt options routing', () => {
  let codexImpl: AgentSdkImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    codexImpl = createMockCodexImpl()
  })

  it('passes codexFastMode options to SDK implementers', async () => {
    const sdkManager = createMockSdkManager(codexImpl)
    const dbService = {
      getAgentSdkForSession: vi.fn().mockReturnValue('codex')
    } as any
    const result = await promptOpenCodeSession(
      '/project',
      'session-1',
      [{ type: 'text', text: 'hello' }],
      { providerID: 'codex', modelID: 'gpt-5.3-codex', variant: undefined },
      { codexFastMode: true },
      sdkManager,
      dbService
    )

    expect(result).toEqual({ success: true })
    expect(codexImpl.prompt).toHaveBeenCalledWith(
      '/project',
      'session-1',
      [{ type: 'text', text: 'hello' }],
      { providerID: 'codex', modelID: 'gpt-5.3-codex', variant: undefined },
      { codexFastMode: true }
    )
    expect(openCodeService.prompt).not.toHaveBeenCalled()
  })
})
