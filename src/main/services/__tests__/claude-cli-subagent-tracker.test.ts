// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearAllClaudeCliSubagentTracking,
  clearClaudeCliSubagentTracking,
  hasPendingClaudeCliSubagentWork,
  isClaudeCliCompletionDeferred,
  isTaskNotificationPrompt,
  parseTaskNotificationIds,
  processClaudeCliSubagentHook,
  setClaudeCliDeferredCompletionHandler,
  SUBAGENT_RESUME_TIMEOUT_MS,
  SUBAGENT_WATCHDOG_TIMEOUT_MS,
  type ClaudeCliBackgroundTask,
  type ClaudeCliTrackedHook,
  type SubagentGateResult
} from '../claude-cli-subagent-tracker'
import type { ClaudeCliStatusPayload } from '../claude-hook-server'

const SESSION = 'hive-session-1'

function bgTask(id: string, overrides: Partial<ClaudeCliBackgroundTask> = {}): ClaudeCliBackgroundTask {
  return { id, type: 'subagent', status: 'running', ...overrides }
}

interface HookInput {
  event: string
  agentId?: string
  backgroundTasks?: ClaudeCliBackgroundTask[]
  prompt?: unknown
  lastAssistantMessage?: string
}

function buildHook(input: HookInput): ClaudeCliTrackedHook {
  const hook: ClaudeCliTrackedHook = { hook_event_name: input.event }
  if (input.agentId) hook.agent_id = input.agentId
  if (input.backgroundTasks) hook.background_tasks = input.backgroundTasks
  if (input.prompt !== undefined) hook.prompt = input.prompt
  if (input.lastAssistantMessage) hook.last_assistant_message = input.lastAssistantMessage
  return hook
}

function buildMapped(sessionId: string, status: ClaudeCliStatusPayload['status']): ClaudeCliStatusPayload {
  return { sessionId, status, metadata: { hookEventName: 'Stop' } }
}

function process(
  input: HookInput,
  mapped: ClaudeCliStatusPayload | null = null,
  sessionId = SESSION
): SubagentGateResult {
  return processClaudeCliSubagentHook(sessionId, buildHook(input), mapped)
}

function notificationPrompt(...ids: string[]): string {
  return `<task-notification>${ids.map((id) => `<task-id>${id}</task-id>`).join('')}</task-notification>`
}

afterEach(() => {
  clearAllClaudeCliSubagentTracking()
  setClaudeCliDeferredCompletionHandler(null)
  vi.useRealTimers()
})

describe('pass-through with no background work', () => {
  it('Stop with no background_tasks and nothing pending passes', () => {
    expect(process({ event: 'Stop', backgroundTasks: [] })).toEqual({ kind: 'pass' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)
  })
})

describe('deferring a Stop with running background subagents', () => {
  it('defers and stays deferred across repeated Stops, overwriting the payload handed to the watchdog', () => {
    vi.useFakeTimers()
    const handler = vi.fn().mockReturnValue(true)
    setClaudeCliDeferredCompletionHandler(handler)

    expect(process({ event: 'Stop', backgroundTasks: [bgTask('a')] }, buildMapped(SESSION, 'completed'))).toEqual({
      kind: 'defer_stop'
    })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(true)

    const secondPayload: ClaudeCliStatusPayload = {
      sessionId: SESSION,
      status: 'completed',
      metadata: { hookEventName: 'Stop', reason: 'second' }
    }
    expect(process({ event: 'Stop', backgroundTasks: [bgTask('a')] }, secondPayload)).toEqual({
      kind: 'defer_stop'
    })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(true)

    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(SESSION, secondPayload, undefined)
  })
})

describe('full happy path (real trace replay)', () => {
  it('defers, drains via notification, then completes on a clean Stop', () => {
    expect(
      process({ event: 'Stop', backgroundTasks: [bgTask('a'), bgTask('b')] }, buildMapped(SESSION, 'completed'))
    ).toEqual({ kind: 'defer_stop' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(true)

    expect(
      process({ event: 'SubagentStop', agentId: 'a', backgroundTasks: [bgTask('a')] })
    ).toEqual({ kind: 'pass' })
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(true)

    expect(
      process({ event: 'UserPromptSubmit', prompt: notificationPrompt('a') }, buildMapped(SESSION, 'working'))
    ).toEqual({ kind: 'pass' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(false)

    expect(process({ event: 'Stop', backgroundTasks: [] })).toEqual({ kind: 'pass' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(false)
  })
})

describe('queued-notification gap', () => {
  it('defers a clean Stop when a notification is still pending, then completes once drained', () => {
    // Subagent finishes mid-turn, self-listed, before the main Stop fires.
    expect(
      process({ event: 'SubagentStop', agentId: 'a', backgroundTasks: [bgTask('a')] })
    ).toEqual({ kind: 'pass' })
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(true)

    // The main Stop reports nothing running, but the notification hasn't arrived yet.
    expect(process({ event: 'Stop', backgroundTasks: [] })).toEqual({ kind: 'defer_stop' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(true)

    expect(
      process({ event: 'UserPromptSubmit', prompt: notificationPrompt('a') }, buildMapped(SESSION, 'working'))
    ).toEqual({ kind: 'pass' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)

    expect(process({ event: 'Stop', backgroundTasks: [] })).toEqual({ kind: 'pass' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(false)
  })
})

describe('foreground subagents', () => {
  it('a SubagentStop not self-listed in background_tasks leaves nothing pending', () => {
    expect(
      process({ event: 'SubagentStop', agentId: 'a', backgroundTasks: [] })
    ).toEqual({ kind: 'pass' })
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(false)

    expect(process({ event: 'Stop', backgroundTasks: [] })).toEqual({ kind: 'pass' })
  })
})

describe('isSelfListed requires a running status', () => {
  it('a SubagentStop whose self-entry is already completed does not add a pending notification', () => {
    expect(
      process({
        event: 'SubagentStop',
        agentId: 'a',
        backgroundTasks: [bgTask('a', { status: 'completed' })]
      })
    ).toEqual({ kind: 'pass' })
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(false)

    expect(process({ event: 'Stop', backgroundTasks: [] })).toEqual({ kind: 'pass' })
  })
})

describe('ephemeral internal agents', () => {
  it('a not-self-listed SubagentStop after a passing Stop creates no state and has no effect', () => {
    expect(process({ event: 'Stop', backgroundTasks: [] })).toEqual({ kind: 'pass' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)

    expect(
      process({ event: 'SubagentStop', agentId: 'x', backgroundTasks: [] })
    ).toEqual({ kind: 'pass' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(false)

    expect(process({ event: 'Stop', backgroundTasks: [] })).toEqual({ kind: 'pass' })
  })
})

describe('Stop scoped to a subagent (agent_id present)', () => {
  it('is never a session completion and creates no deferral', () => {
    expect(process({ event: 'Stop', agentId: 'a', backgroundTasks: [] })).toEqual({
      kind: 'subagent_scoped'
    })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(false)
  })

  it('does not clear or complete an already-deferred session, only re-arms its timer', () => {
    vi.useFakeTimers()
    const handler = vi.fn().mockReturnValue(true)
    setClaudeCliDeferredCompletionHandler(handler)

    process({ event: 'Stop', backgroundTasks: [bgTask('a')] })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(true)

    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS - 1)
    expect(process({ event: 'Stop', agentId: 'b', backgroundTasks: [] })).toEqual({
      kind: 'subagent_scoped'
    })
    // Still deferred — a subagent-scoped Stop must not complete or clear it.
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(true)
    expect(handler).not.toHaveBeenCalled()

    // The subagent-scoped Stop re-armed the countdown from scratch.
    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS - 1)
    expect(handler).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('non-notification UserPromptSubmit', () => {
  it('clears the deferral but keeps pendingNotifications', () => {
    process({ event: 'SubagentStop', agentId: 'a', backgroundTasks: [bgTask('a')] })
    process({ event: 'Stop', backgroundTasks: [] })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(true)

    expect(process({ event: 'UserPromptSubmit', prompt: 'please continue' })).toEqual({ kind: 'pass' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(true)

    expect(process({ event: 'Stop', backgroundTasks: [] })).toEqual({ kind: 'defer_stop' })
  })
})

describe('SessionStart / SessionEnd', () => {
  it.each(['SessionStart', 'SessionEnd'])('%s clears all tracking and disarms timers', (event) => {
    vi.useFakeTimers()
    const handler = vi.fn().mockReturnValue(true)
    setClaudeCliDeferredCompletionHandler(handler)

    process({ event: 'Stop', backgroundTasks: [bgTask('a')] })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(true)

    expect(process({ event })).toEqual({ kind: 'pass' })
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)
    expect(hasPendingClaudeCliSubagentWork(SESSION)).toBe(false)

    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS + SUBAGENT_RESUME_TIMEOUT_MS + 1000)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('timer duration by state', () => {
  it('running-nonempty deferral fires at the watchdog duration, not before', () => {
    vi.useFakeTimers()
    const handler = vi.fn().mockReturnValue(true)
    setClaudeCliDeferredCompletionHandler(handler)

    process({ event: 'Stop', backgroundTasks: [bgTask('a')] })

    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS - 1)
    expect(handler).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('pending-only deferral (running empty) fires at the shorter resume duration', () => {
    vi.useFakeTimers()
    const handler = vi.fn().mockReturnValue(true)
    setClaudeCliDeferredCompletionHandler(handler)

    process({ event: 'SubagentStop', agentId: 'a', backgroundTasks: [bgTask('a')] })
    process({ event: 'Stop', backgroundTasks: [] })

    vi.advanceTimersByTime(SUBAGENT_RESUME_TIMEOUT_MS - 1)
    expect(handler).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('draining the last running id via self-listed SubagentStop re-arms to the short duration', () => {
    vi.useFakeTimers()
    const handler = vi.fn().mockReturnValue(true)
    setClaudeCliDeferredCompletionHandler(handler)

    process({ event: 'Stop', backgroundTasks: [bgTask('a')] })
    // Still within the long watchdog window.
    vi.advanceTimersByTime(SUBAGENT_RESUME_TIMEOUT_MS + 1000)
    expect(handler).not.toHaveBeenCalled()

    // 'a' drains from running (moves to pendingNotifications) -> should now be armed short.
    process({ event: 'SubagentStop', agentId: 'a', backgroundTasks: [bgTask('a')] })

    vi.advanceTimersByTime(SUBAGENT_RESUME_TIMEOUT_MS - 1)
    expect(handler).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('re-arm on activity', () => {
  it('any unrelated hook while deferred resets the countdown', () => {
    vi.useFakeTimers()
    const handler = vi.fn().mockReturnValue(true)
    setClaudeCliDeferredCompletionHandler(handler)

    process({ event: 'Stop', backgroundTasks: [bgTask('a')] })

    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS - 1)
    expect(handler).not.toHaveBeenCalled()

    process({ event: 'PostToolUse' })

    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS - 1)
    expect(handler).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('deferred completion handler', () => {
  it('is called with the original payload and lastAssistantMessage; true clears state', () => {
    vi.useFakeTimers()
    const originalPayload = buildMapped(SESSION, 'completed')
    const handler = vi.fn().mockReturnValue(true)
    setClaudeCliDeferredCompletionHandler(handler)

    process(
      { event: 'Stop', backgroundTasks: [bgTask('a')], lastAssistantMessage: 'All done.' },
      originalPayload
    )

    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(SESSION, originalPayload, 'All done.')
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)
  })

  it('false keeps the deferral and fires again after the watchdog duration', () => {
    vi.useFakeTimers()
    const handler = vi.fn().mockReturnValue(false)
    setClaudeCliDeferredCompletionHandler(handler)

    process({ event: 'Stop', backgroundTasks: [bgTask('a')] })

    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(true)

    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS - 1)
    expect(handler).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(handler).toHaveBeenCalledTimes(2)
  })
})

describe('manual clears', () => {
  it('clearClaudeCliSubagentTracking cancels the timer so the handler is never called', () => {
    vi.useFakeTimers()
    const handler = vi.fn().mockReturnValue(true)
    setClaudeCliDeferredCompletionHandler(handler)

    process({ event: 'Stop', backgroundTasks: [bgTask('a')] })
    clearClaudeCliSubagentTracking(SESSION)

    vi.advanceTimersByTime(SUBAGENT_WATCHDOG_TIMEOUT_MS + 1000)
    expect(handler).not.toHaveBeenCalled()
    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(false)
  })
})

describe('session isolation', () => {
  it('deferring one session does not affect another', () => {
    const OTHER = 'other-session'
    expect(process({ event: 'Stop', backgroundTasks: [bgTask('a')] }, null, SESSION)).toEqual({
      kind: 'defer_stop'
    })
    expect(process({ event: 'Stop', backgroundTasks: [] }, null, OTHER)).toEqual({ kind: 'pass' })

    expect(isClaudeCliCompletionDeferred(SESSION)).toBe(true)
    expect(isClaudeCliCompletionDeferred(OTHER)).toBe(false)
  })
})

describe('parseTaskNotificationIds', () => {
  it('returns [] for non-string prompts', () => {
    expect(parseTaskNotificationIds(undefined)).toEqual([])
    expect(parseTaskNotificationIds(null)).toEqual([])
    expect(parseTaskNotificationIds({ text: 'hi' })).toEqual([])
  })

  it('returns [] for an ordinary user prompt', () => {
    expect(parseTaskNotificationIds('please fix the bug')).toEqual([])
  })

  it('returns the id for a single notification block', () => {
    expect(parseTaskNotificationIds(notificationPrompt('abc123'))).toEqual(['abc123'])
  })

  it('returns all ids for two concatenated notification blocks', () => {
    expect(parseTaskNotificationIds(notificationPrompt('abc123', 'def456'))).toEqual(['abc123', 'def456'])
  })

  it('tolerates leading whitespace before the tag', () => {
    expect(parseTaskNotificationIds(`   \n${notificationPrompt('abc123')}`)).toEqual(['abc123'])
  })
})

describe('isTaskNotificationPrompt', () => {
  it('returns false for non-string prompts', () => {
    expect(isTaskNotificationPrompt(undefined)).toBe(false)
    expect(isTaskNotificationPrompt(null)).toBe(false)
    expect(isTaskNotificationPrompt({ text: 'hi' })).toBe(false)
  })

  it('returns false for an ordinary user prompt', () => {
    expect(isTaskNotificationPrompt('please fix the bug')).toBe(false)
  })

  it('returns true for a marker-prefixed prompt even with zero parseable task-id blocks', () => {
    expect(isTaskNotificationPrompt('<task-notification></task-notification>')).toBe(true)
    expect(parseTaskNotificationIds('<task-notification></task-notification>')).toEqual([])
  })

  it('tolerates leading whitespace before the tag', () => {
    expect(isTaskNotificationPrompt(`   \n${notificationPrompt('abc123')}`)).toBe(true)
  })
})
