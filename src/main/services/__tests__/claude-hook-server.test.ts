// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const backendManagerMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../desktop/backend-manager', () => ({
  publishDesktopBackendEvent: backendManagerMocks.publishDesktopBackendEvent
}))

import {
  buildClaudeCliHookSettings,
  closeClaudeHookServer,
  getClaudeHookServer,
  mapHookEventToStatus,
  publishClaudeCliStatus,
  type ParsedClaudeHook
} from '../claude-hook-server'

async function postHook(
  port: number,
  sessionId: string,
  path: 'session' | 'start' | 'stop' | 'tool' | 'permission',
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
    ]
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
        PreToolUse: [
          {
            matcher: 'ExitPlanMode|AskUserQuestion',
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:34819/hook/hive-session-1/tool'
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
