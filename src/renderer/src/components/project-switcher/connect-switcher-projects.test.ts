// The glue between the "Go to project" switcher and the store's quickCreateConnection, with
// the real connection store over a stand-in for lib/connection-create.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))
vi.mock('@/lib/toast', () => ({ toast: toastMock, gitToast: {} }))

const createConnectionFromProjects = vi.hoisted(() => vi.fn())
vi.mock('@/lib/connection-create', () => ({ createConnectionFromProjects }))

import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { canConnectSwitcherProject, connectSwitcherProjects } from './connect-switcher-projects'

const PROJECTS = [
  { id: 'seller-ios', name: 'seller-ios', path: '/Users/ana/code/seller-ios' },
  { id: 'ads-api', name: 'ads-api', path: '/Users/ana/code/ads-api' }
]

beforeEach(() => {
  vi.clearAllMocks()
  useConnectionStore.setState({ connections: [], selectedConnectionId: null })
  useWorktreeStore.setState({ selectedWorktreeId: 'wt-open' })
  useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })
})

describe('canConnectSwitcherProject', () => {
  it('is true for a git project only', () => {
    expect(canConnectSwitcherProject({ kind: 'git' })).toBe(true)
    expect(canConnectSwitcherProject({ kind: 'connection' })).toBe(false)
    expect(canConnectSwitcherProject({ kind: 'data' })).toBe(false)
  })
})

describe('connectSwitcherProjects', () => {
  it('creates the connection, selects it and leaves the Pinned Board', async () => {
    createConnectionFromProjects.mockResolvedValue({
      ok: true,
      connectionId: 'conn-1',
      connectionName: 'seller-ios + ads-api',
      connectionPath: '/Users/ana/.hive/connections/conn-1',
      savedProjectId: null
    })
    const onProgress = vi.fn()
    const onError = vi.fn()

    await expect(connectSwitcherProjects(PROJECTS, { onProgress, onError })).resolves.toBe('conn-1')

    // The helper is handed the progress callback and no pull decision of its own.
    expect(createConnectionFromProjects).toHaveBeenCalledWith(PROJECTS, { onProgress })
    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(toastMock.success).toHaveBeenCalledWith('Connection "seller-ios + ads-api" created')
    expect(onError).not.toHaveBeenCalled()
  })

  it('hands the reason to onError and changes nothing when nothing was created', async () => {
    createConnectionFromProjects.mockResolvedValue({
      ok: false,
      error: 'Failed to create worktree in "ads-api": disk full'
    })
    const onError = vi.fn()

    await expect(connectSwitcherProjects(PROJECTS, { onError })).resolves.toBeNull()

    expect(onError).toHaveBeenCalledWith('Failed to create worktree in "ads-api": disk full')
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-open')
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
  })

  it('reports a creation that threw the same way', async () => {
    createConnectionFromProjects.mockRejectedValue(new Error('socket closed'))
    const onError = vi.fn()

    await expect(connectSwitcherProjects(PROJECTS, { onError })).resolves.toBeNull()

    expect(onError).toHaveBeenCalledWith('Failed to create connection: socket closed')
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
  })
})
