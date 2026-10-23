// Git projects and data projects (database connections) in one sidebar list: merged by the
// shared sort_order, drag-reorder across both kinds persisted with dataProjects.reorderSidebar
// (git-only lists keep db.project.reorder), the text filter matching a data project's host,
// data projects listed in every space, and the empty states.

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRendererRpcClient } from '@/api/rpc-client'
import { ProjectList } from './ProjectList'
import { useProjectStore } from '@/stores/useProjectStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { sampleDataProject, sampleGitProject } from '@/components/data-projects/data-project.sample'
import type { DataProject } from '@shared/data-projects/types'

// Git rows: a light stand-in that wires the same drag handlers as ProjectItem.
vi.mock('./ProjectItem', () => ({
  ProjectItem: ({
    project,
    onDragStart,
    onDragOver,
    onDrop
  }: {
    project: { id: string; name: string }
    onDragStart?: (e: React.DragEvent, id: string) => void
    onDragOver?: (e: React.DragEvent, id: string) => void
    onDrop?: (e: React.DragEvent, id: string) => void
  }) => (
    <div
      data-testid={`project-item-${project.id}`}
      data-sidebar-row=""
      draggable
      onDragStart={(e) => onDragStart?.(e, project.id)}
      onDragOver={(e) => onDragOver?.(e, project.id)}
      onDrop={(e) => onDrop?.(e, project.id)}
    >
      {project.name}
    </div>
  )
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

let gitRows: unknown[] = []
let dataRows: DataProject[] = []
const requests: Array<{ method: string; params: unknown }> = []

beforeEach(() => {
  requests.length = 0
  useDataProjectStore.getState().reset()
  useSpaceStore.setState({ activeSpaceId: null, projectSpaceMap: {} })
  setRendererRpcClient({
    request: (async (method: string, params?: unknown) => {
      requests.push({ method, params })
      switch (method) {
        case 'db.project.getAll':
          return gitRows
        case 'dataProjects.list':
          return dataRows
        case 'dataProjects.status':
          return { dataProjectId: (params as { id: string }).id, state: 'disconnected' }
        case 'db.space.list':
        case 'db.space.getAllAssignments':
        case 'db.worktree.getAllActive':
          return []
        default:
          return undefined
      }
    }) as never,
    subscribe: () => () => {}
  })
})

afterEach(() => {
  cleanup()
  useProjectStore.setState({ projects: [] })
})

/** Row test ids in DOM order (the rows' own ids; ids in these tests contain no '-'). */
const rowOrder = (): string[] =>
  Array.from(document.querySelectorAll('[data-testid]'))
    .map((el) => el.getAttribute('data-testid') ?? '')
    .filter((id) => /^(data-)?project-item-[a-z0-9]+$/.test(id))

const drag = (from: string, to: string): void => {
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(screen.getByTestId(from), { dataTransfer })
  fireEvent.dragOver(screen.getByTestId(to), { dataTransfer })
  fireEvent.drop(screen.getByTestId(to), { dataTransfer })
}

describe('merged list', () => {
  it('interleaves git and data projects by the shared sort order', async () => {
    gitRows = [sampleGitProject('a', 0), sampleGitProject('b', 2)]
    dataRows = [sampleDataProject({ id: 'd', name: 'orders db', sortOrder: 1 })]
    render(<ProjectList onAddProject={vi.fn()} filterQuery="" />)

    await screen.findByTestId('data-project-item-d')
    await screen.findByTestId('project-item-b')
    expect(rowOrder()).toEqual(['project-item-a', 'data-project-item-d', 'project-item-b'])
  })

  it('drag-reorders across kinds and persists one merged order', async () => {
    gitRows = [sampleGitProject('a', 0), sampleGitProject('b', 2)]
    dataRows = [sampleDataProject({ id: 'd', name: 'orders db', sortOrder: 1 })]
    render(<ProjectList onAddProject={vi.fn()} filterQuery="" />)
    await screen.findByTestId('data-project-item-d')
    await screen.findByTestId('project-item-b')

    drag('data-project-item-d', 'project-item-a')

    await waitFor(() =>
      expect(rowOrder()).toEqual(['data-project-item-d', 'project-item-a', 'project-item-b'])
    )
    const reorder = requests.find((r) => r.method === 'dataProjects.reorderSidebar')
    expect(reorder?.params).toEqual({
      entries: [
        { kind: 'data', id: 'd' },
        { kind: 'project', id: 'a' },
        { kind: 'project', id: 'b' }
      ]
    })
    expect(requests.some((r) => r.method === 'db.project.reorder')).toBe(false)

    // A git project dragged below the data project goes through the same merged path.
    drag('project-item-a', 'project-item-b')
    await waitFor(() =>
      expect(rowOrder()).toEqual(['data-project-item-d', 'project-item-a', 'project-item-b'])
    )
  })

  it('keeps the git-only reorder when there are no data projects', async () => {
    gitRows = [sampleGitProject('a', 0), sampleGitProject('b', 1)]
    dataRows = []
    render(<ProjectList onAddProject={vi.fn()} filterQuery="" />)
    await screen.findByTestId('project-item-b')

    drag('project-item-b', 'project-item-a')

    await waitFor(() => expect(rowOrder()).toEqual(['project-item-b', 'project-item-a']))
    const reorder = requests.find((r) => r.method === 'db.project.reorder')
    expect(reorder?.params).toEqual({ orderedIds: ['b', 'a'] })
    expect(requests.some((r) => r.method === 'dataProjects.reorderSidebar')).toBe(false)
  })
})

describe('filtering', () => {
  it('matches a data project by its host', async () => {
    gitRows = [sampleGitProject('frontend', 0)]
    dataRows = [
      sampleDataProject({
        id: 'd',
        name: 'Orders',
        sortOrder: 1,
        config: { host: 'billing.example.com', database: 'orders' }
      })
    ]
    render(<ProjectList onAddProject={vi.fn()} filterQuery="billing" />)
    await screen.findByTestId('data-project-item-d')
    await waitFor(() =>
      expect(screen.queryByTestId('project-item-frontend')).not.toBeInTheDocument()
    )
  })

  it('lists data projects in every space', async () => {
    gitRows = [sampleGitProject('in-space', 0), sampleGitProject('elsewhere', 1)]
    dataRows = [sampleDataProject({ id: 'd', sortOrder: 2 })]
    render(<ProjectList onAddProject={vi.fn()} filterQuery="" />)
    await screen.findByTestId('data-project-item-d')
    act(() => {
      useSpaceStore.setState({ activeSpaceId: 's1', projectSpaceMap: { 'in-space': ['s1'] } })
    })

    await waitFor(() =>
      expect(screen.queryByTestId('project-item-elsewhere')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('project-item-in-space')).toBeInTheDocument()
    expect(screen.getByTestId('data-project-item-d')).toBeInTheDocument()
  })
})

describe('empty states', () => {
  it('shows the add hint only when there is neither kind', async () => {
    gitRows = []
    dataRows = []
    render(<ProjectList onAddProject={vi.fn()} filterQuery="" />)
    expect(await screen.findByTestId('empty-projects-state')).toHaveTextContent(
      'Click + to add a project or a database.'
    )
  })

  it('a database alone is a list, not an empty state', async () => {
    gitRows = []
    dataRows = [sampleDataProject({ id: 'd' })]
    render(<ProjectList onAddProject={vi.fn()} filterQuery="" />)
    expect(await screen.findByTestId('data-project-item-d')).toBeInTheDocument()
    expect(screen.queryByTestId('empty-projects-state')).not.toBeInTheDocument()
  })
})
