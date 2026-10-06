import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMigrationPrompt } from '@shared/document-flow/prompts'
import type {
  DocumentRun,
  DocumentRunDetail,
  DocumentRunLaunchConfig,
  SessionFinalMessage
} from '@shared/types/document-flow'
import { markSessionAborted } from '@/api/opencode-api'
import { makeDetail, makeReport, makeRun } from '@/components/document-flow/test-fixtures'
import type { SessionLaunchResult, SessionLaunchSpec } from '@/lib/ticket-launch'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore, type SessionStatusEntry } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { Session, Worktree } from '../../../../main/db/types'
import {
  CLI_INTERRUPT_WAIT_MS,
  MIGRATION_POLL_MS,
  MIGRATION_SETTLE_MS,
  isMigrationSession,
  migrationsRefusal,
  observeMigrationSession,
  resetMigrationStateForTests,
  startMigrationWatcher,
  startRunMigrations,
  stopRunMigrations
} from './migrations'
import { resetSessionSignalLatchForTests } from './session-signal'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  startMigrations: vi.fn(),
  endMigrations: vi.fn(),
  sessionTurn: vi.fn(),
  abort: vi.fn(),
  write: vi.fn(),
  sessionGet: vi.fn(),
  worktreeGet: vi.fn(),
  launchSessionWithModel: vi.fn(),
  resolveDefaultLaunchConfig: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))
vi.mock('@/api/document-flow-api', () => ({
  documentFlowApi: {
    get: mocks.get,
    startMigrations: mocks.startMigrations,
    endMigrations: mocks.endMigrations,
    sessionTurn: mocks.sessionTurn
  }
}))
// Only the abort RPC is faked: the abort mark the session signal reads stays the real one.
vi.mock('@/api/opencode-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/opencode-api')>()
  return { ...actual, opencodeApi: { ...actual.opencodeApi, abort: mocks.abort } }
})
vi.mock('@/api/terminal-api', () => ({ terminalApi: { write: mocks.write } }))
vi.mock('@/api/db-api', () => ({
  dbApi: {
    session: { get: mocks.sessionGet },
    worktree: { get: mocks.worktreeGet },
    setting: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) }
  }
}))
vi.mock('@/lib/ticket-launch', () => ({ launchSessionWithModel: mocks.launchSessionWithModel }))
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }))
vi.mock('./runner-ports', () => ({
  resolveDefaultLaunchConfig: mocks.resolveDefaultLaunchConfig
}))

const RUN = 'run-1'
const SESSION = 's-mig'
const OPENCODE_SESSION = 'opc-mig'
const WORKTREE = 'wt-integration'
const WORKTREE_PATH = '/worktrees/shop--doc-checkout-redesign'
const BRANCH = 'doc-checkout-redesign'
const MIGRATIONS = ['drizzle/0042_counters.sql', 'drizzle/0043_orders.sql — adds orders.test_flag']

const NOW = Date.parse('2026-05-04T12:00:00.000Z')
/** When the migration session of a migrating run was recorded: a minute before `NOW`. */
const STARTED_AT = NOW - 60_000

const RUN_LAUNCH: DocumentRunLaunchConfig = {
  sdk: 'codex',
  model: { providerID: 'codex', modelID: 'gpt-5.5', variant: 'high' },
  codexFastMode: true,
  customProviderId: null
}
const APP_LAUNCH: DocumentRunLaunchConfig = {
  sdk: 'claude-code-cli',
  model: { providerID: 'anthropic', modelID: 'opus' },
  codexFastMode: false,
  customProviderId: null
}

const initialFlowState = useDocumentFlowStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialStatusState = useWorktreeStatusStore.getState()
const initialQuestionState = useQuestionStore.getState()

/** A finished run with migrations to execute, merged into its integration worktree. */
const finishedRun = (overrides: Partial<DocumentRun> = {}): DocumentRun =>
  makeRun({
    status: 'completed',
    report: makeReport({ migrations: MIGRATIONS }),
    integration_branch: BRANCH,
    integration_worktree_id: WORKTREE,
    integration_worktree_path: WORKTREE_PATH,
    ...overrides
  })

/** The same run while a session executes its migrations. */
const migratingRun = (overrides: Partial<DocumentRun> = {}): DocumentRun =>
  finishedRun({
    migration_session_id: SESSION,
    migration_started_at: new Date(STARTED_AT).toISOString(),
    ...overrides
  })

function seedRun(run: DocumentRun): DocumentRunDetail {
  const detail: DocumentRunDetail = { ...makeDetail({}, []), run }
  useDocumentFlowStore.setState((state) => ({ runsById: { ...state.runsById, [run.id]: detail } }))
  return detail
}

const runInStore = (runId = RUN): DocumentRun => useDocumentFlowStore.getState().runsById[runId].run

/** What the server answers: the run as the store holds it, with `patch` applied. */
const serverDetail = (runId: string, patch: Partial<DocumentRun>): DocumentRunDetail => {
  const detail = useDocumentFlowStore.getState().runsById[runId]
  return { ...detail, run: { ...detail.run, ...patch } }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    worktree_id: WORKTREE,
    project_id: 'project-1',
    connection_id: null,
    name: 'Session',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    remote_launch: null,
    created_at: '2026-05-04T11:59:00.000Z',
    updated_at: '2026-05-04T11:59:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  } as Session
}

const SDK_SESSION = makeSession({ agent_sdk: 'claude-code', opencode_session_id: OPENCODE_SESSION })
const CLI_SESSION = makeSession()

/** A session row the page has loaded, in the integration worktree. */
function seedSession(session: Session): void {
  useSessionStore.setState({
    sessionsByWorktree: new Map([[session.worktree_id ?? '', [session]]])
  })
}

/** The project's worktrees as loaded; `ids` without the integration worktree = it was archived. */
function seedWorktrees(ids: string[] = [WORKTREE]): void {
  const worktrees = ids.map(
    (id) => ({ id, project_id: 'project-1', path: WORKTREE_PATH, status: 'active' }) as Worktree
  )
  useWorktreeStore.setState({ worktreesByProject: new Map([['project-1', worktrees]]) })
}

function setStatus(sessionId: string, entry: SessionStatusEntry | null): void {
  useWorktreeStatusStore.setState((state) => ({
    sessionStatuses: { ...state.sessionStatuses, [sessionId]: entry }
  }))
}

const completed = (overrides: Partial<SessionStatusEntry> = {}): SessionStatusEntry => ({
  status: 'completed',
  timestamp: NOW - 10_000,
  completion: 'completed',
  ...overrides
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let updateSessionName: ReturnType<typeof vi.fn>
let closeSession: ReturnType<typeof vi.fn>
let dequeuePendingMessage: ReturnType<typeof vi.fn>
let loadWorktrees: ReturnType<typeof vi.fn>

beforeAll(
  () =>
    // Absorb the settings store's one-shot import timer so it cannot reset state mid-test.
    new Promise((resolve) => setTimeout(resolve, 220))
)

beforeEach(() => {
  resetMigrationStateForTests()
  resetSessionSignalLatchForTests()
  useDocumentFlowStore.setState({ ...initialFlowState, runsById: {} }, true)
  useSessionStore.setState(
    { ...initialSessionState, sessionsByWorktree: new Map(), sessionsByConnection: new Map() },
    true
  )
  useWorktreeStatusStore.setState(
    {
      ...initialStatusState,
      sessionStatuses: {},
      sessionApiErrors: {},
      backgroundWorkBySession: {}
    },
    true
  )
  useQuestionStore.setState({ ...initialQuestionState, pendingBySession: new Map() }, true)

  updateSessionName = vi.fn(async () => true)
  closeSession = vi.fn(async () => ({ success: true }))
  dequeuePendingMessage = vi.fn(() => null)
  loadWorktrees = vi.fn(async () => undefined)
  useSessionStore.setState({ updateSessionName, closeSession, dequeuePendingMessage })
  useWorktreeStore.setState({ ...initialWorktreeState, loadWorktrees }, true)
  seedWorktrees()

  // The server as it answers when all is well: the session is recorded, then released, and
  // in between the run is what this page holds.
  mocks.get.mockImplementation(
    async (runId: string) => useDocumentFlowStore.getState().runsById[runId] ?? null
  )
  mocks.startMigrations.mockImplementation(async (runId: string, sessionId: string) =>
    serverDetail(runId, {
      migration_session_id: sessionId,
      migration_started_at: new Date().toISOString()
    })
  )
  mocks.endMigrations.mockImplementation(async (runId: string) =>
    serverDetail(runId, { migration_session_id: null, migration_started_at: null })
  )
  mocks.sessionTurn.mockResolvedValue(null)
  mocks.abort.mockResolvedValue({ success: true, value: { success: true } })
  mocks.sessionGet.mockResolvedValue(null)
  mocks.worktreeGet.mockResolvedValue(null)
  mocks.resolveDefaultLaunchConfig.mockReturnValue(APP_LAUNCH)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  resetMigrationStateForTests()
  resetSessionSignalLatchForTests()
  useDocumentFlowStore.setState(initialFlowState, true)
  useSessionStore.setState(initialSessionState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useWorktreeStatusStore.setState(initialStatusState, true)
  useQuestionStore.setState(initialQuestionState, true)
})

describe('migrationsRefusal', () => {
  const loaded = new Set([WORKTREE])

  it('allows a finished run with migrations and a checkout of its branch', () => {
    expect(migrationsRefusal(finishedRun(), loaded)).toBeNull()
  })

  it.each(['completed', 'completed_with_issues', 'cancelled'] as const)(
    'allows a run that ended as %s',
    (status) => {
      expect(migrationsRefusal(finishedRun({ status }), loaded)).toBeNull()
    }
  )

  it('refuses while a session is already executing them, before anything else', () => {
    expect(migrationsRefusal(migratingRun(), loaded)).toBe(
      'The migrations of this run are already being executed.'
    )
    // Also for a run that has nothing else going for it.
    expect(migrationsRefusal(migratingRun({ status: 'running', report: null }), undefined)).toBe(
      'The migrations of this run are already being executed.'
    )
  })

  it.each(['extracting', 'extract_failed', 'preview', 'running', 'paused'] as const)(
    'refuses a run that is %s, report or not',
    (status) => {
      expect(migrationsRefusal(finishedRun({ status }), loaded)).toBe(
        'Only a run that has finished has migrations to execute.'
      )
    }
  )

  it('refuses an ended run without a report', () => {
    expect(migrationsRefusal(finishedRun({ report: null }), loaded)).toBe(
      'Only a run that has finished has migrations to execute.'
    )
  })

  it('refuses a run whose report lists no migrations', () => {
    expect(migrationsRefusal(finishedRun({ report: makeReport({ migrations: [] }) }), loaded)).toBe(
      'This run has no migrations to execute.'
    )
  })

  it.each([
    ['worktree', { integration_worktree_id: null }],
    ['branch', { integration_branch: null }]
  ] as const)('refuses a run without an integration %s', (_name, overrides) => {
    expect(migrationsRefusal(finishedRun(overrides), loaded)).toBe(
      'The run has no integration worktree to execute the migrations in.'
    )
  })

  it('refuses when the integration worktree was archived, naming the branch', () => {
    const refusal = migrationsRefusal(finishedRun(), new Set(['wt-other']))
    expect(refusal).toContain(`The worktree of ${BRANCH} was archived`)
    expect(migrationsRefusal(finishedRun(), new Set())).toBe(refusal)
  })

  it('refuses nothing over worktrees that are not loaded yet', () => {
    expect(migrationsRefusal(finishedRun(), undefined)).toBeNull()
  })
})

describe('startRunMigrations', () => {
  /**
   * A launch as `launchSessionWithModel` runs it: the session is handed to the caller before
   * the agent is started, and a throw of the caller is a failed launch that names the session.
   */
  const launchEnds = (
    end: (spec: SessionLaunchSpec) => SessionLaunchResult | Promise<SessionLaunchResult>,
    session: Session = CLI_SESSION
  ): void => {
    mocks.launchSessionWithModel.mockImplementation(async (spec: SessionLaunchSpec) => {
      try {
        await spec.onSessionCreated?.({
          session,
          customProviderId: null,
          model: spec.modelConfig.model
        })
      } catch (error) {
        return { success: false, error: (error as Error).message, sessionId: session.id }
      }
      return end(spec)
    })
  }

  const launchedSpec = (): SessionLaunchSpec => mocks.launchSessionWithModel.mock.calls[0][0]

  beforeEach(() => {
    launchEnds(() => ({ success: true, sessionId: SESSION }))
  })

  it('launches a build session in the integration worktree with the migration prompt', async () => {
    seedRun(finishedRun({ config: { ...makeRun().config, defaultLaunch: RUN_LAUNCH } }))

    await startRunMigrations(RUN)

    expect(mocks.launchSessionWithModel).toHaveBeenCalledTimes(1)
    expect(mocks.launchSessionWithModel).toHaveBeenCalledWith({
      projectId: 'project-1',
      // The checkout of the branch the run's tickets were merged into.
      worktreeId: WORKTREE,
      prompt: buildMigrationPrompt({
        documentTitle: 'Checkout redesign',
        integrationBranch: BRANCH,
        migrations: MIGRATIONS,
        sdk: 'codex'
      }),
      mode: 'build',
      modelConfig: RUN_LAUNCH,
      goalMode: false,
      goalSuccessCriteria: null,
      // The run's own ticket shows the session: no other ticket of the worktree is handed it.
      skipKanbanAttach: true,
      onSessionCreated: expect.any(Function)
    })
    const { prompt } = launchedSpec()
    expect(prompt).toContain(`(${BRANCH}) against production`)
    for (const migration of MIGRATIONS) expect(prompt).toContain(`- ${migration}`)
  })

  it('launches with the model the run launches its tickets with', async () => {
    seedRun(finishedRun({ config: { ...makeRun().config, defaultLaunch: RUN_LAUNCH } }))

    await startRunMigrations(RUN)

    expect(launchedSpec().modelConfig).toBe(RUN_LAUNCH)
    expect(mocks.resolveDefaultLaunchConfig).not.toHaveBeenCalled()
    // The prompt names the question tool of that agent.
    expect(launchedSpec().prompt).toContain('use the request_user_input tool to ask me')
  })

  it("falls back to the app's default launch when the run has none", async () => {
    seedRun(finishedRun({ config: { ...makeRun().config, defaultLaunch: null } }))

    await startRunMigrations(RUN)

    expect(mocks.resolveDefaultLaunchConfig).toHaveBeenCalledTimes(1)
    expect(launchedSpec().modelConfig).toBe(APP_LAUNCH)
    expect(launchedSpec().prompt).toContain('use the AskUserQuestion tool to ask me')
  })

  it('names the session after the branch and records it before the agent is started', async () => {
    seedRun(finishedRun())
    const order: string[] = []
    updateSessionName.mockImplementation(async () => {
      order.push('named')
      return true
    })
    mocks.startMigrations.mockImplementation(async (runId: string, sessionId: string) => {
      order.push('recorded')
      return serverDetail(runId, {
        migration_session_id: sessionId,
        migration_started_at: '2026-05-04T12:00:00.000Z'
      })
    })
    launchEnds(() => {
      // What the launch does next is start the agent: the run shows the session by now.
      order.push('agent started')
      expect(runInStore().migration_session_id).toBe(SESSION)
      return { success: true, sessionId: SESSION }
    })

    await startRunMigrations(RUN)

    expect(updateSessionName).toHaveBeenCalledWith(SESSION, `Migrations — ${BRANCH}`)
    expect(mocks.startMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.startMigrations).toHaveBeenCalledWith(RUN, SESSION)
    expect(order).toEqual(['named', 'recorded', 'agent started'])
    expect(runInStore()).toMatchObject({
      migration_session_id: SESSION,
      migration_started_at: '2026-05-04T12:00:00.000Z'
    })
    expect(mocks.endMigrations).not.toHaveBeenCalled()
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('reloads the worktrees of the project before it decides', async () => {
    seedRun(finishedRun())

    await startRunMigrations(RUN)

    expect(loadWorktrees).toHaveBeenCalledWith('project-1')
    expect(loadWorktrees.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launchSessionWithModel.mock.invocationCallOrder[0]
    )
  })

  it('launches when the worktrees could not be loaded: an unknown worktree is not an archived one', async () => {
    seedRun(finishedRun())
    useWorktreeStore.setState({ worktreesByProject: new Map() })

    await startRunMigrations(RUN)

    expect(mocks.launchSessionWithModel).toHaveBeenCalledTimes(1)
  })

  it('rejects for a run that is not loaded', async () => {
    await expect(startRunMigrations('run-gone')).rejects.toThrow('The run is not loaded.')
    expect(loadWorktrees).not.toHaveBeenCalled()
    expect(mocks.launchSessionWithModel).not.toHaveBeenCalled()
  })

  it.each([
    ['is still running', { status: 'running' }, 'Only a run that has finished'],
    ['has no report', { report: null }, 'Only a run that has finished'],
    [
      'has no migrations',
      { report: makeReport({ migrations: [] }) },
      'This run has no migrations to execute.'
    ],
    [
      'has no integration worktree',
      { integration_worktree_id: null },
      'The run has no integration worktree'
    ],
    [
      'is already migrating',
      { migration_session_id: 's-other' },
      'The migrations of this run are already being executed.'
    ]
  ] as const)('rejects without launching for a run that %s', async (_name, overrides, message) => {
    seedRun(finishedRun(overrides))

    await expect(startRunMigrations(RUN)).rejects.toThrow(message)

    expect(mocks.launchSessionWithModel).not.toHaveBeenCalled()
    expect(mocks.startMigrations).not.toHaveBeenCalled()
    expect(mocks.resolveDefaultLaunchConfig).not.toHaveBeenCalled()
  })

  it('rejects without launching when the reload shows the integration worktree was archived', async () => {
    seedRun(finishedRun())
    // Not loaded when the button is pressed; the reload lists the project without it.
    useWorktreeStore.setState({ worktreesByProject: new Map() })
    loadWorktrees.mockImplementation(async () => seedWorktrees(['wt-other']))

    await expect(startRunMigrations(RUN)).rejects.toThrow(`The worktree of ${BRANCH} was archived`)

    expect(mocks.launchSessionWithModel).not.toHaveBeenCalled()
    expect(mocks.startMigrations).not.toHaveBeenCalled()
  })

  it('rejects a second start of the same run while the first is on its way', async () => {
    seedRun(finishedRun())
    const launch = deferred<SessionLaunchResult>()
    launchEnds(() => launch.promise)

    const first = startRunMigrations(RUN)
    await expect(startRunMigrations(RUN)).rejects.toThrow(
      'The migration session is already being started.'
    )
    launch.resolve({ success: true, sessionId: SESSION })
    await first

    expect(mocks.launchSessionWithModel).toHaveBeenCalledTimes(1)
    expect(mocks.startMigrations).toHaveBeenCalledTimes(1)
  })

  it('starts the sessions of two runs side by side', async () => {
    seedRun(finishedRun())
    seedRun(finishedRun({ id: 'run-2', integration_worktree_id: 'wt-2', integration_branch: 'b2' }))
    seedWorktrees([WORKTREE, 'wt-2'])
    const launch = deferred<SessionLaunchResult>()
    mocks.launchSessionWithModel.mockImplementation(() => launch.promise)

    const both = Promise.all([startRunMigrations(RUN), startRunMigrations('run-2')])
    launch.resolve({ success: true, sessionId: SESSION })
    await both

    expect(mocks.launchSessionWithModel).toHaveBeenCalledTimes(2)
  })

  it('can be started again after a start that failed', async () => {
    seedRun(finishedRun())
    mocks.launchSessionWithModel.mockResolvedValueOnce({ success: false, error: 'no provider' })

    await expect(startRunMigrations(RUN)).rejects.toThrow('no provider')
    await expect(startRunMigrations(RUN)).resolves.toBeUndefined()

    expect(runInStore().migration_session_id).toBe(SESSION)
  })

  it('rejects with the launch error when no session came of it, with nothing to clean up', async () => {
    seedRun(finishedRun())
    mocks.launchSessionWithModel.mockResolvedValue({ success: false, error: 'no provider' })

    await expect(startRunMigrations(RUN)).rejects.toThrow('no provider')

    expect(closeSession).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.endMigrations).not.toHaveBeenCalled()
    expect(runInStore().migration_session_id).toBeNull()
  })

  it('has a message of its own for a launch that failed without one', async () => {
    seedRun(finishedRun())
    mocks.launchSessionWithModel.mockResolvedValue({ success: false })

    await expect(startRunMigrations(RUN)).rejects.toThrow('The session could not be started.')
  })

  it('discards the session and releases the run when the agent could not be started', async () => {
    seedRun(finishedRun())
    seedSession(CLI_SESSION)
    launchEnds(() => ({ success: false, error: 'pty spawn failed', sessionId: SESSION }))

    await expect(startRunMigrations(RUN)).rejects.toThrow('pty spawn failed')

    // Its queued prompt is dropped and the session is closed, so no idle tab is left behind
    // that would run the migrations the moment someone opens it.
    expect(dequeuePendingMessage).toHaveBeenCalledTimes(1)
    expect(dequeuePendingMessage).toHaveBeenCalledWith(SESSION)
    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(dequeuePendingMessage.mock.invocationCallOrder[0]).toBeLessThan(
      closeSession.mock.invocationCallOrder[0]
    )
    // Closing a CLI destroys its process: no Escape is pressed in it first.
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.abort).not.toHaveBeenCalled()
    // It had been recorded: nothing would ever end it, so the run is released here.
    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    expect(runInStore().migration_session_id).toBeNull()
    expect(isMigrationSession(SESSION)).toBe(false)
  })

  it('aborts an SDK session it discards', async () => {
    seedRun(finishedRun())
    seedSession(SDK_SESSION)
    launchEnds(
      () => ({ success: false, error: 'Could not send prompt', sessionId: SESSION }),
      SDK_SESSION
    )

    await expect(startRunMigrations(RUN)).rejects.toThrow('Could not send prompt')

    expect(mocks.abort).toHaveBeenCalledTimes(1)
    expect(mocks.abort).toHaveBeenCalledWith(WORKTREE_PATH, OPENCODE_SESSION)
    expect(mocks.write).not.toHaveBeenCalled()
    // Dequeued, aborted, then closed.
    expect(dequeuePendingMessage).toHaveBeenCalledWith(SESSION)
    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(dequeuePendingMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.abort.mock.invocationCallOrder[0]
    )
    expect(mocks.abort.mock.invocationCallOrder[0]).toBeLessThan(
      closeSession.mock.invocationCallOrder[0]
    )
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
  })

  it('still closes the session and reports the launch error when it cannot be stopped or released', async () => {
    seedRun(finishedRun())
    seedSession(SDK_SESSION)
    launchEnds(
      () => ({ success: false, error: 'connect refused', sessionId: SESSION }),
      SDK_SESSION
    )
    mocks.abort.mockRejectedValue(new Error('WebSocket is not open'))
    mocks.endMigrations.mockRejectedValue(new Error('WebSocket is not open'))

    await expect(startRunMigrations(RUN)).rejects.toThrow('connect refused')

    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
  })

  it('reports the launch error when the session could not be closed either', async () => {
    seedRun(finishedRun())
    seedSession(CLI_SESSION)
    launchEnds(() => ({ success: false, error: 'pty spawn failed', sessionId: SESSION }))
    closeSession.mockRejectedValue(new Error('database is locked'))

    await expect(startRunMigrations(RUN)).rejects.toThrow('pty spawn failed')

    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    expect(runInStore().migration_session_id).toBeNull()
  })

  it('resolves quietly when the launch failed because the user had already stopped it', async () => {
    seedRun(finishedRun())
    seedSession(SDK_SESSION)
    launchEnds(async () => {
      // Stop is pressed while the prompt is on its way.
      await stopRunMigrations(RUN)
      return { success: false, error: 'Could not send prompt', sessionId: SESSION }
    }, SDK_SESSION)

    await expect(startRunMigrations(RUN)).resolves.toBeUndefined()

    // Released once, by the stop: the session is kept so what it did can be read.
    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(closeSession).not.toHaveBeenCalled()
    expect(dequeuePendingMessage).not.toHaveBeenCalled()
    expect(runInStore().migration_session_id).toBeNull()
  })

  it('keeps the session of a launch the server still records for the run', async () => {
    seedRun(finishedRun())
    seedSession(CLI_SESSION)

    await expect(startRunMigrations(RUN)).resolves.toBeUndefined()

    // The server is asked once the prompt was sent, not before.
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.get).toHaveBeenCalledWith(RUN)
    expect(mocks.launchSessionWithModel.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.get.mock.invocationCallOrder[0]
    )
    expect(dequeuePendingMessage).not.toHaveBeenCalled()
    expect(closeSession).not.toHaveBeenCalled()
    expect(mocks.abort).not.toHaveBeenCalled()
    expect(mocks.endMigrations).not.toHaveBeenCalled()
    expect(isMigrationSession(SESSION)).toBe(true)
  })

  it('discards the session of a launch that was stopped while its prompt was on its way', async () => {
    seedRun(finishedRun())
    seedSession(SDK_SESSION)
    launchEnds(async () => {
      // Stop is pressed before the agent has a turn to abort; the prompt starts one all the same.
      await stopRunMigrations(RUN)
      expect(closeSession).not.toHaveBeenCalled()
      return { success: true, sessionId: SESSION }
    }, SDK_SESSION)

    await expect(startRunMigrations(RUN)).resolves.toBeUndefined()

    // The agent that has started since is the run's no longer: it must not keep running.
    expect(dequeuePendingMessage).toHaveBeenCalledWith(SESSION)
    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(closeSession).toHaveBeenCalledWith(SESSION)
    // Aborted by the stop, and again as the session is discarded.
    expect(mocks.abort).toHaveBeenCalledTimes(2)
    // Released once, by the stop.
    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    expect(runInStore().migration_session_id).toBeNull()
    expect(isMigrationSession(SESSION)).toBe(false)
  })

  it.each([
    ['released the run', null],
    ['recorded another session for the run', 's-other']
  ] as const)(
    'discards the session when the server has %s, whatever this window holds',
    async (_name, serverSessionId) => {
      seedRun(finishedRun())
      seedSession(CLI_SESSION)
      // Another window stopped it: this window's copy of the run still names the session.
      mocks.get.mockImplementation(async (runId: string) =>
        serverDetail(runId, { migration_session_id: serverSessionId })
      )

      await expect(startRunMigrations(RUN)).resolves.toBeUndefined()

      // The server's answer replaces this window's copy, so the run stops showing the session.
      expect(runInStore().migration_session_id).toBe(serverSessionId)
      expect(dequeuePendingMessage).toHaveBeenCalledWith(SESSION)
      expect(closeSession).toHaveBeenCalledTimes(1)
      expect(closeSession).toHaveBeenCalledWith(SESSION)
      // A CLI is closed, not interrupted; the run is the server's to release, and it has.
      expect(mocks.write).not.toHaveBeenCalled()
      expect(mocks.endMigrations).not.toHaveBeenCalled()
    }
  )

  it('resolves when the session it discards after a stop could not be closed', async () => {
    seedRun(finishedRun())
    seedSession(SDK_SESSION)
    launchEnds(() => ({ success: true, sessionId: SESSION }), SDK_SESSION)
    mocks.get.mockImplementation(async (runId: string) =>
      serverDetail(runId, { migration_session_id: null })
    )
    mocks.abort.mockRejectedValue(new Error('WebSocket is not open'))
    closeSession.mockRejectedValue(new Error('database is locked'))

    await expect(startRunMigrations(RUN)).resolves.toBeUndefined()

    expect(closeSession).toHaveBeenCalledWith(SESSION)
  })

  it.each([
    [
      'could not be asked',
      (): unknown => mocks.get.mockRejectedValue(new Error('WebSocket is not open'))
    ],
    ['no longer knows the run', (): unknown => mocks.get.mockResolvedValue(null)]
  ])('changes nothing after the launch when the server %s', async (_name, answer) => {
    seedRun(finishedRun())
    seedSession(CLI_SESSION)
    answer()

    await expect(startRunMigrations(RUN)).resolves.toBeUndefined()

    expect(mocks.get).toHaveBeenCalledWith(RUN)
    expect(dequeuePendingMessage).not.toHaveBeenCalled()
    expect(closeSession).not.toHaveBeenCalled()
    expect(mocks.endMigrations).not.toHaveBeenCalled()
    expect(runInStore().migration_session_id).toBe(SESSION)
    expect(isMigrationSession(SESSION)).toBe(true)
  })

  it('fails the launch and discards the session when the server refuses to record it', async () => {
    seedRun(finishedRun())
    seedSession(CLI_SESSION)
    mocks.startMigrations.mockRejectedValue(
      new Error('Another session is executing the migrations of this run.')
    )

    await expect(startRunMigrations(RUN)).rejects.toThrow(
      'Another session is executing the migrations of this run.'
    )

    // The agent was never started (the launch ends where the hook throws).
    expect(closeSession).toHaveBeenCalledWith(SESSION)
    // Never recorded: the run is held by the other session, which this must not release.
    expect(mocks.endMigrations).not.toHaveBeenCalled()
    expect(runInStore().migration_session_id).toBeNull()
    expect(isMigrationSession(SESSION)).toBe(false)
  })
})

describe('stopRunMigrations', () => {
  it('aborts an SDK session in its worktree, then releases the run', async () => {
    seedRun(migratingRun())
    seedSession(SDK_SESSION)

    await stopRunMigrations(RUN)

    expect(mocks.abort).toHaveBeenCalledTimes(1)
    expect(mocks.abort).toHaveBeenCalledWith(WORKTREE_PATH, OPENCODE_SESSION)
    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    expect(mocks.abort.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.endMigrations.mock.invocationCallOrder[0]
    )
    expect(runInStore()).toMatchObject({ migration_session_id: null, migration_started_at: null })
    expect(mocks.write).not.toHaveBeenCalled()
    // The session is kept: what it did until then can be read.
    expect(closeSession).not.toHaveBeenCalled()
  })

  describe('of a CLI session', () => {
    const POLL_MS = 100

    /** The session reports the end of its turn, as of now unless `overrides` says otherwise. */
    const turnEnds = (overrides: Partial<SessionStatusEntry> = {}): void =>
      setStatus(SESSION, completed({ timestamp: Date.now(), ...overrides }))

    /** Press Stop and let the Escape reach the session; `stopping` is still waiting on it. */
    const pressStop = async (): Promise<{ stopping: Promise<void> }> => {
      const stopping = stopRunMigrations(RUN)
      // Settled by the test: not an unhandled rejection in the meantime.
      stopping.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.write).toHaveBeenCalledTimes(1)
      expect(mocks.write).toHaveBeenCalledWith(SESSION, '\x1b')
      return { stopping }
    }

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
      seedRun(migratingRun())
      seedSession(CLI_SESSION)
    })

    it.each(['claude-code-cli', 'codex-cli'] as const)(
      'presses Escape in a %s session instead of the abort RPC',
      async (agent_sdk) => {
        seedSession(makeSession({ agent_sdk }))

        const { stopping } = await pressStop()
        // Nothing is released before the session has answered the Escape.
        expect(mocks.endMigrations).not.toHaveBeenCalled()
        turnEnds({ reason: 'user_interrupt' })
        await vi.advanceTimersByTimeAsync(POLL_MS)
        await stopping

        expect(mocks.write).toHaveBeenCalledTimes(1)
        expect(mocks.abort).not.toHaveBeenCalled()
        expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
        expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
        expect(runInStore().migration_session_id).toBeNull()
        // The session is kept: what it did until then can be read.
        expect(closeSession).not.toHaveBeenCalled()
      }
    )

    it.each(['user_interrupt', 'codex_turn_aborted', 'user_abort'])(
      'keeps the session open once it reports the interrupt (%s)',
      async (reason) => {
        const { stopping } = await pressStop()
        await vi.advanceTimersByTimeAsync(10 * POLL_MS)
        expect(mocks.endMigrations).not.toHaveBeenCalled()

        turnEnds({ reason })
        await vi.advanceTimersByTimeAsync(POLL_MS)
        await stopping

        // Seen on the next look, well within the wait.
        expect(Date.now() - NOW).toBeLessThan(CLI_INTERRUPT_WAIT_MS)
        expect(closeSession).not.toHaveBeenCalled()
        expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
      }
    )

    it('closes a session that did not report the interrupt in time', async () => {
      // Still starting, or parked between turns: Escape interrupts nothing.
      setStatus(SESSION, { status: 'working', timestamp: NOW - 30_000 })

      const { stopping } = await pressStop()
      await vi.advanceTimersByTimeAsync(CLI_INTERRUPT_WAIT_MS - 1)
      expect(closeSession).not.toHaveBeenCalled()
      expect(mocks.endMigrations).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await stopping

      expect(mocks.write).toHaveBeenCalledTimes(1)
      expect(closeSession).toHaveBeenCalledTimes(1)
      expect(closeSession).toHaveBeenCalledWith(SESSION)
      expect(closeSession.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.endMigrations.mock.invocationCallOrder[0]
      )
      expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
      expect(runInStore().migration_session_id).toBeNull()
    })

    it.each([
      ['it has no status at all', (): void => undefined],
      [
        'the interrupt it reports is from before the Escape',
        (): void => turnEnds({ timestamp: NOW - 1, reason: 'user_interrupt' })
      ],
      ['its turn ended by itself, not by the interrupt', (): void => turnEnds()],
      [
        'its interrupted turn left background work going',
        (): void => {
          turnEnds({ reason: 'user_interrupt' })
          useWorktreeStatusStore.setState({
            backgroundWorkBySession: {
              [SESSION]: { runningShells: 1, runningMonitors: 0, runningSubagents: 0 }
            }
          })
        }
      ]
    ])('closes the session when %s', async (_name, report) => {
      const { stopping } = await pressStop()
      report()
      await vi.advanceTimersByTimeAsync(CLI_INTERRUPT_WAIT_MS)
      await stopping

      expect(closeSession).toHaveBeenCalledTimes(1)
      expect(closeSession).toHaveBeenCalledWith(SESSION)
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    })

    it('keeps the session open for an interrupt reported in the instant of the Escape', async () => {
      const { stopping } = await pressStop()
      turnEnds({ timestamp: NOW, reason: 'user_interrupt' })
      await vi.advanceTimersByTimeAsync(CLI_INTERRUPT_WAIT_MS)
      await stopping

      expect(closeSession).not.toHaveBeenCalled()
    })

    it.each([
      ['with its cause', { success: false, error: 'pty is gone' }, 'pty is gone'],
      ['with a message of its own', { success: false }, 'The session did not stop.']
    ] as const)(
      'releases the run but rejects %s when the session could not be closed either',
      async (_name, closed, cause) => {
        closeSession.mockResolvedValue(closed)

        const { stopping } = await pressStop()
        await vi.advanceTimersByTimeAsync(CLI_INTERRUPT_WAIT_MS)

        await expect(stopping).rejects.toThrow(
          `The run was released, but its migration session could not be stopped (${cause}). Open the session to stop it.`
        )
        expect(closeSession).toHaveBeenCalledWith(SESSION)
        expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
        expect(runInStore().migration_session_id).toBeNull()
      }
    )
  })

  it('releases the run but rejects with a message when the session did not stop', async () => {
    seedRun(migratingRun())
    seedSession(SDK_SESSION)
    mocks.abort.mockResolvedValue({ success: true, value: { success: false } })

    await expect(stopRunMigrations(RUN)).rejects.toThrow(
      'The run was released, but its migration session could not be stopped (The session did not stop.). Open the session to stop it.'
    )

    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    expect(runInStore().migration_session_id).toBeNull()
  })

  it('releases the run but rejects with the cause when the abort RPC failed', async () => {
    seedRun(migratingRun())
    seedSession(SDK_SESSION)
    mocks.abort.mockRejectedValue(new Error('WebSocket is not open'))

    await expect(stopRunMigrations(RUN)).rejects.toThrow(
      /could not be stopped \(WebSocket is not open\)/
    )

    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    expect(runInStore().migration_session_id).toBeNull()
  })

  it('releases the run when the session no longer exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedRun(migratingRun())

    await expect(stopRunMigrations(RUN)).resolves.toBeUndefined()

    expect(mocks.abort).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    warn.mockRestore()
  })

  it('releases the run of an SDK session that was never connected', async () => {
    seedRun(migratingRun())
    seedSession(makeSession({ agent_sdk: 'claude-code', opencode_session_id: null }))

    await expect(stopRunMigrations(RUN)).resolves.toBeUndefined()

    expect(mocks.abort).not.toHaveBeenCalled()
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
  })

  it('leaves the run migrating when the server could not be told', async () => {
    seedRun(migratingRun())
    seedSession(SDK_SESSION)
    mocks.endMigrations.mockRejectedValue(new Error('WebSocket is not open'))

    await expect(stopRunMigrations(RUN)).rejects.toThrow('WebSocket is not open')

    expect(runInStore().migration_session_id).toBe(SESSION)
    expect(isMigrationSession(SESSION)).toBe(true)
  })

  it.each([
    ['has no migration session', (): unknown => seedRun(finishedRun())],
    ['is not loaded', (): unknown => undefined]
  ])('does nothing for a run that %s', async (_name, seed) => {
    seed()
    seedSession(CLI_SESSION)

    await expect(stopRunMigrations(RUN)).resolves.toBeUndefined()

    expect(mocks.abort).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.endMigrations).not.toHaveBeenCalled()
  })
})

describe('isMigrationSession', () => {
  it('knows the session recorded on a loaded run', () => {
    seedRun(finishedRun({ id: 'run-0' }))
    seedRun(migratingRun())

    expect(isMigrationSession(SESSION)).toBe(true)
  })

  it('knows a session it just launched, before the server has recorded it', async () => {
    seedRun(finishedRun())
    const seen: boolean[] = []
    mocks.launchSessionWithModel.mockImplementation(async (spec: SessionLaunchSpec) => {
      await spec.onSessionCreated?.({ session: CLI_SESSION, customProviderId: null, model: null })
      return { success: true, sessionId: SESSION }
    })
    // Renamed before it is recorded: the run in the store does not name it yet.
    updateSessionName.mockImplementation(async () => {
      seen.push(runInStore().migration_session_id === null, isMigrationSession(SESSION))
      return true
    })

    expect(isMigrationSession(SESSION)).toBe(false)
    await startRunMigrations(RUN)

    expect(seen).toEqual([true, true])
    expect(isMigrationSession(SESSION)).toBe(true)
  })

  it('is false for any other session', () => {
    seedRun(migratingRun())
    seedRun(finishedRun({ id: 'run-2' }))

    expect(isMigrationSession('s-ticket')).toBe(false)
    expect(isMigrationSession('')).toBe(false)
  })

  it('forgets the session once the run was released', async () => {
    seedRun(migratingRun())
    seedSession(SDK_SESSION)

    await stopRunMigrations(RUN)

    expect(isMigrationSession(SESSION)).toBe(false)
  })
})

describe('observeMigrationSession', () => {
  const observe = (now = NOW): ReturnType<typeof observeMigrationSession> =>
    observeMigrationSession(SESSION, STARTED_AT, now)

  it('is unknown for a session the page has no status for', () => {
    expect(observe()).toEqual({ kind: 'unknown' })
  })

  it.each(['working', 'planning'] as const)('is running while the session is %s', (status) => {
    setStatus(SESSION, { status, timestamp: NOW - 30_000 })
    expect(observe()).toEqual({ kind: 'running' })
  })

  it.each(['answering', 'permission', 'command_approval', 'plan_ready'] as const)(
    'is running while the session waits for the user (%s)',
    (status) => {
      setStatus(SESSION, { status, timestamp: NOW - 30_000 })
      expect(observe()).toEqual({ kind: 'running' })
    }
  )

  it('is running while a question of the session is pending, whatever its status', () => {
    setStatus(SESSION, completed())
    useQuestionStore.getState().addQuestion(SESSION, {
      id: 'q-1',
      sessionID: SESSION,
      questions: [{ question: 'Run 0043 too?', header: 'Migration', options: [] }]
    })

    expect(observe()).toEqual({ kind: 'running' })
  })

  it.each([
    ['the SessionStart hook', { hookEventName: 'SessionStart' }],
    ['the start of the process', { reason: 'pty_start' }]
  ])('does not read the completed of %s as an end', (_name, overrides) => {
    setStatus(SESSION, completed(overrides))
    expect(observe()).toEqual({ kind: 'running' })
  })

  it('is running while the agent paused for its own background work', () => {
    setStatus(SESSION, completed({ completion: 'waiting' }))
    expect(observe()).toEqual({ kind: 'running' })
  })

  it('lets a fresh end settle before it counts', () => {
    const at = NOW - 1_000
    setStatus(SESSION, completed({ timestamp: at }))

    expect(observe()).toEqual({ kind: 'settling', until: at + MIGRATION_SETTLE_MS })
    expect(observe(at + MIGRATION_SETTLE_MS - 1)).toEqual({
      kind: 'settling',
      until: at + MIGRATION_SETTLE_MS
    })
    expect(observe(at + MIGRATION_SETTLE_MS)).toEqual({ kind: 'over', outcome: 'finished' })
  })

  it('is over and finished once the end has settled', () => {
    setStatus(SESSION, completed())
    // Nothing says the agent did not finish its turn.
    expect(observe()).toStrictEqual({ kind: 'over', outcome: 'finished' })
  })

  it('reads an end without a Stop hook as finished too, but as one that died', () => {
    setStatus(SESSION, completed({ completion: 'none', reason: 'pty_exit' }))
    expect(observe()).toEqual({ kind: 'over', outcome: 'finished', died: true })
  })

  it.each([
    ['carries an API error', { apiError: 'Overloaded' }],
    ['had no Stop hook end its turn', { completion: 'none' }],
    ['is the exit of the process', { reason: 'pty_exit' }],
    ['was published by the SessionEnd hook', { hookEventName: 'SessionEnd' }]
  ] as const)('marks an end that %s as died', (_name, overrides) => {
    setStatus(SESSION, completed(overrides))
    expect(observe()).toEqual({ kind: 'over', outcome: 'finished', died: true })
  })

  it('marks an end as died for an API error the session reported apart from it', () => {
    setStatus(SESSION, completed())
    useWorktreeStatusStore.setState({ sessionApiErrors: { [SESSION]: 'Overloaded' } })

    expect(observe()).toEqual({ kind: 'over', outcome: 'finished', died: true })
  })

  it('lets an end that died settle like any other', () => {
    const at = NOW - 1_000
    setStatus(SESSION, completed({ timestamp: at, completion: 'none', reason: 'pty_exit' }))

    expect(observe()).toEqual({ kind: 'settling', until: at + MIGRATION_SETTLE_MS })
  })

  it.each(['user_interrupt', 'codex_turn_aborted'])(
    'is over and stopped when the end carries the reason %s',
    (reason) => {
      setStatus(SESSION, completed({ reason }))
      expect(observe()).toEqual({ kind: 'over', outcome: 'stopped' })
    }
  )

  it.each(['user_interrupt', 'codex_turn_aborted', 'user_abort'])(
    'is stopped, not died, when a %s end looks like the process going away',
    (reason) => {
      setStatus(
        SESSION,
        completed({
          reason,
          completion: 'none',
          hookEventName: 'SessionEnd',
          apiError: 'Overloaded'
        })
      )
      expect(observe()).toStrictEqual({ kind: 'over', outcome: 'stopped' })
    }
  )

  it('is over and stopped when the user aborted an SDK session', () => {
    vi.useFakeTimers()
    seedSession(SDK_SESSION)
    setStatus(SESSION, { status: 'working', timestamp: NOW - 30_000 })
    vi.setSystemTime(NOW - 10_010)
    markSessionAborted(OPENCODE_SESSION)
    setStatus(SESSION, { status: 'completed', timestamp: NOW - 10_000, word: 'Stopped' })

    expect(observe()).toEqual({ kind: 'over', outcome: 'stopped' })
  })

  it('keeps reading an end after the entry was cleared by opening the worktree', () => {
    setStatus(SESSION, completed())
    expect(observe()).toEqual({ kind: 'over', outcome: 'finished' })
    setStatus(SESSION, null)

    expect(observe()).toEqual({ kind: 'over', outcome: 'finished' })
  })

  it('is unknown for an end from before the session was recorded', () => {
    setStatus(SESSION, completed({ timestamp: STARTED_AT - 1 }))
    expect(observe()).toEqual({ kind: 'unknown' })

    setStatus(SESSION, completed({ timestamp: STARTED_AT }))
    expect(observe()).toEqual({ kind: 'over', outcome: 'finished' })
  })
})

describe('startMigrationWatcher', () => {
  const TICK_MS = 100
  let stop: (() => void) | null = null

  const watch = (): void => {
    stop = startMigrationWatcher()
  }

  const turn = (overrides: Partial<SessionFinalMessage> = {}): SessionFinalMessage => ({
    session_id: SESSION,
    state: 'ended',
    text: 'Ran 0042 and 0043.',
    completion: 'completed',
    api_error: null,
    hook_event: 'Stop',
    detail: null,
    updated_at: new Date(NOW - 10_000).toISOString(),
    ...overrides
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    stop?.()
    stop = null
  })

  it('reports a session whose turn ended as finished, once', async () => {
    seedRun(migratingRun())
    setStatus(SESSION, completed())
    watch()

    expect(mocks.endMigrations).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(TICK_MS)

    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'finished')
    expect(runInStore().migration_session_id).toBeNull()
    expect(isMigrationSession(SESSION)).toBe(false)
    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
    expect(mocks.toast.success).toHaveBeenCalledWith(
      expect.stringContaining('The migration session of Checkout redesign finished.')
    )

    // Later ticks see a run that is no longer migrating.
    await vi.advanceTimersByTimeAsync(3 * MIGRATION_POLL_MS)
    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
    // The page saw the session itself: the server's record of its turn is not needed.
    expect(mocks.sessionGet).not.toHaveBeenCalled()
    expect(mocks.sessionTurn).not.toHaveBeenCalled()
  })

  it('does not report again while the first report is on its way', async () => {
    seedRun(migratingRun())
    setStatus(SESSION, completed())
    const report = deferred<DocumentRunDetail>()
    mocks.endMigrations.mockReturnValue(report.promise)
    watch()

    await vi.advanceTimersByTimeAsync(TICK_MS)
    // More ticks: a status of another session, a change of the runs, the poll.
    setStatus('s-other', { status: 'working', timestamp: Date.now() })
    seedRun(finishedRun({ id: 'run-2' }))
    await vi.advanceTimersByTimeAsync(2 * MIGRATION_POLL_MS)
    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)

    report.resolve(serverDetail(RUN, { migration_session_id: null, migration_started_at: null }))
    await vi.advanceTimersByTimeAsync(2 * MIGRATION_POLL_MS)

    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(runInStore().migration_session_id).toBeNull()
  })

  it('asks again on a later tick when the report did not reach the server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedRun(migratingRun())
    setStatus(SESSION, completed())
    mocks.endMigrations.mockRejectedValueOnce(new Error('WebSocket is not open'))
    watch()

    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(runInStore().migration_session_id).toBe(SESSION)
    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MIGRATION_POLL_MS)
    expect(mocks.endMigrations).toHaveBeenCalledTimes(2)
    expect(mocks.endMigrations).toHaveBeenLastCalledWith(RUN, SESSION, 'finished')
    expect(runInStore().migration_session_id).toBeNull()
    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
  })

  it('reports a session the user stopped in its own tab as stopped', async () => {
    seedRun(migratingRun({ title: '' }))
    setStatus(SESSION, completed({ reason: 'user_interrupt' }))
    watch()

    await vi.advanceTimersByTimeAsync(TICK_MS)

    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    expect(mocks.toast.info).toHaveBeenCalledWith(
      'The migration session of the document run was stopped.'
    )
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it.each([
    ['an API error', { apiError: 'Overloaded' }],
    ['no Stop hook', { completion: 'none' }],
    ['the exit of its process', { reason: 'pty_exit' }],
    ['the SessionEnd hook', { hookEventName: 'SessionEnd' }]
  ] as const)(
    'reports a session that ended with %s as finished, with a warning instead',
    async (_name, overrides) => {
      seedRun(migratingRun())
      setStatus(SESSION, completed(overrides))
      watch()

      await vi.advanceTimersByTimeAsync(TICK_MS)

      expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'finished')
      expect(runInStore().migration_session_id).toBeNull()
      expect(mocks.toast.warning).toHaveBeenCalledTimes(1)
      expect(mocks.toast.warning).toHaveBeenCalledWith(
        'The migration session of Checkout redesign ended before it was done. Open it to see how far it got.'
      )
      expect(mocks.toast.success).not.toHaveBeenCalled()
      expect(mocks.toast.info).not.toHaveBeenCalled()
    }
  )

  it('names a run without a title in the warning of a session that died', async () => {
    seedRun(migratingRun({ title: '' }))
    setStatus(SESSION, completed({ completion: 'none', reason: 'pty_exit' }))
    watch()

    await vi.advanceTimersByTimeAsync(TICK_MS)

    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'The migration session of the document run ended before it was done. Open it to see how far it got.'
    )
  })

  it('reports a session the user stopped as stopped, even when its process went with it', async () => {
    seedRun(migratingRun())
    setStatus(SESSION, completed({ reason: 'user_interrupt', hookEventName: 'SessionEnd' }))
    watch()

    await vi.advanceTimersByTimeAsync(TICK_MS)

    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    expect(mocks.toast.info).toHaveBeenCalledTimes(1)
    expect(mocks.toast.warning).not.toHaveBeenCalled()
  })

  describe('while this page stops the session', () => {
    it('stands back from an end that settles while a CLI session is given time to stop', async () => {
      // The turn ended by itself two seconds before Stop was pressed: Escape interrupts nothing.
      seedRun(migratingRun())
      seedSession(CLI_SESSION)
      setStatus(SESSION, completed({ timestamp: NOW - 2_000 }))
      watch()
      await vi.advanceTimersByTimeAsync(TICK_MS)
      expect(mocks.endMigrations).not.toHaveBeenCalled()

      const stopping = stopRunMigrations(RUN)
      // The end settles, and the watcher wakes for it, while the stop still waits.
      await vi.advanceTimersByTimeAsync(MIGRATION_SETTLE_MS - 2_000 + 2 * TICK_MS)
      expect(mocks.endMigrations).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(CLI_INTERRUPT_WAIT_MS)
      await stopping

      // One end, the stop's own: not also the watcher's, with its toast.
      expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
      expect(runInStore().migration_session_id).toBeNull()
      await vi.advanceTimersByTimeAsync(3 * MIGRATION_POLL_MS)
      expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
      expect(mocks.toast.success).not.toHaveBeenCalled()
      expect(mocks.toast.info).not.toHaveBeenCalled()
      expect(mocks.toast.warning).not.toHaveBeenCalled()
    })

    it('stands back while the abort of an SDK session is on its way', async () => {
      seedRun(migratingRun())
      seedSession(SDK_SESSION)
      setStatus(SESSION, completed())
      const abort = deferred<{ success: true; value: { success: boolean } }>()
      mocks.abort.mockReturnValue(abort.promise)

      const stopping = stopRunMigrations(RUN)
      watch()
      await vi.advanceTimersByTimeAsync(3 * MIGRATION_POLL_MS)
      expect(mocks.abort).toHaveBeenCalledTimes(1)
      expect(mocks.endMigrations).not.toHaveBeenCalled()
      expect(mocks.sessionGet).not.toHaveBeenCalled()

      abort.resolve({ success: true, value: { success: true } })
      await stopping
      await vi.advanceTimersByTimeAsync(3 * MIGRATION_POLL_MS)

      expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
      expect(mocks.toast.success).not.toHaveBeenCalled()
    })

    it('follows the run again after a stop that could not reach the server', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      seedRun(migratingRun())
      seedSession(SDK_SESSION)
      setStatus(SESSION, { status: 'working', timestamp: NOW - 30_000 })
      mocks.endMigrations.mockRejectedValueOnce(new Error('WebSocket is not open'))
      watch()

      await expect(stopRunMigrations(RUN)).rejects.toThrow('WebSocket is not open')
      expect(runInStore().migration_session_id).toBe(SESSION)

      // The aborted turn ends; the watcher is no longer told to stand back.
      setStatus(SESSION, completed({ timestamp: Date.now(), reason: 'user_abort' }))
      await vi.advanceTimersByTimeAsync(MIGRATION_SETTLE_MS + 2 * TICK_MS)

      expect(mocks.endMigrations).toHaveBeenCalledTimes(2)
      expect(mocks.endMigrations).toHaveBeenLastCalledWith(RUN, SESSION, 'stopped')
      expect(runInStore().migration_session_id).toBeNull()
      expect(mocks.toast.info).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })
  })

  it.each([
    ['working', { status: 'working', timestamp: NOW - 30_000 }],
    ['waiting for an answer', { status: 'answering', timestamp: NOW - 30_000 }],
    ['paused for background work', completed({ completion: 'waiting' })],
    ['only just started', completed({ hookEventName: 'SessionStart' })]
  ] as const)('reports nothing while the session is %s', async (_name, entry) => {
    seedRun(migratingRun())
    setStatus(SESSION, entry)
    watch()

    await vi.advanceTimersByTimeAsync(3 * MIGRATION_POLL_MS)

    expect(mocks.endMigrations).not.toHaveBeenCalled()
    expect(mocks.sessionGet).not.toHaveBeenCalled()
    expect(mocks.sessionTurn).not.toHaveBeenCalled()
    expect(runInStore().migration_session_id).toBe(SESSION)
  })

  it('follows a session from working to its end', async () => {
    seedRun(migratingRun())
    setStatus(SESSION, { status: 'working', timestamp: NOW - 30_000 })
    watch()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.endMigrations).not.toHaveBeenCalled()

    // The end wakes the watcher by itself, and counts once it has settled.
    setStatus(SESSION, completed({ timestamp: Date.now() }))
    await vi.advanceTimersByTimeAsync(MIGRATION_SETTLE_MS - 1)
    expect(mocks.endMigrations).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2 * TICK_MS + 1)
    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'finished')
  })

  it('reports nothing for an end the session bounced out of while it settled', async () => {
    seedRun(migratingRun())
    setStatus(SESSION, completed({ timestamp: NOW - 1_000 }))
    watch()
    await vi.advanceTimersByTimeAsync(1_000)

    setStatus(SESSION, { status: 'working', timestamp: Date.now() })
    await vi.advanceTimersByTimeAsync(MIGRATION_POLL_MS)

    expect(mocks.endMigrations).not.toHaveBeenCalled()
  })

  it('follows every loaded run, each with its own session', async () => {
    seedRun(migratingRun())
    seedRun(migratingRun({ id: 'run-2', title: 'Factory area', migration_session_id: 's-2' }))
    seedRun(finishedRun({ id: 'run-3' }))
    setStatus(SESSION, { status: 'working', timestamp: NOW - 30_000 })
    setStatus('s-2', completed())
    watch()

    await vi.advanceTimersByTimeAsync(TICK_MS)

    expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.endMigrations).toHaveBeenCalledWith('run-2', 's-2', 'finished')
    expect(runInStore().migration_session_id).toBe(SESSION)
    expect(runInStore('run-2').migration_session_id).toBeNull()
  })

  it('picks up a run that starts migrating after the watcher was mounted', async () => {
    seedRun(finishedRun())
    watch()
    await vi.advanceTimersByTimeAsync(MIGRATION_POLL_MS)
    expect(mocks.endMigrations).not.toHaveBeenCalled()

    setStatus(SESSION, completed({ timestamp: Date.now() - MIGRATION_SETTLE_MS }))
    seedRun(migratingRun({ migration_started_at: new Date(Date.now() - 30_000).toISOString() }))
    await vi.advanceTimersByTimeAsync(TICK_MS)

    expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'finished')
  })

  describe('a session this page has no status for', () => {
    it('is stopped when its row is gone', async () => {
      seedRun(migratingRun())
      watch()

      await vi.advanceTimersByTimeAsync(TICK_MS)

      expect(mocks.sessionGet).toHaveBeenCalledWith(SESSION)
      expect(mocks.sessionTurn).not.toHaveBeenCalled()
      expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
      expect(runInStore().migration_session_id).toBeNull()
    })

    it('is stopped when its row was closed', async () => {
      seedRun(migratingRun())
      mocks.sessionGet.mockResolvedValue(makeSession({ status: 'completed' }))
      watch()

      await vi.advanceTimersByTimeAsync(TICK_MS)

      expect(mocks.sessionTurn).not.toHaveBeenCalled()
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    })

    it('reads the row from the session store when the page has it loaded', async () => {
      seedRun(migratingRun())
      seedSession(makeSession({ status: 'completed' }))
      watch()

      await vi.advanceTimersByTimeAsync(TICK_MS)

      expect(mocks.sessionGet).not.toHaveBeenCalled()
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
    })

    it('is finished when the server recorded a turn end since the session was started', async () => {
      seedRun(migratingRun())
      mocks.sessionGet.mockResolvedValue(makeSession())
      mocks.sessionTurn.mockResolvedValue(turn())
      watch()

      await vi.advanceTimersByTimeAsync(TICK_MS)

      expect(mocks.sessionTurn).toHaveBeenCalledWith(SESSION)
      expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'finished')
      expect(mocks.toast.success).toHaveBeenCalledTimes(1)
    })

    it('is stopped when the recorded end is an interrupt', async () => {
      seedRun(migratingRun())
      mocks.sessionGet.mockResolvedValue(makeSession())
      mocks.sessionTurn.mockResolvedValue(turn({ hook_event: 'Interrupt', completion: null }))
      watch()

      await vi.advanceTimersByTimeAsync(TICK_MS)

      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'stopped')
      expect(mocks.toast.info).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['no turn was recorded', null],
      ['the recorded turn is still working', turn({ state: 'working', hook_event: 'SdkBusy' })],
      ['the recorded turn is blocked on a question', turn({ state: 'blocked' })],
      ['the record is the SessionStart of the process', turn({ hook_event: 'SessionStart' })],
      ['the agent paused for background work', turn({ completion: 'waiting' })],
      [
        'the recorded end is older than the session start',
        turn({ updated_at: new Date(STARTED_AT - 1_000).toISOString() })
      ],
      ['the recorded end has not settled yet', turn({ updated_at: new Date(NOW).toISOString() })],
      ['the recorded end has no readable time', turn({ updated_at: 'not a date' })]
    ] as const)('reports nothing when %s', async (_name, recorded) => {
      seedRun(migratingRun())
      mocks.sessionGet.mockResolvedValue(makeSession())
      mocks.sessionTurn.mockResolvedValue(recorded)
      watch()

      await vi.advanceTimersByTimeAsync(TICK_MS)

      expect(mocks.sessionTurn).toHaveBeenCalledTimes(1)
      expect(mocks.endMigrations).not.toHaveBeenCalled()
      expect(runInStore().migration_session_id).toBe(SESSION)
    })

    it('looks an end from before the session start up on the server', async () => {
      seedRun(migratingRun())
      // A stale status of the page: says nothing about the turn the launch started.
      setStatus(SESSION, completed({ timestamp: STARTED_AT - 5_000 }))
      mocks.sessionGet.mockResolvedValue(makeSession())
      mocks.sessionTurn.mockResolvedValue(turn())
      watch()

      await vi.advanceTimersByTimeAsync(TICK_MS)

      expect(mocks.sessionTurn).toHaveBeenCalledWith(SESSION)
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'finished')
    })

    it('asks the server once per poll, however often it ticks', async () => {
      seedRun(migratingRun())
      mocks.sessionGet.mockResolvedValue(makeSession())
      mocks.sessionTurn.mockResolvedValue(turn({ state: 'working', hook_event: 'SdkBusy' }))
      watch()

      await vi.advanceTimersByTimeAsync(TICK_MS)
      expect(mocks.sessionTurn).toHaveBeenCalledTimes(1)

      // Ticks in between do not ask again.
      for (let index = 0; index < 5; index += 1) {
        setStatus(`s-other-${index}`, { status: 'working', timestamp: Date.now() })
        await vi.advanceTimersByTimeAsync(1_000)
      }
      expect(mocks.sessionTurn).toHaveBeenCalledTimes(1)
      expect(mocks.sessionGet).toHaveBeenCalledTimes(1)

      // The next poll does, and finds the turn ended in the meantime.
      mocks.sessionTurn.mockResolvedValue(turn({ updated_at: new Date(Date.now()).toISOString() }))
      await vi.advanceTimersByTimeAsync(MIGRATION_POLL_MS)

      expect(mocks.sessionTurn).toHaveBeenCalledTimes(2)
      expect(mocks.endMigrations).toHaveBeenCalledTimes(1)
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'finished')
    })

    it('reports nothing when the server could not be asked, and asks again on the next poll', async () => {
      seedRun(migratingRun())
      mocks.sessionGet.mockRejectedValueOnce(new Error('WebSocket is not open'))
      watch()

      await vi.advanceTimersByTimeAsync(TICK_MS)
      expect(mocks.sessionGet).toHaveBeenCalledTimes(1)
      expect(mocks.endMigrations).not.toHaveBeenCalled()

      mocks.sessionGet.mockResolvedValue(makeSession())
      mocks.sessionTurn.mockResolvedValue(turn())
      await vi.advanceTimersByTimeAsync(MIGRATION_POLL_MS)

      expect(mocks.sessionGet).toHaveBeenCalledTimes(2)
      expect(mocks.endMigrations).toHaveBeenCalledWith(RUN, SESSION, 'finished')
    })
  })

  describe('once stopped', () => {
    it('no longer follows the runs or the session statuses', async () => {
      seedRun(migratingRun())
      setStatus(SESSION, { status: 'working', timestamp: NOW - 30_000 })
      watch()
      await vi.advanceTimersByTimeAsync(TICK_MS)

      stop?.()
      setStatus(SESSION, completed())
      seedRun(migratingRun({ id: 'run-2', migration_session_id: 's-2' }))
      setStatus('s-2', completed())
      await vi.advanceTimersByTimeAsync(3 * MIGRATION_POLL_MS)

      expect(mocks.endMigrations).not.toHaveBeenCalled()
      expect(mocks.sessionGet).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('drops the tick that was already scheduled', async () => {
      seedRun(migratingRun())
      setStatus(SESSION, completed())
      watch()

      stop?.()
      await vi.advanceTimersByTimeAsync(MIGRATION_POLL_MS)

      expect(mocks.endMigrations).not.toHaveBeenCalled()
    })

    it('drops the wake-up of an end that was settling', async () => {
      seedRun(migratingRun())
      setStatus(SESSION, completed({ timestamp: NOW - 1_000 }))
      watch()
      await vi.advanceTimersByTimeAsync(TICK_MS)

      stop?.()
      await vi.advanceTimersByTimeAsync(MIGRATION_POLL_MS)

      expect(mocks.endMigrations).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('ignores the answer of a lookup that was on its way', async () => {
      seedRun(migratingRun())
      const row = deferred<Session | null>()
      mocks.sessionGet.mockReturnValue(row.promise)
      watch()
      await vi.advanceTimersByTimeAsync(TICK_MS)
      expect(mocks.sessionGet).toHaveBeenCalledTimes(1)

      stop?.()
      row.resolve(null)
      await vi.advanceTimersByTimeAsync(MIGRATION_POLL_MS)

      expect(mocks.endMigrations).not.toHaveBeenCalled()
    })
  })
})
