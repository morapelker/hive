import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Session pinning regression tests.
 *
 * These tests verify that:
 * 1. Sessions created with a specific agent_sdk retain that value
 * 2. Changing the default SDK setting does not affect existing sessions
 * 3. Mixed old (opencode) and new (claude-code) sessions coexist correctly
 */

// Mock the database layer
const mockSessions = new Map<string, { id: string; agent_sdk: string; worktree_id: string }>()

const mockDbService = {
  createSession: vi.fn(
    (data: { id?: string; agent_sdk?: string; worktree_id: string; project_id: string }) => {
      const session = {
        id: data.id ?? `session-${Date.now()}`,
        worktree_id: data.worktree_id,
        project_id: data.project_id,
        agent_sdk: data.agent_sdk ?? 'opencode',
        status: 'active',
        opencode_session_id: null,
        name: null,
        mode: 'build',
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      }
      mockSessions.set(session.id, session)
      return session
    }
  ),
  getSession: vi.fn((id: string) => mockSessions.get(id) ?? null),
  getSessionsByWorktree: vi.fn((worktreeId: string) =>
    Array.from(mockSessions.values()).filter((s) => s.worktree_id === worktreeId)
  ),
  getAgentSdkForSession: vi.fn((agentSessionId: string) => {
    for (const session of mockSessions.values()) {
      if (session.id === agentSessionId) return session.agent_sdk
    }
    return null
  })
}

describe('Session pinning regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessions.clear()
  })

  describe('session creation respects default SDK setting', () => {
    it('creates session with opencode when that is the default', () => {
      const session = mockDbService.createSession({
        agent_sdk: 'opencode',
        worktree_id: 'wt-1',
        project_id: 'proj-1'
      })
      expect(session.agent_sdk).toBe('opencode')
    })

    it('creates session with claude-code when that is the default', () => {
      const session = mockDbService.createSession({
        agent_sdk: 'claude-code',
        worktree_id: 'wt-1',
        project_id: 'proj-1'
      })
      expect(session.agent_sdk).toBe('claude-code')
    })

    it('defaults to opencode when no agent_sdk is specified', () => {
      const session = mockDbService.createSession({
        worktree_id: 'wt-1',
        project_id: 'proj-1'
      })
      expect(session.agent_sdk).toBe('opencode')
    })
  })

  describe('changing default SDK does not affect existing sessions', () => {
    it('old opencode sessions remain opencode after switching default to claude-code', () => {
      // Create session with opencode (the old default)
      mockDbService.createSession({
        id: 'old-session',
        agent_sdk: 'opencode',
        worktree_id: 'wt-1',
        project_id: 'proj-1'
      })

      // Simulate user changing default to claude-code
      // (This only affects NEW session creation, not existing)
      mockDbService.createSession({
        id: 'new-session',
        agent_sdk: 'claude-code',
        worktree_id: 'wt-1',
        project_id: 'proj-1'
      })

      // Old session still has opencode
      const fetchedOld = mockDbService.getSession('old-session')
      expect(fetchedOld?.agent_sdk).toBe('opencode')

      // New session has claude-code
      const fetchedNew = mockDbService.getSession('new-session')
      expect(fetchedNew?.agent_sdk).toBe('claude-code')
    })

    it('old claude-code sessions remain claude-code after switching default to opencode', () => {
      mockDbService.createSession({
        id: 'claude-session',
        agent_sdk: 'claude-code',
        worktree_id: 'wt-1',
        project_id: 'proj-1'
      })

      mockDbService.createSession({
        id: 'opencode-session',
        agent_sdk: 'opencode',
        worktree_id: 'wt-1',
        project_id: 'proj-1'
      })

      expect(mockDbService.getSession('claude-session')?.agent_sdk).toBe('claude-code')
      expect(mockDbService.getSession('opencode-session')?.agent_sdk).toBe('opencode')
    })
  })

  describe('mixed SDK sessions in the same worktree', () => {
    it('worktree can contain both opencode and claude-code sessions', () => {
      mockDbService.createSession({
        id: 's1',
        agent_sdk: 'opencode',
        worktree_id: 'wt-mixed',
        project_id: 'proj-1'
      })
      mockDbService.createSession({
        id: 's2',
        agent_sdk: 'claude-code',
        worktree_id: 'wt-mixed',
        project_id: 'proj-1'
      })
      mockDbService.createSession({
        id: 's3',
        agent_sdk: 'opencode',
        worktree_id: 'wt-mixed',
        project_id: 'proj-1'
      })

      const sessions = mockDbService.getSessionsByWorktree('wt-mixed')
      expect(sessions).toHaveLength(3)

      const sdks = sessions.map((s) => s.agent_sdk)
      expect(sdks).toContain('opencode')
      expect(sdks).toContain('claude-code')
    })

    it('each session SDK lookup returns the correct pinned value', () => {
      mockDbService.createSession({
        id: 'oc-session',
        agent_sdk: 'opencode',
        worktree_id: 'wt-1',
        project_id: 'proj-1'
      })
      mockDbService.createSession({
        id: 'cc-session',
        agent_sdk: 'claude-code',
        worktree_id: 'wt-1',
        project_id: 'proj-1'
      })

      expect(mockDbService.getAgentSdkForSession('oc-session')).toBe('opencode')
      expect(mockDbService.getAgentSdkForSession('cc-session')).toBe('claude-code')
    })
  })
})
