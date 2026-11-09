import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRunLaunchConfig, DocumentRunMember } from '@shared/types/document-flow'
import {
  defaultManualStepsTarget,
  isManualStepsSession,
  launchManualStepsSession,
  manualStepsTargets,
  resetManualStepsStateForTests,
  type ManualStepsCheckout,
  type ManualStepsTarget
} from './manual-steps'

const mocks = vi.hoisted(() => ({
  launchSessionWithModel: vi.fn(),
  launchSessionOnConnection: vi.fn(),
  discardSession: vi.fn(),
  updateSessionName: vi.fn()
}))

vi.mock('@/lib/ticket-launch', () => ({
  launchSessionWithModel: mocks.launchSessionWithModel,
  launchSessionOnConnection: mocks.launchSessionOnConnection
}))
vi.mock('./migrations', () => ({ discardSession: mocks.discardSession }))
vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: { getState: () => ({ updateSessionName: mocks.updateSessionName }) }
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
  integration_connection_path: null,
  members: null
}
const CONNECTION_RUN = {
  ...WORKTREE_RUN,
  integration_worktree_id: null,
  integration_connection_id: 'conn-integration',
  integration_connection_path: '/connections/doc-checkout',
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
        checkout: {
          kind: 'connection',
          connectionId: 'conn-integration',
          path: '/connections/doc-checkout'
        },
        refusal: null
      },
      {
        kind: 'no-worktree',
        branch: 'main + master',
        checkout: { kind: 'connection', connectionId: 'conn-base', path: '/connections/base' },
        refusal: null
      }
    ])
  })

  it('falls back to the store’s path when the run has none', () => {
    const target = find(
      manualStepsTargets({ ...CONNECTION_RUN, integration_connection_path: null }, undefined, [
        INTEGRATION_INSTANCE
      ]),
      'integration'
    )
    expect(target.checkout).toEqual({
      kind: 'connection',
      connectionId: 'conn-integration',
      path: '/from-store'
    })
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
  type LaunchTarget = ManualStepsTarget & { checkout: ManualStepsCheckout }
  const WORKTREE_TARGET: LaunchTarget = {
    kind: 'integration',
    branch: 'doc-checkout',
    checkout: { kind: 'worktree', worktreeId: 'wt-integration' },
    refusal: null
  }
  const CONNECTION_TARGET: LaunchTarget = {
    kind: 'integration',
    branch: 'doc-checkout',
    checkout: { kind: 'connection', connectionId: 'conn-1', path: '/connections/x' },
    refusal: null
  }

  type CreatedHook = (created: { session: { id: string } }) => Promise<void>
  const launchAs = (
    fn: typeof mocks.launchSessionWithModel,
    result: { success: boolean; sessionId?: string; error?: string }
  ): void => {
    fn.mockImplementation(async (spec: { onSessionCreated: CreatedHook }) => {
      if (result.sessionId) await spec.onSessionCreated({ session: { id: result.sessionId } })
      return result
    })
  }

  beforeEach(() => {
    vi.resetAllMocks()
    resetManualStepsStateForTests()
    mocks.updateSessionName.mockResolvedValue(true)
    mocks.discardSession.mockResolvedValue(undefined)
  })

  it('launches in the worktree with no ticket attached, and names the session', async () => {
    launchAs(mocks.launchSessionWithModel, { success: true, sessionId: 'session-1' })

    await expect(
      launchManualStepsSession(WORKTREE_TARGET, 'project-1', 'do the steps', CONFIG)
    ).resolves.toBe('session-1')

    expect(mocks.launchSessionWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'wt-integration',
        prompt: 'do the steps',
        mode: 'build',
        modelConfig: CONFIG,
        goalMode: false,
        goalSuccessCriteria: null,
        skipKanbanAttach: true
      })
    )
    expect(mocks.launchSessionOnConnection).not.toHaveBeenCalled()
    expect(mocks.updateSessionName).toHaveBeenCalledWith('session-1', 'Manual steps — doc-checkout')
  })

  it('launches on the connection instance of a connection target', async () => {
    launchAs(mocks.launchSessionOnConnection, { success: true, sessionId: 'session-2' })

    await launchManualStepsSession(CONNECTION_TARGET, 'project-1', 'do the steps', CONFIG)

    expect(mocks.launchSessionOnConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-1',
        connectionPath: '/connections/x',
        prompt: 'do the steps',
        modelConfig: CONFIG
      })
    )
    expect(mocks.launchSessionWithModel).not.toHaveBeenCalled()
  })

  it('keeps the board from opening a ticket for the session from its creation on', async () => {
    let seenDuringLaunch = false
    mocks.launchSessionWithModel.mockImplementation(
      async (spec: { onSessionCreated: CreatedHook }) => {
        await spec.onSessionCreated({ session: { id: 'session-3' } })
        seenDuringLaunch = isManualStepsSession('session-3')
        return { success: true, sessionId: 'session-3' }
      }
    )

    await launchManualStepsSession(WORKTREE_TARGET, 'project-1', 'p', CONFIG)

    expect(seenDuringLaunch).toBe(true)
    expect(isManualStepsSession('session-3')).toBe(true)
    expect(isManualStepsSession('another')).toBe(false)
  })

  it('discards a session that was created but not started, and reports why', async () => {
    launchAs(mocks.launchSessionWithModel, {
      success: false,
      sessionId: 'session-4',
      error: 'Could not send prompt'
    })

    await expect(
      launchManualStepsSession(WORKTREE_TARGET, 'project-1', 'p', CONFIG)
    ).rejects.toThrow('Could not send prompt')

    expect(mocks.discardSession).toHaveBeenCalledWith('session-4')
    expect(isManualStepsSession('session-4')).toBe(false)
  })

  it('has nothing to discard when no session was created', async () => {
    launchAs(mocks.launchSessionWithModel, { success: false })

    await expect(
      launchManualStepsSession(WORKTREE_TARGET, 'project-1', 'p', CONFIG)
    ).rejects.toThrow('The session could not be started.')

    expect(mocks.discardSession).not.toHaveBeenCalled()
  })
})
