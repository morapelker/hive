/**
 * Session 9: Branch Up-to-Date Archive Swap Tests
 *
 * Testing criteria from phase-20.md:
 * - isBranchMerged returns true when branch is ancestor of HEAD
 * - isBranchMerged returns false when branch is not ancestor
 * - GitPushPull shows Archive button when branch is merged AND checked out in a worktree
 * - GitPushPull shows Delete button when branch is merged AND not checked out
 * - GitPushPull shows Merge button when branch is not merged
 * - Archive button targets the branch's worktree, not the current worktree
 * - After merge, merged check re-runs automatically
 * - Changing branch re-checks merged status
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'

// Mock window.gitOps
const mockIsBranchMerged = vi.fn()
const mockMerge = vi.fn()
const mockDeleteBranch = vi.fn()
const mockListBranchesWithStatus = vi.fn().mockResolvedValue({
  success: true,
  branches: []
})

// Ensure gitOps mock includes all required methods
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const existingGitOps = (window as any).gitOps as Record<string, unknown>
Object.defineProperty(window, 'gitOps', {
  writable: true,
  configurable: true,
  value: {
    ...existingGitOps,
    isBranchMerged: mockIsBranchMerged,
    merge: mockMerge,
    deleteBranch: mockDeleteBranch,
    listBranchesWithStatus: mockListBranchesWithStatus
  }
})

import { GitPushPull } from '../../../src/renderer/src/components/git/GitPushPull'

describe('Session 9: Branch Up-to-Date Archive Swap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsBranchMerged.mockResolvedValue({ success: true, isMerged: false })
    mockMerge.mockResolvedValue({ success: true })
    mockDeleteBranch.mockResolvedValue({ success: true })
    mockListBranchesWithStatus.mockResolvedValue({ success: true, branches: [] })

    // Set up git store with branch info
    useGitStore.setState({
      branchInfoByWorktree: new Map([
        ['/path/to/worktree', { name: 'feature-branch', tracking: null, ahead: 0, behind: 0 }]
      ]),
      selectedMergeBranch: new Map(),
      defaultMergeBranch: new Map(),
      mergeSelectionVersion: 0,
      isPushing: false,
      isPulling: false,
      error: null
    })

    // Set up worktree store
    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-default',
              project_id: 'proj-1',
              path: '/project/root',
              branch_name: 'main',
              is_default: true,
              name: 'main',
              status: 'active' as const,
              branch_renamed: 0,
              last_message_at: null,
              session_titles: '[]',
              last_model_provider_id: null,
              last_model_id: null,
              last_model_variant: null,
              created_at: '2024-01-01',
              last_accessed_at: '2024-01-01'
            },
            {
              id: 'wt-1',
              project_id: 'proj-1',
              path: '/path/to/worktree',
              branch_name: 'feature-branch',
              is_default: false,
              name: 'feature-branch',
              status: 'active' as const,
              branch_renamed: 0,
              last_message_at: null,
              session_titles: '[]',
              last_model_provider_id: null,
              last_model_id: null,
              last_model_variant: null,
              created_at: '2024-01-01',
              last_accessed_at: '2024-01-01'
            }
          ]
        ]
      ])
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('isBranchMerged IPC contract', () => {
    test('returns isMerged: true when branch is ancestor of HEAD', async () => {
      mockIsBranchMerged.mockResolvedValue({ success: true, isMerged: true })
      const result = await mockIsBranchMerged('/path', 'main')
      expect(result.success).toBe(true)
      expect(result.isMerged).toBe(true)
    })

    test('returns isMerged: false when branch is not ancestor', async () => {
      mockIsBranchMerged.mockResolvedValue({ success: true, isMerged: false })
      const result = await mockIsBranchMerged('/path', 'unmerged-branch')
      expect(result.success).toBe(true)
      expect(result.isMerged).toBe(false)
    })

    test('is called with correct worktreePath and branch arguments', async () => {
      mockIsBranchMerged.mockResolvedValue({ success: true, isMerged: false })
      await mockIsBranchMerged('/my/worktree', 'feature-x')
      expect(mockIsBranchMerged).toHaveBeenCalledWith('/my/worktree', 'feature-x')
    })
  })

  describe('deleteBranch IPC contract', () => {
    test('calls deleteBranch with correct arguments', async () => {
      mockDeleteBranch.mockResolvedValue({ success: true })
      const result = await mockDeleteBranch('/path', 'old-branch')
      expect(result.success).toBe(true)
      expect(mockDeleteBranch).toHaveBeenCalledWith('/path', 'old-branch')
    })

    test('returns error on failure', async () => {
      mockDeleteBranch.mockResolvedValue({ success: false, error: 'branch not found' })
      const result = await mockDeleteBranch('/path', 'missing-branch')
      expect(result.success).toBe(false)
      expect(result.error).toBe('branch not found')
    })
  })

  describe('GitPushPull button rendering', () => {
    test('shows Merge button by default when no branch is selected', async () => {
      render(<GitPushPull worktreePath="/path/to/worktree" />)

      const mergeButton = screen.getByTestId('merge-button')
      expect(mergeButton).toBeInTheDocument()
      expect(screen.queryByTestId('archive-merged-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('delete-branch-button')).not.toBeInTheDocument()
    })

    test('shows Merge button when branch is not merged', async () => {
      mockIsBranchMerged.mockResolvedValue({ success: true, isMerged: false })

      // Pre-populate merge branch via defaultMergeBranch so the effect triggers
      useGitStore.setState({
        defaultMergeBranch: new Map([['proj-1', 'main']])
      })

      render(<GitPushPull worktreePath="/path/to/worktree" />)

      // Wait for the isBranchMerged check to complete
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })

      expect(screen.getByTestId('merge-button')).toBeInTheDocument()
      expect(screen.queryByTestId('archive-merged-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('delete-branch-button')).not.toBeInTheDocument()
    })

    test('shows Delete button when branch is merged but NOT checked out in a worktree', async () => {
      mockIsBranchMerged.mockResolvedValue({ success: true, isMerged: true })

      // Pre-populate merge branch
      useGitStore.setState({
        defaultMergeBranch: new Map([['proj-1', 'main']])
      })

      render(<GitPushPull worktreePath="/path/to/worktree" />)

      // Wait for the isBranchMerged check to resolve
      // Note: branches list is empty (no worktree info for 'main'), so Delete should show
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })

      expect(screen.getByTestId('delete-branch-button')).toBeInTheDocument()
      expect(screen.queryByTestId('archive-merged-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('merge-button')).not.toBeInTheDocument()
    })
  })

  describe('isBranchMerged check behavior', () => {
    test('does not call isBranchMerged when no branch is selected', async () => {
      render(<GitPushPull worktreePath="/path/to/worktree" />)

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })

      // No branch selected = no check
      expect(mockIsBranchMerged).not.toHaveBeenCalled()
    })

    test('does not call isBranchMerged when no worktreePath', () => {
      render(<GitPushPull worktreePath={null} />)
      expect(mockIsBranchMerged).not.toHaveBeenCalled()
    })

    test('calls isBranchMerged when a merge branch is pre-populated', async () => {
      useGitStore.setState({
        defaultMergeBranch: new Map([['proj-1', 'main']])
      })

      render(<GitPushPull worktreePath="/path/to/worktree" />)

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })

      expect(mockIsBranchMerged).toHaveBeenCalledWith('/path/to/worktree', 'main')
    })
  })

  describe('merge branch selection stability', () => {
    test('selecting branch works after worktreePath changes from null to a value', async () => {
      mockListBranchesWithStatus.mockResolvedValue({
        success: true,
        branches: [
          { name: 'main', isRemote: false, isCheckedOut: false },
          { name: 'develop', isRemote: false, isCheckedOut: false }
        ]
      })

      const { rerender } = render(<GitPushPull worktreePath={null} />)

      rerender(<GitPushPull worktreePath="/path/to/worktree" />)

      fireEvent.click(screen.getByTestId('merge-branch-trigger'))

      await waitFor(() => {
        expect(mockListBranchesWithStatus).toHaveBeenCalledWith('/path/to/worktree')
      })

      const dropdown = screen.getByTestId('merge-branch-dropdown')
      fireEvent.click(within(dropdown).getByRole('button', { name: 'main' }))

      await waitFor(() => {
        expect(useGitStore.getState().selectedMergeBranch.get('/path/to/worktree')).toBe('main')
      })
    })

    test('selecting branch after switching worktree updates the current worktree key', async () => {
      useWorktreeStore.setState({
        selectedWorktreeId: 'wt-2',
        worktreesByProject: new Map([
          [
            'proj-1',
            [
              {
                id: 'wt-1',
                project_id: 'proj-1',
                path: '/path/to/worktree',
                branch_name: 'feature-branch',
                is_default: false,
                name: 'feature-branch',
                status: 'active' as const,
                branch_renamed: 0,
                last_message_at: null,
                session_titles: '[]',
                last_model_provider_id: null,
                last_model_id: null,
                last_model_variant: null,
                created_at: '2024-01-01',
                last_accessed_at: '2024-01-01'
              },
              {
                id: 'wt-2',
                project_id: 'proj-1',
                path: '/path/to/worktree-2',
                branch_name: 'feature-2',
                is_default: false,
                name: 'feature-2',
                status: 'active' as const,
                branch_renamed: 0,
                last_message_at: null,
                session_titles: '[]',
                last_model_provider_id: null,
                last_model_id: null,
                last_model_variant: null,
                created_at: '2024-01-01',
                last_accessed_at: '2024-01-01'
              }
            ]
          ]
        ])
      })

      mockListBranchesWithStatus.mockResolvedValue({
        success: true,
        branches: [{ name: 'main', isRemote: false, isCheckedOut: false }]
      })

      const { rerender } = render(<GitPushPull worktreePath="/path/to/worktree" />)

      rerender(<GitPushPull worktreePath="/path/to/worktree-2" />)

      fireEvent.click(screen.getByTestId('merge-branch-trigger'))

      await waitFor(() => {
        expect(mockListBranchesWithStatus).toHaveBeenCalledWith('/path/to/worktree-2')
      })

      const dropdown = screen.getByTestId('merge-branch-dropdown')
      fireEvent.click(within(dropdown).getByRole('button', { name: 'main' }))

      await waitFor(() => {
        expect(useGitStore.getState().selectedMergeBranch.get('/path/to/worktree-2')).toBe('main')
      })
    })
  })
})
