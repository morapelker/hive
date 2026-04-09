/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CodexSessionState } from '../src/main/services/codex-implementer'

const mockGenerateCodexSessionTitle = vi.fn()
vi.mock('../src/main/services/codex-session-title', () => ({
  generateCodexSessionTitle: (...args: any[]) => mockGenerateCodexSessionTitle(...args)
}))

const mockAutoRenameWorktreeBranch = vi.fn()
vi.mock('../src/main/services/git-service', () => ({
  autoRenameWorktreeBranch: (...args: any[]) => mockAutoRenameWorktreeBranch(...args)
}))

vi.mock('../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { CodexImplementer } from '../src/main/services/codex-implementer'

function createMockWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn()
    }
  } as any
}

function createMockDbService(overrides: Record<string, any> = {}) {
  return {
    updateSession: vi.fn(),
    updateWorktree: vi.fn(),
    getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', name: 'Fix auth refresh' }),
    getWorktreeBySessionId: vi.fn().mockReturnValue(null),
    getConnection: vi.fn(),
    getWorktree: vi.fn(),
    ...overrides
  } as any
}

function createMockSession(overrides: Partial<CodexSessionState> = {}): CodexSessionState {
  return {
    threadId: 'thread-1',
    hiveSessionId: 'hive-session-1',
    worktreePath: '/path/to/worktree',
    status: 'ready',
    messages: [],
    revertMessageID: null,
    revertDiff: null,
    titleGenerated: false,
    titleGenerationStarted: false,
    ...overrides
  }
}

function injectSession(impl: CodexImplementer, session: CodexSessionState): void {
  impl.getSessions().set(`${session.worktreePath}::${session.threadId}`, session)
}

describe('Codex title integration', () => {
  let impl: CodexImplementer
  let mockWindow: ReturnType<typeof createMockWindow>
  let mockDb: ReturnType<typeof createMockDbService>
  let session: CodexSessionState

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new CodexImplementer()
    mockWindow = createMockWindow()
    impl.setMainWindow(mockWindow)
    mockDb = createMockDbService()
    impl.setDatabaseService(mockDb)
    session = createMockSession()
    injectSession(impl, session)
  })

  it('applies generated title and auto-renames the direct worktree branch', async () => {
    mockGenerateCodexSessionTitle.mockResolvedValue('Fix auth refresh')
    mockDb.getSession.mockReturnValue({ id: 'hive-session-1', name: 'Fix auth token refresh bug' })
    mockDb.getWorktreeBySessionId.mockReturnValue({
      id: 'wt-1',
      branch_name: 'labrador',
      branch_renamed: 0,
      path: '/path/to/worktree'
    })
    mockAutoRenameWorktreeBranch.mockResolvedValue({
      renamed: true,
      newBranch: 'fix-auth-refresh'
    })

    await (impl as any).handleTitleGeneration(session, 'Fix auth token refresh bug')

    expect(mockDb.updateSession).toHaveBeenCalledWith('hive-session-1', {
      name: 'Fix auth refresh'
    })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('opencode:stream', {
      type: 'session.updated',
      sessionId: 'hive-session-1',
      data: {
        title: 'Fix auth refresh',
        info: { title: 'Fix auth refresh' }
      }
    })
    expect(mockAutoRenameWorktreeBranch).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      worktreePath: '/path/to/worktree',
      currentBranchName: 'labrador',
      sessionTitle: 'Fix auth refresh',
      db: mockDb
    })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('worktree:branchRenamed', {
      worktreeId: 'wt-1',
      newBranch: 'fix-auth-refresh'
    })
  })

  it('still auto-renames the branch when the generated title matches the placeholder', async () => {
    mockGenerateCodexSessionTitle.mockResolvedValue('Fix auth refresh')
    mockDb.getSession.mockReturnValue({ id: 'hive-session-1', name: 'Fix auth refresh' })
    mockDb.getWorktreeBySessionId.mockReturnValue({
      id: 'wt-1',
      branch_name: 'labrador',
      branch_renamed: 0,
      path: '/path/to/worktree'
    })
    mockAutoRenameWorktreeBranch.mockResolvedValue({
      renamed: true,
      newBranch: 'fix-auth-refresh'
    })

    await (impl as any).handleTitleGeneration(session, 'Fix auth refresh')

    expect(mockDb.updateSession).not.toHaveBeenCalled()
    expect(mockAutoRenameWorktreeBranch).toHaveBeenCalledTimes(1)
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
      'opencode:stream',
      expect.objectContaining({ type: 'session.updated' })
    )
  })

  it('dedupes a provider title update when the same title was already applied', async () => {
    mockDb.getSession.mockReturnValue({ id: 'hive-session-1', name: 'Fix auth refresh' })
    mockDb.getWorktreeBySessionId.mockReturnValue(null)

    await (impl as any).handleProviderTitleUpdate({
      kind: 'notification',
      provider: 'codex',
      threadId: 'thread-1',
      method: 'thread/name/updated',
      payload: { threadName: 'Fix auth refresh' }
    })

    expect(mockDb.updateSession).not.toHaveBeenCalled()
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
      'opencode:stream',
      expect.objectContaining({ type: 'session.updated' })
    )
  })

  it('applies a provider title update when local generation did not run', async () => {
    mockDb.getSession.mockReturnValue({ id: 'hive-session-1', name: 'Session 1' })
    mockDb.getWorktreeBySessionId.mockReturnValue(null)

    await (impl as any).handleProviderTitleUpdate({
      kind: 'notification',
      provider: 'codex',
      threadId: 'thread-1',
      method: 'thread/name/updated',
      payload: { threadName: 'Dark mode settings' }
    })

    expect(mockDb.updateSession).toHaveBeenCalledWith('hive-session-1', {
      name: 'Dark mode settings'
    })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('opencode:stream', {
      type: 'session.updated',
      sessionId: 'hive-session-1',
      data: {
        title: 'Dark mode settings',
        info: { title: 'Dark mode settings' }
      }
    })
  })
})
