import { beforeEach, describe, expect, it } from 'vitest'
import { useConnectionStore } from '@/stores/useConnectionStore'
import type { Connection } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { findRedirectConnection, redirectWorktreeToConnection } from './connected-worktree-redirect'

const makeConnection = (
  id: string,
  worktreeIds: string[],
  extra: Partial<Connection> = {}
): Connection => ({
  id,
  name: id,
  custom_name: null,
  status: 'active',
  path: `/tmp/${id}`,
  color: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  members: worktreeIds.map((wt) => ({
    id: `${id}-${wt}`,
    connection_id: id,
    worktree_id: wt,
    project_id: 'p1',
    symlink_name: wt,
    added_at: '2026-01-01',
    worktree_name: wt,
    worktree_branch: wt,
    worktree_path: `/tmp/${wt}`,
    project_name: 'p1'
  })),
  ...extra
})

describe('connected worktree redirect', () => {
  beforeEach(() => {
    useSettingsStore.setState({ openConnectionForConnectedWorktree: true })
    useConnectionStore.setState({ connections: [], selectedConnectionId: null })
  })

  it('does nothing when the setting is off', () => {
    useSettingsStore.setState({ openConnectionForConnectedWorktree: false })
    useConnectionStore.setState({ connections: [makeConnection('c1', ['wt1'])] })
    expect(redirectWorktreeToConnection('wt1')).toBe(false)
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
  })

  it('does nothing for a worktree in no connection', () => {
    useConnectionStore.setState({ connections: [makeConnection('c1', ['wt2'])] })
    expect(redirectWorktreeToConnection('wt1')).toBe(false)
  })

  it('selects the connection the worktree belongs to', () => {
    useConnectionStore.setState({ connections: [makeConnection('c1', ['wt1', 'wt2'])] })
    expect(redirectWorktreeToConnection('wt1')).toBe(true)
    expect(useConnectionStore.getState().selectedConnectionId).toBe('c1')
  })

  it('skips base and archived connections', () => {
    useConnectionStore.setState({
      connections: [
        makeConnection('base', ['wt1'], { is_base: 1 }),
        makeConnection('old', ['wt1'], { status: 'archived' })
      ]
    })
    expect(findRedirectConnection('wt1')).toBeNull()
  })

  it('picks the most recently updated connection', () => {
    useConnectionStore.setState({
      connections: [
        makeConnection('older', ['wt1'], { updated_at: '2026-01-01' }),
        makeConnection('newer', ['wt1'], { updated_at: '2026-03-01' })
      ]
    })
    expect(findRedirectConnection('wt1')?.id).toBe('newer')
  })
})
