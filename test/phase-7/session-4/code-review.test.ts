import { describe, test, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import {
  resetRendererRpcClientForTests,
  setRendererRpcClient
} from '../../../src/renderer/src/api/rpc-client'
import { opencodeApi } from '../../../src/renderer/src/api/opencode-api'

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: {
    connect: vi.fn(),
    prompt: vi.fn()
  }
}))

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------
const mockGitOps = {
  listBranchesWithStatus: vi.fn().mockResolvedValue({ success: false, branches: [] }),
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

function installTestRpcClient() {
  setRendererRpcClient({
    request: vi.fn(async (method: string, params: unknown) => {
      if (method === 'db.setting.get') {
        return mockDb.setting.get((params as { key: string }).key)
      }
      if (method === 'db.setting.set') {
        const { key, value } = params as { key: string; value: string }
        return mockDb.setting.set(key, value)
      }
      if (method === 'db.session.setPinnedToBoard') {
        const { sessionId, pinned } = params as { sessionId: string; pinned: boolean }
        return mockDb.session.setPinnedToBoard(sessionId, pinned)
      }
      if (method === 'db.session.update') {
        const { id, data } = params as { id: string; data: unknown }
        return mockDb.session.update(id, data)
      }
      if (method === 'gitOps.listBranchesWithStatus') {
        return mockGitOps.listBranchesWithStatus((params as { projectPath: string }).projectPath)
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    }),
    subscribe: vi.fn()
  })
}

describe('Session 4: Code Review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    cleanup()

    vi.mocked(opencodeApi.connect).mockResolvedValue({
      success: true,
      value: { success: true, sessionId: 'opc-review-session' }
    })
    vi.mocked(opencodeApi.prompt).mockResolvedValue({
      success: true,
      value: { success: true }
    })
    installTestRpcClient()
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
      const { DEFAULT_REVIEW_PROMPT_TYPE } =
        await import('../../../src/renderer/src/constants/reviewPrompts')

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

      mockDb.setting.get.mockResolvedValueOnce(
        JSON.stringify({
          reviewPromptType: 'superpowers'
        })
      )

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
      const { REVIEW_PROMPT_LABELS } =
        await import('../../../src/renderer/src/constants/reviewPrompts')

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

    test('uses the review default model when creating a review session', async () => {
      const { useGitStore } = await import('../../../src/renderer/src/stores/useGitStore')
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')
      const { useSettingsStore } = await import('../../../src/renderer/src/stores/useSettingsStore')
      const { useWorktreeStore } = await import('../../../src/renderer/src/stores/useWorktreeStore')
      const { useLifecycleActions } =
        await import('../../../src/renderer/src/hooks/useLifecycleActions')

      const reviewModel = {
        agentSdk: 'codex' as const,
        providerID: 'codex',
        modelID: 'gpt-5.5',
        variant: 'high'
      }
      const createSession = vi.fn().mockResolvedValue({
        success: true,
        session: {
          id: 'review-session-model',
          worktree_id: 'wt-1',
          project_id: 'proj-1',
          connection_id: null,
          name: 'Session 14:00',
          status: 'active',
          opencode_session_id: null,
          agent_sdk: 'codex',
          mode: 'build',
          model_provider_id: 'codex',
          model_id: 'gpt-5.5',
          model_variant: 'high',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null
        }
      })
      const updateSessionName = vi.fn().mockResolvedValue(undefined)

      act(() => {
        useWorktreeStore.setState({
          worktreesByProject: new Map([
            [
              'proj-1',
              [
                {
                  id: 'wt-1',
                  project_id: 'proj-1',
                  name: 'feature-auth',
                  branch_name: 'feature-auth',
                  path: '/tmp/review-model-worktree',
                  status: 'active',
                  is_default: false,
                  branch_renamed: 0,
                  last_message_at: null,
                  session_titles: '[]',
                  last_model_provider_id: null,
                  last_model_id: null,
                  last_model_variant: null,
                  attachments: '[]',
                  pinned: 0,
                  context: null,
                  github_pr_number: null,
                  github_pr_url: null,
                  base_branch: null,
                  created_at: new Date().toISOString(),
                  last_accessed_at: new Date().toISOString()
                }
              ]
            ]
          ])
        })
        useGitStore.setState({
          branchInfoByWorktree: new Map([
            [
              '/tmp/review-model-worktree',
              { name: 'feature-auth', tracking: 'origin/main', ahead: 0, behind: 0 }
            ]
          ]),
          remoteInfo: new Map([
            ['wt-1', { hasRemote: true, isGitHub: true, remoteUrl: 'git@github.com:test/repo.git' }]
          ])
        })
        useSettingsStore.setState({
          defaultModels: {
            build: null,
            plan: null,
            ask: null,
            review: reviewModel
          }
        })
        useSessionStore.setState({
          createSession,
          updateSessionName
        })
      })

      const { result } = renderHook(() => useLifecycleActions('wt-1'))

      await result.current.createCodeReview('origin/main')

      expect(createSession).toHaveBeenCalledWith('wt-1', 'proj-1', 'codex', undefined, {
        autoFocus: false,
        modelOverride: reviewModel
      })
      expect(opencodeApi.connect).toHaveBeenCalledWith(
        '/tmp/review-model-worktree',
        'review-session-model'
      )
      await waitFor(() => {
        expect(opencodeApi.prompt).toHaveBeenCalledWith(
          '/tmp/review-model-worktree',
          'opc-review-session',
          expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('Compare the current branch (feature-auth)')
            })
          ]),
          {
            providerID: 'codex',
            modelID: 'gpt-5.5',
            variant: 'high'
          }
        )
      })
    })

    test('focuses the new review tab when not currently on the board', async () => {
      const [
        { usePinAndActivateSession },
        { useSessionStore },
        { useKanbanStore },
        { useSettingsStore },
        { useFileViewerStore }
      ] = await Promise.all([
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
      const [
        { usePinAndActivateSession },
        { useSessionStore },
        { useKanbanStore },
        { useSettingsStore },
        { useFileViewerStore }
      ] = await Promise.all([
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
      const [
        { usePinAndActivateSession },
        { useSessionStore, BOARD_TAB_ID },
        { useKanbanStore },
        { useSettingsStore },
        { useFileViewerStore }
      ] = await Promise.all([
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
      const [
        { usePinAndActivateSession },
        { useSessionStore },
        { useKanbanStore },
        { useSettingsStore },
        { useFileViewerStore }
      ] = await Promise.all([
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
