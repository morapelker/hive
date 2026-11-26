import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeepLinkNavigatePayload } from '@shared/deep-link-events'

const mocks = vi.hoisted(() => ({
  listener: null as ((data: DeepLinkNavigatePayload) => void) | null,
  selectConnection: vi.fn(),
  loadConnections: vi.fn(async () => {}),
  openWithPicks: vi.fn(),
  loadProjects: vi.fn(async () => {}),
  projects: [] as { id: string }[],
  toastError: vi.fn()
}))

vi.mock('@/api/system-api', () => ({
  systemApi: {
    onDeepLinkNavigate: (callback: (data: DeepLinkNavigatePayload) => void) => {
      mocks.listener = callback
      return () => {
        mocks.listener = null
      }
    }
  }
}))

vi.mock('@/lib/board-navigation', () => ({ leaveBoardViews: vi.fn() }))
vi.mock('@/lib/sidebar-reveal', () => ({ revealProjectInSidebar: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/stores/useDataProjectStore', () => ({
  leaveDataProjectThen: (then: () => void) => then()
}))
vi.mock('@/stores/useConnectionStore', () => ({
  useConnectionStore: {
    getState: () => ({
      connections: [{ id: 'c1' }, { id: 'c2' }],
      loadConnections: mocks.loadConnections,
      selectConnection: mocks.selectConnection
    })
  }
}))
vi.mock('@/stores/useProjectStore', () => ({
  useProjectStore: {
    getState: () => ({ projects: mocks.projects, loadProjects: mocks.loadProjects })
  }
}))
vi.mock('@/stores/useProjectSwitcherStore', () => ({
  useProjectSwitcherStore: { getState: () => ({ openWithPicks: mocks.openWithPicks }) }
}))
vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: { getState: () => ({}) }
}))

import { useDeepLinkNavigation } from '../useDeepLinkNavigation'

const send = (data: DeepLinkNavigatePayload): void => mocks.listener?.(data)

describe('useDeepLinkNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.projects = [{ id: 'p1' }, { id: 'p2' }]
    renderHook(() => useDeepLinkNavigation())
  })

  it('acts on a re-published request once, so it cannot undo later navigation', async () => {
    send({ kind: 'connection', requestId: 'r-once', connectionId: 'c1' })
    await waitFor(() => expect(mocks.selectConnection).toHaveBeenCalledWith('c1'))
    // The user moves on; the startup copies of the first link arrive afterwards.
    send({ kind: 'connection', requestId: 'r-other', connectionId: 'c2' })
    await waitFor(() => expect(mocks.selectConnection).toHaveBeenCalledWith('c2'))
    send({ kind: 'connection', requestId: 'r-once', connectionId: 'c1' })
    send({ kind: 'connection', requestId: 'r-once', connectionId: 'c1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.selectConnection.mock.calls).toEqual([['c1'], ['c2']])
  })

  it('picks the projects of a new-connection link once', async () => {
    const link: DeepLinkNavigatePayload = {
      kind: 'new-connection',
      requestId: 'r-new',
      members: [
        { projectId: 'p1', useBase: false },
        { projectId: 'p2', useBase: true }
      ],
      pull: false
    }
    send(link)
    send(link)
    await waitFor(() => expect(mocks.openWithPicks).toHaveBeenCalledTimes(1))
    expect(mocks.openWithPicks).toHaveBeenCalledWith({
      members: [
        { projectId: 'p1', useBase: false },
        { projectId: 'p2', useBase: true }
      ],
      pull: false
    })
    expect(mocks.loadProjects).not.toHaveBeenCalled()
  })

  it('loads the git projects before picking when they are not loaded yet', async () => {
    mocks.projects = []
    mocks.loadProjects.mockImplementationOnce(async () => {
      mocks.projects = [{ id: 'p1' }, { id: 'p2' }]
    })
    send({
      kind: 'new-connection',
      requestId: 'r-load',
      members: [
        { projectId: 'p1', useBase: false },
        { projectId: 'p2', useBase: false }
      ]
    })
    await waitFor(() => expect(mocks.openWithPicks).toHaveBeenCalledTimes(1))
    expect(mocks.loadProjects).toHaveBeenCalledTimes(1)
  })

  it('does not open the switcher when a project is still missing after loading', async () => {
    send({
      kind: 'new-connection',
      requestId: 'r-missing',
      members: [
        { projectId: 'p1', useBase: false },
        { projectId: 'gone', useBase: false }
      ]
    })
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    expect(mocks.openWithPicks).not.toHaveBeenCalled()
  })
})
