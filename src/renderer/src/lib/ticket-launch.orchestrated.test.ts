/**
 * A ticket its orchestrator will launch is launched by the run alone: the shared launch
 * pipeline refuses every other caller before it creates anything — a worktree, an instance, a
 * session — and only the run's own launch (`orchestrated`) goes through. The connection-project
 * entry refuses it the same way.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchTicketWithModel } from './ticket-launch'
import { launchTicketOnConnectionProject } from './connection-project-launch'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { connectionApi } from '@/api/connection-api'
import { opencodeApi } from '@/api/opencode-api'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { DocumentRunItem, DocumentRunStatus } from '@shared/types/document-flow'
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
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('@/api/opencode-api', () => ({
  opencodeApi: { connect: vi.fn(), prompt: vi.fn() }
}))
vi.mock('@/api/connection-api', () => ({
  connectionApi: { create: vi.fn(), get: vi.fn(), rename: vi.fn() }
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
const initialFlowState = useDocumentFlowStore.getState()

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
  attachments: '[]'
} as unknown as Worktree

const createSession = vi.fn()
const createWorktreeFromBranch = vi.fn()
const updateTicket = vi.fn()

/** `ticket-1` as an item of a run of project-1. */
function seedRun(status: DocumentRunStatus, item: Partial<DocumentRunItem> = {}): void {
  const detail = makeDetail(
    { id: 'run-1', project_id: 'project-1', title: 'Checkout', source_kind: 'tickets', status },
    [{ key: 'TD-7', ticket_id: 'ticket-1', ...item }]
  )
  useDocumentFlowStore.setState({ runsById: { 'run-1': detail } })
}

const spec = (
  overrides: Partial<Parameters<typeof launchTicketWithModel>[0]> = {}
): Parameters<typeof launchTicketWithModel>[0] => ({
  ticketId: 'ticket-1',
  projectId: 'project-1',
  ticketTitle: 'Checkout button',
  worktree: { type: 'new', sourceBranch: 'main' },
  prompt: 'Implement the ticket',
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

const REFUSAL =
  'TD-7 is part of the orchestrator “Checkout”: it launches when the run gets to it. Remove it from the orchestrator to launch it yourself.'

beforeAll(() => {
  // Absorb the useSettingsStore one-shot import timer (as ticket-launch.test.ts does)
  return new Promise((resolve) => setTimeout(resolve, 220))
})

beforeEach(() => {
  vi.clearAllMocks()
  setRendererRpcClient({
    request: vi.fn(async (method: string) =>
      method === 'terminalOps.createClaudeCli' ? { success: true } : null
    ),
    subscribe: vi.fn()
  } as never)
  createSession.mockResolvedValue({ success: true, session })
  createWorktreeFromBranch.mockResolvedValue({ success: true, worktree })
  updateTicket.mockResolvedValue(undefined)
  vi.mocked(opencodeApi.connect).mockResolvedValue({
    success: true,
    value: { success: true, sessionId: 'opc-1' }
  })
  vi.mocked(opencodeApi.prompt).mockResolvedValue({ success: true, value: { success: true } })
  useProjectStore.setState({
    projects: [
      { id: 'project-1', name: 'Shop', path: '/repo' },
      { id: 'saved-1', name: 'Linked', path: '', kind: 'connection', member_project_ids: '[]' }
    ] as never
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map([['project-1', [worktree]]]),
    createWorktreeFromBranch
  })
  useKanbanStore.setState({
    updateTicket,
    tickets: new Map([['project-1', [{ id: 'ticket-1', project_id: 'project-1' }]]]) as never
  })
  useSessionStore.setState({
    createSession,
    setSessionModel: vi.fn(async () => undefined),
    setOpenCodeSessionId: vi.fn(),
    setSessionMode: vi.fn(async () => undefined),
    dequeuePendingMessage: vi.fn()
  })
  useWorktreeStatusStore.setState({ setSessionStatus: vi.fn(), setLastMessageTime: vi.fn() })
  useUsageStore.setState({ fetchUsageForProvider: vi.fn() })
})

afterEach(() => {
  resetRendererRpcClientForTests()
  useSessionStore.setState(initialSessionState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useProjectStore.setState(initialProjectState, true)
  useUsageStore.setState(initialUsageState, true)
  useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
  useDocumentFlowStore.setState(initialFlowState, true)
})

describe('launchTicketWithModel and a ticket its run launches', () => {
  it.each(['preview', 'running', 'paused'] as const)(
    'refuses it before creating a worktree while the run is %s',
    async (status) => {
      seedRun(status)

      const result = await launchTicketWithModel(spec())

      expect(result).toEqual({ success: false, error: REFUSAL })
      expect(createWorktreeFromBranch).not.toHaveBeenCalled()
      expect(createSession).not.toHaveBeenCalled()
      expect(updateTicket).not.toHaveBeenCalled()
    }
  )

  it('refuses it before an instance is made for a connection launch', async () => {
    seedRun('running')

    const result = await launchTicketWithModel(
      spec({
        worktree: {
          type: 'connection-new',
          savedProjectId: 'saved-1',
          members: [],
          nameHint: 'checkout'
        }
      })
    )

    expect(result).toEqual({ success: false, error: REFUSAL })
    expect(connectionApi.create).not.toHaveBeenCalled()
  })

  it("launches it for the run's own launch", async () => {
    seedRun('running')

    const result = await launchTicketWithModel(spec({ orchestrated: true }))

    expect(result.success).toBe(true)
    expect(createWorktreeFromBranch).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('refuses anyone else while the run launches it, and lets the run itself through', async () => {
    // The run writes `launching` before it launches: until the session is on the ticket, a
    // second launch would still find the ticket free
    seedRun('running', { status: 'launching' })

    const refused = await launchTicketWithModel(spec())

    expect(refused).toEqual({
      success: false,
      error: 'TD-7 is being launched by the orchestrator “Checkout”.'
    })
    expect(createSession).not.toHaveBeenCalled()

    const result = await launchTicketWithModel(spec({ orchestrated: true }))

    expect(result.success).toBe(true)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('launches it once the run has launched it and it runs', async () => {
    seedRun('running', { status: 'running', session_id: 'session-1' })

    const result = await launchTicketWithModel(spec())

    expect(result.success).toBe(true)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('launches a ticket no run has', async () => {
    const result = await launchTicketWithModel(spec())

    expect(result.success).toBe(true)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it("names an orchestrator's own ticket as such when refusing to launch it", async () => {
    useKanbanStore.setState({
      tickets: new Map([
        ['project-1', [{ id: 'ticket-1', external_provider: 'document-run', external_id: 'run-1' }]]
      ]) as never
    })
    useDocumentFlowStore.setState({
      runsById: {
        'run-1': makeDetail({ id: 'run-1', source_kind: 'tickets', source_path: '' }, [])
      }
    })

    const result = await launchTicketWithModel(spec({ orchestrated: true }))

    expect(result).toEqual({
      success: false,
      error: 'The ticket of an orchestrator cannot be launched.'
    })
    expect(createSession).not.toHaveBeenCalled()
  })
})

describe('launchTicketOnConnectionProject and a ticket its run launches', () => {
  it('refuses it before an instance is resolved', async () => {
    seedRun('paused')

    const result = await launchTicketOnConnectionProject({
      ticket: { id: 'ticket-1', project_id: 'project-1', title: 'Checkout button' },
      savedProject: { id: 'saved-1', kind: 'connection', member_project_ids: '[]' },
      target: { type: 'new' },
      options: {
        mode: 'build',
        sdk: 'claude-code-cli',
        model: null,
        codexFastMode: false,
        promptText: 'Implement',
        goalMode: false,
        goalSuccessCriteria: null
      }
    })

    expect(result).toEqual({ success: false, error: REFUSAL })
    expect(connectionApi.create).not.toHaveBeenCalled()
    expect(connectionApi.get).not.toHaveBeenCalled()
  })
})
