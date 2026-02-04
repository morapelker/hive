import { describe, test, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../utils/render'
import { AppLayout } from '@/components/layout'
import { useLayoutStore, LAYOUT_CONSTRAINTS } from '@/stores/useLayoutStore'
import { useThemeStore } from '@/stores/useThemeStore'

describe('Session 2: Application Layout', () => {
  beforeEach(() => {
    // Reset stores before each test
    useLayoutStore.setState({
      leftSidebarWidth: LAYOUT_CONSTRAINTS.leftSidebar.default,
      rightSidebarWidth: LAYOUT_CONSTRAINTS.rightSidebar.default,
      rightSidebarCollapsed: false,
    })
    useThemeStore.setState({ theme: 'dark' })
    localStorage.clear()
  })

  test('Three-panel layout renders', () => {
    render(<AppLayout />)

    expect(screen.getByTestId('left-sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('main-pane')).toBeInTheDocument()
    expect(screen.getByTestId('right-sidebar')).toBeInTheDocument()
  })

  test('Left sidebar has correct default width', () => {
    render(<AppLayout />)

    const leftSidebar = screen.getByTestId('left-sidebar')
    expect(leftSidebar).toHaveAttribute('data-width', '240')
    expect(leftSidebar).toHaveStyle({ width: '240px' })
  })

  test('Left sidebar respects min/max constraints', () => {
    const { setLeftSidebarWidth } = useLayoutStore.getState()

    // Try to set below minimum
    setLeftSidebarWidth(100)
    expect(useLayoutStore.getState().leftSidebarWidth).toBe(LAYOUT_CONSTRAINTS.leftSidebar.min)

    // Try to set above maximum
    setLeftSidebarWidth(500)
    expect(useLayoutStore.getState().leftSidebarWidth).toBe(LAYOUT_CONSTRAINTS.leftSidebar.max)

    // Valid width should be set correctly
    setLeftSidebarWidth(300)
    expect(useLayoutStore.getState().leftSidebarWidth).toBe(300)
  })

  test('Right sidebar collapses and expands', async () => {
    render(<AppLayout />)

    // Initially visible
    expect(screen.getByTestId('right-sidebar')).toBeInTheDocument()

    // Click toggle button in header
    const toggleButton = screen.getByTestId('right-sidebar-toggle')
    fireEvent.click(toggleButton)

    // Should be collapsed (hidden element)
    await waitFor(() => {
      expect(screen.getByTestId('right-sidebar-collapsed')).toBeInTheDocument()
      expect(screen.queryByTestId('right-sidebar')).not.toBeInTheDocument()
    })

    // Click toggle again to expand
    fireEvent.click(toggleButton)

    // Should be visible again
    await waitFor(() => {
      expect(screen.getByTestId('right-sidebar')).toBeInTheDocument()
      expect(screen.queryByTestId('right-sidebar-collapsed')).not.toBeInTheDocument()
    })
  })

  test('Right sidebar shows file tree component', () => {
    render(<AppLayout />)

    // File tree component should be rendered (with "Files" header and "Select a worktree" message)
    expect(screen.getByText('Files')).toBeInTheDocument()
    expect(screen.getByText('Select a worktree')).toBeInTheDocument()
  })

  test('Panel sizes persist to localStorage', () => {
    const { setLeftSidebarWidth } = useLayoutStore.getState()
    setLeftSidebarWidth(300)

    // The persist middleware should have saved to localStorage
    const stored = localStorage.getItem('hive-layout')
    expect(stored).not.toBeNull()

    const parsed = JSON.parse(stored!)
    expect(parsed.state.leftSidebarWidth).toBe(300)
  })

  test('Theme toggle switches modes', async () => {
    render(<AppLayout />)

    // Theme toggle button exists in header
    const themeToggle = screen.getByTestId('theme-toggle')
    expect(themeToggle).toBeInTheDocument()

    // Initially dark
    expect(useThemeStore.getState().theme).toBe('dark')

    // Theme toggle is a dropdown menu trigger (has aria-haspopup)
    expect(themeToggle).toHaveAttribute('aria-haspopup', 'menu')

    // Test theme changes via store (dropdown UI testing is in session-6)
    const { setTheme } = useThemeStore.getState()

    // Switch to light
    setTheme('light')
    expect(useThemeStore.getState().theme).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)

    // Switch to system
    setTheme('system')
    expect(useThemeStore.getState().theme).toBe('system')

    // Switch back to dark
    setTheme('dark')
    expect(useThemeStore.getState().theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  test('Main pane fills remaining space', () => {
    render(<AppLayout />)

    const mainPane = screen.getByTestId('main-pane')
    // Main pane should have flex-1 class which makes it fill remaining space
    expect(mainPane).toHaveClass('flex-1')
  })

  test('Header renders with app title', () => {
    render(<AppLayout />)

    expect(screen.getByTestId('header')).toBeInTheDocument()
    expect(screen.getByText('Hive')).toBeInTheDocument()
  })

  test('Resize handles are present', () => {
    render(<AppLayout />)

    expect(screen.getByTestId('resize-handle-left')).toBeInTheDocument()
    expect(screen.getByTestId('resize-handle-right')).toBeInTheDocument()
  })

  test('Layout content container exists', () => {
    render(<AppLayout />)

    const layoutContent = screen.getByTestId('layout-content')
    expect(layoutContent).toBeInTheDocument()
    expect(layoutContent).toHaveClass('flex')
  })

  test('Right sidebar can be closed via X button', async () => {
    render(<AppLayout />)

    // Find the X button inside the right sidebar header
    const closeButton = screen.getByTitle('Close sidebar')
    fireEvent.click(closeButton)

    await waitFor(() => {
      expect(screen.getByTestId('right-sidebar-collapsed')).toBeInTheDocument()
    })
  })

  test('Theme persists to localStorage', () => {
    const { setTheme } = useThemeStore.getState()
    setTheme('light')

    const stored = localStorage.getItem('hive-theme')
    expect(stored).not.toBeNull()

    const parsed = JSON.parse(stored!)
    expect(parsed.state.theme).toBe('light')
  })
})
