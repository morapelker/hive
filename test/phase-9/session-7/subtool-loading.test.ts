import { describe, test, expect, beforeEach } from 'vitest'

/**
 * Session 7: Streaming Lifecycle via session.status
 *
 * Tests that isStreaming is driven by session.status events (busy/idle),
 * NOT by session.idle or message.updated finalization. This ensures the
 * streaming indicator stays active throughout multi-turn subagent flows.
 */

interface StreamEvent {
  type: string
  sessionId: string
  childSessionId?: string
  statusPayload?: { type: 'idle' | 'busy' | 'retry' }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

let hasFinalizedCurrentResponse: boolean
let isStreaming: boolean

/**
 * Simulates the session.status handler from SessionView.
 */
function handleSessionStatus(event: StreamEvent): {
  handled: boolean
  action?: string
} {
  const status = event.statusPayload || event.data?.status
  if (!status) return { handled: false }

  // Skip child session status -- only parent status drives isStreaming
  if (event.childSessionId) return { handled: true, action: 'skip-child' }

  if (status.type === 'busy') {
    isStreaming = true
    return { handled: true, action: 'set-busy' }
  } else if (status.type === 'idle') {
    if (!hasFinalizedCurrentResponse) {
      hasFinalizedCurrentResponse = true
      isStreaming = false
      return { handled: true, action: 'finalize' }
    }
    isStreaming = false
    return { handled: true, action: 'already-finalized' }
  } else if (status.type === 'retry') {
    // Keep streaming active during retries
    return { handled: true, action: 'retry' }
  }

  return { handled: false }
}

/**
 * Simulates the session.idle handler (fallback only).
 */
function handleSessionIdle(event: StreamEvent): {
  handledAsChild: boolean
  finalized?: boolean
} {
  if (event.childSessionId) {
    return { handledAsChild: true }
  }

  if (!hasFinalizedCurrentResponse) {
    hasFinalizedCurrentResponse = true
    isStreaming = false
    return { handledAsChild: false, finalized: true }
  }
  return { handledAsChild: false, finalized: false }
}

/**
 * Simulates the message.updated handler (token extraction only, no finalization).
 */
function handleMessageUpdated(event: StreamEvent): {
  action: string
  tokensCaptured?: boolean
} {
  if (event.data?.role === 'user') return { action: 'skip-user-echo' }
  if (event.childSessionId) return { action: 'skip-child' }

  const info = event.data?.info
  if (info?.time?.completed && info?.tokens) {
    return { action: 'extract-tokens', tokensCaptured: true }
  }

  return { action: 'no-op' }
}

describe('Session 7: Streaming Lifecycle via session.status', () => {
  beforeEach(() => {
    hasFinalizedCurrentResponse = false
    isStreaming = false
  })

  describe('session.status drives isStreaming', () => {
    test('session.status busy sets isStreaming to true', () => {
      const result = handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'busy' }
      })

      expect(result.action).toBe('set-busy')
      expect(isStreaming).toBe(true)
    })

    test('session.status idle sets isStreaming to false and finalizes', () => {
      isStreaming = true

      const result = handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })

      expect(result.action).toBe('finalize')
      expect(isStreaming).toBe(false)
      expect(hasFinalizedCurrentResponse).toBe(true)
    })

    test('session.status retry keeps isStreaming true', () => {
      isStreaming = true

      const result = handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'retry' }
      })

      expect(result.action).toBe('retry')
      expect(isStreaming).toBe(true)
    })

    test('child session.status is ignored', () => {
      isStreaming = true

      const result = handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        childSessionId: 'child-1',
        statusPayload: { type: 'idle' }
      })

      expect(result.action).toBe('skip-child')
      expect(isStreaming).toBe(true)
    })

    test('duplicate session.status idle does not double-finalize', () => {
      isStreaming = true

      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })

      const result = handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })

      expect(result.action).toBe('already-finalized')
    })
  })

  describe('message.updated no longer finalizes', () => {
    test('message.updated with time.completed extracts tokens only', () => {
      isStreaming = true

      const result = handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent',
        data: {
          role: 'assistant',
          info: {
            time: { completed: Date.now() },
            tokens: { input: 100, output: 50, reasoning: 0 }
          },
          id: 'msg-1'
        }
      })

      expect(result.action).toBe('extract-tokens')
      expect(result.tokensCaptured).toBe(true)
      // CRITICAL: isStreaming unchanged, no finalization
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)
    })

    test('child message.updated is still skipped', () => {
      const result = handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: {
          role: 'assistant',
          info: { time: { completed: Date.now() } }
        }
      })

      expect(result.action).toBe('skip-child')
    })

    test('user message.updated echo is skipped', () => {
      const result = handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent',
        data: { role: 'user' }
      })

      expect(result.action).toBe('skip-user-echo')
    })
  })

  describe('session.idle is fallback only', () => {
    test('session.idle finalizes if session.status did not', () => {
      isStreaming = true

      const result = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent'
      })

      expect(result.finalized).toBe(true)
      expect(isStreaming).toBe(false)
    })

    test('session.idle skips if session.status already finalized', () => {
      isStreaming = true

      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })
      expect(hasFinalizedCurrentResponse).toBe(true)

      const result = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent'
      })

      expect(result.finalized).toBe(false)
    })

    test('child session.idle still handled as child', () => {
      const result = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent',
        childSessionId: 'child-1'
      })

      expect(result.handledAsChild).toBe(true)
    })
  })

  describe('Full multi-turn subagent lifecycle', () => {
    test('isStreaming stays true throughout Task tool execution', () => {
      // 1. session.status busy -> parent starts
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'busy' }
      })
      expect(isStreaming).toBe(true)

      // 2. message.updated with time.completed (turn 1 tool dispatch)
      //    Old code: would finalize. New code: token extraction only.
      handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent',
        data: {
          role: 'assistant',
          info: {
            time: { completed: Date.now() },
            tokens: { input: 500, output: 100 }
          },
          id: 'msg-turn1'
        }
      })
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)

      // 3. Child session runs and completes
      handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent',
        childSessionId: 'child-1'
      })
      expect(isStreaming).toBe(true)

      // 4. Turn 2: response text streams (session.status stays busy)
      //    message.part.updated events would set isStreaming=true in real code

      // 5. Turn 2 message.updated (has tokens)
      handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent',
        data: {
          role: 'assistant',
          info: {
            time: { completed: Date.now() },
            tokens: { input: 1000, output: 500 }
          },
          id: 'msg-turn2'
        }
      })
      expect(isStreaming).toBe(true) // Still no finalization

      // 6. session.status idle -> TRUE completion
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })
      expect(isStreaming).toBe(false)
      expect(hasFinalizedCurrentResponse).toBe(true)
    })

    test('multiple children do not affect parent streaming', () => {
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'busy' }
      })

      for (let i = 0; i < 5; i++) {
        handleSessionIdle({
          type: 'session.idle',
          sessionId: 'parent',
          childSessionId: `child-${i}`
        })
        handleSessionStatus({
          type: 'session.status',
          sessionId: 'parent',
          childSessionId: `child-${i}`,
          statusPayload: { type: 'idle' }
        })
      }

      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)

      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })
      expect(isStreaming).toBe(false)
    })

    test('retry during subagent flow keeps streaming', () => {
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'busy' }
      })

      // Rate limited -> retry
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'retry' }
      })
      expect(isStreaming).toBe(true)

      // Retry succeeds -> busy again
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'busy' }
      })
      expect(isStreaming).toBe(true)

      // Eventually done
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })
      expect(isStreaming).toBe(false)
    })
  })
})
