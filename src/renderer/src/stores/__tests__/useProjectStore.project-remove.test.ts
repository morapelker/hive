import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

vi.mock('../useKanbanStore', () => ({
  useKanbanStore: {
    getState: vi.fn(() => ({
      isPinnedBoardActive: false,
      togglePinnedBoard: vi.fn()
    }))
  }
}))

import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../api/rpc-client'
import { useProjectStore } from '../useProjectStore'

const project = {
  id: 'project-1',
  name: 'Hive',
  path: '/repo/hive',
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-05-28T00:00:00.000Z',
  last_accessed_at: '2026-05-28T00:00:00.000Z'
}

const otherProject = {
  ...project,
  id: 'project-2',
  name: 'Other',
  path: '/repo/other',
  sort_order: 1
}

let request: ReturnType<typeof vi.fn>

describe('useProjectStore project removal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    request = vi.fn().mockResolvedValue(true)
    setRendererRpcClient({ request, subscribe: vi.fn() })
    useProjectStore.setState({
      projects: [project, otherProject],
      isLoading: false,
      error: null,
      selectedProjectId: project.id,
      expandedProjectIds: new Set([project.id, otherProject.id]),
      editingProjectId: project.id,
      settingsProjectId: null
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('removes projects through dbApi after a successful delete', async () => {
    await expect(useProjectStore.getState().removeProject(project.id)).resolves.toBe(true)

    expect(request).toHaveBeenCalledWith('db.project.delete', { id: project.id })
    expect(useProjectStore.getState().projects).toEqual([otherProject])
    expect(useProjectStore.getState().selectedProjectId).toBeNull()
    expect(useProjectStore.getState().editingProjectId).toBeNull()
    expect(useProjectStore.getState().expandedProjectIds.has(project.id)).toBe(false)
    expect(useProjectStore.getState().expandedProjectIds.has(otherProject.id)).toBe(true)
  })
})
