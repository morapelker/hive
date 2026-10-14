import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  launchSessionWithModel,
  launchTicketWithModel,
  type SessionLaunchSpec
} from './ticket-launch'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { opencodeApi } from '@/api/opencode-api'
import { toast } from '@/lib/toast'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { createSessionShellCommandSnapshot } from '@shared/lib/shell-commands'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
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
    error: vi.fn(),
    warning: vi.fn()
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

// The created session the mocked store returns — individual tests reassign this
// to control the badge-resolution source (session row vs. config vs. fallback).
let nextSession: Session

function setupStores(): {
  createSession: ReturnType<typeof vi.fn>
  createWorktreeFromBranch: ReturnType<typeof vi.fn>
  updateTicket: ReturnType<typeof vi.fn>
  setSessionModel: ReturnType<typeof vi.fn>
} {
  const createSession = vi.fn(async () => ({ success: true, session: nextSession }))
  const createWorktreeFromBranch = vi.fn(async () => ({
    success: true,
    worktree: makeWorktree()
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
    createWorktreeFromBranch
  })
  useKanbanStore.setState({ updateTicket })
  useSessionStore.setState({
    createSession,
    setSessionModel,
    setOpenCodeSessionId: vi.fn(),
    setSessionMode: vi.fn(async () => undefined),
    dequeuePendingMessage: vi.fn()
  })
  useWorktreeStatusStore.setState({
    setSessionStatus: vi.fn(),
    setLastMessageTime: vi.fn()
  })
  useUsageStore.setState({ fetchUsageForProvider: vi.fn() })

  return { createSession, createWorktreeFromBranch, updateTicket, setSessionModel }
}

function baseSpec(
  overrides: Record<string, unknown> = {}
): Parameters<typeof launchTicketWithModel>[0] {
  return {
    ticketId: 'ticket-1',
    projectId: 'project-1',
    ticketTitle: 'My Ticket Title',
    worktree: { type: 'existing', worktreeId: 'worktree-1' },
    prompt: 'Implement the ticket',
    mode: 'build',
    modelConfig: {
      sdk: 'claude-code-cli',
      model: { providerID: 'anthropic', modelID: 'opus', variant: 'high' },
      codexFastMode: false
    },
    goalMode: false,
    goalSuccessCriteria: null,
    ticketUpdateExtras: { pending_launch_config: null },
    ...overrides
  } as Parameters<typeof launchTicketWithModel>[0]
}

describe('launchTicketWithModel', () => {
  let request: ReturnType<typeof vi.fn>

  beforeAll(() => {
    // Absorb the useSettingsStore one-shot 200ms import timer so it cannot null
    // store state mid-test (see global constraints).
    return new Promise((resolve) => setTimeout(resolve, 220))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    request = vi.fn(async (method: string) => {
      if (method === 'terminalOps.createClaudeCli') return { success: true }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    nextSession = makeSession()
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

  it('refuses the ticket of a document run before creating anything', async () => {
    const { createSession, createWorktreeFromBranch, updateTicket } = setupStores()
    useKanbanStore.setState({
      tickets: new Map([
        ['project-1', [{ id: 'ticket-1', external_provider: 'document-run', external_id: 'run-1' }]]
      ]) as never
    })

    const result = await launchTicketWithModel(baseSpec())

    expect(result).toEqual({
      success: false,
      error: 'The ticket of a document run cannot be launched.'
    })
    expect(createSession).not.toHaveBeenCalled()
    expect(createWorktreeFromBranch).not.toHaveBeenCalled()
    expect(updateTicket).not.toHaveBeenCalled()
  })

  it('refuses a ticket from before the marker, known through its shell-command run', async () => {
    const { createSession, createWorktreeFromBranch, updateTicket } = setupStores()
    useKanbanStore.setState({
      tickets: new Map([
        ['project-1', [{ id: 'ticket-1', current_session_id: 's-legacy' }]]
      ]) as never
    })
    useShellCommandRunStore.setState({
      runsBySession: {
        's-legacy': createSessionShellCommandSnapshot({
          id: 'build',
          name: 'Build',
          commands: 'make'
        })
      }
    })

    try {
      const result = await launchTicketWithModel(
        baseSpec({ worktree: { type: 'new', sourceBranch: 'main' } })
      )

      expect(result).toEqual({
        success: false,
        error: expect.stringMatching(/shell command ticket/i)
      })
      expect(createWorktreeFromBranch).not.toHaveBeenCalled()
      expect(createSession).not.toHaveBeenCalled()
      expect(updateTicket).not.toHaveBeenCalled()
    } finally {
      useShellCommandRunStore.setState({ runsBySession: {} })
    }
  })

  it('refuses a shell command ticket before creating anything', async () => {
    const { createSession, createWorktreeFromBranch, updateTicket } = setupStores()
    useKanbanStore.setState({
      tickets: new Map([
        [
          'project-1',
          [{ id: 'ticket-1', external_provider: 'shell-command', external_id: 'build' }]
        ]
      ]) as never
    })

    // A new worktree is asked for: the refusal has to come before it is created.
    const result = await launchTicketWithModel(
      baseSpec({ worktree: { type: 'new', sourceBranch: 'main' } })
    )

    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/shell command ticket/i)
    })
    expect(createWorktreeFromBranch).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect(updateTicket).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(opencodeApi.connect).not.toHaveBeenCalled()
    expect(opencodeApi.prompt).not.toHaveBeenCalled()
  })

  it.each([
    ['an ordinary ticket', { id: 'ticket-1', external_provider: null, external_id: null }],
    // Only the provider marks a ticket: a command's id under another provider is just an id.
    ['an imported ticket', { id: 'ticket-1', external_provider: 'jira', external_id: 'build' }]
  ])('launches %s sitting next to a shell command ticket', async (_name, ticket) => {
    const { createSession, updateTicket } = setupStores()
    useKanbanStore.setState({
      tickets: new Map([
        [
          'project-1',
          [{ id: 'ticket-shell', external_provider: 'shell-command', external_id: 'build' }, ticket]
        ]
      ]) as never
    })

    const result = await launchTicketWithModel(baseSpec())

    expect(result).toEqual({ success: true, sessionId: 'session-1', worktreeId: 'worktree-1' })
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      expect.objectContaining({ current_session_id: 'session-1', worktree_id: 'worktree-1' })
    )
  })

  it('returns sessionId/worktreeId and stamps badge fields + extras on success', async () => {
    const { updateTicket } = setupStores()

    const result = await launchTicketWithModel(baseSpec())

    expect(result).toEqual({ success: true, sessionId: 'session-1', worktreeId: 'worktree-1' })
    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      expect.objectContaining({
        current_session_id: 'session-1',
        worktree_id: 'worktree-1',
        mode: 'build',
        model_provider_id: 'anthropic',
        model_id: 'opus',
        model_variant: 'high',
        // Default hygiene: a (re)launch through this shared pipeline clears
        // any stale variant_group_id unless extras override it (next test).
        variant_group_id: null,
        pending_launch_config: null
      })
    )
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("never asks session creation to skip the kanban attach: a ticket's session is the board's to attach", async () => {
    const { createSession } = setupStores()

    // Even a spec carrying the session-only flag does not get it through.
    await launchTicketWithModel(baseSpec())
    await launchTicketWithModel(baseSpec({ skipKanbanAttach: true }))

    expect(createSession).toHaveBeenCalledTimes(2)
    for (const call of createSession.mock.calls as unknown[][]) {
      expect(call[4]).toMatchObject({ autoFocus: false })
      expect(call[4]).not.toHaveProperty('skipKanbanAttach')
    }
  })

  it('lets ticketUpdateExtras.variant_group_id override the default null (extras win)', async () => {
    const { updateTicket } = setupStores()

    await launchTicketWithModel(
      baseSpec({
        ticketUpdateExtras: { pending_launch_config: null, variant_group_id: 'group-123' }
      })
    )

    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      expect.objectContaining({ variant_group_id: 'group-123' })
    )
  })

  it('returns {success:false} without creating a session when worktree creation fails', async () => {
    const createWorktreeFromBranch = vi.fn(async () => ({
      success: false,
      error: 'disk full'
    }))
    const createSession = vi.fn(async () => ({ success: true, session: nextSession }))
    useWorktreeStore.setState({ createWorktreeFromBranch })
    useSessionStore.setState({ createSession })

    const result = await launchTicketWithModel(
      baseSpec({ worktree: { type: 'new', sourceBranch: 'main' } })
    )

    expect(result).toEqual({ success: false, error: 'disk full' })
    expect(createSession).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('returns {success:false} with the resolved worktreeId when session creation fails', async () => {
    const createSession = vi.fn(async () => ({ success: false, error: 'no provider' }))
    useSessionStore.setState({ createSession })

    const result = await launchTicketWithModel(baseSpec())

    expect(result).toEqual({ success: false, error: 'no provider', worktreeId: 'worktree-1' })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('includes the created worktreeId when session creation fails after a NEW worktree was created (round 2)', async () => {
    // Without the id in the failure result, the just-created git worktree
    // would be invisible to callers — no ticket link ever gets stamped on
    // this path, so nothing else records that it exists.
    const createSession = vi.fn(async () => ({ success: false, error: 'no provider' }))
    useSessionStore.setState({ createSession })

    const result = await launchTicketWithModel(
      baseSpec({ worktree: { type: 'new', sourceBranch: 'main' } })
    )

    expect(result).toEqual({ success: false, error: 'no provider', worktreeId: 'worktree-1' })
  })

  it('returns {success:false} with the created sessionId/worktreeId when the OpenCode connect fails (Fix 5)', async () => {
    nextSession = makeSession({ agent_sdk: 'opencode' })
    setupStores()
    vi.mocked(opencodeApi.connect).mockResolvedValue({
      success: true,
      value: { success: false, error: 'connect refused' }
    })

    const result = await launchTicketWithModel(
      baseSpec({
        modelConfig: { sdk: 'opencode', model: null, codexFastMode: false }
      })
    )

    expect(result).toEqual({
      success: false,
      error: 'connect refused',
      sessionId: 'session-1',
      worktreeId: 'worktree-1'
    })
    expect(opencodeApi.prompt).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('returns {success:false, sessionId, worktreeId} when the OpenCode prompt result reports failure (round 2)', async () => {
    nextSession = makeSession({ agent_sdk: 'opencode' })
    setupStores()
    vi.mocked(opencodeApi.prompt).mockResolvedValue({
      success: true,
      value: { success: false, error: 'command bridge unavailable' }
    })

    const result = await launchTicketWithModel(
      baseSpec({
        modelConfig: { sdk: 'opencode', model: null, codexFastMode: false }
      })
    )

    expect(result).toEqual({
      success: false,
      error: 'command bridge unavailable',
      sessionId: 'session-1',
      worktreeId: 'worktree-1'
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('falls back to a default error message when the OpenCode prompt fails without one', async () => {
    nextSession = makeSession({ agent_sdk: 'opencode' })
    setupStores()
    vi.mocked(opencodeApi.prompt).mockResolvedValue({
      success: true,
      value: { success: false }
    })

    const result = await launchTicketWithModel(
      baseSpec({
        modelConfig: { sdk: 'opencode', model: null, codexFastMode: false }
      })
    )

    expect(result).toEqual({
      success: false,
      error: 'Could not send prompt',
      sessionId: 'session-1',
      worktreeId: 'worktree-1'
    })
  })

  it('returns success when the OpenCode prompt result succeeds', async () => {
    nextSession = makeSession({ agent_sdk: 'opencode' })
    setupStores()

    const result = await launchTicketWithModel(
      baseSpec({
        modelConfig: { sdk: 'opencode', model: null, codexFastMode: false }
      })
    )

    expect(result).toEqual({ success: true, sessionId: 'session-1', worktreeId: 'worktree-1' })
    expect(opencodeApi.prompt).toHaveBeenCalledTimes(1)
  })

  it('returns {success:false, sessionId, worktreeId} when the resolved worktree has no path (Fix 1)', async () => {
    nextSession = makeSession({ agent_sdk: 'opencode' })
    setupStores()
    // Worktree exists but carries no path — the pre-fix pipeline treated this
    // as a silent success without connecting or sending a prompt.
    useWorktreeStore.setState({
      worktreesByProject: new Map([['project-1', [makeWorktree({ path: '' })]]])
    })

    const result = await launchTicketWithModel(
      baseSpec({
        modelConfig: { sdk: 'opencode', model: null, codexFastMode: false }
      })
    )

    expect(result).toEqual({
      success: false,
      error: 'Worktree path not found',
      sessionId: 'session-1',
      worktreeId: 'worktree-1'
    })
    expect(opencodeApi.connect).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('returns {success:false, sessionId, worktreeId} when the claude-code-cli spawn RPC reports failure (Fix 2)', async () => {
    setupStores()
    request = vi.fn(async (method: string) => {
      if (method === 'terminalOps.createClaudeCli') {
        return { success: false, error: 'pty spawn failed' }
      }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    const result = await launchTicketWithModel(baseSpec())

    expect(result).toEqual({
      success: false,
      error: 'pty spawn failed',
      sessionId: 'session-1',
      worktreeId: 'worktree-1'
    })
    expect(useSessionStore.getState().dequeuePendingMessage).not.toHaveBeenCalled()
  })

  it('falls back to a default error message when the claude-code-cli spawn RPC fails without one', async () => {
    setupStores()
    request = vi.fn(async (method: string) => {
      if (method === 'terminalOps.createClaudeCli') return { success: false }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    const result = await launchTicketWithModel(baseSpec())

    expect(result).toEqual({
      success: false,
      error: 'Failed to start Claude CLI',
      sessionId: 'session-1',
      worktreeId: 'worktree-1'
    })
  })

  it('includes the created sessionId/worktreeId in the catch fallback when a later step throws (Fix 5)', async () => {
    setupStores()
    useSessionStore.setState({
      setSessionModel: vi.fn(async () => {
        throw new Error('model apply failed')
      })
    })

    const result = await launchTicketWithModel(baseSpec())

    expect(result).toEqual({
      success: false,
      error: 'model apply failed',
      sessionId: 'session-1',
      worktreeId: 'worktree-1'
    })
  })

  it('passes an explicit nameHint through to createWorktreeFromBranch', async () => {
    const { createWorktreeFromBranch } = setupStores()

    await launchTicketWithModel(
      baseSpec({ worktree: { type: 'new', sourceBranch: 'main', nameHint: 'custom-slug' } })
    )

    expect(createWorktreeFromBranch).toHaveBeenCalledWith(
      'project-1',
      '/repo',
      'Hive',
      'main',
      'custom-slug'
    )
  })

  it('falls back to the canonicalized ticket title when no nameHint is given', async () => {
    const { createWorktreeFromBranch } = setupStores()

    await launchTicketWithModel(baseSpec({ worktree: { type: 'new', sourceBranch: 'main' } }))

    expect(createWorktreeFromBranch).toHaveBeenCalledWith(
      'project-1',
      '/repo',
      'Hive',
      'main',
      'my-ticket-title'
    )
  })

  it('stamps badge from the session row when modelConfig.model is null', async () => {
    nextSession = makeSession({
      agent_sdk: 'opencode',
      model_provider_id: 'openai',
      model_id: 'gpt-5.5',
      model_variant: null
    })
    const { updateTicket } = setupStores()

    await launchTicketWithModel(
      baseSpec({ modelConfig: { sdk: 'opencode', model: null, codexFastMode: false } })
    )

    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      expect.objectContaining({
        model_provider_id: 'openai',
        model_id: 'gpt-5.5',
        model_variant: null
      })
    )
  })

  it('stamps badge from the resolution fallback when session row and modelConfig.model are null', async () => {
    // Session row carries no model, config carries no model → resolveModelForSdk
    // (null under empty settings) → FALLBACK_MODELS['codex'].
    useSettingsStore.setState({ selectedModel: null, selectedModelByProvider: {} })
    nextSession = makeSession({
      agent_sdk: 'codex',
      model_provider_id: null,
      model_id: null,
      model_variant: null
    })
    const { updateTicket } = setupStores()

    await launchTicketWithModel(
      baseSpec({ modelConfig: { sdk: 'codex', model: null, codexFastMode: false } })
    )

    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      expect.objectContaining({
        model_provider_id: 'codex',
        model_id: 'gpt-5.5',
        model_variant: null
      })
    )
  })
})

// The ticket-free half of the pipeline: what a caller without a ticket (a document run's
// migration session) launches with.
describe('launchSessionWithModel', () => {
  let request: ReturnType<typeof vi.fn>

  const sessionSpec = (overrides: Partial<SessionLaunchSpec> = {}): SessionLaunchSpec => ({
    projectId: 'project-1',
    worktreeId: 'worktree-2',
    prompt: 'Run the migrations',
    mode: 'build',
    modelConfig: {
      sdk: 'claude-code-cli',
      model: { providerID: 'anthropic', modelID: 'opus', variant: 'high' },
      codexFastMode: false
    },
    goalMode: false,
    goalSuccessCriteria: null,
    ...overrides
  })

  const SDK_CONFIG = { sdk: 'opencode', model: null, codexFastMode: false } as const

  /** Call order of the first call of `mock` that `matches`, to compare across mocks. */
  const orderOf = (
    mock: ReturnType<typeof vi.fn>,
    matches: (args: unknown[]) => boolean = () => true
  ): number => {
    const index = mock.mock.calls.findIndex(matches)
    expect(index).toBeGreaterThanOrEqual(0)
    return mock.mock.invocationCallOrder[index]
  }

  const cliSpawns = (): unknown[][] =>
    request.mock.calls.filter(([method]) => method === 'terminalOps.createClaudeCli')

  function setupSessionStores(): ReturnType<typeof setupStores> {
    const stores = setupStores()
    // Two worktrees, so the one the session lands in is the one that was asked for.
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'project-1',
          [makeWorktree(), makeWorktree({ id: 'worktree-2', path: '/repo/integration' })]
        ]
      ])
    })
    return stores
  }

  beforeAll(() => {
    // Absorb the useSettingsStore one-shot 200ms import timer so it cannot null
    // store state mid-test (see global constraints).
    return new Promise((resolve) => setTimeout(resolve, 220))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    request = vi.fn(async (method: string) => {
      if (method === 'terminalOps.createClaudeCli') return { success: true }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    nextSession = makeSession({ worktree_id: 'worktree-2' })
    setupSessionStores()
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

  it('creates the session in the given worktree, unfocused, with the model of the launch config', async () => {
    const { createSession, createWorktreeFromBranch, setSessionModel } = setupSessionStores()

    const result = await launchSessionWithModel(sessionSpec())

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledWith(
      'worktree-2',
      'project-1',
      'claude-code-cli',
      'build',
      {
        autoFocus: false,
        modelOverride: {
          providerID: 'anthropic',
          modelID: 'opus',
          variant: 'high',
          agentSdk: 'claude-code-cli'
        },
        pendingMessage: 'Run the migrations'
      }
    )
    expect(setSessionModel).toHaveBeenCalledWith('session-1', {
      providerID: 'anthropic',
      modelID: 'opus',
      variant: 'high'
    })
    // The worktree exists already: none is created for a session.
    expect(createWorktreeFromBranch).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('leaves the model to session creation when the launch config names none', async () => {
    nextSession = makeSession({ agent_sdk: 'opencode', worktree_id: 'worktree-2' })
    const { createSession, setSessionModel } = setupSessionStores()
    const onSessionCreated = vi.fn()

    await launchSessionWithModel(sessionSpec({ modelConfig: SDK_CONFIG, onSessionCreated }))

    expect(createSession).toHaveBeenCalledWith('worktree-2', 'project-1', 'opencode', 'build', {
      autoFocus: false
    })
    expect(setSessionModel).not.toHaveBeenCalled()
    expect(onSessionCreated).toHaveBeenCalledWith({
      session: nextSession,
      customProviderId: null,
      model: null
    })
  })

  it('asks session creation to skip the kanban attach when the caller says the session belongs to no ticket', async () => {
    const { createSession } = setupSessionStores()

    const result = await launchSessionWithModel(sessionSpec({ skipKanbanAttach: true }))

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledWith(
      'worktree-2',
      'project-1',
      'claude-code-cli',
      'build',
      {
        autoFocus: false,
        modelOverride: {
          providerID: 'anthropic',
          modelID: 'opus',
          variant: 'high',
          agentSdk: 'claude-code-cli'
        },
        pendingMessage: 'Run the migrations',
        skipKanbanAttach: true
      }
    )
    expect(result).toEqual({ success: true, sessionId: 'session-1' })
  })

  it('leaves skipKanbanAttach out of the session options unless the caller sets it', async () => {
    const { createSession } = setupSessionStores()

    await launchSessionWithModel(sessionSpec())
    await launchSessionWithModel(sessionSpec({ skipKanbanAttach: false }))
    nextSession = makeSession({ agent_sdk: 'opencode', worktree_id: 'worktree-2' })
    await launchSessionWithModel(sessionSpec({ modelConfig: SDK_CONFIG }))

    expect(createSession).toHaveBeenCalledTimes(3)
    // The key is absent, not merely falsy.
    for (const call of createSession.mock.calls as unknown[][]) {
      expect(call[4]).not.toHaveProperty('skipKanbanAttach')
    }
  })

  it('returns the session id and nothing about the worktree', async () => {
    const result = await launchSessionWithModel(sessionSpec())

    expect(result).toEqual({ success: true, sessionId: 'session-1' })
    expect(result).not.toHaveProperty('worktreeId')
  })

  it("never touches a ticket: linking the session is the caller's", async () => {
    const { updateTicket } = setupSessionStores()

    await launchSessionWithModel(sessionSpec())
    nextSession = makeSession({ agent_sdk: 'opencode', worktree_id: 'worktree-2' })
    await launchSessionWithModel(sessionSpec({ modelConfig: SDK_CONFIG }))

    expect(updateTicket).not.toHaveBeenCalled()
  })

  it('hands the created session to onSessionCreated once it is working, before the CLI is started', async () => {
    setupSessionStores()
    const setSessionStatus = vi.mocked(useWorktreeStatusStore.getState().setSessionStatus)
    const onSessionCreated = vi.fn(async () => {
      // Nothing runs yet when the caller links the session.
      expect(cliSpawns()).toEqual([])
    })

    const result = await launchSessionWithModel(sessionSpec({ onSessionCreated }))

    expect(result).toEqual({ success: true, sessionId: 'session-1' })
    expect(onSessionCreated).toHaveBeenCalledTimes(1)
    expect(onSessionCreated).toHaveBeenCalledWith({
      session: nextSession,
      customProviderId: null,
      model: { providerID: 'anthropic', modelID: 'opus', variant: 'high' }
    })
    expect(setSessionStatus).toHaveBeenCalledWith('session-1', 'working')
    expect(cliSpawns()).toEqual([
      [
        'terminalOps.createClaudeCli',
        { sessionId: 'session-1', opts: { pendingPrompt: 'Run the migrations' } }
      ]
    ])
    const created = orderOf(onSessionCreated)
    expect(orderOf(setSessionStatus)).toBeLessThan(created)
    expect(
      orderOf(request, ([method]) => method === 'terminalOps.createClaudeCli')
    ).toBeGreaterThan(created)
  })

  it('hands the created session to onSessionCreated before an SDK session is connected and prompted', async () => {
    nextSession = makeSession({ agent_sdk: 'opencode', worktree_id: 'worktree-2' })
    setupSessionStores()
    const setSessionStatus = vi.mocked(useWorktreeStatusStore.getState().setSessionStatus)
    const onSessionCreated = vi.fn(async () => {
      expect(opencodeApi.connect).not.toHaveBeenCalled()
      expect(opencodeApi.prompt).not.toHaveBeenCalled()
    })

    const result = await launchSessionWithModel(
      sessionSpec({ modelConfig: SDK_CONFIG, onSessionCreated })
    )

    expect(result).toEqual({ success: true, sessionId: 'session-1' })
    expect(onSessionCreated).toHaveBeenCalledTimes(1)
    // Connected in the checkout of the worktree that was asked for.
    expect(opencodeApi.connect).toHaveBeenCalledWith('/repo/integration', 'session-1')
    expect(opencodeApi.prompt).toHaveBeenCalledWith(
      '/repo/integration',
      'opc-1',
      [{ type: 'text', text: 'Run the migrations' }],
      undefined,
      undefined
    )
    const created = orderOf(onSessionCreated)
    expect(orderOf(setSessionStatus)).toBeLessThan(created)
    expect(orderOf(vi.mocked(opencodeApi.connect))).toBeGreaterThan(created)
    expect(orderOf(vi.mocked(opencodeApi.prompt))).toBeGreaterThan(created)
    expect(cliSpawns()).toEqual([])
  })

  it('fails the launch with the session id when onSessionCreated throws, and starts no CLI', async () => {
    const result = await launchSessionWithModel(
      sessionSpec({
        onSessionCreated: async () => {
          throw new Error('another session is at it')
        }
      })
    )

    expect(result).toEqual({
      success: false,
      error: 'another session is at it',
      sessionId: 'session-1'
    })
    expect(cliSpawns()).toEqual([])
    expect(useSessionStore.getState().dequeuePendingMessage).not.toHaveBeenCalled()
  })

  it('fails the launch with the session id when onSessionCreated throws, and prompts no SDK session', async () => {
    nextSession = makeSession({ agent_sdk: 'opencode', worktree_id: 'worktree-2' })
    setupSessionStores()

    const result = await launchSessionWithModel(
      sessionSpec({
        modelConfig: SDK_CONFIG,
        onSessionCreated: () => {
          throw new Error('another session is at it')
        }
      })
    )

    expect(result).toEqual({
      success: false,
      error: 'another session is at it',
      sessionId: 'session-1'
    })
    expect(opencodeApi.connect).not.toHaveBeenCalled()
    expect(opencodeApi.prompt).not.toHaveBeenCalled()
  })

  it('does not call onSessionCreated when the session could not be created', async () => {
    useSessionStore.setState({
      createSession: vi.fn(async () => ({ success: false, error: 'no provider' }))
    })
    const onSessionCreated = vi.fn()

    const result = await launchSessionWithModel(sessionSpec({ onSessionCreated }))

    expect(result).toEqual({ success: false, error: 'no provider' })
    expect(onSessionCreated).not.toHaveBeenCalled()
    expect(cliSpawns()).toEqual([])
  })

  it("loads the project's worktrees when the one asked for is not in the store yet", async () => {
    nextSession = makeSession({ agent_sdk: 'opencode', worktree_id: 'worktree-2' })
    setupSessionStores()
    const loadWorktrees = vi.fn(async () => {
      useWorktreeStore.setState({
        worktreesByProject: new Map([
          ['project-1', [makeWorktree({ id: 'worktree-2', path: '/repo/integration' })]]
        ])
      })
    })
    useWorktreeStore.setState({ worktreesByProject: new Map(), loadWorktrees })

    const result = await launchSessionWithModel(sessionSpec({ modelConfig: SDK_CONFIG }))

    expect(loadWorktrees).toHaveBeenCalledWith('project-1')
    expect(result).toEqual({ success: true, sessionId: 'session-1' })
    expect(opencodeApi.connect).toHaveBeenCalledWith('/repo/integration', 'session-1')
  })
})
