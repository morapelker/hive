// The "Go to project" row of the sidebar's top navigation: where it sits and what a click does.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('@/components/projects', () => ({
  ProjectList: () => <div data-testid="project-list" />,
  AddProjectButton: () => null,
  SortProjectsButton: () => null,
  RecentToggleButton: () => null,
  FilterChips: () => null
}))
vi.mock('@/components/projects/ProjectFilter', () => ({
  ProjectFilter: () => <input data-testid="project-filter-input" />
}))
vi.mock('@/components/connections', () => ({
  ConnectionList: () => null,
  ConnectionsButton: () => null
}))
vi.mock('@/components/spaces', () => ({ SpacesTabBar: () => null }))
vi.mock('@/components/sidebar/MachinesSection', () => ({ MachinesSection: () => null }))
vi.mock('./UsageIndicator', () => ({ UsageIndicator: () => null }))
vi.mock('./UpdatePill', () => ({ UpdatePill: () => null }))
vi.mock('./PinnedList', () => ({ PinnedList: () => null }))
vi.mock('./RecentList', () => ({ RecentList: () => null }))
vi.mock('./ResizeHandle', () => ({ ResizeHandle: () => null }))

import { LeftSidebar } from './LeftSidebar'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { sampleGitProject } from '@/components/data-projects/data-project.sample'

describe('LeftSidebar "Go to project" row', () => {
  beforeEach(() => {
    cleanup()
    useLayoutStore.setState({ leftSidebarCollapsed: false })
    useProjectStore.setState({
      projects: [sampleGitProject('a', 0), sampleGitProject('b', 1)] as never
    })
    useProjectSwitcherStore.setState({ isOpen: false })
  })

  it('sits directly under "Pinned Board", above the filter field', () => {
    render(<LeftSidebar />)
    const pinnedBoard = screen.getByTestId('sidebar-nav-pinned-board')
    const goToProject = screen.getByTestId('sidebar-nav-go-to-project')
    expect(goToProject.textContent).toBe('Go to project')
    expect(pinnedBoard.nextElementSibling).toBe(goToProject)
    expect(goToProject.nextElementSibling).toBe(screen.getByTestId('project-filter-input'))
    // It opens an overlay; it is never the current page.
    expect(goToProject.getAttribute('aria-current')).toBeNull()
  })

  it('opens the switcher on click and closes it when clicked again', () => {
    render(<LeftSidebar />)
    const row = screen.getByTestId('sidebar-nav-go-to-project')
    fireEvent.click(row)
    expect(useProjectSwitcherStore.getState().isOpen).toBe(true)
    fireEvent.click(row)
    expect(useProjectSwitcherStore.getState().isOpen).toBe(false)
  })

  it('does not take the keyboard focus, so the switcher can hand it back', () => {
    render(
      <>
        <textarea data-testid="chat-input" />
        <LeftSidebar />
      </>
    )
    const chat = screen.getByTestId('chat-input')
    chat.focus()
    const row = screen.getByTestId('sidebar-nav-go-to-project')
    // A mousedown that is not prevented would move the focus to the button.
    expect(fireEvent.mouseDown(row)).toBe(false)
    fireEvent.click(row)
    expect(useProjectSwitcherStore.getState().isOpen).toBe(true)

    useProjectSwitcherStore.getState().close()
    expect(document.activeElement).toBe(chat)
  })

  it('is not rendered with the sidebar collapsed', () => {
    useLayoutStore.setState({ leftSidebarCollapsed: true })
    render(<LeftSidebar />)
    expect(screen.queryByTestId('sidebar-nav-go-to-project')).toBeNull()
  })
})
