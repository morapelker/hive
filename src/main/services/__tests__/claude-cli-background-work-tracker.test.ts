// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'

import {
  clearAllClaudeCliBackgroundWork,
  clearClaudeCliBackgroundWork,
  getClaudeCliBackgroundWorkCounts,
  getClaudeCliMonitorTaskIds,
  MONITOR_TIMEOUT_EVENT,
  parseEndedTaskNotificationIds,
  processClaudeCliBackgroundWorkHook
} from '../claude-cli-background-work-tracker'
import type { ParsedClaudeHook } from '../claude-hook-server'

const SESSION = 'hive-session-1'

// Fixtures mirror real hook payloads captured from claude v2.1.218 (shells/
// monitors) and v2.1.226 (subagents/workflows, via the claude-playground
// prototype).

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

function subagentStart(agentId: string): ParsedClaudeHook {
  return {
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    agent_type: 'general-purpose'
  }
}

function subagentStop(
  agentId: string,
  backgroundTasks: ParsedClaudeHook['background_tasks'] = []
): ParsedClaudeHook {
  return {
    hook_event_name: 'SubagentStop',
    agent_id: agentId,
    agent_type: 'general-purpose',
    background_tasks: backgroundTasks
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
      runningMonitors: 0,
      runningSubagents: 0
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
      runningMonitors: 1,
      runningSubagents: 0
    })
    expect(processClaudeCliBackgroundWorkHook(SESSION, failed)).toBeNull()
  })

  it('exposes live monitor ids (not shells) for the Stop completion classifier', () => {
    expect(getClaudeCliMonitorTaskIds(SESSION).size).toBe(0)

    processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('bshell1'))
    processClaudeCliBackgroundWorkHook(SESSION, monitorStart('bmon1'))
    expect([...getClaudeCliMonitorTaskIds(SESSION)]).toEqual(['bmon1'])

    const stop: ParsedClaudeHook = {
      hook_event_name: 'PostToolUse',
      tool_name: 'TaskStop',
      tool_input: { task_id: 'bmon1' },
      tool_response: { message: 'Successfully stopped task: bmon1', task_id: 'bmon1' }
    }
    processClaudeCliBackgroundWorkHook(SESSION, stop)
    expect(getClaudeCliMonitorTaskIds(SESSION).size).toBe(0)
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
      runningMonitors: 1,
      runningSubagents: 0
    })
  })

  it('retires a task on a terminal notification for every status value', () => {
    for (const status of ['completed', 'failed', 'killed', 'stopped']) {
      processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('btask'))
      expect(
        processClaudeCliBackgroundWorkHook(SESSION, notificationPrompt([terminalBlock('btask', status)]))
      ).toEqual({ runningShells: 0, runningMonitors: 0, runningSubagents: 0 })
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
      runningMonitors: 1,
      runningSubagents: 0
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
      runningMonitors: 1,
      runningSubagents: 0
    })
    expect(processClaudeCliBackgroundWorkHook(SESSION, timedOut)).toEqual({
      runningShells: 0,
      runningMonitors: 0,
      runningSubagents: 0
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

    // The running subagent in the snapshot is adopted, not ignored.
    expect(processClaudeCliBackgroundWorkHook(SESSION, stop)).toEqual({
      runningShells: 1,
      runningMonitors: 1,
      runningSubagents: 1
    })
  })

  it('treats an absent background_tasks key as no snapshot, but an empty array as authoritative', () => {
    processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('bkeep'))

    expect(processClaudeCliBackgroundWorkHook(SESSION, { hook_event_name: 'Stop' })).toBeNull()
    expect(getClaudeCliBackgroundWorkCounts(SESSION)).toEqual({
      runningShells: 1,
      runningMonitors: 0,
      runningSubagents: 0
    })

    expect(
      processClaudeCliBackgroundWorkHook(SESSION, { hook_event_name: 'Stop', background_tasks: [] })
    ).toEqual({ runningShells: 0, runningMonitors: 0, runningSubagents: 0 })
  })

  it('clears everything on session boundaries', () => {
    for (const event of ['SessionStart', 'SessionEnd']) {
      processClaudeCliBackgroundWorkHook(SESSION, backgroundBashStart('bshell'))
      processClaudeCliBackgroundWorkHook(SESSION, monitorStart('bmon'))

      expect(processClaudeCliBackgroundWorkHook(SESSION, { hook_event_name: event })).toEqual({
        runningShells: 0,
        runningMonitors: 0,
        runningSubagents: 0
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
      runningMonitors: 0,
      runningSubagents: 0
    })
    expect(getClaudeCliBackgroundWorkCounts('session-b')).toEqual({
      runningShells: 0,
      runningMonitors: 1,
      runningSubagents: 0
    })
  })
})

describe('subagent counting', () => {
  it('counts SubagentStart and retires on SubagentStop', () => {
    expect(processClaudeCliBackgroundWorkHook(SESSION, subagentStart('a1'))).toEqual({
      runningShells: 0,
      runningMonitors: 0,
      runningSubagents: 1
    })
    expect(processClaudeCliBackgroundWorkHook(SESSION, subagentStart('a2'))).toEqual({
      runningShells: 0,
      runningMonitors: 0,
      runningSubagents: 2
    })
    expect(processClaudeCliBackgroundWorkHook(SESSION, subagentStop('a1'))).toEqual({
      runningShells: 0,
      runningMonitors: 0,
      runningSubagents: 1
    })
    expect(processClaudeCliBackgroundWorkHook(SESSION, subagentStop('a2'))).toEqual({
      runningShells: 0,
      runningMonitors: 0,
      runningSubagents: 0
    })
  })

  it('ignores a SubagentStart without an agent id', () => {
    expect(
      processClaudeCliBackgroundWorkHook(SESSION, { hook_event_name: 'SubagentStart' })
    ).toBeNull()
  })

  it("never prunes siblings on a SubagentStop's empty snapshot (foreground agents are invisible there)", () => {
    // Two foreground subagents; the first one's SubagentStop carries
    // background_tasks: [] (captured from claude v2.1.226) — the second must
    // survive it.
    processClaudeCliBackgroundWorkHook(SESSION, subagentStart('a1'))
    processClaudeCliBackgroundWorkHook(SESSION, subagentStart('a2'))

    expect(processClaudeCliBackgroundWorkHook(SESSION, subagentStop('a1', []))).toEqual({
      runningShells: 0,
      runningMonitors: 0,
      runningSubagents: 1
    })
  })

  it("retires a background subagent on its own SubagentStop even though it self-lists as running", () => {
    // A background subagent's SubagentStop still lists it as 'running' in the
    // snapshot (its result has not been consumed yet) — the stop edge wins.
    processClaudeCliBackgroundWorkHook(SESSION, subagentStart('a1'))

    expect(
      processClaudeCliBackgroundWorkHook(
        SESSION,
        subagentStop('a1', [{ id: 'a1', type: 'subagent', status: 'running' }])
      )
    ).toEqual({ runningShells: 0, runningMonitors: 0, runningSubagents: 0 })
  })

  it('adopts running background subagents from a snapshot when their start was missed', () => {
    expect(
      processClaudeCliBackgroundWorkHook(SESSION, {
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'a9', type: 'subagent', status: 'running' }]
      })
    ).toEqual({ runningShells: 0, runningMonitors: 0, runningSubagents: 1 })
  })

  it('keeps workflow-spawned agents through a main Stop whose snapshot only lists the workflow', () => {
    // Workflow inner agents never appear in background_tasks — only the parent
    // {type:'workflow'} task does (captured from claude v2.1.226).
    processClaudeCliBackgroundWorkHook(SESSION, subagentStart('wf-agent-1'))

    expect(
      processClaudeCliBackgroundWorkHook(SESSION, {
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'w1', type: 'workflow', status: 'running' }]
      })
    ).toBeNull()
    expect(getClaudeCliBackgroundWorkCounts(SESSION)).toEqual({
      runningShells: 0,
      runningMonitors: 0,
      runningSubagents: 1
    })
  })

  it('prunes stale subagent ids at a main Stop with no workflow running', () => {
    processClaudeCliBackgroundWorkHook(SESSION, subagentStart('leaked'))

    expect(
      processClaudeCliBackgroundWorkHook(SESSION, { hook_event_name: 'Stop', background_tasks: [] })
    ).toEqual({ runningShells: 0, runningMonitors: 0, runningSubagents: 0 })
  })

  it('retires a subagent via a terminal task notification when its SubagentStop was missed', () => {
    processClaudeCliBackgroundWorkHook(SESSION, subagentStart('a1'))

    expect(
      processClaudeCliBackgroundWorkHook(SESSION, notificationPrompt([terminalBlock('a1', 'completed')]))
    ).toEqual({ runningShells: 0, runningMonitors: 0, runningSubagents: 0 })
  })

  it('does not count a running workflow task itself as a subagent', () => {
    expect(
      processClaudeCliBackgroundWorkHook(SESSION, {
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'w1', type: 'workflow', status: 'running' }]
      })
    ).toBeNull()
    expect(getClaudeCliBackgroundWorkCounts(SESSION)).toEqual({
      runningShells: 0,
      runningMonitors: 0,
      runningSubagents: 0
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
      runningMonitors: 0,
      runningSubagents: 0
    })
  })

  it('reports live counts for a session tracking only subagents', () => {
    processClaudeCliBackgroundWorkHook(SESSION, subagentStart('a1'))
    expect(clearClaudeCliBackgroundWork(SESSION)).toBe(true)
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
