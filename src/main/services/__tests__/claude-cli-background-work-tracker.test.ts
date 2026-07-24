// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'

import {
  clearAllClaudeCliBackgroundWork,
  clearClaudeCliBackgroundWork,
  getClaudeCliBackgroundWorkCounts,
  MONITOR_TIMEOUT_EVENT,
  parseEndedTaskNotificationIds,
  processClaudeCliBackgroundWorkHook
} from '../claude-cli-background-work-tracker'
import type { ParsedClaudeHook } from '../claude-hook-server'

const SESSION = 'hive-session-1'

// Fixtures mirror real hook payloads captured from claude v2.1.218.

function backgroundBashStart(taskId: string): ParsedClaudeHook {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { run_in_background: true },
    tool_response: {
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      backgroundTaskId: taskId
    }
  }
}

function monitorStart(taskId: string): ParsedClaudeHook {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Monitor',
    tool_response: { taskId, timeoutMs: 3600000, persistent: false }
  }
}

function notificationPrompt(blocks: string[]): ParsedClaudeHook {
  return { hook_event_name: 'UserPromptSubmit', prompt: blocks.join('\n') }
}

function terminalBlock(taskId: string, status: string): string {
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>Background command "x" ended</summary>\n</task-notification>`
}

afterEach(() => {
  clearAllClaudeCliBackgroundWork()
})

describe('processClaudeCliBackgroundWorkHook', () => {
  it('counts a background Bash start from PostToolUse', () => {
    expect(processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('bshell1'))).toEqual({
      runningShells: 1,
      runningMonitors: 0
    })
  })

  it('ignores foreground Bash and failed background launches', () => {
    const foreground: ParsedClaudeHook = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {},
      tool_response: { stdout: 'ok' }
    }
    const noTaskId: ParsedClaudeHook = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { run_in_background: true },
      tool_response: { stdout: '', stderr: 'spawn failed' }
    }

    expect(processClaudeCliBackgroundWorkHook(SESSION, foreground)).toBeNull()
    expect(processClaudeCliBackgroundWorkHook(SESSION, noTaskId)).toBeNull()
  })

  it('counts a Monitor start but not a failed one', () => {
    const failed: ParsedClaudeHook = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Monitor',
      tool_response: 'InputValidationError: Monitor failed'
    }

    expect(processClaudeCliBackgroundWorkHook(SESSION, monitorStart('bmon1'))).toEqual({
      runningShells: 0,
      runningMonitors: 1
    })
    expect(processClaudeCliBackgroundWorkHook(SESSION, failed)).toBeNull()
  })

  it('retires shells and monitors on TaskStop (which never notifies)', () => {
    processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('bshell1'))
    processClaudeCliBackgroundWorkHook(SESSION, monitorStart('bmon1'))

    const stop: ParsedClaudeHook = {
      hook_event_name: 'PostToolUse',
      tool_name: 'TaskStop',
      tool_input: { task_id: 'bshell1' },
      tool_response: { message: 'Successfully stopped task: bshell1', task_id: 'bshell1' }
    }

    expect(processClaudeCliBackgroundWorkHook(SESSION, stop)).toEqual({
      runningShells: 0,
      runningMonitors: 1
    })
  })

  it('retires a task on a terminal notification for every status value', () => {
    for (const status of ['completed', 'failed', 'killed', 'stopped']) {
      processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('btask'))
      expect(
        processClaudeCliBackgroundWorkHook(SESSION, notificationPrompt([terminalBlock('btask', status)]))
      ).toEqual({ runningShells: 0, runningMonitors: 0 })
    }
  })

  it('keeps a monitor alive through routine (statusless) monitor events', () => {
    processClaudeCliBackgroundWorkHook(SESSION, monitorStart('bmon1'))

    const routineEvent = notificationPrompt([
      '<task-notification>\n<task-id>bmon1</task-id>\n<summary>Monitor event: "sweep"</summary>\n<event>=== DONE: batch 3 ===</event>\n</task-notification>'
    ])

    expect(processClaudeCliBackgroundWorkHook(SESSION, routineEvent)).toBeNull()
    expect(getClaudeCliBackgroundWorkCounts(SESSION)).toEqual({
      runningShells: 0,
      runningMonitors: 1
    })
  })

  it('retires a monitor on stream-end and on the statusless timeout event', () => {
    processClaudeCliBackgroundWorkHook(SESSION, monitorStart('bmon1'))
    processClaudeCliBackgroundWorkHook(SESSION, monitorStart('bmon2'))

    const streamEnded = notificationPrompt([terminalBlock('bmon1', 'completed')])
    const timedOut = notificationPrompt([
      `<task-notification>\n<task-id>bmon2</task-id>\n<summary>Monitor event: "sweep"</summary>\n<event>${MONITOR_TIMEOUT_EVENT}</event>\n</task-notification>`
    ])

    expect(processClaudeCliBackgroundWorkHook(SESSION, streamEnded)).toEqual({
      runningShells: 0,
      runningMonitors: 1
    })
    expect(processClaudeCliBackgroundWorkHook(SESSION, timedOut)).toEqual({
      runningShells: 0,
      runningMonitors: 0
    })
  })

  it('reconciles away tasks missing from a Stop background_tasks snapshot', () => {
    processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('bkeep'))
    processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('bgone'))
    processClaudeCliBackgroundWorkHook(SESSION, monitorStart('bmon1'))

    const stop: ParsedClaudeHook = {
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'bkeep', type: 'shell', status: 'running' },
        { id: 'bmon1', type: 'shell', status: 'running' },
        { id: 'bother-subagent', type: 'subagent', status: 'running' }
      ]
    }

    expect(processClaudeCliBackgroundWorkHook(SESSION, stop)).toEqual({
      runningShells: 1,
      runningMonitors: 1
    })
  })

  it('treats an absent background_tasks key as no snapshot, but an empty array as authoritative', () => {
    processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('bkeep'))

    expect(processClaudeCliBackgroundWorkHook(SESSION, { hook_event_name: 'Stop' })).toBeNull()
    expect(getClaudeCliBackgroundWorkCounts(SESSION)).toEqual({
      runningShells: 1,
      runningMonitors: 0
    })

    expect(
      processClaudeCliBackgroundWorkHook(SESSION, { hook_event_name: 'Stop', background_tasks: [] })
    ).toEqual({ runningShells: 0, runningMonitors: 0 })
  })

  it('clears everything on session boundaries', () => {
    for (const event of ['SessionStart', 'SessionEnd']) {
      processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('bshell'))
      processClaudeCliBackgroundWorkHook(SESSION, monitorStart('bmon'))

      expect(processClaudeCliBackgroundWorkHook(SESSION, { hook_event_name: event })).toEqual({
        runningShells: 0,
        runningMonitors: 0
      })
    }
  })

  it('returns null for a session boundary with nothing tracked', () => {
    expect(processClaudeCliBackgroundWorkHook(SESSION, { hook_event_name: 'SessionStart' })).toBeNull()
  })

  it('tracks sessions independently', () => {
    processClaudeCliBackgroundWorkHook('session-a', backgroundBashStart('ba'))
    processClaudeCliBackgroundWorkHook('session-b', monitorStart('bb'))

    expect(getClaudeCliBackgroundWorkCounts('session-a')).toEqual({
      runningShells: 1,
      runningMonitors: 0
    })
    expect(getClaudeCliBackgroundWorkCounts('session-b')).toEqual({
      runningShells: 0,
      runningMonitors: 1
    })
  })
})

describe('clearClaudeCliBackgroundWork', () => {
  it('reports whether the session had live counts', () => {
    expect(clearClaudeCliBackgroundWork(SESSION)).toBe(false)

    processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('bshell'))
    expect(clearClaudeCliBackgroundWork(SESSION)).toBe(true)
    expect(getClaudeCliBackgroundWorkCounts(SESSION)).toEqual({
      runningShells: 0,
      runningMonitors: 0
    })
  })
})

describe('parseEndedTaskNotificationIds', () => {
  it('extracts only terminal blocks from a batch resume prompt', () => {
    const prompt = [
      terminalBlock('bdone', 'completed'),
      '<task-notification>\n<task-id>bevent</task-id>\n<event>progress line</event>\n</task-notification>',
      `<task-notification>\n<task-id>btimeout</task-id>\n<event>${MONITOR_TIMEOUT_EVENT}</event>\n</task-notification>`
    ].join('\n')

    expect(parseEndedTaskNotificationIds(prompt)).toEqual(['bdone', 'btimeout'])
  })

  it('returns nothing for non-notification prompts', () => {
    expect(parseEndedTaskNotificationIds('please fix the bug')).toEqual([])
    expect(parseEndedTaskNotificationIds(undefined)).toEqual([])
  })
})
