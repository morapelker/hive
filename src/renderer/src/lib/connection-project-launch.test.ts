import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/connection-api', () => ({
  connectionApi: {
    create: vi.fn(),
    get: vi.fn(),
    rename: vi.fn()
  }
}))
vi.mock('@/api/worktree-api', () => ({
  worktreeApi: {
    createFromBranch: vi.fn(),
    delete: vi.fn()
  }
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))
vi.mock('@/lib/hive-enterprise-telemetry', () => ({
  startHivePromptTelemetry: vi.fn()
}))

import { connectionApi } from '@/api/connection-api'
import { worktreeApi } from '@/api/worktree-api'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import {
  createInstanceWithNewWorktrees,
  resolveConnectionForLaunch,
  startSessionOnConnection,
  startTicketSessionOnConnectionInstance
} from './connection-project-launch'
import type { WorktreeNameSet } from './connection-project'

const SAVED_ID = 'saved-project-1'

const makeConnection = (
  id: string,
  worktreeIds: string[],
  savedProjectId: string | null = SAVED_ID
) =>
  ({
    id,
    name: 'a + b',
    custom_name: null,
    status: 'active' as const,
    path: `/tmp/connections/${id}`,
    color: null,
    saved_project_id: savedProjectId,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    members: worktreeIds.map((worktreeId, i) => ({
      id: `m-${id}-${i}`,
      connection_id: id,
      worktree_id: worktreeId,
      project_id: `p${i}`,
      symlink_name: `p${i}`,
      added_at: '2026-01-01',
      worktree_name: 'wt',
      worktree_branch: 'wt',
      worktree_path: `/tmp/wt/${worktreeId}`,
      project_name: `p${i}`
    }))
  }) as never

const memberProjects = [
  { id: 'pa', path: '/tmp/alpha', name: 'alpha' },
  { id: 'pb', path: '/tmp/beta', name: 'beta' }
]

const makeWorktree = (
  id: string,
  projectId: string,
  name: string,
  extra: Record<string, unknown> = {}
) =>
  ({
    id,
    project_id: projectId,
    name,
    branch_name: name,
    path: `/tmp/wt/${projectId}/${name}`,
    status: 'active',
    is_default: false,
    ...extra
  }) as never

describe('resolveConnectionForLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useConnectionStore.setState({ connections: [] })
    useWorktreeStore.setState({ worktreesByProject: new Map() })
  })

  it('existing-connection target returns the live instance without creating anything', async () => {
    useConnectionStore.setState({ connections: [makeConnection('conn-1', ['w1', 'w2'])] })

    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects,
      target: { type: 'existing-connection', connectionId: 'conn-1' }
    })

    expect(result).toEqual({ connectionId: 'conn-1', connectionPath: '/tmp/connections/conn-1' })
    expect(connectionApi.create).not.toHaveBeenCalled()
  })

  it('name-set target reuses an instance whose worktree set matches exactly', async () => {
    useConnectionStore.setState({
      connections: [
        makeConnection('other', ['w1', 'w2'], null), // ad-hoc — never reused
        makeConnection('inst', ['w1', 'w2'])
      ]
    })
    const nameSet: WorktreeNameSet = {
      name: 'ticket-x',
      worktrees: [
        { projectId: 'pa', worktreeId: 'w1', worktreePath: '/tmp/wt/pa/ticket-x' },
        { projectId: 'pb', worktreeId: 'w2', worktreePath: '/tmp/wt/pb/ticket-x' }
      ]
    }

    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects,
      target: { type: 'name-set', nameSet }
    })

    expect(result.connectionId).toBe('inst')
    expect(connectionApi.create).not.toHaveBeenCalled()
  })

  it('name-set target creates a linked connection when no instance matches', async () => {
    vi.mocked(connectionApi.create).mockResolvedValue({
      success: true,
      connection: makeConnection('fresh', ['w1', 'w2'])
    } as never)

    const nameSet: WorktreeNameSet = {
      name: 'ticket-x',
      worktrees: [
        { projectId: 'pa', worktreeId: 'w1', worktreePath: '/tmp/wt/pa/ticket-x' },
        { projectId: 'pb', worktreeId: 'w2', worktreePath: '/tmp/wt/pb/ticket-x' }
      ]
    }

    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects,
      target: { type: 'name-set', nameSet }
    })

    expect(connectionApi.create).toHaveBeenCalledExactlyOnceWith(['w1', 'w2'], {
      savedProjectId: SAVED_ID
    })
    expect(result.connectionId).toBe('fresh')
    // Inserted into the store without selection
    expect(useConnectionStore.getState().connections.some((c) => c.id === 'fresh')).toBe(true)
    expect(useConnectionStore.getState().selectedConnectionId).not.toBe('fresh')
  })

  it('new target creates a worktree per member off its default branch, then connects them', async () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        ['pa', [makeWorktree('da', 'pa', 'main', { is_default: true, branch_name: 'main' })]],
        ['pb', [makeWorktree('db', 'pb', 'develop', { is_default: true, branch_name: 'develop' })]]
      ])
    })
    const loadWorktrees = vi.fn().mockResolvedValue(undefined)
    useWorktreeStore.setState({ loadWorktrees } as never)

    vi.mocked(worktreeApi.createFromBranch)
      .mockResolvedValueOnce({
        success: true,
        worktree: makeWorktree('na', 'pa', 'ticket-x')
      } as never)
      .mockResolvedValueOnce({
        success: true,
        worktree: makeWorktree('nb', 'pb', 'ticket-x')
      } as never)
    vi.mocked(connectionApi.create).mockResolvedValue({
      success: true,
      connection: makeConnection('inst-new', ['na', 'nb'])
    } as never)

    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects,
      target: { type: 'new' },
      nameHint: 'ticket-x'
    })

    expect(worktreeApi.createFromBranch).toHaveBeenNthCalledWith(1, {
      projectId: 'pa',
      projectPath: '/tmp/alpha',
      projectName: 'alpha',
      branchName: 'main',
      nameHint: 'ticket-x'
    })
    expect(worktreeApi.createFromBranch).toHaveBeenNthCalledWith(2, {
      projectId: 'pb',
      projectPath: '/tmp/beta',
      projectName: 'beta',
      branchName: 'develop',
      nameHint: 'ticket-x'
    })
    expect(connectionApi.create).toHaveBeenCalledExactlyOnceWith(['na', 'nb'], {
      savedProjectId: SAVED_ID
    })
    expect(result.connectionId).toBe('inst-new')
  })

  it('new target rolls back already-created worktrees when a later create fails', async () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        ['pa', [makeWorktree('da', 'pa', 'main', { is_default: true, branch_name: 'main' })]],
        ['pb', [makeWorktree('db', 'pb', 'main', { is_default: true, branch_name: 'main' })]]
      ]),
      loadWorktrees: vi.fn().mockResolvedValue(undefined) as never
    })

    const createdWorktree = makeWorktree('na', 'pa', 'ticket-x') as { id: string; path: string }
    vi.mocked(worktreeApi.createFromBranch)
      .mockResolvedValueOnce({ success: true, worktree: createdWorktree } as never)
      .mockResolvedValueOnce({ success: false, error: 'boom' } as never)
    vi.mocked(worktreeApi.delete).mockResolvedValue({ success: true } as never)

    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects,
      target: { type: 'new' },
      nameHint: 'ticket-x'
    })

    expect(result.connectionId).toBeUndefined()
    expect(result.error).toContain('beta')
    expect(worktreeApi.delete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ worktreeId: 'na', archive: false })
    )
    expect(connectionApi.create).not.toHaveBeenCalled()
  })

  it('new target fails fast with fewer than 2 member projects', async () => {
    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects: [memberProjects[0]],
      target: { type: 'new' }
    })
    expect(result.error).toMatch(/at least 2/)
    expect(worktreeApi.createFromBranch).not.toHaveBeenCalled()
  })

  describe('with per-member specs (a document run)', () => {
    beforeEach(() => {
      useWorktreeStore.setState({
        worktreesByProject: new Map([
          ['pa', [makeWorktree('da', 'pa', 'main', { is_default: true, branch_name: 'main' })]],
          ['pb', [makeWorktree('db', 'pb', 'main', { is_default: true, branch_name: 'main' })]]
        ]),
        loadWorktrees: vi.fn().mockResolvedValue(undefined) as never
      })
      vi.mocked(worktreeApi.createFromBranch)
        .mockResolvedValueOnce({
          success: true,
          worktree: makeWorktree('na', 'pa', 'a2-ramp-up-rule')
        } as never)
        .mockResolvedValueOnce({
          success: true,
          worktree: makeWorktree('nb', 'pb', 'a2-ramp-up-rule-2')
        } as never)
      vi.mocked(connectionApi.create).mockResolvedValue({
        success: true,
        connection: makeConnection('inst-run', ['na', 'nb'])
      } as never)
    })

    it('cuts each member from its own branch and base ref, without auto-pull, and reports the worktrees', async () => {
      const result = await resolveConnectionForLaunch({
        savedProjectId: SAVED_ID,
        memberProjects,
        target: { type: 'new' },
        nameHint: 'a2-ramp-up-rule',
        members: [
          { projectId: 'pa', sourceBranch: 'main', baseRef: 'sha-a', autoPull: false },
          { projectId: 'pb', sourceBranch: 'develop', baseRef: 'sha-b', autoPull: false }
        ]
      })

      expect(worktreeApi.createFromBranch).toHaveBeenNthCalledWith(1, {
        projectId: 'pa',
        projectPath: '/tmp/alpha',
        projectName: 'alpha',
        branchName: 'main',
        nameHint: 'a2-ramp-up-rule',
        autoPull: false,
        baseRef: 'sha-a'
      })
      expect(worktreeApi.createFromBranch).toHaveBeenNthCalledWith(2, {
        projectId: 'pb',
        projectPath: '/tmp/beta',
        projectName: 'beta',
        // The spec's branch, not the member's default.
        branchName: 'develop',
        nameHint: 'a2-ramp-up-rule',
        autoPull: false,
        baseRef: 'sha-b'
      })
      expect(result).toEqual({
        connectionId: 'inst-run',
        connectionPath: '/tmp/connections/inst-run',
        worktrees: [
          {
            projectId: 'pa',
            worktreeId: 'na',
            branchName: 'a2-ramp-up-rule',
            path: '/tmp/wt/pa/a2-ramp-up-rule'
          },
          {
            projectId: 'pb',
            worktreeId: 'nb',
            branchName: 'a2-ramp-up-rule-2',
            path: '/tmp/wt/pb/a2-ramp-up-rule-2'
          }
        ]
      })
    })

    it('follows the specs’ member order and falls back to the default branch for a spec without one', async () => {
      await createInstanceWithNewWorktrees({
        savedProjectId: SAVED_ID,
        memberProjects,
        nameHint: 'x',
        members: [{ projectId: 'pb', baseRef: 'sha-b' }, { projectId: 'pa' }]
      })

      expect(worktreeApi.createFromBranch).toHaveBeenNthCalledWith(1, {
        projectId: 'pb',
        projectPath: '/tmp/beta',
        projectName: 'beta',
        branchName: 'main',
        nameHint: 'x',
        baseRef: 'sha-b'
      })
      expect(worktreeApi.createFromBranch).toHaveBeenNthCalledWith(2, {
        projectId: 'pa',
        projectPath: '/tmp/alpha',
        projectName: 'alpha',
        branchName: 'main',
        nameHint: 'x'
      })
      expect(connectionApi.create).toHaveBeenCalledExactlyOnceWith(['na', 'nb'], {
        savedProjectId: SAVED_ID
      })
    })

    it('fails before creating anything when a spec names a project that is not a member', async () => {
      const result = await createInstanceWithNewWorktrees({
        savedProjectId: SAVED_ID,
        memberProjects,
        nameHint: 'x',
        members: [{ projectId: 'pa' }, { projectId: 'gone' }]
      })

      expect(result.error).toContain('gone')
      expect(worktreeApi.createFromBranch).not.toHaveBeenCalled()
      expect(connectionApi.create).not.toHaveBeenCalled()
    })
  })
})

describe('startSessionOnConnection', () => {
  const initialSessionState = useSessionStore.getState()
  const initialStatusState = useWorktreeStatusStore.getState()
  const initialUsageState = useUsageStore.getState()
  let createConnectionSession: ReturnType<typeof vi.fn>
  let updateSessionName: ReturnType<typeof vi.fn>
  let setSessionModel: ReturnType<typeof vi.fn>
  let request: ReturnType<typeof vi.fn>

  const session = {
    id: 'session-1',
    worktree_id: null,
    project_id: SAVED_ID,
    connection_id: 'conn-1',
    name: 'Session 1',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'opus',
    model_variant: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    completed_at: null
  }

  const args = {
    connectionId: 'conn-1',
    connectionPath: '/tmp/connections/conn-1',
    sdk: 'claude-code-cli' as const,
    model: { providerID: 'anthropic', modelID: 'opus' },
    codexFastMode: false,
    customProviderId: 'provider-1',
    mode: 'build' as const,
    promptText: 'execute the migrations',
    goalMode: false,
    goalSuccessCriteria: null
  }

  beforeEach(() => {
    createConnectionSession = vi.fn(async () => ({ success: true, session }))
    updateSessionName = vi.fn(async () => true)
    setSessionModel = vi.fn(async () => undefined)
    useSessionStore.setState({
      createConnectionSession,
      updateSessionName,
      setSessionModel,
      dequeuePendingMessage: vi.fn(),
      setSessionMode: vi.fn(async () => undefined)
    } as never)
    useWorktreeStatusStore.setState({
      setSessionStatus: vi.fn(),
      setLastMessageTime: vi.fn()
    } as never)
    useUsageStore.setState({ fetchUsageForProvider: vi.fn() } as never)
    request = vi.fn(async (method: string) =>
      method === 'terminalOps.createClaudeCli' ? { success: true } : null
    )
    resetRendererRpcClientForTests()
    setRendererRpcClient({ request, subscribe: vi.fn() })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStatusStore.setState(initialStatusState, true)
    useUsageStore.setState(initialUsageState, true)
  })

  it('creates a CLI session with the prompt pending and the custom provider, names it, and starts the CLI after the caller’s hook', async () => {
    const order: string[] = []
    updateSessionName.mockImplementation(async () => {
      order.push('named')
      return true
    })
    request.mockImplementation(async (method: string) => {
      order.push(method)
      return { success: true }
    })
    const onSessionCreated = vi.fn(() => {
      order.push('hook')
    })

    const result = await startSessionOnConnection({
      ...args,
      sessionName: 'Migrations — doc-checkout',
      onSessionCreated
    })

    expect(createConnectionSession).toHaveBeenCalledExactlyOnceWith(
      'conn-1',
      'claude-code-cli',
      'build',
      {
        autoFocus: false,
        modelOverride: { providerID: 'anthropic', modelID: 'opus', agentSdk: 'claude-code-cli' },
        pendingMessage: 'execute the migrations',
        customProviderId: 'provider-1'
      }
    )
    expect(setSessionModel).toHaveBeenCalledWith('session-1', args.model)
    expect(onSessionCreated).toHaveBeenCalledWith(session)
    expect(useWorktreeStatusStore.getState().setSessionStatus).toHaveBeenCalledWith(
      'session-1',
      'working'
    )
    expect(order).toEqual(['named', 'hook', 'terminalOps.createClaudeCli'])
    expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', {
      sessionId: 'session-1',
      opts: { pendingPrompt: 'execute the migrations' }
    })
    expect(result).toEqual({ success: true, sessionId: 'session-1' })
  })

  it('reports a session that could not be created', async () => {
    createConnectionSession.mockResolvedValue({
      success: false,
      error: 'Connection has no members'
    })

    await expect(startSessionOnConnection(args)).resolves.toEqual({
      success: false,
      error: 'Connection has no members'
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('fails the launch with the session id when the caller’s hook throws, before the agent starts', async () => {
    const result = await startSessionOnConnection({
      ...args,
      onSessionCreated: () => {
        throw new Error('another session is already at it')
      }
    })

    expect(result).toEqual({
      success: false,
      sessionId: 'session-1',
      error: 'another session is already at it'
    })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('startTicketSessionOnConnectionInstance', () => {
  const initialSessionState = useSessionStore.getState()
  const initialStatusState = useWorktreeStatusStore.getState()
  const initialUsageState = useUsageStore.getState()
  const initialKanbanState = useKanbanStore.getState()
  const initialConnectionState = useConnectionStore.getState()
  const renameConnection = vi.fn(async () => undefined)
  const updateTicket = vi.fn(async () => undefined)

  const start = (extra: Record<string, unknown>): ReturnType<typeof startTicketSessionOnConnectionInstance> =>
    startTicketSessionOnConnectionInstance({
      ticket: { id: 'ticket-1', project_id: SAVED_ID, title: 'Manual steps — Shop' },
      savedProjectId: SAVED_ID,
      connectionId: 'conn-1',
      connectionPath: '/tmp/connections/conn-1',
      options: {
        mode: 'build',
        sdk: 'claude-code-cli',
        model: { providerID: 'anthropic', modelID: 'opus' },
        codexFastMode: false,
        promptText: 'do the steps',
        goalMode: false,
        goalSuccessCriteria: null,
        headless: true,
        ...extra
      }
    })

  beforeEach(() => {
    vi.clearAllMocks()
    useConnectionStore.setState({
      connections: [makeConnection('conn-1', ['w1', 'w2'])],
      renameConnection
    } as never)
    useKanbanStore.setState({
      tickets: new Map(),
      updateTicket,
      computeSortOrder: () => 3,
      getTicketsByColumn: () => []
    } as never)
    useSessionStore.setState({
      createConnectionSession: vi.fn(async () => ({
        success: true,
        session: { id: 'session-1', agent_sdk: 'claude-code-cli', mode: 'build' }
      })),
      updateSessionName: vi.fn(async () => true),
      setSessionModel: vi.fn(async () => undefined),
      dequeuePendingMessage: vi.fn(),
      setSessionMode: vi.fn(async () => undefined)
    } as never)
    useWorktreeStatusStore.setState({
      setSessionStatus: vi.fn(),
      setLastMessageTime: vi.fn()
    } as never)
    useUsageStore.setState({ fetchUsageForProvider: vi.fn() } as never)
    resetRendererRpcClientForTests()
    setRendererRpcClient({
      request: vi.fn(async (method: string) =>
        method === 'terminalOps.createClaudeCli' ? { success: true } : null
      ) as never,
      subscribe: vi.fn()
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStatusStore.setState(initialStatusState, true)
    useUsageStore.setState(initialUsageState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useConnectionStore.setState(initialConnectionState, true)
  })

  it('names the instance after the ticket by default', async () => {
    await start({})
    expect(renameConnection).toHaveBeenCalledExactlyOnceWith('conn-1', 'Manual steps — Shop')
  })

  it('leaves the instance’s name alone when asked', async () => {
    const result = await start({ keepInstanceName: true })

    expect(result).toMatchObject({ success: true, sessionId: 'session-1', connectionId: 'conn-1' })
    expect(renameConnection).not.toHaveBeenCalled()
  })

  it('links the ticket to its session on the saved project’s board, without a worktree', async () => {
    await start({ keepInstanceName: true })

    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-1',
      SAVED_ID,
      expect.objectContaining({
        current_session_id: 'session-1',
        worktree_id: null,
        column: 'in_progress',
        mode: 'build'
      })
    )
  })
})
