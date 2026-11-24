/**
 * The unpin question of a move to Done that never showed the archive step: asked once the
 * last open ticket of a pinned project lands in Done, answered with Unpin or Keep pinned, and
 * withdrawn when the project stops qualifying.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useUnpinOnDoneStore } from '@/lib/auto-unpin'
import {
  emitTicketTransition,
  resetTicketTransitionListenersForTests
} from '@/lib/ticket-transition-events'
import { UnpinOnDoneDialog } from './UnpinOnDoneDialog'

// The question is decided against the real stores, the unpin itself is recorded
const setProjectPinnedMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/project-pin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/project-pin')>()),
  setProjectPinned: setProjectPinnedMock
}))

const initialKanban = useKanbanStore.getState()

type Row = { id: string; column: string; archived_at: string | null; title: string }
const row = (id: string, column: string): Row => ({ id, column, archived_at: null, title: id })

const setTickets = (tickets: Row[]): void => {
  useKanbanStore.setState({ tickets: new Map([['project-1', tickets]]) as never })
}

/** A drop on Done as the store announces it: the ticket is in the column already. */
const dropOnDone = (others: Row[] = []): void => {
  act(() => {
    setTickets([row('ticket-1', 'done'), ...others])
    emitTicketTransition({
      ticketId: 'ticket-1',
      projectId: 'project-1',
      from: 'in_progress',
      to: 'done',
      ticket: { id: 'ticket-1', project_id: 'project-1', title: 'Fix the ledger' } as never,
      interactive: true
    })
  })
}

const dialog = (): HTMLElement => screen.getByTestId('unpin-on-done-dialog')
const queryDialog = (): HTMLElement | null => screen.queryByTestId('unpin-on-done-dialog')

describe('UnpinOnDoneDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetTicketTransitionListenersForTests()
    setProjectPinnedMock.mockResolvedValue(true)
    useUnpinOnDoneStore.setState({ offer: null })
    setTickets([row('ticket-1', 'in_progress')])
    useProjectStore.setState({ projects: [{ id: 'project-1', name: 'ledger-worker' }] as never })
    // On the pinned board through its default worktree, where the ticket ran
    useWorktreeStore.setState({
      worktreesByProject: new Map([['project-1', [{ id: 'worktree-main' }]]]) as never
    })
    usePinnedStore.setState({
      pinnedProjectIds: new Set(['project-1']),
      pinnedWorktreeIds: new Set(['worktree-main']),
      pinnedConnectionIds: new Set(),
      loaded: true
    })
  })

  afterEach(() => {
    cleanup()
    resetTicketTransitionListenersForTests()
    useKanbanStore.setState(initialKanban, true)
    useProjectStore.setState({ projects: [] })
    useWorktreeStore.setState({ worktreesByProject: new Map() })
    usePinnedStore.setState({ pinnedProjectIds: new Set(), pinnedWorktreeIds: new Set() })
  })

  it('shows nothing until a ticket is moved to Done', () => {
    render(<UnpinOnDoneDialog />)

    expect(queryDialog()).toBeNull()
  })

  it('asks whether to unpin the project once its last open ticket is in Done', () => {
    render(<UnpinOnDoneDialog />)

    dropOnDone()

    expect(within(dialog()).getByText('Unpin project?')).toBeTruthy()
    expect(dialog().textContent).toContain('Fix the ledger')
    expect(dialog().textContent).toContain('ledger-worker')
    expect(within(dialog()).getByRole('button', { name: 'Unpin' })).toBeTruthy()
    expect(within(dialog()).getByRole('button', { name: 'Keep pinned' })).toBeTruthy()
    expect(setProjectPinnedMock).not.toHaveBeenCalled()
  })

  it('Unpin takes the project off the pinned board and closes', async () => {
    render(<UnpinOnDoneDialog />)
    dropOnDone()

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Unpin' }))

    await waitFor(() =>
      expect(setProjectPinnedMock).toHaveBeenCalledWith(
        { id: 'project-1', name: 'ledger-worker', kind: 'git' },
        false
      )
    )
    expect(setProjectPinnedMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(queryDialog()).toBeNull())
  })

  it('Keep pinned closes and leaves the project on the board', async () => {
    render(<UnpinOnDoneDialog />)
    dropOnDone()

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Keep pinned' }))

    await waitFor(() => expect(queryDialog()).toBeNull())
    expect(useUnpinOnDoneStore.getState().offer).toBeNull()
    expect(setProjectPinnedMock).not.toHaveBeenCalled()
  })

  it('Escape closes and leaves the project on the board', async () => {
    render(<UnpinOnDoneDialog />)
    dropOnDone()

    fireEvent.keyDown(dialog(), { key: 'Escape' })

    await waitFor(() => expect(queryDialog()).toBeNull())
    expect(setProjectPinnedMock).not.toHaveBeenCalled()
  })

  it('does not ask while another ticket of the project is still open', () => {
    render(<UnpinOnDoneDialog />)

    dropOnDone([row('ticket-2', 'review')])

    expect(queryDialog()).toBeNull()
  })

  it('does not ask for a project that is not pinned', () => {
    usePinnedStore.setState({ pinnedProjectIds: new Set(), pinnedWorktreeIds: new Set() })
    render(<UnpinOnDoneDialog />)

    dropOnDone()

    expect(queryDialog()).toBeNull()
  })

  it('withdraws the question when a ticket of the project is opened meanwhile', async () => {
    render(<UnpinOnDoneDialog />)
    dropOnDone()
    expect(dialog()).toBeTruthy()

    act(() => setTickets([row('ticket-1', 'done'), row('ticket-2', 'todo')]))

    await waitFor(() => expect(queryDialog()).toBeNull())
    expect(useUnpinOnDoneStore.getState().offer).toBeNull()
    // Not asked again once that ticket is gone: the move it was about is long over
    act(() => setTickets([row('ticket-1', 'done')]))
    expect(queryDialog()).toBeNull()
  })

  it('withdraws the question when the project is unpinned some other way', async () => {
    render(<UnpinOnDoneDialog />)
    dropOnDone()

    act(() =>
      usePinnedStore.setState({ pinnedProjectIds: new Set(), pinnedWorktreeIds: new Set() })
    )

    await waitFor(() => expect(queryDialog()).toBeNull())
    expect(setProjectPinnedMock).not.toHaveBeenCalled()
  })

  it('waits behind the merge-on-done dialog of another move', async () => {
    render(<UnpinOnDoneDialog />)
    dropOnDone()

    act(() =>
      useKanbanStore.setState({
        pendingDoneMove: {
          ticketId: 'ticket-9',
          projectId: 'project-9',
          sortOrder: 1,
          targetColumn: 'done'
        }
      })
    )
    await waitFor(() => expect(queryDialog()).toBeNull())
    // Held back, not withdrawn
    expect(useUnpinOnDoneStore.getState().offer).not.toBeNull()

    act(() => useKanbanStore.setState({ pendingDoneMove: null }))
    expect(dialog()).toBeTruthy()
  })

  it('does not unpin when a ticket shows up between the question and the answer', async () => {
    render(<UnpinOnDoneDialog />)
    dropOnDone()
    const unpin = within(dialog()).getByRole('button', { name: 'Unpin' })

    // The store changes and the click land in the same tick
    act(() => {
      useKanbanStore.setState({
        tickets: new Map([
          ['project-1', [row('ticket-1', 'done'), row('ticket-2', 'todo')]]
        ]) as never
      })
      fireEvent.click(unpin)
    })

    await waitFor(() => expect(queryDialog()).toBeNull())
    expect(setProjectPinnedMock).not.toHaveBeenCalled()
  })

  it('unmounting withdraws the question', () => {
    const { unmount } = render(<UnpinOnDoneDialog />)
    dropOnDone()
    expect(useUnpinOnDoneStore.getState().offer).not.toBeNull()

    unmount()

    expect(useUnpinOnDoneStore.getState().offer).toBeNull()
  })
})
