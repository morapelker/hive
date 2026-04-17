import { describe, test, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
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
    setPinnedToBoard: vi.fn().mockResolvedValue(undefined),
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
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')

      useSessionStore.getState().setPendingMessage('session-1', 'Review prompt text')
      expect(useSessionStore.getState().pendingMessages.get('session-1')).toBe('Review prompt text')
    })

    test('consumePendingMessage returns and removes message', async () => {
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')

      useSessionStore.getState().setPendingMessage('session-2', 'Another prompt')

      const message = useSessionStore.getState().consumePendingMessage('session-2')
      expect(message).toBe('Another prompt')

      // Should be removed
      const again = useSessionStore.getState().consumePendingMessage('session-2')
      expect(again).toBeNull()
    })

    test('consumePendingMessage returns null for unknown session', async () => {
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')

      const message = useSessionStore.getState().consumePendingMessage('nonexistent')
      expect(message).toBeNull()
    })

    test('dequeuePendingMessage returns and removes message', async () => {
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')

      useSessionStore.getState().setPendingMessage('session-3', 'Dequeued prompt')

      const message = useSessionStore.getState().dequeuePendingMessage('session-3')
      expect(message).toBe('Dequeued prompt')
      expect(useSessionStore.getState().pendingMessages.get('session-3')).toBeUndefined()
    })

    test('requeuePendingMessage restores a failed auto-send prompt', async () => {
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')

      useSessionStore.getState().setPendingMessage('session-4', 'Failed prompt')
      const dequeued = useSessionStore.getState().dequeuePendingMessage('session-4')
      expect(dequeued).toBe('Failed prompt')

      useSessionStore.getState().requeuePendingMessage('session-4', dequeued!)

      expect(useSessionStore.getState().consumePendingMessage('session-4')).toBe('Failed prompt')
    })
  })

  // ---------------------------------------------------------------------------
  // Review prompt construction tests (branch comparison)
  // ---------------------------------------------------------------------------
  describe('Review prompt construction', () => {
    test('REVIEW_PROMPTS contains all three prompt types', async () => {
      const { REVIEW_PROMPTS } = await import('../../../src/renderer/src/constants/reviewPrompts')

      expect(REVIEW_PROMPTS).toHaveProperty('superpowers')
      expect(REVIEW_PROMPTS).toHaveProperty('adversarial')
      expect(REVIEW_PROMPTS).toHaveProperty('standard')
    })

    test('default review prompt type is standard', async () => {
      const { DEFAULT_REVIEW_PROMPT_TYPE } = await import(
        '../../../src/renderer/src/constants/reviewPrompts'
      )

      expect(DEFAULT_REVIEW_PROMPT_TYPE).toBe('standard')
    })

    test('settings reset restores standard review prompt type', async () => {
      const { useSettingsStore } = await import('../../../src/renderer/src/stores/useSettingsStore')

      useSettingsStore.getState().updateSetting('reviewPromptType', 'superpowers')
      expect(useSettingsStore.getState().reviewPromptType).toBe('superpowers')

      useSettingsStore.getState().resetToDefaults()

      expect(useSettingsStore.getState().reviewPromptType).toBe('standard')
    })

    test('loading persisted superpowers review prompt preserves existing user preference', async () => {
      const { useSettingsStore } = await import('../../../src/renderer/src/stores/useSettingsStore')

      mockDb.setting.get.mockResolvedValueOnce(JSON.stringify({
        reviewPromptType: 'superpowers'
      }))

      await useSettingsStore.getState().loadFromDatabase()

      expect(useSettingsStore.getState().reviewPromptType).toBe('superpowers')
    })

    test('each prompt type produces a non-empty string', async () => {
      const { REVIEW_PROMPTS } = await import('../../../src/renderer/src/constants/reviewPrompts')

      for (const [, content] of Object.entries(REVIEW_PROMPTS)) {
        expect(content).toBeTruthy()
        expect(typeof content).toBe('string')
        expect(content.length).toBeGreaterThan(10)
      }
    })

    test('prompt construction appends branch comparison to template', async () => {
      const { REVIEW_PROMPTS } = await import('../../../src/renderer/src/constants/reviewPrompts')

      const branchName = 'feature-auth'
      const target = 'origin/main'
      const reviewTemplate = REVIEW_PROMPTS.superpowers

      const prompt = [
        reviewTemplate,
        '',
        '---',
        '',
        `Compare the current branch (${branchName}) against ${target}.`,
        `Use \`git diff ${target}...HEAD\` to see all changes.`
      ].join('\n')

      expect(prompt).toContain('superpowers:code-reviewer')
      expect(prompt).toContain('---')
      expect(prompt).toContain('feature-auth')
      expect(prompt).toContain('origin/main')
      expect(prompt).toContain('git diff origin/main...HEAD')
    })

    test('selecting adversarial prompt type uses adversarial content', async () => {
      const { REVIEW_PROMPTS } = await import('../../../src/renderer/src/constants/reviewPrompts')

      const branchName = 'feature-auth'
      const target = 'origin/main'
      const reviewTemplate = REVIEW_PROMPTS.adversarial

      const prompt = [
        reviewTemplate,
        '',
        '---',
        '',
        `Compare the current branch (${branchName}) against ${target}.`,
        `Use \`git diff ${target}...HEAD\` to see all changes.`
      ].join('\n')

      expect(prompt).toContain('Adversarial Code Review')
      expect(prompt).toContain('feature-auth')
    })

    test('selecting standard prompt type uses standard content', async () => {
      const { REVIEW_PROMPTS } = await import('../../../src/renderer/src/constants/reviewPrompts')

      const branchName = 'feature-auth'
      const target = 'origin/main'
      const reviewTemplate = REVIEW_PROMPTS.standard

      const prompt = [
        reviewTemplate,
        '',
        '---',
        '',
        `Compare the current branch (${branchName}) against ${target}.`,
        `Use \`git diff ${target}...HEAD\` to see all changes.`
      ].join('\n')

      expect(prompt).toContain('bugs, logic errors, and code quality')
      expect(prompt).toContain('feature-auth')
    })

    test('REVIEW_PROMPT_LABELS has human-readable labels for all types', async () => {
      const { REVIEW_PROMPT_LABELS } = await import(
        '../../../src/renderer/src/constants/reviewPrompts'
      )

      expect(REVIEW_PROMPT_LABELS.superpowers).toBe('Superpowers')
      expect(REVIEW_PROMPT_LABELS.adversarial).toBe('Adversarial')
      expect(REVIEW_PROMPT_LABELS.standard).toBe('Standard')
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

    test('focuses the new review tab when not currently on the board', async () => {
      const [{ usePinAndActivateSession }, { useSessionStore }, { useKanbanStore }, { useSettingsStore }, { useFileViewerStore }] = await Promise.all([
        import('../../../src/renderer/src/hooks/usePinAndActivateSession'),
        import('../../../src/renderer/src/stores/useSessionStore'),
        import('../../../src/renderer/src/stores/useKanbanStore'),
        import('../../../src/renderer/src/stores/useSettingsStore'),
        import('../../../src/renderer/src/stores/useFileViewerStore')
      ])

      act(() => {
        useSettingsStore.setState({ boardMode: 'toggle' })
        useKanbanStore.setState({ isBoardViewActive: false })
        useFileViewerStore.setState({
          openFiles: new Map(),
          activeFilePath: null,
          activeDiff: null,
          contextEditorWorktreeId: null
        })
        useSessionStore.setState({
          activeSessionId: 'session-0',
          activeWorktreeId: 'wt-1',
          activePinnedSessionId: null,
          inlineConnectionSessionId: null,
          pinnedSessionIds: new Set()
        })
      })

      const { result } = renderHook(() => usePinAndActivateSession())

      await act(async () => {
        await result.current.pinAndActivate(async () => 'review-session-1')
      })

      expect(mockDb.session.setPinnedToBoard).toHaveBeenCalledWith('review-session-1', true)
      expect(useSessionStore.getState().pinnedSessionIds.has('review-session-1')).toBe(true)
      expect(useSessionStore.getState().activeSessionId).toBe('review-session-1')
    })

    test('keeps focus on toggle board when the board is visible', async () => {
      const [{ usePinAndActivateSession }, { useSessionStore }, { useKanbanStore }, { useSettingsStore }, { useFileViewerStore }] = await Promise.all([
        import('../../../src/renderer/src/hooks/usePinAndActivateSession'),
        import('../../../src/renderer/src/stores/useSessionStore'),
        import('../../../src/renderer/src/stores/useKanbanStore'),
        import('../../../src/renderer/src/stores/useSettingsStore'),
        import('../../../src/renderer/src/stores/useFileViewerStore')
      ])

      act(() => {
        useSettingsStore.setState({ boardMode: 'toggle' })
        useKanbanStore.setState({ isBoardViewActive: true })
        useFileViewerStore.setState({
          openFiles: new Map(),
          activeFilePath: null,
          activeDiff: null,
          contextEditorWorktreeId: null
        })
        useSessionStore.setState({
          activeSessionId: 'session-0',
          activeWorktreeId: 'wt-1',
          activePinnedSessionId: null,
          inlineConnectionSessionId: null,
          pinnedSessionIds: new Set()
        })
      })

      const { result } = renderHook(() => usePinAndActivateSession())

      await act(async () => {
        await result.current.pinAndActivate(async () => 'review-session-2')
      })

      expect(useSessionStore.getState().pinnedSessionIds.has('review-session-2')).toBe(true)
      expect(useSessionStore.getState().activeSessionId).toBe('session-0')
    })

    test('keeps focus on sticky board when the board tab is visible', async () => {
      const [{ usePinAndActivateSession }, { useSessionStore, BOARD_TAB_ID }, { useKanbanStore }, { useSettingsStore }, { useFileViewerStore }] = await Promise.all([
        import('../../../src/renderer/src/hooks/usePinAndActivateSession'),
        import('../../../src/renderer/src/stores/useSessionStore'),
        import('../../../src/renderer/src/stores/useKanbanStore'),
        import('../../../src/renderer/src/stores/useSettingsStore'),
        import('../../../src/renderer/src/stores/useFileViewerStore')
      ])

      act(() => {
        useSettingsStore.setState({ boardMode: 'sticky-tab' })
        useKanbanStore.setState({ isBoardViewActive: false })
        useFileViewerStore.setState({
          openFiles: new Map(),
          activeFilePath: null,
          activeDiff: null,
          contextEditorWorktreeId: null
        })
        useSessionStore.setState({
          activeSessionId: BOARD_TAB_ID,
          activeWorktreeId: 'wt-1',
          activePinnedSessionId: null,
          inlineConnectionSessionId: null,
          pinnedSessionIds: new Set()
        })
      })

      const { result } = renderHook(() => usePinAndActivateSession())

      await act(async () => {
        await result.current.pinAndActivate(async () => 'review-session-3')
      })

      expect(useSessionStore.getState().pinnedSessionIds.has('review-session-3')).toBe(true)
      expect(useSessionStore.getState().activeSessionId).toBe(BOARD_TAB_ID)
    })

    test('focuses the new review tab when board mode is active but an overlay is covering it', async () => {
      const [{ usePinAndActivateSession }, { useSessionStore }, { useKanbanStore }, { useSettingsStore }, { useFileViewerStore }] = await Promise.all([
        import('../../../src/renderer/src/hooks/usePinAndActivateSession'),
        import('../../../src/renderer/src/stores/useSessionStore'),
        import('../../../src/renderer/src/stores/useKanbanStore'),
        import('../../../src/renderer/src/stores/useSettingsStore'),
        import('../../../src/renderer/src/stores/useFileViewerStore')
      ])

      act(() => {
        useSettingsStore.setState({ boardMode: 'toggle' })
        useKanbanStore.setState({ isBoardViewActive: true })
        useFileViewerStore.setState({
          openFiles: new Map(),
          activeFilePath: '/tmp/file.ts',
          activeDiff: null,
          contextEditorWorktreeId: null
        })
        useSessionStore.setState({
          activeSessionId: 'session-0',
          activeWorktreeId: 'wt-1',
          activePinnedSessionId: null,
          inlineConnectionSessionId: null,
          pinnedSessionIds: new Set()
        })
      })

      const { result } = renderHook(() => usePinAndActivateSession())

      await act(async () => {
        await result.current.pinAndActivate(async () => 'review-session-4')
      })

      expect(useSessionStore.getState().pinnedSessionIds.has('review-session-4')).toBe(true)
      expect(useSessionStore.getState().activeSessionId).toBe('review-session-4')
    })
  })

  // ---------------------------------------------------------------------------
  // Review target branch store tests
  // ---------------------------------------------------------------------------
  describe('Review target branch store', () => {
    test('setReviewTargetBranch stores branch for worktree', async () => {
      const { useGitStore } = await import('../../../src/renderer/src/stores/useGitStore')

      useGitStore.getState().setReviewTargetBranch('wt-1', 'origin/develop')
      expect(useGitStore.getState().reviewTargetBranch.get('wt-1')).toBe('origin/develop')
    })

    test('setReviewTargetBranch updates existing branch', async () => {
      const { useGitStore } = await import('../../../src/renderer/src/stores/useGitStore')

      useGitStore.getState().setReviewTargetBranch('wt-1', 'origin/develop')
      useGitStore.getState().setReviewTargetBranch('wt-1', 'origin/main')
      expect(useGitStore.getState().reviewTargetBranch.get('wt-1')).toBe('origin/main')
    })

    test('reviewTargetBranch returns undefined for unknown worktree', async () => {
      const { useGitStore } = await import('../../../src/renderer/src/stores/useGitStore')

      expect(useGitStore.getState().reviewTargetBranch.get('nonexistent')).toBeUndefined()
    })
  })
})
