import { describe, test, expect, beforeEach } from 'vitest'

/**
 * Session 5: SessionView Idle → Busy Restart — Tests
 *
 * The approach: idle finalizes immediately, but if busy arrives again,
 * the session restarts streaming/working state so the next idle can
 * finalize the new response.
 *
 * Tests verify:
 * 1. session.status idle finalizes immediately
 * 2. session.status busy after idle restarts the streaming state
 * 3. busy resets hasFinalizedCurrentResponse so next idle can finalize again
 * 4. busy restores worktree working/planning status
 * 5. idle → busy → idle sequence: both idles finalize their respective responses
 * 6. session.idle fallback still works as safety net
 * 7. session.idle with childSessionId still updates subtask
 */

// ---------- Simulated controller ----------

/**
 * Extracts the core logic from SessionView's session.status handler
 * so we can test it in isolation without rendering React components.
 */
class SessionStatusController {
  isStreaming = false
  isSending = false
  hasFinalizedCurrentResponse = false
  finalizeCallCount = 0
  worktreeStatus: string | null = null
  sessionMode: 'build' | 'plan' = 'build'

  handleSessionStatus(type: 'busy' | 'idle' | 'retry'): void {
    if (type === 'busy') {
      // Session became active (again) — restart streaming state
      this.isStreaming = true
      this.hasFinalizedCurrentResponse = false
      this.isSending = true
      this.worktreeStatus = this.sessionMode === 'plan' ? 'planning' : 'working'
      return
    }

    if (type === 'idle') {
      // Finalize immediately
      this.isSending = false

      if (!this.hasFinalizedCurrentResponse) {
        this.hasFinalizedCurrentResponse = true
        this.finalizeCallCount++
      }

      this.worktreeStatus = 'cleared'
      return
    }
    // 'retry': no-op
  }

  handleSessionIdle(options?: { childSessionId?: string }): string {
    if (options?.childSessionId) {
      return 'subtask-updated'
    }

    // Fallback finalization (safety net)
    this.isSending = false
    if (!this.hasFinalizedCurrentResponse) {
      this.hasFinalizedCurrentResponse = true
      this.finalizeCallCount++
    }
    return 'finalized'
  }
}

// ---------- Tests ----------

describe('Session 5: SessionView Idle → Busy Restart', () => {
  let controller: SessionStatusController

  beforeEach(() => {
    controller = new SessionStatusController()
    controller.isStreaming = true
    controller.isSending = true
  })

  test('session.status idle finalizes immediately', () => {
    controller.handleSessionStatus('idle')

    expect(controller.finalizeCallCount).toBe(1)
    expect(controller.isSending).toBe(false)
    expect(controller.hasFinalizedCurrentResponse).toBe(true)
    expect(controller.worktreeStatus).toBe('cleared')
  })

  test('session.status busy restarts streaming state', () => {
    // First go idle
    controller.handleSessionStatus('idle')
    expect(controller.finalizeCallCount).toBe(1)
    expect(controller.isSending).toBe(false)

    // Now busy arrives — restart everything
    controller.handleSessionStatus('busy')

    expect(controller.isStreaming).toBe(true)
    expect(controller.isSending).toBe(true)
    expect(controller.hasFinalizedCurrentResponse).toBe(false)
    expect(controller.worktreeStatus).toBe('working')
  })

  test('busy resets hasFinalizedCurrentResponse so next idle can finalize', () => {
    // idle → finalize
    controller.handleSessionStatus('idle')
    expect(controller.finalizeCallCount).toBe(1)

    // busy → restart
    controller.handleSessionStatus('busy')
    expect(controller.hasFinalizedCurrentResponse).toBe(false)

    // idle → finalize again
    controller.handleSessionStatus('idle')
    expect(controller.finalizeCallCount).toBe(2)
  })

  test('busy restores planning status for plan-mode sessions', () => {
    controller.sessionMode = 'plan'

    controller.handleSessionStatus('idle')
    controller.handleSessionStatus('busy')

    expect(controller.worktreeStatus).toBe('planning')
  })

  test('busy restores working status for build-mode sessions', () => {
    controller.sessionMode = 'build'

    controller.handleSessionStatus('idle')
    controller.handleSessionStatus('busy')

    expect(controller.worktreeStatus).toBe('working')
  })

  test('idle → busy → idle sequence: both idles finalize', () => {
    controller.handleSessionStatus('idle')
    expect(controller.finalizeCallCount).toBe(1)

    controller.handleSessionStatus('busy')
    controller.handleSessionStatus('idle')
    expect(controller.finalizeCallCount).toBe(2)
  })

  test('multiple busy-idle cycles each finalize once', () => {
    // 3 full cycles
    for (let i = 0; i < 3; i++) {
      if (i > 0) controller.handleSessionStatus('busy')
      controller.handleSessionStatus('idle')
    }

    expect(controller.finalizeCallCount).toBe(3)
  })

  test('duplicate idle does not double-finalize', () => {
    controller.handleSessionStatus('idle')
    controller.handleSessionStatus('idle') // second idle without busy in between

    expect(controller.finalizeCallCount).toBe(1) // hasFinalizedCurrentResponse guards
  })

  test('session.idle fallback finalizes as safety net', () => {
    controller.hasFinalizedCurrentResponse = false

    const result = controller.handleSessionIdle()

    expect(result).toBe('finalized')
    expect(controller.finalizeCallCount).toBe(1)
    expect(controller.isSending).toBe(false)
  })

  test('session.idle does not double-finalize if already finalized', () => {
    controller.hasFinalizedCurrentResponse = true

    controller.handleSessionIdle()

    expect(controller.finalizeCallCount).toBe(0) // already finalized, skips
  })

  test('session.idle with childSessionId updates subtask, not parent', () => {
    controller.hasFinalizedCurrentResponse = false

    const result = controller.handleSessionIdle({ childSessionId: 'child-1' })

    expect(result).toBe('subtask-updated')
    expect(controller.finalizeCallCount).toBe(0)
  })

  test('retry status is a no-op', () => {
    controller.handleSessionStatus('retry')

    // Nothing changed
    expect(controller.isStreaming).toBe(true) // unchanged from setup
    expect(controller.isSending).toBe(true)
    expect(controller.finalizeCallCount).toBe(0)
  })
})
