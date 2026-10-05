// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const recorderMocks = vi.hoisted(() => ({
  recordSessionFinalMessage: vi.fn()
}))

vi.mock('../pty-service', () => ({
  ptyService: { has: vi.fn(() => true), write: vi.fn() }
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../hive-enterprise-claude-cli-telemetry', () => ({
  handleClaudeCliHiveTelemetryHook: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../../db', () => ({
  getDatabase: () => ({
    getSession: () => null,
    getSessionByClaudeSessionId: () => null,
    updateSession: vi.fn(),
    upsertSessionFinalMessage: vi.fn()
  })
}))

vi.mock('../usage/session-usage-service', () => ({
  scheduleSessionUsageReport: vi.fn()
}))

vi.mock('../document-flow/session-final-message-recorder', () => ({
  recordSessionFinalMessage: recorderMocks.recordSessionFinalMessage
}))

import { clearClaudeCliStatus, publishClaudeCliStatus } from '../claude-hook-server'

const SESSION = 'hive-session-state'

const recorded = (): unknown[] =>
  recorderMocks.recordSessionFinalMessage.mock.calls.map(([input]) => input)

afterEach(() => {
  clearClaudeCliStatus(SESSION)
  publishClaudeCliStatus({ sessionId: SESSION, status: 'completed' })
  clearClaudeCliStatus(SESSION)
  vi.clearAllMocks()
})

describe('recording the session state from published statuses', () => {
  it('records a blocking status with its tool, and the return to work', () => {
    publishClaudeCliStatus({
      sessionId: SESSION,
      status: 'permission',
      metadata: { hookEventName: 'PermissionRequest', toolName: 'Bash' }
    })
    publishClaudeCliStatus({
      sessionId: SESSION,
      status: 'working',
      metadata: { hookEventName: 'PostToolUse', toolName: 'Bash' }
    })

    expect(recorded()).toEqual([
      {
        session_id: SESSION,
        state: 'blocked',
        completion: null,
        api_error: null,
        hook_event: 'permission',
        detail: 'Bash'
      },
      {
        session_id: SESSION,
        state: 'working',
        completion: null,
        api_error: null,
        hook_event: 'Working',
        detail: null
      }
    ])
  })

  it.each([
    ['answering', 'AskUserQuestion'],
    ['plan_ready', 'ExitPlanMode'],
    ['command_approval', undefined]
  ] as const)('records %s as blocked under its own name, without its tool', (status, toolName) => {
    publishClaudeCliStatus({
      sessionId: SESSION,
      status,
      metadata: toolName ? { hookEventName: 'PreToolUse', toolName } : {}
    })

    expect(recorded()).toEqual([
      expect.objectContaining({ state: 'blocked', hook_event: status, detail: null })
    ])
  })

  it('writes once while the session keeps working, and not at all for a turn end', () => {
    publishClaudeCliStatus({ sessionId: SESSION, status: 'working' })
    publishClaudeCliStatus({ sessionId: SESSION, status: 'working' })
    publishClaudeCliStatus({ sessionId: SESSION, status: 'planning' })
    publishClaudeCliStatus({ sessionId: SESSION, status: 'working' })
    publishClaudeCliStatus({
      sessionId: SESSION,
      status: 'completed',
      metadata: { hookEventName: 'Stop', completion: 'completed' }
    })

    expect(recorded()).toEqual([expect.objectContaining({ state: 'working' })])
  })

  it('records working again after a turn end, since the Stop recorded the end itself', () => {
    publishClaudeCliStatus({ sessionId: SESSION, status: 'working' })
    publishClaudeCliStatus({ sessionId: SESSION, status: 'completed' })
    publishClaudeCliStatus({ sessionId: SESSION, status: 'working' })

    expect(recorded().map((input) => (input as { state: string }).state)).toEqual([
      'working',
      'working'
    ])
  })

  it('ignores statuses that say nothing about the turn', () => {
    publishClaudeCliStatus({ sessionId: SESSION, status: 'unread' })

    expect(recorded()).toEqual([])
  })
})
