import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../utils/render'
import { AppLayout } from '@/components/layout'
import { useProjectStore } from '@/stores'

// Mock the window APIs
const mockDb = {
  project: {
    getAll: vi.fn(),
    create: vi.fn(),
    getByPath: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    touch: vi.fn()
  }
}

const mockProjectOps = {
  openDirectoryDialog: vi.fn(),
  validateProject: vi.fn(),
  showInFolder: vi.fn(),
  copyToClipboard: vi.fn(),
  readFromClipboard: vi.fn(),
  openPath: vi.fn(),
  isGitRepository: vi.fn()
}

// Setup window mocks
beforeEach(() => {
  // @ts-expect-error - Mock window.db
  window.db = mockDb
  // @ts-expect-error - Mock window.projectOps
  window.projectOps = mockProjectOps

  // Reset all mocks
  vi.clearAllMocks()

  // Reset project store
  useProjectStore.setState({
    projects: [],
    isLoading: false,
    error: null,
    selectedProjectId: null,
    expandedProjectIds: new Set(),
    editingProjectId: null
  })

  // Default mock implementations
  mockDb.project.getAll.mockResolvedValue([])
  mockDb.project.touch.mockResolvedValue(true)
})

describe('Session 4: Project Management', () => {
  test('Project list renders empty state', async () => {
    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByTestId('empty-projects-state')).toBeInTheDocument()
    })

    expect(screen.getByText('No projects added yet.')).toBeInTheDocument()
    expect(screen.getByText('Click + to add a project.')).toBeInTheDocument()
  })

  test('Project list displays projects', async () => {
    const mockProjects = [
      {
        id: '1',
        name: 'Project One',
        path: '/path/to/project-one',
        description: null,
        tags: null,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      },
      {
        id: '2',
        name: 'Project Two',
        path: '/path/to/project-two',
        description: null,
        tags: null,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      }
    ]

    mockDb.project.getAll.mockResolvedValue(mockProjects)

    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument()
      expect(screen.getByText('Project Two')).toBeInTheDocument()
    })
  })

  test('Add project button exists', async () => {
    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByTestId('add-project-button')).toBeInTheDocument()
    })
  })

  test('Add project via folder picker', async () => {
    const mockProject = {
      id: '1',
      name: 'new-project',
      path: '/path/to/new-project',
      description: null,
      tags: null,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString()
    }

    mockProjectOps.openDirectoryDialog.mockResolvedValue('/path/to/new-project')
    mockProjectOps.validateProject.mockResolvedValue({
      success: true,
      path: '/path/to/new-project',
      name: 'new-project'
    })
    mockDb.project.getByPath.mockResolvedValue(null)
    mockDb.project.create.mockResolvedValue(mockProject)

    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByTestId('add-project-button')).toBeInTheDocument()
    })

    // Click add project button
    const addButton = screen.getByTestId('add-project-button')
    fireEvent.click(addButton)

    await waitFor(() => {
      expect(mockProjectOps.openDirectoryDialog).toHaveBeenCalled()
      expect(mockProjectOps.validateProject).toHaveBeenCalledWith('/path/to/new-project')
      expect(mockDb.project.create).toHaveBeenCalledWith({
        name: 'new-project',
        path: '/path/to/new-project'
      })
    })

    await waitFor(() => {
      expect(screen.getByText('new-project')).toBeInTheDocument()
    })
  })

  test('Reject non-git directory', async () => {
    mockProjectOps.openDirectoryDialog.mockResolvedValue('/path/to/not-a-repo')
    mockProjectOps.validateProject.mockResolvedValue({
      success: false,
      error: 'The selected folder is not a Git repository.'
    })

    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByTestId('add-project-button')).toBeInTheDocument()
    })

    const addButton = screen.getByTestId('add-project-button')
    fireEvent.click(addButton)

    await waitFor(() => {
      expect(mockProjectOps.openDirectoryDialog).toHaveBeenCalled()
      expect(mockProjectOps.validateProject).toHaveBeenCalledWith('/path/to/not-a-repo')
    })

    // Project should not be created
    expect(mockDb.project.create).not.toHaveBeenCalled()
  })

  test('Reject duplicate project', async () => {
    const existingProject = {
      id: '1',
      name: 'existing-project',
      path: '/path/to/existing',
      description: null,
      tags: null,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString()
    }

    mockProjectOps.openDirectoryDialog.mockResolvedValue('/path/to/existing')
    mockProjectOps.validateProject.mockResolvedValue({
      success: true,
      path: '/path/to/existing',
      name: 'existing-project'
    })
    mockDb.project.getByPath.mockResolvedValue(existingProject)

    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByTestId('add-project-button')).toBeInTheDocument()
    })

    const addButton = screen.getByTestId('add-project-button')
    fireEvent.click(addButton)

    await waitFor(() => {
      expect(mockDb.project.getByPath).toHaveBeenCalledWith('/path/to/existing')
    })

    // Project should not be created since it already exists
    expect(mockDb.project.create).not.toHaveBeenCalled()
  })

  test('User can cancel folder picker', async () => {
    mockProjectOps.openDirectoryDialog.mockResolvedValue(null) // User cancelled

    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByTestId('add-project-button')).toBeInTheDocument()
    })

    const addButton = screen.getByTestId('add-project-button')
    fireEvent.click(addButton)

    await waitFor(() => {
      expect(mockProjectOps.openDirectoryDialog).toHaveBeenCalled()
    })

    // Nothing should happen
    expect(mockProjectOps.validateProject).not.toHaveBeenCalled()
    expect(mockDb.project.create).not.toHaveBeenCalled()
  })

  test('Project can be selected', async () => {
    const mockProjects = [
      {
        id: '1',
        name: 'Project One',
        path: '/path/to/project-one',
        description: null,
        tags: null,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      }
    ]

    mockDb.project.getAll.mockResolvedValue(mockProjects)

    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument()
    })

    // Click on project
    const projectItem = screen.getByTestId('project-item-1')
    fireEvent.click(projectItem)

    // Verify project is selected in store
    expect(useProjectStore.getState().selectedProjectId).toBe('1')

    // Verify touch was called
    await waitFor(() => {
      expect(mockDb.project.touch).toHaveBeenCalledWith('1')
    })
  })

  test('Project can be expanded/collapsed', async () => {
    const mockProjects = [
      {
        id: '1',
        name: 'Project One',
        path: '/path/to/project-one',
        description: null,
        tags: null,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      }
    ]

    mockDb.project.getAll.mockResolvedValue(mockProjects)

    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument()
    })

    // Initially not expanded
    expect(useProjectStore.getState().expandedProjectIds.has('1')).toBe(false)

    // Click chevron to expand
    const projectItem = screen.getByTestId('project-item-1')
    const chevron = projectItem.querySelector('button')
    if (chevron) {
      fireEvent.click(chevron)
    }

    // Verify project is expanded in store
    expect(useProjectStore.getState().expandedProjectIds.has('1')).toBe(true)
  })

  test('Project store: addProject success', async () => {
    const mockProject = {
      id: '1',
      name: 'new-project',
      path: '/path/to/new-project',
      description: null,
      tags: null,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString()
    }

    mockProjectOps.validateProject.mockResolvedValue({
      success: true,
      path: '/path/to/new-project',
      name: 'new-project'
    })
    mockDb.project.getByPath.mockResolvedValue(null)
    mockDb.project.create.mockResolvedValue(mockProject)

    const result = await useProjectStore.getState().addProject('/path/to/new-project')

    expect(result.success).toBe(true)
    expect(useProjectStore.getState().projects).toContainEqual(mockProject)
  })

  test('Project store: addProject rejects non-git repo', async () => {
    mockProjectOps.validateProject.mockResolvedValue({
      success: false,
      error: 'Not a git repository'
    })

    const result = await useProjectStore.getState().addProject('/path/to/not-repo')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Not a git repository')
  })

  test('Project store: removeProject', async () => {
    // Add a project first
    useProjectStore.setState({
      projects: [
        {
          id: '1',
          name: 'Project One',
          path: '/path/to/project-one',
          description: null,
          tags: null,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
    })

    mockDb.project.delete.mockResolvedValue(true)

    const success = await useProjectStore.getState().removeProject('1')

    expect(success).toBe(true)
    expect(useProjectStore.getState().projects).toHaveLength(0)
  })

  test('Project store: updateProjectName', async () => {
    useProjectStore.setState({
      projects: [
        {
          id: '1',
          name: 'Old Name',
          path: '/path/to/project',
          description: null,
          tags: null,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
    })

    mockDb.project.update.mockResolvedValue({
      id: '1',
      name: 'New Name',
      path: '/path/to/project',
      description: null,
      tags: null,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString()
    })

    const success = await useProjectStore.getState().updateProjectName('1', 'New Name')

    expect(success).toBe(true)
    expect(useProjectStore.getState().projects[0].name).toBe('New Name')
  })

  test('Copy path to clipboard', async () => {
    const mockProjects = [
      {
        id: '1',
        name: 'Project One',
        path: '/path/to/project-one',
        description: null,
        tags: null,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      }
    ]

    mockDb.project.getAll.mockResolvedValue(mockProjects)
    mockProjectOps.copyToClipboard.mockResolvedValue(undefined)

    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument()
    })

    // Right-click to open context menu
    const projectItem = screen.getByTestId('project-item-1')
    fireEvent.contextMenu(projectItem)

    await waitFor(() => {
      expect(screen.getByText('Copy Path')).toBeInTheDocument()
    })

    // Click copy path
    fireEvent.click(screen.getByText('Copy Path'))

    await waitFor(() => {
      expect(mockProjectOps.copyToClipboard).toHaveBeenCalledWith('/path/to/project-one')
    })
  })

  test('Open in Finder', async () => {
    const mockProjects = [
      {
        id: '1',
        name: 'Project One',
        path: '/path/to/project-one',
        description: null,
        tags: null,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      }
    ]

    mockDb.project.getAll.mockResolvedValue(mockProjects)
    mockProjectOps.showInFolder.mockResolvedValue(undefined)

    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument()
    })

    // Right-click to open context menu
    const projectItem = screen.getByTestId('project-item-1')
    fireEvent.contextMenu(projectItem)

    await waitFor(() => {
      expect(screen.getByText('Open in Finder')).toBeInTheDocument()
    })

    // Click open in finder
    fireEvent.click(screen.getByText('Open in Finder'))

    await waitFor(() => {
      expect(mockProjectOps.showInFolder).toHaveBeenCalledWith('/path/to/project-one')
    })
  })

  test('Projects sorted by lastAccessedAt', async () => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    const mockProjects = [
      {
        id: '1',
        name: 'Old Project',
        path: '/path/to/old',
        description: null,
        tags: null,
        created_at: yesterday.toISOString(),
        last_accessed_at: yesterday.toISOString()
      },
      {
        id: '2',
        name: 'Recent Project',
        path: '/path/to/recent',
        description: null,
        tags: null,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString()
      }
    ]

    mockDb.project.getAll.mockResolvedValue(mockProjects)

    render(<AppLayout />)

    await waitFor(() => {
      const state = useProjectStore.getState()
      expect(state.projects[0].name).toBe('Recent Project')
      expect(state.projects[1].name).toBe('Old Project')
    })
  })

  test('lastAccessedAt updates on project interaction', async () => {
    const mockProjects = [
      {
        id: '1',
        name: 'Project One',
        path: '/path/to/project-one',
        description: null,
        tags: null,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date(Date.now() - 1000).toISOString()
      }
    ]

    mockDb.project.getAll.mockResolvedValue(mockProjects)
    mockDb.project.touch.mockResolvedValue(true)

    render(<AppLayout />)

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument()
    })

    const oldTimestamp = useProjectStore.getState().projects[0].last_accessed_at

    // Click on project to interact with it
    const projectItem = screen.getByTestId('project-item-1')
    fireEvent.click(projectItem)

    await waitFor(() => {
      expect(mockDb.project.touch).toHaveBeenCalledWith('1')
      // Local state should have updated timestamp
      const newTimestamp = useProjectStore.getState().projects[0].last_accessed_at
      expect(new Date(newTimestamp).getTime()).toBeGreaterThan(new Date(oldTimestamp).getTime())
    })
  })
})
