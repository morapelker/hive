import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreePickerModal, _resetLastSourceBranch } from './WorktreePickerModal'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { opencodeApi } from '@/api/opencode-api'
import { toast } from '@/lib/toast'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket, Session, Worktree } from '../../../../main/db/types'

vi.mock('@/api/hive-enterprise/client', () => ({
  isHiveTelemetryEnabled: vi.fn(() => false),
  recordHivePromptStart: vi.fn(),
  recordHivePromptIdle: vi.fn(),
  recordHiveQuestionsAnswered: vi.fn()
}))

vi.mock('@/components/sessions/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />
}))

vi.mock('@/components/sessions/CodexFastToggle', () => ({
  CodexFastToggle: () => <div data-testid="codex-fast-toggle" />
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    loadCustomCommandsFile: vi.fn().mockResolvedValue({ commands: [] }),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    updateSettings: vi.fn().mockResolvedValue({
      success: true,
      value: { enabled: true, size: 'md', position: { x: 0, y: 0 }, hatched: true }
    })
  }
}))

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: {
    connect: vi.fn(),
    prompt: vi.fn()
  }
}))

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialUsageState = useUsageStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

// Long enough that the built prompt (prefix + <ticket> XML) exceeds 3k chars.
const LONG_DESCRIPTION = 'Implement all the things. '.repeat(150)

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Goal ticket',
    description: 'Short description',
    column: 'todo',
    sort_order: 0,
    worktree_id: null,
    current_session_id: null,
    mode: 'build',
    plan_ready: false,
    goal_mode: false,
    goal_success_criteria: null,
    pending_launch_config: null,
    created_from_session: false,
    auto_approve_plan: false,
    attachments: [],
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    note: null,
    total_tokens: 0,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
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

function setupStores(): void {
  const createSession = vi.fn(
    async (
      worktreeId: string,
      projectId: string,
      sdk: Session['agent_sdk'] = 'opencode',
      mode: Session['mode'] = 'build'
    ) => ({
      success: true,
      session: makeSession({
        worktree_id: worktreeId,
        project_id: projectId,
        agent_sdk: sdk,
        mode: mode === 'super-plan' ? 'plan' : mode
      })
    })
  )
  const createConnectionSession = vi.fn(
    async (connectionId: string, sdk: Session['agent_sdk'] = 'opencode') => ({
      success: true,
      session: makeSession({
        id: 'connection-session-1',
        worktree_id: null,
        connection_id: connectionId,
        agent_sdk: sdk
      })
    })
  )

  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    defaultAgentSdk: 'opencode',
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    codexFastMode: false,
    codexFastModeAccepted: true,
    boardMode: 'toggle'
  })
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
    worktreesByProject: new Map([['project-1', [makeWorktree()]]]),
    worktreeOrderByProject: new Map(),
    syncWorktrees: vi.fn(),
    createWorktreeFromBranch: vi.fn()
  })
  useConnectionStore.setState({
    connections: [
      {
        id: 'connection-1',
        name: 'Feature connection',
        custom_name: null,
        status: 'active',
        path: '/repo/connection',
        color: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        members: []
      }
    ],
    loaded: true
  })
  useKanbanStore.setState({
    tickets: new Map([['project-1', []]]),
    updateTicket: vi.fn(async () => undefined),
    computeSortOrder: vi.fn(() => 1),
    getTicketsByColumn: vi.fn(() => []),
    getTicketsByColumnForConnection: vi.fn(() => [])
  })
  useSessionStore.setState({
    sessionsByWorktree: new Map(),
    sessionsByConnection: new Map(),
    modeBySession: new Map(),
    createSession,
    createConnectionSession,
    setSessionModel: vi.fn(async () => undefined),
    setSessionMode: vi.fn(async () => undefined),
    setOpenCodeSessionId: vi.fn(),
    setActiveSession: vi.fn(),
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

async function enableGoalMode(criteria = 'Tests pass'): Promise<void> {
  await userEvent.click(screen.getByTestId('sdk-toggle-claude-code-cli'))
  await userEvent.click(screen.getByTestId('goal-mode-toggle'))
  await userEvent.type(screen.getByTestId('goal-success-criteria'), criteria)
}

function findRpcCall(
  request: ReturnType<typeof vi.fn>,
  method: string
): unknown[] | undefined {
  return request.mock.calls.find(([m]) => m === method)
}

describe('WorktreePickerModal goal plan-file conversion', () => {
  let request: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    // useSettingsStore schedules a one-shot 200ms timer on module import that
    // reloads settings and re-detects agent SDKs; with the mocked RPC client it
    // sets availableAgentSdks to null, unmounting the SDK toggle mid-test. Let
    // it fire (against a mock client) before any test renders.
    const bootRequest: ReturnType<typeof vi.fn> = vi.fn(async () => null)
    setRendererRpcClient({ request: bootRequest, subscribe: vi.fn() })
    await new Promise((resolve) => setTimeout(resolve, 400))
    resetRendererRpcClientForTests()
  })

  beforeEach(() => {
    _resetLastSourceBranch()
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
    cleanup()
    useSettingsStore.setState(initialSettingsState, true)
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useConnectionStore.setState(initialConnectionState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useProjectStore.setState(initialProjectState, true)
    useUsageStore.setState(initialUsageState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
    resetRendererRpcClientForTests()
  })

  it('shows the conversion notice when goal mode is on and the prompt exceeds 3k characters', async () => {
    render(
      <WorktreePickerModal
        ticket={makeTicket({ description: LONG_DESCRIPTION })}
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.queryByTestId('goal-plan-file-notice')).toBeNull()

    await userEvent.click(screen.getByTestId('sdk-toggle-claude-code-cli'))
    await userEvent.click(screen.getByTestId('goal-mode-toggle'))

    expect(screen.getByTestId('goal-plan-file-notice').textContent).toContain(
      'Will be converted to an md file for implementation (>3k characters)'
    )
  })

  it('hides the notice for prompts under the limit', async () => {
    render(
      <WorktreePickerModal
        ticket={makeTicket()}
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('sdk-toggle-claude-code-cli'))
    await userEvent.click(screen.getByTestId('goal-mode-toggle'))

    expect(screen.queryByTestId('goal-plan-file-notice')).toBeNull()
  })

  it('writes a plan file into the worktree root and sends a slim goal prompt (Claude CLI)', async () => {
    render(
      <WorktreePickerModal
        ticket={makeTicket({ description: LONG_DESCRIPTION })}
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSendComplete={vi.fn()}
      />
    )

    await enableGoalMode()
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.any(Object))
    )

    const createFileCall = findRpcCall(request, 'fileOps.createFile')
    expect(createFileCall).toBeDefined()
    const { directoryPath, fileName, content } = createFileCall![1] as {
      directoryPath: string
      fileName: string
      content: string
    }
    expect(directoryPath).toBe('/repo/feature')
    expect(fileName).toMatch(/^PLAN_[0-9a-f-]{36}\.md$/)
    expect(content).toContain('<ticket title="Goal ticket">')
    expect(content).toContain(LONG_DESCRIPTION.trim())
    const cliCall = findRpcCall(request, 'terminalOps.createClaudeCli')
    const pendingPrompt = (cliCall![1] as { opts: { pendingPrompt: string } }).opts.pendingPrompt
    expect(pendingPrompt).toBe(`/goal Implement ${fileName}. Goal success criteria: Tests pass`)

    // The plan file must be written before the CLI spawns to read it
    const methods = request.mock.calls.map(([m]) => m)
    expect(methods.indexOf('fileOps.createFile')).toBeLessThan(
      methods.indexOf('terminalOps.createClaudeCli')
    )
  })

  it('aborts the send when the plan-file write fails', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'fileOps.createFile') throw new Error('read-only worktree')
      if (method === 'terminalOps.createClaudeCli') return { success: true }
      return null
    })
    const createSession = useSessionStore.getState().createSession

    render(
      <WorktreePickerModal
        ticket={makeTicket({ description: LONG_DESCRIPTION })}
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSendComplete={vi.fn()}
      />
    )

    await enableGoalMode()
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'Failed to create plan file: read-only worktree'
      )
    )
    expect(createSession).not.toHaveBeenCalled()
    expect(findRpcCall(request, 'terminalOps.createClaudeCli')).toBeUndefined()
  })

  it('creates the plan file in a newly created worktree root', async () => {
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

    render(
      <WorktreePickerModal
        ticket={makeTicket({ description: LONG_DESCRIPTION })}
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSendComplete={vi.fn()}
      />
    )

    await enableGoalMode()
    // Default selection is "New worktree" — send without picking an existing one
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.any(Object))
    )
    expect(createWorktreeFromBranch).toHaveBeenCalled()

    const createFileCall = findRpcCall(request, 'fileOps.createFile')
    expect(createFileCall).toBeDefined()
    const { directoryPath, fileName } = createFileCall![1] as {
      directoryPath: string
      fileName: string
    }
    expect(directoryPath).toBe('/repo/goal-ticket')
    expect(fileName).toMatch(/^PLAN_[0-9a-f-]{36}\.md$/)
  })

  it('writes the plan file to the connection root in connection mode', async () => {
    render(
      <WorktreePickerModal
        ticket={makeTicket({ description: LONG_DESCRIPTION })}
        projectId="project-1"
        connectionId="connection-1"
        open
        onOpenChange={vi.fn()}
        onSendComplete={vi.fn()}
      />
    )

    await enableGoalMode()
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.any(Object))
    )

    const createFileCall = findRpcCall(request, 'fileOps.createFile')
    expect(createFileCall).toBeDefined()
    const { directoryPath, fileName } = createFileCall![1] as {
      directoryPath: string
      fileName: string
    }
    expect(directoryPath).toBe('/repo/connection')
    expect(fileName).toMatch(/^PLAN_[0-9a-f-]{36}\.md$/)

    const cliCall = findRpcCall(request, 'terminalOps.createClaudeCli')
    const pendingPrompt = (cliCall![1] as { opts: { pendingPrompt: string } }).opts.pendingPrompt
    expect(pendingPrompt).toBe(`/goal Implement ${fileName}. Goal success criteria: Tests pass`)
  })

  it('converts oversized codex goal prompts sent through OpenCode', async () => {
    render(
      <WorktreePickerModal
        ticket={makeTicket({ description: LONG_DESCRIPTION })}
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSendComplete={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('sdk-toggle-codex'))
    await userEvent.click(screen.getByTestId('goal-mode-toggle'))
    await userEvent.type(screen.getByTestId('goal-success-criteria'), 'Tests pass')
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() => expect(opencodeApi.prompt).toHaveBeenCalled())

    const createFileCall = findRpcCall(request, 'fileOps.createFile')
    expect(createFileCall).toBeDefined()
    const { directoryPath, fileName } = createFileCall![1] as {
      directoryPath: string
      fileName: string
    }
    expect(directoryPath).toBe('/repo/feature')
    expect(fileName).toMatch(/^PLAN_[0-9a-f-]{36}\.md$/)

    const [, , parts] = vi.mocked(opencodeApi.prompt).mock.calls[0]
    expect(parts).toEqual([
      { type: 'text', text: `/goal Implement ${fileName}. Goal success criteria: Tests pass` }
    ])

    // The plan file must be written before the prompt referencing it is sent
    const createFileIdx = request.mock.calls.findIndex(([m]) => m === 'fileOps.createFile')
    expect(request.mock.invocationCallOrder[createFileIdx]).toBeLessThan(
      vi.mocked(opencodeApi.prompt).mock.invocationCallOrder[0]
    )
  })

  it('converts oversized codex goal prompts in connection mode through OpenCode', async () => {
    render(
      <WorktreePickerModal
        ticket={makeTicket({ description: LONG_DESCRIPTION })}
        projectId="project-1"
        connectionId="connection-1"
        open
        onOpenChange={vi.fn()}
        onSendComplete={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('sdk-toggle-codex'))
    await userEvent.click(screen.getByTestId('goal-mode-toggle'))
    await userEvent.type(screen.getByTestId('goal-success-criteria'), 'Tests pass')
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() => expect(opencodeApi.prompt).toHaveBeenCalled())

    const createFileCall = findRpcCall(request, 'fileOps.createFile')
    expect(createFileCall).toBeDefined()
    const { directoryPath, fileName } = createFileCall![1] as {
      directoryPath: string
      fileName: string
    }
    expect(directoryPath).toBe('/repo/connection')
    expect(fileName).toMatch(/^PLAN_[0-9a-f-]{36}\.md$/)

    const [promptPath, , parts] = vi.mocked(opencodeApi.prompt).mock.calls[0]
    expect(promptPath).toBe('/repo/connection')
    expect(parts).toEqual([
      { type: 'text', text: `/goal Implement ${fileName}. Goal success criteria: Tests pass` }
    ])
  })

  it('sends the full goal prompt without a plan file when under the limit', async () => {
    render(
      <WorktreePickerModal
        ticket={makeTicket()}
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSendComplete={vi.fn()}
      />
    )

    await enableGoalMode()
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.any(Object))
    )
    expect(findRpcCall(request, 'fileOps.createFile')).toBeUndefined()

    const cliCall = findRpcCall(request, 'terminalOps.createClaudeCli')
    const pendingPrompt = (cliCall![1] as { opts: { pendingPrompt: string } }).opts.pendingPrompt
    expect(pendingPrompt).toContain('<ticket title="Goal ticket">')
    expect(pendingPrompt).toContain('Goal success criteria: Tests pass')
  })

  it('does not create a plan file for oversized prompts when goal mode is off', async () => {
    render(
      <WorktreePickerModal
        ticket={makeTicket({ description: LONG_DESCRIPTION })}
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSendComplete={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('sdk-toggle-claude-code-cli'))
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.any(Object))
    )
    expect(findRpcCall(request, 'fileOps.createFile')).toBeUndefined()
  })
})
