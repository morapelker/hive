// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'

const backendManagerMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

const telemetryMocks = vi.hoisted(() => ({
  handleClaudeCliHiveTelemetryHook: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: backendManagerMocks.publishDesktopBackendEvent
}))

vi.mock('../hive-enterprise-claude-cli-telemetry', () => ({
  handleClaudeCliHiveTelemetryHook: telemetryMocks.handleClaudeCliHiveTelemetryHook
}))

import {
  buildClaudeCliHookSettings,
  closeClaudeHookServer,
  getClaudeHookServer,
  mapHookEventToStatus,
  publishClaudeCliStatus,
  subscribeClaudeCliStatus,
  type ParsedClaudeHook
} from '../claude-hook-server'
import { hasBlockingClaudeCliInteraction } from '../claude-cli-interaction-ledger'
import {
  processClaudeCliSubagentHook,
  SUBAGENT_WATCHDOG_TIMEOUT_MS
} from '../claude-cli-subagent-tracker'
import { cliHookTransportRouter } from '../cli-hook-transport-router'

async function postHook(
  port: number,
  sessionId: string,
  path: 'session' | 'start' | 'stop' | 'tool' | 'permission' | 'subagent',
  body: Record<string, unknown> | string
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/hook/${sessionId}/${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      'content-type': 'application/json'
    }
  })

  return { status: response.status, text: await response.text() }
}

async function getHook(
  port: number,
  sessionId: string,
  path: 'session' | 'start' | 'stop' | 'tool' | 'permission'
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/hook/${sessionId}/${path}`)

  return { status: response.status, text: await response.text() }
}

afterEach(async () => {
  await closeClaudeHookServer()
  vi.clearAllMocks()
  backendManagerMocks.publishDesktopBackendEvent.mockReset()
})

describe('mapHookEventToStatus', () => {
  it.each<[string, ParsedClaudeHook, string | null]>([
    ['SessionStart maps to completed', { hook_event_name: 'SessionStart' }, 'completed'],
    ['SessionEnd maps to completed', { hook_event_name: 'SessionEnd' }, 'completed'],
    [
      'UserPromptSubmit in plan mode maps to planning',
      { hook_event_name: 'UserPromptSubmit', permission_mode: 'plan' },
      'planning'
    ],
    [
      'UserPromptSubmit in default mode maps to working',
      { hook_event_name: 'UserPromptSubmit', permission_mode: 'default' },
      'working'
    ],
    ['Stop maps to completed', { hook_event_name: 'Stop' }, 'completed'],
    [
      'PreToolUse ExitPlanMode maps to plan_ready',
      { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode' },
      'plan_ready'
    ],
    [
      'PreToolUse AskUserQuestion maps to answering',
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' },
      'answering'
    ],
    [
      'PostToolUse ExitPlanMode maps to working',
      { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode' },
      'working'
    ],
    [
      'PostToolUse other tool maps to working',
      { hook_event_name: 'PostToolUse', tool_name: 'Read' },
      'working'
    ],
    [
      'PostToolUseFailure ExitPlanMode maps to planning',
      { hook_event_name: 'PostToolUseFailure', tool_name: 'ExitPlanMode' },
      'planning'
    ],
    ['PostToolUseFailure maps to working', { hook_event_name: 'PostToolUseFailure' }, 'working'],
    [
      'PermissionRequest maps to permission',
      { hook_event_name: 'PermissionRequest' },
      'permission'
    ],
    [
      'PermissionRequest for ExitPlanMode maps to plan_ready',
      { hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode' },
      'plan_ready'
    ],
    [
      'PermissionRequest for AskUserQuestion maps to answering',
      { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion' },
      'answering'
    ],
    ['unknown events are ignored', { hook_event_name: 'BogusEvent' }, null],
    [
      'unmatched PreToolUse events are ignored',
      { hook_event_name: 'PreToolUse', tool_name: 'Read' },
      null
    ],
    ['SubagentStop maps to null', { hook_event_name: 'SubagentStop' }, null]
  ])('%s', (_name, hook, expected) => {
    expect(mapHookEventToStatus(hook)).toBe(expected)
  })
})

describe('buildClaudeCliHookSettings', () => {
  it('builds Claude hook settings with session-scoped localhost URLs and exact matchers', () => {
    const settings = JSON.parse(buildClaudeCliHookSettings(34819, 'hive-session-1'))

    expect(settings).toEqual({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:34819/hook/hive-session-1/session'
              }
            ]
          }
        ],
        SessionEnd: [
          {
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:34819/hook/hive-session-1/session'
              }
            ]
          }
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:34819/hook/hive-session-1/start'
              }
            ]
          }
        ],
        Stop: [
          {
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:34819/hook/hive-session-1/stop'
              }
            ]
          }
        ],
        SubagentStop: [
          {
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:34819/hook/hive-session-1/subagent'
              }
            ]
          }
        ],
        PreToolUse: [
          {
            matcher: 'ExitPlanMode|AskUserQuestion',
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:34819/hook/hive-session-1/tool',
                timeout: 600
              }
            ]
          }
        ],
        PostToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:34819/hook/hive-session-1/tool'
              }
            ]
          }
        ],
        PostToolUseFailure: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:34819/hook/hive-session-1/tool'
              }
            ]
          }
        ],
        // SubagentStart is intentionally not registered: only completion of a
        // background subagent (SubagentStop) is needed by the tracker.
        PermissionRequest: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:34819/hook/hive-session-1/permission'
              }
            ]
          }
        ]
      }
    })
    expect(settings.hooks).not.toHaveProperty('SubagentStart')
  })
})

describe('ClaudeHookServer HTTP round-trip', () => {
  it('publishes mapped hook status through the backend event bus without legacy renderer IPC sends', async () => {
    const { port } = await getClaudeHookServer()
    backendManagerMocks.publishDesktopBackendEvent.mockResolvedValue(true)

    const response = await postHook(port, 'hive-session-1', 'session', {
      hook_event_name: 'SessionStart'
    })

    expect(response).toEqual({ status: 200, text: '{}' })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'claude-cli:status',
        {
          sessionId: 'hive-session-1',
          status: 'completed',
          metadata: { hookEventName: 'SessionStart', hookPath: 'session' }
        }
      )
    })
  })

  it('publishes ExitPlanMode raw plan text through the backend event bus', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: {
        plan: '# Plan\n\n1. Add CLI card.'
      }
    })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'claude-cli:status',
        {
          sessionId: 'hive-session-1',
          status: 'plan_ready',
          metadata: {
            hookEventName: 'PreToolUse',
            hookPath: 'tool',
            toolName: 'ExitPlanMode',
            plan: '# Plan\n\n1. Add CLI card.'
          }
        }
      )
    })
  })

  it('forwards ExitPlanMode rejection as planning so plan followups can resume review', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'ExitPlanMode',
      tool_response: {
        content: 'Please revise the plan before implementing.'
      }
    })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'claude-cli:status',
        {
          sessionId: 'hive-session-1',
          status: 'planning',
          metadata: {
            hookEventName: 'PostToolUseFailure',
            hookPath: 'tool',
            toolName: 'ExitPlanMode'
          }
        }
      )
    })
  })

  it('does not publish duplicate sequential statuses for the same session', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })
    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
    })
  })

  it('publishes again after the session status changes', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })
    await postHook(port, 'hive-session-1', 'permission', {
      hook_event_name: 'PermissionRequest'
    })
    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(3)
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenNthCalledWith(
      3,
      'claude-cli:status',
      {
        sessionId: 'hive-session-1',
        status: 'working',
        metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start' }
      }
    )
  })

  it('dedupes direct PTY-exit fallback after an equivalent hook status', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
    })
    publishClaudeCliStatus({
      sessionId: 'hive-session-1',
      status: 'completed',
      metadata: { reason: 'pty_exit' }
    })

    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      'claude-cli:status',
      {
        sessionId: 'hive-session-1',
        status: 'completed',
        metadata: { hookEventName: 'Stop', hookPath: 'stop' }
      }
    )
  })

  it('keeps a pending question surfaced through unrelated sub-agent hooks until answered', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'claude-cli:status',
        expect.objectContaining({ sessionId: 'hive-session-1', status: 'answering' })
      )
    })

    // Parallel sub-agent tool completions must not clobber the question.
    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read'
    })
    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash'
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)

    // Answering the question resolves the latch and publishes working.
    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PostToolUse',
      tool_name: 'AskUserQuestion'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(2)
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenLastCalledWith(
      'claude-cli:status',
      {
        sessionId: 'hive-session-1',
        status: 'working',
        metadata: {
          hookEventName: 'PostToolUse',
          hookPath: 'tool',
          toolName: 'AskUserQuestion'
        }
      }
    )
  })

  it('re-surfaces a queued permission request after the question is answered', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion'
    })
    // Permission arrives while the question is pending: queued, not published.
    await postHook(port, 'hive-session-1', 'permission', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
    })

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PostToolUse',
      tool_name: 'AskUserQuestion'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(3)
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenNthCalledWith(
      2,
      'claude-cli:status',
      expect.objectContaining({ sessionId: 'hive-session-1', status: 'working' })
    )
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenNthCalledWith(
      3,
      'claude-cli:status',
      {
        sessionId: 'hive-session-1',
        status: 'permission',
        metadata: {
          hookEventName: 'PermissionRequest',
          hookPath: 'permission',
          toolName: 'Bash',
          reason: 'interaction_resurfaced'
        }
      }
    )

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(4)
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenLastCalledWith(
      'claude-cli:status',
      expect.objectContaining({ sessionId: 'hive-session-1', status: 'working' })
    )
  })

  it('keeps plan_ready surfaced through sub-agent completions until the plan resolves', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '# Plan' }
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'claude-cli:status',
        expect.objectContaining({ sessionId: 'hive-session-1', status: 'plan_ready' })
      )
    })

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Task'
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PostToolUse',
      tool_name: 'ExitPlanMode'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(2)
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenLastCalledWith(
      'claude-cli:status',
      {
        sessionId: 'hive-session-1',
        status: 'working',
        metadata: {
          hookEventName: 'PostToolUse',
          hookPath: 'tool',
          toolName: 'ExitPlanMode'
        }
      }
    )
  })

  it('clears pending interactions on turn boundaries so later hooks publish normally', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion'
    })
    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(2)
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenLastCalledWith(
      'claude-cli:status',
      expect.objectContaining({ sessionId: 'hive-session-1', status: 'working' })
    )

    // The abandoned question no longer suppresses later publishes.
    await postHook(port, 'hive-session-1', 'permission', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(3)
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenLastCalledWith(
      'claude-cli:status',
      expect.objectContaining({ sessionId: 'hive-session-1', status: 'permission' })
    )
  })

  it('ignores unknown event names without publishing status events', async () => {
    const { port } = await getClaudeHookServer()

    const response = await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'BogusEvent'
    })

    expect(response).toEqual({ status: 200, text: '{}' })
    expect(backendManagerMocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  it('handles malformed JSON without publishing status events', async () => {
    const { port } = await getClaudeHookServer()

    const response = await postHook(port, 'hive-session-1', 'start', 'not json')

    expect(response).toEqual({ status: 200, text: '{}' })
    expect(backendManagerMocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  it('rejects non-POST requests without publishing status events', async () => {
    const { port } = await getClaudeHookServer()

    const response = await getHook(port, 'hive-session-1', 'start')

    expect(response).toEqual({ status: 405, text: '{}' })
    expect(backendManagerMocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })
})

function completedCalls(): unknown[] {
  return backendManagerMocks.publishDesktopBackendEvent.mock.calls.filter(
    ([channel, payload]) =>
      channel === 'claude-cli:status' &&
      (payload as { status?: string } | undefined)?.status === 'completed'
  )
}

describe('background subagent deferral (HTTP round-trip)', () => {
  it('defers session completion while a background subagent runs, then completes once the notification resume ends cleanly', async () => {
    const { port } = await getClaudeHookServer()

    // (No leading "real" UserPromptSubmit here: publishClaudeCliStatus dedupes
    // on status alone, so an initial 'working' would swallow the resume's
    // identically-'working' publish below and hide the very metadata this
    // test is verifying. Starting from the deferred Stop keeps the dedup
    // cache empty going into the assertions that matter.)
    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }]
    })
    expect(completedCalls()).toHaveLength(0)

    // Self-listed SubagentStop: the subagent finished but the resume turn
    // hasn't started yet — still no completion.
    await postHook(port, 'hive-session-1', 'subagent', {
      hook_event_name: 'SubagentStop',
      agent_id: 'a',
      background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }]
    })
    expect(completedCalls()).toHaveLength(0)

    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default',
      prompt: '<task-notification>\n<task-id>a</task-id>\n</task-notification>'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'claude-cli:status',
        expect.objectContaining({
          status: 'working',
          metadata: expect.objectContaining({ taskNotification: true })
        })
      )
    })
    expect(completedCalls()).toHaveLength(0)

    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop',
      background_tasks: []
    })

    await vi.waitFor(() => {
      expect(completedCalls()).toHaveLength(1)
    })
    const [, completedPayload] = completedCalls()[0] as [string, { metadata?: { hookEventName?: string } }]
    expect(completedPayload.metadata?.hookEventName).toBe('Stop')
  })

  it('queued-notification gap: a clean Stop still defers when the notification has not arrived yet', async () => {
    const { port } = await getClaudeHookServer()

    // Subagent finishes mid-turn, self-listed, before the main Stop fires.
    await postHook(port, 'hive-session-1', 'subagent', {
      hook_event_name: 'SubagentStop',
      agent_id: 'a',
      background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }]
    })

    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop',
      background_tasks: []
    })
    expect(completedCalls()).toHaveLength(0)

    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default',
      prompt: '<task-notification>\n<task-id>a</task-id>\n</task-notification>'
    })
    expect(completedCalls()).toHaveLength(0)

    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop',
      background_tasks: []
    })

    await vi.waitFor(() => {
      expect(completedCalls()).toHaveLength(1)
    })
  })

  it('foreground subagent: a not-self-listed SubagentStop lets the following Stop complete immediately', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'subagent', {
      hook_event_name: 'SubagentStop',
      agent_id: 'a',
      background_tasks: []
    })
    expect(completedCalls()).toHaveLength(0)

    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop',
      background_tasks: []
    })

    await vi.waitFor(() => {
      expect(completedCalls()).toHaveLength(1)
    })
  })
})

describe('ledger survival across a deferred Stop', () => {
  it('keeps a latched question surfaced through a deferring Stop and a task-notification resume, but a plain prompt clears it', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'claude-cli:status',
        expect.objectContaining({ status: 'answering' })
      )
    })
    expect(hasBlockingClaudeCliInteraction('hive-session-1')).toBe(true)

    // A deferred Stop (background subagent still running) must never reach
    // the ledger — its RESET would otherwise clobber the latched question.
    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }]
    })
    expect(hasBlockingClaudeCliInteraction('hive-session-1')).toBe(true)

    const callsBeforeUnrelated = backendManagerMocks.publishDesktopBackendEvent.mock.calls.length
    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read'
    })
    expect(backendManagerMocks.publishDesktopBackendEvent.mock.calls.length).toBe(callsBeforeUnrelated)
    expect(hasBlockingClaudeCliInteraction('hive-session-1')).toBe(true)

    // A task-notification resume is not a user turn boundary either.
    const callsBeforeNotification = backendManagerMocks.publishDesktopBackendEvent.mock.calls.length
    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default',
      prompt: '<task-notification>\n<task-id>a</task-id>\n</task-notification>'
    })
    expect(backendManagerMocks.publishDesktopBackendEvent.mock.calls.length).toBe(callsBeforeNotification)
    expect(hasBlockingClaudeCliInteraction('hive-session-1')).toBe(true)

    // A plain user prompt still resets it.
    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default',
      prompt: 'please continue'
    })
    expect(hasBlockingClaudeCliInteraction('hive-session-1')).toBe(false)
  })
})

describe('telemetry gating for deferred Stops', () => {
  it('does not record telemetry for a deferred Stop but does for a passing one', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }]
    })
    expect(telemetryMocks.handleClaudeCliHiveTelemetryHook).not.toHaveBeenCalled()

    await postHook(port, 'hive-session-1', 'subagent', {
      hook_event_name: 'SubagentStop',
      agent_id: 'a',
      background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }]
    })
    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default',
      prompt: '<task-notification>\n<task-id>a</task-id>\n</task-notification>'
    })
    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop',
      background_tasks: []
    })

    expect(telemetryMocks.handleClaudeCliHiveTelemetryHook).toHaveBeenCalledWith(
      'hive-session-1',
      expect.objectContaining({ hook_event_name: 'Stop' })
    )
  })
})

describe('transport ctx suppressIdle', () => {
  it('passes suppressIdle true for a deferred Stop and false for a passing hook', async () => {
    const { port } = await getClaudeHookServer()
    const routeHookSpy = vi.spyOn(cliHookTransportRouter, 'routeHook')

    await postHook(port, 'hive-session-1', 'stop', {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }]
    })
    expect(routeHookSpy).toHaveBeenLastCalledWith(
      'hive-session-1',
      expect.objectContaining({ hook_event_name: 'Stop' }),
      expect.anything(),
      { suppressIdle: true }
    )

    await postHook(port, 'hive-session-1', 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default'
    })
    expect(routeHookSpy).toHaveBeenLastCalledWith(
      'hive-session-1',
      expect.objectContaining({ hook_event_name: 'UserPromptSubmit' }),
      expect.anything(),
      { suppressIdle: false }
    )

    routeHookSpy.mockRestore()
  })
})

describe('deferred-completion watchdog handler', () => {
  afterEach(() => {
    // Must run before the top-level afterEach's closeClaudeHookServer(), so
    // the server close (real socket I/O) happens under real timers.
    vi.useRealTimers()
  })

  it('completes via the watchdog handler after the timeout and notifies transport idle', async () => {
    await getClaudeHookServer()
    const statusListener = vi.fn()
    const unsubscribe = subscribeClaudeCliStatus(statusListener)
    const notifyIdleSpy = vi.spyOn(cliHookTransportRouter, 'notifySessionIdle')

    vi.useFakeTimers()
    try {
      const gate = processClaudeCliSubagentHook(
        'hive-session-1',
        { hook_event_name: 'Stop', background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }] },
        { sessionId: 'hive-session-1', status: 'completed', metadata: { hookEventName: 'Stop' } }
      )
      expect(gate).toEqual({ kind: 'defer_stop' })

      vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS)

      expect(statusListener).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'hive-session-1',
          status: 'completed',
          metadata: expect.objectContaining({ reason: 'deferred_completion_watchdog' })
        })
      )
      expect(notifyIdleSpy).toHaveBeenCalledWith('hive-session-1', undefined)
    } finally {
      unsubscribe()
      notifyIdleSpy.mockRestore()
    }
  })

  it('does not complete via the watchdog while a blocking interaction is pending', async () => {
    const { port } = await getClaudeHookServer()
    await postHook(port, 'hive-session-1', 'tool', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion'
    })

    const statusListener = vi.fn()
    const unsubscribe = subscribeClaudeCliStatus(statusListener)
    const notifyIdleSpy = vi.spyOn(cliHookTransportRouter, 'notifySessionIdle')

    vi.useFakeTimers()
    try {
      const gate = processClaudeCliSubagentHook(
        'hive-session-1',
        { hook_event_name: 'Stop', background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }] },
        { sessionId: 'hive-session-1', status: 'completed', metadata: { hookEventName: 'Stop' } }
      )
      expect(gate).toEqual({ kind: 'defer_stop' })

      vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS)

      expect(statusListener).not.toHaveBeenCalled()
      expect(notifyIdleSpy).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
      notifyIdleSpy.mockRestore()
    }
  })
})

describe('first-prompt detection with task notifications', () => {
  // A dedicated session id: `firstPromptAnnounced` is a module-level Set that
  // closeClaudeHookServer() never clears (by design — a session must announce
  // at most once for the lifetime of the app, even across hook-server
  // restarts), so reusing 'hive-session-1' here would flake depending on
  // whether an earlier test in this file already sent it a real prompt.
  const SESSION = 'hive-session-first-prompt'

  it('does not treat a task-notification resume as the first prompt, but a later real prompt still announces', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, SESSION, 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default',
      prompt: '<task-notification>\n<task-id>a</task-id>\n</task-notification>'
    })
    expect(backendManagerMocks.publishDesktopBackendEvent).not.toHaveBeenCalledWith(
      OPENCODE_STREAM_CHANNEL,
      expect.objectContaining({ type: 'claude-cli.first-prompt-detected' })
    )

    await postHook(port, SESSION, 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default',
      prompt: 'please fix the bug'
    })
    await vi.waitFor(() => {
      expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        OPENCODE_STREAM_CHANNEL,
        {
          type: 'claude-cli.first-prompt-detected',
          sessionId: SESSION,
          data: { promptText: 'please fix the bug' }
        }
      )
    })
  })
})
