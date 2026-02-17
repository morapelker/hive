/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ClaudeSessionState } from '../src/main/services/claude-code-implementer'

// ── Mocks ──────────────────────────────────────────────────────────────

const mockGenerateSessionTitle = vi.fn()
vi.mock('../src/main/services/claude-session-title', () => ({
  generateSessionTitle: (...args: any[]) => mockGenerateSessionTitle(...args)
}))

vi.mock('../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))

vi.mock('../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../src/main/services/claude-transcript-reader', () => ({
  readClaudeTranscript: vi.fn().mockResolvedValue([]),
  translateEntry: vi.fn()
}))

const mockBranchExists = vi.fn()
const mockRenameBranch = vi.fn()
vi.mock('../src/main/services/git-service', () => ({
  canonicalizeBranchName: (title: string) =>
    title
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join(' ')
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9\-/.]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, ''),
  createGitService: () => ({
    branchExists: mockBranchExists,
    renameBranch: mockRenameBranch
  })
}))

vi.mock('../src/main/services/breed-names', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/breed-names')>()
  return actual
})

// ── Helpers ────────────────────────────────────────────────────────────

import { ClaudeCodeImplementer } from '../src/main/services/claude-code-implementer'

function createMockWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn()
    }
  } as any
}

function createMockDbService(worktreeOverrides: Record<string, any> = {}) {
  return {
    updateSession: vi.fn(),
    updateWorktree: vi.fn(),
    getWorktreeBySessionId: vi.fn().mockReturnValue(null),
    getSession: vi.fn(),
    ...worktreeOverrides
  } as any
}

function createMockSession(overrides: Partial<ClaudeSessionState> = {}): ClaudeSessionState {
  return {
    claudeSessionId: 'sdk-session-123',
    hiveSessionId: 'hive-session-456',
    worktreePath: '/path/to/worktree',
    abortController: null,
    checkpointCounter: 0,
    checkpoints: new Map(),
    query: null,
    lastQuery: null,
    materialized: true,
    messages: [],
    toolNames: new Map(),
    pendingQuestion: null,
    pendingPlanApproval: null,
    revertMessageID: null,
    revertCheckpointUuid: null,
    revertDiff: null,
    pendingFork: false,
    pendingResumeSessionAt: null,
    ...overrides
  }
}

function injectSession(impl: ClaudeCodeImplementer, session: ClaudeSessionState): void {
  const sessions = (impl as any).sessions as Map<string, ClaudeSessionState>
  sessions.set(`${session.worktreePath}::${session.claudeSessionId}`, session)
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('handleTitleGeneration', () => {
  let impl: ClaudeCodeImplementer
  let mockWindow: ReturnType<typeof createMockWindow>
  let mockDb: ReturnType<typeof createMockDbService>
  let session: ClaudeSessionState

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new ClaudeCodeImplementer()
    mockWindow = createMockWindow()
    impl.setMainWindow(mockWindow)
    mockDb = createMockDbService()
    impl.setDatabaseService(mockDb)
    impl.setClaudeBinaryPath('/usr/local/bin/claude')
    session = createMockSession()
    injectSession(impl, session)
  })

  // ── Title updates DB ─────────────────────────────────────────────

  it('updates DB session name on successful title generation', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Fix auth refresh')

    await (impl as any).handleTitleGeneration(session, 'Fix the auth token refresh bug')

    expect(mockDb.updateSession).toHaveBeenCalledWith('hive-session-456', {
      name: 'Fix auth refresh'
    })
  })

  // ── Renderer notification ────────────────────────────────────────

  it('sends session.updated event to renderer with correct shape', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Add dark mode')

    await (impl as any).handleTitleGeneration(session, 'Add a dark mode toggle')

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('opencode:stream', {
      type: 'session.updated',
      sessionId: 'hive-session-456',
      data: {
        title: 'Add dark mode',
        info: { title: 'Add dark mode' }
      }
    })
  })

  // ── Branch rename when conditions met ────────────────────────────

  it('auto-renames branch when worktree has auto-generated breed name', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Fix auth refresh')
    mockDb.getWorktreeBySessionId.mockReturnValue({
      id: 'wt-1',
      branch_name: 'labrador',
      branch_renamed: 0,
      path: '/path/to/worktree'
    })
    mockBranchExists.mockResolvedValue(false)
    mockRenameBranch.mockResolvedValue({ success: true })

    await (impl as any).handleTitleGeneration(session, 'Fix the auth refresh bug')

    expect(mockRenameBranch).toHaveBeenCalledWith(
      '/path/to/worktree',
      'labrador',
      'fix-auth-refresh'
    )
    expect(mockDb.updateWorktree).toHaveBeenCalledWith('wt-1', {
      name: 'fix-auth-refresh',
      branch_name: 'fix-auth-refresh',
      branch_renamed: 1
    })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('worktree:branchRenamed', {
      worktreeId: 'wt-1',
      newBranch: 'fix-auth-refresh'
    })
  })

  it('auto-renames branch for legacy city names', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Add new feature')
    mockDb.getWorktreeBySessionId.mockReturnValue({
      id: 'wt-2',
      branch_name: 'tokyo',
      branch_renamed: 0,
      path: '/path/to/worktree'
    })
    mockBranchExists.mockResolvedValue(false)
    mockRenameBranch.mockResolvedValue({ success: true })

    await (impl as any).handleTitleGeneration(session, 'Add a new feature')

    expect(mockRenameBranch).toHaveBeenCalledWith('/path/to/worktree', 'tokyo', 'add-new-feature')
  })

  // ── Branch rename skipped ────────────────────────────────────────

  it('skips branch rename when branch_renamed is already 1', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Fix something')
    mockDb.getWorktreeBySessionId.mockReturnValue({
      id: 'wt-1',
      branch_name: 'labrador',
      branch_renamed: 1,
      path: '/path/to/worktree'
    })

    await (impl as any).handleTitleGeneration(session, 'Fix something')

    expect(mockRenameBranch).not.toHaveBeenCalled()
  })

  it('skips branch rename when branch name is not auto-generated', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Fix something')
    mockDb.getWorktreeBySessionId.mockReturnValue({
      id: 'wt-1',
      branch_name: 'my-feature-branch',
      branch_renamed: 0,
      path: '/path/to/worktree'
    })

    await (impl as any).handleTitleGeneration(session, 'Fix something')

    expect(mockRenameBranch).not.toHaveBeenCalled()
  })

  // ── Branch name suffix ───────────────────────────────────────────

  it('appends suffix when branch name already exists', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Fix auth refresh')
    mockDb.getWorktreeBySessionId.mockReturnValue({
      id: 'wt-1',
      branch_name: 'golden-retriever',
      branch_renamed: 0,
      path: '/path/to/worktree'
    })
    // Base name exists, but -2 is available
    mockBranchExists
      .mockResolvedValueOnce(true) // 'fix-auth-refresh' exists
      .mockResolvedValueOnce(false) // 'fix-auth-refresh-2' available
    mockRenameBranch.mockResolvedValue({ success: true })

    await (impl as any).handleTitleGeneration(session, 'Fix the auth refresh bug')

    expect(mockRenameBranch).toHaveBeenCalledWith(
      '/path/to/worktree',
      'golden-retriever',
      'fix-auth-refresh-2'
    )
  })

  // ── Graceful degradation ─────────────────────────────────────────

  it('does nothing when generateSessionTitle returns null', async () => {
    mockGenerateSessionTitle.mockResolvedValue(null)

    await (impl as any).handleTitleGeneration(session, 'some message')

    expect(mockDb.updateSession).not.toHaveBeenCalled()
    expect(mockWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('handles missing dbService gracefully', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Some title')
    ;(impl as any).dbService = null

    // Should not throw
    await expect(
      (impl as any).handleTitleGeneration(session, 'message')
    ).resolves.toBeUndefined()
  })

  it('handles missing mainWindow gracefully', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Some title')
    ;(impl as any).mainWindow = null

    // Should not throw — DB still gets updated
    await expect(
      (impl as any).handleTitleGeneration(session, 'message')
    ).resolves.toBeUndefined()
    expect(mockDb.updateSession).toHaveBeenCalledWith('hive-session-456', { name: 'Some title' })
  })

  it('handles generateSessionTitle rejection gracefully', async () => {
    mockGenerateSessionTitle.mockRejectedValue(new Error('Unexpected error'))

    // Should not throw
    await expect(
      (impl as any).handleTitleGeneration(session, 'message')
    ).resolves.toBeUndefined()
  })

  // ── Branch rename failure handling ───────────────────────────────

  it('sets branch_renamed=1 when renameBranch fails', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Fix something')
    mockDb.getWorktreeBySessionId.mockReturnValue({
      id: 'wt-1',
      branch_name: 'labrador',
      branch_renamed: 0,
      path: '/path/to/worktree'
    })
    mockBranchExists.mockResolvedValue(false)
    mockRenameBranch.mockResolvedValue({ success: false, error: 'Permission denied' })

    await (impl as any).handleTitleGeneration(session, 'Fix something')

    expect(mockDb.updateWorktree).toHaveBeenCalledWith('wt-1', { branch_renamed: 1 })
  })

  it('sets branch_renamed=1 when git service throws', async () => {
    mockGenerateSessionTitle.mockResolvedValue('Fix something')
    mockDb.getWorktreeBySessionId.mockReturnValue({
      id: 'wt-1',
      branch_name: 'labrador',
      branch_renamed: 0,
      path: '/path/to/worktree'
    })
    mockBranchExists.mockRejectedValue(new Error('Git error'))

    await (impl as any).handleTitleGeneration(session, 'Fix something')

    expect(mockDb.updateWorktree).toHaveBeenCalledWith('wt-1', { branch_renamed: 1 })
  })
})
