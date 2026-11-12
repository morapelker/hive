/**
 * The override behind a shift-drag from Merged to Done: the ticket's worktrees are queued
 * for the archive/keep step as they are — nothing is pulled, and no branch is checked for
 * uncommitted changes or unmerged commits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'

const dbApiMocks = vi.hoisted(() => ({ worktree: { get: vi.fn() } }))
const connectionApiMocks = vi.hoisted(() => ({ get: vi.fn() }))
const connectionMerge = vi.hoisted(() => ({ resolveTicketConnectionId: vi.fn() }))
const setPendingDoneMove = vi.hoisted(() => vi.fn())
const archivingWorktreeIds = vi.hoisted(() => new Set<string>())

vi.mock('@/api/db-api', () => ({ dbApi: dbApiMocks }))
vi.mock('@/api/connection-api', () => ({ connectionApi: connectionApiMocks }))
vi.mock('@/lib/connection-merge', () => connectionMerge)
vi.mock('@/stores/useKanbanStore', () => ({
  useKanbanStore: { getState: () => ({ setPendingDoneMove }) }
}))
vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: { getState: () => ({ archivingWorktreeIds }) }
}))

import { queueArchiveOverride } from './archive-override'

const worktree = (id: string, projectId: string, overrides: Record<string, unknown> = {}) => ({
  id,
  project_id: projectId,
  branch_name: `feature-${id}`,
  path: `/repo/${id}`,
  status: 'active',
  is_default: false,
  base_branch: null,
  ...overrides
})

const worktreeTicket = {
  id: 'ticket-1',
  project_id: 'proj-web',
  worktree_id: 'wt-web',
  current_session_id: 'session-1'
} as KanbanTicket

const connectionTicket = {
  id: 'ticket-1',
  project_id: 'proj-web',
  worktree_id: null,
  current_session_id: 'session-conn'
} as KanbanTicket

const member = (worktreeId: string, projectId: string) => ({
  worktree_id: worktreeId,
  project_id: projectId
})

beforeEach(() => {
  vi.resetAllMocks()
  archivingWorktreeIds.clear()
  dbApiMocks.worktree.get.mockImplementation(async (id: string) =>
    id === 'wt-web' ? worktree('wt-web', 'proj-web') : worktree(id, 'proj-api')
  )
  connectionMerge.resolveTicketConnectionId.mockResolvedValue('conn-1')
  connectionApiMocks.get.mockResolvedValue({
    success: true,
    connection: {
      status: 'active',
      members: [member('wt-web', 'proj-web'), member('wt-api', 'proj-api')]
    }
  })
})

describe('queueArchiveOverride — a ticket with its own worktree', () => {
  it('queues the archive step for the worktree, unchecked', async () => {
    expect(await queueArchiveOverride({ ticket: worktreeTicket, sortOrder: 3 })).toBe(true)

    expect(setPendingDoneMove).toHaveBeenCalledWith({
      ticketId: 'ticket-1',
      projectId: 'proj-web',
      sortOrder: 3,
      targetColumn: 'done',
      skipMergeChecks: true
    })
    // Its own worktree is the whole story: the session's connection is never consulted
    expect(connectionMerge.resolveTicketConnectionId).not.toHaveBeenCalled()
  })

  it.each([
    ['archived', worktree('wt-web', 'proj-web', { status: 'archived' })],
    ['gone', null],
    ['the default worktree', worktree('wt-web', 'proj-web', { is_default: true })]
  ])('leaves the move to the caller when the worktree is %s', async (_label, row) => {
    dbApiMocks.worktree.get.mockResolvedValue(row)

    expect(await queueArchiveOverride({ ticket: worktreeTicket, sortOrder: 0 })).toBe(false)
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })

  it('leaves the move to the caller when the worktree is being archived already', async () => {
    archivingWorktreeIds.add('wt-web')

    expect(await queueArchiveOverride({ ticket: worktreeTicket, sortOrder: 0 })).toBe(false)
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })

  it('rejects when the worktree cannot be looked up', async () => {
    dbApiMocks.worktree.get.mockRejectedValue(new Error('db is locked'))

    await expect(queueArchiveOverride({ ticket: worktreeTicket, sortOrder: 0 })).rejects.toThrow(
      'db is locked'
    )
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })
})

describe('queueArchiveOverride — a connection ticket', () => {
  it('queues every member, the rest offered as "Archive all"', async () => {
    expect(await queueArchiveOverride({ ticket: connectionTicket, sortOrder: 2 })).toBe(true)

    expect(connectionMerge.resolveTicketConnectionId).toHaveBeenCalledWith('session-conn')
    expect(setPendingDoneMove).toHaveBeenCalledWith({
      ticketId: 'ticket-1',
      projectId: 'proj-web',
      sortOrder: 2,
      targetColumn: 'done',
      skipMergeChecks: true,
      worktreeId: 'wt-web',
      worktreeProjectId: 'proj-web',
      remainingWorktrees: [{ worktreeId: 'wt-api', projectId: 'proj-api' }],
      offerArchive: true
    })
  })

  it('leaves out members that cannot be archived, and lists a shared worktree once', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        status: 'active',
        members: [
          member('wt-main', 'proj-web'),
          member('wt-api', 'proj-api'),
          member('wt-api', 'proj-api'),
          member('wt-archived', 'proj-api')
        ]
      }
    })
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      if (id === 'wt-main') return worktree(id, 'proj-web', { is_default: true })
      if (id === 'wt-archived') return worktree(id, 'proj-api', { status: 'archived' })
      return worktree(id, 'proj-api')
    })

    expect(await queueArchiveOverride({ ticket: connectionTicket, sortOrder: 0 })).toBe(true)

    expect(setPendingDoneMove).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-api',
        worktreeProjectId: 'proj-api',
        remainingWorktrees: []
      })
    )
  })

  it.each([
    ['is deleted', { success: false, error: 'Connection not found' }],
    ['is archived', { success: true, connection: { status: 'archived', members: [] } }]
  ])('leaves the move to the caller when the connection %s', async (_label, result) => {
    connectionApiMocks.get.mockResolvedValue(result)

    expect(await queueArchiveOverride({ ticket: connectionTicket, sortOrder: 0 })).toBe(false)
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })

  it('leaves the move to the caller for a ticket with neither worktree nor connection', async () => {
    connectionMerge.resolveTicketConnectionId.mockResolvedValue(null)

    expect(await queueArchiveOverride({ ticket: connectionTicket, sortOrder: 0 })).toBe(false)
    expect(connectionApiMocks.get).not.toHaveBeenCalled()
  })

  it('rejects when the connection cannot be read', async () => {
    connectionApiMocks.get.mockResolvedValue({ success: false, error: 'tunnel closed' })

    await expect(
      queueArchiveOverride({ ticket: connectionTicket, sortOrder: 0 })
    ).rejects.toThrow('tunnel closed')
  })
})
