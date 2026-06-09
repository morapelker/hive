import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  useBoardChatStore,
  type TicketDraft
} from '../../src/renderer/src/stores/useBoardChatStore'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { dbApi } from '../../src/renderer/src/api/db-api'
import { opencodeApi } from '../../src/renderer/src/api/opencode-api'

vi.mock('../../src/renderer/src/api/db-api', () => ({
  dbApi: {
    session: {
      update: vi.fn(),
      delete: vi.fn()
    }
  }
}))

vi.mock('../../src/renderer/src/api/opencode-api', () => ({
  opencodeApi: {
    abort: vi.fn(),
    disconnect: vi.fn()
  }
}))

vi.mock('../../src/renderer/src/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => () => {})
  }
}))

const projectScope = {
  kind: 'project' as const,
  projectId: 'proj-1',
  projectName: 'Project One',
  projectPath: '/tmp/proj-1'
}

const otherProjectScope = {
  kind: 'project' as const,
  projectId: 'proj-2',
  projectName: 'Project Two',
  projectPath: '/tmp/proj-2'
}

const boardDraft: TicketDraft = {
  id: 'draft-1',
  draftKey: 'draft-1',
  title: 'Create ticket',
  description: 'Persist the board assistant state',
  dependsOn: [],
  resolvedDependsOnTitles: [],
  warnings: [],
  validationIssues: [],
  projectId: 'proj-1',
  projectName: 'Project One',
  selected: true,
  createdAt: null
}

describe('board assistant persistence', () => {
  const mockSessionUpdate = vi.mocked(dbApi.session.update)
  const mockSessionDelete = vi.mocked(dbApi.session.delete)
  const mockAbort = vi.mocked(opencodeApi.abort)
  const mockDisconnect = vi.mocked(opencodeApi.disconnect)

  beforeEach(() => {
    vi.clearAllMocks()
    useBoardChatStore.setState(useBoardChatStore.getInitialState())
    useSessionStore.setState({
      boardAssistantByProject: new Map(),
      activeBoardAssistantProjectId: null,
      modeBySession: new Map()
    })

    mockSessionUpdate.mockResolvedValue({ success: true })
    mockSessionDelete.mockResolvedValue(true)
    mockAbort.mockResolvedValue({ success: true, value: { success: true } })
    mockDisconnect.mockResolvedValue({ success: true, value: { success: true } })
  })

  test('restores the existing project snapshot after switching away and back', () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateScope(projectScope, { scope: projectScope })
    boardChat.addLocalUserMessage('Break this into tickets')
    boardChat.setDrafts([boardDraft], 'assistant-msg-1')
    boardChat.setRuntimeSession({
      sessionId: 'board-session-1',
      opencodeSessionId: 'opc-1',
      runtimePath: '/tmp/proj-1'
    })
    boardChat.setStatus('awaiting_confirmation')

    boardChat.activateScope(otherProjectScope, { scope: otherProjectScope })
    boardChat.addLocalUserMessage('Different board')

    boardChat.activateScope(projectScope, { scope: projectScope })

    const restored = useBoardChatStore.getState()
    expect(restored.sessionId).toBe('board-session-1')
    expect(restored.opencodeSessionId).toBe('opc-1')
    expect(restored.status).toBe('awaiting_confirmation')
    expect(restored.drafts).toHaveLength(1)
    expect(restored.messages.some((message) => message.content === 'Break this into tickets')).toBe(
      true
    )
    expect(restored.messages.some((message) => message.content === 'Different board')).toBe(false)
  })

  test('finds inactive project snapshots by session id', () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateScope(projectScope, { scope: projectScope })
    boardChat.setRuntimeSession({
      sessionId: 'board-session-1',
      opencodeSessionId: 'opc-1',
      runtimePath: '/tmp/proj-1'
    })

    boardChat.activateScope(otherProjectScope, { scope: otherProjectScope })

    const inactive = useBoardChatStore.getState().getSessionSnapshot('board-session-1')
    expect(inactive).not.toBeNull()
    expect(inactive?.key).toBe('project:proj-1')
    expect(inactive?.snapshot.runtimePath).toBe('/tmp/proj-1')
  })

  test('closing an active board assistant deletes the runtime session', async () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateScope(projectScope, { scope: projectScope })
    boardChat.setRuntimeSession({
      sessionId: 'board-session-1',
      opencodeSessionId: 'opc-1',
      runtimePath: '/tmp/proj-1'
    })

    await boardChat.close()

    expect(mockDisconnect).toHaveBeenCalledWith('/tmp/proj-1', 'opc-1')
    expect(mockSessionDelete).toHaveBeenCalledWith('board-session-1')
    expect(useBoardChatStore.getState().sessionId).toBeNull()
  })

  test('closing an unfocused board assistant clears the correct project snapshot', async () => {
    const boardChat = useBoardChatStore.getState()

    boardChat.activateScope(projectScope, { scope: projectScope })
    boardChat.setRuntimeSession({
      sessionId: 'board-session-1',
      opencodeSessionId: 'opc-1',
      runtimePath: '/tmp/proj-1'
    })

    boardChat.activateScope(otherProjectScope, { scope: otherProjectScope })
    boardChat.setRuntimeSession({
      sessionId: 'board-session-2',
      opencodeSessionId: 'opc-2',
      runtimePath: '/tmp/proj-2'
    })

    useSessionStore.setState({
      boardAssistantByProject: new Map([
        [
          'proj-1',
          {
            id: 'board-session-1',
            worktree_id: null,
            project_id: 'proj-1',
            connection_id: null,
            name: 'Board Assistant',
            status: 'active',
            opencode_session_id: 'opc-1',
            agent_sdk: 'opencode',
            mode: 'build',
            session_type: 'board-assistant',
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            created_at: '2026-04-15T00:00:00.000Z',
            updated_at: '2026-04-15T00:00:00.000Z',
            completed_at: null
          }
        ]
      ]),
      modeBySession: new Map([['board-session-1', 'build']])
    })

    const result = await useSessionStore.getState().closeBoardAssistantSession('proj-1')

    expect(result.success).toBe(true)
    expect(useBoardChatStore.getState().getProjectSnapshot('proj-1')).toBeNull()
    expect(useBoardChatStore.getState().getProjectSnapshot('proj-2')).not.toBeNull()
    expect(mockAbort).toHaveBeenCalledWith('/tmp/proj-1', 'opc-1')
    expect(mockDisconnect).toHaveBeenCalledWith('/tmp/proj-1', 'opc-1')
    expect(mockSessionUpdate).toHaveBeenCalledWith('board-session-1', {
      status: 'completed',
      completed_at: expect.any(String)
    })
    expect(useSessionStore.getState().boardAssistantByProject.has('proj-1')).toBe(false)
  })

  test('setOpenCodeSessionId updates board assistant sessions in the session store', () => {
    useSessionStore.setState({
      boardAssistantByProject: new Map([
        [
          'proj-1',
          {
            id: 'board-session-1',
            worktree_id: null,
            project_id: 'proj-1',
            connection_id: null,
            name: 'Board Assistant',
            status: 'active',
            opencode_session_id: 'pending::1',
            agent_sdk: 'opencode',
            mode: 'build',
            session_type: 'board-assistant',
            model_provider_id: null,
            model_id: null,
            model_variant: null,
            created_at: '2026-04-15T00:00:00.000Z',
            updated_at: '2026-04-15T00:00:00.000Z',
            completed_at: null
          }
        ]
      ])
    })

    useSessionStore.getState().setOpenCodeSessionId('board-session-1', 'materialized-1')

    expect(
      useSessionStore.getState().boardAssistantByProject.get('proj-1')?.opencode_session_id
    ).toBe('materialized-1')
  })
})
