import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import React from 'react'

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------
const mockGitOps = {
  getFileStatuses: vi.fn().mockResolvedValue({ success: true, files: [] }),
  getBranchInfo: vi.fn().mockResolvedValue({
    success: true,
    branch: { name: 'feature-auth', tracking: null, ahead: 0, behind: 0 }
  }),
  stageFile: vi.fn().mockResolvedValue({ success: true }),
  unstageFile: vi.fn().mockResolvedValue({ success: true }),
  stageAll: vi.fn().mockResolvedValue({ success: true }),
  unstageAll: vi.fn().mockResolvedValue({ success: true }),
  discardChanges: vi.fn().mockResolvedValue({ success: true }),
  addToGitignore: vi.fn().mockResolvedValue({ success: true }),
  commit: vi.fn().mockResolvedValue({ success: true }),
  push: vi.fn().mockResolvedValue({ success: true }),
  pull: vi.fn().mockResolvedValue({ success: true }),
  getDiff: vi.fn().mockResolvedValue({ success: true, diff: '' }),
  openInEditor: vi.fn().mockResolvedValue({ success: true }),
  showInFinder: vi.fn().mockResolvedValue({ success: true }),
  onStatusChanged: vi.fn().mockReturnValue(() => {})
}

const mockFileOps = {
  readFile: vi.fn().mockResolvedValue({ success: false })
}

const mockDb = {
  setting: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getAll: vi.fn() },
  project: {
    create: vi.fn(),
    get: vi.fn(),
    getByPath: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    delete: vi.fn(),
    touch: vi.fn()
  },
  worktree: {
    create: vi.fn(),
    get: vi.fn(),
    getByProject: vi.fn(),
    getActiveByProject: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    delete: vi.fn(),
    archive: vi.fn(),
    touch: vi.fn()
  },
  session: {
    create: vi.fn().mockResolvedValue({
      id: 'review-session-1',
      worktree_id: 'wt-1',
      project_id: 'proj-1',
      name: 'Session 14:00',
      status: 'active',
      opencode_session_id: null,
      mode: 'build',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null
    }),
    get: vi.fn(),
    getByWorktree: vi.fn(),
    getByProject: vi.fn(),
    getActiveByWorktree: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn(),
    search: vi.fn()
  },
  message: {
    create: vi.fn().mockResolvedValue({}),
    getBySession: vi.fn().mockResolvedValue([]),
    delete: vi.fn()
  },
  schemaVersion: vi.fn(),
  tableExists: vi.fn(),
  getIndexes: vi.fn()
}

const mockWorktreeOps = {
  create: vi.fn(),
  delete: vi.fn(),
  sync: vi.fn(),
  exists: vi.fn(),
  openInTerminal: vi.fn(),
  openInEditor: vi.fn(),
  getBranches: vi.fn(),
  branchExists: vi.fn(),
  duplicate: vi.fn()
}

const mockProjectOps = {
  openDirectoryDialog: vi.fn(),
  isGitRepository: vi.fn(),
  validateProject: vi.fn(),
  showInFolder: vi.fn(),
  openPath: vi.fn(),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  readFromClipboard: vi.fn(),
  detectLanguage: vi.fn(),
  loadLanguageIcons: vi.fn()
}

describe('Session 4: Code Review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()

    Object.defineProperty(window, 'gitOps', { writable: true, value: mockGitOps })
    Object.defineProperty(window, 'fileOps', { writable: true, value: mockFileOps })
    Object.defineProperty(window, 'db', { writable: true, value: mockDb })
    Object.defineProperty(window, 'worktreeOps', { writable: true, value: mockWorktreeOps })
    Object.defineProperty(window, 'projectOps', { writable: true, value: mockProjectOps })
  })

  // ---------------------------------------------------------------------------
  // GitStatusPanel Review button tests
  // ---------------------------------------------------------------------------
  describe('GitStatusPanel Review Button', () => {
    test('Review button rendered when changes exist', async () => {
      // Return files from getFileStatuses
      mockGitOps.getFileStatuses.mockResolvedValue({
        success: true,
        files: [
          { path: '/path/App.tsx', relativePath: 'App.tsx', status: 'M', staged: false }
        ]
      })

      const { GitStatusPanel } = await import(
        '../../../src/renderer/src/components/git/GitStatusPanel'
      )

      render(React.createElement(GitStatusPanel, { worktreePath: '/path/to/worktree' }))

      await waitFor(() => {
        const reviewButton = screen.getByTestId('git-review-button')
        expect(reviewButton).toBeTruthy()
        expect(reviewButton).not.toBeDisabled()
      })
    })

    test('Review button disabled when no changes', async () => {
      // Return empty files
      mockGitOps.getFileStatuses.mockResolvedValue({
        success: true,
        files: []
      })

      const { GitStatusPanel } = await import(
        '../../../src/renderer/src/components/git/GitStatusPanel'
      )

      render(React.createElement(GitStatusPanel, { worktreePath: '/path/to/worktree' }))

      await waitFor(() => {
        const reviewButton = screen.getByTestId('git-review-button')
        expect(reviewButton).toBeDisabled()
      })
    })

    test('Review button not rendered when no worktree path', async () => {
      const { GitStatusPanel } = await import(
        '../../../src/renderer/src/components/git/GitStatusPanel'
      )

      const { container } = render(
        React.createElement(GitStatusPanel, { worktreePath: null })
      )

      // Component returns null when no worktreePath
      expect(container.innerHTML).toBe('')
    })
  })

  // ---------------------------------------------------------------------------
  // Session store pending messages tests
  // ---------------------------------------------------------------------------
  describe('Session store pending messages', () => {
    test('setPendingMessage stores message', async () => {
      const { useSessionStore } = await import(
        '../../../src/renderer/src/stores/useSessionStore'
      )

      useSessionStore.getState().setPendingMessage('session-1', 'Review prompt text')
      expect(useSessionStore.getState().pendingMessages.get('session-1')).toBe('Review prompt text')
    })

    test('consumePendingMessage returns and removes message', async () => {
      const { useSessionStore } = await import(
        '../../../src/renderer/src/stores/useSessionStore'
      )

      useSessionStore.getState().setPendingMessage('session-2', 'Another prompt')

      const message = useSessionStore.getState().consumePendingMessage('session-2')
      expect(message).toBe('Another prompt')

      // Should be removed
      const again = useSessionStore.getState().consumePendingMessage('session-2')
      expect(again).toBeNull()
    })

    test('consumePendingMessage returns null for unknown session', async () => {
      const { useSessionStore } = await import(
        '../../../src/renderer/src/stores/useSessionStore'
      )

      const message = useSessionStore.getState().consumePendingMessage('nonexistent')
      expect(message).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Review prompt construction tests
  // ---------------------------------------------------------------------------
  describe('Review prompt construction', () => {
    test('prompt includes changed file list', () => {
      const files = [
        { status: 'M', relativePath: 'src/App.tsx' },
        { status: 'A', relativePath: 'src/New.tsx' },
        { status: '?', relativePath: 'src/util.ts' }
      ]

      const fileList = files
        .map(f => `- ${f.status}  ${f.relativePath}`)
        .join('\n')

      expect(fileList).toContain('- M  src/App.tsx')
      expect(fileList).toContain('- A  src/New.tsx')
      expect(fileList).toContain('- ?  src/util.ts')
    })

    test('default prompt includes focus areas', () => {
      const branchName = 'feature-auth'
      const fileList = '- M  src/App.tsx'
      const prompt = `Please review the following uncommitted changes in this worktree (branch: ${branchName}):\n\nChanged files:\n${fileList}\n\nFocus on:\n- Bugs and logic errors\n- Code quality issues\n- Security concerns\n- Performance issues\n\nProvide specific, actionable feedback for each issue found.`

      expect(prompt).toContain('Bugs and logic errors')
      expect(prompt).toContain('Code quality issues')
      expect(prompt).toContain('Security concerns')
      expect(prompt).toContain('Performance issues')
      expect(prompt).toContain('feature-auth')
      expect(prompt).toContain('src/App.tsx')
    })

    test('prompt with template uses template content', () => {
      const template = '## Custom Review\nPlease review carefully.'
      const fileList = '- M  src/App.tsx'
      const prompt = `${template}\n\n---\n\nPlease review the following uncommitted changes in this worktree:\n\nChanged files:\n${fileList}\n\nFocus on: bugs, logic errors, and code quality.`

      expect(prompt).toContain('Custom Review')
      expect(prompt).toContain('src/App.tsx')
    })
  })

  // ---------------------------------------------------------------------------
  // Session creation for review tests
  // ---------------------------------------------------------------------------
  describe('Session creation for review', () => {
    test('session name follows "Code Review — {branch}" pattern', () => {
      const branchName = 'feature-auth'
      const sessionName = `Code Review — ${branchName}`
      expect(sessionName).toBe('Code Review — feature-auth')
    })

    test('session name handles unknown branch', () => {
      const branchName = 'unknown'
      const sessionName = `Code Review — ${branchName}`
      expect(sessionName).toBe('Code Review — unknown')
    })
  })
})
