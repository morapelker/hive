import { describe, expect, it } from 'vitest'
import { resolveConnectionGitMembers, connectionMemberProjectIds } from '../connection-git-view'
import type { Connection, ConnectionMemberEnriched } from '@/stores/useConnectionStore'

function member(overrides: Partial<ConnectionMemberEnriched>): ConnectionMemberEnriched {
  return {
    id: 'm',
    connection_id: 'conn-1',
    worktree_id: 'wt',
    project_id: 'proj',
    symlink_name: 'proj',
    added_at: '2026-01-01T00:00:00.000Z',
    worktree_name: 'feature',
    worktree_branch: 'feature',
    worktree_path: '/wt/feature',
    project_name: 'Proj',
    ...overrides
  }
}

const connection: Connection = {
  id: 'conn-1',
  name: 'a + b',
  custom_name: null,
  status: 'active',
  path: '/connections/conn-1',
  color: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  members: [
    member({
      id: 'm-a',
      worktree_id: 'wt-a',
      project_id: 'proj-a',
      project_name: 'A',
      worktree_path: '/a/feature',
      symlink_name: 'a'
    }),
    member({
      id: 'm-b',
      worktree_id: 'wt-b',
      project_id: 'proj-b',
      project_name: 'B',
      worktree_path: '/b/feature',
      symlink_name: 'b'
    })
  ]
}

const worktreesByProject = new Map([
  [
    'proj-a',
    [
      {
        id: 'wt-a',
        name: 'feature',
        branch_name: 'feature',
        path: '/a/feature',
        is_default: false
      },
      { id: 'wt-a-main', name: 'main', branch_name: 'main', path: '/a', is_default: true }
    ]
  ],
  [
    'proj-b',
    [
      { id: 'wt-b-main', name: 'master', branch_name: 'master', path: '/b', is_default: true },
      { id: 'wt-b', name: 'feature', branch_name: 'feature', path: '/b/feature', is_default: false }
    ]
  ]
])

describe('resolveConnectionGitMembers', () => {
  it('returns the connection members themselves for the connection view', () => {
    expect(resolveConnectionGitMembers(connection, 'connection', worktreesByProject)).toBe(
      connection.members
    )
  })

  it('points each member project at its default worktree for the base view', () => {
    const members = resolveConnectionGitMembers(connection, 'base', worktreesByProject)
    expect(
      members.map((m) => [m.project_name, m.worktree_branch, m.worktree_path, m.worktree_id])
    ).toEqual([
      ['A', 'main', '/a', 'wt-a-main'],
      ['B', 'master', '/b', 'wt-b-main']
    ])
    // Keeps the member identity the rest of the UI keys on
    expect(members[0].connection_id).toBe('conn-1')
    expect(members[0].symlink_name).toBe('a')
    expect(members[0].id).not.toBe(members[1].id)
  })

  it('leaves out projects whose worktrees are not loaded yet', () => {
    const partial = new Map([['proj-a', worktreesByProject.get('proj-a')!]])
    const members = resolveConnectionGitMembers(connection, 'base', partial)
    expect(members.map((m) => m.project_name)).toEqual(['A'])
  })

  it('lists one base member per project even when a project contributes several worktrees', () => {
    const twice: Connection = {
      ...connection,
      members: [
        ...connection.members,
        member({ id: 'm-a2', worktree_id: 'wt-a2', project_id: 'proj-a', project_name: 'A' })
      ]
    }
    expect(connectionMemberProjectIds(twice)).toEqual(['proj-a', 'proj-b'])
    const members = resolveConnectionGitMembers(twice, 'base', worktreesByProject)
    expect(members.map((m) => m.project_id)).toEqual(['proj-a', 'proj-b'])
  })
})
