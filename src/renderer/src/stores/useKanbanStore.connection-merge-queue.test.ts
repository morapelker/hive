import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useKanbanStore } from './useKanbanStore'

const toastMocks = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn()
}))

vi.mock('@/lib/toast', () => ({ toast: toastMocks }))

const moveTicketMock = vi.fn().mockResolvedValue(undefined)

describe('completeDoneMove — connection merge queue', () => {
  beforeEach(() => {
    moveTicketMock.mockClear()
    toastMocks.warning.mockClear()
    useKanbanStore.setState({
      moveTicket: moveTicketMock,
      pendingDoneMove: {
        ticketId: 'ticket-1',
        projectId: 'proj-a',
        sortOrder: 5,
        targetColumn: 'merged',
        worktreeId: 'wt-a',
        worktreeProjectId: 'proj-a',
        remainingWorktrees: [
          { worktreeId: 'wt-b', projectId: 'proj-b' },
          { worktreeId: 'wt-c', projectId: 'proj-c' }
        ]
      }
    })
  })

  it('advances to the next member worktree without moving the ticket', async () => {
    await useKanbanStore.getState().completeDoneMove()

    expect(moveTicketMock).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().pendingDoneMove).toEqual({
      ticketId: 'ticket-1',
      projectId: 'proj-a',
      sortOrder: 5,
      targetColumn: 'merged',
      worktreeId: 'wt-b',
      worktreeProjectId: 'proj-b',
      remainingWorktrees: [{ worktreeId: 'wt-c', projectId: 'proj-c' }]
    })
  })

  it('moves the ticket only after the last worktree completes', async () => {
    await useKanbanStore.getState().completeDoneMove() // wt-a → wt-b
    await useKanbanStore.getState().completeDoneMove() // wt-b → wt-c
    expect(moveTicketMock).not.toHaveBeenCalled()

    await useKanbanStore.getState().completeDoneMove() // wt-c done → move
    expect(moveTicketMock).toHaveBeenCalledExactlyOnceWith('ticket-1', 'proj-a', 'merged', 5)
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
  })

  it('clearPendingDoneMove cancels the whole queue', () => {
    useKanbanStore.getState().clearPendingDoneMove()
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('ignores stale completions whose identity no longer matches the pending move', async () => {
    await useKanbanStore.getState().completeDoneMove({
      ticketId: 'ticket-1',
      projectId: 'proj-a',
      worktreeId: 'wt-stale'
    })

    expect(moveTicketMock).not.toHaveBeenCalled()
    // Queue untouched — still on wt-a
    expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('wt-a')
  })

  it('completes when the expected identity matches the pending move', async () => {
    await useKanbanStore.getState().completeDoneMove({
      ticketId: 'ticket-1',
      projectId: 'proj-a',
      worktreeId: 'wt-a'
    })

    expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('wt-b')
  })

  it('continueDoneMoveAfterConflict advances past a conflicted member instead of cancelling', () => {
    useKanbanStore.getState().continueDoneMoveAfterConflict({
      ticketId: 'ticket-1',
      projectId: 'proj-a',
      worktreeId: 'wt-a'
    })

    expect(moveTicketMock).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().pendingDoneMove).toEqual({
      ticketId: 'ticket-1',
      projectId: 'proj-a',
      sortOrder: 5,
      targetColumn: 'merged',
      worktreeId: 'wt-b',
      worktreeProjectId: 'proj-b',
      remainingWorktrees: [{ worktreeId: 'wt-c', projectId: 'proj-c' }],
      conflictedWorktrees: [{ worktreeId: 'wt-a', projectId: 'proj-a' }]
    })
  })

  it('continueDoneMoveAfterConflict ignores stale identities', () => {
    useKanbanStore.getState().continueDoneMoveAfterConflict({
      ticketId: 'ticket-1',
      projectId: 'proj-a',
      worktreeId: 'wt-stale'
    })

    expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('wt-a')
    expect(useKanbanStore.getState().pendingDoneMove?.conflictedWorktrees).toBeUndefined()
  })

  it('keeps checking every member and never moves the ticket once any member conflicted', async () => {
    useKanbanStore.getState().continueDoneMoveAfterConflict() // wt-a conflicts → wt-b
    await useKanbanStore.getState().completeDoneMove() // wt-b merges → wt-c
    expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('wt-c')
    expect(useKanbanStore.getState().pendingDoneMove?.conflictedWorktrees).toEqual([
      { worktreeId: 'wt-a', projectId: 'proj-a' }
    ])

    await useKanbanStore.getState().completeDoneMove() // wt-c merges → end of queue
    expect(moveTicketMock).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Merge conflicts in 1 project — ticket not moved. Fix the conflicts and move it again.'
    )
  })

  it('accumulates conflicts across members and reports the total at the end', () => {
    useKanbanStore.getState().continueDoneMoveAfterConflict() // wt-a
    useKanbanStore.getState().continueDoneMoveAfterConflict() // wt-b
    expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('wt-c')

    useKanbanStore.getState().continueDoneMoveAfterConflict() // wt-c — last member
    expect(moveTicketMock).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Merge conflicts in 3 projects — ticket not moved. Fix the conflicts and move it again.'
    )
  })

  it('moves the ticket directly when no queue is present (single-project flow)', async () => {
    useKanbanStore.setState({
      pendingDoneMove: {
        ticketId: 'ticket-2',
        projectId: 'proj-x',
        sortOrder: 1,
        targetColumn: 'done'
      }
    })

    await useKanbanStore.getState().completeDoneMove()
    expect(moveTicketMock).toHaveBeenCalledExactlyOnceWith('ticket-2', 'proj-x', 'done', 1)
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
  })
})
