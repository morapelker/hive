import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useConnectionInstanceAggregate } from '../useSiblingAggregate'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore, type Session } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

type Connection = ReturnType<typeof useConnectionStore.getState>['connections'][number]

function makeConnection(overrides: Partial<Connection>): Connection {
  return {
    id: 'conn',
    name: 'connection',
    custom_name: null,
    status: 'active',
    path: '/tmp/conn',
    color: null,
    saved_project_id: null,
    is_base: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    members: [],
    ...overrides
  } as Connection
}

function sessions(...ids: string[]): Session[] {
  return ids.map((id) => ({ id }) as unknown as Session)
}

describe('useConnectionInstanceAggregate', () => {
  beforeEach(() => {
    useConnectionStore.setState({
      connections: [
        makeConnection({ id: 'base-1', saved_project_id: 'proj-1', is_base: 1 }),
        makeConnection({
          id: 'inst-working',
          saved_project_id: 'proj-1',
          custom_name: 'feature-a'
        }),
        makeConnection({
          id: 'inst-waiting',
          saved_project_id: 'proj-1',
          custom_name: null,
          members: [
            { project_name: 'alpha' },
            { project_name: 'beta' }
          ] as Connection['members']
        }),
        makeConnection({ id: 'inst-idle', saved_project_id: 'proj-1', custom_name: 'idle-one' }),
        makeConnection({ id: 'other-project', saved_project_id: 'proj-2', custom_name: 'other' }),
        makeConnection({ id: 'adhoc', saved_project_id: null, custom_name: 'adhoc' })
      ]
    })
    useSessionStore.setState({
      sessionsByConnection: new Map([
        ['inst-working', sessions('s-working')],
        ['inst-waiting', sessions('s-waiting')],
        ['other-project', sessions('s-other')],
        ['adhoc', sessions('s-adhoc')]
      ])
    })
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        's-working': { status: 'working', timestamp: 1 },
        's-waiting': { status: 'permission', timestamp: 1 },
        's-other': { status: 'working', timestamp: 1 },
        's-adhoc': { status: 'working', timestamp: 1 }
      }
    })
  })

  it('buckets sibling instances of the connection project, excluding the base itself', () => {
    const { result } = renderHook(() => useConnectionInstanceAggregate('proj-1', 'base-1'))

    expect(result.current.working).toEqual({ count: 1, names: ['feature-a'] })
    expect(result.current.waiting).toEqual({ count: 1, names: ['alpha + beta'] })
    expect(result.current.ready).toEqual({ count: 0, names: [] })
  })

  it('returns an empty aggregate for ad-hoc connections (no project)', () => {
    const { result } = renderHook(() => useConnectionInstanceAggregate(null, 'adhoc'))

    expect(result.current.working.count).toBe(0)
    expect(result.current.ready.count).toBe(0)
    expect(result.current.waiting.count).toBe(0)
  })

  it('reacts to status changes of sibling instances', () => {
    const { result } = renderHook(() => useConnectionInstanceAggregate('proj-1', 'base-1'))
    expect(result.current.working.count).toBe(1)

    act(() => {
      useWorktreeStatusStore.setState((state) => ({
        sessionStatuses: {
          ...state.sessionStatuses,
          's-working': { status: 'completed', timestamp: 2 }
        }
      }))
    })

    expect(result.current.working.count).toBe(0)
    expect(result.current.ready).toEqual({ count: 1, names: ['feature-a'] })
  })
})
