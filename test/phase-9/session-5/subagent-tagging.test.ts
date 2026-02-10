import { describe, test, expect, vi, beforeEach } from 'vitest'
import type { StreamEvent } from '../../../src/main/services/opencode-service'

/**
 * Session 5: Subagent Event Tagging
 *
 * Tests the logic for detecting child/subagent events, guarding notifications,
 * tagging forwarded events with childSessionId, and skipping persistence for child events.
 *
 * Since handleEvent is a private method on OpenCodeService, we test the extracted logic
 * patterns in isolation.
 */

describe('Session 5: Subagent Event Tagging', () => {
  // Helper: simulate the child detection logic from handleEvent
  function detectChildEvent(
    directHiveId: string | undefined,
    resolvedHiveId: string | undefined
  ): { hiveSessionId: string | undefined; isChildEvent: boolean } {
    let hiveSessionId = directHiveId
    if (!hiveSessionId && resolvedHiveId) {
      hiveSessionId = resolvedHiveId
    }
    const isChildEvent = !directHiveId && !!hiveSessionId
    return { hiveSessionId, isChildEvent }
  }

  describe('Child event detection', () => {
    test('child event detected when getMappedHiveSessionId returns null but resolveParentSession succeeds', () => {
      // getMappedHiveSessionId returns undefined for the child session ID
      // but resolveParentSession resolved through the parent to get a hiveSessionId
      const { hiveSessionId, isChildEvent } = detectChildEvent(undefined, 'hive-session-1')
      expect(isChildEvent).toBe(true)
      expect(hiveSessionId).toBe('hive-session-1')
    })

    test('parent event detected when direct mapping exists', () => {
      // getMappedHiveSessionId returns hive ID directly
      const { hiveSessionId, isChildEvent } = detectChildEvent('hive-session-1', undefined)
      expect(isChildEvent).toBe(false)
      expect(hiveSessionId).toBe('hive-session-1')
    })

    test('no hive session found when both return undefined', () => {
      const { hiveSessionId, isChildEvent } = detectChildEvent(undefined, undefined)
      expect(hiveSessionId).toBeUndefined()
      expect(isChildEvent).toBe(false)
    })

    test('parent event when direct mapping exists even if resolve would also succeed', () => {
      // Direct mapping takes priority — isChildEvent should be false
      const { hiveSessionId, isChildEvent } = detectChildEvent('hive-session-1', 'hive-session-1')
      expect(isChildEvent).toBe(false)
      expect(hiveSessionId).toBe('hive-session-1')
    })
  })

  describe('Notification guard for session.idle', () => {
    test('notification only fires for parent session.idle', () => {
      const maybeNotifySessionComplete = vi.fn()

      // Parent session.idle
      const { isChildEvent: isParent } = detectChildEvent('hive-1', undefined)
      if (!isParent) {
        maybeNotifySessionComplete('hive-1')
      }
      expect(maybeNotifySessionComplete).toHaveBeenCalledWith('hive-1')
      expect(maybeNotifySessionComplete).toHaveBeenCalledTimes(1)
    })

    test('notification does NOT fire for child session.idle', () => {
      const maybeNotifySessionComplete = vi.fn()

      // Child session.idle
      const { isChildEvent } = detectChildEvent(undefined, 'hive-1')
      if (!isChildEvent) {
        maybeNotifySessionComplete('hive-1')
      }
      expect(maybeNotifySessionComplete).not.toHaveBeenCalled()
    })
  })

  describe('StreamEvent tagging with childSessionId', () => {
    test('child events tagged with childSessionId', () => {
      const sessionId = 'child-opencode-session'
      const hiveSessionId = 'hive-session-1'
      const isChildEvent = true

      const streamEvent: StreamEvent = {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: { part: { type: 'text', text: 'hello' } },
        ...(isChildEvent ? { childSessionId: sessionId } : {})
      }

      expect(streamEvent.childSessionId).toBe('child-opencode-session')
      expect(streamEvent.sessionId).toBe('hive-session-1')
    })

    test('parent events do not have childSessionId', () => {
      const sessionId = 'parent-opencode-session'
      const hiveSessionId = 'hive-session-1'
      const isChildEvent = false

      const streamEvent: StreamEvent = {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: { part: { type: 'text', text: 'hello' } },
        ...(isChildEvent ? { childSessionId: sessionId } : {})
      }

      expect(streamEvent.childSessionId).toBeUndefined()
      expect(streamEvent.sessionId).toBe('hive-session-1')
    })
  })

  describe('Persistence guard for child events', () => {
    test('parent events are persisted', () => {
      const persistStreamEvent = vi.fn()
      const isChildEvent = false
      const hiveSessionId = 'hive-1'
      const eventType = 'message.part.updated'
      const data = { part: { type: 'text' } }

      if (!isChildEvent) {
        persistStreamEvent(hiveSessionId, eventType, data)
      }

      expect(persistStreamEvent).toHaveBeenCalledWith(hiveSessionId, eventType, data)
    })

    test('child events are NOT persisted as top-level messages', () => {
      const persistStreamEvent = vi.fn()
      const isChildEvent = true
      const hiveSessionId = 'hive-1'
      const eventType = 'message.part.updated'
      const data = { part: { type: 'text' } }

      if (!isChildEvent) {
        persistStreamEvent(hiveSessionId, eventType, data)
      }

      expect(persistStreamEvent).not.toHaveBeenCalled()
    })
  })

  describe('StreamEvent type', () => {
    test('StreamEvent interface supports optional childSessionId', () => {
      // Verify the type allows childSessionId to be omitted
      const parentEvent: StreamEvent = {
        type: 'session.idle',
        sessionId: 'hive-1',
        data: {}
      }
      expect(parentEvent.childSessionId).toBeUndefined()

      // Verify the type allows childSessionId to be set
      const childEvent: StreamEvent = {
        type: 'session.idle',
        sessionId: 'hive-1',
        data: {},
        childSessionId: 'child-1'
      }
      expect(childEvent.childSessionId).toBe('child-1')
    })
  })

  describe('End-to-end child event flow', () => {
    let sendToRenderer: ReturnType<typeof vi.fn>
    let persistStreamEvent: ReturnType<typeof vi.fn>
    let maybeNotifySessionComplete: ReturnType<typeof vi.fn>

    beforeEach(() => {
      sendToRenderer = vi.fn()
      persistStreamEvent = vi.fn()
      maybeNotifySessionComplete = vi.fn()
    })

    function simulateHandleEvent(params: {
      directHiveId: string | undefined
      resolvedHiveId: string | undefined
      sessionId: string
      eventType: string
      eventData: unknown
    }) {
      const { directHiveId, resolvedHiveId, sessionId, eventType, eventData } = params

      // Detection logic from handleEvent
      let hiveSessionId = directHiveId
      if (!hiveSessionId && resolvedHiveId) {
        hiveSessionId = resolvedHiveId
      }
      if (!hiveSessionId) return undefined

      const isChildEvent = !directHiveId && !!hiveSessionId

      // Notification guard
      if (eventType === 'session.idle') {
        if (!isChildEvent) {
          maybeNotifySessionComplete(hiveSessionId)
        }
      }

      // Persistence guard
      if (!isChildEvent) {
        persistStreamEvent(hiveSessionId, eventType, eventData)
      }

      // Build StreamEvent
      const streamEvent: StreamEvent = {
        type: eventType,
        sessionId: hiveSessionId,
        data: eventData,
        ...(isChildEvent ? { childSessionId: sessionId } : {})
      }

      sendToRenderer('opencode:stream', streamEvent)
      return streamEvent
    }

    test('parent message.part.updated: persisted, sent without childSessionId', () => {
      const result = simulateHandleEvent({
        directHiveId: 'hive-1',
        resolvedHiveId: undefined,
        sessionId: 'oc-parent',
        eventType: 'message.part.updated',
        eventData: { part: { type: 'text', text: 'hello' } }
      })

      expect(result).toBeDefined()
      expect(result!.childSessionId).toBeUndefined()
      expect(persistStreamEvent).toHaveBeenCalledTimes(1)
      expect(sendToRenderer).toHaveBeenCalledTimes(1)
      expect(maybeNotifySessionComplete).not.toHaveBeenCalled()
    })

    test('child message.part.updated: NOT persisted, sent WITH childSessionId', () => {
      const result = simulateHandleEvent({
        directHiveId: undefined,
        resolvedHiveId: 'hive-1',
        sessionId: 'oc-child',
        eventType: 'message.part.updated',
        eventData: { part: { type: 'text', text: 'child text' } }
      })

      expect(result).toBeDefined()
      expect(result!.childSessionId).toBe('oc-child')
      expect(persistStreamEvent).not.toHaveBeenCalled()
      expect(sendToRenderer).toHaveBeenCalledTimes(1)
      expect(maybeNotifySessionComplete).not.toHaveBeenCalled()
    })

    test('parent session.idle: persisted, notification fired, no childSessionId', () => {
      const result = simulateHandleEvent({
        directHiveId: 'hive-1',
        resolvedHiveId: undefined,
        sessionId: 'oc-parent',
        eventType: 'session.idle',
        eventData: {}
      })

      expect(result).toBeDefined()
      expect(result!.childSessionId).toBeUndefined()
      expect(persistStreamEvent).toHaveBeenCalledTimes(1)
      expect(maybeNotifySessionComplete).toHaveBeenCalledWith('hive-1')
      expect(sendToRenderer).toHaveBeenCalledTimes(1)
    })

    test('child session.idle: NOT persisted, NO notification, WITH childSessionId', () => {
      const result = simulateHandleEvent({
        directHiveId: undefined,
        resolvedHiveId: 'hive-1',
        sessionId: 'oc-child',
        eventType: 'session.idle',
        eventData: {}
      })

      expect(result).toBeDefined()
      expect(result!.childSessionId).toBe('oc-child')
      expect(persistStreamEvent).not.toHaveBeenCalled()
      expect(maybeNotifySessionComplete).not.toHaveBeenCalled()
      expect(sendToRenderer).toHaveBeenCalledTimes(1)
    })

    test('unresolvable session returns undefined', () => {
      const result = simulateHandleEvent({
        directHiveId: undefined,
        resolvedHiveId: undefined,
        sessionId: 'oc-unknown',
        eventType: 'message.part.updated',
        eventData: {}
      })

      expect(result).toBeUndefined()
      expect(persistStreamEvent).not.toHaveBeenCalled()
      expect(sendToRenderer).not.toHaveBeenCalled()
      expect(maybeNotifySessionComplete).not.toHaveBeenCalled()
    })
  })
})
