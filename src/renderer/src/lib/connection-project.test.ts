import { beforeEach, describe, expect, it } from 'vitest'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import {
  baseInstanceLabel,
  computeWorktreeNameSets,
  findBaseInstanceConnection,
  getMemberProjects,
  isBaseInstance,
  isConnectionProject,
  parseMemberProjectIds,
  sortInstancesBaseLast
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

describe('connection-project base instance helpers', () => {
  const makeConnection = (
    id: string,
    extra: Record<string, unknown> = {}
  ): { id: string; saved_project_id?: string | null; is_base?: number } =>
    ({
      id,
      name: id,
      custom_name: null,
      status: 'active',
      path: `/tmp/connections/${id}`,
      color: null,
      saved_project_id: 'saved',
      is_base: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      members: [],
      ...extra
    }) as never

  beforeEach(() => {
    useConnectionStore.setState({ connections: [] })
  })

  it('isBaseInstance requires the flag AND a live connection project', () => {
    expect(isBaseInstance({ id: 'c', is_base: 1, saved_project_id: 'p' })).toBe(true)
    expect(isBaseInstance({ id: 'c', is_base: 0, saved_project_id: 'p' })).toBe(false)
    // Orphan: the project was removed, so the row is an ordinary connection again
    expect(isBaseInstance({ id: 'c', is_base: 1, saved_project_id: null })).toBe(false)
    expect(isBaseInstance({ id: 'c', is_base: 1 })).toBe(false)
    expect(isBaseInstance({ id: 'c' })).toBe(false)
    expect(isBaseInstance(null)).toBe(false)
  })

  it('findBaseInstanceConnection returns the base of the given project only', () => {
    useConnectionStore.setState({
      connections: [
        makeConnection('inst'),
        makeConnection('other-base', { saved_project_id: 'other', is_base: 1 }),
        makeConnection('base', { is_base: 1 })
      ] as never
    })
    expect(findBaseInstanceConnection('saved')?.id).toBe('base')
    expect(findBaseInstanceConnection('other')?.id).toBe('other-base')
    expect(findBaseInstanceConnection('missing')).toBeNull()
  })

  it('baseInstanceLabel joins the distinct member branches, falling back to "main"', () => {
    expect(baseInstanceLabel([{ worktree_branch: 'main' }, { worktree_branch: 'main' }])).toBe('main')
    expect(baseInstanceLabel([{ worktree_branch: 'main' }, { worktree_branch: 'master' }])).toBe(
      'main + master'
    )
    expect(baseInstanceLabel([{ worktree_branch: '' }, { worktree_branch: null }])).toBe('main')
    expect(baseInstanceLabel([])).toBe('main')
    expect(baseInstanceLabel(undefined)).toBe('main')
  })

  it('sortInstancesBaseLast keeps user instances in order and moves the base to the end', () => {
    const sorted = sortInstancesBaseLast([
      makeConnection('base', { is_base: 1 }),
      makeConnection('b'),
      makeConnection('a')
    ])
    expect(sorted.map((c) => c.id)).toEqual(['b', 'a', 'base'])
    expect(sortInstancesBaseLast([]).length).toBe(0)
  })

  it('an orphaned base (project removed) sorts and reads as an ordinary instance', () => {
    const orphan = makeConnection('orphan', { is_base: 1, saved_project_id: null })
    expect(isBaseInstance(orphan)).toBe(false)
    expect(sortInstancesBaseLast([orphan, makeConnection('a')]).map((c) => c.id)).toEqual([
      'orphan',
      'a'
    ])
    useConnectionStore.setState({ connections: [orphan] as never })
    expect(findBaseInstanceConnection('saved')).toBeNull()
  })
})
