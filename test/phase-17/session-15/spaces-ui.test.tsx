import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../utils/render'
import { SpacesTabBar } from '@/components/spaces/SpacesTabBar'
import { SpaceIconPicker, ICON_LIST } from '@/components/spaces/SpaceIconPicker'
import { ProjectList } from '@/components/projects/ProjectList'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useProjectStore } from '@/stores/useProjectStore'

// Mock window.db.space namespace
const mockSpaceDb = {
  list: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  assignProject: vi.fn(),
  removeProject: vi.fn(),
  getProjectIds: vi.fn(),
  getAllAssignments: vi.fn().mockResolvedValue([]),
  reorder: vi.fn()
}

const mockProjectDb = {
  getAll: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  getByPath: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  touch: vi.fn().mockResolvedValue(true)
}

const mockProjectOps = {
  openDirectoryDialog: vi.fn(),
  validateProject: vi.fn(),
  showInFolder: vi.fn(),
  copyToClipboard: vi.fn(),
  readFromClipboard: vi.fn(),
  openPath: vi.fn(),
  isGitRepository: vi.fn(),
  loadLanguageIcons: vi.fn().mockResolvedValue({})
}

// Set up window mocks
Object.defineProperty(window, 'db', {
  writable: true,
  value: {
    ...(window.db ?? {}),
    space: mockSpaceDb,
    project: mockProjectDb
  }
})

Object.defineProperty(window, 'projectOps', {
  writable: true,
  value: mockProjectOps
})

Object.defineProperty(window, 'worktreeOps', {
  writable: true,
  value: {
    getForProject: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    createFromBranch: vi.fn(),
    remove: vi.fn(),
    listBranches: vi.fn()
  }
})

function resetStores(): void {
  useSpaceStore.setState({
    spaces: [],
    activeSpaceId: null,
    projectSpaceMap: {}
  })
  useProjectStore.setState({
    projects: [],
    isLoading: false,
    error: null,
    selectedProjectId: null,
    expandedProjectIds: new Set(),
    editingProjectId: null
  })
}

describe('Session 15: Project Spaces UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStores()
  })

  test('SpacesTabBar renders All tab (icon-only)', () => {
    render(<SpacesTabBar />)

    const allTab = screen.getByTestId('space-tab-all')
    expect(allTab).toBeInTheDocument()
    expect(allTab).toHaveAttribute('title', 'All projects')
  })

  test('SpacesTabBar renders user space tabs (icon-only with title)', () => {
    useSpaceStore.setState({
      spaces: [
        {
          id: 's1',
          name: 'Work',
          icon_type: 'default',
          icon_value: 'Briefcase',
          sort_order: 0,
          created_at: '2025-01-01T00:00:00.000Z'
        },
        {
          id: 's2',
          name: 'Side Projects',
          icon_type: 'default',
          icon_value: 'Gamepad2',
          sort_order: 1,
          created_at: '2025-01-01T00:00:00.000Z'
        }
      ]
    })

    render(<SpacesTabBar />)

    expect(screen.getByTestId('space-tab-s1')).toHaveAttribute('title', 'Work')
    expect(screen.getByTestId('space-tab-s2')).toHaveAttribute('title', 'Side Projects')
  })

  test('clicking space tab calls setActiveSpace', () => {
    useSpaceStore.setState({
      spaces: [
        {
          id: 's1',
          name: 'Work',
          icon_type: 'default',
          icon_value: 'Briefcase',
          sort_order: 0,
          created_at: '2025-01-01T00:00:00.000Z'
        }
      ]
    })

    render(<SpacesTabBar />)

    fireEvent.click(screen.getByTestId('space-tab-s1'))
    expect(useSpaceStore.getState().activeSpaceId).toBe('s1')
  })

  test('clicking All tab resets to null', () => {
    useSpaceStore.setState({
      activeSpaceId: 's1',
      spaces: [
        {
          id: 's1',
          name: 'Work',
          icon_type: 'default',
          icon_value: 'Briefcase',
          sort_order: 0,
          created_at: '2025-01-01T00:00:00.000Z'
        }
      ]
    })

    render(<SpacesTabBar />)

    fireEvent.click(screen.getByTestId('space-tab-all'))
    expect(useSpaceStore.getState().activeSpaceId).toBeNull()
  })

  test('add space button is present', () => {
    render(<SpacesTabBar />)

    expect(screen.getByTestId('space-add-button')).toBeInTheDocument()
  })

  test('ProjectList filters by active space', async () => {
    // Set up 3 projects
    const projects = [
      {
        id: 'p1',
        name: 'Alpha',
        path: '/alpha',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        sort_order: 0,
        created_at: '2025-01-01T00:00:00.000Z',
        last_accessed_at: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 'p2',
        name: 'Beta',
        path: '/beta',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        sort_order: 1,
        created_at: '2025-01-01T00:00:00.000Z',
        last_accessed_at: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 'p3',
        name: 'Gamma',
        path: '/gamma',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        sort_order: 2,
        created_at: '2025-01-01T00:00:00.000Z',
        last_accessed_at: '2025-01-01T00:00:00.000Z'
      }
    ]

    useProjectStore.setState({ projects, isLoading: false })

    // Assign p1 and p2 to space s1
    useSpaceStore.setState({
      activeSpaceId: 's1',
      projectSpaceMap: {
        p1: ['s1'],
        p2: ['s1', 's2'],
        p3: ['s2']
      }
    })

    render(<ProjectList onAddProject={vi.fn()} />)

    // Should show Alpha and Beta but not Gamma
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument()
  })

  test('ProjectList shows all projects when activeSpaceId is null', async () => {
    const projects = [
      {
        id: 'p1',
        name: 'Alpha',
        path: '/alpha',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        sort_order: 0,
        created_at: '2025-01-01T00:00:00.000Z',
        last_accessed_at: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 'p2',
        name: 'Beta',
        path: '/beta',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        sort_order: 1,
        created_at: '2025-01-01T00:00:00.000Z',
        last_accessed_at: '2025-01-01T00:00:00.000Z'
      }
    ]

    useProjectStore.setState({ projects, isLoading: false })
    useSpaceStore.setState({ activeSpaceId: null })

    render(<ProjectList onAddProject={vi.fn()} />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  test('SpaceIconPicker renders 50+ icons', () => {
    render(<SpaceIconPicker onSelect={vi.fn()} />)

    expect(ICON_LIST.length).toBeGreaterThanOrEqual(50)
    // Verify at least some icons are rendered
    expect(screen.getByTestId('icon-Briefcase')).toBeInTheDocument()
    expect(screen.getByTestId('icon-Code')).toBeInTheDocument()
    expect(screen.getByTestId('icon-Rocket')).toBeInTheDocument()
  })

  test('selecting icon calls onSelect with correct values', () => {
    const onSelect = vi.fn()
    render(<SpaceIconPicker onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('icon-Briefcase'))
    expect(onSelect).toHaveBeenCalledWith('default', 'Briefcase')
  })

  test('SpaceIconPicker filters icons by search', () => {
    render(<SpaceIconPicker onSelect={vi.fn()} />)

    const searchInput = screen.getByPlaceholderText('Search icons...')
    fireEvent.change(searchInput, { target: { value: 'rocket' } })

    // Rocket should still be visible
    expect(screen.getByTestId('icon-Rocket')).toBeInTheDocument()
    // Briefcase should not be visible
    expect(screen.queryByTestId('icon-Briefcase')).not.toBeInTheDocument()
  })

  test('empty space shows instructional message', () => {
    const projects = [
      {
        id: 'p1',
        name: 'Alpha',
        path: '/alpha',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        sort_order: 0,
        created_at: '2025-01-01T00:00:00.000Z',
        last_accessed_at: '2025-01-01T00:00:00.000Z'
      }
    ]

    useProjectStore.setState({ projects, isLoading: false })
    // Active space with no projects assigned
    useSpaceStore.setState({
      activeSpaceId: 's1',
      projectSpaceMap: {}
    })

    render(<ProjectList onAddProject={vi.fn()} />)

    expect(screen.getByTestId('empty-space-state')).toBeInTheDocument()
    expect(screen.getByText('No projects in this space.')).toBeInTheDocument()
  })

  test('SpaceIconPicker highlights selected icon', () => {
    render(<SpaceIconPicker selectedValue="Star" onSelect={vi.fn()} />)

    const starButton = screen.getByTestId('icon-Star')
    // The selected icon should have the primary styling class
    expect(starButton.className).toContain('bg-primary')
  })

  test('active space tab has accent styling', () => {
    useSpaceStore.setState({
      activeSpaceId: 's1',
      spaces: [
        {
          id: 's1',
          name: 'Work',
          icon_type: 'default',
          icon_value: 'Briefcase',
          sort_order: 0,
          created_at: '2025-01-01T00:00:00.000Z'
        }
      ]
    })

    render(<SpacesTabBar />)

    const tab = screen.getByTestId('space-tab-s1')
    expect(tab.className).toContain('bg-accent')
  })
})
