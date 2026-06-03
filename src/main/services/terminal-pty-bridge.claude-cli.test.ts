/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const exitCallbacks = new Map<string, (code: number | null) => void>()
  const dataCallbacks = new Map<string, (data: string) => void>()
  const claudeSessionWatchCallbacks = new Map<string, (claudeSessionId: string) => void>()

  return {
    handlers,
    exitCallbacks,
    dataCallbacks,
    claudeSessionWatchCallbacks,
    publishDesktopBackendEvent: vi.fn(),
    getDatabase: vi.fn(),
    getClaudeHookServer: vi.fn(),
    buildClaudeCliHookSettings: vi.fn(),
    publishClaudeCliStatus: vi.fn(),
    subscribeClaudeCliStatus: vi.fn(() => vi.fn()),
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
  BrowserWindow: class {},
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LoggerService: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
}))

vi.mock('./pty-service', () => ({
  ptyService: mocks.ptyService
}))

vi.mock('./ghostty-service', () => ({
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

vi.mock('./ghostty-config', () => ({
  parseGhosttyConfig: vi.fn(() => ({}))
}))

vi.mock('../db', () => ({
  getDatabase: mocks.getDatabase
}))

vi.mock('./claude-binary-resolver', () => ({
  resolveClaudeBinaryPath: vi.fn(() => '/usr/local/bin/claude')
}))

vi.mock('./claude-session-watcher', () => ({
  watchForClaudeSessionId: vi.fn(
    (worktreePath: string, callback: (claudeSessionId: string) => void) => {
      mocks.claudeSessionWatchCallbacks.set(worktreePath, callback)
      return { close: vi.fn(() => mocks.claudeSessionWatchCallbacks.delete(worktreePath)) }
    }
  )
}))

vi.mock('./claude-hook-server', () => ({
  getClaudeHookServer: mocks.getClaudeHookServer,
  buildClaudeCliHookSettings: mocks.buildClaudeCliHookSettings,
  publishClaudeCliStatus: mocks.publishClaudeCliStatus,
  subscribeClaudeCliStatus: mocks.subscribeClaudeCliStatus
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import type { Session } from '../db/types'
import {
  cleanupTerminals,
  destroyNodePtyTerminal,
  createClaudeCliTerminal
} from './terminal-pty-bridge'
import { __resetRuntimeRegistryForTests } from '../effect/_shared/runtime'

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

const waitImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('Claude CLI terminal hook status wiring', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.exitCallbacks.clear()
    mocks.dataCallbacks.clear()
    mocks.claudeSessionWatchCallbacks.clear()
    vi.clearAllMocks()
    __resetRuntimeRegistryForTests()

    setupDb()
    mocks.getClaudeHookServer.mockResolvedValue({ port: 45678 })
    mocks.buildClaudeCliHookSettings.mockReturnValue('{"hooks":{"mock":true}}')
    mocks.publishDesktopBackendEvent.mockResolvedValue(true)
  })

  afterEach(() => {
    cleanupTerminals()
  })

  it('starts the hook server and passes inline settings into the Claude PTY argv before the prompt', async () => {
    const result = await createClaudeCliTerminal('hive-session-1', {
      pendingPrompt: 'Implement the plan'
    })

    expect(result).toEqual({
      success: true,
      cols: 120,
      rows: 40
    })
    expect(mocks.getClaudeHookServer).toHaveBeenCalledWith()
    expect(mocks.buildClaudeCliHookSettings).toHaveBeenCalledWith(45678, 'hive-session-1')

    const [, options] = mocks.ptyService.create.mock.calls.at(-1)! as unknown as [
      string,
      { args: string[]; command: string; cwd: string }
    ]
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

  it('does not register the old terminal:create IPC handler', () => {
    expect(mocks.handlers.has('terminal:create')).toBe(false)
  })

  it('does not register the old Claude CLI terminal IPC handler', () => {
    expect(mocks.handlers.has('terminal:createClaudeCli')).toBe(false)
  })

  it('does not import Electron IPC in the terminal PTY bridge', () => {
    const source = readFileSync(resolve(__dirname, 'terminal-pty-bridge.ts'), 'utf-8')
    const legacyIpcMain = 'ipc' + 'Main'

    expect(source).not.toContain(legacyIpcMain)
  })

  it('does not register the old terminal:resize IPC handler', () => {
    expect(mocks.handlers.has('terminal:resize')).toBe(false)
  })

  it('does not register the old terminal:destroy IPC handler', () => {
    expect(mocks.handlers.has('terminal:destroy')).toBe(false)
  })

  it('does not register the old terminal:getConfig IPC handler', () => {
    expect(mocks.handlers.has('terminal:getConfig')).toBe(false)
  })

  it('does not register the old terminal:ghostty:init IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:init')).toBe(false)
  })

  it('does not register the old terminal:ghostty:isAvailable IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:isAvailable')).toBe(false)
  })

  it('does not register the old terminal:ghostty:createSurface IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:createSurface')).toBe(false)
  })

  it('does not register the old terminal:ghostty:setFrame IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:setFrame')).toBe(false)
  })

  it('does not register the old terminal:ghostty:setSize IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:setSize')).toBe(false)
  })

  it('does not register the old terminal:ghostty:keyEvent IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:keyEvent')).toBe(false)
  })

  it('does not register the old terminal:ghostty:mouseButton IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:mouseButton')).toBe(false)
  })

  it('does not register the old terminal:ghostty:mousePos IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:mousePos')).toBe(false)
  })

  it('does not register the old terminal:ghostty:mouseScroll IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:mouseScroll')).toBe(false)
  })

  it('does not register the old terminal:ghostty:setFocus IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:setFocus')).toBe(false)
  })

  it('does not register the old terminal:ghostty:pasteText IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:pasteText')).toBe(false)
  })

  it('does not register the old terminal:ghostty:focusDiagnostics IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:focusDiagnostics')).toBe(false)
  })

  it('does not register the old terminal:ghostty:destroySurface IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:destroySurface')).toBe(false)
  })

  it('does not register the old terminal:ghostty:shutdown IPC handler', () => {
    expect(mocks.handlers.has('terminal:ghostty:shutdown')).toBe(false)
  })

  it('publishes terminal data through the backend event bus without legacy renderer IPC sends', async () => {
    await createClaudeCliTerminal('hive-session-1', {})

    mocks.dataCallbacks.get('hive-session-1')?.('hel')
    mocks.dataCallbacks.get('hive-session-1')?.('lo')
    await waitImmediate()

    await vi.waitFor(() => {
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'terminal:data:hive-session-1',
        'hello'
      )
    })
  })

  it('publishes terminal data through the backend event bus without renderer window state', async () => {
    await createClaudeCliTerminal('hive-session-1', {})

    mocks.dataCallbacks.get('hive-session-1')?.('still')
    await waitImmediate()

    await vi.waitFor(() => {
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'terminal:data:hive-session-1',
        'still'
      )
    })
  })

  it('publishes Claude session id events through the backend event bus without legacy renderer IPC sends', async () => {
    setupDb(makeSession({ claude_session_id: null }))

    const result = await createClaudeCliTerminal('hive-session-1', {})

    expect(result).toEqual({
      success: true,
      cols: 120,
      rows: 40
    })

    mocks.claudeSessionWatchCallbacks.get('/repo/worktree')?.('claude-session-new')

    await vi.waitFor(() => {
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'terminal:claude-session-id:hive-session-1',
        'claude-session-new'
      )
    })
  })

  it('publishes terminal exit through the backend event bus without legacy renderer IPC sends', async () => {
    await createClaudeCliTerminal('hive-session-1', {})

    mocks.exitCallbacks.get('hive-session-1')?.(9)

    await vi.waitFor(() => {
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'terminal:exit:hive-session-1',
        9
      )
    })
  })

  it('publishes completed with pty_exit metadata when a tracked Claude CLI PTY exits', async () => {
    await createClaudeCliTerminal('hive-session-1', {})

    mocks.exitCallbacks.get('hive-session-1')?.(9)

    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledWith({
      sessionId: 'hive-session-1',
      status: 'completed',
      metadata: { reason: 'pty_exit' }
    })
  })

  it('publishes an initial completed status after starting an idle Claude CLI PTY', async () => {
    await createClaudeCliTerminal('hive-session-1', {})

    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledWith({
      sessionId: 'hive-session-1',
      status: 'completed',
      metadata: { reason: 'pty_start' }
    })
  })

  it('removes the Claude CLI PTY-exit safety net when the terminal is destroyed', async () => {
    await createClaudeCliTerminal('hive-session-1', {})
    const exitCallback = mocks.exitCallbacks.get('hive-session-1')
    mocks.publishClaudeCliStatus.mockClear()

    destroyNodePtyTerminal('hive-session-1')
    expect(mocks.ptyService.destroy).toHaveBeenCalledWith('hive-session-1')

    exitCallback?.(0)

    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
  })
})
