import { beforeEach, describe, expect, test, vi } from 'vitest'

const { syncWorktreesMock } = vi.hoisted(() => ({
  syncWorktreesMock: vi.fn()
}))

vi.mock('../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: () => ({
      syncWorktrees: syncWorktreesMock
    })
  }
}))

import { useProjectStore } from '../src/renderer/src/stores/useProjectStore'

describe('useProjectStore addProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useProjectStore.setState({
      projects: [],
      isLoading: false,
      error: null,
      selectedProjectId: null,
      expandedProjectIds: new Set(),
      editingProjectId: null,
      settingsProjectId: null
    })

    // @ts-expect-error test window mock
    window.projectOps = {
      validateProject: vi.fn().mockResolvedValue({
        success: true,
        path: '/path/to/new-project',
        name: 'new-project'
      }),
      detectLanguage: vi.fn().mockResolvedValue(null)
    }

    // @ts-expect-error test window mock
    window.db = {
      project: {
        getByPath: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'project-1',
          name: 'new-project',
          path: '/path/to/new-project',
          description: null,
          tags: null,
          language: null,
          custom_icon: null,
          setup_script: null,
          run_script: null,
          archive_script: null,
          auto_assign_port: false,
          sort_order: 0,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }),
        update: vi.fn().mockResolvedValue(null)
      }
    }
  })

  test('triggers an initial worktree sync after creating a project', async () => {
    const result = await useProjectStore.getState().addProject('/path/to/new-project')

    expect(result).toEqual({ success: true })

    await vi.waitFor(() => {
      expect(syncWorktreesMock).toHaveBeenCalledWith('project-1', '/path/to/new-project')
    })
  })
})
