import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchSessionOnConnection, launchTicketWithModel } from './ticket-launch'
import { useProjectStore } from '@/stores/useProjectStore'
import { useKanbanStore } from '@/stores/useKanbanStore'

// The connection variants of a ticket launch are handed to lib/connection-project-launch;
// this checks what they are handed and what comes back, with that module faked.

const mocks = vi.hoisted(() => ({
  createInstanceWithNewWorktrees: vi.fn(),
  resolveConnectionForLaunch: vi.fn(),
  startTicketSessionOnConnectionInstance: vi.fn(),
  startSessionOnConnection: vi.fn()
}))

vi.mock('@/lib/connection-project-launch', () => mocks)
vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

const initialProjectState = useProjectStore.getState()
const initialKanbanState = useKanbanStore.getState()

const SAVED = 'proj-conn'

const project = {
  id: SAVED,
  name: 'Shop',
  path: '/connections/shop',
  kind: 'connection' as const,
  member_project_ids: JSON.stringify(['pa', 'pb']),
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
const members = [
  {
    ...project,
    id: 'pa',
    name: 'Alpha',
    path: '/repo/alpha',
    kind: 'git' as const,
    member_project_ids: null
  },
  {
    ...project,
    id: 'pb',
    name: 'Beta',
    path: '/repo/beta',
    kind: 'git' as const,
    member_project_ids: null
  }
]

const modelConfig = {
  sdk: 'claude-code-cli' as const,
  model: { providerID: 'anthropic', modelID: 'opus' },
  codexFastMode: false,
  customProviderId: null
}

const spec = {
  ticketId: 'ticket-1',
  projectId: SAVED,
  ticketTitle: 'A2 Ramp-up rule',
  prompt: 'implement task A2',
  mode: 'build' as const,
  modelConfig,
  goalMode: false,
  goalSuccessCriteria: null,
  ticketUpdateExtras: { column: 'in_progress' as const, sort_order: -1 }
}

beforeEach(() => {
  useProjectStore.setState({ projects: [project, ...members] as never })
  useKanbanStore.setState({ tickets: new Map() })
  mocks.startTicketSessionOnConnectionInstance.mockResolvedValue({
    success: true,
    sessionId: 'session-1',
    connectionId: 'conn-1'
  })
})

afterEach(() => {
  vi.resetAllMocks()
  useProjectStore.setState(initialProjectState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('launchTicketWithModel on a connection project', () => {
  it('creates the instance with each member cut from its base ref, then starts the ticket session on it', async () => {
    mocks.createInstanceWithNewWorktrees.mockResolvedValue({
      connectionId: 'conn-1',
      connectionPath: '/connections/conn-1',
      worktrees: [
        { projectId: 'pa', worktreeId: 'wa', branchName: 'a2-ramp-up-rule', path: '/w/a' },
        { projectId: 'pb', worktreeId: 'wb', branchName: 'a2-ramp-up-rule-2', path: '/w/b' }
      ]
    })

    const result = await launchTicketWithModel({
      ...spec,
      worktree: {
        type: 'connection-new',
        savedProjectId: SAVED,
        members: [
          { projectId: 'pa', sourceBranch: 'main', baseRef: 'sha-a' },
          { projectId: 'pb', sourceBranch: 'develop', baseRef: 'sha-b' }
        ],
        nameHint: 'a2-ramp-up-rule'
      }
    })

    expect(mocks.createInstanceWithNewWorktrees).toHaveBeenCalledExactlyOnceWith({
      savedProjectId: SAVED,
      memberProjects: [
        { id: 'pa', path: '/repo/alpha', name: 'Alpha' },
        { id: 'pb', path: '/repo/beta', name: 'Beta' }
      ],
      nameHint: 'a2-ramp-up-rule',
      members: [
        { projectId: 'pa', sourceBranch: 'main', baseRef: 'sha-a', autoPull: false },
        { projectId: 'pb', sourceBranch: 'develop', baseRef: 'sha-b', autoPull: false }
      ]
    })
    expect(mocks.startTicketSessionOnConnectionInstance).toHaveBeenCalledExactlyOnceWith({
      ticket: { id: 'ticket-1', project_id: SAVED, title: 'A2 Ramp-up rule' },
      savedProjectId: SAVED,
      connectionId: 'conn-1',
      connectionPath: '/connections/conn-1',
      options: {
        mode: 'build',
        sdk: 'claude-code-cli',
        model: modelConfig.model,
        codexFastMode: false,
        customProviderId: null,
        promptText: 'implement task A2',
        goalMode: false,
        goalSuccessCriteria: null,
        headless: true
      },
      ticketUpdateExtras: spec.ticketUpdateExtras
    })
    expect(result).toEqual({
      success: true,
      sessionId: 'session-1',
      connectionId: 'conn-1',
      // The real branch names, as the rows record them.
      worktrees: [
        { projectId: 'pa', worktreeId: 'wa', branchName: 'a2-ramp-up-rule' },
        { projectId: 'pb', worktreeId: 'wb', branchName: 'a2-ramp-up-rule-2' }
      ]
    })
    expect(mocks.resolveConnectionForLaunch).not.toHaveBeenCalled()
  })

  it('reports a failed instance creation without starting a session', async () => {
    mocks.createInstanceWithNewWorktrees.mockResolvedValue({
      error: 'Failed to create worktree in "Beta": boom'
    })

    const result = await launchTicketWithModel({
      ...spec,
      worktree: {
        type: 'connection-new',
        savedProjectId: SAVED,
        members: [{ projectId: 'pa', sourceBranch: 'main', baseRef: 'sha-a' }],
        nameHint: 'x'
      }
    })

    expect(result).toEqual({ success: false, error: 'Failed to create worktree in "Beta": boom' })
    expect(mocks.startTicketSessionOnConnectionInstance).not.toHaveBeenCalled()
  })

  it('keeps the instance on a session failure, so the caller can see what was created', async () => {
    mocks.createInstanceWithNewWorktrees.mockResolvedValue({
      connectionId: 'conn-1',
      connectionPath: '/connections/conn-1',
      worktrees: [{ projectId: 'pa', worktreeId: 'wa', branchName: 'x', path: '/w/a' }]
    })
    mocks.startTicketSessionOnConnectionInstance.mockResolvedValue({
      success: false,
      error: 'Failed to create session',
      connectionId: 'conn-1'
    })

    const result = await launchTicketWithModel({
      ...spec,
      worktree: {
        type: 'connection-new',
        savedProjectId: SAVED,
        members: [{ projectId: 'pa', sourceBranch: 'main', baseRef: 'sha-a' }],
        nameHint: 'x'
      }
    })

    expect(result).toEqual({
      success: false,
      error: 'Failed to create session',
      connectionId: 'conn-1',
      worktrees: [{ projectId: 'pa', worktreeId: 'wa', branchName: 'x' }]
    })
  })

  it('starts a session on an existing instance without creating anything', async () => {
    mocks.resolveConnectionForLaunch.mockResolvedValue({
      connectionId: 'conn-int',
      connectionPath: '/connections/conn-int'
    })

    const result = await launchTicketWithModel({
      ...spec,
      worktree: { type: 'existing-connection', connectionId: 'conn-int' }
    })

    expect(mocks.resolveConnectionForLaunch).toHaveBeenCalledExactlyOnceWith({
      savedProjectId: SAVED,
      memberProjects: expect.any(Array),
      target: { type: 'existing-connection', connectionId: 'conn-int' }
    })
    expect(mocks.createInstanceWithNewWorktrees).not.toHaveBeenCalled()
    expect(mocks.startTicketSessionOnConnectionInstance).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-int', connectionPath: '/connections/conn-int' })
    )
    expect(result).toEqual({ success: true, sessionId: 'session-1', connectionId: 'conn-int' })
  })

  it('tells the instance to keep its name when asked', async () => {
    mocks.resolveConnectionForLaunch.mockResolvedValue({
      connectionId: 'conn-int',
      connectionPath: '/connections/conn-int'
    })

    await launchTicketWithModel({
      ...spec,
      worktree: { type: 'existing-connection', connectionId: 'conn-int' },
      keepInstanceName: true
    })

    expect(mocks.startTicketSessionOnConnectionInstance.mock.calls[0][0].options).toMatchObject({
      keepInstanceName: true
    })
  })

  it('leaves the instance’s naming as it was for every other launch', async () => {
    mocks.resolveConnectionForLaunch.mockResolvedValue({
      connectionId: 'conn-int',
      connectionPath: '/connections/conn-int'
    })

    await launchTicketWithModel({
      ...spec,
      worktree: { type: 'existing-connection', connectionId: 'conn-int' }
    })

    const { options } = mocks.startTicketSessionOnConnectionInstance.mock.calls[0][0]
    expect(options).not.toHaveProperty('keepInstanceName')
  })

  it('fails when the saved project is not in the store', async () => {
    useProjectStore.setState({ projects: [] })

    const result = await launchTicketWithModel({
      ...spec,
      worktree: { type: 'existing-connection', connectionId: 'conn-int' }
    })

    expect(result).toEqual({ success: false, error: 'Project not found' })
    expect(mocks.resolveConnectionForLaunch).not.toHaveBeenCalled()
  })
})

describe('launchSessionOnConnection', () => {
  it('starts a ticketless session on the instance and hands the created session to the caller', async () => {
    const session = { id: 'session-9', agent_sdk: 'claude-code-cli' }
    mocks.startSessionOnConnection.mockImplementation(async (args) => {
      await args.onSessionCreated?.(session)
      return { success: true, sessionId: 'session-9' }
    })
    const onSessionCreated = vi.fn()

    const result = await launchSessionOnConnection({
      connectionId: 'conn-int',
      connectionPath: '/connections/conn-int',
      prompt: 'execute the migrations',
      mode: 'build',
      modelConfig,
      goalMode: false,
      goalSuccessCriteria: null,
      sessionName: 'Migrations — doc-checkout',
      onSessionCreated
    })

    expect(mocks.startSessionOnConnection).toHaveBeenCalledExactlyOnceWith({
      connectionId: 'conn-int',
      connectionPath: '/connections/conn-int',
      sdk: 'claude-code-cli',
      model: modelConfig.model,
      codexFastMode: false,
      customProviderId: null,
      mode: 'build',
      promptText: 'execute the migrations',
      goalMode: false,
      goalSuccessCriteria: null,
      sessionName: 'Migrations — doc-checkout',
      onSessionCreated: expect.any(Function)
    })
    expect(onSessionCreated).toHaveBeenCalledWith({
      session,
      customProviderId: null,
      model: modelConfig.model
    })
    expect(result).toEqual({ success: true, sessionId: 'session-9' })
  })

  it('returns a thrown failure as a result instead of rejecting', async () => {
    mocks.startSessionOnConnection.mockRejectedValue(new Error('no such instance'))

    await expect(
      launchSessionOnConnection({
        connectionId: 'conn-int',
        connectionPath: null,
        prompt: 'x',
        mode: 'build',
        modelConfig,
        goalMode: false,
        goalSuccessCriteria: null
      })
    ).resolves.toEqual({ success: false, error: 'no such instance' })
  })
})
