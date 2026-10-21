/**
 * Archiving or unbranching a worktree closes every open session of it before the
 * directory goes away — those loaded into the session store AND the DB's active rows,
 * since the store only knows worktrees selected this run (a session resumed from its
 * ticket modal on the board would otherwise keep its agent running in a deleted cwd).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { closeSession, sessionsByWorktree, getActiveByWorktree, worktreeDelete } = vi.hoisted(
  () => ({
    closeSession: vi.fn(),
    sessionsByWorktree: new Map<string, Array<{ id: string }>>(),
    getActiveByWorktree: vi.fn(),
    worktreeDelete: vi.fn()
  })
)

vi.mock('../useKanbanStore', () => ({
  useKanbanStore: {
    getState: () => ({ detachWorktreeTickets: vi.fn().mockResolvedValue(undefined) })
  }
}))

vi.mock('../useSessionStore', () => ({
  useSessionStore: {
    getState: () => ({ sessionsByWorktree, closeSession })
  }
}))

vi.mock('../useConnectionStore', () => ({
  useConnectionStore: { getState: () => ({ loadConnections: vi.fn() }) }
}))

vi.mock('../usePinnedStore', () => ({
  usePinnedStore: { getState: () => ({ removeWorktree: vi.fn() }) }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: { session: { getActiveByWorktree } }
}))

vi.mock('@/api/connection-api', () => ({
  connectionApi: { removeWorktreeFromAll: vi.fn().mockResolvedValue({ success: true }) }
}))

vi.mock('@/api/worktree-api', () => ({
  worktreeApi: { delete: worktreeDelete }
}))

import { useWorktreeStore } from '../useWorktreeStore'

const WORKTREE_ID = 'wt-feature'

const archive = (): Promise<{ success: boolean; error?: string }> =>
  useWorktreeStore.getState().archiveWorktree(WORKTREE_ID, '/repo/wt-feature', 'feature', '/repo')

const unbranch = (): Promise<{ success: boolean; error?: string }> =>
  useWorktreeStore.getState().unbranchWorktree(WORKTREE_ID, '/repo/wt-feature', 'feature', '/repo')

const closedIds = (): string[] => closeSession.mock.calls.map(([id]) => id as string)

beforeEach(() => {
  vi.clearAllMocks()
  sessionsByWorktree.clear()
  closeSession.mockResolvedValue({ success: true })
  getActiveByWorktree.mockResolvedValue([])
  worktreeDelete.mockResolvedValue({ success: true })
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    selectedWorktreeId: null,
    archivingWorktreeIds: new Set()
  })
})

afterEach(() => {
  sessionsByWorktree.clear()
})

describe.each([
  ['archiveWorktree', archive],
  ['unbranchWorktree', unbranch]
] as const)('%s closes the worktree sessions', (_name, run) => {
  it('closes the sessions only the DB knows about', async () => {
    getActiveByWorktree.mockResolvedValue([{ id: 'db-only-1' }, { id: 'db-only-2' }])

    const result = await run()

    expect(result.success).toBe(true)
    expect(getActiveByWorktree).toHaveBeenCalledWith(WORKTREE_ID)
    expect(closedIds()).toEqual(['db-only-1', 'db-only-2'])
  })

  it('closes the union of store and DB sessions, each once', async () => {
    sessionsByWorktree.set(WORKTREE_ID, [{ id: 'loaded-1' }, { id: 'shared' }])
    getActiveByWorktree.mockResolvedValue([{ id: 'shared' }, { id: 'db-only' }])

    await run()

    expect(closedIds().sort()).toEqual(['db-only', 'loaded-1', 'shared'])
  })

  it('closes the store sessions when the DB read fails', async () => {
    sessionsByWorktree.set(WORKTREE_ID, [{ id: 'loaded-1' }])
    getActiveByWorktree.mockRejectedValue(new Error('db down'))

    const result = await run()

    expect(result.success).toBe(true)
    expect(closedIds()).toEqual(['loaded-1'])
  })

  it('closes the sessions before removing the worktree', async () => {
    getActiveByWorktree.mockResolvedValue([{ id: 'db-only' }])

    await run()

    expect(closeSession.mock.invocationCallOrder[0]).toBeLessThan(
      worktreeDelete.mock.invocationCallOrder[0]
    )
  })
})

describe('unbranchWorktree', () => {
  it('aborts when a DB-only session cannot be closed', async () => {
    getActiveByWorktree.mockResolvedValue([{ id: 'db-only' }])
    closeSession.mockResolvedValue({ success: false, error: 'remote stop failed' })

    const result = await unbranch()

    expect(result).toEqual({
      success: false,
      error: 'Failed to close session before unbranch: remote stop failed'
    })
    expect(worktreeDelete).not.toHaveBeenCalled()
  })
})
