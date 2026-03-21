import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { cleanup } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock child components — we only care about FileSidebar's tab switching,
// not the contents of each panel.
// ---------------------------------------------------------------------------

vi.mock('@/components/file-tree/FileTree', () => ({
  FileTree: () => <div data-testid="file-tree">FileTree</div>
}))

vi.mock('@/components/file-tree/ChangesView', () => ({
  ChangesView: () => <div data-testid="changes-view">ChangesView</div>
}))

vi.mock('@/components/file-tree/BranchDiffView', () => ({
  BranchDiffView: () => <div data-testid="branch-diff-view">BranchDiffView</div>
}))

// ---------------------------------------------------------------------------
// Import the component under test AFTER mocks
// ---------------------------------------------------------------------------

import { FileSidebar } from '@/components/file-tree/FileSidebar'

// ---------------------------------------------------------------------------
// Helper: dispatch the hive:right-sidebar-tab custom event
// ---------------------------------------------------------------------------

function dispatchTabEvent(tab: string): void {
  const event = new CustomEvent('hive:right-sidebar-tab', {
    detail: { tab }
  })
  window.dispatchEvent(event)
}

// ---------------------------------------------------------------------------
// Default props for FileSidebar
// ---------------------------------------------------------------------------

const defaultProps = {
  worktreePath: '/test/worktree',
  onClose: vi.fn(),
  onFileClick: vi.fn()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileSidebar — hive:right-sidebar-tab event listener', () => {
  afterEach(() => {
    cleanup()
  })

  it('starts on the changes tab by default', () => {
    render(<FileSidebar {...defaultProps} />)
    expect(screen.getByTestId('changes-view')).toBeInTheDocument()
  })

  it('switches to files tab when hive:right-sidebar-tab event fires with tab="files"', () => {
    render(<FileSidebar {...defaultProps} />)

    // Initially on changes tab
    expect(screen.getByTestId('changes-view')).toBeInTheDocument()

    // Dispatch the custom event
    act(() => {
      dispatchTabEvent('files')
    })

    // Should now show files tab
    expect(screen.getByTestId('file-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('changes-view')).not.toBeInTheDocument()
  })

  it('switches to diffs tab when hive:right-sidebar-tab event fires with tab="diffs"', () => {
    render(<FileSidebar {...defaultProps} />)

    act(() => {
      dispatchTabEvent('diffs')
    })

    expect(screen.getByTestId('branch-diff-view')).toBeInTheDocument()
    expect(screen.queryByTestId('changes-view')).not.toBeInTheDocument()
  })

  it('switches to changes tab when hive:right-sidebar-tab event fires with tab="changes"', () => {
    render(<FileSidebar {...defaultProps} />)

    // First switch away from changes
    act(() => {
      dispatchTabEvent('files')
    })
    expect(screen.getByTestId('file-tree')).toBeInTheDocument()

    // Now switch back to changes
    act(() => {
      dispatchTabEvent('changes')
    })
    expect(screen.getByTestId('changes-view')).toBeInTheDocument()
    expect(screen.queryByTestId('file-tree')).not.toBeInTheDocument()
  })

  it('ignores invalid tab values', () => {
    render(<FileSidebar {...defaultProps} />)

    // Dispatch an event with an invalid tab value
    act(() => {
      dispatchTabEvent('invalid-tab')
    })

    // Should still be on the default changes tab
    expect(screen.getByTestId('changes-view')).toBeInTheDocument()
  })

  it('handles rapid tab switching correctly', () => {
    render(<FileSidebar {...defaultProps} />)

    act(() => {
      dispatchTabEvent('files')
      dispatchTabEvent('diffs')
      dispatchTabEvent('changes')
    })

    // Should end on changes tab (last event wins)
    expect(screen.getByTestId('changes-view')).toBeInTheDocument()
  })

  it('cleans up the event listener on unmount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    const { unmount } = render(<FileSidebar {...defaultProps} />)

    // Verify listener was added
    const addCalls = addSpy.mock.calls.filter(
      ([event]) => event === 'hive:right-sidebar-tab'
    )
    expect(addCalls).toHaveLength(1)

    // Unmount and verify listener was removed
    unmount()

    const removeCalls = removeSpy.mock.calls.filter(
      ([event]) => event === 'hive:right-sidebar-tab'
    )
    expect(removeCalls).toHaveLength(1)

    // The same handler reference should be used for add and remove
    expect(addCalls[0][1]).toBe(removeCalls[0][1])

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
