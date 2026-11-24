import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pinMocks = vi.hoisted(() => ({ isProjectPinned: vi.fn(), setProjectPinned: vi.fn() }))
vi.mock('@/lib/project-pin', () => pinMocks)

import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import {
  answeredByArchiveStep,
  dismissUnpinOnDone,
  hasOpenTickets,
  hasUnpinOnDoneOffer,
  unpinIdleProject,
  useUnpinOnDoneStore,
  watchDoneMovesForUnpin
} from './auto-unpin'
import {
  emitTicketTransition,
  resetTicketTransitionListenersForTests
} from './ticket-transition-events'

const ticket = (id: string, column: string, archived = false) => ({
  id,
  column,
  archived_at: archived ? '2026-01-01T00:00:00.000Z' : null
})

describe('hasOpenTickets', () => {
  it.each(['todo', 'in_progress', 'review', 'merged'])('counts a ticket in %s', (column) => {
    expect(hasOpenTickets([ticket('a', 'done'), ticket('b', column)])).toBe(true)
  })

  it('counts neither Done nor archived tickets', () => {
    expect(hasOpenTickets([ticket('a', 'done'), ticket('b', 'merged', true)])).toBe(false)
    expect(hasOpenTickets([])).toBe(false)
    expect(hasOpenTickets(undefined)).toBe(false)
  })

  it('leaves out the tickets on their way to Done', () => {
    const tickets = [ticket('a', 'review'), ticket('b', 'merged')]
    expect(hasOpenTickets(tickets, new Set(['a', 'b']))).toBe(false)
    expect(hasOpenTickets(tickets, new Set(['a']))).toBe(true)
  })
})

describe('unpinIdleProject', () => {
  const project = { id: 'project-1', name: 'ledger-worker', kind: 'git' as const }
  const setTickets = (tickets: ReturnType<typeof ticket>[]): void => {
    useKanbanStore.setState({ tickets: new Map([['project-1', tickets]]) as never })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    pinMocks.isProjectPinned.mockReturnValue(true)
    pinMocks.setProjectPinned.mockResolvedValue(true)
  })

  it('unpins a pinned project with nothing left outside Done', async () => {
    setTickets([ticket('a', 'done')])

    expect(await unpinIdleProject(project)).toBe(true)
    expect(pinMocks.setProjectPinned).toHaveBeenCalledWith(project, false)
  })

  it('leaves the project pinned while a ticket is still outside Done', async () => {
    setTickets([ticket('a', 'done'), ticket('b', 'review')])

    expect(await unpinIdleProject(project)).toBe(false)
    expect(pinMocks.setProjectPinned).not.toHaveBeenCalled()
  })

  it('does nothing for a project that already left the board', async () => {
    setTickets([ticket('a', 'done')])
    pinMocks.isProjectPinned.mockReturnValue(false)

    expect(await unpinIdleProject(project)).toBe(false)
    expect(pinMocks.setProjectPinned).not.toHaveBeenCalled()
  })
})

describe('watchDoneMovesForUnpin (a move to Done without the archive step)', () => {
  const moved = { ...ticket('a', 'review'), title: 'Fix the ledger', project_id: 'project-1' }
  /** The store's move as its listeners see it: the ticket is in its column, then announced. */
  const land = (
    to: 'done' | 'merged' = 'done',
    options: { interactive?: boolean; others?: ReturnType<typeof ticket>[] } = {}
  ): void => {
    useKanbanStore.setState({
      tickets: new Map([['project-1', [ticket('a', to), ...(options.others ?? [])]]]) as never
    })
    emitTicketTransition({
      ticketId: 'a',
      projectId: 'project-1',
      from: 'review',
      to,
      ticket: moved as never,
      ...(options.interactive === false ? {} : { interactive: true })
    })
  }
  const offer = (): unknown => useUnpinOnDoneStore.getState().offer
  let stop: () => void

  beforeEach(() => {
    resetTicketTransitionListenersForTests()
    useUnpinOnDoneStore.setState({ offer: null })
    useProjectStore.setState({ projects: [{ id: 'project-1', name: 'ledger-worker' }] as never })
    // On the pinned board through its default worktree
    useWorktreeStore.setState({
      worktreesByProject: new Map([['project-1', [{ id: 'worktree-main' }]]]) as never
    })
    usePinnedStore.setState({
      pinnedProjectIds: new Set(['project-1']),
      pinnedWorktreeIds: new Set(['worktree-main']),
      pinnedConnectionIds: new Set(),
      loaded: true
    })
    stop = watchDoneMovesForUnpin()
  })

  afterEach(() => {
    stop()
    resetTicketTransitionListenersForTests()
    useProjectStore.setState({ projects: [] })
    useWorktreeStore.setState({ worktreesByProject: new Map() })
    usePinnedStore.setState({ pinnedProjectIds: new Set(), pinnedWorktreeIds: new Set() })
  })

  it('asks once the last open ticket of a pinned project is in Done', () => {
    land('done', { others: [ticket('b', 'done'), ticket('c', 'merged', true)] })

    expect(offer()).toEqual({
      projectId: 'project-1',
      ticketId: 'a',
      ticketTitle: 'Fix the ledger'
    })
    expect(hasUnpinOnDoneOffer()).toBe(true)
  })

  it('asks for a connection project pinned through one of its instances', () => {
    useProjectStore.setState({
      projects: [{ id: 'project-1', name: 'checkout-stack', kind: 'connection' }] as never
    })
    useWorktreeStore.setState({ worktreesByProject: new Map() })
    usePinnedStore.setState({
      pinnedWorktreeIds: new Set(),
      pinnedConnectionIds: new Set(['connection-1'])
    })

    land()

    expect(offer()).toMatchObject({ projectId: 'project-1' })
  })

  it.each(['todo', 'in_progress', 'review', 'merged'])(
    'does not ask while another ticket of the project is in %s',
    (column) => {
      land('done', { others: [ticket('b', column)] })

      expect(offer()).toBeNull()
    }
  )

  it('does not ask for a project that is not pinned', () => {
    usePinnedStore.setState({ pinnedProjectIds: new Set(), pinnedWorktreeIds: new Set() })

    land()

    expect(offer()).toBeNull()
  })

  it('does not ask for a move to Merged: the ticket is not done yet', () => {
    land('merged')

    expect(offer()).toBeNull()
  })

  it('does not ask for a move nobody at this desktop made', () => {
    land('done', { interactive: false })

    expect(offer()).toBeNull()
  })

  it('does not ask again for a move the archive step made, and does for the next one', async () => {
    await answeredByArchiveStep({ projectId: 'project-1', ticketId: 'a' }, async () => land())
    expect(offer()).toBeNull()

    // Another ticket's move meanwhile is not the archive step's
    await answeredByArchiveStep({ projectId: 'project-1', ticketId: 'other' }, async () => land())
    expect(offer()).not.toBeNull()

    dismissUnpinOnDone()
    land()
    expect(offer()).not.toBeNull()
  })

  it('stays answered until the last overlapping move of the ticket is over', async () => {
    let finishFirst = (): void => {}
    const first = answeredByArchiveStep(
      { projectId: 'project-1', ticketId: 'a' },
      () => new Promise<void>((resolve) => (finishFirst = resolve))
    )
    // A second click that found nothing left to do
    await answeredByArchiveStep({ projectId: 'project-1', ticketId: 'a' }, async () => {})

    land()
    expect(offer()).toBeNull()

    finishFirst()
    await first
    land()
    expect(offer()).not.toBeNull()
  })

  it('forgets the move when it fails', async () => {
    await expect(
      answeredByArchiveStep({ projectId: 'project-1', ticketId: 'a' }, async () => {
        throw new Error('move refused')
      })
    ).rejects.toThrow('move refused')

    land()
    expect(offer()).not.toBeNull()
  })

  it('stops asking, and withdraws the question, once nobody watches', () => {
    land()
    expect(offer()).not.toBeNull()

    stop()
    expect(offer()).toBeNull()

    land()
    expect(offer()).toBeNull()
  })
})
