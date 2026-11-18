import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { Worktree } from '../../../../main/db/types'
import {
  describeExistingPrdFlowFiles,
  findExistingPrdFlowFiles,
  resolvePrdFlowTarget
} from './target'

// Where a PRD flow runs, against the real project, worktree and connection stores: a git
// project's main checkout, a connection project's base instance, and why a project has neither.
// Then the look for documents that are already there, and the sentence said about them.

const mocks = vi.hoisted(() => ({ exists: vi.fn() }))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))
vi.mock('@/api/worktree-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/worktree-api')>()
  return { ...actual, worktreeApi: { ...actual.worktreeApi, exists: mocks.exists } }
})

const GIT_PROJECT = 'project-shop'
const CONNECTION_PROJECT = 'project-suite'
const MAIN_CHECKOUT = '/repo/shop'
const BASE_PATH = '/connections/suite-base'

const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()

type Connection = ReturnType<typeof useConnectionStore.getState>['connections'][number]

const worktree = (overrides: Partial<Worktree>): Worktree =>
  ({
    id: 'wt-main',
    project_id: GIT_PROJECT,
    name: '(no-worktree)',
    branch_name: 'main',
    path: MAIN_CHECKOUT,
    status: 'active',
    is_default: true,
    ...overrides
  }) as Worktree

const member = (symlinkName: string): Connection['members'][number] => ({
  id: `member-${symlinkName}`,
  connection_id: 'conn-base',
  worktree_id: `wt-${symlinkName}`,
  project_id: `project-${symlinkName}`,
  symlink_name: symlinkName,
  added_at: '2026-05-04T10:00:00.000Z',
  worktree_name: '(no-worktree)',
  worktree_branch: 'main',
  worktree_path: `/repo/${symlinkName}`,
  project_name: symlinkName
})

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'conn-base',
  name: 'web + api',
  custom_name: null,
  status: 'active',
  path: BASE_PATH,
  color: null,
  saved_project_id: CONNECTION_PROJECT,
  is_base: 1,
  created_at: '2026-05-04T10:00:00.000Z',
  updated_at: '2026-05-04T10:00:00.000Z',
  members: [member('web'), member('api')],
  ...overrides
})

let loadWorktrees: ReturnType<typeof vi.fn>
let loadConnections: ReturnType<typeof vi.fn>

const seedWorktrees = (worktrees: Worktree[]): void =>
  useWorktreeStore.setState({ worktreesByProject: new Map([[GIT_PROJECT, worktrees]]) })

beforeAll(
  () =>
    // Absorb the settings store's one-shot import timer so it cannot reset state mid-test.
    new Promise((resolve) => setTimeout(resolve, 220))
)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.exists.mockResolvedValue(false)
  loadWorktrees = vi.fn(async () => undefined)
  loadConnections = vi.fn(async () => undefined)
  useProjectStore.setState(
    {
      ...initialProjectState,
      projects: [
        { id: GIT_PROJECT, name: 'Shop', path: MAIN_CHECKOUT, kind: 'git' },
        { id: CONNECTION_PROJECT, name: 'Suite', path: '/connections/suite', kind: 'connection' }
      ] as never
    },
    true
  )
  useWorktreeStore.setState(
    { ...initialWorktreeState, worktreesByProject: new Map(), loadWorktrees } as never,
    true
  )
  useConnectionStore.setState(
    { ...initialConnectionState, connections: [], loadConnections } as never,
    true
  )
})

describe('resolvePrdFlowTarget', () => {
  it('refuses a project this page does not know', async () => {
    await expect(resolvePrdFlowTarget('project-unknown')).resolves.toEqual({
      ok: false,
      error: 'The project was not found.'
    })
    expect(loadWorktrees).not.toHaveBeenCalled()
    expect(loadConnections).not.toHaveBeenCalled()
  })

  describe('a git project', () => {
    it('runs in its main checkout: the default worktree, with no member directories', async () => {
      seedWorktrees([
        worktree({ id: 'wt-feature', is_default: false, path: '/worktrees/shop--feature' }),
        worktree({})
      ])

      await expect(resolvePrdFlowTarget(GIT_PROJECT)).resolves.toEqual({
        ok: true,
        target: {
          checkout: { kind: 'worktree', worktreeId: 'wt-main' },
          cwd: MAIN_CHECKOUT,
          memberDirs: []
        }
      })
    })

    it('loads the worktrees of a project that was never opened on this page', async () => {
      loadWorktrees.mockImplementation(async () => seedWorktrees([worktree({})]))

      const result = await resolvePrdFlowTarget(GIT_PROJECT)

      expect(loadWorktrees).toHaveBeenCalledTimes(1)
      expect(loadWorktrees).toHaveBeenCalledWith(GIT_PROJECT)
      expect(result).toMatchObject({ ok: true, target: { cwd: MAIN_CHECKOUT } })
    })

    it('asks past the cache once when the loaded worktrees hold no main checkout', async () => {
      loadWorktrees.mockImplementation(async (_projectId: string, opts?: { force?: boolean }) => {
        // What the cache holds is stale; only a forced read brings the main checkout.
        seedWorktrees(opts?.force ? [worktree({})] : [worktree({ is_default: false })])
      })

      const result = await resolvePrdFlowTarget(GIT_PROJECT)

      expect(loadWorktrees.mock.calls).toEqual([[GIT_PROJECT], [GIT_PROJECT, { force: true }]])
      expect(result).toMatchObject({
        ok: true,
        target: { checkout: { kind: 'worktree', worktreeId: 'wt-main' } }
      })
    })

    it('refuses a project without a main checkout', async () => {
      seedWorktrees([worktree({ id: 'wt-feature', is_default: false })])

      await expect(resolvePrdFlowTarget(GIT_PROJECT)).resolves.toEqual({
        ok: false,
        error: 'This project has no main checkout to run in.'
      })
    })
  })

  describe('a connection project', () => {
    it('runs on its base instance, with one member directory per member', async () => {
      useConnectionStore.setState({
        connections: [
          // An instance made for a ticket is not the project's root.
          connection({ id: 'conn-ticket', is_base: 0, path: '/connections/suite-ticket' }),
          connection()
        ]
      })

      await expect(resolvePrdFlowTarget(CONNECTION_PROJECT)).resolves.toEqual({
        ok: true,
        target: {
          checkout: { kind: 'connection', connectionId: 'conn-base' },
          cwd: BASE_PATH,
          memberDirs: ['web', 'api']
        }
      })
      expect(loadConnections).not.toHaveBeenCalled()
      expect(loadWorktrees).not.toHaveBeenCalled()
    })

    it('names each member directory once and skips a member without one', async () => {
      useConnectionStore.setState({
        connections: [
          connection({ members: [member('web'), member(''), member('api'), member('web')] })
        ]
      })

      const result = await resolvePrdFlowTarget(CONNECTION_PROJECT)

      expect(result).toMatchObject({ ok: true, target: { memberDirs: ['web', 'api'] } })
    })

    it('loads the connections when the base instance is not on this page yet', async () => {
      loadConnections.mockImplementation(async () => {
        useConnectionStore.setState({ connections: [connection()] })
      })

      const result = await resolvePrdFlowTarget(CONNECTION_PROJECT)

      expect(loadConnections).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({
        ok: true,
        target: { checkout: { kind: 'connection', connectionId: 'conn-base' }, cwd: BASE_PATH }
      })
    })

    it('refuses a project whose base instance cannot be found', async () => {
      useConnectionStore.setState({
        connections: [
          connection({ id: 'conn-ticket', is_base: 0 }),
          // The base instance of another project.
          connection({ id: 'conn-other', saved_project_id: 'project-other' })
        ]
      })

      await expect(resolvePrdFlowTarget(CONNECTION_PROJECT)).resolves.toEqual({
        ok: false,
        error: 'This project has no base instance to run in.'
      })
      expect(loadConnections).toHaveBeenCalledTimes(1)
    })

    it('refuses a base instance that was archived', async () => {
      useConnectionStore.setState({ connections: [connection({ status: 'archived' })] })

      await expect(resolvePrdFlowTarget(CONNECTION_PROJECT)).resolves.toEqual({
        ok: false,
        error: 'This project has no base instance to run in.'
      })
    })
  })
})

describe('findExistingPrdFlowFiles', () => {
  const onDisk = (...paths: string[]): void => {
    mocks.exists.mockImplementation(async (path: string) => paths.includes(path))
  }

  it('finds nothing in a directory that holds neither document', async () => {
    await expect(
      findExistingPrdFlowFiles({ cwd: MAIN_CHECKOUT, memberDirs: [] }, 'CODE_MODE')
    ).resolves.toEqual([])
    expect(mocks.exists.mock.calls.map(([path]) => path)).toEqual([
      '/repo/shop/CODE_MODE_PRD.html',
      '/repo/shop/CODE_MODE_TASKS.html'
    ])
  })

  it('finds the documents that are there, the PRD before the tasks', async () => {
    onDisk('/repo/shop/CODE_MODE_TASKS.html', '/repo/shop/CODE_MODE_PRD.html')

    await expect(
      findExistingPrdFlowFiles({ cwd: MAIN_CHECKOUT, memberDirs: [] }, 'CODE_MODE')
    ).resolves.toEqual(['/repo/shop/CODE_MODE_PRD.html', '/repo/shop/CODE_MODE_TASKS.html'])
  })

  it('does not take a document of another name for it', async () => {
    onDisk('/repo/shop/CODE_PRD.html')

    await expect(
      findExistingPrdFlowFiles({ cwd: MAIN_CHECKOUT, memberDirs: [] }, 'CODE_MODE')
    ).resolves.toEqual([])
  })

  it('looks inside the member directories of a connection directory too', async () => {
    onDisk(`${BASE_PATH}/api/CODE_MODE_PRD.html`, `${BASE_PATH}/web/CODE_MODE_TASKS.html`)

    await expect(
      findExistingPrdFlowFiles({ cwd: BASE_PATH, memberDirs: ['web', 'api'] }, 'CODE_MODE')
    ).resolves.toEqual([
      `${BASE_PATH}/api/CODE_MODE_PRD.html`,
      `${BASE_PATH}/web/CODE_MODE_TASKS.html`
    ])
    expect(mocks.exists.mock.calls.map(([path]) => path)).toEqual([
      `${BASE_PATH}/CODE_MODE_PRD.html`,
      `${BASE_PATH}/web/CODE_MODE_PRD.html`,
      `${BASE_PATH}/api/CODE_MODE_PRD.html`,
      `${BASE_PATH}/CODE_MODE_TASKS.html`,
      `${BASE_PATH}/web/CODE_MODE_TASKS.html`,
      `${BASE_PATH}/api/CODE_MODE_TASKS.html`
    ])
  })

  it('rejects when the directory could not be looked at, rather than finding nothing', async () => {
    mocks.exists.mockRejectedValue(new Error('WebSocket is not open'))

    await expect(
      findExistingPrdFlowFiles({ cwd: MAIN_CHECKOUT, memberDirs: [] }, 'CODE_MODE')
    ).rejects.toThrow('WebSocket is not open')
  })
})

describe('describeExistingPrdFlowFiles', () => {
  it('names the one document that is there and its directory', () => {
    expect(describeExistingPrdFlowFiles(['/repo/shop/CODE_MODE_PRD.html'])).toBe(
      'CODE_MODE_PRD.html already exists in /repo/shop. Pick another name, or remove the file.'
    )
    expect(describeExistingPrdFlowFiles(['/repo/shop/CODE_MODE_TASKS.html'])).toBe(
      'CODE_MODE_TASKS.html already exists in /repo/shop. Pick another name, or remove the file.'
    )
  })

  it('names both documents when both are there', () => {
    expect(
      describeExistingPrdFlowFiles([
        '/repo/shop/CODE_MODE_PRD.html',
        '/repo/shop/CODE_MODE_TASKS.html'
      ])
    ).toBe(
      'CODE_MODE_PRD.html and CODE_MODE_TASKS.html already exist in /repo/shop. Pick another name, or remove the files.'
    )
  })

  it('names the member directory a document was found in', () => {
    expect(describeExistingPrdFlowFiles([`${BASE_PATH}/api/CODE_MODE_PRD.html`])).toBe(
      `CODE_MODE_PRD.html already exists in ${BASE_PATH}/api. Pick another name, or remove the file.`
    )
  })

  it('names a document once when it is there in two directories', () => {
    expect(
      describeExistingPrdFlowFiles([
        `${BASE_PATH}/CODE_MODE_PRD.html`,
        `${BASE_PATH}/web/CODE_MODE_PRD.html`
      ])
    ).toBe(
      `CODE_MODE_PRD.html already exists in ${BASE_PATH}. Pick another name, or remove the file.`
    )
  })

  it('reads a Windows path by its own separator', () => {
    expect(describeExistingPrdFlowFiles(['C:\\repo\\shop\\CODE_MODE_PRD.html'])).toBe(
      'CODE_MODE_PRD.html already exists in C:\\repo\\shop. Pick another name, or remove the file.'
    )
  })
})
