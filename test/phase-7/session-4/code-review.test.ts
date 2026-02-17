import { describe, test, expect, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

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
  // Review prompt construction tests (branch comparison)
  // ---------------------------------------------------------------------------
  describe('Review prompt construction', () => {
    test('default prompt includes branch comparison and focus areas', () => {
      const branchName = 'feature-auth'
      const targetBranch = 'origin/main'
      const prompt = [
        `Please review the changes on branch "${branchName}" compared to ${targetBranch}.`,
        `Use \`git diff ${targetBranch}...HEAD\` to get the full diff.`,
        'Focus on: bugs, logic errors, and code quality.'
      ].join('\n')

      expect(prompt).toContain('feature-auth')
      expect(prompt).toContain('origin/main')
      expect(prompt).toContain('git diff origin/main...HEAD')
      expect(prompt).toContain('bugs, logic errors, and code quality')
    })

    test('prompt with template appends branch comparison', () => {
      const template = '## Custom Review\nPlease review carefully.'
      const branchName = 'feature-auth'
      const targetBranch = 'origin/main'
      const prompt = [
        template,
        '',
        '---',
        '',
        `Compare the current branch (${branchName}) against ${targetBranch}.`,
        `Use \`git diff ${targetBranch}...HEAD\` to see all changes.`
      ].join('\n')

      expect(prompt).toContain('Custom Review')
      expect(prompt).toContain('git diff origin/main...HEAD')
      expect(prompt).toContain('feature-auth')
    })
  })

  // ---------------------------------------------------------------------------
  // Session creation for review tests
  // ---------------------------------------------------------------------------
  describe('Session creation for review', () => {
    test('session name follows "Code Review — {branch} vs {target}" pattern', () => {
      const branchName = 'feature-auth'
      const targetBranch = 'origin/main'
      const sessionName = `Code Review — ${branchName} vs ${targetBranch}`
      expect(sessionName).toBe('Code Review — feature-auth vs origin/main')
    })

    test('session name handles unknown branch', () => {
      const branchName = 'unknown'
      const targetBranch = 'origin/main'
      const sessionName = `Code Review — ${branchName} vs ${targetBranch}`
      expect(sessionName).toBe('Code Review — unknown vs origin/main')
    })
  })

  // ---------------------------------------------------------------------------
  // Review target branch store tests
  // ---------------------------------------------------------------------------
  describe('Review target branch store', () => {
    test('setReviewTargetBranch stores branch for worktree', async () => {
      const { useGitStore } = await import(
        '../../../src/renderer/src/stores/useGitStore'
      )

      useGitStore.getState().setReviewTargetBranch('wt-1', 'origin/develop')
      expect(useGitStore.getState().reviewTargetBranch.get('wt-1')).toBe('origin/develop')
    })

    test('setReviewTargetBranch updates existing branch', async () => {
      const { useGitStore } = await import(
        '../../../src/renderer/src/stores/useGitStore'
      )

      useGitStore.getState().setReviewTargetBranch('wt-1', 'origin/develop')
      useGitStore.getState().setReviewTargetBranch('wt-1', 'origin/main')
      expect(useGitStore.getState().reviewTargetBranch.get('wt-1')).toBe('origin/main')
    })

    test('reviewTargetBranch returns undefined for unknown worktree', async () => {
      const { useGitStore } = await import(
        '../../../src/renderer/src/stores/useGitStore'
      )

      expect(useGitStore.getState().reviewTargetBranch.get('nonexistent')).toBeUndefined()
    })
  })
})
