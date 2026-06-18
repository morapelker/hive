import type { PropsWithChildren } from 'react'
import { act, render, waitFor } from '../utils/render'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { KanbanBoard } from '@/components/kanban/KanbanBoard'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'

const apiMocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  onChanged: vi.fn()
}))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    watch: {
      start: apiMocks.start,
      stop: apiMocks.stop,
      onChanged: apiMocks.onChanged
    }
  }
}))

vi.mock('motion/react', () => ({
  LayoutGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  motion: {
    div: ({
      children,
      layoutScroll: _layoutScroll,
      ...props
    }: PropsWithChildren<{
      layoutScroll?: boolean
      [key: string]: unknown
    }>) => <div {...props}>{children}</div>
  }
}))

vi.mock('@/components/kanban/KanbanColumn', () => ({
  KanbanColumn: ({ column }: { column: string }) => <div data-testid={`kanban-column-${column}`} />
}))

vi.mock('@/components/kanban/KanbanTicketModal', () => ({
  KanbanTicketModal: () => null
}))

vi.mock('@/components/kanban/MergeOnDoneDialog', () => ({
  MergeOnDoneDialog: () => null
}))

vi.mock('@/components/kanban/BoardChatLauncher', () => ({
  BoardChatLauncher: () => null
}))

describe('KanbanBoard markdown watcher lifecycle', () => {
  let onChangedCallback:
    | ((event: {
        projectId: string
        paths: string[]
        eventTypes: Array<'add' | 'change' | 'unlink'>
      }) => void)
    | null
  const unsubscribe = vi.fn()
  const loadTickets = vi.fn()
  const loadTicketsForProjectInAggregate = vi.fn()
  const loadTicketsForPinnedProjects = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    onChangedCallback = null
    apiMocks.start.mockResolvedValue({ success: true })
    apiMocks.stop.mockResolvedValue({ success: true })
    apiMocks.onChanged.mockImplementation((callback) => {
      onChangedCallback = callback
      return unsubscribe
    })
    loadTickets.mockResolvedValue(undefined)
    loadTicketsForProjectInAggregate.mockResolvedValue(undefined)
    loadTicketsForPinnedProjects.mockResolvedValue(undefined)
    useKanbanStore.setState({
      tickets: new Map(),
      markdownDiagnostics: new Map(),
      markdownPlaceholders: new Map(),
      dependencyMap: new Map(),
      showArchivedByProject: {},
      loadTickets,
      loadTicketsForProjectInAggregate,
      loadTicketsForPinnedProjects
    })
    usePinnedStore.setState({
      pinnedProjectIds: new Set<string>(),
      loaded: true
    })
  })

  test('starts a watcher for the project board and reloads on markdown changes', async () => {
    const { unmount } = render(<KanbanBoard projectId="project-a" />)

    await waitFor(() => {
      expect(apiMocks.start).toHaveBeenCalledWith('project-a')
      expect(loadTickets).toHaveBeenCalledWith('project-a')
    })

    loadTickets.mockClear()

    act(() => {
      onChangedCallback?.({
        projectId: 'project-a',
        paths: ['/repo/cards/a.md'],
        eventTypes: ['change']
      })
      onChangedCallback?.({
        projectId: 'project-b',
        paths: ['/repo/cards/b.md'],
        eventTypes: ['change']
      })
    })

    expect(loadTickets).toHaveBeenCalledTimes(1)
    expect(loadTickets).toHaveBeenCalledWith('project-a')

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(apiMocks.stop).toHaveBeenCalledWith('project-a')
    })
  })

  test('starts watchers for pinned board projects and reloads the changed aggregate project', async () => {
    usePinnedStore.setState({
      pinnedProjectIds: new Set(['project-a', 'project-b']),
      loaded: true
    })

    const { unmount } = render(<KanbanBoard isPinnedMode />)

    await waitFor(() => {
      expect(apiMocks.start).toHaveBeenCalledWith('project-a')
      expect(apiMocks.start).toHaveBeenCalledWith('project-b')
      expect(loadTicketsForPinnedProjects).toHaveBeenCalled()
    })

    act(() => {
      onChangedCallback?.({
        projectId: 'project-b',
        paths: ['/repo/cards/b.md'],
        eventTypes: ['unlink']
      })
    })

    expect(loadTicketsForProjectInAggregate).toHaveBeenCalledTimes(1)
    expect(loadTicketsForProjectInAggregate).toHaveBeenCalledWith('project-b')
    expect(loadTickets).not.toHaveBeenCalled()

    unmount()

    await waitFor(() => {
      expect(apiMocks.stop).toHaveBeenCalledWith('project-a')
      expect(apiMocks.stop).toHaveBeenCalledWith('project-b')
    })
  })
})
