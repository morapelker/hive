/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'
import { mapCodexEventToStreamEvents } from '../../../src/main/services/codex-event-mapper'
import type { CodexManagerEvent } from '../../../src/main/services/codex-app-server-manager'

const HIVE_SESSION = 'hive-session-123'

function makeEvent(overrides: Partial<CodexManagerEvent>): CodexManagerEvent {
  return {
    id: 'evt-plan-1',
    kind: 'notification',
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: new Date().toISOString(),
    method: '',
    ...overrides
  }
}

describe('Codex plan update stream mapping', () => {
  it('maps turn/plan/updated into an update_plan checklist tool event', () => {
    const event = makeEvent({
      method: 'turn/plan/updated',
      turnId: 'turn-1',
      payload: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        explanation: 'Tracking progress',
        plan: [
          { step: 'Inspect adapter', status: 'completed' },
          { step: 'Map plan updates', status: 'inProgress' },
          { step: 'Verify logging', status: 'pending' }
        ]
      }
    })

    const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('message.part.updated')
    expect(result[0]?.sessionId).toBe(HIVE_SESSION)

    const data = result[0]?.data as any
    expect(data._codexEventId).toBe('evt-plan-1')
    expect(data.part.type).toBe('tool')
    expect(data.part.callID).toBe('update-plan:thread-1:turn-1')
    expect(data.part.tool).toBe('update_plan')
    expect(data.part.state.status).toBe('completed')
    expect(data.part.state.input).toEqual({
      explanation: 'Tracking progress',
      todos: [
        {
          id: 'update-plan:thread-1:turn-1:0',
          content: 'Inspect adapter',
          status: 'completed',
          priority: 'medium'
        },
        {
          id: 'update-plan:thread-1:turn-1:1',
          content: 'Map plan updates',
          status: 'in_progress',
          priority: 'medium'
        },
        {
          id: 'update-plan:thread-1:turn-1:2',
          content: 'Verify logging',
          status: 'pending',
          priority: 'medium'
        }
      ]
    })
  })
})
