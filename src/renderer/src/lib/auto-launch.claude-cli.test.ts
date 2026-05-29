import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoLaunchTicket } from './auto-launch'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { Session } from '../../../main/db/types'

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

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
} {
  const createSession = vi.fn(async (worktreeId: string, projectId: string, sdk: Session['agent_sdk'], mode: Session['mode']) => ({
    success: true,
    session: makeSession({ worktree_id: worktreeId, project_id: projectId, agent_sdk: sdk, mode })
  }))
  const setSessionModel = vi.fn(async () => undefined)
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
    setSessionMode: vi.fn(async () => undefined)
  })
  useWorktreeStatusStore.setState({
    setSessionStatus: vi.fn(),
    setLastMessageTime: vi.fn()
  })
  useUsageStore.setState({
    fetchUsageForProvider: vi.fn()
  })

  return { createSession, setSessionModel, updateTicket }
}

function setupWindowApis(): void {
  Object.defineProperty(window, 'terminalOps', {
    configurable: true,
    writable: true,
    value: {
      createClaudeCli: vi.fn().mockResolvedValue({ success: true, value: { success: true } })
    }
  })
  Object.defineProperty(window, 'opencodeOps', {
    configurable: true,
    writable: true,
    value: {
      connect: vi.fn().mockResolvedValue({ success: true, value: { success: true, sessionId: 'opc-1' } }),
      prompt: vi.fn().mockResolvedValue({ success: true, value: { success: true } })
    }
  })
  Object.defineProperty(window, 'db', {
    configurable: true,
    writable: true,
    value: {
      session: {
        update: vi.fn().mockResolvedValue({ success: true, value: undefined })
      }
    }
  })
}

describe('autoLaunchTicket Claude CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupWindowApis()
    setupStores()
  })

  afterEach(() => {
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useProjectStore.setState(initialProjectState, true)
    useUsageStore.setState(initialUsageState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
    delete (window as { terminalOps?: unknown }).terminalOps
    delete (window as { opencodeOps?: unknown }).opencodeOps
    delete (window as { db?: unknown }).db
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

    expect(createSession).toHaveBeenCalledWith('worktree-1', 'project-1', 'claude-code-cli', 'plan', {
      autoFocus: false,
      modelOverride: {
        agentSdk: 'claude-code-cli',
        providerID: 'anthropic',
        modelID: 'opus',
        variant: 'high'
      },
      pendingMessage: 'Implement the ticket'
    })
    expect(setSessionModel).toHaveBeenCalledWith('session-1', {
      providerID: 'anthropic',
      modelID: 'opus',
      variant: 'high'
    })
    expect(updateTicket).toHaveBeenCalledWith('ticket-1', 'project-1', expect.objectContaining({
      pending_launch_config: null,
      current_session_id: 'session-1',
      worktree_id: 'worktree-1',
      mode: 'plan'
    }))
    expect(window.terminalOps.createClaudeCli).toHaveBeenCalledWith('session-1', {
      pendingPrompt: 'Implement the ticket'
    })
    expect(window.opencodeOps.connect).not.toHaveBeenCalled()
    expect(window.opencodeOps.prompt).not.toHaveBeenCalled()
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

    expect(window.terminalOps.createClaudeCli).toHaveBeenCalledWith('session-1', {
      pendingPrompt: '/goal Implement the ticket. Goal success criteria: Tests pass'
    })
  })
})
