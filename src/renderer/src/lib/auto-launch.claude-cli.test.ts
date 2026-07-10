import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoLaunchTicket } from './auto-launch'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { opencodeApi } from '@/api/opencode-api'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { Session } from '../../../main/db/types'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: {
    connect: vi.fn(),
    prompt: vi.fn()
  }
}))

const hiveTelemetryMocks = vi.hoisted(() => ({
  startHivePromptTelemetry: vi.fn()
}))

vi.mock('@/lib/hive-enterprise-telemetry', () => hiveTelemetryMocks)

const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialUsageState = useUsageStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'opus',
    model_variant: 'high',
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

function setupStores(): {
  createSession: ReturnType<typeof vi.fn>
  setSessionModel: ReturnType<typeof vi.fn>
  updateTicket: ReturnType<typeof vi.fn>
  setOpenCodeSessionId: ReturnType<typeof vi.fn>
} {
  const createSession = vi.fn(
    async (
      worktreeId: string,
      projectId: string,
      sdk?: Session['agent_sdk'],
      mode?: Session['mode']
    ) => ({
      success: true,
      session: makeSession({
        worktree_id: worktreeId,
        project_id: projectId,
        agent_sdk: sdk ?? 'opencode',
        mode: mode ?? 'build'
      })
    })
  )
  const setSessionModel = vi.fn(async () => undefined)
  const setOpenCodeSessionId = vi.fn()
  const updateTicket = vi.fn(async () => undefined)

  useProjectStore.setState({
    projects: [
      {
        id: 'project-1',
        name: 'Hive',
        path: '/repo',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        detected_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        auto_assign_port: false,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        last_accessed_at: '2026-01-01T00:00:00.000Z'
      }
    ]
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      [
        'project-1',
        [
          {
            id: 'worktree-1',
            project_id: 'project-1',
            name: 'Feature',
            branch_name: 'feature',
            path: '/repo/feature',
            status: 'active',
            is_default: false,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            attachments: '[]',
            created_at: '2026-01-01T00:00:00.000Z',
            last_accessed_at: '2026-01-01T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          }
        ]
      ]
    ])
  })
  useKanbanStore.setState({ updateTicket })
  useSessionStore.setState({
    createSession,
    setSessionModel,
    setOpenCodeSessionId,
    setSessionMode: vi.fn(async () => undefined)
  })
  useWorktreeStatusStore.setState({
    setSessionStatus: vi.fn(),
    setLastMessageTime: vi.fn()
  })
  useUsageStore.setState({
    fetchUsageForProvider: vi.fn()
  })

  return { createSession, setSessionModel, updateTicket, setOpenCodeSessionId }
}

describe('autoLaunchTicket Claude CLI', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    request = vi.fn(async (method: string) => {
      if (method === 'terminalOps.createClaudeCli') return { success: true }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    setupStores()
    vi.mocked(opencodeApi.connect).mockResolvedValue({
      success: true,
      value: { success: true, sessionId: 'opc-1' }
    })
    vi.mocked(opencodeApi.prompt).mockResolvedValue({
      success: true,
      value: { success: true }
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useProjectStore.setState(initialProjectState, true)
    useUsageStore.setState(initialUsageState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
  })

  it('consumes a Claude CLI pending launch by spawning terminalOps instead of OpenCode', async () => {
    const { createSession, setSessionModel, updateTicket } = setupStores()
    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Launch Claude CLI',
      pending_launch_config: JSON.stringify({
        worktree: { type: 'existing', worktreeId: 'worktree-1' },
        prompt: 'Implement the ticket',
        mode: 'plan',
        model: { providerID: 'anthropic', modelID: 'opus', variant: 'high' },
        sdk: 'claude-code-cli',
        codexFastMode: false,
        goalMode: false,
        goalSuccessCriteria: null
      })
    })

    expect(createSession).toHaveBeenCalledWith(
      'worktree-1',
      'project-1',
      'claude-code-cli',
      'plan',
      {
        autoFocus: false,
        modelOverride: {
          agentSdk: 'claude-code-cli',
          providerID: 'anthropic',
          modelID: 'opus',
          variant: 'high'
        },
        pendingMessage: 'Implement the ticket'
      }
    )
    expect(setSessionModel).toHaveBeenCalledWith('session-1', {
      providerID: 'anthropic',
      modelID: 'opus',
      variant: 'high'
    })
    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      expect.objectContaining({
        pending_launch_config: null,
        current_session_id: 'session-1',
        worktree_id: 'worktree-1',
        mode: 'plan'
      })
    )
    expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', {
      sessionId: 'session-1',
      opts: { pendingPrompt: 'Implement the ticket' }
    })
  })

  it('persists connected OpenCode session IDs through dbApi', async () => {
    const { setOpenCodeSessionId, updateTicket } = setupStores()

    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Launch OpenCode',
      pending_launch_config: JSON.stringify({
        worktree: { type: 'existing', worktreeId: 'worktree-1' },
        prompt: 'Implement the ticket',
        mode: 'build',
        model: null,
        sdk: 'opencode',
        codexFastMode: false,
        goalMode: false,
        goalSuccessCriteria: null
      })
    })

    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      expect.objectContaining({
        pending_launch_config: null,
        current_session_id: 'session-1',
        worktree_id: 'worktree-1',
        mode: 'build'
      })
    )
    expect(opencodeApi.connect).toHaveBeenCalledWith('/repo/feature', 'session-1')
    expect(setOpenCodeSessionId).toHaveBeenCalledWith('session-1', 'opc-1')
    expect(request).toHaveBeenCalledWith('db.session.update', {
      id: 'session-1',
      data: { opencode_session_id: 'opc-1' }
    })
    expect(opencodeApi.prompt).toHaveBeenCalledWith(
      '/repo/feature',
      'opc-1',
      [{ type: 'text', text: 'Implement the ticket' }],
      undefined,
      undefined
    )
    expect(hiveTelemetryMocks.startHivePromptTelemetry).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'Implement the ticket',
      worktreeId: 'worktree-1',
      modelId: undefined,
      providerId: undefined,
      modelVariant: undefined,
      mode: 'build',
      source: 'other'
    })
  })

  it('wraps goal-mode prompts before spawning Claude CLI', async () => {
    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Launch Claude CLI',
      pending_launch_config: JSON.stringify({
        worktree: { type: 'existing', worktreeId: 'worktree-1' },
        prompt: 'Implement the ticket',
        mode: 'build',
        model: null,
        sdk: 'claude-code-cli',
        codexFastMode: false,
        goalMode: true,
        goalSuccessCriteria: 'Tests pass'
      })
    })

    expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', {
      sessionId: 'session-1',
      opts: { pendingPrompt: '/goal Implement the ticket. Goal success criteria: Tests pass' }
    })
  })
})
