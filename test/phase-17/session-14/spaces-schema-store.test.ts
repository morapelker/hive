import { describe, test, expect, vi, beforeEach } from 'vitest'
import { useSpaceStore } from '@/stores/useSpaceStore'

// Mock window.db.space namespace
const mockSpaceDb = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  assignProject: vi.fn(),
  removeProject: vi.fn(),
  getProjectIds: vi.fn(),
  getAllAssignments: vi.fn(),
  reorder: vi.fn()
}

Object.defineProperty(window, 'db', {
  writable: true,
  value: {
    ...(window.db ?? {}),
    space: mockSpaceDb
  }
})

// Helper to reset store state between tests
function resetStore(): void {
  useSpaceStore.setState({
    spaces: [],
    activeSpaceId: null,
    projectSpaceMap: {}
  })
}

describe('Session 14: Project Spaces Schema & Store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
  })

  test('createSpace adds space to store', async () => {
    const mockSpace: Space = {
      id: 'space-1',
      name: 'Work',
      icon_type: 'default',
      icon_value: 'Briefcase',
      sort_order: 0,
      created_at: '2025-01-01T00:00:00.000Z'
    }
    mockSpaceDb.create.mockResolvedValue(mockSpace)

    const result = await useSpaceStore.getState().createSpace('Work', 'default', 'Briefcase')

    expect(result).toEqual(mockSpace)
    expect(useSpaceStore.getState().spaces).toHaveLength(1)
    expect(useSpaceStore.getState().spaces[0].name).toBe('Work')
    expect(mockSpaceDb.create).toHaveBeenCalledWith({
      name: 'Work',
      icon_type: 'default',
      icon_value: 'Briefcase'
    })
  })

  test('loadSpaces fetches spaces and assignments', async () => {
    const mockSpaces: Space[] = [
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
        name: 'Side',
        icon_type: 'default',
        icon_value: 'Gamepad2',
        sort_order: 1,
        created_at: '2025-01-01T00:00:00.000Z'
      }
    ]
    const mockAssignments: ProjectSpaceAssignment[] = [
      { project_id: 'p1', space_id: 's1' },
      { project_id: 'p2', space_id: 's1' },
      { project_id: 'p2', space_id: 's2' }
    ]
    mockSpaceDb.list.mockResolvedValue(mockSpaces)
    mockSpaceDb.getAllAssignments.mockResolvedValue(mockAssignments)

    await useSpaceStore.getState().loadSpaces()

    expect(useSpaceStore.getState().spaces).toEqual(mockSpaces)
    expect(useSpaceStore.getState().projectSpaceMap).toEqual({
      p1: ['s1'],
      p2: ['s1', 's2']
    })
  })

  test('assignProjectToSpace updates projectSpaceMap', async () => {
    mockSpaceDb.assignProject.mockResolvedValue(true)

    await useSpaceStore.getState().assignProjectToSpace('p1', 's1')

    const map = useSpaceStore.getState().projectSpaceMap
    expect(map['p1']).toContain('s1')
  })

  test('assignProjectToSpace does not duplicate entries', async () => {
    mockSpaceDb.assignProject.mockResolvedValue(true)

    // Assign twice
    await useSpaceStore.getState().assignProjectToSpace('p1', 's1')
    await useSpaceStore.getState().assignProjectToSpace('p1', 's1')

    const map = useSpaceStore.getState().projectSpaceMap
    expect(map['p1']).toEqual(['s1'])
  })

  test('removeProjectFromSpace updates projectSpaceMap', async () => {
    mockSpaceDb.assignProject.mockResolvedValue(true)
    mockSpaceDb.removeProject.mockResolvedValue(true)

    await useSpaceStore.getState().assignProjectToSpace('p1', 's1')
    await useSpaceStore.getState().assignProjectToSpace('p1', 's2')
    await useSpaceStore.getState().removeProjectFromSpace('p1', 's1')

    const map = useSpaceStore.getState().projectSpaceMap
    expect(map['p1']).toEqual(['s2'])
  })

  test('removeProjectFromSpace cleans up empty entries', async () => {
    mockSpaceDb.assignProject.mockResolvedValue(true)
    mockSpaceDb.removeProject.mockResolvedValue(true)

    await useSpaceStore.getState().assignProjectToSpace('p1', 's1')
    await useSpaceStore.getState().removeProjectFromSpace('p1', 's1')

    const map = useSpaceStore.getState().projectSpaceMap
    expect(map['p1']).toBeUndefined()
  })

  test('setActiveSpace filters projects', () => {
    // Set up projectSpaceMap
    useSpaceStore.setState({
      projectSpaceMap: {
        p1: ['s1'],
        p2: ['s1', 's2'],
        p3: ['s2']
      }
    })

    useSpaceStore.getState().setActiveSpace('s1')
    const filtered = useSpaceStore.getState().getProjectIdsForActiveSpace()
    expect(filtered).toEqual(expect.arrayContaining(['p1', 'p2']))
    expect(filtered).not.toContain('p3')
    expect(filtered).toHaveLength(2)
  })

  test('setActiveSpace(null) returns null (show all)', () => {
    useSpaceStore.getState().setActiveSpace(null)
    expect(useSpaceStore.getState().getProjectIdsForActiveSpace()).toBeNull()
  })

  test('deleteSpace removes from store and clears active if needed', async () => {
    const mockSpace: Space = {
      id: 's1',
      name: 'Work',
      icon_type: 'default',
      icon_value: 'Briefcase',
      sort_order: 0,
      created_at: '2025-01-01T00:00:00.000Z'
    }
    mockSpaceDb.delete.mockResolvedValue(true)

    useSpaceStore.setState({
      spaces: [mockSpace],
      activeSpaceId: 's1',
      projectSpaceMap: { p1: ['s1'] }
    })

    await useSpaceStore.getState().deleteSpace('s1')

    expect(useSpaceStore.getState().spaces).toHaveLength(0)
    expect(useSpaceStore.getState().activeSpaceId).toBeNull()
    expect(useSpaceStore.getState().projectSpaceMap).toEqual({})
  })

  test('deleteSpace does not reset activeSpaceId if different space is active', async () => {
    mockSpaceDb.delete.mockResolvedValue(true)

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
          name: 'Side',
          icon_type: 'default',
          icon_value: 'Gamepad2',
          sort_order: 1,
          created_at: '2025-01-01T00:00:00.000Z'
        }
      ],
      activeSpaceId: 's2'
    })

    await useSpaceStore.getState().deleteSpace('s1')

    expect(useSpaceStore.getState().activeSpaceId).toBe('s2')
  })

  test('updateSpace updates space in store', async () => {
    const original: Space = {
      id: 's1',
      name: 'Work',
      icon_type: 'default',
      icon_value: 'Briefcase',
      sort_order: 0,
      created_at: '2025-01-01T00:00:00.000Z'
    }
    const updated: Space = { ...original, name: 'Work Projects' }
    mockSpaceDb.update.mockResolvedValue(updated)

    useSpaceStore.setState({ spaces: [original] })

    await useSpaceStore.getState().updateSpace('s1', { name: 'Work Projects' })

    expect(useSpaceStore.getState().spaces[0].name).toBe('Work Projects')
  })

  test('reorderSpaces updates sort_order and persists', () => {
    mockSpaceDb.reorder.mockResolvedValue(true)

    const spaces: Space[] = [
      {
        id: 's1',
        name: 'A',
        icon_type: 'default',
        icon_value: 'Folder',
        sort_order: 0,
        created_at: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 's2',
        name: 'B',
        icon_type: 'default',
        icon_value: 'Folder',
        sort_order: 1,
        created_at: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 's3',
        name: 'C',
        icon_type: 'default',
        icon_value: 'Folder',
        sort_order: 2,
        created_at: '2025-01-01T00:00:00.000Z'
      }
    ]
    useSpaceStore.setState({ spaces })

    // Move s3 (index 2) to index 0
    useSpaceStore.getState().reorderSpaces(2, 0)

    const reordered = useSpaceStore.getState().spaces
    expect(reordered[0].id).toBe('s3')
    expect(reordered[1].id).toBe('s1')
    expect(reordered[2].id).toBe('s2')
    expect(reordered[0].sort_order).toBe(0)
    expect(reordered[1].sort_order).toBe(1)
    expect(reordered[2].sort_order).toBe(2)
    expect(mockSpaceDb.reorder).toHaveBeenCalledWith(['s3', 's1', 's2'])
  })

  test('createSpace returns null on failure', async () => {
    mockSpaceDb.create.mockRejectedValue(new Error('DB error'))

    const result = await useSpaceStore.getState().createSpace('Fail', 'default', 'Folder')

    expect(result).toBeNull()
    expect(useSpaceStore.getState().spaces).toHaveLength(0)
  })
})
