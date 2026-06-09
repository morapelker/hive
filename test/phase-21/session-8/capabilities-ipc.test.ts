/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES
} from '../../../src/main/services/agent-sdk-types'

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
  }
}))

vi.mock('../../../src/main/services/claude-code-implementer', () => ({
  ClaudeCodeImplementer: vi.fn()
}))

vi.mock('../../../src/main/services/codex-implementer', () => ({
  CodexImplementer: vi.fn()
}))

import { getOpenCodeCapabilities } from '../../../src/main/services/opencode-session-commands'
import type { AgentSdkManager } from '../../../src/main/services/agent-sdk-manager'
import type { DatabaseService } from '../../../src/main/db/database'
import type { AgentSdkCapabilities } from '../../../src/main/services/agent-sdk-types'

function createMockSdkManager(): AgentSdkManager {
  return {
    getImplementer: vi.fn(),
    getCapabilities: vi.fn((sdkId: string): AgentSdkCapabilities => {
      if (sdkId === 'claude-code') return CLAUDE_CODE_CAPABILITIES
      return OPENCODE_CAPABILITIES
    }),
    cleanup: vi.fn()
  } as unknown as AgentSdkManager
}

function createMockDbService(sdkId: 'opencode' | 'claude-code' | null): DatabaseService {
  return {
    getAgentSdkForSession: vi.fn().mockReturnValue(sdkId)
  } as unknown as DatabaseService
}

describe('OpenCode capabilities routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns CLAUDE_CODE_CAPABILITIES for claude-code sessions', async () => {
    const sdkManager = createMockSdkManager()
    const dbService = createMockDbService('claude-code')

    const result = await getOpenCodeCapabilities('claude-session-1', sdkManager, dbService)

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('claude-session-1')
    expect(sdkManager.getCapabilities).toHaveBeenCalledWith('claude-code')
    expect(result).toEqual({
      success: true,
      capabilities: CLAUDE_CODE_CAPABILITIES
    })
    expect(result.capabilities.supportsRedo).toBe(false)
    expect(result.capabilities.supportsUndo).toBe(true)
  })

  it('returns OPENCODE_CAPABILITIES for opencode sessions', async () => {
    const sdkManager = createMockSdkManager()
    const dbService = createMockDbService('opencode')

    const result = await getOpenCodeCapabilities('oc-session-1', sdkManager, dbService)

    expect(dbService.getAgentSdkForSession).toHaveBeenCalledWith('oc-session-1')
    expect(sdkManager.getCapabilities).toHaveBeenCalledWith('opencode')
    expect(result).toEqual({
      success: true,
      capabilities: OPENCODE_CAPABILITIES
    })
    expect(result.capabilities.supportsRedo).toBe(true)
    expect(result.capabilities.supportsUndo).toBe(true)
  })

  it('returns default opencode capabilities when no session is found', async () => {
    const sdkManager = createMockSdkManager()
    const dbService = createMockDbService(null)

    const result = await getOpenCodeCapabilities('unknown-session', sdkManager, dbService)

    // sdkId is null, so it falls through to default
    expect(result).toEqual({
      success: true,
      capabilities: OPENCODE_CAPABILITIES
    })
  })

  it('returns default capabilities when no sessionId is provided', async () => {
    const sdkManager = createMockSdkManager()
    const dbService = createMockDbService(null)

    const result = await getOpenCodeCapabilities(undefined, sdkManager, dbService)

    expect(result).toEqual({
      success: true,
      capabilities: OPENCODE_CAPABILITIES
    })
  })

  it('returns null capabilities when sdkManager is unavailable', async () => {
    const result = await getOpenCodeCapabilities('any-session')

    expect(result).toEqual({
      success: true,
      capabilities: null
    })
  })
})
