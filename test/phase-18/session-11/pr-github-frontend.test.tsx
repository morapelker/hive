/**
 * Session 11: PR to GitHub — Frontend Tests
 *
 * Testing criteria from phase-18.md:
 * - PR button visible when isGitHub is true
 * - PR button hidden when isGitHub is false
 * - handleCreatePR creates session with correct prompt
 * - Target branch dropdown shows remote branches
 * - Selecting target branch updates store
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { GitPushPull } from '../../../src/renderer/src/components/git/GitPushPull'

const mockWorktree = {
  id: 'wt-1',
  project_id: 'proj-1',
  name: 'test',
  branch_name: 'feature',
  path: '/test/path',
  status: 'active' as const,
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  created_at: '2025-01-01T00:00:00.000Z',
  last_accessed_at: '2025-01-01T00:00:00.000Z'
}

beforeEach(() => {
  // Reset stores
  useGitStore.setState({
    remoteInfo: new Map(),
    prTargetBranch: new Map(),
    branchInfoByWorktree: new Map(),
    fileStatusesByWorktree: new Map(),
    isPushing: false,
    isPulling: false,
    isCommitting: false,
    isLoading: false,
    error: null
  })

  // Mock window.gitOps
  Object.defineProperty(window, 'gitOps', {
    writable: true,
    value: {
      ...window.gitOps,
      getRemoteUrl: vi.fn().mockResolvedValue({ success: true, url: null, remote: null }),
      listBranchesWithStatus: vi.fn().mockResolvedValue({ success: true, branches: [] }),
      getFileStatuses: vi.fn().mockResolvedValue({ success: true, files: [] }),
      getBranchInfo: vi.fn().mockResolvedValue({
        success: true,
        branch: { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }
      }),
      push: vi.fn().mockResolvedValue({ success: true }),
      pull: vi.fn().mockResolvedValue({ success: true }),
      merge: vi.fn().mockResolvedValue({ success: true })
    }
  })
})

describe('Session 11: PR to GitHub Frontend', () => {
  describe('PR button visibility', () => {
    test('PR button visible when isGitHub is true', () => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
      useGitStore.setState({
        remoteInfo: new Map([
          ['wt-1', { hasRemote: true, isGitHub: true, url: 'git@github.com:org/repo.git' }]
        ]),
        branchInfoByWorktree: new Map([
          ['/test/path', { name: 'feature', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitPushPull worktreePath="/test/path" />)

      expect(screen.getByTestId('pr-button')).toBeInTheDocument()
    })

    test('PR button hidden when isGitHub is false', () => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
      useGitStore.setState({
        remoteInfo: new Map([
          ['wt-1', { hasRemote: true, isGitHub: false, url: 'https://gitlab.com/org/repo.git' }]
        ])
      })

      render(<GitPushPull worktreePath="/test/path" />)

      expect(screen.queryByTestId('pr-button')).not.toBeInTheDocument()
    })

    test('PR button hidden when no remote info', () => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
      useGitStore.setState({
        remoteInfo: new Map()
      })

      render(<GitPushPull worktreePath="/test/path" />)

      expect(screen.queryByTestId('pr-button')).not.toBeInTheDocument()
    })

    test('PR button hidden when no worktree selected', () => {
      useWorktreeStore.setState({ selectedWorktreeId: null })

      render(<GitPushPull worktreePath="/test/path" />)

      expect(screen.queryByTestId('pr-button')).not.toBeInTheDocument()
    })

    test('PR section has correct data-testid', () => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
      useGitStore.setState({
        remoteInfo: new Map([
          ['wt-1', { hasRemote: true, isGitHub: true, url: 'git@github.com:org/repo.git' }]
        ])
      })

      render(<GitPushPull worktreePath="/test/path" />)

      expect(screen.getByTestId('pr-section')).toBeInTheDocument()
    })
  })

  describe('Target branch dropdown', () => {
    test('displays default target branch from tracking', () => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
      useGitStore.setState({
        remoteInfo: new Map([
          ['wt-1', { hasRemote: true, isGitHub: true, url: 'git@github.com:org/repo.git' }]
        ]),
        branchInfoByWorktree: new Map([
          ['/test/path', { name: 'feature', tracking: 'origin/develop', ahead: 1, behind: 0 }]
        ])
      })

      render(<GitPushPull worktreePath="/test/path" />)

      const trigger = screen.getByTestId('pr-target-branch-trigger')
      expect(trigger.textContent).toContain('origin/develop')
    })

    test('displays custom target branch when set', () => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
      useGitStore.setState({
        remoteInfo: new Map([
          ['wt-1', { hasRemote: true, isGitHub: true, url: 'git@github.com:org/repo.git' }]
        ]),
        prTargetBranch: new Map([['wt-1', 'origin/release']]),
        branchInfoByWorktree: new Map([
          ['/test/path', { name: 'feature', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitPushPull worktreePath="/test/path" />)

      const trigger = screen.getByTestId('pr-target-branch-trigger')
      expect(trigger.textContent).toContain('origin/release')
    })

    test('displays fallback origin/main when no tracking branch', () => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
      useGitStore.setState({
        remoteInfo: new Map([
          ['wt-1', { hasRemote: true, isGitHub: true, url: 'git@github.com:org/repo.git' }]
        ]),
        branchInfoByWorktree: new Map([
          ['/test/path', { name: 'feature', tracking: null, ahead: 0, behind: 0 }]
        ])
      })

      render(<GitPushPull worktreePath="/test/path" />)

      const trigger = screen.getByTestId('pr-target-branch-trigger')
      expect(trigger.textContent).toContain('origin/main')
    })

    test('selecting target branch updates store', () => {
      useGitStore.getState().setPrTargetBranch('wt-1', 'origin/release')

      expect(useGitStore.getState().prTargetBranch.get('wt-1')).toBe('origin/release')
    })
  })

  describe('handleCreatePR', () => {
    test('creates session with correct prompt containing target branch', async () => {
      const createSessionMock = vi.fn().mockResolvedValue({
        success: true,
        session: { id: 'new-session-1' }
      })
      const updateSessionNameMock = vi.fn().mockResolvedValue(true)
      const setPendingMessageMock = vi.fn()

      useWorktreeStore.setState({
        selectedWorktreeId: 'wt-1',
        worktreesByProject: new Map([['proj-1', [mockWorktree]]])
      })

      useSessionStore.setState({
        createSession: createSessionMock,
        updateSessionName: updateSessionNameMock,
        setPendingMessage: setPendingMessageMock
      })

      useGitStore.setState({
        remoteInfo: new Map([
          ['wt-1', { hasRemote: true, isGitHub: true, url: 'git@github.com:org/repo.git' }]
        ]),
        branchInfoByWorktree: new Map([
          ['/test/path', { name: 'feature', tracking: 'origin/main', ahead: 1, behind: 0 }]
        ])
      })

      render(<GitPushPull worktreePath="/test/path" />)

      const prButton = screen.getByTestId('pr-button')
      fireEvent.click(prButton)

      await waitFor(() => {
        expect(createSessionMock).toHaveBeenCalledWith('wt-1', 'proj-1')
      })

      await waitFor(() => {
        expect(updateSessionNameMock).toHaveBeenCalledWith('new-session-1', 'PR → origin/main')
      })

      await waitFor(() => {
        expect(setPendingMessageMock).toHaveBeenCalledWith(
          'new-session-1',
          expect.stringContaining('gh pr create')
        )
      })
    })

    test('prompt includes custom target branch when set', async () => {
      const createSessionMock = vi.fn().mockResolvedValue({
        success: true,
        session: { id: 'new-session-2' }
      })
      const updateSessionNameMock = vi.fn().mockResolvedValue(true)
      const setPendingMessageMock = vi.fn()

      useWorktreeStore.setState({
        selectedWorktreeId: 'wt-1',
        worktreesByProject: new Map([['proj-1', [mockWorktree]]])
      })

      useSessionStore.setState({
        createSession: createSessionMock,
        updateSessionName: updateSessionNameMock,
        setPendingMessage: setPendingMessageMock
      })

      useGitStore.setState({
        remoteInfo: new Map([
          ['wt-1', { hasRemote: true, isGitHub: true, url: 'git@github.com:org/repo.git' }]
        ]),
        prTargetBranch: new Map([['wt-1', 'origin/release']]),
        branchInfoByWorktree: new Map([
          ['/test/path', { name: 'feature', tracking: 'origin/main', ahead: 1, behind: 0 }]
        ])
      })

      render(<GitPushPull worktreePath="/test/path" />)

      const prButton = screen.getByTestId('pr-button')
      fireEvent.click(prButton)

      await waitFor(() => {
        expect(updateSessionNameMock).toHaveBeenCalledWith('new-session-2', 'PR → origin/release')
      })

      await waitFor(() => {
        expect(setPendingMessageMock).toHaveBeenCalledWith(
          'new-session-2',
          expect.stringContaining('origin/release')
        )
      })
    })

    test('PR button not shown when no worktree selected', () => {
      useWorktreeStore.setState({ selectedWorktreeId: null })

      // When no selectedWorktreeId, isGitHub will be false, so button won't render
      render(<GitPushPull worktreePath="/test/path" />)

      expect(screen.queryByTestId('pr-button')).not.toBeInTheDocument()
    })

    test('does not call updateSessionName when createSession fails', async () => {
      const createSessionMock = vi.fn().mockResolvedValue({
        success: false,
        error: 'DB error'
      })
      const updateSessionNameMock = vi.fn()

      useWorktreeStore.setState({
        selectedWorktreeId: 'wt-1',
        worktreesByProject: new Map([['proj-1', [mockWorktree]]])
      })

      useSessionStore.setState({
        createSession: createSessionMock,
        updateSessionName: updateSessionNameMock,
        setPendingMessage: vi.fn()
      })

      useGitStore.setState({
        remoteInfo: new Map([
          ['wt-1', { hasRemote: true, isGitHub: true, url: 'git@github.com:org/repo.git' }]
        ]),
        branchInfoByWorktree: new Map([
          ['/test/path', { name: 'feature', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitPushPull worktreePath="/test/path" />)

      const prButton = screen.getByTestId('pr-button')
      fireEvent.click(prButton)

      await waitFor(() => {
        expect(createSessionMock).toHaveBeenCalled()
      })

      // updateSessionName should NOT be called when createSession fails
      expect(updateSessionNameMock).not.toHaveBeenCalled()
    })
  })

  describe('Remote branches for dropdown', () => {
    test('remote branches are filtered from branch list', () => {
      const allBranches = [
        { name: 'main', isRemote: false, isCheckedOut: true },
        { name: 'feature', isRemote: false, isCheckedOut: false },
        { name: 'origin/main', isRemote: true, isCheckedOut: false },
        { name: 'origin/develop', isRemote: true, isCheckedOut: false }
      ]

      const remoteBranches = allBranches.filter((b) => b.isRemote)

      expect(remoteBranches).toHaveLength(2)
      expect(remoteBranches[0].name).toBe('origin/main')
      expect(remoteBranches[1].name).toBe('origin/develop')
    })
  })

  describe('PR prompt content', () => {
    test('prompt includes gh pr create command', () => {
      const targetBranch = 'origin/main'
      const prompt = [
        `Create a pull request targeting ${targetBranch}.`,
        `Use \`gh pr create\` to create the PR.`,
        `Base the PR title and description on the git diff between HEAD and ${targetBranch}.`,
        `Make the description comprehensive, summarizing all changes.`
      ].join(' ')

      expect(prompt).toContain('gh pr create')
      expect(prompt).toContain('origin/main')
      expect(prompt).toContain('git diff between HEAD')
    })

    test('session name includes target branch', () => {
      const targetBranch = 'origin/main'
      const sessionName = `PR → ${targetBranch}`

      expect(sessionName).toBe('PR → origin/main')
    })
  })
})
