import { describe, expect, it } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'
import type { SessionStatusEntry } from '@/stores/useWorktreeStatusStore'
import {
  collectInProgressSessionIds,
  collectInProgressTicketSessions,
  countInProgressSessions,
  isPausedSessionEntry
} from './in-progress-sessions'

type TicketRef = Pick<KanbanTicket, 'column' | 'current_session_id' | 'worktree_id' | 'archived_at'>

function ticket(overrides: Partial<TicketRef> = {}): TicketRef {
  return {
    column: 'in_progress',
    current_session_id: 'sess',
    worktree_id: 'wt',
    archived_at: null,
    ...overrides
  }
}

function entry(
  status: SessionStatusEntry['status'],
  extra: Partial<SessionStatusEntry> = {}
): SessionStatusEntry {
  return { status, timestamp: 1, ...extra }
}

describe('isPausedSessionEntry', () => {
  it('is true only for a completed status whose Stop was a pause', () => {
    expect(isPausedSessionEntry(entry('completed', { completion: 'waiting' }))).toBe(true)
    expect(isPausedSessionEntry(entry('completed', { completion: 'completed' }))).toBe(false)
    expect(isPausedSessionEntry(entry('completed', { completion: 'unknown' }))).toBe(false)
    expect(isPausedSessionEntry(entry('completed', { completion: 'none' }))).toBe(false)
    expect(isPausedSessionEntry(entry('completed'))).toBe(false)
    expect(isPausedSessionEntry(entry('working', { completion: 'waiting' }))).toBe(false)
    expect(isPausedSessionEntry(null)).toBe(false)
  })
})

describe('collectInProgressTicketSessions', () => {
  it('maps the sessions of live in-progress tickets to their worktrees', () => {
    const map = collectInProgressTicketSessions([
      [
        ticket({ current_session_id: 'a', worktree_id: 'wt-a' }),
        ticket({ current_session_id: 'review', column: 'review' }),
        ticket({ current_session_id: 'todo', column: 'todo' }),
        ticket({ current_session_id: 'done', column: 'done' }),
        ticket({ current_session_id: 'archived', archived_at: '2026-01-01' }),
        ticket({ current_session_id: null })
      ],
      [ticket({ current_session_id: 'b', worktree_id: null })]
    ])
    expect([...map.entries()]).toEqual([
      ['a', 'wt-a'],
      ['b', null]
    ])
  })

  it('prefers a ticket that knows the worktree when two tickets share a session', () => {
    const map = collectInProgressTicketSessions([
      [
        ticket({ current_session_id: 'a', worktree_id: null }),
        ticket({ current_session_id: 'a', worktree_id: 'wt-a' }),
        ticket({ current_session_id: 'a', worktree_id: null })
      ]
    ])
    expect(map.get('a')).toBe('wt-a')
  })
})

describe('collectInProgressSessionIds', () => {
  it('counts streaming sessions and paused ones, not finished or blocked ones', () => {
    const ids = collectInProgressSessionIds({
      working: entry('working'),
      planning: entry('planning'),
      paused: entry('completed', { completion: 'waiting' }),
      finished: entry('completed', { completion: 'completed' }),
      stopped: entry('completed'),
      unread: entry('unread'),
      permission: entry('permission'),
      cleared: null
    })
    expect([...ids].sort()).toEqual(['paused', 'planning', 'working'])
  })

  it('counts a known session linked from an in-progress ticket whatever its status', () => {
    const ids = collectInProgressSessionIds(
      {
        finished: entry('completed', { completion: 'completed' }),
        unread: entry('unread'),
        permission: entry('permission'),
        working: entry('working')
      },
      new Map([
        ['finished', 'wt'],
        ['unread', null],
        ['permission', 'wt'],
        ['unknown', 'wt']
      ])
    )
    expect([...ids].sort()).toEqual(['finished', 'permission', 'unread', 'working'])
  })

  it('ignores an in-progress ticket whose session the app does not know', () => {
    const ids = collectInProgressSessionIds({}, new Set(['ghost']))
    expect(ids.size).toBe(0)
  })
})

describe('countInProgressSessions', () => {
  it('counts each session once across statuses and tickets', () => {
    const count = countInProgressSessions(
      {
        a: entry('working'),
        b: entry('completed', { completion: 'waiting' }),
        c: entry('completed'),
        d: entry('completed')
      },
      [[ticket({ current_session_id: 'a' }), ticket({ current_session_id: 'c' })]]
    )
    expect(count).toBe(3)
  })
})
