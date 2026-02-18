import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { type ReactNode } from 'react'
import { useFileTreeStore } from '@/stores/useFileTreeStore'
import { useFileSearchStore } from '@/stores/useFileSearchStore'
import { useWorktreeStore } from '@/stores'
import { FileSearchDialog } from '@/components/file-search/FileSearchDialog'

// Mock scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn()

// Mock cmdk
vi.mock('cmdk', () => {
  const CommandRoot = ({ children }: { children: ReactNode }) => <div>{children}</div>
  CommandRoot.Input = () => <input />
  CommandRoot.List = ({ children }: { children: ReactNode }) => <div>{children}</div>
  CommandRoot.Empty = ({ children }: { children: ReactNode }) => <div>{children}</div>
  CommandRoot.Item = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return { Command: CommandRoot }
})

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Search: () => <span data-testid="search-icon" />
}))

// Mock FileIcon
vi.mock('@/components/file-tree/FileIcon', () => ({
  FileIcon: () => <span data-testid="file-icon" />
}))

describe('Session 1: File Search Bug Fix', () => {
  beforeEach(() => {
    // Reset stores to clean state
    useFileTreeStore.setState({
      fileTreeByWorktree: new Map(),
      isLoading: false,
      error: null
    })
    useFileSearchStore.setState({
      isOpen: false,
      searchQuery: '',
      selectedIndex: 0
    })
  })

  test('loads file index when dialog opens with empty index', () => {
    const loadFileIndex = vi.fn().mockResolvedValue(undefined)

    // Set up worktree store with a selected worktree
    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              path: '/test/worktree',
              project_id: 'proj-1',
              name: 'test-wt',
              branch: 'main',
              is_default: true,
              is_active: true,
              created_at: '',
              updated_at: ''
            }
          ]
        ]
      ])
    })

    // File tree store has no index for this worktree
    useFileTreeStore.setState({
      fileIndexByWorktree: new Map(),
      loadFileIndex
    })

    // Open the dialog
    useFileSearchStore.setState({ isOpen: true })

    render(<FileSearchDialog />)

    expect(loadFileIndex).toHaveBeenCalledWith('/test/worktree')
  })

  test('does not reload file index when already loaded', () => {
    const loadFileIndex = vi.fn().mockResolvedValue(undefined)

    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              path: '/test/worktree',
              project_id: 'proj-1',
              name: 'test-wt',
              branch: 'main',
              is_default: true,
              is_active: true,
              created_at: '',
              updated_at: ''
            }
          ]
        ]
      ])
    })

    // File tree store already has index data for this worktree
    const populatedIndex = [
      {
        name: 'index.ts',
        path: '/test/worktree/index.ts',
        relativePath: 'index.ts',
        extension: '.ts'
      }
    ]
    useFileTreeStore.setState({
      fileIndexByWorktree: new Map([['/test/worktree', populatedIndex]]),
      loadFileIndex
    })

    useFileSearchStore.setState({ isOpen: true })

    render(<FileSearchDialog />)

    expect(loadFileIndex).not.toHaveBeenCalled()
  })

  test('does not load when dialog is closed', () => {
    const loadFileIndex = vi.fn().mockResolvedValue(undefined)

    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              path: '/test/worktree',
              project_id: 'proj-1',
              name: 'test-wt',
              branch: 'main',
              is_default: true,
              is_active: true,
              created_at: '',
              updated_at: ''
            }
          ]
        ]
      ])
    })

    useFileTreeStore.setState({
      fileIndexByWorktree: new Map(),
      loadFileIndex
    })

    // Dialog is closed
    useFileSearchStore.setState({ isOpen: false })

    render(<FileSearchDialog />)

    expect(loadFileIndex).not.toHaveBeenCalled()
  })
})
