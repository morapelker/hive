import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    updateSettings: vi.fn()
  }
}))

import { useConnectionStore, type Connection } from '@/stores/useConnectionStore'
import {
  connectionArchiveLabel,
  trackConnectionArchives,
  withArchivingConnections
} from './connection-archive'

const member = (connectionId: string, worktreeId: string): Connection['members'][number] => ({
  id: `member-${connectionId}-${worktreeId}`,
  connection_id: connectionId,
  worktree_id: worktreeId,
  project_id: `proj-${worktreeId}`,
  symlink_name: worktreeId,
  added_at: '2026-01-01',
  worktree_name: worktreeId,
  worktree_branch: `branch-${worktreeId}`,
  worktree_path: `/tmp/${worktreeId}`,
  project_name: `proj-${worktreeId}`
})

const connection = (id: string, worktreeIds: string[]): Connection => ({
  id,
  name: id,
  custom_name: null,
  status: 'active',
  path: `/tmp/${id}`,
  color: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  members: worktreeIds.map((worktreeId) => member(id, worktreeId))
})

const progressOf = (id: string): { done: number; total: number } | undefined => {
  const progress = useConnectionStore.getState().archivingConnections[id]
  return progress && { done: progress.done, total: progress.total }
}

describe('connection archive progress', () => {
  beforeEach(() => {
    useConnectionStore.setState({
      connections: [
        connection('conn-a', ['wt-1', 'wt-2']),
        connection('conn-b', ['wt-3']),
        connection('conn-c', ['wt-2', 'wt-4'])
      ],
      archivingConnections: {}
    })
  })

  afterEach(() => {
    useConnectionStore.setState({ connections: [], archivingConnections: {} })
  })

  it('labels the member being archived out of the batch', () => {
    expect(connectionArchiveLabel({ done: 0, total: 3 })).toBe('Archiving 1/3')
    expect(connectionArchiveLabel({ done: 2, total: 3 })).toBe('Archiving 3/3')
    // The last member has ended and the row is about to go: never "4/3"
    expect(connectionArchiveLabel({ done: 3, total: 3 })).toBe('Archiving 3/3')
  })

  it('counts members as their archive ends and forgets the batch at the end', () => {
    const store = useConnectionStore.getState()
    store.beginConnectionArchive('conn-a', 2)
    expect(progressOf('conn-a')).toEqual({ done: 0, total: 2 })

    store.advanceConnectionArchive('conn-a')
    store.advanceConnectionArchive('conn-a')
    store.advanceConnectionArchive('conn-a')
    expect(progressOf('conn-a')).toEqual({ done: 2, total: 2 })

    store.endConnectionArchive('conn-a')
    expect(useConnectionStore.getState().archivingConnections).toEqual({})
  })

  it('tracks nothing for an unknown connection or an empty batch', () => {
    const store = useConnectionStore.getState()
    store.beginConnectionArchive('conn-missing', 2)
    store.beginConnectionArchive('conn-a', 0)
    store.advanceConnectionArchive('conn-a')
    expect(useConnectionStore.getState().archivingConnections).toEqual({})
  })

  it('keeps the row of an archiving connection as it was, where it was', () => {
    const [a, b, c] = useConnectionStore.getState().connections
    useConnectionStore.getState().beginConnectionArchive('conn-b', 1)
    useConnectionStore.getState().beginConnectionArchive('conn-c', 2)
    const archiving = useConnectionStore.getState().archivingConnections

    // conn-c lost a member (its name follows its members), conn-b was deleted with its last one
    const shrunk = { ...c, name: 'shrunk', members: c.members.slice(1) }
    expect(withArchivingConnections([a, shrunk], archiving)).toEqual([a, b, c])
    expect(withArchivingConnections([a], archiving)).toEqual([a, b, c])
  })

  it('returns the list untouched while nothing is being archived', () => {
    const connections = useConnectionStore.getState().connections
    expect(withArchivingConnections(connections, {})).toBe(connections)
  })

  describe('trackConnectionArchives', () => {
    it('tracks the connections a batch takes down whole, not the ones that keep a member', () => {
      const tracker = trackConnectionArchives(['wt-1', 'wt-2', 'wt-3'])
      expect(progressOf('conn-a')).toEqual({ done: 0, total: 2 })
      expect(progressOf('conn-b')).toEqual({ done: 0, total: 1 })
      // wt-4 stays: conn-c only loses a member
      expect(progressOf('conn-c')).toBeUndefined()

      tracker.settled('wt-2')
      expect(progressOf('conn-a')).toEqual({ done: 1, total: 2 })
      expect(progressOf('conn-b')).toEqual({ done: 0, total: 1 })

      tracker.end()
      expect(useConnectionStore.getState().archivingConnections).toEqual({})
    })

    it('releases a connection whose worktree is kept after all', () => {
      const tracker = trackConnectionArchives(['wt-1', 'wt-2', 'wt-3'])
      tracker.release(['wt-1'])
      expect(progressOf('conn-a')).toBeUndefined()
      expect(progressOf('conn-b')).toEqual({ done: 0, total: 1 })

      // A released connection is no longer counted
      tracker.settled('wt-2')
      expect(progressOf('conn-a')).toBeUndefined()
      tracker.end()
    })

    it('leaves a connection that another batch is archiving to that batch', () => {
      useConnectionStore.getState().beginConnectionArchive('conn-b', 1)
      const tracker = trackConnectionArchives(['wt-3'])
      tracker.settled('wt-3')
      tracker.end()
      expect(progressOf('conn-b')).toEqual({ done: 0, total: 1 })
    })
  })
})
