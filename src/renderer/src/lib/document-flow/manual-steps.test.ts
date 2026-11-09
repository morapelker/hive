import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRunLaunchConfig, DocumentRunMember } from '@shared/types/document-flow'
import {
  defaultManualStepsTarget,
  launchManualStepsSession,
  manualStepsTargets,
  type ManualStepsTarget
} from './manual-steps'
import type { RunCheckout } from './run-checkout'

const mocks = vi.hoisted(() => ({
  createTicket: vi.fn(),
  deleteTicket: vi.fn(),
  launchTicketOnCheckout: vi.fn()
}))

vi.mock('./run-checkout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-checkout')>()),
  launchTicketOnCheckout: mocks.launchTicketOnCheckout
}))
vi.mock('@/lib/ticket-launch', () => ({ launchTicketWithModel: vi.fn() }))
vi.mock('./migrations', () => ({ discardSession: vi.fn() }))
vi.mock('./runner-ports', () => ({ resetTicketToTodo: vi.fn() }))
vi.mock('./ticket-run-membership', () => ({
  runTitle: (run: { title: string; source_kind: string }) =>
    run.title.trim() || (run.source_kind === 'tickets' ? 'Orchestrator' : 'Document run')
}))
vi.mock('@/stores/useKanbanStore', () => ({
  useKanbanStore: {
    getState: () => ({ createTicket: mocks.createTicket, deleteTicket: mocks.deleteTicket })
  }
}))
vi.mock('@/lib/connection-project', () => ({
  isBaseInstance: (c: { is_base?: number; saved_project_id?: string | null }) =>
    !!c.is_base && !!c.saved_project_id,
  baseInstanceLabel: (members: { worktree_branch?: string | null }[]) =>
    members.map((m) => m.worktree_branch).join(' + ')
}))

const WORKTREE_RUN = {
  project_id: 'project-1',
  base_branch: 'develop',
  integration_branch: 'doc-checkout',
  integration_worktree_id: 'wt-integration',
  integration_connection_id: null,
  members: null
}
const CONNECTION_RUN = {
  ...WORKTREE_RUN,
  integration_worktree_id: null,
  integration_connection_id: 'conn-integration',
  members: [{ project_id: 'web' } as DocumentRunMember]
}
const INTEGRATION_WORKTREE = {
  id: 'wt-integration',
  is_default: false,
  branch_name: 'doc-checkout'
}
const ROOT_WORKTREE = { id: 'wt-root', is_default: true, branch_name: 'main' }
const INTEGRATION_INSTANCE = { id: 'conn-integration', status: 'active', path: '/from-store' }
const BASE_INSTANCE = {
  id: 'conn-base',
  status: 'active',
  path: '/connections/base',
  saved_project_id: 'project-1',
  is_base: 1,
  members: [{ worktree_branch: 'main' }, { worktree_branch: 'master' }]
}

const find = (targets: ManualStepsTarget[], kind: ManualStepsTarget['kind']): ManualStepsTarget =>
  targets.find((target) => target.kind === kind) as ManualStepsTarget

describe('manualStepsTargets — a worktree run', () => {
  it('offers the run’s branch first, then the project’s no-worktree checkout', () => {
    expect(
      manualStepsTargets(WORKTREE_RUN, [INTEGRATION_WORKTREE, ROOT_WORKTREE], undefined)
    ).toEqual([
      {
        kind: 'integration',
        branch: 'doc-checkout',
        checkout: { kind: 'worktree', worktreeId: 'wt-integration' },
        refusal: null
      },
      {
        kind: 'no-worktree',
        branch: 'main',
        checkout: { kind: 'worktree', worktreeId: 'wt-root' },
        refusal: null
      }
    ])
  })

  it('refuses the run’s branch once its worktree is archived', () => {
    const target = find(manualStepsTargets(WORKTREE_RUN, [ROOT_WORKTREE], undefined), 'integration')
    expect(target.checkout).toBeNull()
    expect(target.refusal).toBe('The worktree of doc-checkout was archived.')
  })

  it('refuses the run’s branch when the run never had a worktree', () => {
    const target = find(
      manualStepsTargets(
        { ...WORKTREE_RUN, integration_worktree_id: null },
        [ROOT_WORKTREE],
        undefined
      ),
      'integration'
    )
    expect(target.refusal).toBe('The run has no integration worktree to run in.')
  })

  it('waits for the worktrees: the run’s branch is offered, the no-worktree path is not yet', () => {
    const targets = manualStepsTargets(WORKTREE_RUN, undefined, undefined)
    expect(find(targets, 'integration').refusal).toBeNull()
    expect(find(targets, 'no-worktree')).toMatchObject({
      branch: 'develop',
      checkout: null,
      refusal: 'Loading the project’s worktrees…'
    })
  })

  it('refuses the no-worktree path of a project without one', () => {
    const target = find(
      manualStepsTargets(WORKTREE_RUN, [INTEGRATION_WORKTREE], undefined),
      'no-worktree'
    )
    expect(target.refusal).toBe('This project has no checkout outside a worktree.')
  })
})

describe('manualStepsTargets — a connection run', () => {
  it('offers the integration instance, then the project’s base instance', () => {
    expect(
      manualStepsTargets(CONNECTION_RUN, undefined, [INTEGRATION_INSTANCE, BASE_INSTANCE])
    ).toEqual([
      {
        kind: 'integration',
        branch: 'doc-checkout',
        checkout: { kind: 'connection', connectionId: 'conn-integration' },
        refusal: null
      },
      {
        kind: 'no-worktree',
        branch: 'main + master',
        checkout: { kind: 'connection', connectionId: 'conn-base' },
        refusal: null
      }
    ])
  })

  it.each([
    ['gone', [BASE_INSTANCE]],
    ['archived', [{ ...INTEGRATION_INSTANCE, status: 'archived' }, BASE_INSTANCE]]
  ])('refuses an integration instance that is %s', (_label, connections) => {
    expect(
      find(manualStepsTargets(CONNECTION_RUN, undefined, connections), 'integration').refusal
    ).toBe('The instance of doc-checkout was archived or deleted.')
  })

  it('does not take another project’s base instance', () => {
    expect(
      find(
        manualStepsTargets(CONNECTION_RUN, undefined, [
          INTEGRATION_INSTANCE,
          { ...BASE_INSTANCE, saved_project_id: 'other' }
        ]),
        'no-worktree'
      ).refusal
    ).toBe('This project has no base instance to run in.')
  })

  it('waits for the connections to load before looking up the base instance', () => {
    expect(
      find(manualStepsTargets(CONNECTION_RUN, undefined, undefined), 'no-worktree').refusal
    ).toBe('Loading the project’s instances…')
  })
})

describe('defaultManualStepsTarget', () => {
  it('is the run’s branch while it can be run on', () => {
    expect(
      defaultManualStepsTarget(
        manualStepsTargets(WORKTREE_RUN, [INTEGRATION_WORKTREE, ROOT_WORKTREE], undefined)
      )
    ).toBe('integration')
  })

  it('is the no-worktree path once the branch’s worktree is archived with the merge', () => {
    expect(
      defaultManualStepsTarget(manualStepsTargets(WORKTREE_RUN, [ROOT_WORKTREE], undefined))
    ).toBe('no-worktree')
  })
})

describe('launchManualStepsSession', () => {
  const CONFIG: DocumentRunLaunchConfig = {
    sdk: 'claude-code-cli',
    model: { providerID: 'anthropic', modelID: 'opus' },
    codexFastMode: false,
    customProviderId: null
  }
  const TARGET: ManualStepsTarget & { checkout: RunCheckout } = {
    kind: 'integration',
    branch: 'doc-checkout',
    checkout: { kind: 'worktree', worktreeId: 'wt-integration' },
    refusal: null
  }
  const RUN = { project_id: 'project-1', title: 'Checkout redesign', source_kind: 'document' as const }
  const TICKET = { id: 'ticket-1', project_id: 'project-1', title: 'Manual steps' }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.createTicket.mockResolvedValue(TICKET)
    mocks.deleteTicket.mockResolvedValue(undefined)
    mocks.launchTicketOnCheckout.mockResolvedValue('session-1')
  })

  it('opens a ticket on the board of the run’s project and starts it in the checkout', async () => {
    await expect(launchManualStepsSession(TARGET, RUN, 'do the steps', CONFIG)).resolves.toBe(
      'session-1'
    )

    expect(mocks.createTicket).toHaveBeenCalledExactlyOnceWith('project-1', {
      project_id: 'project-1',
      title: 'Manual steps — Checkout redesign',
      description: 'do the steps',
      column: 'todo'
    })
    expect(mocks.launchTicketOnCheckout).toHaveBeenCalledExactlyOnceWith(TICKET, TARGET.checkout, {
      prompt: 'do the steps',
      modelConfig: CONFIG
    })
    expect(mocks.deleteTicket).not.toHaveBeenCalled()
  })

  it('names the ticket after what the run is when it has no title', async () => {
    await launchManualStepsSession(TARGET, { ...RUN, title: '  ', source_kind: 'tickets' }, 'p', CONFIG)
    expect(mocks.createTicket.mock.calls[0][1].title).toBe('Manual steps — Orchestrator')
  })

  it('takes the ticket off the board again when the session could not be started', async () => {
    mocks.launchTicketOnCheckout.mockRejectedValue(new Error('Could not send prompt'))

    await expect(launchManualStepsSession(TARGET, RUN, 'p', CONFIG)).rejects.toThrow(
      'Could not send prompt'
    )

    expect(mocks.deleteTicket).toHaveBeenCalledExactlyOnceWith('ticket-1', 'project-1')
  })

  it('reports the launch failure even when the ticket cannot be removed', async () => {
    mocks.launchTicketOnCheckout.mockRejectedValue(new Error('Could not send prompt'))
    mocks.deleteTicket.mockRejectedValue(new Error('database is locked'))

    await expect(launchManualStepsSession(TARGET, RUN, 'p', CONFIG)).rejects.toThrow(
      'Could not send prompt'
    )
  })

  it('starts nothing when the ticket could not be created', async () => {
    mocks.createTicket.mockRejectedValue(new Error('board is read only'))

    await expect(launchManualStepsSession(TARGET, RUN, 'p', CONFIG)).rejects.toThrow(
      'board is read only'
    )

    expect(mocks.launchTicketOnCheckout).not.toHaveBeenCalled()
  })
})
