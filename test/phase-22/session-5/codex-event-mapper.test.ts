/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import {
  mapCodexEventToStreamEvents,
  contentStreamKindFromMethod
} from '../../../src/main/services/codex-event-mapper'
import type { CodexManagerEvent } from '../../../src/main/services/codex-app-server-manager'

// ── Helpers ──────────────────────────────────────────────────────

function makeEvent(overrides: Partial<CodexManagerEvent>): CodexManagerEvent {
  return {
    id: 'evt-1',
    kind: 'notification',
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: new Date().toISOString(),
    method: '',
    ...overrides
  }
}

const HIVE_SESSION = 'hive-session-abc'

describe('mapCodexEventToStreamEvents', () => {
  // ── Content deltas ──────────────────────────────────────────

  describe('contentStreamKindFromMethod', () => {
    it('classifies item/agentMessage/delta as assistant', () => {
      expect(contentStreamKindFromMethod('item/agentMessage/delta')).toBe('assistant')
    })

    it('classifies item/reasoning/textDelta as reasoning', () => {
      expect(contentStreamKindFromMethod('item/reasoning/textDelta')).toBe('reasoning')
    })

    it('classifies item/reasoning/summaryTextDelta as reasoning_summary', () => {
      expect(contentStreamKindFromMethod('item/reasoning/summaryTextDelta')).toBe(
        'reasoning_summary'
      )
    })

    it('classifies item/commandExecution/outputDelta as command_output', () => {
      expect(contentStreamKindFromMethod('item/commandExecution/outputDelta')).toBe(
        'command_output'
      )
    })

    it('classifies item/fileChange/outputDelta as file_change_output', () => {
      expect(contentStreamKindFromMethod('item/fileChange/outputDelta')).toBe('file_change_output')
    })

    it('classifies item/plan/delta as assistant', () => {
      expect(contentStreamKindFromMethod('item/plan/delta')).toBe('assistant')
    })

    it('returns null for unknown methods', () => {
      expect(contentStreamKindFromMethod('content.delta')).toBeNull()
      expect(contentStreamKindFromMethod('turn/started')).toBeNull()
    })
  })

  describe('content streaming deltas (actual Codex methods)', () => {
    it('maps item/agentMessage/delta with string delta payload', () => {
      const event = makeEvent({
        method: 'item/agentMessage/delta',
        payload: { delta: 'Hello world' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'message.part.updated',
        sessionId: HIVE_SESSION,
        data: {
          part: { type: 'text', text: 'Hello world' },
          delta: 'Hello world'
        }
      })
    })

    it('maps item/agentMessage/delta with textDelta on event', () => {
      const event = makeEvent({
        method: 'item/agentMessage/delta',
        textDelta: 'direct text'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({
        part: { type: 'text', text: 'direct text' },
        delta: 'direct text'
      })
    })

    it('maps item/reasoning/textDelta to reasoning type', () => {
      const event = makeEvent({
        method: 'item/reasoning/textDelta',
        payload: { text: 'Let me think...' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'message.part.updated',
        sessionId: HIVE_SESSION,
        data: {
          part: { type: 'reasoning', text: 'Let me think...' },
          delta: 'Let me think...'
        }
      })
    })

    it('maps item/reasoning/summaryTextDelta to reasoning type', () => {
      const event = makeEvent({
        method: 'item/reasoning/summaryTextDelta',
        payload: { text: 'Summary of reasoning' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({
        part: { type: 'reasoning', text: 'Summary of reasoning' },
        delta: 'Summary of reasoning'
      })
    })

    it('maps item/commandExecution/outputDelta to text type', () => {
      const event = makeEvent({
        method: 'item/commandExecution/outputDelta',
        payload: { text: 'command output line' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({
        part: { type: 'text', text: 'command output line' },
        delta: 'command output line'
      })
    })

    it('maps item/fileChange/outputDelta to text type', () => {
      const event = makeEvent({
        method: 'item/fileChange/outputDelta',
        payload: { text: 'file change diff' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({
        part: { type: 'text', text: 'file change diff' },
        delta: 'file change diff'
      })
    })

    it('maps item/plan/delta to text type', () => {
      const event = makeEvent({
        method: 'item/plan/delta',
        payload: { text: 'plan step 1' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({
        part: { type: 'text', text: 'plan step 1' },
        delta: 'plan step 1'
      })
    })

    it('returns empty array for delta with no text', () => {
      const event = makeEvent({
        method: 'item/agentMessage/delta',
        payload: {}
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })

    it('also handles structured delta object (backward compat)', () => {
      const event = makeEvent({
        method: 'item/agentMessage/delta',
        payload: {
          delta: { type: 'text', text: 'structured delta' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({
        part: { type: 'text', text: 'structured delta' },
        delta: 'structured delta'
      })
    })

    it('maps assistantText at payload level', () => {
      const event = makeEvent({
        method: 'item/agentMessage/delta',
        payload: { assistantText: 'payload assistant text' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({
        part: { type: 'text', text: 'payload assistant text' },
        delta: 'payload assistant text'
      })
    })

    it('maps reasoningText at payload level', () => {
      const event = makeEvent({
        method: 'item/reasoning/textDelta',
        payload: { reasoningText: 'payload reasoning text' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({
        part: { type: 'reasoning', text: 'payload reasoning text' },
        delta: 'payload reasoning text'
      })
    })
  })

  // ── Turn started ────────────────────────────────────────────

  describe('turn/started', () => {
    it('maps to session.status busy', () => {
      const event = makeEvent({ method: 'turn/started' })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'session.status',
        sessionId: HIVE_SESSION,
        data: { status: { type: 'busy' } },
        statusPayload: { type: 'busy' }
      })
    })
  })

  // ── Turn completed ──────────────────────────────────────────

  describe('turn/completed', () => {
    it('maps successful completion to idle status', () => {
      const event = makeEvent({
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      // Should have at least the idle status event
      const statusEvents = result.filter((e) => e.type === 'session.status')
      expect(statusEvents).toHaveLength(1)
      expect(statusEvents[0].statusPayload).toEqual({ type: 'idle' })
    })

    it('maps failed turn to session.error + idle', () => {
      const event = makeEvent({
        method: 'turn/completed',
        payload: { turn: { status: 'failed', error: 'Rate limit exceeded' } }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      const errorEvents = result.filter((e) => e.type === 'session.error')
      expect(errorEvents).toHaveLength(1)
      expect(errorEvents[0].data).toEqual({ error: 'Rate limit exceeded' })

      const statusEvents = result.filter((e) => e.type === 'session.status')
      expect(statusEvents).toHaveLength(1)
      expect(statusEvents[0].statusPayload).toEqual({ type: 'idle' })
    })

    it('includes usage info in message.updated when present', () => {
      const event = makeEvent({
        method: 'turn/completed',
        payload: {
          turn: {
            status: 'completed',
            usage: { inputTokens: 100, outputTokens: 50 },
            cost: 0.003
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      const usageEvents = result.filter((e) => e.type === 'message.updated')
      expect(usageEvents).toHaveLength(1)
      expect((usageEvents[0].data as any).usage).toEqual({
        inputTokens: 100,
        outputTokens: 50
      })
      expect((usageEvents[0].data as any).cost).toBe(0.003)
    })

    it('handles turn/completed with no turn object (fallback status)', () => {
      const event = makeEvent({
        method: 'turn/completed',
        payload: {}
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      // Defaults to 'completed' status → just idle
      const statusEvents = result.filter((e) => e.type === 'session.status')
      expect(statusEvents).toHaveLength(1)
      expect(statusEvents[0].statusPayload).toEqual({ type: 'idle' })

      // No error events for default completion
      const errorEvents = result.filter((e) => e.type === 'session.error')
      expect(errorEvents).toHaveLength(0)
    })
  })

  // ── Item started ────────────────────────────────────────────

  describe('item.started / item/started', () => {
    it('maps item.started to tool_use part', () => {
      const event = makeEvent({
        method: 'item.started',
        payload: {
          item: { id: 'item-1', toolName: 'shell', type: 'commandExecution' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'message.part.updated',
        sessionId: HIVE_SESSION,
        data: {
          part: {
            type: 'tool',
            callID: 'item-1',
            tool: 'shell',
            state: { status: 'running' }
          }
        }
      })
    })

    it('maps item/started (slash variant)', () => {
      const event = makeEvent({
        method: 'item/started',
        payload: {
          item: { id: 'item-2', name: 'file_edit', type: 'fileChange' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).part.tool).toBe('file_edit')
      expect((result[0].data as any).part.callID).toBe('item-2')
    })
  })

  // ── Item updated ────────────────────────────────────────────

  describe('item.updated / item/updated', () => {
    it('maps item.updated to tool_use with status', () => {
      const event = makeEvent({
        method: 'item.updated',
        payload: {
          item: { id: 'item-3', toolName: 'shell', type: 'commandExecution', status: 'running' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).part.type).toBe('tool')
      expect((result[0].data as any).part.state.status).toBe('running')
    })
  })

  // ── Item completed ──────────────────────────────────────────

  describe('item.completed / item/completed', () => {
    it('maps item.completed to tool_result', () => {
      const event = makeEvent({
        method: 'item.completed',
        payload: {
          item: {
            id: 'item-4',
            toolName: 'shell',
            type: 'commandExecution',
            status: 'completed',
            output: 'file created'
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'message.part.updated',
        sessionId: HIVE_SESSION,
        data: {
          part: {
            type: 'tool',
            callID: 'item-4',
            tool: 'shell',
            state: {
              status: 'completed',
              output: 'file created'
            }
          }
        }
      })
    })

    it('defaults status to completed', () => {
      const event = makeEvent({
        method: 'item/completed',
        payload: {
          item: { id: 'item-5', name: 'file_read', type: 'fileChange' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect((result[0].data as any).part.state.status).toBe('completed')
    })
  })

  // ── Task lifecycle ──────────────────────────────────────────

  describe('task events', () => {
    it('maps task.started', () => {
      const event = makeEvent({
        method: 'task.started',
        payload: {
          task: { id: 'task-1', status: 'running', message: 'Starting analysis' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({
        type: 'task',
        taskId: 'task-1',
        status: 'running',
        message: 'Starting analysis'
      })
    })

    it('maps task.progress with progress value', () => {
      const event = makeEvent({
        method: 'task.progress',
        payload: {
          task: { id: 'task-2', status: 'running', progress: 0.5 }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).progress).toBe(0.5)
    })

    it('maps task/completed (slash variant)', () => {
      const event = makeEvent({
        method: 'task/completed',
        payload: {
          task: { id: 'task-3', status: 'completed' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).status).toBe('completed')
    })
  })

  // ── Session state changed ───────────────────────────────────

  describe('session.state.changed', () => {
    it('maps error state to session.error', () => {
      const event = makeEvent({
        method: 'session.state.changed',
        payload: { state: 'error', reason: 'API key invalid' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'session.error',
        sessionId: HIVE_SESSION,
        data: { error: 'API key invalid' }
      })
    })

    it('maps running state to busy', () => {
      const event = makeEvent({
        method: 'session.state.changed',
        payload: { state: 'running' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].statusPayload).toEqual({ type: 'busy' })
    })

    it('maps ready state to idle', () => {
      const event = makeEvent({
        method: 'session.state.changed',
        payload: { state: 'ready' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].statusPayload).toEqual({ type: 'idle' })
    })

    it('returns empty for unknown state', () => {
      const event = makeEvent({
        method: 'session.state.changed',
        payload: { state: 'connecting' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })

    it('handles session/state/changed (slash variant)', () => {
      const event = makeEvent({
        method: 'session/state/changed',
        payload: { state: 'error', error: 'Connection lost' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('session.error')
      expect((result[0].data as any).error).toBe('Connection lost')
    })
  })

  // ── Runtime error ───────────────────────────────────────────

  describe('runtime.error', () => {
    it('maps runtime.error to session.error', () => {
      const event = makeEvent({
        method: 'runtime.error',
        payload: { message: 'OOM killed' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'session.error',
        sessionId: HIVE_SESSION,
        data: { error: 'OOM killed' }
      })
    })

    it('maps runtime/error (slash variant)', () => {
      const event = makeEvent({
        method: 'runtime/error',
        payload: { error: 'Sandbox violation' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).error).toBe('Sandbox violation')
    })

    it('falls back to event.message', () => {
      const event = makeEvent({
        method: 'runtime.error',
        message: 'fallback error message'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).error).toBe('fallback error message')
    })
  })

  // ── Manager-level error events ──────────────────────────────

  describe('error kind events', () => {
    it('maps process/error to session.error', () => {
      const event = makeEvent({
        kind: 'error',
        method: 'process/error',
        message: 'codex process crashed'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('session.error')
      expect((result[0].data as any).error).toBe('codex process crashed')
    })

    it('uses "Unknown error" for process/error events without message', () => {
      const event = makeEvent({
        kind: 'error',
        method: 'process/error'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).error).toBe('Unknown error')
    })

    it('silently drops non-fatal error events (e.g. protocol errors)', () => {
      const event = makeEvent({
        kind: 'error',
        method: 'protocol/parseError',
        message: 'Received invalid JSON'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })
  })

  // ── Stderr output (downgraded to notification) ──────────────

  describe('process/stderr events', () => {
    it('silently drops stderr notification events', () => {
      const event = makeEvent({
        kind: 'notification',
        method: 'process/stderr',
        message: 'codex stderr output'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })
  })

  // ── Unrecognized events ─────────────────────────────────────

  describe('unrecognized events', () => {
    it('returns empty array for unknown notification methods', () => {
      const event = makeEvent({
        kind: 'notification',
        method: 'some.unknown.event'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })

    it('returns empty array for session lifecycle events', () => {
      const event = makeEvent({
        kind: 'session',
        method: 'session/ready'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })
  })

  // ── Session ID passthrough ──────────────────────────────────

  describe('session ID passthrough', () => {
    it('uses the provided hiveSessionId in all events', () => {
      const event = makeEvent({
        method: 'item/agentMessage/delta',
        payload: { delta: 'x' }
      })

      const result = mapCodexEventToStreamEvents(event, 'custom-session-id')

      expect(result[0].sessionId).toBe('custom-session-id')
    })
  })

  it('normalizes command arrays into input.command for commandExecution items', () => {
    const event = makeEvent({
      method: 'item.started',
      payload: {
        item: {
          id: 'item-cmd-1',
          toolName: 'shell',
          type: 'commandExecution',
          command: ['/bin/zsh', '-lc', 'pnpm test']
        }
      }
    })

    const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

    expect((result[0].data as any).part.state.input).toEqual({ command: '/bin/zsh -lc pnpm test' })
  })
})
