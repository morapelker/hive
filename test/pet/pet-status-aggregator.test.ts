import { describe, expect, it } from 'vitest'
import { aggregatePetStatus } from '@/lib/pet-status-aggregator'
import type { SessionStatusEntry } from '@/stores/useWorktreeStatusStore'

function entry(status: SessionStatusEntry['status']): SessionStatusEntry {
  return { status, timestamp: 1 }
}

describe('aggregatePetStatus', () => {
  it('returns idle when there are no active attention-worthy statuses', () => {
    const result = aggregatePetStatus({
      sessionStatuses: {
        s1: entry('completed'),
        s2: entry('unread')
      },
      worktreeSessions: new Map([
        ['wt1', [{ id: 's1' }]],
        ['wt2', [{ id: 's2' }]]
      ]),
      connectionSessions: new Map(),
      connections: []
    })

    expect(result).toEqual({ state: 'idle', sourceWorktreeId: null, workingSessionCount: 0 })
  })

  it('maps the highest-priority worktree status to a pet state', () => {
    const result = aggregatePetStatus({
      sessionStatuses: {
        working: entry('working'),
        permission: entry('permission')
      },
      worktreeSessions: new Map([
        ['wt-working', [{ id: 'working' }]],
        ['wt-permission', [{ id: 'permission' }]]
      ]),
      connectionSessions: new Map(),
      connections: []
    })

    expect(result).toEqual({
      state: 'permission',
      sourceWorktreeId: 'wt-permission',
      workingSessionCount: 1
    })
  })

  it('uses connection sessions for member worktrees and reports the member as the source', () => {
    const result = aggregatePetStatus({
      sessionStatuses: {
        planning: entry('planning'),
        question: entry('answering')
      },
      worktreeSessions: new Map([['wt1', [{ id: 'planning' }]]]),
      connectionSessions: new Map([['conn1', [{ id: 'question' }]]]),
      connections: [
        {
          id: 'conn1',
          members: [{ worktree_id: 'wt2' }, { worktree_id: 'wt3' }]
        }
      ]
    })

    expect(result).toEqual({ state: 'question', sourceWorktreeId: 'wt2', workingSessionCount: 1 })
  })

  it('counts all working and planning sessions across worktrees and connections', () => {
    const result = aggregatePetStatus({
      sessionStatuses: {
        working1: entry('working'),
        planning1: entry('planning'),
        planning2: entry('planning'),
        permission: entry('permission'),
        completed: entry('completed')
      },
      worktreeSessions: new Map([
        ['wt-working', [{ id: 'working1' }, { id: 'completed' }]],
        ['wt-permission', [{ id: 'permission' }]]
      ]),
      connectionSessions: new Map([['conn1', [{ id: 'planning1' }, { id: 'planning2' }]]]),
      connections: [
        {
          id: 'conn1',
          members: [{ worktree_id: 'wt-connected' }]
        }
      ]
    })

    expect(result).toEqual({
      state: 'permission',
      sourceWorktreeId: 'wt-permission',
      workingSessionCount: 3
    })
  })
})
