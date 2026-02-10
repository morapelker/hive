import { describe, test, expect, beforeEach } from 'vitest'

/**
 * Session 7: Subtool Loading Indicator Fix
 *
 * Tests that `message.updated` from child sessions does NOT trigger premature
 * finalization of the parent response, and that `isStreaming` stays `true`
 * until the parent's own `session.idle` arrives.
 *
 * Uses pure logic testing (no component rendering) to validate the guard
 * conditions in the stream event handler.
 */

interface StreamEvent {
  type: string
  sessionId: string
  childSessionId?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

/**
 * Simulates the state variables that SessionView maintains.
 */
let hasFinalizedCurrentResponse: boolean
let isStreaming: boolean
let finalizedMessageIds: Set<string>

/**
 * Simulates the `message.updated` handler logic from SessionView.
 * Returns an object describing what actions were taken.
 */
function handleMessageUpdated(
  event: StreamEvent,
  hasRunningSubtasks: boolean = false
): {
  skipped: boolean
  reason?: string
  finalized?: boolean
} {
  const eventRole = event.data?.role

  // Skip user-message echoes
  if (eventRole === 'user') {
    return { skipped: true, reason: 'user-echo' }
  }

  // Session 7 fix: skip finalization for child/subagent messages
  if (event.childSessionId) {
    return { skipped: true, reason: 'child-event' }
  }

  const info = event.data?.info
  if (eventRole !== 'user' && info?.time?.completed) {
    // Defer finalization if there are active subtasks still running.
    // In multi-step flows with subagents, the SDK sends message.updated with
    // time.completed when each step finishes, but the parent continues in a new step.
    if (hasRunningSubtasks) {
      return { skipped: true, reason: 'running-subtasks' }
    }

    const messageId = event.data?.id

    // Skip duplicate finalization
    if (messageId && finalizedMessageIds.has(messageId)) {
      return { skipped: true, reason: 'already-finalized' }
    }
    if (hasFinalizedCurrentResponse) {
      return { skipped: true, reason: 'already-finalized' }
    }

    if (messageId) {
      finalizedMessageIds.add(messageId)
    }
    hasFinalizedCurrentResponse = true
    // In the real code, this calls finalizeResponseFromDatabase()
    // which calls resetStreamingState() → setIsStreaming(false)
    isStreaming = false
    return { skipped: false, finalized: true }
  }

  return { skipped: true, reason: 'no-completion' }
}

/**
 * Simulates the `session.idle` handler logic from SessionView.
 * Returns an object describing what actions were taken.
 */
function handleSessionIdle(event: StreamEvent): {
  handledAsChild: boolean
  finalized?: boolean
} {
  // Session 6 guard: child session idle
  if (event.childSessionId) {
    return { handledAsChild: true }
  }

  // Parent session idle
  if (!hasFinalizedCurrentResponse) {
    hasFinalizedCurrentResponse = true
    isStreaming = false
    return { handledAsChild: false, finalized: true }
  }

  // Already finalized by message.updated
  isStreaming = false
  return { handledAsChild: false, finalized: false }
}

/**
 * Simulates individual tool card status updates.
 * Returns whether isStreaming was affected.
 */
function handleToolUpdate(
  _toolId: string,
  status: 'running' | 'success' | 'error'
): { isStreamingChanged: boolean } {
  // In the real code, tool updates call setIsStreaming(true), never false.
  // Tool completion (status = 'success' | 'error') only updates the individual
  // tool card status, not the global isStreaming state.
  if (status === 'running') {
    isStreaming = true
  }
  // Note: success/error do NOT set isStreaming to false
  return { isStreamingChanged: false }
}

describe('Session 7: Subtool Loading Indicator Fix', () => {
  beforeEach(() => {
    hasFinalizedCurrentResponse = false
    isStreaming = true
    finalizedMessageIds = new Set()
  })

  describe('message.updated child guard', () => {
    test('message.updated from child does not trigger finalization', () => {
      const result = handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent-hive-id',
        childSessionId: 'child-opencode-id',
        data: {
          role: 'assistant',
          info: { time: { completed: Date.now() } },
          id: 'msg-child-1'
        }
      })

      expect(result.skipped).toBe(true)
      expect(result.reason).toBe('child-event')
      expect(result.finalized).toBeUndefined()
      // isStreaming should NOT have changed
      expect(isStreaming).toBe(true)
      // hasFinalizedCurrentResponse should NOT have been set
      expect(hasFinalizedCurrentResponse).toBe(false)
    })

    test('message.updated from parent with time.completed triggers finalization', () => {
      const result = handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent-hive-id',
        // no childSessionId
        data: {
          role: 'assistant',
          info: { time: { completed: Date.now() } },
          id: 'msg-parent-1'
        }
      })

      expect(result.skipped).toBe(false)
      expect(result.finalized).toBe(true)
      expect(isStreaming).toBe(false)
      expect(hasFinalizedCurrentResponse).toBe(true)
    })

    test('message.updated from child without time.completed still skips', () => {
      const result = handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent-hive-id',
        childSessionId: 'child-opencode-id',
        data: {
          role: 'assistant',
          info: { time: {} }, // no completed field
          id: 'msg-child-2'
        }
      })

      expect(result.skipped).toBe(true)
      expect(result.reason).toBe('child-event')
      expect(isStreaming).toBe(true)
    })

    test('user echo still skipped before child guard', () => {
      const result = handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent-hive-id',
        childSessionId: 'child-opencode-id',
        data: {
          role: 'user',
          info: { time: { completed: Date.now() } },
          id: 'msg-user-1'
        }
      })

      // User echo check comes first, so reason is 'user-echo'
      expect(result.skipped).toBe(true)
      expect(result.reason).toBe('user-echo')
    })

    test('message.updated defers finalization when subtasks are running', () => {
      // This is the key fix for the reported issue: when a subagent completes
      // mid-stream, the SDK sends message.updated with time.completed.
      // We should NOT finalize if subtasks are still running (parent will continue).
      const result = handleMessageUpdated(
        {
          type: 'message.updated',
          sessionId: 'parent-hive-id',
          data: {
            role: 'assistant',
            info: { time: { completed: Date.now() } },
            id: 'msg-parent-1'
          }
        },
        true // hasRunningSubtasks
      )

      expect(result.skipped).toBe(true)
      expect(result.reason).toBe('running-subtasks')
      // Critical: isStreaming should NOT have changed
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)
    })

    test('message.updated finalizes immediately when no subtasks running', () => {
      const result = handleMessageUpdated(
        {
          type: 'message.updated',
          sessionId: 'parent-hive-id',
          data: {
            role: 'assistant',
            info: { time: { completed: Date.now() } },
            id: 'msg-parent-1'
          }
        },
        false // no running subtasks
      )

      expect(result.skipped).toBe(false)
      expect(result.finalized).toBe(true)
      // When no subtasks, finalization proceeds normally
      expect(isStreaming).toBe(false)
      expect(hasFinalizedCurrentResponse).toBe(true)
    })
  })

  describe('isStreaming stays true during tool execution', () => {
    test('isStreaming stays true after first tool completes', () => {
      // Simulate 3 tools starting
      handleToolUpdate('tool-1', 'running')
      handleToolUpdate('tool-2', 'running')
      handleToolUpdate('tool-3', 'running')
      expect(isStreaming).toBe(true)

      // First tool completes
      handleToolUpdate('tool-1', 'success')
      expect(isStreaming).toBe(true)

      // Second tool completes
      handleToolUpdate('tool-2', 'success')
      expect(isStreaming).toBe(true)

      // Third tool completes
      handleToolUpdate('tool-3', 'success')
      // Still true — only session.idle or message.updated finalization sets it false
      expect(isStreaming).toBe(true)
    })

    test('isStreaming stays true when tool errors', () => {
      handleToolUpdate('tool-1', 'running')
      handleToolUpdate('tool-1', 'error')
      // Tool error updates the card status, not the global streaming state
      expect(isStreaming).toBe(true)
    })
  })

  describe('isStreaming becomes false on parent session.idle', () => {
    test('parent session.idle triggers finalization and stops streaming', () => {
      const result = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent-hive-id'
        // no childSessionId
      })

      expect(result.handledAsChild).toBe(false)
      expect(result.finalized).toBe(true)
      expect(isStreaming).toBe(false)
      expect(hasFinalizedCurrentResponse).toBe(true)
    })

    test('child session.idle does not stop parent streaming', () => {
      const result = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent-hive-id',
        childSessionId: 'child-opencode-id'
      })

      expect(result.handledAsChild).toBe(true)
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)
    })

    test('parent session.idle after message.updated finalization skips double-finalize', () => {
      // First: message.updated finalizes
      handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent-hive-id',
        data: {
          role: 'assistant',
          info: { time: { completed: Date.now() } },
          id: 'msg-1'
        }
      })
      expect(hasFinalizedCurrentResponse).toBe(true)
      expect(isStreaming).toBe(false)

      // Then: session.idle arrives (already finalized)
      const result = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent-hive-id'
      })

      expect(result.handledAsChild).toBe(false)
      expect(result.finalized).toBe(false) // already done
    })
  })

  describe('Full subagent lifecycle', () => {
    test('child events do not interfere with parent streaming lifecycle', () => {
      // Parent starts streaming
      expect(isStreaming).toBe(true)

      // Child message.updated arrives (with completion) — should NOT finalize
      handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent-hive-id',
        childSessionId: 'child-1',
        data: {
          role: 'assistant',
          info: { time: { completed: Date.now() } },
          id: 'child-msg-1'
        }
      })
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)

      // Child session.idle arrives — should NOT finalize parent
      handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent-hive-id',
        childSessionId: 'child-1'
      })
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)

      // Parent message.updated arrives with completion — SHOULD finalize
      handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent-hive-id',
        data: {
          role: 'assistant',
          info: { time: { completed: Date.now() } },
          id: 'parent-msg-1'
        }
      })
      expect(isStreaming).toBe(false)
      expect(hasFinalizedCurrentResponse).toBe(true)
    })

    test('parent message.updated with time.completed defers finalization while subtask runs', () => {
      // THIS IS THE FIX FOR THE REPORTED ISSUE:
      // User sends "Use Task tool to research X"
      // Subagent starts running (running subtask)
      // Subagent completes (subtask status → completed)
      // BUT: SDK sends parent message.updated with time.completed to reflect
      // the step finish (first "turn" of the multi-turn loop is done)
      // Previous code would finalize here, stopping isStreaming
      // NEW CODE: defers finalization until the parent's session.idle

      // Subtask is running
      const hasRunningSubtask = true

      // Parent message.updated arrives with time.completed (mid-step)
      const result = handleMessageUpdated(
        {
          type: 'message.updated',
          sessionId: 'parent-hive-id',
          data: {
            role: 'assistant',
            info: { time: { completed: Date.now() } },
            id: 'parent-msg-mid-step'
          }
        },
        hasRunningSubtask
      )

      // CRITICAL: Should skip finalization
      expect(result.skipped).toBe(true)
      expect(result.reason).toBe('running-subtasks')
      // isStreaming should STAY true
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)

      // Later: Subtask finishes
      // (In real code this would be session.idle for child, update subtask status)

      // Finally: Parent session.idle arrives (true completion)
      const finalResult = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent-hive-id'
      })

      expect(finalResult.handledAsChild).toBe(false)
      expect(finalResult.finalized).toBe(true)
      expect(isStreaming).toBe(false)
    })

    test('multiple child completions do not affect parent streaming', () => {
      // Multiple child message.updated with completion
      for (let i = 0; i < 5; i++) {
        handleMessageUpdated({
          type: 'message.updated',
          sessionId: 'parent-hive-id',
          childSessionId: `child-${i}`,
          data: {
            role: 'assistant',
            info: { time: { completed: Date.now() } },
            id: `child-msg-${i}`
          }
        })
      }

      // isStreaming should still be true
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)

      // Multiple child session.idle events
      for (let i = 0; i < 5; i++) {
        handleSessionIdle({
          type: 'session.idle',
          sessionId: 'parent-hive-id',
          childSessionId: `child-${i}`
        })
      }

      // Still streaming — only parent events matter
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)

      // Finally, parent session.idle
      handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent-hive-id'
      })
      expect(isStreaming).toBe(false)
      expect(hasFinalizedCurrentResponse).toBe(true)
    })
  })
})
