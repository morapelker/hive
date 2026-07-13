import { describe, expect, it } from 'vitest'

import type { CodexManagerEvent } from '../codex-app-server-manager'
import { mapCodexEventToStreamEvents } from '../codex-event-mapper'

function makeEvent(overrides: Partial<CodexManagerEvent>): CodexManagerEvent {
  return {
    id: 'evt-1',
    kind: 'notification',
    provider: 'codex',
    threadId: 'T',
    createdAt: '2026-01-01T00:00:00.000Z',
    method: 'turn/completed',
    ...overrides
  }
}

const statusTypes = (events: ReturnType<typeof mapCodexEventToStreamEvents>): string[] =>
  events
    .filter((event) => event.type === 'session.status')
    .map((event) => event.statusPayload?.type ?? '')

describe('mapCodexEventToStreamEvents turn lifecycle thread scoping', () => {
  it('emits idle for turn/completed on the session thread', () => {
    const events = mapCodexEventToStreamEvents(
      makeEvent({ payload: { threadId: 'T', turn: { id: 't1', status: 'completed' } } }),
      'hive-1'
    )

    expect(statusTypes(events)).toEqual(['idle'])
  })

  it('emits nothing for turn/completed from a foreign thread', () => {
    const events = mapCodexEventToStreamEvents(
      makeEvent({ payload: { threadId: 'C', turn: { id: 'c1', status: 'completed' } } }),
      'hive-1'
    )

    expect(events).toEqual([])
  })

  it('still emits idle when the payload carries no threadId (legacy shape)', () => {
    const events = mapCodexEventToStreamEvents(
      makeEvent({ payload: { turn: { id: 't1', status: 'completed' } } }),
      'hive-1'
    )

    expect(statusTypes(events)).toEqual(['idle'])
  })

  it('emits busy for turn/started on the session thread', () => {
    const events = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'turn/started',
        payload: { threadId: 'T', turn: { id: 't1', status: 'inProgress' } }
      }),
      'hive-1'
    )

    expect(statusTypes(events)).toEqual(['busy'])
  })

  it('emits nothing for turn/started from a foreign thread', () => {
    const events = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'turn/started',
        payload: { threadId: 'C', turn: { id: 'c1', status: 'inProgress' } }
      }),
      'hive-1'
    )

    expect(events).toEqual([])
  })

  it('emits session.error plus idle for a failed turn on the session thread', () => {
    const events = mapCodexEventToStreamEvents(
      makeEvent({
        payload: {
          threadId: 'T',
          turn: { id: 't1', status: 'failed', error: { message: 'boom' } }
        }
      }),
      'hive-1'
    )

    expect(events.some((event) => event.type === 'session.error')).toBe(true)
    expect(statusTypes(events)).toEqual(['idle'])
  })
})
