/**
 * "Pin to board" / "Unpin from board" for a whole project, against the real pinned, worktree
 * and connection stores and a small in-memory stand-in for the database behind the RPC client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: toastMock, gitToast: {} }))

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { isProjectPinned, setProjectPinned } from './project-pin'

interface WorktreeRow {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  pinned: number
  created_at: string
  last_accessed_at: string
}

interface ConnectionRow {
  id: string
  name: string
  status: 'active'
  path: string
  pinned: number
  saved_project_id: string | null
  is_base: number
  members: never[]
}

const worktree = (id: string, projectId: string, extra: Partial<WorktreeRow> = {}): WorktreeRow => ({
  id,
  project_id: projectId,
  name: id,
  branch_name: id,
  path: `/tmp/${projectId}/${id}`,
  status: 'active',
  is_default: false,
  pinned: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  ...extra
})

const connection = (
  id: string,
  savedProjectId: string | null,
  extra: Partial<ConnectionRow> = {}
): ConnectionRow => ({
  id,
  name: id,
  status: 'active',
  path: `/tmp/connections/${id}`,
  pinned: 0,
  saved_project_id: savedProjectId,
  is_base: 0,
  members: [],
  ...extra
})

const GIT = { id: 'ledger-worker', name: 'ledger-worker' }
const OTHER = { id: 'checkout-api', name: 'checkout-api' }
const STACK = { id: 'checkout-stack', name: 'checkout-stack', kind: 'connection' as const }

let worktrees: WorktreeRow[]
let connections: ConnectionRow[]
/** setPinned calls for these worktree / connection ids fail. */
let failing: { ids: Set<string>; mode: 'refuse' | 'throw' }
let calls: Array<{ method: string; params: Record<string, unknown> }>

function installDatabase(): void {
  setRendererRpcClient({
    request: (async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      switch (method) {
        case 'db.worktree.getActiveByProject':
          return worktrees.filter(
            (wt) => wt.project_id === params.projectId && wt.status === 'active'
          )
        case 'db.worktree.getAllActive':
          return worktrees.filter((wt) => wt.status === 'active')
        case 'db.worktree.getPinned':
          return worktrees.filter((wt) => wt.status === 'active' && wt.pinned === 1)
        case 'db.worktree.setPinned': {
          const id = params.worktreeId as string
          if (failing.ids.has(id)) {
            if (failing.mode === 'throw') throw new Error('database is locked')
            return { success: false, error: 'database is locked' }
          }
          const row = worktrees.find((wt) => wt.id === id)
          if (row) row.pinned = params.pinned ? 1 : 0
          return { success: true }
        }
        case 'connectionOps.getAll':
          return { success: true, connections: connections.map((c) => ({ ...c })) }
        case 'connectionOps.getPinned':
          return connections.filter((c) => c.pinned === 1).map((c) => ({ ...c }))
        case 'connectionOps.setPinned': {
          const id = params.connectionId as string
          if (failing.ids.has(id)) {
            if (failing.mode === 'throw') throw new Error('database is locked')
            return { success: false, error: 'database is locked' }
          }
          const row = connections.find((c) => c.id === id)
          if (row) row.pinned = params.pinned ? 1 : 0
          return { success: true }
        }
        default:
          return null
      }
    }) as never,
    subscribe: vi.fn(() => () => {})
  })
}

const pinnedInDatabase = (): string[] =>
  [
    ...worktrees.filter((wt) => wt.pinned === 1).map((wt) => wt.id),
    ...connections.filter((c) => c.pinned === 1).map((c) => c.id)
  ].sort()

const pinCalls = (): Array<Record<string, unknown>> =>
  calls
    .filter((c) => c.method === 'db.worktree.setPinned' || c.method === 'connectionOps.setPinned')
    .map((c) => c.params)

const pinnedState = (): { worktrees: string[]; connections: string[]; projects: string[] } => {
  const state = usePinnedStore.getState()
  return {
    worktrees: [...state.pinnedWorktreeIds].sort(),
    connections: [...state.pinnedConnectionIds].sort(),
    projects: [...state.pinnedProjectIds].sort()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  failing = { ids: new Set(), mode: 'refuse' }
  worktrees = [
    worktree('lw-main', GIT.id, { is_default: true, branch_name: 'main' }),
    worktree('ca-main', OTHER.id, { is_default: true, branch_name: 'main' }),
    worktree('ca-feature', OTHER.id),
    worktree('ca-fix', OTHER.id)
  ]
  connections = [
    connection('stack-base', STACK.id, { is_base: 1 }),
    connection('stack-run-1', STACK.id),
    connection('stack-run-2', STACK.id),
    connection('adhoc', null)
  ]
  installDatabase()
  usePinnedStore.setState({
    pinnedWorktreeIds: new Set(),
    pinnedConnectionIds: new Set(),
    pinnedProjectIds: new Set(),
    loaded: false
  })
  // Nothing expanded, nothing hydrated: the stores know no worktree and no connection.
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    loadedProjectIds: new Set(),
    selectedWorktreeId: null
  })
  useConnectionStore.setState({ connections: [], selectedConnectionId: null })
})

afterEach(() => {
  resetRendererRpcClientForTests()
})

describe('pinning a git project', () => {
  it('pins the default worktree of a project whose worktrees were never loaded', async () => {
    expect(useWorktreeStore.getState().worktreesByProject.has(GIT.id)).toBe(false)

    await expect(setProjectPinned(GIT, true)).resolves.toBe(true)

    expect(pinCalls()).toEqual([{ worktreeId: 'lw-main', pinned: true }])
    expect(pinnedInDatabase()).toEqual(['lw-main'])
    expect(pinnedState()).toEqual({
      worktrees: ['lw-main'],
      connections: [],
      projects: [GIT.id]
    })
    expect(isProjectPinned(GIT.id)).toBe(true)
    // The Pinned section draws the card from the worktree store: the row is there now.
    expect(
      useWorktreeStore
        .getState()
        .worktreesByProject.get(GIT.id)
        ?.map((wt) => wt.id)
    ).toEqual(['lw-main'])
    expect(toastMock.success).toHaveBeenCalledWith('Pinned ledger-worker')
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('pins the default worktree, not the most recent one', async () => {
    await setProjectPinned(OTHER, true)

    expect(pinnedInDatabase()).toEqual(['ca-main'])
    expect(pinnedState().worktrees).toEqual(['ca-main'])
  })

  it('selects nothing and expands nothing', async () => {
    await setProjectPinned(GIT, true)

    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(calls.map((c) => c.method)).not.toContain('worktreeOps.sync')
  })

  it('adds no second pin to a project that is already on the board', async () => {
    worktrees.find((wt) => wt.id === 'ca-feature')!.pinned = 1

    await expect(setProjectPinned(OTHER, true)).resolves.toBe(true)

    expect(pinCalls()).toEqual([])
    expect(pinnedInDatabase()).toEqual(['ca-feature'])
    expect(toastMock.success).toHaveBeenCalledWith('Pinned checkout-api')
  })

  it('a second request while the first is running joins it: one write, one toast', async () => {
    const [first, second] = await Promise.all([
      setProjectPinned(GIT, true),
      setProjectPinned(GIT, true)
    ])

    expect([first, second]).toEqual([true, true])
    expect(pinCalls()).toEqual([{ worktreeId: 'lw-main', pinned: true }])
    expect(toastMock.success).toHaveBeenCalledTimes(1)
  })

  it('fails with a toast when the project has no default worktree', async () => {
    worktrees = worktrees.filter((wt) => wt.project_id !== GIT.id)

    await expect(setProjectPinned(GIT, true)).resolves.toBe(false)

    expect(pinCalls()).toEqual([])
    expect(pinnedState().projects).toEqual([])
    expect(toastMock.error).toHaveBeenCalledWith('Failed to pin ledger-worker', {
      description: 'This project has no default worktree.'
    })
    expect(toastMock.success).not.toHaveBeenCalled()
  })
})

describe('unpinning a git project', () => {
  it('removes the pin from every pinned worktree of the project, and from no other', async () => {
    for (const id of ['ca-main', 'ca-feature', 'lw-main']) {
      worktrees.find((wt) => wt.id === id)!.pinned = 1
    }
    await usePinnedStore.getState().loadPinned()
    expect(pinnedState().projects).toEqual([OTHER.id, GIT.id])

    await expect(setProjectPinned(OTHER, false)).resolves.toBe(true)

    expect(pinnedInDatabase()).toEqual(['lw-main'])
    expect(pinnedState()).toEqual({ worktrees: ['lw-main'], connections: [], projects: [GIT.id] })
    expect(toastMock.success).toHaveBeenCalledWith('Unpinned checkout-api')
  })

  it('works before the pins or the worktrees were loaded', async () => {
    worktrees.find((wt) => wt.id === 'ca-feature')!.pinned = 1
    worktrees.find((wt) => wt.id === 'ca-fix')!.pinned = 1

    await expect(setProjectPinned(OTHER, false)).resolves.toBe(true)

    expect(pinnedInDatabase()).toEqual([])
    expect(pinnedState()).toEqual({ worktrees: [], connections: [], projects: [] })
  })
})

describe('a connection project', () => {
  it('pinning pins the base instance, with the connections not loaded yet', async () => {
    await expect(setProjectPinned(STACK, true)).resolves.toBe(true)

    expect(pinCalls()).toEqual([{ connectionId: 'stack-base', pinned: true }])
    expect(pinnedInDatabase()).toEqual(['stack-base'])
    expect(pinnedState()).toEqual({
      worktrees: [],
      connections: ['stack-base'],
      projects: [STACK.id]
    })
    expect(toastMock.success).toHaveBeenCalledWith('Pinned checkout-stack')
  })

  it('unpinning removes the pin from all of its instances, and leaves other connections', async () => {
    for (const id of ['stack-base', 'stack-run-1', 'adhoc']) {
      connections.find((c) => c.id === id)!.pinned = 1
    }
    await useConnectionStore.getState().loadConnections()
    await usePinnedStore.getState().loadPinned()
    expect(pinnedState().projects).toEqual([STACK.id])

    await expect(setProjectPinned(STACK, false)).resolves.toBe(true)

    expect(pinnedInDatabase()).toEqual(['adhoc'])
    expect(pinnedState()).toEqual({ worktrees: [], connections: ['adhoc'], projects: [] })
    expect(toastMock.success).toHaveBeenCalledWith('Unpinned checkout-stack')
  })

  it('fails with a toast when it has no base instance', async () => {
    connections = connections.filter((c) => c.id !== 'stack-base')

    await expect(setProjectPinned(STACK, true)).resolves.toBe(false)

    expect(pinCalls()).toEqual([])
    expect(toastMock.error).toHaveBeenCalledWith('Failed to pin checkout-stack', {
      description: 'This connection project has no base connection.'
    })
  })
})

describe('agreement with per-worktree Pin and Unpin', () => {
  beforeEach(async () => {
    // As after expanding the project: its worktrees are in the store.
    await useWorktreeStore.getState().loadWorktrees(OTHER.id, { force: true })
    await usePinnedStore.getState().loadPinned()
  })

  it('pinning one worktree makes the project pinned; unpinning the project unpins that worktree', async () => {
    expect(isProjectPinned(OTHER.id)).toBe(false)

    await usePinnedStore.getState().pinWorktree('ca-feature')
    expect(isProjectPinned(OTHER.id)).toBe(true)

    await setProjectPinned(OTHER, false)
    expect(usePinnedStore.getState().isWorktreePinned('ca-feature')).toBe(false)
    expect(isProjectPinned(OTHER.id)).toBe(false)
    expect(pinnedInDatabase()).toEqual([])
  })

  it('pinning the project shows its default worktree as pinned; unpinning that worktree unpins the project', async () => {
    await setProjectPinned(OTHER, true)
    expect(usePinnedStore.getState().isWorktreePinned('ca-main')).toBe(true)

    await usePinnedStore.getState().unpinWorktree('ca-main')
    expect(isProjectPinned(OTHER.id)).toBe(false)
  })

  it('the project stays pinned while another of its worktrees is', async () => {
    await setProjectPinned(OTHER, true)
    await usePinnedStore.getState().pinWorktree('ca-feature')

    await usePinnedStore.getState().unpinWorktree('ca-main')
    expect(isProjectPinned(OTHER.id)).toBe(true)

    await usePinnedStore.getState().unpinWorktree('ca-feature')
    expect(isProjectPinned(OTHER.id)).toBe(false)
  })
})

describe('a pin that fails', () => {
  it.each(['refuse', 'throw'] as const)(
    'leaves an unpinned project unpinned (the write %ss)',
    async (mode) => {
      failing = { ids: new Set(['lw-main']), mode }
      await usePinnedStore.getState().loadPinned()
      const before = pinnedState()

      await expect(setProjectPinned(GIT, true)).resolves.toBe(false)

      expect(pinnedState()).toEqual(before)
      expect(pinnedInDatabase()).toEqual([])
      expect(toastMock.error).toHaveBeenCalledWith('Failed to pin ledger-worker', {
        description: 'database is locked'
      })
      expect(toastMock.success).not.toHaveBeenCalled()
    }
  )

  it('an unpin that fails on the second worktree puts the first one back', async () => {
    for (const id of ['ca-main', 'ca-feature', 'ca-fix']) {
      worktrees.find((wt) => wt.id === id)!.pinned = 1
    }
    await usePinnedStore.getState().loadPinned()
    const before = pinnedState()
    const second = worktrees.filter((wt) => wt.pinned === 1)[1].id
    failing = { ids: new Set([second]), mode: 'refuse' }

    await expect(setProjectPinned(OTHER, false)).resolves.toBe(false)

    expect(pinnedInDatabase()).toEqual(['ca-feature', 'ca-fix', 'ca-main'])
    expect(pinnedState()).toEqual(before)
    expect(isProjectPinned(OTHER.id)).toBe(true)
    expect(toastMock.error).toHaveBeenCalledWith('Failed to unpin checkout-api', {
      description: 'database is locked'
    })
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('an unpin that cannot read the pins changes nothing', async () => {
    worktrees.find((wt) => wt.id === 'ca-main')!.pinned = 1
    await usePinnedStore.getState().loadPinned()
    const before = pinnedState()
    setRendererRpcClient({
      request: (async (method: string) => {
        calls.push({ method, params: {} })
        throw new Error('server is not reachable')
      }) as never,
      subscribe: vi.fn(() => () => {})
    })

    await expect(setProjectPinned(OTHER, false)).resolves.toBe(false)

    expect(pinnedState()).toEqual(before)
    expect(pinnedInDatabase()).toEqual(['ca-main'])
    expect(toastMock.error).toHaveBeenCalledWith('Failed to unpin checkout-api', {
      description: 'server is not reachable'
    })
  })

  it('can be tried again once the cause is gone', async () => {
    failing = { ids: new Set(['lw-main']), mode: 'refuse' }
    await expect(setProjectPinned(GIT, true)).resolves.toBe(false)

    failing = { ids: new Set(), mode: 'refuse' }
    await expect(setProjectPinned(GIT, true)).resolves.toBe(true)
    expect(pinnedState().projects).toEqual([GIT.id])
  })
})
