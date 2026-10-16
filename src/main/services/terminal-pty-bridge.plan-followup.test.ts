/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeCliStatusPayload } from './claude-hook-server'

const mocks = vi.hoisted(() => {
  const statusListeners = new Set<(payload: any) => void>()
  const followupWatchers: Array<{
    worktreePath: string
    claudeSessionId: string
    onPlanFollowup: () => void
    close: ReturnType<typeof vi.fn>
  }> = []

  return {
    statusListeners,
    followupWatchers,
    getDatabase: vi.fn(),
    getClaudeHookServer: vi.fn(),
    buildClaudeCliHookSettings: vi.fn(),
    getLastClaudeCliStatus: vi.fn(),
    publishClaudeCliStatus: vi.fn(),
    resetClaudeCliBackgroundWork: vi.fn(),
    subscribeClaudeCliStatus: vi.fn((listener: (payload: any) => void) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    }),
    ptyService: {
      has: vi.fn(() => false),
      create: vi.fn(() => ({ cols: 120, rows: 40 })),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      write: vi.fn(),
      resize: vi.fn(),
      destroy: vi.fn(),
      destroyAll: vi.fn(),
      destroyAllAndReap: vi.fn(async () => {})
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

vi.mock('./pty-service', () => ({ ptyService: mocks.ptyService }))

vi.mock('./ghostty-service', () => ({
  ghostty: {},
  ghosttyService: {
    setMainWindow: vi.fn(),
    init: vi.fn(),
    loadAddon: vi.fn(),
    isAvailable: vi.fn(() => false),
    isInitialized: vi.fn(() => false),
    createSurface: vi.fn(),
    destroySurface: vi.fn(),
    shutdown: vi.fn()
  }
}))

vi.mock('./ghostty-config', () => ({ parseGhosttyConfig: vi.fn(() => ({})) }))

vi.mock('../db', () => ({ getDatabase: mocks.getDatabase }))

vi.mock('./claude-binary-resolver', () => ({
  resolveClaudeBinaryPath: vi.fn(() => '/usr/local/bin/claude'),
  logClaudeBinaryVersion: vi.fn()
}))

vi.mock('./claude-cli-plan-handoff', () => ({
  externalizeGoalHandoffPlan: vi.fn((prompt: string) => prompt)
}))

vi.mock('./claude-trust', () => ({
  ensureProjectTrustCheck: vi.fn(async () => {}),
  reassertSessionFolderTrust: vi.fn(async () => ({ wasMissing: false }))
}))

vi.mock('./claude-cli-pty-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-cli-pty-prompt')>()),
  reassertClaudeCliPromptSubmit: vi.fn()
}))

vi.mock('./claude-session-watcher', () => ({
  watchForClaudeSessionId: vi.fn(() => ({ close: vi.fn() }))
}))

vi.mock('./claude-plan-followup-watcher', () => ({
  watchForClaudePlanFollowup: vi.fn(
    (worktreePath: string, claudeSessionId: string, onPlanFollowup: () => void) => {
      const watcher = { worktreePath, claudeSessionId, onPlanFollowup, close: vi.fn() }
      mocks.followupWatchers.push(watcher)
      return { close: watcher.close }
    }
  )
}))

vi.mock('./claude-hook-server', () => ({
  getClaudeHookServer: mocks.getClaudeHookServer,
  buildClaudeCliHookSettings: mocks.buildClaudeCliHookSettings,
  getLastClaudeCliStatus: mocks.getLastClaudeCliStatus,
  publishClaudeCliStatus: mocks.publishClaudeCliStatus,
  resetClaudeCliBackgroundWork: mocks.resetClaudeCliBackgroundWork,
  subscribeClaudeCliStatus: mocks.subscribeClaudeCliStatus,
  subscribeCliHookEvents: vi.fn(() => vi.fn())
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: vi.fn(async () => true)
}))

vi.mock('./claude-cli-interaction-ledger', () => ({
  clearClaudeCliInteractions: vi.fn(),
  clearAllClaudeCliInteractions: vi.fn(),
  holdClaudeCliInteraction: vi.fn(),
  releaseClaudeCliInteraction: vi.fn()
}))

vi.mock('./claude-cli-subagent-tracker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-cli-subagent-tracker')>()),
  clearClaudeCliSubagentTracking: vi.fn(),
  clearAllClaudeCliSubagentTracking: vi.fn()
}))

import type { Session } from '../db/types'
import { cleanupTerminals, createClaudeCliTerminal } from './terminal-pty-bridge'
import { __resetRuntimeRegistryForTests } from '../effect/_shared/runtime'

const SESSION_ID = 'hive-session-1'

function makeSession(): Session {
  return {
    id: SESSION_ID,
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
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false
  }
}

function emitStatus(payload: Omit<ClaudeCliStatusPayload, 'sessionId'>): void {
  for (const listener of mocks.statusListeners) listener({ sessionId: SESSION_ID, ...payload })
}

describe('Claude CLI plan follow-up watcher lifecycle', () => {
  beforeEach(async () => {
    mocks.statusListeners.clear()
    mocks.followupWatchers.length = 0
    vi.clearAllMocks()
    __resetRuntimeRegistryForTests()

    const session = makeSession()
    mocks.getDatabase.mockReturnValue({
      getSession: vi.fn(() => session),
      getWorktree: vi.fn(() => ({ path: '/repo/worktree' })),
      getConnection: vi.fn(() => ({ path: '/repo/connection' })),
      getProject: vi.fn(() => ({ id: session.project_id, path: '/repo', kind: 'git' })),
      getSetting: vi.fn(() => null),
      getSessionByClaudeSessionId: vi.fn(() => null),
      updateSession: vi.fn(),
      updateProjectTrustCheck: vi.fn()
    })
    mocks.getClaudeHookServer.mockResolvedValue({ port: 45678 })
    mocks.buildClaudeCliHookSettings.mockReturnValue('{"hooks":{}}')

    await createClaudeCliTerminal(SESSION_ID, {})
    emitStatus({ status: 'plan_ready' })
    expect(mocks.followupWatchers).toHaveLength(1)
    expect(mocks.followupWatchers[0]).toMatchObject({
      worktreePath: '/repo/worktree',
      claudeSessionId: 'claude-session-1'
    })
  })

  afterEach(() => {
    cleanupTerminals()
  })

  it.each(['completed', 'unread'] as const)(
    'closes the watcher when the turn ends with status %s',
    (status) => {
      emitStatus({ status, metadata: { reason: 'user_interrupt' } })

      expect(mocks.followupWatchers[0].close).toHaveBeenCalledTimes(1)
    }
  )

  it('closes the watcher when ExitPlanMode is accepted (PostToolUse)', () => {
    emitStatus({
      status: 'working',
      metadata: { hookEventName: 'PostToolUse', toolName: 'ExitPlanMode' }
    })

    expect(mocks.followupWatchers[0].close).toHaveBeenCalledTimes(1)
  })

  it('closes the watcher when ExitPlanMode fails (PostToolUseFailure)', () => {
    emitStatus({
      status: 'planning',
      metadata: { hookEventName: 'PostToolUseFailure', toolName: 'ExitPlanMode' }
    })

    expect(mocks.followupWatchers[0].close).toHaveBeenCalledTimes(1)
  })

  it.each(['working', 'planning', 'permission', 'answering'] as const)(
    'keeps the watcher open while the session is %s without an ExitPlanMode hook',
    (status) => {
      emitStatus({ status, metadata: { hookEventName: 'PostToolUse', toolName: 'Read' } })

      expect(mocks.followupWatchers[0].close).not.toHaveBeenCalled()
    }
  )

  it('re-arms a fresh watcher on a later plan_ready after the turn ended', () => {
    emitStatus({ status: 'completed' })
    emitStatus({ status: 'plan_ready' })

    expect(mocks.followupWatchers).toHaveLength(2)
    expect(mocks.followupWatchers[0].close).toHaveBeenCalledTimes(1)
    expect(mocks.followupWatchers[1].close).not.toHaveBeenCalled()
  })

  it('publishes planning and closes the watcher when a follow-up is detected', () => {
    mocks.followupWatchers[0].onPlanFollowup()

    expect(mocks.followupWatchers[0].close).toHaveBeenCalledTimes(1)
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      status: 'planning',
      metadata: { reason: 'claude_cli_plan_followup' }
    })
  })
})
