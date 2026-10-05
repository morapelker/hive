// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const backendManagerMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

const recorderMocks = vi.hoisted(() => ({
  recordSessionFinalMessage: vi.fn()
}))

const dbMocks = vi.hoisted(() => ({
  upsertSessionFinalMessage: vi.fn()
}))

vi.mock('../pty-service', () => ({
  ptyService: { has: vi.fn(() => true), write: vi.fn() }
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: backendManagerMocks.publishDesktopBackendEvent
}))

vi.mock('../hive-enterprise-claude-cli-telemetry', () => ({
  handleClaudeCliHiveTelemetryHook: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../../db', () => ({
  getDatabase: () => ({
    getSession: () => null,
    getSessionByClaudeSessionId: () => null,
    updateSession: vi.fn(),
    upsertSessionFinalMessage: dbMocks.upsertSessionFinalMessage
  })
}))

vi.mock('../usage/session-usage-service', () => ({
  scheduleSessionUsageReport: vi.fn()
}))

vi.mock('../document-flow/session-final-message-recorder', () => ({
  recordSessionFinalMessage: recorderMocks.recordSessionFinalMessage
}))

import { closeClaudeHookServer, getClaudeHookServer } from '../claude-hook-server'
import {
  SUBAGENT_WATCHDOG_TIMEOUT_MS,
  processClaudeCliSubagentHook
} from '../claude-cli-subagent-tracker'
import { recordSessionFinalMessage } from '../document-flow/session-final-message-recorder'

const SESSION = 'hive-session-final'

async function postHook(
  port: number,
  path: 'start' | 'stop' | 'subagent',
  body: Record<string, unknown>,
  cli: 'hook' | 'codex-hook' = 'hook'
): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/${cli}/${SESSION}/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' }
  })
}

/** The calls that recorded a turn end, leaving out the working / blocked state updates. */
const turnEndCalls = (): unknown[][] =>
  recorderMocks.recordSessionFinalMessage.mock.calls.filter(
    ([input]) => (input as { state?: string }).state === undefined
  )

afterEach(async () => {
  await closeClaudeHookServer()
  vi.clearAllMocks()
})

describe('final-message capture on turn end', () => {
  it('records the text and completion of a passing main-agent Stop', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'stop', {
      hook_event_name: 'Stop',
      last_assistant_message: 'All done.\n\nSTATUS: DONE',
      background_tasks: [],
      session_crons: []
    })

    expect(recorderMocks.recordSessionFinalMessage).toHaveBeenCalledTimes(1)
    expect(recorderMocks.recordSessionFinalMessage).toHaveBeenCalledWith({
      session_id: SESSION,
      text: 'All done.\n\nSTATUS: DONE',
      completion: 'completed',
      api_error: null,
      hook_event: 'Stop'
    })
  })

  it('records a paused Stop as waiting, and a legacy Stop as unknown with the older field', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'stop', {
      hook_event_name: 'Stop',
      assistant_message: 'Will check back later.',
      background_tasks: [],
      session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'poll' }]
    })
    await postHook(port, 'stop', { hook_event_name: 'Stop' })

    expect(recorderMocks.recordSessionFinalMessage.mock.calls).toEqual([
      [
        {
          session_id: SESSION,
          text: 'Will check back later.',
          completion: 'waiting',
          api_error: null,
          hook_event: 'Stop'
        }
      ],
      [
        {
          session_id: SESSION,
          text: '',
          completion: 'unknown',
          api_error: null,
          hook_event: 'Stop'
        }
      ]
    ])
  })

  it('ignores a subagent-scoped Stop', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'stop', {
      hook_event_name: 'Stop',
      agent_id: 'agent-1',
      last_assistant_message: 'Subagent finished its part.'
    })

    expect(recorderMocks.recordSessionFinalMessage).not.toHaveBeenCalled()
  })

  it('ignores a deferred Stop and records the one that ends the turn', async () => {
    const { port } = await getClaudeHookServer()

    // The main agent stops while a background subagent is still running: not a turn end.
    await postHook(port, 'stop', {
      hook_event_name: 'Stop',
      last_assistant_message: 'Waiting for the subagent.',
      background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }]
    })
    expect(recorderMocks.recordSessionFinalMessage).not.toHaveBeenCalled()

    await postHook(port, 'subagent', {
      hook_event_name: 'SubagentStop',
      agent_id: 'a',
      background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }]
    })
    await postHook(port, 'start', {
      hook_event_name: 'UserPromptSubmit',
      permission_mode: 'default',
      prompt: '<task-notification>\n<task-id>a</task-id>\n</task-notification>'
    })
    await postHook(port, 'stop', {
      hook_event_name: 'Stop',
      last_assistant_message: 'Now it is done.',
      background_tasks: []
    })

    expect(turnEndCalls()).toEqual([
      [expect.objectContaining({ text: 'Now it is done.', completion: 'completed' })]
    ])
  })

  it('records the turn end the deferred-completion watchdog declares, without the deferred text', async () => {
    await getClaudeHookServer()
    vi.useFakeTimers()
    try {
      const gate = processClaudeCliSubagentHook(
        SESSION,
        {
          hook_event_name: 'Stop',
          last_assistant_message: 'Waiting for the subagent.',
          background_tasks: [{ id: 'a', type: 'subagent', status: 'running' }]
        },
        {
          sessionId: SESSION,
          status: 'completed',
          metadata: { hookEventName: 'Stop', completion: 'completed' }
        }
      )
      expect(gate).toEqual({ kind: 'defer_stop' })
      expect(turnEndCalls()).toEqual([])

      vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS)

      // The deferred message predates the subagents' results: an empty text sends the judge
      // to the transcript instead of the previous turn's recorded message.
      expect(turnEndCalls()).toEqual([
        [
          {
            session_id: SESSION,
            text: '',
            completion: 'completed',
            api_error: null,
            hook_event: 'Stop'
          }
        ]
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('records a codex Interrupt (the user stopped the turn) apart from a Stop', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(
      port,
      'stop',
      {
        session_id: '01a07dbd-6a11-7982-a2b6-ceaa43736708',
        transcript_path: '/Users/me/.codex/sessions/rollout.jsonl',
        cwd: '/repo/wt',
        hook_event_name: 'Interrupt'
      },
      'codex-hook'
    )

    expect(turnEndCalls()).toEqual([
      [
        {
          session_id: SESSION,
          text: '',
          completion: null,
          api_error: null,
          hook_event: 'Interrupt'
        }
      ]
    ])
  })

  it('records the API error of a StopFailure, with whatever text the turn produced', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'stop', {
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      error_details: 'You have hit your limit',
      last_assistant_message: 'I was in the middle of'
    })
    await postHook(port, 'stop', { hook_event_name: 'StopFailure' })

    expect(recorderMocks.recordSessionFinalMessage.mock.calls).toEqual([
      [
        {
          session_id: SESSION,
          text: 'I was in the middle of',
          completion: null,
          api_error: 'rate_limit',
          hook_event: 'StopFailure'
        }
      ],
      [
        {
          session_id: SESSION,
          text: '',
          completion: null,
          api_error: 'unknown',
          hook_event: 'StopFailure'
        }
      ]
    ])
  })

  it('ignores a subagent-scoped StopFailure', async () => {
    const { port } = await getClaudeHookServer()

    await postHook(port, 'stop', {
      hook_event_name: 'StopFailure',
      agent_id: 'agent-1',
      error: 'server_error'
    })

    expect(recorderMocks.recordSessionFinalMessage).not.toHaveBeenCalled()
  })
})

describe('recordSessionFinalMessage', () => {
  it('writes the row, and never throws into the hook pipeline', async () => {
    const { recordSessionFinalMessage: record } = await vi.importActual<{
      recordSessionFinalMessage: typeof recordSessionFinalMessage
    }>('../document-flow/session-final-message-recorder')
    const input = {
      session_id: SESSION,
      text: 'Done.',
      completion: 'completed',
      api_error: null,
      hook_event: 'Stop'
    }

    record(input)
    expect(dbMocks.upsertSessionFinalMessage).toHaveBeenCalledWith(input)

    dbMocks.upsertSessionFinalMessage.mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    expect(() => record(input)).not.toThrow()
  })
})
