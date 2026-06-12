import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { useMarkdownKanbanWatcher } from '@/hooks/useMarkdownKanbanWatcher'
import { useKanbanStore } from '@/stores/useKanbanStore'

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

describe('useMarkdownKanbanWatcher', () => {
  let onChangedCallback:
    | ((event: {
        projectId: string
        paths: string[]
        eventTypes: Array<'add' | 'change' | 'unlink'>
      }) => void)
    | null
  const unsubscribe = vi.fn()
  const loadTickets = vi.fn()
  const reloadProject = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    onChangedCallback = null
    apiMocks.start.mockResolvedValue({ success: true })
    apiMocks.stop.mockResolvedValue({ success: true })
    apiMocks.onChanged.mockImplementation((callback) => {
      onChangedCallback = callback
      return unsubscribe
    })
    reloadProject.mockResolvedValue(undefined)
    useKanbanStore.setState({ loadTickets })
  })

  test('starts, updates, reloads, and stops watched project scopes', async () => {
    const { rerender, unmount } = renderHook(
      ({ projectIds }) => useMarkdownKanbanWatcher(projectIds),
      { initialProps: { projectIds: ['project-a'] } }
    )

    await waitFor(() => {
      expect(apiMocks.start).toHaveBeenCalledWith('project-a')
    })

    rerender({ projectIds: ['project-b', 'project-c'] })

    await waitFor(() => {
      expect(apiMocks.stop).toHaveBeenCalledWith('project-a')
      expect(apiMocks.start).toHaveBeenCalledWith('project-b')
      expect(apiMocks.start).toHaveBeenCalledWith('project-c')
    })

    act(() => {
      onChangedCallback?.({ projectId: 'project-a', paths: ['/repo/a.md'], eventTypes: ['change'] })
      onChangedCallback?.({ projectId: 'project-b', paths: ['/repo/b.md'], eventTypes: ['change'] })
    })

    expect(loadTickets).toHaveBeenCalledTimes(1)
    expect(loadTickets).toHaveBeenCalledWith('project-b')

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(apiMocks.stop).toHaveBeenCalledWith('project-b')
      expect(apiMocks.stop).toHaveBeenCalledWith('project-c')
    })
  })

  test('uses the scoped reload callback for watched project changes', async () => {
    renderHook(({ projectIds, reload }) => useMarkdownKanbanWatcher(projectIds, reload), {
      initialProps: { projectIds: ['project-a'], reload: reloadProject }
    })

    await waitFor(() => {
      expect(apiMocks.start).toHaveBeenCalledWith('project-a')
    })

    act(() => {
      onChangedCallback?.({ projectId: 'project-a', paths: ['/repo/a.md'], eventTypes: ['change'] })
      onChangedCallback?.({ projectId: 'project-b', paths: ['/repo/b.md'], eventTypes: ['change'] })
    })

    expect(reloadProject).toHaveBeenCalledTimes(1)
    expect(reloadProject).toHaveBeenCalledWith('project-a')
    expect(loadTickets).not.toHaveBeenCalled()
  })
})
