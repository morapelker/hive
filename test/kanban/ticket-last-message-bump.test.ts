import { beforeEach, describe, expect, test, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    worktree: {
      update: vi.fn().mockResolvedValue(undefined)
    }
  },
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: apiMocks.dbApi
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

import { dbApi } from '@/api/db-api'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

const mockWorktreeDb = vi.mocked(dbApi.worktree)

describe('ticket last message bump', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWorktreeDb.update.mockResolvedValue(undefined)
    useWorktreeStatusStore.setState({ lastMessageTimeByWorktree: {} })
    useConnectionStore.setState({
      connections: [
        {
          id: 'conn-1',
          name: 'Connection 1',
          custom_name: null,
          status: 'active',
          path: '/test/conn-1',
          color: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          members: [
            {
              id: 'member-1',
              connection_id: 'conn-1',
              worktree_id: 'wt-a',
              project_id: 'proj-1',
              symlink_name: 'a',
              added_at: '2026-01-01T00:00:00Z',
              worktree_name: 'A',
              worktree_branch: 'feature-a',
              worktree_path: '/test/a',
              project_name: 'Project'
            },
            {
              id: 'member-2',
              connection_id: 'conn-1',
              worktree_id: 'wt-b',
              project_id: 'proj-1',
              symlink_name: 'b',
              added_at: '2026-01-01T00:00:00Z',
              worktree_name: 'B',
              worktree_branch: 'feature-b',
              worktree_path: '/test/b',
              project_name: 'Project'
            }
          ]
        }
      ]
    })
  })

  test('bumps a worktree-bound ticket send', () => {
    bumpWorktreeLastMessage({ worktreeId: 'wt-1', timestamp: 1234 })

    expect(useWorktreeStatusStore.getState().getLastMessageTime('wt-1')).toBe(1234)
    expect(mockWorktreeDb.update).toHaveBeenCalledWith('wt-1', { last_message_at: 1234 })
  })

  test('fans out a connection-bound ticket send to every member worktree', () => {
    bumpWorktreeLastMessage({ connectionId: 'conn-1', timestamp: 5678 })

    expect(useWorktreeStatusStore.getState().getLastMessageTime('wt-a')).toBe(5678)
    expect(useWorktreeStatusStore.getState().getLastMessageTime('wt-b')).toBe(5678)
    expect(mockWorktreeDb.update).toHaveBeenCalledWith('wt-a', { last_message_at: 5678 })
    expect(mockWorktreeDb.update).toHaveBeenCalledWith('wt-b', { last_message_at: 5678 })
  })

  test('does nothing for board-assistant sends with no worktree or connection', () => {
    bumpWorktreeLastMessage({ worktreeId: null, connectionId: null, timestamp: 9999 })

    expect(useWorktreeStatusStore.getState().lastMessageTimeByWorktree).toEqual({})
    expect(mockWorktreeDb.update).not.toHaveBeenCalled()
  })
})
