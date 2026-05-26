/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, async (...args: any[]) => {
        const result = await handler(...args)
        return result?.success === true && 'value' in result ? result.value : result
      })
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
    listCommands: vi.fn().mockResolvedValue([]),
    sendCommand: vi.fn().mockResolvedValue(undefined)
  }
}))

import { registerOpenCodeHandlers } from '../../../src/main/ipc/opencode-handlers'
import { openCodeService } from '../../../src/main/services/opencode-service'
import type { AgentSdkManager } from '../../../src/main/services/agent-sdk-manager'
import type { DatabaseService } from '../../../src/main/db/database'

const mockEvent = {} as any

describe('IPC Codex goal command routing', () => {
  beforeEach(() => {
    handlers.clear()
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

    registerOpenCodeHandlers({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any, sdkManager, dbService)

    const handler = handlers.get('opencode:commands')!
    const result = await handler(mockEvent, { worktreePath: '/project', sessionId: 'hive-1' })

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
      getSession: vi
        .fn()
        .mockReturnValue({ agent_sdk: 'codex', opencode_session_id: 'thread-1' })
    } as unknown as DatabaseService

    registerOpenCodeHandlers({ isDestroyed: () => false, webContents: { send: vi.fn() } } as any, sdkManager, dbService)

    const handler = handlers.get('opencode:command')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'hive-1',
      command: 'goal',
      args: 'ship the feature'
    })

    expect(codexImpl.sendCommand).toHaveBeenCalledWith('/project', 'thread-1', 'goal', 'ship the feature')
    expect(openCodeService.sendCommand).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true })
  })
})
