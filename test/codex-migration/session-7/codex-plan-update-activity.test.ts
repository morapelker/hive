import { describe, expect, it } from 'vitest'
import { mapCodexManagerEventToActivity } from '../../../src/main/services/codex-activity-mapper'
import type { CodexManagerEvent } from '../../../src/main/services/codex-app-server-manager'

function makeEvent(overrides: Partial<CodexManagerEvent>): CodexManagerEvent {
  return {
    id: 'evt-plan-activity-1',
    kind: 'notification',
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: new Date().toISOString(),
    method: '',
    ...overrides
  }
}

describe('codex-activity-mapper plan updates', () => {
  it('persists turn/plan/updated as a session info activity with progress summary', () => {
    const result = mapCodexManagerEventToActivity('session-1', 'agent-1', makeEvent({
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
    }))

    expect(result).not.toBeNull()
    expect(result!.kind).toBe('session.info')
    expect(result!.tone).toBe('info')
    expect(result!.turn_id).toBe('turn-1')
    expect(result!.summary).toBe('Plan updated (1/3 completed)')
    expect(result!.payload_json).toContain('"plan"')
  })
})
