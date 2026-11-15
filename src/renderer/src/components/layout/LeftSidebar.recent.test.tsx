// Where Recent sits in the sidebar, and that the Projects row no longer carries its toggle.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

// No RecentToggleButton here: the sidebar importing it again would fail this file.
vi.mock('@/components/projects', () => ({
  ProjectList: () => <div data-testid="project-list" data-section="projects" />,
  AddProjectButton: () => <button type="button" data-testid="add-project-button" />,
  SortProjectsButton: () => <button type="button" data-testid="sort-projects-button" />,
  FilterChips: () => null
}))
vi.mock('@/components/projects/ProjectFilter', () => ({ ProjectFilter: () => null }))
vi.mock('@/components/connections', () => ({
  ConnectionList: () => <div data-section="connections" />,
  ConnectionsButton: () => <button type="button" data-testid="connections-button" />
}))
vi.mock('@/components/spaces', () => ({ SpacesTabBar: () => null }))
vi.mock('./UsageIndicator', () => ({ UsageIndicator: () => null }))
vi.mock('./UpdatePill', () => ({ UpdatePill: () => null }))
vi.mock('./PinnedList', () => ({ PinnedList: () => <div data-section="pinned" /> }))
vi.mock('./RecentList', () => ({ RecentList: () => <div data-section="recent" /> }))
vi.mock('./ResizeHandle', () => ({ ResizeHandle: () => null }))

import { LeftSidebar } from './LeftSidebar'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useLayoutStore } from '@/stores/useLayoutStore'

describe('LeftSidebar and the Recent section', () => {
  beforeEach(() => {
    cleanup()
    useLayoutStore.setState({ leftSidebarCollapsed: false })
    useConnectionStore.setState({ connectionModeActive: false })
  })

  it('shows Recent between Pinned and Connections, above the project list', () => {
    render(<LeftSidebar />)

    const sections = Array.from(
      screen.getByTestId('sidebar-scroll-container').querySelectorAll<HTMLElement>('[data-section]')
    ).map((section) => section.dataset.section)

    expect(sections).toEqual(['pinned', 'recent', 'connections', 'projects'])
  })

  it('has no Recent button in the Projects row: Connections, Sort and Add only', () => {
    render(<LeftSidebar />)

    const row = screen.getByText('Projects').closest('div')!.parentElement!
    const buttons = Array.from(row.querySelectorAll('button')).map(
      (button) => button.dataset.testid
    )

    expect(buttons).toEqual(['connections-button', 'sort-projects-button', 'add-project-button'])
    expect(screen.queryByTestId('recent-toggle-button')).toBeNull()
    expect(screen.queryByTitle('Toggle recent activity')).toBeNull()
  })
})
