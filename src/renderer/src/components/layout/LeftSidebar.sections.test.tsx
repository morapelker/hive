// The sidebar's scroll area: the order of its sections, and the "All projects" heading over the
// project list with a count that follows the filter and the active Space. The project list is
// the real one (rows are light stand-ins); the other sections are stand-ins with the real
// sections' test ids.

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/projects', async () => {
  const { ProjectList } = await import('@/components/projects/ProjectList')
  return {
    ProjectList,
    AddProjectButton: () => null,
    SortProjectsButton: () => null,
    RecentToggleButton: () => null,
    FilterChips: () => null
  }
})
vi.mock('@/components/projects/ProjectItem', () => ({
  ProjectItem: ({ project }: { project: { id: string; name: string } }) => (
    <div data-testid={`project-item-${project.id}`}>{project.name}</div>
  )
}))
vi.mock('@/components/projects/ProjectFilter', () => ({ ProjectFilter: () => null }))
vi.mock('@/components/connections', () => ({
  ConnectionList: () => <div data-testid="connection-list" />,
  ConnectionsButton: () => null
}))
vi.mock('@/components/spaces', () => ({ SpacesTabBar: () => null }))
vi.mock('./UsageIndicator', () => ({ UsageIndicator: () => null }))
vi.mock('./UpdatePill', () => ({ UpdatePill: () => null }))
vi.mock('./PinnedList', () => ({ PinnedList: () => <div data-testid="pinned-list" /> }))
vi.mock('./RecentList', () => ({ RecentList: () => <div data-testid="recent-list" /> }))
vi.mock('./ResizeHandle', () => ({ ResizeHandle: () => null }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

import { LeftSidebar } from './LeftSidebar'
import { SIDEBAR_SECTIONS } from '@/components/sidebar'
import { setRendererRpcClient } from '@/api/rpc-client'
import { useProjectStore } from '@/stores/useProjectStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useFilterStore } from '@/stores/useFilterStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { sampleDataProject, sampleGitProject } from '@/components/data-projects/data-project.sample'
import type { DataProject } from '@shared/data-projects/types'

let gitRows: unknown[] = []
let dataRows: DataProject[] = []

beforeEach(() => {
  useLayoutStore.setState({ leftSidebarCollapsed: false })
  useDataProjectStore.getState().reset()
  useSpaceStore.setState({ activeSpaceId: null, projectSpaceMap: {} })
  useFilterStore.getState().clearAll()
  setRendererRpcClient({
    request: (async (method: string, params?: unknown) => {
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
  useFilterStore.getState().clearAll()
})

/** Test ids of the scroll area's direct children, top to bottom. */
const sectionOrder = (): string[] =>
  Array.from(screen.getByTestId('sidebar-scroll-container').children).map(
    (el) => el.getAttribute('data-testid') ?? ''
  )

/** The number in the heading's count pill. */
const headingCount = (): string | null =>
  within(screen.getByTestId('all-projects-header')).getByLabelText(/^\d+ projects?$/).textContent

/** Project rows of either kind under the heading, top to bottom. */
const listedRows = (): string[] =>
  Array.from(screen.getByTestId('project-list').children)
    .map(
      (el) =>
        el.querySelector('[data-testid]')?.getAttribute('data-testid') ??
        el.getAttribute('data-testid') ??
        ''
    )
    .filter((id) => /^(data-)?project-item-/.test(id))

/** What the debounced filter field ends up writing to the store. */
const filterBy = (query: string): void => {
  act(() => {
    useFilterStore.setState({ filterQuery: query, debouncedFilterQuery: query })
  })
}

/** Four git projects (two named ledger-*) and one database. */
const seedWorkspace = (): void => {
  gitRows = [
    sampleGitProject('ledger-api', 0),
    sampleGitProject('ledger-worker', 1),
    sampleGitProject('orders-web', 2),
    sampleGitProject('seller-ios', 4)
  ]
  dataRows = [sampleDataProject({ id: 'fixtures', name: 'fixtures-db', sortOrder: 3 })]
}

const renderSidebar = async (): Promise<void> => {
  render(<LeftSidebar />)
  await screen.findByTestId('project-item-seller-ios')
  await screen.findByTestId('data-project-item-fixtures')
}

describe('section order', () => {
  it('fixes the order: Pinned, Recent, Connections, All projects', () => {
    expect(SIDEBAR_SECTIONS).toEqual(['pinned', 'recent', 'connections', 'all-projects'])
  })

  it('renders the sections in that order', async () => {
    seedWorkspace()
    await renderSidebar()

    expect(sectionOrder()).toEqual([
      'pinned-list',
      'recent-list',
      'connection-list',
      'all-projects-section'
    ])
  })

  it('puts the heading directly above the project list', async () => {
    seedWorkspace()
    await renderSidebar()

    const section = screen.getByTestId('all-projects-section')
    expect(Array.from(section.children).map((el) => el.getAttribute('data-testid'))).toEqual([
      'all-projects-header',
      'project-list'
    ])
    expect(screen.getByTestId('all-projects-header')).toHaveTextContent('All projects')
  })

  it('does not pin the heading: it scrolls away with the list', async () => {
    seedWorkspace()
    await renderSidebar()

    const header = screen.getByTestId('all-projects-header')
    expect(header.className).not.toContain('sticky')
    expect(header.querySelector('.sticky')).toBeNull()
  })
})

describe('"All projects" count', () => {
  it('counts every listed project with no filter, in the user’s order', async () => {
    seedWorkspace()
    await renderSidebar()

    expect(headingCount()).toBe('5')
    expect(listedRows()).toEqual([
      'project-item-ledger-api',
      'project-item-ledger-worker',
      'project-item-orders-web',
      'data-project-item-fixtures',
      'project-item-seller-ios'
    ])
  })

  it('counts the matches of a filter, and the total again once it is cleared', async () => {
    seedWorkspace()
    await renderSidebar()

    filterBy('ledg')
    await waitFor(() => expect(headingCount()).toBe('2'))
    expect(listedRows()).toEqual(['project-item-ledger-api', 'project-item-ledger-worker'])

    filterBy('')
    await waitFor(() => expect(headingCount()).toBe('5'))
    expect(listedRows()).toHaveLength(5)
  })

  it('reads "1 project" for a single match', async () => {
    seedWorkspace()
    await renderSidebar()

    filterBy('fixtures')
    await waitFor(() => expect(headingCount()).toBe('1'))
    expect(
      within(screen.getByTestId('all-projects-header')).getByLabelText('1 project')
    ).toBeInTheDocument()
  })

  it('shows 0 and "No matching projects" under the heading when a filter matches nothing', async () => {
    seedWorkspace()
    await renderSidebar()

    filterBy('zzzz')
    await waitFor(() => expect(headingCount()).toBe('0'))

    const header = screen.getByTestId('all-projects-header')
    const message = screen.getByText('No matching projects')
    expect(screen.getByTestId('all-projects-section')).toContainElement(message)
    expect(header.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(listedRows()).toEqual([])
  })

  it('follows the active Space', async () => {
    seedWorkspace()
    await renderSidebar()

    act(() => {
      useSpaceStore.setState({
        activeSpaceId: 'mobile',
        projectSpaceMap: { 'seller-ios': ['mobile'], 'orders-web': ['web'] }
      })
    })

    // The Space's one git project, plus the database: databases are listed in every Space.
    await waitFor(() => expect(headingCount()).toBe('2'))
    expect(listedRows()).toEqual(['data-project-item-fixtures', 'project-item-seller-ios'])

    act(() => {
      useSpaceStore.setState({ activeSpaceId: null })
    })
    await waitFor(() => expect(headingCount()).toBe('5'))
  })

  it('shows 0 over the empty-Space message when the active Space has no projects', async () => {
    gitRows = [sampleGitProject('orders-web', 0), sampleGitProject('seller-ios', 1)]
    dataRows = []
    render(<LeftSidebar />)
    await screen.findByTestId('project-item-seller-ios')

    act(() => {
      useSpaceStore.setState({ activeSpaceId: 'empty', projectSpaceMap: {} })
    })

    await waitFor(() => expect(headingCount()).toBe('0'))
    expect(screen.getByTestId('all-projects-section')).toContainElement(
      screen.getByTestId('empty-space-state')
    )
    expect(screen.queryByTestId('project-list')).not.toBeInTheDocument()
  })
})

describe('no projects at all', () => {
  it('shows today’s empty state in the list’s place and hides the heading', async () => {
    gitRows = []
    dataRows = []
    render(<LeftSidebar />)

    await screen.findByTestId('empty-projects-state')
    expect(screen.queryByTestId('all-projects-header')).not.toBeInTheDocument()
    expect(screen.queryByText('All projects')).not.toBeInTheDocument()
    expect(sectionOrder()).toEqual([
      'pinned-list',
      'recent-list',
      'connection-list',
      'empty-projects-state'
    ])
  })
})
