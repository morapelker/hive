import { vi, beforeEach, afterEach } from 'vitest'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'

// Mock window.db.worktree.updateModel + window.db.session.create + window.db.session.update
const mockUpdateModel = vi.fn().mockResolvedValue({ success: true })
const mockSessionCreate = vi.fn()
const mockSessionUpdate = vi.fn()
const mockSetModel = vi.fn().mockResolvedValue({ success: true })

beforeEach(() => {
  // Reset stores
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    worktreeOrderByProject: new Map(),
    isLoading: false,
    error: null,
    selectedWorktreeId: null,
    creatingForProjectId: null,
    archivingWorktreeIds: new Set()
  })

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

  // Mock window APIs
  mockUpdateModel.mockClear()
  mockSessionCreate.mockClear()
  mockSessionUpdate.mockClear()
  mockSetModel.mockClear()

  Object.defineProperty(window, 'db', {
    value: {
      worktree: {
        updateModel: mockUpdateModel,
        touch: vi.fn().mockResolvedValue(true),
        getActiveByProject: vi.fn().mockResolvedValue([]),
        appendSessionTitle: vi.fn().mockResolvedValue({ success: true })
      },
      session: {
        create: mockSessionCreate,
        update: mockSessionUpdate,
        getActiveByWorktree: vi.fn().mockResolvedValue([])
      },
      setting: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(true)
      }
    },
    writable: true,
    configurable: true
  })

  Object.defineProperty(window, 'opencodeOps', {
    value: {
      setModel: mockSetModel
    },
    writable: true,
    configurable: true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Session 6: Per-Worktree Model Frontend', () => {
  describe('useWorktreeStore.updateWorktreeModel', () => {
    test('updates in-memory worktree record with model fields', () => {
      // Set up worktree in store
      const worktrees = [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          name: 'test',
          branch_name: 'main',
          path: '/tmp/test',
          status: 'active' as const,
          is_default: false,
          branch_renamed: 0,
          last_message_at: null,
          session_titles: '[]',
          last_model_provider_id: null,
          last_model_id: null,
          last_model_variant: null,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
      useWorktreeStore.setState({
        worktreesByProject: new Map([['proj-1', worktrees]])
      })

      // Call updateWorktreeModel
      useWorktreeStore.getState().updateWorktreeModel('wt-1', {
        providerID: 'anthropic',
        modelID: 'claude-opus',
        variant: 'latest'
      })

      // Verify the worktree record is updated
      const updated = useWorktreeStore.getState().worktreesByProject.get('proj-1')
      expect(updated).toBeDefined()
      expect(updated![0].last_model_provider_id).toBe('anthropic')
      expect(updated![0].last_model_id).toBe('claude-opus')
      expect(updated![0].last_model_variant).toBe('latest')
    })

    test('handles variant as undefined (sets null)', () => {
      const worktrees = [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          name: 'test',
          branch_name: 'main',
          path: '/tmp/test',
          status: 'active' as const,
          is_default: false,
          branch_renamed: 0,
          last_message_at: null,
          session_titles: '[]',
          last_model_provider_id: null,
          last_model_id: null,
          last_model_variant: null,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
      useWorktreeStore.setState({
        worktreesByProject: new Map([['proj-1', worktrees]])
      })

      useWorktreeStore.getState().updateWorktreeModel('wt-1', {
        providerID: 'openai',
        modelID: 'gpt-4o'
        // no variant
      })

      const updated = useWorktreeStore.getState().worktreesByProject.get('proj-1')
      expect(updated![0].last_model_provider_id).toBe('openai')
      expect(updated![0].last_model_id).toBe('gpt-4o')
      expect(updated![0].last_model_variant).toBeNull()
    })

    test('does not affect other worktrees', () => {
      const worktreeA = {
        id: 'wt-a',
        project_id: 'proj-1',
        name: 'a',
        branch_name: 'feature-a',
        path: '/tmp/a',
        status: 'active' as const,
        is_default: false,
        branch_renamed: 0,
        last_message_at: null,
        session_titles: '[]',
        last_model_provider_id: null,
        last_model_id: null,
        last_model_variant: null,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      }
      const worktreeB = {
        id: 'wt-b',
        project_id: 'proj-1',
        name: 'b',
        branch_name: 'feature-b',
        path: '/tmp/b',
        status: 'active' as const,
        is_default: false,
        branch_renamed: 0,
        last_message_at: null,
        session_titles: '[]',
        last_model_provider_id: null,
        last_model_id: null,
        last_model_variant: null,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      }
      useWorktreeStore.setState({
        worktreesByProject: new Map([['proj-1', [worktreeA, worktreeB]]])
      })

      useWorktreeStore.getState().updateWorktreeModel('wt-a', {
        providerID: 'anthropic',
        modelID: 'claude-opus'
      })

      const updated = useWorktreeStore.getState().worktreesByProject.get('proj-1')
      // worktreeA updated
      expect(updated![0].last_model_id).toBe('claude-opus')
      // worktreeB unchanged
      expect(updated![1].last_model_id).toBeNull()
    })
  })

  describe('useSessionStore.setSessionModel persists to worktree', () => {
    test('calls window.db.worktree.updateModel with correct params', async () => {
      // Set up a session in the store
      const sessions = [
        {
          id: 'sess-1',
          worktree_id: 'wt-1',
          project_id: 'proj-1',
          name: 'Test Session',
          status: 'active' as const,
          opencode_session_id: null,
          mode: 'build' as const,
          model_provider_id: null,
          model_id: null,
          model_variant: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null
        }
      ]
      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-1', sessions]]),
        tabOrderByWorktree: new Map([['wt-1', ['sess-1']]]),
        activeSessionId: 'sess-1',
        activeWorktreeId: 'wt-1'
      })

      // Set up worktree so updateWorktreeModel works
      const worktrees = [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          name: 'test',
          branch_name: 'main',
          path: '/tmp/test',
          status: 'active' as const,
          is_default: false,
          branch_renamed: 0,
          last_message_at: null,
          session_titles: '[]',
          last_model_provider_id: null,
          last_model_id: null,
          last_model_variant: null,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
      useWorktreeStore.setState({
        worktreesByProject: new Map([['proj-1', worktrees]])
      })

      mockSessionUpdate.mockResolvedValue(sessions[0])

      await useSessionStore.getState().setSessionModel('sess-1', {
        providerID: 'anthropic',
        modelID: 'claude-opus',
        variant: 'latest'
      })

      // Verify window.db.worktree.updateModel was called
      expect(mockUpdateModel).toHaveBeenCalledWith({
        worktreeId: 'wt-1',
        modelProviderId: 'anthropic',
        modelId: 'claude-opus',
        modelVariant: 'latest'
      })

      // Verify in-memory worktree was updated
      const updatedWt = useWorktreeStore.getState().worktreesByProject.get('proj-1')
      expect(updatedWt![0].last_model_id).toBe('claude-opus')
      expect(updatedWt![0].last_model_provider_id).toBe('anthropic')
      expect(updatedWt![0].last_model_variant).toBe('latest')
    })

    test('handles null variant correctly', async () => {
      const sessions = [
        {
          id: 'sess-1',
          worktree_id: 'wt-1',
          project_id: 'proj-1',
          name: 'Test',
          status: 'active' as const,
          opencode_session_id: null,
          mode: 'build' as const,
          model_provider_id: null,
          model_id: null,
          model_variant: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null
        }
      ]
      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-1', sessions]]),
        tabOrderByWorktree: new Map([['wt-1', ['sess-1']]])
      })
      mockSessionUpdate.mockResolvedValue(sessions[0])

      await useSessionStore.getState().setSessionModel('sess-1', {
        providerID: 'openai',
        modelID: 'gpt-4o'
        // no variant
      })

      expect(mockUpdateModel).toHaveBeenCalledWith({
        worktreeId: 'wt-1',
        modelProviderId: 'openai',
        modelId: 'gpt-4o',
        modelVariant: null
      })
    })

    test('updates global selectedModel in useSettingsStore', async () => {
      const sessions = [
        {
          id: 'sess-1',
          worktree_id: 'wt-1',
          project_id: 'proj-1',
          name: 'Test',
          status: 'active' as const,
          opencode_session_id: null,
          mode: 'build' as const,
          model_provider_id: null,
          model_id: null,
          model_variant: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null
        }
      ]
      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-1', sessions]]),
        tabOrderByWorktree: new Map([['wt-1', ['sess-1']]])
      })
      mockSessionUpdate.mockResolvedValue(sessions[0])

      const { useSettingsStore } = await import('../../../src/renderer/src/stores/useSettingsStore')
      useSettingsStore.setState({ selectedModel: null })

      await useSessionStore.getState().setSessionModel('sess-1', {
        providerID: 'anthropic',
        modelID: 'claude-opus',
        variant: 'latest'
      })

      // Verify global selectedModel was updated
      const globalModel = useSettingsStore.getState().selectedModel
      expect(globalModel).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-opus',
        variant: 'latest'
      })
    })
  })

  describe('useSessionStore.createSession uses worktree model', () => {
    test('uses worktree model when available', async () => {
      // Set up worktree with a model
      const worktrees = [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          name: 'test',
          branch_name: 'main',
          path: '/tmp/test',
          status: 'active' as const,
          is_default: false,
          branch_renamed: 0,
          last_message_at: null,
          session_titles: '[]',
          last_model_provider_id: 'anthropic',
          last_model_id: 'claude-opus',
          last_model_variant: 'latest',
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
      useWorktreeStore.setState({
        worktreesByProject: new Map([['proj-1', worktrees]])
      })

      const createdSession = {
        id: 'new-sess',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'New session',
        status: 'active',
        opencode_session_id: null,
        mode: 'build',
        model_provider_id: 'anthropic',
        model_id: 'claude-opus',
        model_variant: 'latest',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      }
      mockSessionCreate.mockResolvedValue(createdSession)

      const result = await useSessionStore.getState().createSession('wt-1', 'proj-1')

      expect(result.success).toBe(true)
      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model_provider_id: 'anthropic',
          model_id: 'claude-opus',
          model_variant: 'latest'
        })
      )
    })

    test('falls back to global when worktree has no model', async () => {
      // Set up worktree without a model
      const worktrees = [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          name: 'test',
          branch_name: 'main',
          path: '/tmp/test',
          status: 'active' as const,
          is_default: false,
          branch_renamed: 0,
          last_message_at: null,
          session_titles: '[]',
          last_model_provider_id: null,
          last_model_id: null,
          last_model_variant: null,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
      useWorktreeStore.setState({
        worktreesByProject: new Map([['proj-1', worktrees]])
      })

      // Mock the global settings store
      const { useSettingsStore } = await import('../../../src/renderer/src/stores/useSettingsStore')
      useSettingsStore.setState({
        selectedModel: {
          providerID: 'openai',
          modelID: 'gpt-4o',
          variant: undefined
        }
      })

      const createdSession = {
        id: 'new-sess',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'New session',
        status: 'active',
        opencode_session_id: null,
        mode: 'build',
        model_provider_id: 'openai',
        model_id: 'gpt-4o',
        model_variant: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      }
      mockSessionCreate.mockResolvedValue(createdSession)

      const result = await useSessionStore.getState().createSession('wt-1', 'proj-1')

      expect(result.success).toBe(true)
      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model_provider_id: 'openai',
          model_id: 'gpt-4o'
        })
      )
    })

    test('worktree model takes priority over global setting', async () => {
      // Set up worktree with model A
      const worktrees = [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          name: 'test',
          branch_name: 'main',
          path: '/tmp/test',
          status: 'active' as const,
          is_default: false,
          branch_renamed: 0,
          last_message_at: null,
          session_titles: '[]',
          last_model_provider_id: 'anthropic',
          last_model_id: 'claude-opus',
          last_model_variant: null,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
      useWorktreeStore.setState({
        worktreesByProject: new Map([['proj-1', worktrees]])
      })

      // Set global to model B
      const { useSettingsStore } = await import('../../../src/renderer/src/stores/useSettingsStore')
      useSettingsStore.setState({
        selectedModel: {
          providerID: 'openai',
          modelID: 'gpt-4o'
        }
      })

      const createdSession = {
        id: 'new-sess',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'New session',
        status: 'active',
        opencode_session_id: null,
        mode: 'build',
        model_provider_id: 'anthropic',
        model_id: 'claude-opus',
        model_variant: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      }
      mockSessionCreate.mockResolvedValue(createdSession)

      await useSessionStore.getState().createSession('wt-1', 'proj-1')

      // Should use worktree model (anthropic/claude-opus), NOT global (openai/gpt-4o)
      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model_provider_id: 'anthropic',
          model_id: 'claude-opus'
        })
      )
    })

    test('creates session with no model when neither worktree nor global has one', async () => {
      // Worktree with no model
      const worktrees = [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          name: 'test',
          branch_name: 'main',
          path: '/tmp/test',
          status: 'active' as const,
          is_default: false,
          branch_renamed: 0,
          last_message_at: null,
          session_titles: '[]',
          last_model_provider_id: null,
          last_model_id: null,
          last_model_variant: null,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
      useWorktreeStore.setState({
        worktreesByProject: new Map([['proj-1', worktrees]])
      })

      // Clear global model
      const { useSettingsStore } = await import('../../../src/renderer/src/stores/useSettingsStore')
      useSettingsStore.setState({ selectedModel: null })

      const createdSession = {
        id: 'new-sess',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'New session',
        status: 'active',
        opencode_session_id: null,
        mode: 'build',
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      }
      mockSessionCreate.mockResolvedValue(createdSession)

      await useSessionStore.getState().createSession('wt-1', 'proj-1')

      // Should not include model fields in the create call
      const callArgs = mockSessionCreate.mock.calls[0][0]
      expect(callArgs.model_provider_id).toBeUndefined()
      expect(callArgs.model_id).toBeUndefined()
    })
  })
})
