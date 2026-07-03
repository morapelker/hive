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

vi.mock('@/lib/hive-enterprise-telemetry', () => ({
  startHivePromptTelemetry: vi.fn()
}))

const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialUsageState = useUsageStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

const LONG_PROMPT = 'Implement all the things. '.repeat(150)

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
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
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
    github_pr_url: null,
    ...overrides
  } as Worktree
}

function setupStores(): void {
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
    worktreesByProject: new Map([['project-1', [makeWorktree()]]])
  })
  useKanbanStore.setState({ updateTicket: vi.fn(async () => undefined) })
  useSessionStore.setState({
    createSession: vi.fn(
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
    ),
    setSessionModel: vi.fn(async () => undefined),
    setOpenCodeSessionId: vi.fn(),
    setSessionMode: vi.fn(async () => undefined),
    dequeuePendingMessage: vi.fn()
  })
  useWorktreeStatusStore.setState({
    setSessionStatus: vi.fn(),
    setLastMessageTime: vi.fn()
  })
  useUsageStore.setState({
    fetchUsageForProvider: vi.fn()
  })
}

function makeConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    worktree: { type: 'existing', worktreeId: 'worktree-1' },
    prompt: LONG_PROMPT,
    mode: 'build',
    model: null,
    sdk: 'claude-code-cli',
    codexFastMode: false,
    goalMode: true,
    goalSuccessCriteria: 'Tests pass',
    ...overrides
  })
}

function findRpcCall(
  request: ReturnType<typeof vi.fn>,
  method: string
): unknown[] | undefined {
  return request.mock.calls.find(([m]) => m === method)
}

describe('autoLaunchTicket goal plan-file conversion', () => {
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

  it('converts an oversized goal prompt to a plan file before spawning Claude CLI', async () => {
    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Launch Claude CLI',
      pending_launch_config: makeConfig()
    })

    const createFileCall = findRpcCall(request, 'fileOps.createFile')
    expect(createFileCall).toBeDefined()
    const { filePath, content } = createFileCall![1] as { filePath: string; content: string }
    expect(filePath).toMatch(/^\/repo\/feature\/PLAN_[0-9a-f-]{36}\.md$/)
    expect(content).toBe(LONG_PROMPT.trim())

    const fileName = filePath.replace('/repo/feature/', '')
    expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', {
      sessionId: 'session-1',
      opts: {
        pendingPrompt: `/goal Implement ${fileName}. Goal success criteria: Tests pass`
      }
    })

    // The plan file must be written before the CLI spawns to read it
    const methods = request.mock.calls.map(([m]) => m)
    expect(methods.indexOf('fileOps.createFile')).toBeLessThan(
      methods.indexOf('terminalOps.createClaudeCli')
    )
  })

  it('aborts the launch when the plan-file write fails', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'fileOps.createFile') throw new Error('read-only worktree')
      if (method === 'terminalOps.createClaudeCli') return { success: true }
      return null
    })
    const createSession = useSessionStore.getState().createSession

    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Launch Claude CLI',
      pending_launch_config: makeConfig()
    })

    expect(createSession).not.toHaveBeenCalled()
    expect(findRpcCall(request, 'terminalOps.createClaudeCli')).toBeUndefined()
  })

  it('creates the plan file in the root of a newly created worktree', async () => {
    const newWorktree = makeWorktree({
      id: 'worktree-2',
      name: 'goal-ticket',
      branch_name: 'goal-ticket',
      path: '/repo/goal-ticket'
    })
    const createWorktreeFromBranch = vi.fn(async () => {
      useWorktreeStore.setState((state) => {
        const map = new Map(state.worktreesByProject)
        map.set('project-1', [newWorktree, ...(map.get('project-1') ?? [])])
        return { worktreesByProject: map }
      })
      return { success: true, worktree: newWorktree }
    })
    useWorktreeStore.setState({ createWorktreeFromBranch })

    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Goal ticket',
      pending_launch_config: makeConfig({
        worktree: { type: 'new', sourceBranch: 'main' },
        sdk: 'codex'
      })
    })

    expect(createWorktreeFromBranch).toHaveBeenCalled()
    const createFileCall = findRpcCall(request, 'fileOps.createFile')
    expect(createFileCall).toBeDefined()
    const { filePath } = createFileCall![1] as { filePath: string }
    expect(filePath).toMatch(/^\/repo\/goal-ticket\/PLAN_[0-9a-f-]{36}\.md$/)

    const fileName = filePath.replace('/repo/goal-ticket/', '')
    expect(opencodeApi.prompt).toHaveBeenCalledWith(
      '/repo/goal-ticket',
      'opc-1',
      [{ type: 'text', text: `/goal Implement ${fileName}. Goal success criteria: Tests pass` }],
      undefined,
      { codexFastMode: false }
    )
  })

  it('leaves goal prompts under the limit untouched', async () => {
    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Launch Claude CLI',
      pending_launch_config: makeConfig({ prompt: 'Implement the ticket' })
    })

    expect(findRpcCall(request, 'fileOps.createFile')).toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', {
      sessionId: 'session-1',
      opts: {
        pendingPrompt: '/goal Implement the ticket. Goal success criteria: Tests pass'
      }
    })
  })

  it('leaves oversized prompts untouched when goal mode is off', async () => {
    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Launch Claude CLI',
      pending_launch_config: makeConfig({ goalMode: false, goalSuccessCriteria: null })
    })

    expect(findRpcCall(request, 'fileOps.createFile')).toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', {
      sessionId: 'session-1',
      opts: { pendingPrompt: LONG_PROMPT.trim() }
    })
  })
})
