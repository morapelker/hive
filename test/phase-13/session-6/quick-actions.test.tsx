import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock worktree store state - use let so tests can override
let mockWorktreeStoreState: {
  selectedWorktreeId: string | null
  worktreesByProject: Map<string, Array<Record<string, unknown>>>
} = {
  selectedWorktreeId: 'wt-1',
  worktreesByProject: new Map([
    [
      'proj-1',
      [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          path: '/Users/test/my-project',
          name: 'main',
          branch_name: 'main',
          is_default: true
        }
      ]
    ]
  ])
}

vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: Object.assign(
    (selector?: (s: unknown) => unknown) =>
      selector ? selector(mockWorktreeStoreState) : mockWorktreeStoreState,
    {
      getState: () => mockWorktreeStoreState
    }
  )
}))

// Mock window APIs
const mockCopyToClipboard = vi.fn().mockResolvedValue(undefined)
const mockShowInFolder = vi.fn().mockResolvedValue(undefined)
const mockOpenInApp = vi.fn().mockResolvedValue({ success: true })

Object.defineProperty(window, 'projectOps', {
  writable: true,
  value: {
    copyToClipboard: mockCopyToClipboard,
    showInFolder: mockShowInFolder
  }
})

Object.defineProperty(window, 'systemOps', {
  writable: true,
  value: {
    openInApp: mockOpenInApp
  }
})

import { QuickActions } from '../../../src/renderer/src/components/layout/QuickActions'

describe('Session 6: Quick Action Buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset to default state with a selected worktree
    mockWorktreeStoreState = {
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              project_id: 'proj-1',
              path: '/Users/test/my-project',
              name: 'main',
              branch_name: 'main',
              is_default: true
            }
          ]
        ]
      ])
    }
  })

  test('renders four individual buttons', () => {
    render(<QuickActions />)
    expect(screen.getByTestId('quick-action-cursor')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-ghostty')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-copy-path')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-finder')).toBeInTheDocument()
  })

  test('no dropdown menu exists', () => {
    render(<QuickActions />)
    expect(screen.queryByTestId('quick-action-dropdown')).not.toBeInTheDocument()
  })

  test('Cursor button shows label', () => {
    render(<QuickActions />)
    expect(screen.getByText('Cursor')).toBeInTheDocument()
  })

  test('Ghostty button shows label', () => {
    render(<QuickActions />)
    expect(screen.getByText('Ghostty')).toBeInTheDocument()
  })

  test('Cursor button calls openInApp with cursor', async () => {
    const user = userEvent.setup()
    render(<QuickActions />)
    await user.click(screen.getByTestId('quick-action-cursor'))
    expect(mockOpenInApp).toHaveBeenCalledWith('cursor', '/Users/test/my-project')
  })

  test('Ghostty button calls openInApp with ghostty', async () => {
    const user = userEvent.setup()
    render(<QuickActions />)
    await user.click(screen.getByTestId('quick-action-ghostty'))
    expect(mockOpenInApp).toHaveBeenCalledWith('ghostty', '/Users/test/my-project')
  })

  test('Copy Path calls copyToClipboard', async () => {
    const user = userEvent.setup()
    render(<QuickActions />)
    await user.click(screen.getByTestId('quick-action-copy-path'))
    expect(mockCopyToClipboard).toHaveBeenCalledWith('/Users/test/my-project')
  })

  test('Finder button calls showInFolder', async () => {
    const user = userEvent.setup()
    render(<QuickActions />)
    await user.click(screen.getByTestId('quick-action-finder'))
    expect(mockShowInFolder).toHaveBeenCalledWith('/Users/test/my-project')
  })

  test('buttons disabled when no worktree selected', () => {
    mockWorktreeStoreState = {
      selectedWorktreeId: null,
      worktreesByProject: new Map()
    }

    render(<QuickActions />)
    expect(screen.getByTestId('quick-action-cursor')).toBeDisabled()
    expect(screen.getByTestId('quick-action-ghostty')).toBeDisabled()
    expect(screen.getByTestId('quick-action-copy-path')).toBeDisabled()
    expect(screen.getByTestId('quick-action-finder')).toBeDisabled()
  })

  test('all buttons show label text', () => {
    render(<QuickActions />)
    expect(screen.getByText('Cursor')).toBeInTheDocument()
    expect(screen.getByText('Ghostty')).toBeInTheDocument()
    expect(screen.getByText('Copy Path')).toBeInTheDocument()
    expect(screen.getByText('Finder')).toBeInTheDocument()
  })
})
