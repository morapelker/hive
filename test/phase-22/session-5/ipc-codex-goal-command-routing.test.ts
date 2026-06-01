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
    listCommands: vi.fn().mockResolvedValue([]),
    sendCommand: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('../../../src/main/services/claude-code-implementer', () => ({
  ClaudeCodeImplementer: vi.fn()
}))

vi.mock('../../../src/main/services/codex-implementer', () => ({
  CodexImplementer: vi.fn()
}))

import { listOpenCodeCommands, sendOpenCodeCommand } from '../../../src/main/services/opencode-session-commands'
import { openCodeService } from '../../../src/main/services/opencode-service'
import type { AgentSdkManager } from '../../../src/main/services/agent-sdk-manager'
import type { DatabaseService } from '../../../src/main/db/database'

describe('Codex goal command routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists Codex commands when the renderer passes the Hive session id', async () => {
    const codexImpl = {
      listCommands: vi.fn().mockResolvedValue([{ name: 'goal', template: '/goal ' }])
    }
    const sdkManager = {
      getImplementer: vi.fn().mockReturnValue(codexImpl)
    } as unknown as AgentSdkManager
    const dbService = {
      getAgentSdkForSession: vi.fn().mockReturnValue(null),
      getSession: vi.fn().mockReturnValue({ agent_sdk: 'codex', opencode_session_id: null })
    } as unknown as DatabaseService

    const result = await listOpenCodeCommands('/project', 'hive-1', sdkManager, dbService)

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('hive-1')
    expect(dbService.getSession).toHaveBeenCalledWith('hive-1')
    expect(sdkManager.getImplementer).toHaveBeenCalledWith('codex')
    expect(codexImpl.listCommands).toHaveBeenCalledWith('/project')
    expect(openCodeService.listCommands).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: true,
      commands: [{ name: 'goal', template: '/goal ' }]
    })
  })

  it('routes Codex commands to the provider thread id when the renderer passes the Hive session id', async () => {
    const codexImpl = {
      sendCommand: vi.fn().mockResolvedValue(undefined)
    }
    const sdkManager = {
      getImplementer: vi.fn().mockReturnValue(codexImpl)
    } as unknown as AgentSdkManager
    const dbService = {
      getAgentSdkForSession: vi.fn().mockReturnValue(null),
      getSession: vi.fn().mockReturnValue({ agent_sdk: 'codex', opencode_session_id: 'thread-1' })
    } as unknown as DatabaseService

    const result = await sendOpenCodeCommand(
      '/project',
      'hive-1',
      'goal',
      'ship the feature',
      undefined,
      sdkManager,
      dbService
    )

    expect(codexImpl.sendCommand).toHaveBeenCalledWith(
      '/project',
      'thread-1',
      'goal',
      'ship the feature'
    )
    expect(openCodeService.sendCommand).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true })
  })
})
