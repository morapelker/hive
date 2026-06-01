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

import { useProjectStore } from '../useProjectStore'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../api/rpc-client'

const existingProject = {
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

let request: ReturnType<typeof vi.fn>

describe('useProjectStore project adding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    request = vi.fn().mockImplementation((method) => {
      if (method === 'projectOps.validateProject') {
        return Promise.resolve({
          success: true,
          name: 'Hive',
          path: '/repo/hive'
        })
      }
      if (method === 'db.project.getByPath') return Promise.resolve(existingProject)
      return Promise.resolve(null)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    useProjectStore.setState({
      projects: [],
      isLoading: false,
      error: null,
      selectedProjectId: null,
      expandedProjectIds: new Set(),
      editingProjectId: null,
      settingsProjectId: null
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('checks duplicate project paths through dbApi before creating', async () => {
    await expect(useProjectStore.getState().addProject('/repo/hive')).resolves.toEqual({
      success: false,
      error: 'This project has already been added to Hive.'
    })

    expect(request).toHaveBeenCalledWith('db.project.getByPath', { path: '/repo/hive' })
    expect(useProjectStore.getState().projects).toEqual([])
  })

  it('creates new projects through dbApi after duplicate checks pass', async () => {
    request.mockImplementation((method) => {
      if (method === 'projectOps.validateProject') {
        return Promise.resolve({
          success: true,
          name: 'Hive',
          path: '/repo/hive'
        })
      }
      if (method === 'db.project.getByPath') return Promise.resolve(null)
      if (method === 'db.project.create') return Promise.resolve(existingProject)
      return Promise.resolve(null)
    })

    await expect(useProjectStore.getState().addProject('/repo/hive')).resolves.toEqual({
      success: true
    })

    expect(request).toHaveBeenCalledWith('db.project.getByPath', { path: '/repo/hive' })
    expect(request).toHaveBeenCalledWith('db.project.create', {
      name: 'Hive',
      path: '/repo/hive'
    })
    expect(useProjectStore.getState().projects[0]).toMatchObject({
      id: existingProject.id,
      name: existingProject.name,
      path: existingProject.path
    })
    expect(useProjectStore.getState().selectedProjectId).toBe(existingProject.id)
    expect(useProjectStore.getState().expandedProjectIds.has(existingProject.id)).toBe(true)
  })

  it('persists startup detected-icon scans through dbApi', async () => {
    const unscannedProject = { ...existingProject, detected_icon: null }
    request.mockImplementation((method) => {
      if (method === 'db.project.getAll') return Promise.resolve([unscannedProject])
      if (method === 'projectOps.detectFavicon') return Promise.resolve('favicon.png')
      if (method === 'db.project.update') {
        return Promise.resolve({ ...unscannedProject, detected_icon: 'favicon.png' })
      }
      return Promise.resolve(null)
    })

    await useProjectStore.getState().loadProjects()

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('db.project.update', {
        id: unscannedProject.id,
        data: { detected_icon: 'favicon.png' }
      })
      expect(useProjectStore.getState().projects[0].detected_icon).toBe('favicon.png')
    })
    expect(request).toHaveBeenCalledWith('projectOps.detectFavicon', {
      path: '/repo/hive'
    })
  })

  it('persists add-project language detection through dbApi', async () => {
    request.mockImplementation((method) => {
      if (method === 'projectOps.validateProject') {
        return Promise.resolve({
          success: true,
          name: 'Hive',
          path: '/repo/hive'
        })
      }
      if (method === 'projectOps.detectLanguage') return Promise.resolve('typescript')
      if (method === 'projectOps.detectFavicon') return new Promise(() => {})
      if (method === 'db.project.getByPath') return Promise.resolve(null)
      if (method === 'db.project.create') return Promise.resolve(existingProject)
      if (method === 'db.project.update') {
        return Promise.resolve({ ...existingProject, language: 'typescript' })
      }
      return Promise.resolve(null)
    })

    await expect(useProjectStore.getState().addProject('/repo/hive')).resolves.toEqual({
      success: true
    })

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('projectOps.detectLanguage', {
        path: '/repo/hive'
      })
      expect(request).toHaveBeenCalledWith('db.project.update', {
        id: existingProject.id,
        data: { language: 'typescript' }
      })
      expect(useProjectStore.getState().projects[0].language).toBe('typescript')
    })
  })

  it('persists add-project favicon detection through dbApi', async () => {
    request.mockImplementation((method) => {
      if (method === 'projectOps.validateProject') {
        return Promise.resolve({
          success: true,
          name: 'Hive',
          path: '/repo/hive'
        })
      }
      if (method === 'projectOps.detectLanguage') return new Promise(() => {})
      if (method === 'projectOps.detectFavicon') return Promise.resolve('favicon.png')
      if (method === 'db.project.getByPath') return Promise.resolve(null)
      if (method === 'db.project.create') return Promise.resolve(existingProject)
      if (method === 'db.project.update') {
        return Promise.resolve({ ...existingProject, detected_icon: 'favicon.png' })
      }
      return Promise.resolve(null)
    })

    await expect(useProjectStore.getState().addProject('/repo/hive')).resolves.toEqual({
      success: true
    })

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('projectOps.detectFavicon', {
        path: '/repo/hive'
      })
      expect(request).toHaveBeenCalledWith('db.project.update', {
        id: existingProject.id,
        data: { detected_icon: 'favicon.png' }
      })
      expect(useProjectStore.getState().projects[0].detected_icon).toBe('favicon.png')
    })
  })
})
