// What a window does when it hears that a worktree is on a branch of another name
// (`worktree:branchRenamed`): everything in it that holds the branch's name follows — the
// worktree's row, the base of the worktrees cut from it (read back from the database), the
// remembered merge source and compare branch, open diff tabs, and the connections that list
// the worktree as a member.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/useKanbanStore', () => ({
  useKanbanStore: { getState: vi.fn(() => ({ detachWorktreeTickets: vi.fn() })) }
}))
vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: { getState: vi.fn(() => ({ sessionsByWorktree: new Map() })) }
}))

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { worktreeApi } from '@/api/worktree-api'
import { applyBranchRenamed } from '@/lib/branch-rename'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

const PROJECT = 'project-1'

const makeWorktree = (
  id: string,
  branch: string,
  over: { name?: string; base_branch?: string | null; project_id?: string } = {}
) => ({
  id,
  project_id: PROJECT,
  name: branch,
  branch_name: branch,
  path: `/repo/${id}`,
  status: 'active' as const,
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  pinned: 0,
  context: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  github_pr_number: null,
  github_pr_url: null,
  base_branch: null,
  ...over
})

type Row = ReturnType<typeof makeWorktree>

/** What the database answers for the project's worktrees; a test replaces it. */
let databaseRows: Row[]
let request: ReturnType<typeof vi.fn>

const requestsOf = (method: string): unknown[][] =>
  request.mock.calls.filter(([called]) => called === method)

const storeRows = (): Row[] =>
  (useWorktreeStore.getState().worktreesByProject.get(PROJECT) ?? []) as Row[]

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  databaseRows = []
  request = vi.fn(async (method: string) => {
    if (method === 'db.worktree.getActiveByProject') return databaseRows
    if (method === 'connectionOps.getAll') return { success: true, connections: [] }
    return { success: false }
  })
  setRendererRpcClient({ request, subscribe: vi.fn() })
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    loadedProjectIds: new Set(),
    worktreeOrderByProject: new Map(),
    isLoading: false,
    error: null
  })
  useGitStore.setState({
    selectedMergeBranch: new Map(),
    selectedDiffBranch: new Map(),
    defaultMergeBranch: new Map()
  })
  useConnectionStore.setState({ connections: [] })
  useFileViewerStore.getState().closeAllFiles()
})

afterEach(() => {
  resetRendererRpcClientForTests()
})

describe('applyBranchRenamed', () => {
  it('renames the row at once and reads the project back, bases of dependents included', async () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          PROJECT,
          [makeWorktree('a', 'corgi'), makeWorktree('b', 'child', { base_branch: 'corgi' })]
        ]
      ])
    })
    // What the main process wrote: the renamed row, and the dependent's base
    databaseRows = [
      makeWorktree('a', 'fix-login'),
      makeWorktree('b', 'child', { base_branch: 'fix-login' })
    ]

    applyBranchRenamed({
      worktreeId: 'a',
      newBranch: 'fix-login',
      worktreePath: '/repo/a',
      oldBranch: 'corgi',
      projectId: PROJECT
    })

    // Before any answer from the database
    expect(storeRows().find((w) => w.id === 'a')).toMatchObject({
      branch_name: 'fix-login',
      name: 'fix-login'
    })
    await settle()
    expect(requestsOf('db.worktree.getActiveByProject')).toHaveLength(1)
    expect(storeRows().find((w) => w.id === 'b')?.base_branch).toBe('fix-login')
  })

  it('finds the project of the worktree when the event does not name it', async () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([[PROJECT, [makeWorktree('a', 'corgi')]]])
    })
    databaseRows = [makeWorktree('a', 'fix-login')]

    applyBranchRenamed({ worktreeId: 'a', newBranch: 'fix-login', worktreePath: '/repo/a' })
    await settle()

    expect(requestsOf('db.worktree.getActiveByProject')).toEqual([
      ['db.worktree.getActiveByProject', { projectId: PROJECT }]
    ])
  })

  it('does not load a project this window never opened', async () => {
    applyBranchRenamed({
      worktreeId: 'a',
      newBranch: 'fix-login',
      worktreePath: '/repo/a',
      oldBranch: 'corgi',
      projectId: 'never-opened'
    })
    await settle()

    expect(requestsOf('db.worktree.getActiveByProject')).toHaveLength(0)
  })

  it('moves remembered choices of the old name to the new one, in that repository only', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [PROJECT, [makeWorktree('a', 'corgi'), makeWorktree('b', 'child')]]
      ])
    })
    useGitStore.setState({
      selectedMergeBranch: new Map([
        ['/repo/b', 'corgi'],
        ['/other-repo/x', 'corgi']
      ]),
      selectedDiffBranch: new Map([
        ['/repo/b', 'corgi'],
        ['/repo/a', 'main']
      ]),
      defaultMergeBranch: new Map([
        [PROJECT, 'corgi'],
        ['other-project', 'corgi']
      ])
    })

    applyBranchRenamed({
      worktreeId: 'a',
      newBranch: 'fix-login',
      worktreePath: '/repo/a',
      oldBranch: 'corgi',
      projectId: PROJECT
    })

    const git = useGitStore.getState()
    expect(Object.fromEntries(git.selectedMergeBranch)).toEqual({
      '/repo/b': 'fix-login',
      '/other-repo/x': 'corgi'
    })
    expect(Object.fromEntries(git.selectedDiffBranch)).toEqual({
      '/repo/b': 'fix-login',
      '/repo/a': 'main'
    })
    expect(Object.fromEntries(git.defaultMergeBranch)).toEqual({
      [PROJECT]: 'fix-login',
      'other-project': 'corgi'
    })
  })

  // A worktree that merely switched to another branch renamed nothing: the old branch is
  // still there, and a choice of it stays a choice of it.
  it('leaves remembered choices alone when the event carries no old name', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([[PROJECT, [makeWorktree('a', 'corgi')]]])
    })
    useGitStore.setState({ selectedDiffBranch: new Map([['/repo/a', 'corgi']]) })

    applyBranchRenamed({
      worktreeId: 'a',
      newBranch: 'experiment',
      worktreePath: '/repo/a',
      projectId: PROJECT
    })

    expect(useGitStore.getState().selectedDiffBranch.get('/repo/a')).toBe('corgi')
  })

  it('keeps open diff tabs comparing with the renamed branch, in place', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [PROJECT, [makeWorktree('a', 'corgi'), makeWorktree('b', 'child')]]
      ])
    })
    const viewer = useFileViewerStore.getState()
    const diff = (worktreePath: string, filePath: string, compareBranch: string) => ({
      worktreePath,
      filePath,
      fileName: filePath,
      staged: false,
      isUntracked: false,
      compareBranch
    })
    viewer.setActiveDiff(diff('/repo/b', 'a.ts', 'main'))
    viewer.setActiveDiff(diff('/other-repo/x', 'a.ts', 'corgi'))
    viewer.setActiveDiff(diff('/repo/b', 'a.ts', 'corgi'))

    applyBranchRenamed({
      worktreeId: 'a',
      newBranch: 'fix-login',
      worktreePath: '/repo/a',
      oldBranch: 'corgi',
      projectId: PROJECT
    })

    const state = useFileViewerStore.getState()
    expect(Array.from(state.openFiles.keys())).toEqual([
      'diff:/repo/b:a.ts:branch:main',
      'diff:/other-repo/x:a.ts:branch:corgi',
      'diff:/repo/b:a.ts:branch:fix-login'
    ])
    expect(state.activeFilePath).toBe('diff:/repo/b:a.ts:branch:fix-login')
    expect(state.activeDiff?.compareBranch).toBe('fix-login')
  })

  it('reloads the connections the worktree is a member of', async () => {
    const member = (worktreeId: string) => ({
      id: `m-${worktreeId}`,
      connection_id: 'c1',
      worktree_id: worktreeId,
      project_id: PROJECT,
      symlink_name: 'repo',
      added_at: '',
      worktree_name: 'corgi',
      worktree_branch: 'corgi',
      worktree_path: `/repo/${worktreeId}`,
      project_name: 'repo'
    })
    useConnectionStore.setState({
      connections: [
        {
          id: 'c1',
          name: 'stack',
          custom_name: null,
          status: 'active',
          path: '/connections/stack',
          color: null,
          created_at: '',
          updated_at: '',
          members: [member('a')]
        }
      ]
    })

    applyBranchRenamed({ worktreeId: 'unrelated', newBranch: 'x', worktreePath: '/repo/zz' })
    await settle()
    expect(requestsOf('connectionOps.getAll')).toHaveLength(0)

    applyBranchRenamed({ worktreeId: 'a', newBranch: 'fix-login', worktreePath: '/repo/a' })
    await settle()
    expect(requestsOf('connectionOps.getAll')).toHaveLength(1)
  })
})

describe('useWorktreeStore after a rename', () => {
  it('keeps a display name the user chose', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [PROJECT, [makeWorktree('a', 'corgi', { name: 'Login rework' })]]
      ])
    })

    useWorktreeStore.getState().updateWorktreeBranch('a', 'fix-login')

    expect(storeRows()[0]).toMatchObject({ branch_name: 'fix-login', name: 'Login rework' })
  })

  // A load that started before the rename must not be the answer to a reload asked after it.
  it('a forced load asked during another load runs after it, once for all who asked', async () => {
    const answers: Array<(rows: Row[]) => void> = []
    request.mockImplementation((method: string) => {
      if (method !== 'db.worktree.getActiveByProject') return Promise.resolve({ success: false })
      return new Promise<Row[]>((resolve) => answers.push(resolve))
    })
    const store = useWorktreeStore.getState()

    const first = store.loadWorktrees(PROJECT)
    const second = store.loadWorktrees(PROJECT, { force: true })
    const third = store.loadWorktrees(PROJECT, { force: true })
    expect(answers).toHaveLength(1)

    answers[0]([makeWorktree('a', 'corgi')])
    await first
    await settle()
    expect(answers).toHaveLength(2)
    answers[1]([makeWorktree('a', 'fix-login')])
    await Promise.all([second, third])

    expect(answers).toHaveLength(2)
    expect(storeRows()[0].branch_name).toBe('fix-login')
  })

  // A sync that fails before it has awaited anything is over before it was recorded as
  // running. It must not stay recorded: a forced sync asked later would wait behind it, find
  // it again when it reruns, and never stop.
  it('a sync that fails at once does not block, or trap, the forced syncs after it', async () => {
    const sync = vi.spyOn(worktreeApi, 'sync').mockImplementation(() => {
      throw new Error('no connection')
    })
    const store = useWorktreeStore.getState()

    await store.syncWorktrees(PROJECT, '/repo', { force: true })
    await Promise.all([
      store.syncWorktrees(PROJECT, '/repo', { force: true }),
      store.syncWorktrees(PROJECT, '/repo', { force: true })
    ])
    expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2)

    sync.mockResolvedValue({ success: true })
    databaseRows = [makeWorktree('a', 'fix-login')]
    await store.syncWorktrees(PROJECT, '/repo', { force: true })

    expect(storeRows()[0]?.branch_name).toBe('fix-login')
    sync.mockRestore()
  })
})
