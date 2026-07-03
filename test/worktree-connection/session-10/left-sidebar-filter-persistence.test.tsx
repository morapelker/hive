import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { LeftSidebar } from '../../../src/renderer/src/components/layout/LeftSidebar'
import { useConnectionStore } from '../../../src/renderer/src/stores/useConnectionStore'
import { useFilterStore } from '../../../src/renderer/src/stores/useFilterStore'
import { useLayoutStore } from '../../../src/renderer/src/stores/useLayoutStore'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useSpaceStore } from '../../../src/renderer/src/stores/useSpaceStore'

vi.mock('@/components/projects', () => ({
  ProjectList: ({
    filterQuery,
    activeLanguages
  }: {
    filterQuery: string
    activeLanguages: string[]
  }) => (
    <div
      data-testid="project-list"
      data-filter-query={filterQuery}
      data-active-languages={activeLanguages.join(',')}
    />
  ),
  AddProjectButton: () => <button data-testid="add-project-button" type="button" />,
  SortProjectsButton: () => <button data-testid="sort-projects-button" type="button" />,
  RecentToggleButton: () => <button data-testid="recent-toggle-button" type="button" />,
  FilterChips: ({ languages }: { languages: string[] }) => (
    <div data-testid="filter-chips">{languages.join(',')}</div>
  )
}))

vi.mock('@/components/connections', () => ({
  ConnectionList: () => <div data-testid="mock-connection-list" />,
  ConnectionsButton: () => <button data-testid="connections-button" type="button" />
}))

vi.mock('@/components/spaces', () => ({
  SpacesTabBar: () => <div data-testid="mock-spaces-tab-bar" />
}))

vi.mock('../../../src/renderer/src/components/layout/UsageIndicator', () => ({
  UsageIndicator: () => <div data-testid="mock-usage-indicator" />
}))

vi.mock('../../../src/renderer/src/components/layout/PinnedList', () => ({
  PinnedList: () => <div data-testid="mock-pinned-list" />
}))

vi.mock('../../../src/renderer/src/components/layout/RecentList', () => ({
  RecentList: () => <div data-testid="mock-recent-list" />
}))

vi.mock('../../../src/renderer/src/components/layout/ResizeHandle', () => ({
  ResizeHandle: () => <div data-testid="mock-resize-handle" />
}))

function makeProject(id: string, name: string, language: string | null) {
  return {
    id,
    name,
    path: `/repos/${name.toLowerCase()}`,
    description: null,
    tags: null,
    language,
    custom_icon: null,
    detected_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    auto_assign_port: false,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    last_accessed_at: '2026-01-01T00:00:00.000Z'
  }
}

describe('Session 10: LeftSidebar filter persistence', () => {
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

    useFilterStore.setState({ activeLanguages: [] })

    useConnectionStore.setState({
      connections: [],
      isLoading: false,
      error: null,
      loaded: true,
      selectedConnectionId: null,
      connectionModeActive: false,
      connectionModeSourceWorktreeId: null,
      connectionModeSelectedIds: new Set(),
      connectionModeSubmitting: false
    })

    useLayoutStore.setState({
      leftSidebarWidth: 240,
      leftSidebarCollapsed: false
    })

    useSpaceStore.setState({
      spaces: [],
      activeSpaceId: null,
      projectSpaceMap: {}
    })
  })

  test('keeps the typed search query after enterConnectionMode is fired', async () => {
    const user = userEvent.setup()

    useProjectStore.setState({
      projects: [
        makeProject('p1', 'Frontend', 'typescript'),
        makeProject('p2', 'Backend', 'go')
      ]
    })

    render(<LeftSidebar />)

    const filterInput = screen.getByTestId('project-filter-input')
    await user.type(filterInput, 'front')
    expect(filterInput).toHaveValue('front')
    expect(screen.getByTestId('project-list')).toHaveAttribute('data-filter-query', 'front')

    act(() => {
      useConnectionStore.getState().enterConnectionMode('wt-1')
    })

    expect(screen.getByTestId('project-filter-input')).toHaveValue('front')
    expect(screen.getByTestId('project-list')).toHaveAttribute('data-filter-query', 'front')
  })

  test('keeps active language filters after enterConnectionMode is fired', () => {
    useProjectStore.setState({
      projects: [
        makeProject('p1', 'Frontend', 'typescript'),
        makeProject('p2', 'Backend', 'go')
      ]
    })

    render(<LeftSidebar />)

    act(() => {
      useFilterStore.setState({ activeLanguages: ['typescript'] })
    })

    expect(useFilterStore.getState().activeLanguages).toEqual(['typescript'])
    expect(screen.getByTestId('project-list')).toHaveAttribute(
      'data-active-languages',
      'typescript'
    )

    act(() => {
      useConnectionStore.getState().enterConnectionMode('wt-1')
    })

    expect(useFilterStore.getState().activeLanguages).toEqual(['typescript'])
    expect(screen.getByTestId('project-list')).toHaveAttribute(
      'data-active-languages',
      'typescript'
    )
  })
})
