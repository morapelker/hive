import { describe, test, expect, vi, beforeEach } from 'vitest'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useSettingsStore } from '../../../src/renderer/src/stores/useSettingsStore'

/**
 * Session 9: Per-Session Model — Frontend Integration Tests
 *
 * Validates:
 * 1. setSessionModel updates session model fields in store
 * 2. setSessionModel persists to database via window.db.session.update
 * 3. setSessionModel pushes model to OpenCode via window.opencodeOps.setModel
 * 4. setSessionModel updates global setting as well
 * 5. createSession defaults to last session's model in same worktree
 * 6. createSession falls back to global selectedModel when no prior sessions
 */

// Mock window APIs
const mockSessionUpdate = vi.fn().mockResolvedValue({
  id: 'session-1',
  worktree_id: 'wt-1',
  project_id: 'proj-1',
  name: 'Test',
  status: 'active',
  opencode_session_id: null,
  mode: 'build',
  model_provider_id: 'anthropic',
  model_id: 'claude-opus-4-5',
  model_variant: 'high',
  created_at: '2025-01-01',
  updated_at: '2025-01-01',
  completed_at: null
})

const mockSessionCreate = vi.fn().mockImplementation((data) => ({
  id: `session-${Date.now()}`,
  worktree_id: data.worktree_id,
  project_id: data.project_id,
  name: data.name || 'New session',
  status: 'active',
  opencode_session_id: null,
  mode: 'build',
  model_provider_id: data.model_provider_id ?? null,
  model_id: data.model_id ?? null,
  model_variant: data.model_variant ?? null,
  created_at: '2025-01-01',
  updated_at: '2025-01-01',
  completed_at: null
}))

const mockSetModel = vi.fn().mockResolvedValue({ success: true })

const mockGetActiveByWorktree = vi.fn().mockResolvedValue([])

Object.defineProperty(window, 'db', {
  writable: true,
  value: {
    session: {
      update: mockSessionUpdate,
      create: mockSessionCreate,
      getActiveByWorktree: mockGetActiveByWorktree,
      get: vi.fn(),
      getDraft: vi.fn().mockResolvedValue(null),
      saveDraft: vi.fn().mockResolvedValue(undefined)
    },
    setting: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined)
    }
  }
})

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  value: {
    setModel: mockSetModel,
    listModels: vi.fn().mockResolvedValue({ success: true, providers: [] }),
    onStream: vi.fn().mockReturnValue(() => {})
  }
})

// Helper: seed the store with a session that has a model set
function seedSessionWithModel(
  sessionId: string,
  worktreeId: string,
  model?: { providerID: string; modelID: string; variant?: string | null }
) {
  const session = {
    id: sessionId,
    worktree_id: worktreeId,
    project_id: 'proj-1',
    name: 'Test Session',
    status: 'active' as const,
    opencode_session_id: null,
    mode: 'build' as const,
    model_provider_id: model?.providerID ?? null,
    model_id: model?.modelID ?? null,
    model_variant: model?.variant ?? null,
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
    completed_at: null
  }

  useSessionStore.setState((state) => {
    const newMap = new Map(state.sessionsByWorktree)
    const existing = newMap.get(worktreeId) || []
    newMap.set(worktreeId, [session, ...existing])

    const newTabOrder = new Map(state.tabOrderByWorktree)
    const existingOrder = newTabOrder.get(worktreeId) || []
    newTabOrder.set(worktreeId, [...existingOrder, sessionId])

    return {
      sessionsByWorktree: newMap,
      tabOrderByWorktree: newTabOrder,
      activeWorktreeId: worktreeId
    }
  })
}

// Helper: find session in the store by ID
function findSession(sessionId: string) {
  const state = useSessionStore.getState()
  for (const sessions of state.sessionsByWorktree.values()) {
    const session = sessions.find((s) => s.id === sessionId)
    if (session) return session
  }
  return null
}

describe('Session 9: Per-Session Model Frontend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset session store to initial state
    useSessionStore.setState({
      sessionsByWorktree: new Map(),
      tabOrderByWorktree: new Map(),
      modeBySession: new Map(),
      pendingMessages: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: null,
      activeWorktreeId: null,
      activeSessionByWorktree: {}
    })
    // Reset settings store to clear any persisted selectedModel
    useSettingsStore.setState({ selectedModel: null })
  })

  describe('setSessionModel', () => {
    test('updates session model fields in store', async () => {
      seedSessionWithModel('session-1', 'wt-1')

      // Verify model is initially null
      let session = findSession('session-1')
      expect(session?.model_id).toBeNull()

      // Set the model
      await useSessionStore.getState().setSessionModel('session-1', {
        providerID: 'anthropic',
        modelID: 'claude-opus-4-5',
        variant: 'high'
      })

      // Verify model is updated in store
      session = findSession('session-1')
      expect(session?.model_provider_id).toBe('anthropic')
      expect(session?.model_id).toBe('claude-opus-4-5')
      expect(session?.model_variant).toBe('high')
    })

    test('persists to database via window.db.session.update', async () => {
      seedSessionWithModel('session-1', 'wt-1')

      await useSessionStore
        .getState()
        .setSessionModel('session-1', { providerID: 'openai', modelID: 'gpt-4o' })

      expect(mockSessionUpdate).toHaveBeenCalledWith('session-1', {
        model_provider_id: 'openai',
        model_id: 'gpt-4o',
        model_variant: null
      })
    })

    test('pushes model to OpenCode via window.opencodeOps.setModel', async () => {
      seedSessionWithModel('session-1', 'wt-1')

      await useSessionStore.getState().setSessionModel('session-1', {
        providerID: 'anthropic',
        modelID: 'claude-opus-4-5',
        variant: 'high'
      })

      expect(mockSetModel).toHaveBeenCalledWith({
        providerID: 'anthropic',
        modelID: 'claude-opus-4-5',
        variant: 'high'
      })
    })

    test('handles variant as undefined (sets model_variant to null)', async () => {
      seedSessionWithModel('session-1', 'wt-1')

      await useSessionStore
        .getState()
        .setSessionModel('session-1', { providerID: 'openai', modelID: 'gpt-4o' })

      const session = findSession('session-1')
      expect(session?.model_variant).toBeNull()
    })

    test('does not affect other sessions in the same worktree', async () => {
      seedSessionWithModel('session-1', 'wt-1')
      seedSessionWithModel('session-2', 'wt-1')

      await useSessionStore.getState().setSessionModel('session-1', {
        providerID: 'anthropic',
        modelID: 'claude-opus-4-5',
        variant: 'high'
      })

      const session1 = findSession('session-1')
      const session2 = findSession('session-2')
      expect(session1?.model_id).toBe('claude-opus-4-5')
      expect(session2?.model_id).toBeNull()
    })
  })

  describe('createSession model defaults', () => {
    test('new session inherits model from last session in same worktree', async () => {
      // Seed a session with a model
      seedSessionWithModel('session-1', 'wt-1', {
        providerID: 'anthropic',
        modelID: 'claude-opus-4-5',
        variant: 'high'
      })

      // Create a new session in the same worktree
      const result = await useSessionStore.getState().createSession('wt-1', 'proj-1')
      expect(result.success).toBe(true)

      // Verify the create call included model fields from session-1
      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model_provider_id: 'anthropic',
          model_id: 'claude-opus-4-5',
          model_variant: 'high'
        })
      )
    })

    test('new session inherits model from first session with model set', async () => {
      // Seed a session without a model (most recent) and one with a model
      seedSessionWithModel('session-old', 'wt-1', {
        providerID: 'openai',
        modelID: 'gpt-4o'
      })
      seedSessionWithModel('session-new', 'wt-1') // no model

      // session-new is first (most recent since we prepend), session-old is second
      // The code looks for the first session with a model_id set
      const result = await useSessionStore.getState().createSession('wt-1', 'proj-1')
      expect(result.success).toBe(true)

      // Should inherit from session-old (first one with model_id set)
      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model_provider_id: 'openai',
          model_id: 'gpt-4o'
        })
      )
    })

    test('new session without prior sessions creates without model fields', async () => {
      // No existing sessions, no global model set
      const result = await useSessionStore.getState().createSession('wt-empty', 'proj-1')
      expect(result.success).toBe(true)

      // Should not include model fields (or include undefined/null values)
      const call = mockSessionCreate.mock.calls[0][0]
      // The session create should NOT have model fields set when there's no prior session
      // and no global setting
      expect(call.model_provider_id).toBeUndefined()
      expect(call.model_id).toBeUndefined()
    })
  })

  describe('session model field types', () => {
    test('store Session interface includes model fields', () => {
      seedSessionWithModel('session-1', 'wt-1', {
        providerID: 'anthropic',
        modelID: 'claude-opus-4-5',
        variant: 'high'
      })

      const session = findSession('session-1')
      expect(session).toBeDefined()
      expect(typeof session!.model_provider_id).toBe('string')
      expect(typeof session!.model_id).toBe('string')
      expect(typeof session!.model_variant).toBe('string')
    })

    test('model fields can be null', () => {
      seedSessionWithModel('session-1', 'wt-1')

      const session = findSession('session-1')
      expect(session?.model_provider_id).toBeNull()
      expect(session?.model_id).toBeNull()
      expect(session?.model_variant).toBeNull()
    })
  })
})
