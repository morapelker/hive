import { beforeEach, describe, expect, it, vi } from 'vitest'

const pinMocks = vi.hoisted(() => ({ isProjectPinned: vi.fn(), setProjectPinned: vi.fn() }))
vi.mock('@/lib/project-pin', () => pinMocks)

import { useKanbanStore } from '@/stores/useKanbanStore'
import { hasOpenTickets, unpinIdleProject } from './auto-unpin'

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
