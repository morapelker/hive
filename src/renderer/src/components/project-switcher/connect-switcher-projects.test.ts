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
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import {
  canConnectSwitcherProject,
  connectSwitcherProjects,
  switcherConnectionPullsFirst
} from './connect-switcher-projects'

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

describe('switcherConnectionPullsFirst', () => {
  it('is the "auto-pull before worktree" setting', () => {
    const before = useSettingsStore.getState().autoPullBeforeWorktree
    try {
      useSettingsStore.setState({ autoPullBeforeWorktree: true })
      expect(switcherConnectionPullsFirst()).toBe(true)
      useSettingsStore.setState({ autoPullBeforeWorktree: false })
      expect(switcherConnectionPullsFirst()).toBe(false)
    } finally {
      useSettingsStore.setState({ autoPullBeforeWorktree: before })
    }
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

    await expect(
      connectSwitcherProjects(PROJECTS, { autoPull: true, onProgress, onError })
    ).resolves.toBe('conn-1')

    // The helper is handed the pull decision and the progress callback.
    expect(createConnectionFromProjects).toHaveBeenCalledWith(PROJECTS, {
      autoPull: true,
      onProgress
    })
    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(toastMock.success).toHaveBeenCalledWith('Connection "seller-ios + ads-api" created')
    expect(onError).not.toHaveBeenCalled()
  })

  it('says not to pull as plainly as to pull', async () => {
    createConnectionFromProjects.mockResolvedValue({
      ok: true,
      connectionId: 'conn-1',
      connectionName: 'seller-ios + ads-api',
      connectionPath: '/Users/ana/.hive/connections/conn-1',
      savedProjectId: null
    })

    await connectSwitcherProjects(PROJECTS, { autoPull: false })

    // Left out, the worktree create would pull on its own, out of sight.
    expect(createConnectionFromProjects).toHaveBeenCalledWith(PROJECTS, { autoPull: false })
  })

  it('hands on which projects join on their base branch', async () => {
    createConnectionFromProjects.mockResolvedValue({
      ok: true,
      connectionId: 'conn-1',
      connectionName: 'seller-ios + ads-api',
      connectionPath: '/Users/ana/.hive/connections/conn-1',
      savedProjectId: null
    })
    const picked = [{ ...PROJECTS[0], useBase: true }, PROJECTS[1]]

    await expect(connectSwitcherProjects(picked, { autoPull: true })).resolves.toBe('conn-1')

    expect(createConnectionFromProjects).toHaveBeenCalledWith(picked, { autoPull: true })
    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
  })

  it('hands the reason to onError and changes nothing when nothing was created', async () => {
    createConnectionFromProjects.mockResolvedValue({
      ok: false,
      error: 'Failed to create worktree in "ads-api": disk full'
    })
    const onError = vi.fn()

    await expect(
      connectSwitcherProjects(PROJECTS, { autoPull: true, onError })
    ).resolves.toBeNull()

    expect(onError).toHaveBeenCalledWith('Failed to create worktree in "ads-api": disk full')
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-open')
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
  })

  it('reports a creation that threw the same way', async () => {
    createConnectionFromProjects.mockRejectedValue(new Error('socket closed'))
    const onError = vi.fn()

    await expect(
      connectSwitcherProjects(PROJECTS, { autoPull: true, onError })
    ).resolves.toBeNull()

    expect(onError).toHaveBeenCalledWith('Failed to create connection: socket closed')
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
  })
})
