import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchTicketWithModel } from './ticket-launch'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { Session, Worktree } from '../../../main/db/types'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

vi.mock('@/lib/hive-enterprise-telemetry', () => ({
  startHivePromptTelemetry: vi.fn()
}))

const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialUsageState = useUsageStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

const session = {
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
  pinned_to_board: false
} as Session

const worktree = {
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
} as Worktree

function setupStores(): ReturnType<typeof vi.fn> {
  const createWorktreeFromBranch = vi.fn(async () => ({ success: true, worktree }))
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
        worktree_create_script: null,
        custom_commands: null,
        auto_assign_port: false,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        last_accessed_at: '2026-01-01T00:00:00.000Z'
      }
    ]
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map([['project-1', [worktree]]]),
    createWorktreeFromBranch
  })
  useKanbanStore.setState({ updateTicket: vi.fn(async () => undefined) })
  useSessionStore.setState({
    createSession: vi.fn(async () => ({ success: true, session })),
    setSessionModel: vi.fn(async () => undefined),
    setOpenCodeSessionId: vi.fn(),
    setSessionMode: vi.fn(async () => undefined),
    dequeuePendingMessage: vi.fn()
  })
  useWorktreeStatusStore.setState({ setSessionStatus: vi.fn(), setLastMessageTime: vi.fn() })
  useUsageStore.setState({ fetchUsageForProvider: vi.fn() })
  return createWorktreeFromBranch
}

const spec = (
  worktreeSpec: Parameters<typeof launchTicketWithModel>[0]['worktree']
): Parameters<typeof launchTicketWithModel>[0] => ({
  ticketId: 'ticket-1',
  projectId: 'project-1',
  ticketTitle: 'My Ticket Title',
  worktree: worktreeSpec,
  prompt: 'Implement the ticket',
  mode: 'build',
  modelConfig: {
    sdk: 'claude-code-cli',
    model: { providerID: 'anthropic', modelID: 'opus', variant: 'high' },
    codexFastMode: false
  },
  goalMode: false,
  goalSuccessCriteria: null
})

describe('launchTicketWithModel worktree options', () => {
  beforeAll(() => new Promise((resolve) => setTimeout(resolve, 220)))

  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    const request = vi.fn(async (method: string) =>
      method === 'terminalOps.createClaudeCli' ? { success: true } : null
    )
    setRendererRpcClient({ request: request as never, subscribe: vi.fn() })
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

  it('forwards baseRef, autoPull and select to the store', async () => {
    const createWorktreeFromBranch = setupStores()

    const result = await launchTicketWithModel(
      spec({
        type: 'new',
        sourceBranch: 'doc-run',
        nameHint: 'a1-task',
        baseRef: 'doc-run',
        autoPull: false,
        select: false
      })
    )

    expect(result).toEqual({ success: true, sessionId: 'session-1', worktreeId: 'worktree-1' })
    expect(createWorktreeFromBranch).toHaveBeenCalledWith(
      'project-1',
      '/repo',
      'Hive',
      'doc-run',
      'a1-task',
      { baseRef: 'doc-run', autoPull: false, select: false }
    )
  })

  it('forwards only the options that are set', async () => {
    const createWorktreeFromBranch = setupStores()

    await launchTicketWithModel(spec({ type: 'new', sourceBranch: 'main', select: false }))

    expect(createWorktreeFromBranch).toHaveBeenCalledWith(
      'project-1',
      '/repo',
      'Hive',
      'main',
      'my-ticket-title',
      { select: false }
    )
  })

  it('makes the same five-argument call as before when no option is given', async () => {
    const createWorktreeFromBranch = setupStores()

    await launchTicketWithModel(spec({ type: 'new', sourceBranch: 'main' }))

    expect(createWorktreeFromBranch).toHaveBeenCalledTimes(1)
    expect(createWorktreeFromBranch.mock.calls[0]).toEqual([
      'project-1',
      '/repo',
      'Hive',
      'main',
      'my-ticket-title'
    ])
  })
})
