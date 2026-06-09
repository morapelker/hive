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

const secondProject = {
  ...project,
  id: 'project-2',
  name: 'Hive Docs',
  path: '/repo/hive-docs',
  sort_order: 1
}

let request: ReturnType<typeof vi.fn>

describe('useProjectStore project updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    request = vi.fn().mockResolvedValue({ ...project, name: 'Hive Renamed' })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    useProjectStore.setState({
      projects: [project],
      isLoading: false,
      error: null,
      selectedProjectId: project.id,
      expandedProjectIds: new Set([project.id]),
      editingProjectId: project.id,
      settingsProjectId: null
    })

  })

  afterEach(() => {
    vi.useRealTimers()
    resetRendererRpcClientForTests()
  })

  it('updates project names through dbApi', async () => {
    await expect(
      useProjectStore.getState().updateProjectName(project.id, 'Hive Renamed')
    ).resolves.toBe(true)

    expect(request).toHaveBeenCalledWith('db.project.update', {
      id: project.id,
      data: { name: 'Hive Renamed' }
    })
    expect(useProjectStore.getState().projects[0].name).toBe('Hive Renamed')
    expect(useProjectStore.getState().editingProjectId).toBeNull()
  })

  it('updates project fields through dbApi', async () => {
    request.mockResolvedValue({
      ...project,
      description: 'Updated description',
      tags: JSON.stringify(['client', 'urgent']),
      auto_assign_port: true
    })

    await expect(
      useProjectStore.getState().updateProject(project.id, {
        description: 'Updated description',
        tags: ['client', 'urgent'],
        auto_assign_port: true
      })
    ).resolves.toBe(true)

    expect(request).toHaveBeenCalledWith('db.project.update', {
      id: project.id,
      data: {
        description: 'Updated description',
        tags: ['client', 'urgent'],
        auto_assign_port: true
      }
    })
    expect(useProjectStore.getState().projects[0]).toMatchObject({
      description: 'Updated description',
      tags: JSON.stringify(['client', 'urgent']),
      auto_assign_port: true
    })
  })

  it('touches projects through dbApi', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-28T12:34:56.000Z'))
    request.mockResolvedValue(true)

    await useProjectStore.getState().touchProject(project.id)

    expect(request).toHaveBeenCalledWith('db.project.touch', { id: project.id })
    expect(useProjectStore.getState().projects[0].last_accessed_at).toBe('2026-05-28T12:34:56.000Z')
  })

  it('refreshes project language through dbApi', async () => {
    request.mockImplementation((method) => {
      if (method === 'projectOps.detectLanguage') return Promise.resolve('typescript')
      if (method === 'projectOps.detectFavicon') return new Promise(() => {})
      if (method === 'db.project.update')
        return Promise.resolve({ ...project, language: 'typescript' })
      return Promise.resolve(null)
    })

    await useProjectStore.getState().refreshLanguage(project.id, '/repo/hive-worktree')

    expect(request).toHaveBeenCalledWith('projectOps.detectLanguage', {
      path: '/repo/hive-worktree'
    })
    expect(request).toHaveBeenCalledWith('db.project.update', {
      id: project.id,
      data: { language: 'typescript' }
    })
    expect(useProjectStore.getState().projects[0].language).toBe('typescript')
  })

  it('refreshes project favicon through dbApi', async () => {
    request.mockImplementation((method) => {
      if (method === 'projectOps.detectLanguage') return Promise.resolve('typescript')
      if (method === 'projectOps.detectFavicon') return Promise.resolve('favicon.png')
      if (method === 'db.project.update') return Promise.resolve(project)
      return Promise.resolve(null)
    })

    await useProjectStore.getState().refreshLanguage(project.id)

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('projectOps.detectFavicon', {
        path: project.path
      })
      expect(request).toHaveBeenCalledWith('db.project.update', {
        id: project.id,
        data: { detected_icon: 'favicon.png' }
      })
      expect(useProjectStore.getState().projects[0].detected_icon).toBe('favicon.png')
    })
    expect(request).toHaveBeenCalledWith('projectOps.detectLanguage', {
      path: project.path
    })
  })

  it('reorders projects through dbApi', async () => {
    request.mockResolvedValue(true)
    useProjectStore.setState({
      projects: [project, secondProject],
      expandedProjectIds: new Set([project.id, secondProject.id])
    })

    useProjectStore.getState().reorderProjects(0, 1)

    expect(request).toHaveBeenCalledWith('db.project.reorder', {
      orderedIds: [secondProject.id, project.id]
    })
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
      secondProject.id,
      project.id
    ])
  })

  it('sorts projects by last message IDs through dbApi', async () => {
    request.mockImplementation((method) => {
      if (method === 'db.project.sortByLastMessage') {
        return Promise.resolve([secondProject.id, project.id])
      }
      return Promise.resolve(true)
    })
    useProjectStore.setState({
      projects: [project, secondProject],
      expandedProjectIds: new Set([project.id, secondProject.id])
    })

    await useProjectStore.getState().sortProjectsByLastMessage()

    expect(request).toHaveBeenCalledWith('db.project.sortByLastMessage', {})
    expect(request).toHaveBeenCalledWith('db.project.reorder', {
      orderedIds: [secondProject.id, project.id]
    })
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
      secondProject.id,
      project.id
    ])
  })
})
