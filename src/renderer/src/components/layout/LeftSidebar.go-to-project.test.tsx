// The "Go to project" row of the sidebar's top navigation: where it sits, what a click does
// and the key it shows.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

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
vi.mock('@/api/db-api', () => ({
  dbApi: {
    setting: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
  }
}))

import { LeftSidebar } from './LeftSidebar'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { sampleGitProject } from '@/components/data-projects/data-project.sample'

describe('LeftSidebar "Go to project" row', () => {
  beforeEach(() => {
    cleanup()
    useLayoutStore.setState({ leftSidebarCollapsed: false })
    useProjectStore.setState({
      projects: [sampleGitProject('a', 0), sampleGitProject('b', 1)] as never
    })
    useProjectSwitcherStore.setState({ isOpen: false })
    useShortcutStore.setState({ customBindings: {} })
  })

  it('sits directly under "Pinned Board", above the filter field', () => {
    render(<LeftSidebar />)
    const pinnedBoard = screen.getByTestId('sidebar-nav-pinned-board')
    const goToProject = screen.getByTestId('sidebar-nav-go-to-project')
    expect(goToProject.firstElementChild?.nextElementSibling?.textContent).toBe('Go to project')
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

  it('shows its key next to the label, like the Pinned Board row', () => {
    render(<LeftSidebar />)
    const pinnedBoard = screen.getByTestId('sidebar-nav-pinned-board')
    const goToProject = screen.getByTestId('sidebar-nav-go-to-project')
    expect(pinnedBoard.querySelector('kbd')?.textContent).toBe('⌘P')
    expect(goToProject.querySelector('kbd')?.textContent).toBe('⌘G')
    expect(goToProject.querySelector('kbd')?.className).toBe(
      pinnedBoard.querySelector('kbd')?.className
    )
    expect(goToProject.textContent).toBe('Go to project⌘G')
    expect(goToProject.getAttribute('title')).toBe('Go to project (⌘G)')
  })

  it('follows a rebind without a reload', () => {
    render(<LeftSidebar />)
    const goToProject = screen.getByTestId('sidebar-nav-go-to-project')

    act(() => {
      useShortcutStore
        .getState()
        .setCustomBinding('nav:go-to-project', { key: 'j', modifiers: ['meta', 'shift'] })
    })
    expect(goToProject.querySelector('kbd')?.textContent).toBe('⌘⇧J')
    expect(goToProject.getAttribute('title')).toBe('Go to project (⌘⇧J)')

    act(() => useShortcutStore.getState().removeCustomBinding('nav:go-to-project'))
    expect(goToProject.querySelector('kbd')?.textContent).toBe('⌘G')
  })

  it('shows no key while the user has Cmd+G on another action', () => {
    useShortcutStore.setState({
      customBindings: { 'session:new': { key: 'g', modifiers: ['meta'] } }
    })
    render(<LeftSidebar />)
    const goToProject = screen.getByTestId('sidebar-nav-go-to-project')
    expect(goToProject.querySelector('kbd')).toBeNull()
    expect(goToProject.textContent).toBe('Go to project')
    expect(goToProject.getAttribute('title')).toBeNull()

    // A key chosen for it in Settings shows up on the row.
    act(() => {
      useShortcutStore
        .getState()
        .setCustomBinding('nav:go-to-project', { key: 'j', modifiers: ['meta'] })
    })
    expect(goToProject.querySelector('kbd')?.textContent).toBe('⌘J')
  })

  it('is not rendered with the sidebar collapsed', () => {
    useLayoutStore.setState({ leftSidebarCollapsed: true })
    render(<LeftSidebar />)
    expect(screen.queryByTestId('sidebar-nav-go-to-project')).toBeNull()
  })
})
