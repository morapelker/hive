import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { KanbanTicket, Project, TicketDependency } from '../../src/main/db/types'

const { mockDatabase, mockState } = vi.hoisted(() => {
  const mockState: {
    projects: Map<string, Partial<Project>>
    tickets: Map<string, Partial<KanbanTicket>>
    dependencies: TicketDependency[]
  } = {
    projects: new Map(),
    tickets: new Map(),
    dependencies: []
  }

  const mockDatabase = {
    getProject: vi.fn((projectId: string) => mockState.projects.get(projectId) ?? null),
    getKanbanTicket: vi.fn((ticketId: string) => mockState.tickets.get(ticketId) ?? null),
    removeTicketDependency: vi.fn((dependentId: string, blockerId: string) => {
      const before = mockState.dependencies.length
      mockState.dependencies = mockState.dependencies.filter(
        (dep) => dep.dependent_id !== dependentId || dep.blocker_id !== blockerId
      )
      return mockState.dependencies.length < before
    }),
    removeAllDependenciesForTicket: vi.fn((ticketId: string) => {
      const before = mockState.dependencies.length
      mockState.dependencies = mockState.dependencies.filter(
        (dep) => dep.dependent_id !== ticketId && dep.blocker_id !== ticketId
      )
      return before - mockState.dependencies.length
    }),
    deleteKanbanTicket: vi.fn((ticketId: string) => {
      const existed = mockState.tickets.delete(ticketId)
      return existed
    })
  }

  return { mockDatabase, mockState }
})

vi.mock('../../src/main/db', () => ({
  getDatabase: () => mockDatabase
}))

function makeProject(id: string): Partial<Project> {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    kanban_storage_mode: 'internal',
    kanban_markdown_config: null
  }
}

function makeTicket(id: string, projectId: string): Partial<KanbanTicket> {
  return {
    id,
    project_id: projectId,
    title: id,
    column: 'todo',
    sort_order: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    archived_at: null
  }
}

describe('internal kanban dependency routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.projects = new Map([
      ['project-a', makeProject('project-a')],
      ['project-b', makeProject('project-b')]
    ])
    mockState.tickets = new Map([
      ['dependent-a', makeTicket('dependent-a', 'project-a')],
      ['blocker-a', makeTicket('blocker-a', 'project-a')]
    ])
    mockState.dependencies = [
      {
        dependent_id: 'dependent-a',
        blocker_id: 'blocker-a',
        created_at: '2026-06-01T00:00:00.000Z'
      }
    ]
  })

  test('removeDependency no-ops when the route project does not own the dependent ticket', async () => {
    const { getKanbanBackendForProject } = await import('../../src/main/services/kanban-backend')
    const backend = getKanbanBackendForProject('project-b')

    const removed = await backend.removeDependency('project-b', 'dependent-a', 'blocker-a')

    expect(removed).toBe(false)
    expect(mockDatabase.removeTicketDependency).not.toHaveBeenCalled()
    expect(mockState.dependencies).toHaveLength(1)
  })

  test('removeDependency still removes dependencies for the matching route project', async () => {
    const { getKanbanBackendForProject } = await import('../../src/main/services/kanban-backend')
    const backend = getKanbanBackendForProject('project-a')

    const removed = await backend.removeDependency('project-a', 'dependent-a', 'blocker-a')

    expect(removed).toBe(true)
    expect(mockDatabase.removeTicketDependency).toHaveBeenCalledWith('dependent-a', 'blocker-a')
    expect(mockState.dependencies).toHaveLength(0)
  })

  test('removeAllDependencies no-ops when the route project does not own the ticket', async () => {
    const { getKanbanBackendForProject } = await import('../../src/main/services/kanban-backend')
    const backend = getKanbanBackendForProject('project-b')

    const removed = await backend.removeAllDependencies('project-b', 'dependent-a')

    expect(removed).toBe(0)
    expect(mockDatabase.removeAllDependenciesForTicket).not.toHaveBeenCalled()
    expect(mockState.dependencies).toHaveLength(1)
  })

  test('removeAllDependencies still removes dependencies for the matching route project', async () => {
    const { getKanbanBackendForProject } = await import('../../src/main/services/kanban-backend')
    const backend = getKanbanBackendForProject('project-a')

    const removed = await backend.removeAllDependencies('project-a', 'dependent-a')

    expect(removed).toBe(1)
    expect(mockDatabase.removeAllDependenciesForTicket).toHaveBeenCalledWith('dependent-a')
    expect(mockState.dependencies).toHaveLength(0)
  })

  test('delete removes dependencies before deleting a ticket owned by the route project', async () => {
    const { getKanbanBackendForProject } = await import('../../src/main/services/kanban-backend')
    const backend = getKanbanBackendForProject('project-a')

    const deleted = await backend.delete('project-a', 'dependent-a')

    expect(deleted).toBe(true)
    expect(mockDatabase.removeAllDependenciesForTicket).toHaveBeenCalledWith('dependent-a')
    expect(mockDatabase.deleteKanbanTicket).toHaveBeenCalledWith('dependent-a')
    expect(mockState.dependencies).toHaveLength(0)
    expect(mockState.tickets.has('dependent-a')).toBe(false)
  })

  test('delete no-ops when the route project does not own the ticket', async () => {
    const { getKanbanBackendForProject } = await import('../../src/main/services/kanban-backend')
    const backend = getKanbanBackendForProject('project-b')

    const deleted = await backend.delete('project-b', 'dependent-a')

    expect(deleted).toBe(false)
    expect(mockDatabase.removeAllDependenciesForTicket).not.toHaveBeenCalled()
    expect(mockDatabase.deleteKanbanTicket).not.toHaveBeenCalled()
    expect(mockState.dependencies).toHaveLength(1)
    expect(mockState.tickets.has('dependent-a')).toBe(true)
  })
})
