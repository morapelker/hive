import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import {
  computeWorktreeNameSets,
  getMemberProjects,
  isConnectionProject,
  parseMemberProjectIds
} from './connection-project'

const makeProject = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name,
    path: `/tmp/${name}`,
    description: null,
    tags: null,
    language: null,
    custom_icon: null,
    detected_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    worktree_create_script: null,
    custom_commands: null,
    auto_assign_port: false,
    sort_order: 0,
    created_at: '2026-01-01',
    last_accessed_at: '2026-01-01',
    ...extra
  }) as never

const makeWorktree = (
  id: string,
  projectId: string,
  name: string,
  extra: Record<string, unknown> = {}
) =>
  ({
    id,
    project_id: projectId,
    name,
    branch_name: name,
    path: `/tmp/wt/${projectId}/${name}`,
    status: 'active',
    is_default: false,
    ...extra
  }) as never

describe('connection-project helpers', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [] })
    useWorktreeStore.setState({ worktreesByProject: new Map() })
  })

  it('parseMemberProjectIds tolerates null/garbage and filters non-strings', () => {
    expect(parseMemberProjectIds(null)).toEqual([])
    expect(parseMemberProjectIds(undefined)).toEqual([])
    expect(parseMemberProjectIds('not json')).toEqual([])
    expect(parseMemberProjectIds('{"a":1}')).toEqual([])
    expect(parseMemberProjectIds('["a", 2, "", "b"]')).toEqual(['a', 'b'])
  })

  it('isConnectionProject discriminates on kind', () => {
    expect(isConnectionProject({ id: 'p', kind: 'connection' })).toBe(true)
    expect(isConnectionProject({ id: 'p', kind: 'git' })).toBe(false)
    expect(isConnectionProject({ id: 'p' })).toBe(false)
    expect(isConnectionProject(null)).toBe(false)
  })

  it('getMemberProjects resolves member ids in order and drops removed projects', () => {
    useProjectStore.setState({
      projects: [makeProject('b', 'beta'), makeProject('a', 'alpha')]
    })
    const saved = {
      id: 'saved',
      kind: 'connection' as const,
      member_project_ids: JSON.stringify(['a', 'gone', 'b'])
    }
    expect(getMemberProjects(saved).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('computeWorktreeNameSets intersects names across ALL members, excluding default/archived', () => {
    const members = [
      { id: 'a', path: '/tmp/alpha', name: 'alpha' },
      { id: 'b', path: '/tmp/beta', name: 'beta' }
    ]
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'a',
          [
            makeWorktree('wa1', 'a', 'ticket-x'),
            makeWorktree('wa2', 'a', 'only-in-a'),
            makeWorktree('wa3', 'a', 'archived-both', { status: 'archived' }),
            makeWorktree('wa4', 'a', '(no-worktree)', { is_default: true })
          ]
        ],
        [
          'b',
          [
            makeWorktree('wb1', 'b', 'ticket-x'),
            makeWorktree('wb2', 'b', 'archived-both'),
            makeWorktree('wb3', 'b', '(no-worktree)', { is_default: true })
          ]
        ]
      ])
    })

    const sets = computeWorktreeNameSets(members)
    expect(sets.map((s) => s.name)).toEqual(['ticket-x'])
    expect(sets[0].worktrees).toEqual([
      { projectId: 'a', worktreeId: 'wa1', worktreePath: '/tmp/wt/a/ticket-x' },
      { projectId: 'b', worktreeId: 'wb1', worktreePath: '/tmp/wt/b/ticket-x' }
    ])
  })

  it('computeWorktreeNameSets returns [] when a member has no loaded worktrees', () => {
    const members = [
      { id: 'a', path: '/tmp/alpha', name: 'alpha' },
      { id: 'b', path: '/tmp/beta', name: 'beta' }
    ]
    useWorktreeStore.setState({
      worktreesByProject: new Map([['a', [makeWorktree('wa1', 'a', 'ticket-x')]]])
    })
    expect(computeWorktreeNameSets(members)).toEqual([])
  })
})
