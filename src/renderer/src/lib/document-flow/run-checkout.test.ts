import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRunLaunchConfig, DocumentRunMember } from '@shared/types/document-flow'
import { launchTicketOnCheckout, runBranchTarget, type RunCheckout } from './run-checkout'

const mocks = vi.hoisted(() => ({
  launchTicketWithModel: vi.fn(),
  discardSession: vi.fn(),
  resetTicketToTodo: vi.fn(),
  computeSortOrder: vi.fn(() => 7),
  getTicketsByColumn: vi.fn(() => [])
}))

vi.mock('@/lib/ticket-launch', () => ({ launchTicketWithModel: mocks.launchTicketWithModel }))
vi.mock('./migrations', () => ({ discardSession: mocks.discardSession }))
vi.mock('./runner-ports', () => ({ resetTicketToTodo: mocks.resetTicketToTodo }))
vi.mock('@/stores/useKanbanStore', () => ({
  useKanbanStore: {
    getState: () => ({
      computeSortOrder: mocks.computeSortOrder,
      getTicketsByColumn: mocks.getTicketsByColumn
    })
  }
}))

const WORKTREE_RUN = {
  project_id: 'project-1',
  base_branch: 'main',
  integration_branch: 'doc-checkout',
  integration_worktree_id: 'wt-integration',
  integration_connection_id: null,
  members: null
}
const CONNECTION_RUN = {
  ...WORKTREE_RUN,
  project_id: 'connection-project',
  integration_worktree_id: null,
  integration_connection_id: 'conn-integration',
  members: [{ project_id: 'web' } as DocumentRunMember]
}
const INTEGRATION_WORKTREE = { id: 'wt-integration', is_default: false, branch_name: 'doc-checkout' }

describe('runBranchTarget', () => {
  it('is the run’s integration worktree', () => {
    expect(runBranchTarget(WORKTREE_RUN, [INTEGRATION_WORKTREE], undefined)).toEqual({
      branch: 'doc-checkout',
      checkout: { kind: 'worktree', worktreeId: 'wt-integration' },
      refusal: null
    })
  })

  it('is the run’s integration instance for a connection run', () => {
    expect(
      runBranchTarget(CONNECTION_RUN, undefined, [{ id: 'conn-integration', status: 'active' }])
    ).toEqual({
      branch: 'doc-checkout',
      checkout: { kind: 'connection', connectionId: 'conn-integration' },
      refusal: null
    })
  })

  it('refuses a worktree that was archived', () => {
    expect(runBranchTarget(WORKTREE_RUN, [], undefined)).toEqual({
      branch: 'doc-checkout',
      checkout: null,
      refusal: 'The worktree of doc-checkout was archived.'
    })
  })

  it('refuses an instance that was archived', () => {
    expect(
      runBranchTarget(CONNECTION_RUN, undefined, [{ id: 'conn-integration', status: 'archived' }])
        .refusal
    ).toBe('The instance of doc-checkout was archived or deleted.')
  })

  it('takes the run’s word for it until the lists have loaded', () => {
    expect(runBranchTarget(WORKTREE_RUN, undefined, undefined).refusal).toBeNull()
    expect(runBranchTarget(CONNECTION_RUN, undefined, undefined).refusal).toBeNull()
  })

  it('refuses a run without a checkout', () => {
    expect(
      runBranchTarget({ ...WORKTREE_RUN, integration_worktree_id: null }, [], undefined).refusal
    ).toBe('The run has no integration worktree to run in.')
    expect(
      runBranchTarget({ ...CONNECTION_RUN, integration_connection_id: null }, undefined, []).refusal
    ).toBe('The run has no integration instance to run in.')
  })
})

describe('launchTicketOnCheckout', () => {
  const TICKET = { id: 'ticket-1', project_id: 'project-1', title: 'Rotate the key' }
  const CONFIG: DocumentRunLaunchConfig = {
    sdk: 'claude-code-cli',
    model: { providerID: 'anthropic', modelID: 'opus' },
    codexFastMode: false,
    customProviderId: null
  }
  const WORKTREE: RunCheckout = { kind: 'worktree', worktreeId: 'wt-integration' }
  const CONNECTION: RunCheckout = { kind: 'connection', connectionId: 'conn-integration' }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.discardSession.mockResolvedValue(undefined)
    mocks.resetTicketToTodo.mockResolvedValue(undefined)
    mocks.launchTicketWithModel.mockResolvedValue({ success: true, sessionId: 'session-1' })
  })

  it('launches the ticket in the worktree, In Progress and with the prompt as given', async () => {
    await expect(
      launchTicketOnCheckout(TICKET, WORKTREE, { prompt: 'do it', modelConfig: CONFIG })
    ).resolves.toBe('session-1')

    expect(mocks.launchTicketWithModel).toHaveBeenCalledExactlyOnceWith({
      ticketId: 'ticket-1',
      projectId: 'project-1',
      ticketTitle: 'Rotate the key',
      worktree: { type: 'existing', worktreeId: 'wt-integration' },
      prompt: 'do it',
      mode: 'build',
      modelConfig: CONFIG,
      goalMode: false,
      goalSuccessCriteria: null,
      keepInstanceName: true,
      ticketUpdateExtras: {
        column: 'in_progress',
        sort_order: 7,
        plan_ready: false,
        pending_launch_config: null
      }
    })
    expect(mocks.getTicketsByColumn).toHaveBeenCalledWith('project-1', 'in_progress')
  })

  it('launches on the existing instance of a connection checkout', async () => {
    await launchTicketOnCheckout(TICKET, CONNECTION, { prompt: 'do it', modelConfig: CONFIG })

    expect(mocks.launchTicketWithModel.mock.calls[0][0].worktree).toEqual({
      type: 'existing-connection',
      connectionId: 'conn-integration'
    })
  })

  it('closes the session and returns the ticket to To Do when the agent could not start', async () => {
    mocks.launchTicketWithModel.mockResolvedValue({
      success: false,
      sessionId: 'session-2',
      error: 'Could not send prompt'
    })

    await expect(
      launchTicketOnCheckout(TICKET, WORKTREE, { prompt: 'do it', modelConfig: CONFIG })
    ).rejects.toThrow('Could not send prompt')

    expect(mocks.discardSession).toHaveBeenCalledExactlyOnceWith('session-2')
    expect(mocks.resetTicketToTodo).toHaveBeenCalledExactlyOnceWith('project-1', 'ticket-1')
  })

  it('has no session to close when none was created', async () => {
    mocks.launchTicketWithModel.mockResolvedValue({ success: false })

    await expect(
      launchTicketOnCheckout(TICKET, WORKTREE, { prompt: 'do it', modelConfig: CONFIG })
    ).rejects.toThrow('The session could not be started.')

    expect(mocks.discardSession).not.toHaveBeenCalled()
    expect(mocks.resetTicketToTodo).toHaveBeenCalledTimes(1)
  })

  it('still reports the launch failure when the ticket cannot be reset', async () => {
    mocks.launchTicketWithModel.mockResolvedValue({ success: false, error: 'No such worktree' })
    mocks.resetTicketToTodo.mockRejectedValue(new Error('database is locked'))

    await expect(
      launchTicketOnCheckout(TICKET, WORKTREE, { prompt: 'do it', modelConfig: CONFIG })
    ).rejects.toThrow('No such worktree')
  })
})
