import { describe, test, expect, beforeEach } from 'vitest'

/**
 * Session 6: Subagent Content Routing (Renderer)
 *
 * Tests the logic for routing child session events into SubtaskCards
 * rather than top-level streaming parts. Uses pure logic testing
 * (no component rendering) to validate the routing algorithm.
 *
 * Key insight: the SDK does NOT emit a dedicated "subtask" part type.
 * Instead, child events simply start arriving with a `childSessionId`.
 * The renderer auto-creates a subtask entry on the first child event.
 */

// Minimal type definitions mirroring SessionView's StreamingPart
interface ToolUseInfo {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error'
  startTime: number
  endTime?: number
  output?: string
  error?: string
}

interface StreamingPart {
  type: 'text' | 'tool_use' | 'subtask'
  text?: string
  toolUse?: ToolUseInfo
  subtask?: {
    id: string
    sessionID: string
    prompt: string
    description: string
    agent: string
    parts: StreamingPart[]
    status: 'running' | 'completed' | 'error'
  }
}

interface StreamEvent {
  type: string
  sessionId: string
  childSessionId?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

/**
 * Simulates the child-to-subtask index mapping that SessionView maintains.
 * This is a Map<string, number> mapping child session IDs to their subtask index
 * in the streamingParts array.
 */
let childToSubtaskIndex: Map<string, number>
let streamingParts: StreamingPart[]

/**
 * Simulates the child event routing logic from SessionView's message.part.updated handler.
 * Auto-creates a subtask entry if the child session ID is not yet mapped (because
 * the SDK doesn't emit a dedicated "subtask" part — child events just start arriving).
 * Returns true if the event was routed to a subtask, false if it should be processed as top-level.
 */
function routeChildEvent(event: StreamEvent): boolean {
  if (!event.childSessionId) return false

  let subtaskIdx = childToSubtaskIndex.get(event.childSessionId)

  // Auto-create subtask entry on first child event
  if (subtaskIdx === undefined) {
    subtaskIdx = streamingParts.length
    streamingParts.push({
      type: 'subtask',
      subtask: {
        id: event.childSessionId,
        sessionID: event.childSessionId,
        prompt: '',
        description: '',
        agent: 'task',
        parts: [],
        status: 'running'
      }
    })
    childToSubtaskIndex.set(event.childSessionId, subtaskIdx)
  }

  const childPart = event.data?.part
  if (childPart?.type === 'text') {
    const subtask = streamingParts[subtaskIdx]
    if (subtask?.type === 'subtask' && subtask.subtask) {
      const lastPart = subtask.subtask.parts[subtask.subtask.parts.length - 1]
      if (lastPart?.type === 'text') {
        lastPart.text = (lastPart.text || '') + (event.data?.delta || childPart.text || '')
      } else {
        subtask.subtask.parts.push({
          type: 'text',
          text: event.data?.delta || childPart.text || ''
        })
      }
    }
    return true
  }

  if (childPart?.type === 'tool') {
    const state = childPart.state || childPart
    const toolId = state.toolCallId || childPart.callID || childPart.id || `tool-${Date.now()}`
    const subtask = streamingParts[subtaskIdx]
    if (subtask?.type === 'subtask' && subtask.subtask) {
      const existing = subtask.subtask.parts.find(
        (p) => p.type === 'tool_use' && p.toolUse?.id === toolId
      )
      if (existing && existing.type === 'tool_use' && existing.toolUse) {
        const statusMap: Record<string, string> = {
          running: 'running',
          completed: 'success',
          error: 'error'
        }
        existing.toolUse.status = (statusMap[state.status] || 'running') as ToolUseInfo['status']
        if (state.time?.end) existing.toolUse.endTime = state.time.end
        if (state.status === 'completed') existing.toolUse.output = state.output
        if (state.status === 'error') existing.toolUse.error = state.error
      } else {
        subtask.subtask.parts.push({
          type: 'tool_use',
          toolUse: {
            id: toolId,
            name: childPart.tool || state.name || 'unknown',
            input: state.input || {},
            status: 'running',
            startTime: state.time?.start || Date.now()
          }
        })
      }
    }
    return true
  }

  // Unknown part type from child — still routed (don't leak to top-level)
  return true
}

/**
 * Simulates the child session.idle handling from SessionView.
 * Returns true if handled as a child event, false if it should proceed to parent handling.
 */
function handleSessionIdle(event: StreamEvent): boolean {
  if (!event.childSessionId) return false

  const subtaskIdx = childToSubtaskIndex.get(event.childSessionId)
  if (subtaskIdx === undefined) return false

  const subtask = streamingParts[subtaskIdx]
  if (subtask?.type === 'subtask' && subtask.subtask) {
    subtask.subtask.status = 'completed'
  }
  return true
}

describe('Session 6: Subagent Content Routing', () => {
  beforeEach(() => {
    childToSubtaskIndex = new Map()
    streamingParts = []
  })

  describe('Auto-creation of subtask on first child event', () => {
    test('first child text event auto-creates a subtask entry', () => {
      expect(streamingParts).toHaveLength(0)

      const routed = routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'Hello' }, delta: 'Hello' }
      })

      expect(routed).toBe(true)
      // Subtask was auto-created
      expect(streamingParts).toHaveLength(1)
      expect(streamingParts[0].type).toBe('subtask')
      expect(streamingParts[0].subtask?.sessionID).toBe('child-1')
      expect(streamingParts[0].subtask?.status).toBe('running')
      // Text was routed into the subtask
      expect(streamingParts[0].subtask?.parts).toHaveLength(1)
      expect(streamingParts[0].subtask?.parts[0].text).toBe('Hello')
    })

    test('first child tool event auto-creates a subtask entry', () => {
      const routed = routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: {
          part: {
            type: 'tool',
            callID: 'tool-abc',
            tool: 'Read',
            state: { status: 'running', input: { path: '/foo' }, time: { start: 1000 } }
          }
        }
      })

      expect(routed).toBe(true)
      expect(streamingParts).toHaveLength(1)
      expect(streamingParts[0].type).toBe('subtask')
      expect(streamingParts[0].subtask?.parts[0].type).toBe('tool_use')
      expect(streamingParts[0].subtask?.parts[0].toolUse?.name).toBe('Read')
    })

    test('subsequent events reuse existing subtask (no duplicate)', () => {
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'Hello' }, delta: 'Hello' }
      })

      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: ' world' }, delta: ' world' }
      })

      // Still only one subtask
      expect(streamingParts).toHaveLength(1)
      // Text was appended to the same text part
      expect(streamingParts[0].subtask?.parts).toHaveLength(1)
      expect(streamingParts[0].subtask?.parts[0].text).toBe('Hello world')
    })

    test('subtask appears after existing parent text parts', () => {
      // Parent text already in stream
      streamingParts.push({ type: 'text', text: 'Parent thinking...' })

      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'Child text' }, delta: 'Child text' }
      })

      expect(streamingParts).toHaveLength(2)
      expect(streamingParts[0].type).toBe('text')
      expect(streamingParts[1].type).toBe('subtask')
      expect(childToSubtaskIndex.get('child-1')).toBe(1)
    })
  })

  describe('Multiple concurrent child sessions', () => {
    test('each child session gets its own subtask', () => {
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'From child 1' }, delta: 'From child 1' }
      })

      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-2',
        data: { part: { type: 'text', text: 'From child 2' }, delta: 'From child 2' }
      })

      expect(streamingParts).toHaveLength(2)
      expect(streamingParts[0].subtask?.sessionID).toBe('child-1')
      expect(streamingParts[0].subtask?.parts[0].text).toBe('From child 1')
      expect(streamingParts[1].subtask?.sessionID).toBe('child-2')
      expect(streamingParts[1].subtask?.parts[0].text).toBe('From child 2')
    })
  })

  describe('Child text event routing', () => {
    test('consecutive text deltas are appended to the same text part', () => {
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'Hello' }, delta: 'Hello' }
      })

      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: ' world' }, delta: ' world' }
      })

      const subtaskParts = streamingParts[0].subtask?.parts
      expect(subtaskParts).toHaveLength(1)
      expect(subtaskParts?.[0].text).toBe('Hello world')
    })

    test('child text event does NOT appear as top-level part', () => {
      const routed = routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'child text' }, delta: 'child text' }
      })

      expect(routed).toBe(true)
      // Only the auto-created subtask, no separate text part
      expect(streamingParts).toHaveLength(1)
      expect(streamingParts[0].type).toBe('subtask')
    })
  })

  describe('Child tool event routing', () => {
    test('child tool event creates tool_use in subtask', () => {
      const routed = routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: {
          part: {
            type: 'tool',
            callID: 'tool-abc',
            tool: 'Read',
            state: {
              status: 'running',
              input: { path: '/foo/bar.ts' },
              time: { start: 1000 }
            }
          }
        }
      })

      expect(routed).toBe(true)
      const subtaskParts = streamingParts[0].subtask?.parts
      expect(subtaskParts).toHaveLength(1)
      expect(subtaskParts?.[0].type).toBe('tool_use')
      expect(subtaskParts?.[0].toolUse?.id).toBe('tool-abc')
      expect(subtaskParts?.[0].toolUse?.name).toBe('Read')
      expect(subtaskParts?.[0].toolUse?.status).toBe('running')
    })

    test('child tool event updates existing tool status', () => {
      // First: tool starts running
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: {
          part: {
            type: 'tool',
            callID: 'tool-abc',
            tool: 'Read',
            state: { status: 'running', input: { path: '/foo' }, time: { start: 1000 } }
          }
        }
      })

      // Second: tool completes
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: {
          part: {
            type: 'tool',
            callID: 'tool-abc',
            tool: 'Read',
            state: {
              status: 'completed',
              output: 'file contents',
              time: { start: 1000, end: 2000 }
            }
          }
        }
      })

      const subtaskParts = streamingParts[0].subtask?.parts
      expect(subtaskParts).toHaveLength(1) // Same tool, not duplicated
      expect(subtaskParts?.[0].toolUse?.status).toBe('success')
      expect(subtaskParts?.[0].toolUse?.output).toBe('file contents')
      expect(subtaskParts?.[0].toolUse?.endTime).toBe(2000)
    })
  })

  describe('Child session.idle handling', () => {
    test('child session.idle updates subtask status to completed', () => {
      // Auto-create via a text event first
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'Working...' }, delta: 'Working...' }
      })
      expect(streamingParts[0].subtask?.status).toBe('running')

      const handled = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent',
        childSessionId: 'child-1'
      })

      expect(handled).toBe(true)
      expect(streamingParts[0].subtask?.status).toBe('completed')
    })

    test('child session.idle does NOT finalize parent', () => {
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'Done' }, delta: 'Done' }
      })

      const handled = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent',
        childSessionId: 'child-1'
      })

      // Returns true means the caller should `return` — NOT proceed to parent finalization
      expect(handled).toBe(true)
    })

    test('parent session.idle is not handled as child', () => {
      const handled = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent'
        // no childSessionId
      })

      // Returns false means caller should proceed to parent finalization logic
      expect(handled).toBe(false)
    })
  })

  describe('Parent events unaffected by child routing', () => {
    test('event without childSessionId is not routed', () => {
      const routed = routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        // no childSessionId
        data: { part: { type: 'text', text: 'parent text' }, delta: 'parent text' }
      })

      expect(routed).toBe(false)
      expect(streamingParts).toHaveLength(0)
    })
  })

  describe('Mixed content in subtasks', () => {
    test('subtask accumulates text and tool_use parts interleaved', () => {
      // Text part
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'Analyzing...' }, delta: 'Analyzing...' }
      })

      // Tool part
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: {
          part: {
            type: 'tool',
            callID: 'tool-1',
            tool: 'Grep',
            state: { status: 'running', input: { pattern: 'foo' }, time: { start: 1000 } }
          }
        }
      })

      // More text after tool
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'Found results' }, delta: 'Found results' }
      })

      const subtaskParts = streamingParts[0].subtask?.parts
      expect(subtaskParts).toHaveLength(3)
      expect(subtaskParts?.[0].type).toBe('text')
      expect(subtaskParts?.[0].text).toBe('Analyzing...')
      expect(subtaskParts?.[1].type).toBe('tool_use')
      expect(subtaskParts?.[1].toolUse?.name).toBe('Grep')
      expect(subtaskParts?.[2].type).toBe('text')
      expect(subtaskParts?.[2].text).toBe('Found results')
    })
  })

  describe('Session change cleanup', () => {
    test('clearing the mapping prevents routing to stale subtasks', () => {
      // Create a subtask via child event
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'old' }, delta: 'old' }
      })

      // Simulate session change: clear mapping and parts
      childToSubtaskIndex.clear()
      streamingParts = []

      // New child event for same session ID — creates fresh subtask
      routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'text', text: 'fresh' }, delta: 'fresh' }
      })

      expect(streamingParts).toHaveLength(1)
      expect(streamingParts[0].subtask?.parts[0].text).toBe('fresh')
    })
  })

  describe('Unknown child part types', () => {
    test('unknown part types are still routed (not leaked to top-level)', () => {
      const routed = routeChildEvent({
        type: 'message.part.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: { part: { type: 'step-start' } }
      })

      // The event should be routed (return true) even for unknown part types
      // to prevent child content from leaking to the parent stream
      expect(routed).toBe(true)
      // Subtask was auto-created but no inner parts added for unknown type
      expect(streamingParts).toHaveLength(1)
      expect(streamingParts[0].type).toBe('subtask')
      expect(streamingParts[0].subtask?.parts).toHaveLength(0)
    })
  })
})
