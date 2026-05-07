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
      expect(result[0]).toMatchObject({
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
      expect(result[0].data).toMatchObject({
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
      expect(result[0]).toMatchObject({
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
      expect(result[0].data).toMatchObject({
        part: { type: 'reasoning', text: 'Summary of reasoning' },
        delta: 'Summary of reasoning'
      })
    })

    it('maps item/commandExecution/outputDelta without itemId to text type', () => {
      const event = makeEvent({
        method: 'item/commandExecution/outputDelta',
        payload: { text: 'command output line' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toMatchObject({
        part: { type: 'text', text: 'command output line' },
        delta: 'command output line'
      })
    })

    it('command_output with itemId → tool outputDelta', () => {
      const event = makeEvent({
        method: 'item/commandExecution/outputDelta',
        itemId: 'tool-42',
        payload: { text: 'command output line' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('message.part.updated')
      expect(result[0].sessionId).toBe(HIVE_SESSION)
      const part = (result[0].data as any).part
      expect(part.type).toBe('tool')
      expect(part.callID).toBe('tool-42')
      expect(part.tool).toBe('Bash')
      expect(part.state).toEqual({ status: 'running', outputDelta: 'command output line' })
    })

    it('maps item/fileChange/outputDelta without itemId to text type', () => {
      const event = makeEvent({
        method: 'item/fileChange/outputDelta',
        payload: { text: 'file change diff' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toMatchObject({
        part: { type: 'text', text: 'file change diff' },
        delta: 'file change diff'
      })
    })

    it('file_change_output with itemId → tool outputDelta', () => {
      const event = makeEvent({
        method: 'item/fileChange/outputDelta',
        itemId: 'tool-fc-7',
        payload: { text: 'file change diff' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('message.part.updated')
      expect(result[0].sessionId).toBe(HIVE_SESSION)
      const part = (result[0].data as any).part
      expect(part.type).toBe('tool')
      expect(part.callID).toBe('tool-fc-7')
      expect(part.tool).toBe('fileChange')
      expect(part.state).toEqual({ status: 'running', outputDelta: 'file change diff' })
    })

    it('maps item/plan/delta to text type', () => {
      const event = makeEvent({
        method: 'item/plan/delta',
        payload: { text: 'plan step 1' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toMatchObject({
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
      expect(result[0].data).toMatchObject({
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
      expect(result[0].data).toMatchObject({
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
      expect(result[0].data).toMatchObject({
        part: { type: 'reasoning', text: 'payload reasoning text' },
        delta: 'payload reasoning text'
      })
    })
  })

  describe('thread goal notifications', () => {
    it('maps thread/goal/updated to a goal status stream event', () => {
      const event = makeEvent({
        method: 'thread/goal/updated',
        payload: {
          threadId: 'thread-1',
          turnId: null,
          goal: {
            threadId: 'thread-1',
            objective: 'Finish the migration',
            status: 'active',
            tokenBudget: 50000,
            tokensUsed: 1200,
            timeUsedSeconds: 90,
            createdAt: 10,
            updatedAt: 20
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        type: 'codex.goal.updated',
        sessionId: HIVE_SESSION,
        data: {
          goal: {
            objective: 'Finish the migration',
            status: 'active',
            tokenBudget: 50000,
            tokensUsed: 1200,
            timeUsedSeconds: 90
          }
        }
      })
    })

    it('maps thread/goal/cleared to a goal cleared stream event', () => {
      const event = makeEvent({
        method: 'thread/goal/cleared',
        payload: { threadId: 'thread-1' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        type: 'codex.goal.cleared',
        sessionId: HIVE_SESSION,
        data: { threadId: 'thread-1' }
      })
    })
  })

  // ── Turn started ────────────────────────────────────────────

  describe('turn/started', () => {
    it('maps to session.status busy', () => {
      const event = makeEvent({ method: 'turn/started' })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
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
      expect(errorEvents[0].data).toMatchObject({ error: 'Rate limit exceeded' })

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
      expect(result[0]).toMatchObject({
        type: 'message.part.updated',
        sessionId: HIVE_SESSION,
        data: {
          part: {
            type: 'tool',
            callID: 'item-1',
            tool: 'Bash',
            state: { status: 'running', input: {} }
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

    it('maps typed read actions to Read tool cards', () => {
      const event = makeEvent({
        method: 'item.started',
        payload: {
          item: {
            id: 'item-read-1',
            type: 'commandExecution',
            command: `sed -n '10,40p' src/index.ts`,
            cwd: '/project',
            processId: null,
            source: 'agent',
            status: 'running',
            commandActions: [
              {
                type: 'read',
                command: `sed -n '10,40p' src/index.ts`,
                name: 'index.ts',
                path: 'src/index.ts'
              }
            ],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)
      const part = (result[0].data as any).part
      expect(part.tool).toBe('Read')
      expect(part.state.input).toEqual({
        file_path: 'src/index.ts',
        offset: 10,
        limit: 30
      })
    })

    it('maps numbered nl|sed reads to Read tool cards with exact ranges', () => {
      const event = makeEvent({
        method: 'item.started',
        payload: {
          item: {
            id: 'item-read-2',
            type: 'commandExecution',
            command:
              "nl -ba src/renderer/src/components/sessions/ToolCard.tsx | sed -n '40,120p;220,250p;570,620p;875,915p'",
            cwd: '/project',
            processId: null,
            source: 'agent',
            status: 'running',
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)
      const part = (result[0].data as any).part
      expect(part.tool).toBe('Read')
      expect(part.state.input).toEqual({
        file_path: 'src/renderer/src/components/sessions/ToolCard.tsx',
        line_ranges: [
          { start: 40, end: 120 },
          { start: 220, end: 250 },
          { start: 570, end: 620 },
          { start: 875, end: 915 }
        ]
      })
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
      expect((result[0].data as any).part.tool).toBe('Bash')
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
      expect(result[0]).toMatchObject({
        type: 'message.part.updated',
        sessionId: HIVE_SESSION,
        data: {
          part: {
            type: 'tool',
            callID: 'item-4',
            tool: 'Bash',
            state: {
              status: 'completed',
              input: {},
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

    it('includes input in state when item has input', () => {
      const event = makeEvent({
        method: 'item.completed',
        payload: {
          item: {
            id: 'item-6',
            toolName: 'shell',
            type: 'commandExecution',
            status: 'completed',
            command: 'ls -la',
            output: 'total 8'
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      const state = (result[0].data as any).part.state
      expect(state.status).toBe('completed')
      expect(state.input).toEqual({ command: 'ls -la' })
      expect(state.output).toBe('total 8')
    })
  })

  // ── Approval requests ───────────────────────────────────────

  describe('approval requests (event.kind === "request")', () => {
    it('maps item/commandExecution/requestApproval to Bash tool card', () => {
      const event = makeEvent({
        kind: 'request',
        method: 'item/commandExecution/requestApproval',
        itemId: 'call-bash-1',
        payload: {
          item: {
            id: 'call-bash-1',
            type: 'commandExecution',
            command: 'npm run build'
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('message.part.updated')
      expect(result[0].sessionId).toBe(HIVE_SESSION)
      const part = (result[0].data as any).part
      expect(part.type).toBe('tool')
      expect(part.tool).toBe('Bash')
      expect(part.callID).toBe('call-bash-1')
      expect(part.state.status).toBe('running')
      expect(part.state.input).toEqual({ command: 'npm run build' })
    })

    it('maps item/fileChange/requestApproval to fileChange tool card', () => {
      const event = makeEvent({
        kind: 'request',
        method: 'item/fileChange/requestApproval',
        itemId: 'call-fc-1',
        payload: {
          item: {
            id: 'call-fc-1',
            type: 'fileChange',
            changes: [{ path: 'foo.ts', content: '...' }]
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      const part = (result[0].data as any).part
      expect(part.tool).toBe('fileChange')
      expect(part.callID).toBe('call-fc-1')
      expect(part.state.status).toBe('running')
    })

    it('maps approval commandActions.search to Grep tool card', () => {
      const event = makeEvent({
        kind: 'request',
        method: 'item/commandExecution/requestApproval',
        itemId: 'call-grep-1',
        payload: {
          item: {
            id: 'call-grep-1',
            type: 'commandExecution'
          },
          command: `rg -n "needle" src`,
          commandActions: [
            {
              type: 'search',
              command: `rg -n "needle" src`,
              query: 'needle',
              path: 'src'
            }
          ]
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)
      const part = (result[0].data as any).part
      expect(part.tool).toBe('Grep')
      expect(part.state.input).toEqual({ pattern: 'needle', path: 'src' })
    })

    it('maps item/fileRead/requestApproval to Read tool card', () => {
      const event = makeEvent({
        kind: 'request',
        method: 'item/fileRead/requestApproval',
        itemId: 'call-read-1',
        payload: {
          item: {
            id: 'call-read-1',
            type: 'fileRead'
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      const part = (result[0].data as any).part
      expect(part.tool).toBe('Read')
      expect(part.callID).toBe('call-read-1')
    })

    it('returns empty array when callId cannot be determined', () => {
      const event = makeEvent({
        kind: 'request',
        method: 'item/commandExecution/requestApproval',
        // no itemId, no item.id, no payload.itemId
        payload: {
          item: { type: 'commandExecution', command: 'rm -rf /' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })

    it('returns empty array for non-approval request events', () => {
      const event = makeEvent({
        kind: 'request',
        method: 'item/commandExecution/someOtherMethod',
        itemId: 'call-x-1'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })

    it('strips shell prefix from command in approval request', () => {
      const event = makeEvent({
        kind: 'request',
        method: 'item/commandExecution/requestApproval',
        itemId: 'call-bash-2',
        payload: {
          item: {
            id: 'call-bash-2',
            type: 'commandExecution',
            command: '/bin/zsh -lc git status'
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      const part = (result[0].data as any).part
      expect(part.state.input.command).toBe('git status')
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
      expect(result[0].type).toBe('message.part.updated')
      expect((result[0].data as any).part).toEqual({
        type: 'subtask',
        id: 'task-1',
        sessionID: 'task-1',
        prompt: '',
        description: 'Starting analysis',
        agent: 'task',
        status: 'running'
      })
    })

    it('maps task.progress with progress value', () => {
      const event = makeEvent({
        method: 'task.progress',
        payload: {
          task: { id: 'task-2', status: 'running', message: 'Halfway there', progress: 0.5 }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).part).toMatchObject({
        type: 'subtask',
        id: 'task-2',
        description: 'Halfway there',
        status: 'running'
      })
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
      expect((result[0].data as any).part).toMatchObject({
        type: 'subtask',
        id: 'task-3',
        status: 'completed'
      })
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

    expect((result[0].data as any).part.state.input).toEqual({ command: 'pnpm test' })
  })

  // ── Expanded tool types (Phase 3) ───────────────────────────

  describe('expanded tool type coverage', () => {
    it('item.started with type fileRead returns a tool event', () => {
      const event = makeEvent({
        method: 'item.started',
        payload: {
          item: { id: 'item-fr-1', toolName: 'Read', type: 'fileRead' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('message.part.updated')
      const part = (result[0].data as any).part
      expect(part.type).toBe('tool')
      expect(part.callID).toBe('item-fr-1')
      expect(part.state.status).toBe('running')
    })

    it('item.started with type mcpToolCall returns a tool event', () => {
      const event = makeEvent({
        method: 'item.started',
        payload: {
          item: { id: 'item-mcp-1', toolName: 'MCP', type: 'mcpToolCall' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('message.part.updated')
      const part = (result[0].data as any).part
      expect(part.type).toBe('tool')
      expect(part.callID).toBe('item-mcp-1')
      expect(part.state.status).toBe('running')
    })

    it('item.started with type dynamicToolCall returns a tool event', () => {
      const event = makeEvent({
        method: 'item.started',
        payload: {
          item: { id: 'item-dtc-1', toolName: 'Tool', type: 'dynamicToolCall' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('message.part.updated')
      const part = (result[0].data as any).part
      expect(part.type).toBe('tool')
      expect(part.callID).toBe('item-dtc-1')
      expect(part.state.status).toBe('running')
    })
  })

  // ── Terminal interaction handler ─────────────────────────────

  describe('item/commandExecution/terminalInteraction', () => {
    it('maps terminalInteraction to tool update with status running', () => {
      const event = makeEvent({
        method: 'item/commandExecution/terminalInteraction',
        payload: {
          item: {
            id: 'item-ti-1',
            type: 'commandExecution',
            command: `sed -n '1,20p' src/index.ts`,
            commandActions: [
              {
                type: 'read',
                command: `sed -n '1,20p' src/index.ts`,
                name: 'index.ts',
                path: 'src/index.ts'
              }
            ]
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('message.part.updated')
      expect(result[0].sessionId).toBe(HIVE_SESSION)
      const part = (result[0].data as any).part
      expect(part.type).toBe('tool')
      expect(part.callID).toBe('item-ti-1')
      expect(part.tool).toBe('Read')
      expect(part.state.status).toBe('running')
    })

    it('returns empty array when callId cannot be determined', () => {
      const event = makeEvent({
        method: 'item/commandExecution/terminalInteraction',
        // no itemId, no item.id in payload
        payload: {
          item: { type: 'commandExecution' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })
  })
})
