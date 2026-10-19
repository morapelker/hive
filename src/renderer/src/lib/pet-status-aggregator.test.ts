import { describe, expect, it } from 'vitest'
import type { SessionStatusEntry } from '@/stores/useWorktreeStatusStore'
import { aggregatePetStatus, type PetAggregateInput } from './pet-status-aggregator'

function entry(
  status: SessionStatusEntry['status'],
  extra: Partial<SessionStatusEntry> = {}
): SessionStatusEntry {
  return { status, timestamp: 1, ...extra }
}

function input(overrides: Partial<PetAggregateInput> = {}): PetAggregateInput {
  return {
    sessionStatuses: {},
    worktreeSessions: new Map([['wt-1', [{ id: 'a' }]]]),
    connectionSessions: new Map(),
    connections: [],
    ...overrides
  }
}

describe('aggregatePetStatus', () => {
  it('idles with a zero count when nothing is in progress', () => {
    expect(
      aggregatePetStatus(
        input({ sessionStatuses: { a: entry('completed', { completion: 'completed' }) } })
      )
    ).toEqual({ state: 'idle', sourceWorktreeId: null, workingSessionCount: 0 })
  })

  it('works while a session streams', () => {
    expect(aggregatePetStatus(input({ sessionStatuses: { a: entry('working') } }))).toEqual({
      state: 'working',
      sourceWorktreeId: 'wt-1',
      workingSessionCount: 1
    })
  })

  it('keeps working while a session is paused behind a monitor or wakeup', () => {
    expect(
      aggregatePetStatus(
        input({ sessionStatuses: { a: entry('completed', { completion: 'waiting' }) } })
      )
    ).toEqual({ state: 'working', sourceWorktreeId: 'wt-1', workingSessionCount: 1 })
  })

  it('works for a stopped session whose ticket sits in the in-progress column', () => {
    expect(
      aggregatePetStatus(
        input({
          sessionStatuses: { a: entry('completed') },
          inProgressTicketSessions: new Map([['a', 'wt-1']])
        })
      )
    ).toEqual({ state: 'working', sourceWorktreeId: 'wt-1', workingSessionCount: 1 })
  })

  it('locates an in-progress ticket session by its ticket when no worktree lists it', () => {
    expect(
      aggregatePetStatus(
        input({
          sessionStatuses: { b: entry('unread') },
          worktreeSessions: new Map(),
          inProgressTicketSessions: new Map([['b', 'wt-ticket']])
        })
      )
    ).toEqual({ state: 'working', sourceWorktreeId: 'wt-ticket', workingSessionCount: 1 })
  })

  it('keeps attention states for in-progress ticket sessions and counts them', () => {
    expect(
      aggregatePetStatus(
        input({
          sessionStatuses: { a: entry('permission') },
          inProgressTicketSessions: new Map([['a', 'wt-1']])
        })
      )
    ).toEqual({ state: 'permission', sourceWorktreeId: 'wt-1', workingSessionCount: 1 })
  })

  it('counts every in-progress session once', () => {
    expect(
      aggregatePetStatus(
        input({
          sessionStatuses: {
            a: entry('working'),
            b: entry('completed', { completion: 'waiting' }),
            c: entry('completed'),
            d: entry('completed', { completion: 'completed' })
          },
          worktreeSessions: new Map([
            ['wt-1', [{ id: 'a' }, { id: 'b' }]],
            ['wt-2', [{ id: 'c' }, { id: 'd' }]]
          ]),
          inProgressTicketSessions: new Map([
            ['a', 'wt-1'],
            ['c', 'wt-2']
          ])
        })
      ).workingSessionCount
    ).toBe(3)
  })

  it('does not count an in-progress ticket whose session the app does not know', () => {
    expect(
      aggregatePetStatus(input({ inProgressTicketSessions: new Map([['ghost', 'wt-1']]) }))
    ).toEqual({ state: 'idle', sourceWorktreeId: null, workingSessionCount: 0 })
  })
})
