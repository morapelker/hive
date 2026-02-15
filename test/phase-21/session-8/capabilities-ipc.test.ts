/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES
} from '../../../src/main/services/agent-sdk-types'

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
    setMainWindow: vi.fn()
  }
}))

import { registerOpenCodeHandlers } from '../../../src/main/ipc/opencode-handlers'
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

const mockEvent = {} as any

describe('IPC opencode:capabilities', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('returns CLAUDE_CODE_CAPABILITIES for claude-code sessions', async () => {
    const sdkManager = createMockSdkManager()
    const dbService = createMockDbService('claude-code')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:capabilities')!
    expect(handler).toBeDefined()

    const result = await handler(mockEvent, { sessionId: 'claude-session-1' })

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
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:capabilities')!
    const result = await handler(mockEvent, { sessionId: 'oc-session-1' })

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
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:capabilities')!
    const result = await handler(mockEvent, { sessionId: 'unknown-session' })

    // sdkId is null, so it falls through to default
    expect(result).toEqual({
      success: true,
      capabilities: OPENCODE_CAPABILITIES
    })
  })

  it('returns default capabilities when no sessionId is provided', async () => {
    const sdkManager = createMockSdkManager()
    const dbService = createMockDbService(null)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, sdkManager, dbService)

    const handler = handlers.get('opencode:capabilities')!
    const result = await handler(mockEvent, {})

    expect(result).toEqual({
      success: true,
      capabilities: OPENCODE_CAPABILITIES
    })
  })

  it('returns null capabilities when sdkManager is unavailable', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerOpenCodeHandlers(mainWindow, undefined, undefined)

    const handler = handlers.get('opencode:capabilities')!
    const result = await handler(mockEvent, { sessionId: 'any-session' })

    expect(result).toEqual({
      success: true,
      capabilities: null
    })
  })
})
