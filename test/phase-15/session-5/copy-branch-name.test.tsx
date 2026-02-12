import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../utils/render'
import { QuickActions } from '@/components/layout/QuickActions'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

describe('Session 5: Copy Branch Name', () => {
  const mockCopyToClipboard = vi.fn().mockResolvedValue(undefined)
  const mockShowInFolder = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()

    Object.defineProperty(window, 'projectOps', {
      writable: true,
      configurable: true,
      value: {
        copyToClipboard: mockCopyToClipboard,
        showInFolder: mockShowInFolder,
        getProjects: vi.fn().mockResolvedValue([]),
        createProject: vi.fn(),
        deleteProject: vi.fn(),
        openInFinder: vi.fn(),
        openInTerminal: vi.fn(),
        selectDirectory: vi.fn()
      }
    })

    Object.defineProperty(window, 'systemOps', {
      writable: true,
      configurable: true,
      value: {
        openInApp: vi.fn().mockResolvedValue(undefined),
        onOpenCodeStatus: vi.fn().mockReturnValue(() => {}),
        onSettingsShortcut: vi.fn().mockReturnValue(() => {}),
        onNewSessionShortcut: vi.fn().mockReturnValue(() => {}),
        onCloseSessionShortcut: vi.fn().mockReturnValue(() => {}),
        onNavigateSessionShortcut: vi.fn().mockReturnValue(() => {}),
        onQuickActionsShortcut: vi.fn().mockReturnValue(() => {}),
        getPlatform: vi.fn().mockResolvedValue('darwin')
      }
    })
  })

  test('copy branch button renders when branch name exists', () => {
    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              project_id: 'proj-1',
              name: 'feature-auth',
              path: '/tmp/project/wt',
              branch_name: 'feature/auth',
              is_main: false,
              created_at: '',
              updated_at: ''
            }
          ]
        ]
      ])
    })

    render(<QuickActions />)

    const btn = screen.getByTestId('quick-action-copy-branch')
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('title', 'Copy branch name')
    expect(screen.getByText('Copy branch name')).toBeInTheDocument()
  })

  test('copy branch button not rendered for (no-worktree)', () => {
    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              project_id: 'proj-1',
              name: '(no-worktree)',
              path: '/tmp/project',
              branch_name: 'main',
              is_main: true,
              created_at: '',
              updated_at: ''
            }
          ]
        ]
      ])
    })

    render(<QuickActions />)

    expect(screen.queryByTestId('quick-action-copy-branch')).not.toBeInTheDocument()
  })

  test('copy branch button not rendered when no branch name', () => {
    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              project_id: 'proj-1',
              name: 'some-worktree',
              path: '/tmp/project/wt',
              branch_name: '',
              is_main: false,
              created_at: '',
              updated_at: ''
            }
          ]
        ]
      ])
    })

    render(<QuickActions />)

    expect(screen.queryByTestId('quick-action-copy-branch')).not.toBeInTheDocument()
  })

  test('clicking copy branch button calls copyToClipboard with branch name', async () => {
    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              project_id: 'proj-1',
              name: 'feature-auth',
              path: '/tmp/project/wt',
              branch_name: 'feature/auth',
              is_main: false,
              created_at: '',
              updated_at: ''
            }
          ]
        ]
      ])
    })

    render(<QuickActions />)

    const btn = screen.getByTestId('quick-action-copy-branch')
    fireEvent.click(btn)

    await waitFor(() => {
      expect(mockCopyToClipboard).toHaveBeenCalledWith('feature/auth')
    })
  })

  test('clicking copy branch button shows "Copied" feedback', async () => {
    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              project_id: 'proj-1',
              name: 'feature-auth',
              path: '/tmp/project/wt',
              branch_name: 'feature/auth',
              is_main: false,
              created_at: '',
              updated_at: ''
            }
          ]
        ]
      ])
    })

    render(<QuickActions />)

    const btn = screen.getByTestId('quick-action-copy-branch')
    fireEvent.click(btn)

    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument()
    })
  })

  test('other quick action buttons still render alongside branch button', () => {
    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              project_id: 'proj-1',
              name: 'feature-auth',
              path: '/tmp/project/wt',
              branch_name: 'feature/auth',
              is_main: false,
              created_at: '',
              updated_at: ''
            }
          ]
        ]
      ])
    })

    render(<QuickActions />)

    expect(screen.getByTestId('quick-action-cursor')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-ghostty')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-copy-path')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-finder')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-copy-branch')).toBeInTheDocument()
  })
})
