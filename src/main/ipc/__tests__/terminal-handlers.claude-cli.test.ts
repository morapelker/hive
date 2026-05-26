/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const exitCallbacks = new Map<string, (code: number | null) => void>()
  const dataCallbacks = new Map<string, (data: string) => void>()

  return {
    handlers,
    exitCallbacks,
    dataCallbacks,
    webContentsSend: vi.fn(),
    ipcMainOn: vi.fn(),
    getDatabase: vi.fn(),
    getClaudeHookServer: vi.fn(),
    buildClaudeCliHookSettings: vi.fn(),
    publishClaudeCliStatus: vi.fn(),
    ptyService: {
      has: vi.fn(() => false),
      create: vi.fn(() => ({ cols: 120, rows: 40 })),
      onData: vi.fn((terminalId: string, callback: (data: string) => void) => {
        dataCallbacks.set(terminalId, callback)
        return vi.fn(() => dataCallbacks.delete(terminalId))
      }),
      onExit: vi.fn((terminalId: string, callback: (code: number | null) => void) => {
        exitCallbacks.set(terminalId, callback)
        return vi.fn(() => exitCallbacks.delete(terminalId))
      }),
      write: vi.fn(),
      resize: vi.fn(),
      destroy: vi.fn(),
      destroyAll: vi.fn()
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      mocks.handlers.set(channel, handler)
    }),
    on: mocks.ipcMainOn
  },
  BrowserWindow: class {},
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LoggerService: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
}))

vi.mock('../../services/pty-service', () => ({
  ptyService: mocks.ptyService
}))

vi.mock('../../services/ghostty-service', () => ({
  ghosttyService: {
    setMainWindow: vi.fn(),
    init: vi.fn(),
    loadAddon: vi.fn(),
    isAvailable: vi.fn(() => false),
    isInitialized: vi.fn(() => false),
    createSurface: vi.fn(),
    setFrame: vi.fn(),
    setSize: vi.fn(),
    keyEvent: vi.fn(),
    mouseButton: vi.fn(),
    mousePos: vi.fn(),
    mouseScroll: vi.fn(),
    setFocus: vi.fn(),
    pasteText: vi.fn(),
    focusDiagnostics: vi.fn(),
    destroySurface: vi.fn(),
    shutdown: vi.fn()
  }
}))

vi.mock('../../services/ghostty-config', () => ({
  parseGhosttyConfig: vi.fn(() => ({}))
}))

vi.mock('../../db', () => ({
  getDatabase: mocks.getDatabase
}))

vi.mock('../../services/claude-binary-resolver', () => ({
  resolveClaudeBinaryPath: vi.fn(() => '/usr/local/bin/claude')
}))

vi.mock('../../services/claude-session-watcher', () => ({
  watchForClaudeSessionId: vi.fn(() => ({ close: vi.fn() }))
}))

vi.mock('../../services/claude-hook-server', () => ({
  getClaudeHookServer: mocks.getClaudeHookServer,
  buildClaudeCliHookSettings: mocks.buildClaudeCliHookSettings,
  publishClaudeCliStatus: mocks.publishClaudeCliStatus
}))

import type { Session } from '../../db/types'
import { registerTerminalHandlers, cleanupTerminals } from '../terminal-handlers'
import { __resetRuntimeRegistryForTests } from '../../effect/_shared/runtime'

const mockEvent = {} as any

function makeMainWindow(): any {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: mocks.webContentsSend
    }
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'hive-session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: 'claude-session-1',
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'sonnet',
    model_variant: 'high',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

function setupDb(session: Session = makeSession()): void {
  mocks.getDatabase.mockReturnValue({
    getSession: vi.fn(() => session),
    getWorktree: vi.fn(() => ({ path: '/repo/worktree' })),
    getConnection: vi.fn(() => ({ path: '/repo/connection' })),
    getSetting: vi.fn(() => null),
    updateSession: vi.fn()
  })
}

describe('terminal:createClaudeCli hook status wiring', () => {
  let mainWindow: any

  beforeEach(() => {
    mocks.handlers.clear()
    mocks.exitCallbacks.clear()
    mocks.dataCallbacks.clear()
    vi.clearAllMocks()
    __resetRuntimeRegistryForTests()

    mainWindow = makeMainWindow()
    setupDb()
    mocks.getClaudeHookServer.mockResolvedValue({ port: 45678 })
    mocks.buildClaudeCliHookSettings.mockReturnValue('{"hooks":{"mock":true}}')

    registerTerminalHandlers(mainWindow)
  })

  afterEach(() => {
    cleanupTerminals()
  })

  it('starts the hook server and passes inline settings into the Claude PTY argv before the prompt', async () => {
    const result = await mocks.handlers.get('terminal:createClaudeCli')!(
      mockEvent,
      'hive-session-1',
      { pendingPrompt: 'Implement the plan' }
    )

    expect(result).toEqual({
      success: true,
      value: { success: true, cols: 120, rows: 40 }
    })
    expect(mocks.getClaudeHookServer).toHaveBeenCalledWith(mainWindow)
    expect(mocks.buildClaudeCliHookSettings).toHaveBeenCalledWith(45678, 'hive-session-1')

    const [, options] = mocks.ptyService.create.mock.calls.at(-1)!
    expect(options).toMatchObject({
      cwd: '/repo/worktree',
      command: '/usr/local/bin/claude'
    })
    expect(options.args).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--resume',
      'claude-session-1',
      '--settings',
      '{"hooks":{"mock":true}}',
      'Implement the plan'
    ])
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
  })

  it('publishes completed with pty_exit metadata when a tracked Claude CLI PTY exits', async () => {
    await mocks.handlers.get('terminal:createClaudeCli')!(mockEvent, 'hive-session-1', {})

    mocks.exitCallbacks.get('hive-session-1')?.(9)

    expect(mocks.webContentsSend).toHaveBeenCalledWith('terminal:exit:hive-session-1', 9)
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledWith(mainWindow, {
      sessionId: 'hive-session-1',
      status: 'completed',
      metadata: { reason: 'pty_exit' }
    })
  })

  it('publishes an initial completed status after starting an idle Claude CLI PTY', async () => {
    await mocks.handlers.get('terminal:createClaudeCli')!(mockEvent, 'hive-session-1', {})

    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledWith(mainWindow, {
      sessionId: 'hive-session-1',
      status: 'completed',
      metadata: { reason: 'pty_start' }
    })
  })

  it('removes the Claude CLI PTY-exit safety net when the terminal is destroyed', async () => {
    await mocks.handlers.get('terminal:createClaudeCli')!(mockEvent, 'hive-session-1', {})
    const exitCallback = mocks.exitCallbacks.get('hive-session-1')
    mocks.publishClaudeCliStatus.mockClear()

    const destroyResult = await mocks.handlers.get('terminal:destroy')!(mockEvent, 'hive-session-1')
    expect(destroyResult).toEqual({ success: true, value: undefined })
    expect(mocks.ptyService.destroy).toHaveBeenCalledWith('hive-session-1')

    exitCallback?.(0)

    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
  })
})
