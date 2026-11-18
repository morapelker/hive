import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRD_FLOW_CLI_LEAD } from '@shared/document-flow/prd-flow'
import type { DocumentRunDetail, SessionFinalMessage } from '@shared/types/document-flow'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { resetSessionSignalLatchForTests } from '@/lib/document-flow/session-signal'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { resolveDocumentFlowGeneration, useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { beginKanbanMutation, useKanbanStore } from '@/stores/useKanbanStore'
import { usePrdFlowStore, type PrdFlow } from '@/stores/usePrdFlowStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore, type SessionStatusEntry } from '@/stores/useWorktreeStatusStore'
import type { KanbanTicket, Session } from '../../../../main/db/types'
import { APP_STARTED_AT_TTL_MS, createLivePrdFlowPorts } from './live-ports'

// The PRD flow driver's ports against the real stores and a fake RPC client: each port reaches
// the store or the server call it is meant to, and the ones a flow's fate hangs on are exact.
// A ticket is only ever "gone" on the word of a board read made after it was missed, or of the
// database saying its project is no more; the app's start time is asked sparingly and is 0 when
// it is not known; a prompt finds a session on a connection instance after a restart, and one
// that is not delivered leaves no working status behind; the orchestrator run is created
// without touching an open wizard.

const mocks = vi.hoisted(() => ({
  sendFollowupToSession: vi.fn(),
  isPrdFlowLaunching: vi.fn(),
  discardPrdFlowLaunch: vi.fn(),
  markRunAwaitingPrefs: vi.fn(),
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
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }))
vi.mock('@/lib/session-followup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-followup')>()),
  sendFollowupToSession: mocks.sendFollowupToSession
}))
vi.mock('@/lib/hive-enterprise-telemetry', () => ({
  startHivePromptTelemetry: vi.fn()
}))
vi.mock('@/components/document-flow/useRunConfigDraft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/document-flow/useRunConfigDraft')>()),
  markRunAwaitingPrefs: mocks.markRunAwaitingPrefs
}))
vi.mock('./start', () => ({
  isPrdFlowLaunching: mocks.isPrdFlowLaunching,
  discardPrdFlowLaunch: mocks.discardPrdFlowLaunch
}))

const PROJECT = 'project-shop'
const TICKET = 'ticket-prd'
const SESSION = 's-prd'
const CONNECTION = 'conn-base'
const TASKS_PATH = '/repo/shop/CODE_MODE_TASKS.html'
const TOP_OF_COLUMN = 512

const NOW = Date.parse('2026-11-18T09:00:00.000Z')
const APP_STARTED = '2026-11-18T08:00:00.000Z'
/** When the flow was started: a quarter of an hour before `NOW`. */
const FLOW_STARTED = NOW - 900_000

const initialFlowState = usePrdFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialSessionState = useSessionStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialStatusState = useWorktreeStatusStore.getState()
const initialQuestionState = useQuestionStore.getState()
const initialDocumentFlowState = useDocumentFlowStore.getState()

function makeFlow(overrides: Partial<PrdFlow> = {}): PrdFlow {
  return {
    ticketId: TICKET,
    projectId: PROJECT,
    name: 'Code mode',
    prefix: 'CODE_MODE',
    prompt: 'Build a code mode.',
    research: true,
    clarify: true,
    launch: { sdk: 'claude-code-cli', model: null, codexFastMode: false, customProviderId: null },
    checkout: { kind: 'worktree', worktreeId: 'wt-main' },
    cwd: '/repo/shop',
    memberDirs: [],
    sessionId: SESSION,
    stage: 'prd',
    status: 'running',
    attention: null,
    detail: null,
    promptedAt: NOW - 600_000,
    reprompts: 0,
    resumes: 0,
    waitingSince: null,
    retryAt: null,
    forcePrompt: false,
    prdPath: null,
    tasksPath: null,
    runId: null,
    createdAt: FLOW_STARTED,
    ...overrides
  }
}

const connectionFlow = (overrides: Partial<PrdFlow> = {}): PrdFlow =>
  makeFlow({
    checkout: { kind: 'connection', connectionId: CONNECTION },
    cwd: '/connections/suite-base',
    memberDirs: ['web', 'api'],
    ...overrides
  })

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: TICKET,
    project_id: PROJECT,
    title: 'Code mode',
    column: 'in_progress',
    sort_order: 0,
    current_session_id: SESSION,
    archived_at: null,
    ticket_number: 12,
    ...overrides
  } as KanbanTicket
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    worktree_id: 'wt-main',
    project_id: PROJECT,
    connection_id: null,
    name: 'PRD — Code mode',
    status: 'active',
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    ...overrides
  } as Session
}

function setStatus(sessionId: string, entry: SessionStatusEntry | null): void {
  useWorktreeStatusStore.setState((state) => ({
    sessionStatuses: { ...state.sessionStatuses, [sessionId]: entry }
  }))
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Lets what a port started without being awaited (a board read) run as far as it can. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

/** What the server answers, by method; a test replaces the answers it is about. */
let server: Record<string, (params: never) => unknown>
let request: ReturnType<typeof vi.fn>
const calls = (method: string): unknown[] =>
  request.mock.calls.filter(([called]) => called === method).map(([, params]) => params)

beforeAll(
  () =>
    // Absorb the settings store's one-shot import timer so it cannot reset state mid-test.
    new Promise((resolve) => setTimeout(resolve, 220))
)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  resetSessionSignalLatchForTests()
  usePrdFlowStore.setState(initialFlowState, true)
  useKanbanStore.setState({ ...initialKanbanState, tickets: new Map() }, true)
  useSessionStore.setState(
    { ...initialSessionState, sessionsByWorktree: new Map(), sessionsByConnection: new Map() },
    true
  )
  useConnectionStore.setState({ ...initialConnectionState, connections: [] }, true)
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
  useDocumentFlowStore.setState({ ...initialDocumentFlowState, runsById: {} }, true)

  server = {
    'documentFlow.appStartedAt': () => APP_STARTED,
    'documentFlow.sessionTurn': () => null,
    'documentFlow.list': () => [],
    'worktreeOps.exists': () => false,
    'db.session.get': () => null,
    'db.project.get': ({ id }: { id: string }) => ({ id, name: 'Shop' }),
    'terminalOps.getLiveTerminalIds': () => ({ terminalIds: [] })
  }
  request = vi.fn(async (method: string, params: never) => server[method]?.(params))
  resetRendererRpcClientForTests()
  setRendererRpcClient({ request, subscribe: vi.fn() })
  mocks.sendFollowupToSession.mockResolvedValue(undefined)
  mocks.isPrdFlowLaunching.mockReturnValue(false)
  mocks.discardPrdFlowLaunch.mockResolvedValue(false)
})

afterEach(() => {
  vi.useRealTimers()
  resetRendererRpcClientForTests()
})

describe('the flows', () => {
  it('reads, patches and removes the flows of the store', () => {
    const ports = createLivePrdFlowPorts()
    const flow = makeFlow()
    const other = makeFlow({ ticketId: 'ticket-other' })
    usePrdFlowStore.getState().putFlow(flow)
    usePrdFlowStore.getState().putFlow(other)

    expect(ports.flows()).toEqual([flow, other])
    expect(ports.flow(TICKET)).toBe(flow)
    expect(ports.flow('ticket-plain')).toBeNull()

    ports.patch(TICKET, { stage: 'tasks', prdPath: '/repo/shop/CODE_MODE_PRD.html' })
    expect(ports.flow(TICKET)).toEqual({
      ...flow,
      stage: 'tasks',
      prdPath: '/repo/shop/CODE_MODE_PRD.html'
    })
    expect(usePrdFlowStore.getState().flows[TICKET]).toBe(ports.flow(TICKET))

    ports.remove(TICKET)
    expect(ports.flow(TICKET)).toBeNull()
    expect(ports.flows()).toEqual([other])
  })

  it('tells the time', () => {
    expect(createLivePrdFlowPorts().now()).toBe(NOW)
  })

  it('knows a flow whose session this page is starting', () => {
    const ports = createLivePrdFlowPorts()
    mocks.isPrdFlowLaunching.mockImplementation((ticketId: string) => ticketId === TICKET)

    expect(ports.isLaunching(TICKET)).toBe(true)
    expect(ports.isLaunching('ticket-other')).toBe(false)
  })
})

describe('ticket', () => {
  /** What the server has of the project's board; a read puts it in the store. */
  let onServer: KanbanTicket[]
  let loadTickets: ReturnType<typeof vi.fn>

  const onPage = (tickets: KanbanTicket[]): void => {
    useKanbanStore.setState((state) => ({ tickets: new Map(state.tickets).set(PROJECT, tickets) }))
  }

  beforeEach(() => {
    onServer = []
    loadTickets = vi.fn(async (projectId: string) => {
      useKanbanStore.setState((state) => ({
        tickets: new Map(state.tickets).set(projectId, onServer)
      }))
    })
    useKanbanStore.setState({ loadTickets } as never)
  })

  it('reads the ticket off the board: its column, its session and whether it can have a parent', () => {
    const ports = createLivePrdFlowPorts()
    onPage([makeTicket({ id: 'ticket-other', column: 'done' }), makeTicket()])

    expect(ports.ticket(makeFlow())).toEqual({
      state: 'present',
      column: 'in_progress',
      archived: false,
      sessionId: SESSION,
      linkable: true
    })
    expect(loadTickets).not.toHaveBeenCalled()
  })

  it('reads an archived ticket, one without a session and one of a board without ticket rows', () => {
    const ports = createLivePrdFlowPorts()
    onPage([
      makeTicket({
        column: 'review',
        archived_at: '2026-11-18T08:30:00.000Z',
        current_session_id: null,
        ticket_number: null
      })
    ])

    expect(ports.ticket(makeFlow())).toEqual({
      state: 'present',
      column: 'review',
      archived: true,
      sessionId: null,
      linkable: false
    })
  })

  it('says nothing of a ticket on a board this page never read, and reads that board', async () => {
    const ports = createLivePrdFlowPorts()
    onServer = [makeTicket()]

    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()

    expect(loadTickets).toHaveBeenCalledTimes(1)
    // A board that could not be read must not pass for an empty one.
    expect(loadTickets).toHaveBeenCalledWith(PROJECT, { rethrow: true })
    expect(ports.ticket(makeFlow())).toMatchObject({ state: 'present', column: 'in_progress' })
  })

  it('reads a board once however often it is asked while the read is on its way', async () => {
    const ports = createLivePrdFlowPorts()
    const reading = deferred<void>()
    loadTickets.mockReturnValue(reading.promise)

    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()
    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()

    expect(loadTickets).toHaveBeenCalledTimes(1)
    reading.resolve()
  })

  it('calls the ticket gone only when a read of its board came back without it', async () => {
    const ports = createLivePrdFlowPorts()
    const reading = deferred<void>()
    loadTickets.mockReturnValue(reading.promise)
    // An empty list is on the page before any read: not the word of the board.
    onPage([])

    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()
    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })

    reading.resolve()
    await settle()

    expect(ports.ticket(makeFlow())).toEqual({ state: 'gone' })
    expect(ports.ticket(makeFlow())).toEqual({ state: 'gone' })
    expect(loadTickets).toHaveBeenCalledTimes(1)
  })

  it('does not believe a list that lost the ticket: a new read decides', async () => {
    const ports = createLivePrdFlowPorts()
    onPage([makeTicket()])
    expect(ports.ticket(makeFlow())).toMatchObject({ state: 'present' })

    // An older read landed over the ticket's creation; the server still has the ticket.
    onServer = [makeTicket()]
    onPage([])

    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()

    expect(loadTickets).toHaveBeenCalledTimes(1)
    expect(ports.ticket(makeFlow())).toMatchObject({ state: 'present' })
  })

  it('reads the board again for a ticket that was deleted after an earlier read', async () => {
    const ports = createLivePrdFlowPorts()
    const other = makeFlow({ ticketId: 'ticket-other' })
    // The board was read once, for another flow, and its ticket was gone.
    expect(ports.ticket(other)).toEqual({ state: 'loading' })
    await settle()
    expect(ports.ticket(other)).toEqual({ state: 'gone' })

    onPage([makeTicket()])
    expect(ports.ticket(makeFlow())).toMatchObject({ state: 'present' })
    onPage([])

    // That earlier read says nothing of this ticket.
    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()
    expect(loadTickets).toHaveBeenCalledTimes(2)
    expect(ports.ticket(makeFlow())).toEqual({ state: 'gone' })
  })

  it('knows nothing after a read that failed, and reads again on the next look', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ports = createLivePrdFlowPorts()
    loadTickets.mockRejectedValueOnce(new Error('WebSocket is not open'))

    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()
    expect(loadTickets).toHaveBeenCalledTimes(1)

    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()
    expect(loadTickets).toHaveBeenCalledTimes(2)
    expect(ports.ticket(makeFlow())).toEqual({ state: 'gone' })
    warn.mockRestore()
  })

  describe('a board that cannot be read', () => {
    const boardIsGone = (): void => {
      loadTickets.mockRejectedValue(new Error(`Project not found: ${PROJECT}`))
    }

    it('calls the ticket gone when the database says its project was deleted: that board is never read again', async () => {
      const ports = createLivePrdFlowPorts()
      const other = makeFlow({ ticketId: 'ticket-other' })
      boardIsGone()
      server['db.project.get'] = () => null

      expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
      expect(ports.ticket(other)).toEqual({ state: 'loading' })
      await settle()

      expect(calls('db.project.get')).toEqual([{ id: PROJECT }])
      expect(ports.ticket(makeFlow())).toEqual({ state: 'gone' })
      expect(ports.ticket(other)).toEqual({ state: 'gone' })
      // Settled: the board is not read over and over for them.
      await settle()
      expect(loadTickets).toHaveBeenCalledTimes(1)
    })

    it('knows nothing while the project is still there, whatever the read failed with', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ports = createLivePrdFlowPorts()
      boardIsGone()

      expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
      await settle()

      expect(calls('db.project.get')).toEqual([{ id: PROJECT }])
      // Not gone: the next look reads the board again.
      expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
      await settle()
      expect(loadTickets).toHaveBeenCalledTimes(2)
      warn.mockRestore()
    })

    it.each([
      [
        'could not be asked',
        () => {
          throw new Error('WebSocket is not open')
        }
      ],
      ['answered nothing', () => undefined]
    ])('knows nothing when the database %s about the project', async (_what, answer) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ports = createLivePrdFlowPorts()
      boardIsGone()
      server['db.project.get'] = answer

      expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
      await settle()

      // Not gone: the next look reads the board again.
      expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
      await settle()
      expect(loadTickets).toHaveBeenCalledTimes(2)
      warn.mockRestore()
    })

    it('does not ask about the project after a board read that worked', async () => {
      const ports = createLivePrdFlowPorts()

      expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
      await settle()

      expect(ports.ticket(makeFlow())).toEqual({ state: 'gone' })
      expect(calls('db.project.get')).toEqual([])
    })
  })

  it('waits for a board write in flight before it reads: that list would predate the write', async () => {
    const ports = createLivePrdFlowPorts()
    const written = beginKanbanMutation(PROJECT)

    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()
    expect(loadTickets).not.toHaveBeenCalled()

    onServer = [makeTicket()]
    written()
    await settle()

    expect(loadTickets).toHaveBeenCalledTimes(1)
    expect(ports.ticket(makeFlow())).toMatchObject({ state: 'present' })
  })

  it('settles two tickets missed in the same look with one read', async () => {
    const ports = createLivePrdFlowPorts()
    const other = makeFlow({ ticketId: 'ticket-other' })
    onServer = [makeTicket()]

    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    expect(ports.ticket(other)).toEqual({ state: 'loading' })
    await settle()

    expect(loadTickets).toHaveBeenCalledTimes(1)
    expect(ports.ticket(makeFlow())).toMatchObject({ state: 'present' })
    expect(ports.ticket(other)).toEqual({ state: 'gone' })
  })

  it('gives a ticket missed while a read is on its way a read of its own', async () => {
    const ports = createLivePrdFlowPorts()
    const other = makeFlow({ ticketId: 'ticket-other' })
    const reading = deferred<void>()
    loadTickets.mockReturnValueOnce(reading.promise)

    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()
    // Missed after the read was sent: what it answers may be older than this miss.
    expect(ports.ticket(other)).toEqual({ state: 'loading' })
    reading.resolve()
    await settle()

    expect(ports.ticket(makeFlow())).toEqual({ state: 'gone' })
    expect(ports.ticket(other)).toEqual({ state: 'loading' })
    await settle()
    expect(loadTickets).toHaveBeenCalledTimes(2)
    expect(ports.ticket(other)).toEqual({ state: 'gone' })
  })

  it('reads each project of its own', async () => {
    const ports = createLivePrdFlowPorts()
    const elsewhere = makeFlow({ ticketId: 'ticket-api', projectId: 'project-api' })

    ports.ticket(makeFlow())
    ports.ticket(elsewhere)
    await settle()

    expect(loadTickets.mock.calls.map(([projectId]) => projectId)).toEqual([PROJECT, 'project-api'])
  })

  it('finds a ticket that came back after it was gone, and forgets that it was', async () => {
    const ports = createLivePrdFlowPorts()
    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()
    expect(ports.ticket(makeFlow())).toEqual({ state: 'gone' })

    onPage([makeTicket()])
    expect(ports.ticket(makeFlow())).toMatchObject({ state: 'present' })
    onPage([])

    // Missing again is a new question.
    expect(ports.ticket(makeFlow())).toEqual({ state: 'loading' })
  })

  it('keeps what one set of ports learnt to itself', async () => {
    const first = createLivePrdFlowPorts()
    expect(first.ticket(makeFlow())).toEqual({ state: 'loading' })
    await settle()
    expect(first.ticket(makeFlow())).toEqual({ state: 'gone' })

    // A page that mounts the driver again starts from what it can see for itself.
    expect(createLivePrdFlowPorts().ticket(makeFlow())).toEqual({ state: 'loading' })
  })
})

describe('moving and linking the ticket', () => {
  let moveTicket: ReturnType<typeof vi.fn>
  let updateTicket: ReturnType<typeof vi.fn>
  let computeSortOrder: ReturnType<typeof vi.fn>

  beforeEach(() => {
    moveTicket = vi.fn(async () => undefined)
    updateTicket = vi.fn(async () => undefined)
    computeSortOrder = vi.fn(() => TOP_OF_COLUMN)
    useKanbanStore.setState({ moveTicket, updateTicket, computeSortOrder } as never)
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT,
          [makeTicket(), makeTicket({ id: 'ticket-reviewed', column: 'review', sort_order: 9 })]
        ]
      ])
    })
  })

  it.each(['in_progress', 'review'] as const)(
    'puts the ticket at the top of "%s" without closing or reviving its session',
    async (column) => {
      await createLivePrdFlowPorts().moveTicket(makeFlow(), column)

      expect(computeSortOrder).toHaveBeenCalledWith([expect.objectContaining({ column })], 0)
      expect(moveTicket).toHaveBeenCalledTimes(1)
      expect(moveTicket).toHaveBeenCalledWith(TICKET, PROJECT, column, TOP_OF_COLUMN, {
        skipCompletionEffects: true,
        keepSession: true
      })
    }
  )

  it('rejects when the move was refused', async () => {
    moveTicket.mockRejectedValue(new Error('database is locked'))

    await expect(createLivePrdFlowPorts().moveTicket(makeFlow(), 'review')).rejects.toThrow(
      'database is locked'
    )
  })

  it("makes the ticket a child of the orchestrator's, and changes nothing else on it", async () => {
    await createLivePrdFlowPorts().linkToRun(makeFlow(), 'ticket-run')

    expect(updateTicket).toHaveBeenCalledTimes(1)
    expect(updateTicket).toHaveBeenCalledWith(TICKET, PROJECT, { parent_ticket_id: 'ticket-run' })
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

describe('the session', () => {
  it('reads the turn of the session off this page', () => {
    const ports = createLivePrdFlowPorts()
    expect(ports.signal(SESSION)).toEqual({ kind: 'unknown' })

    setStatus(SESSION, { status: 'working', timestamp: NOW - 5_000 })
    expect(ports.signal(SESSION)).toEqual({ kind: 'working', since: NOW - 5_000 })
  })

  it('remembers a turn that ended from the moment the ports exist, also once the page forgot it', () => {
    const ports = createLivePrdFlowPorts()
    setStatus(SESSION, { status: 'completed', timestamp: NOW - 10_000, completion: 'completed' })
    // Opening the session's worktree clears the entry.
    setStatus(SESSION, null)

    expect(ports.signal(SESSION)).toMatchObject({ kind: 'ended', at: NOW - 10_000 })
  })

  it("asks the main process for the session's recorded turn", async () => {
    const turn: SessionFinalMessage = {
      session_id: SESSION,
      state: 'ended',
      text: 'Done.',
      completion: 'completed',
      api_error: null,
      hook_event: 'Stop',
      detail: null,
      background_work: null,
      updated_at: '2026-11-18T08:55:00.000Z'
    }
    server['documentFlow.sessionTurn'] = () => turn

    await expect(createLivePrdFlowPorts().sessionTurn(SESSION)).resolves.toEqual(turn)
    expect(calls('documentFlow.sessionTurn')).toEqual([{ sessionId: SESSION }])
  })

  describe('isSessionClosed', () => {
    it.each([
      ['an open session', 'active', false],
      ['a closed session', 'completed', true]
    ] as const)('reads %s off the page', async (_what, status, closed) => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-main', [makeSession({ status })]]])
      })

      await expect(createLivePrdFlowPorts().isSessionClosed(SESSION)).resolves.toBe(closed)
      expect(calls('db.session.get')).toEqual([])
    })

    it('reads a session this page has not loaded from the database', async () => {
      server['db.session.get'] = () => makeSession({ status: 'completed' })

      await expect(createLivePrdFlowPorts().isSessionClosed(SESSION)).resolves.toBe(true)
      expect(calls('db.session.get')).toEqual([{ id: SESSION }])
    })

    it('does not take a session that has no row for a closed one', async () => {
      await expect(createLivePrdFlowPorts().isSessionClosed(SESSION)).resolves.toBe(false)
    })
  })

  describe('appStartedAt', () => {
    it('answers when the app started, in milliseconds', async () => {
      await expect(createLivePrdFlowPorts().appStartedAt()).resolves.toBe(Date.parse(APP_STARTED))
      expect(calls('documentFlow.appStartedAt')).toEqual([{}])
    })

    it('asks once for every look inside five seconds, and again after that', async () => {
      const ports = createLivePrdFlowPorts()

      await ports.appStartedAt()
      vi.setSystemTime(NOW + APP_STARTED_AT_TTL_MS - 1)
      await ports.appStartedAt()
      expect(calls('documentFlow.appStartedAt')).toHaveLength(1)

      vi.setSystemTime(NOW + APP_STARTED_AT_TTL_MS)
      server['documentFlow.appStartedAt'] = () => '2026-11-18T08:59:00.000Z'
      await expect(ports.appStartedAt()).resolves.toBe(Date.parse('2026-11-18T08:59:00.000Z'))
      expect(calls('documentFlow.appStartedAt')).toHaveLength(2)
    })

    it('asks once for two looks made before the first answer', async () => {
      const ports = createLivePrdFlowPorts()

      const answers = await Promise.all([ports.appStartedAt(), ports.appStartedAt()])

      expect(answers).toEqual([Date.parse(APP_STARTED), Date.parse(APP_STARTED)])
      expect(calls('documentFlow.appStartedAt')).toHaveLength(1)
    })

    it('answers 0 when the main process could not be asked', async () => {
      server['documentFlow.appStartedAt'] = () => {
        throw new Error('WebSocket is not open')
      }

      await expect(createLivePrdFlowPorts().appStartedAt()).resolves.toBe(0)
    })

    it.each([['not a date'], [''], [undefined], [null]])(
      'answers 0 when the answer (%j) is not a date',
      async (answer) => {
        server['documentFlow.appStartedAt'] = () => answer

        await expect(createLivePrdFlowPorts().appStartedAt()).resolves.toBe(0)
      }
    )

    it('asks again after five seconds when it could not be told', async () => {
      const ports = createLivePrdFlowPorts()
      server['documentFlow.appStartedAt'] = () => {
        throw new Error('WebSocket is not open')
      }
      await expect(ports.appStartedAt()).resolves.toBe(0)

      server['documentFlow.appStartedAt'] = () => APP_STARTED
      await expect(ports.appStartedAt()).resolves.toBe(0)
      vi.setSystemTime(NOW + APP_STARTED_AT_TTL_MS)
      await expect(ports.appStartedAt()).resolves.toBe(Date.parse(APP_STARTED))
    })
  })

  describe('sendPrompt', () => {
    it("sends the prompt into the flow's session as the app, in build mode, with the session's own model", async () => {
      await createLivePrdFlowPorts().sendPrompt(makeFlow(), 'Perfect. lets create the tasks now.')

      expect(mocks.sendFollowupToSession).toHaveBeenCalledTimes(1)
      expect(mocks.sendFollowupToSession).toHaveBeenCalledWith({
        sessionId: SESSION,
        prompt: 'Perfect. lets create the tasks now.',
        followUpMode: 'build',
        ticketId: TICKET,
        preserveSessionModel: true,
        cliLead: PRD_FLOW_CLI_LEAD
      })
    })

    it('rejects for a flow that has no session, and sends nothing', async () => {
      await expect(
        createLivePrdFlowPorts().sendPrompt(makeFlow({ sessionId: null }), 'continue')
      ).rejects.toThrow('The flow has no session to prompt.')
      expect(mocks.sendFollowupToSession).not.toHaveBeenCalled()
    })

    it('rejects when the prompt was not delivered', async () => {
      mocks.sendFollowupToSession.mockRejectedValue(new Error('Failed to start CLI session'))

      await expect(createLivePrdFlowPorts().sendPrompt(makeFlow(), 'continue')).rejects.toThrow(
        'Failed to start CLI session'
      )
    })

    describe('the working status the follow-up writes before it delivers the prompt', () => {
      /** The follow-up as lib/session-followup runs it: the status first, then the delivery. */
      const followUp = (deliver: () => void): void => {
        mocks.sendFollowupToSession.mockImplementation(async ({ sessionId }) => {
          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
          deliver()
        })
      }

      it('is taken back when the prompt was not delivered, and the rejection is passed on', async () => {
        const ports = createLivePrdFlowPorts()
        // The turn before the prompt had ended.
        setStatus(SESSION, {
          status: 'completed',
          timestamp: NOW - 60_000,
          completion: 'completed'
        })
        followUp(() => {
          throw new Error('Failed to start CLI session')
        })

        await expect(ports.sendPrompt(makeFlow(), 'continue')).rejects.toThrow(
          'Failed to start CLI session'
        )

        expect(useWorktreeStatusStore.getState().sessionStatuses[SESSION]).toBeUndefined()
        // The session is not taken for at work on a prompt it never got.
        expect(ports.signal(SESSION)).toEqual({ kind: 'unknown' })
      })

      it('stands when the prompt was delivered', async () => {
        const ports = createLivePrdFlowPorts()
        followUp(() => {})

        await ports.sendPrompt(makeFlow(), 'continue')

        expect(ports.signal(SESSION)).toEqual({ kind: 'working', since: NOW })
      })
    })

    it('does not load connections or session rows for a session in a worktree', async () => {
      const loadConnections = vi.fn(async () => undefined)
      useConnectionStore.setState({ loadConnections })

      await createLivePrdFlowPorts().sendPrompt(makeFlow(), 'continue')

      expect(loadConnections).not.toHaveBeenCalled()
      expect(calls('db.session.get')).toEqual([])
    })

    describe('a session on a connection instance', () => {
      const row = makeSession({ worktree_id: null, connection_id: CONNECTION })
      const instance = { id: CONNECTION, path: '/connections/suite-base', status: 'active' }
      let loadConnections: ReturnType<typeof vi.fn>

      beforeEach(() => {
        loadConnections = vi.fn(async () => {
          useConnectionStore.setState({ connections: [instance] as never })
        })
        useConnectionStore.setState({ loadConnections } as never)
        server['db.session.get'] = () => row
      })

      it('puts the instance and the session row on the page before it sends, as after a restart', async () => {
        mocks.sendFollowupToSession.mockImplementation(async () => {
          // The follow-up finds the session's directory through these two.
          expect(useConnectionStore.getState().connections).toEqual([instance])
          expect(useSessionStore.getState().getSessionById(SESSION)).toEqual(row)
        })

        await createLivePrdFlowPorts().sendPrompt(connectionFlow(), 'continue')

        expect(loadConnections).toHaveBeenCalledTimes(1)
        expect(calls('db.session.get')).toEqual([{ id: SESSION }])
        expect(useSessionStore.getState().sessionsByConnection.get(CONNECTION)).toEqual([row])
        expect(mocks.sendFollowupToSession).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: SESSION, prompt: 'continue' })
        )
      })

      it('loads nothing that the page already has', async () => {
        useConnectionStore.setState({ connections: [instance] as never })
        useSessionStore.setState({ sessionsByConnection: new Map([[CONNECTION, [row]]]) })

        await createLivePrdFlowPorts().sendPrompt(connectionFlow(), 'continue')

        expect(loadConnections).not.toHaveBeenCalled()
        expect(calls('db.session.get')).toEqual([])
        expect(mocks.sendFollowupToSession).toHaveBeenCalledTimes(1)
      })

      it('still sends when the session has no row left: the follow-up says what is wrong', async () => {
        server['db.session.get'] = () => null
        mocks.sendFollowupToSession.mockRejectedValue(new Error(`Session not found: ${SESSION}`))

        await expect(
          createLivePrdFlowPorts().sendPrompt(connectionFlow(), 'continue')
        ).rejects.toThrow(`Session not found: ${SESSION}`)
      })
    })
  })
})

describe('what a prompt or a launch left behind', () => {
  it('drops the status this page holds of a session, and of that session alone', () => {
    const ports = createLivePrdFlowPorts()
    setStatus(SESSION, { status: 'working', timestamp: NOW - 200_000 })
    setStatus('s-other', { status: 'working', timestamp: NOW - 5_000 })

    ports.forgetSessionStatus(SESSION)

    expect(ports.signal(SESSION)).toEqual({ kind: 'unknown' })
    expect(ports.signal('s-other')).toEqual({ kind: 'working', since: NOW - 5_000 })
  })

  it('tells the driver that the status went, so that it looks again', () => {
    const ports = createLivePrdFlowPorts()
    setStatus(SESSION, { status: 'working', timestamp: NOW - 200_000 })
    const listener = vi.fn()
    const stop = ports.subscribe(listener)

    ports.forgetSessionStatus(SESSION)

    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })

  describe('isSessionStarted', () => {
    beforeEach(() => {
      useSessionStore.setState({ sessionsByWorktree: new Map([['wt-main', [makeSession()]]]) })
    })

    it('knows a CLI session whose process is live for started', async () => {
      server['terminalOps.getLiveTerminalIds'] = () => ({ terminalIds: ['s-other', SESSION] })

      await expect(createLivePrdFlowPorts().isSessionStarted(SESSION)).resolves.toBe(true)
    })

    it('knows a CLI session that has no process for one that was never started', async () => {
      server['terminalOps.getLiveTerminalIds'] = () => ({ terminalIds: ['s-other'] })

      await expect(createLivePrdFlowPorts().isSessionStarted(SESSION)).resolves.toBe(false)
    })

    it('rejects when the processes could not be listed: that is not "never started"', async () => {
      server['terminalOps.getLiveTerminalIds'] = () => {
        throw new Error('WebSocket is not open')
      }

      await expect(createLivePrdFlowPorts().isSessionStarted(SESSION)).rejects.toThrow(
        'WebSocket is not open'
      )
    })
  })

  it('has the session of a cut-off launch closed and its ticket put back, as a failed launch does', async () => {
    const flow = makeFlow({ stage: 'launching' })
    mocks.discardPrdFlowLaunch.mockResolvedValue(false)

    await expect(createLivePrdFlowPorts().discardLaunch(flow, SESSION)).resolves.toBe(false)

    expect(mocks.discardPrdFlowLaunch).toHaveBeenCalledTimes(1)
    expect(mocks.discardPrdFlowLaunch).toHaveBeenCalledWith(flow, SESSION)
  })

  it('says so when the ticket still points at that session afterwards', async () => {
    mocks.discardPrdFlowLaunch.mockResolvedValue(true)

    await expect(
      createLivePrdFlowPorts().discardLaunch(makeFlow({ stage: 'launching' }), SESSION)
    ).resolves.toBe(true)
  })
})

describe('files and the orchestrator', () => {
  const detail = (run: Partial<DocumentRunDetail['run']>): DocumentRunDetail =>
    makeDetail({ project_id: PROJECT, source_path: TASKS_PATH, ...run }, [])

  it('asks the server whether a file exists', async () => {
    const ports = createLivePrdFlowPorts()
    server['worktreeOps.exists'] = ({ worktreePath }: { worktreePath: string }) =>
      worktreePath === TASKS_PATH

    await expect(ports.fileExists(TASKS_PATH)).resolves.toBe(true)
    await expect(ports.fileExists('/repo/shop/CODE_MODE_PRD.html')).resolves.toBe(false)
    expect(calls('worktreeOps.exists')).toEqual([
      { worktreePath: TASKS_PATH },
      { worktreePath: '/repo/shop/CODE_MODE_PRD.html' }
    ])
  })

  describe('findRun', () => {
    it("finds the run already made from the flow's tasks document, the newest first", async () => {
      server['documentFlow.list'] = () => [
        detail({ id: 'run-other', source_path: '/repo/shop/CHECKOUT_TASKS.html' }),
        detail({
          id: 'run-newest',
          ticket_id: 'ticket-run',
          created_at: new Date(NOW - 60_000).toISOString()
        }),
        detail({ id: 'run-older', created_at: new Date(NOW - 120_000).toISOString() })
      ]

      await expect(createLivePrdFlowPorts().findRun(makeFlow(), TASKS_PATH)).resolves.toEqual({
        runId: 'run-newest',
        ticketId: 'ticket-run'
      })
      expect(calls('documentFlow.list')).toEqual([{ projectId: PROJECT }])
      // Looked up, not adopted: the store is the runner's to fill.
      expect(useDocumentFlowStore.getState().runsById).toEqual({})
    })

    it('answers a run whose board ticket could not be written without one', async () => {
      server['documentFlow.list'] = () => [
        detail({ id: 'run-1', ticket_id: null, created_at: new Date(NOW).toISOString() })
      ]

      await expect(createLivePrdFlowPorts().findRun(makeFlow(), TASKS_PATH)).resolves.toEqual({
        runId: 'run-1',
        ticketId: null
      })
    })

    it('finds nothing when no run was made from that document', async () => {
      server['documentFlow.list'] = () => [
        detail({ id: 'run-other', source_path: '/repo/shop/CHECKOUT_TASKS.html' })
      ]

      await expect(createLivePrdFlowPorts().findRun(makeFlow(), TASKS_PATH)).resolves.toBeNull()
    })

    it('does not take a run older than the flow, made from an earlier document of that name', async () => {
      server['documentFlow.list'] = () => [
        detail({ id: 'run-old', created_at: new Date(FLOW_STARTED - 1).toISOString() })
      ]

      await expect(createLivePrdFlowPorts().findRun(makeFlow(), TASKS_PATH)).resolves.toBeNull()
    })

    it('rejects when the runs could not be listed', async () => {
      server['documentFlow.list'] = () => {
        throw new Error('WebSocket is not open')
      }

      await expect(createLivePrdFlowPorts().findRun(makeFlow(), TASKS_PATH)).rejects.toThrow(
        'WebSocket is not open'
      )
    })
  })

  describe('createRun', () => {
    const created = detail({ id: 'run-new', status: 'extracting', ticket_id: 'ticket-run' })

    beforeEach(() => {
      server['documentFlow.createRun'] = () => created
    })

    it('creates the run from the tasks document where it lies, with the generation model', async () => {
      await expect(createLivePrdFlowPorts().createRun(makeFlow(), TASKS_PATH)).resolves.toEqual({
        runId: 'run-new',
        ticketId: 'ticket-run'
      })

      // No `documentName`: the file is used in place, not copied.
      expect(calls('documentFlow.createRun')).toEqual([
        {
          projectId: PROJECT,
          documentPath: TASKS_PATH,
          generation: resolveDocumentFlowGeneration()
        }
      ])
    })

    it('shows the run on this page at once, to get the remembered settings when it is first opened', async () => {
      await createLivePrdFlowPorts().createRun(makeFlow(), TASKS_PATH)

      expect(useDocumentFlowStore.getState().runsById).toEqual({ 'run-new': created })
      expect(mocks.markRunAwaitingPrefs).toHaveBeenCalledTimes(1)
      expect(mocks.markRunAwaitingPrefs).toHaveBeenCalledWith('run-new')
    })

    it('leaves a wizard that is open on another run where it is', async () => {
      const wizard = { open: true, projectId: 'project-api', runId: 'run-open' }
      useDocumentFlowStore.setState({ wizard })

      await createLivePrdFlowPorts().createRun(makeFlow(), TASKS_PATH)

      expect(useDocumentFlowStore.getState().wizard).toEqual(wizard)
    })

    it('rejects, and shows no run, when the server refused the document', async () => {
      server['documentFlow.createRun'] = () => {
        throw new Error('The document is empty.')
      }

      await expect(createLivePrdFlowPorts().createRun(makeFlow(), TASKS_PATH)).rejects.toThrow(
        'The document is empty.'
      )
      expect(useDocumentFlowStore.getState().runsById).toEqual({})
      expect(mocks.markRunAwaitingPrefs).not.toHaveBeenCalled()
    })
  })
})

describe('notify', () => {
  it.each(['success', 'info', 'warning', 'error'] as const)(
    'says a "%s" notice as a toast',
    (level) => {
      createLivePrdFlowPorts().notify(level, 'PRD flow of “Code mode” stopped.')

      expect(mocks.toast[level]).toHaveBeenCalledTimes(1)
      expect(mocks.toast[level]).toHaveBeenCalledWith('PRD flow of “Code mode” stopped.')
    }
  )
})

describe('subscribe', () => {
  const changes: [string, () => void][] = [
    ['a flow changes', () => usePrdFlowStore.getState().putFlow(makeFlow())],
    ['a session changes status', () => setStatus(SESSION, { status: 'working', timestamp: NOW })],
    [
      'a turn ends on an API error',
      () => useWorktreeStatusStore.setState({ sessionApiErrors: { [SESSION]: 'overloaded' } })
    ],
    [
      'a session starts or ends background work',
      () => useWorktreeStatusStore.setState({ backgroundWorkBySession: { [SESSION]: {} as never } })
    ],
    [
      'a question is asked or answered',
      () => useQuestionStore.setState({ pendingBySession: new Map([[SESSION, []]]) })
    ],
    ['the board changes', () => useKanbanStore.setState({ tickets: new Map([[PROJECT, []]]) })]
  ]

  it.each(changes)('calls back when %s', (_what, change) => {
    const listener = vi.fn()
    const stop = createLivePrdFlowPorts().subscribe(listener)

    change()

    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })

  it('keeps quiet about what the driver does not read', () => {
    const listener = vi.fn()
    const stop = createLivePrdFlowPorts().subscribe(listener)

    usePrdFlowStore.getState().openDialog(PROJECT)
    usePrdFlowStore.getState().setLaunchPref(null)
    useKanbanStore.setState({ isLoading: true })
    useWorktreeStatusStore.setState({ lastMessageTimeByWorktree: {} } as never)

    expect(listener).not.toHaveBeenCalled()
    stop()
  })

  it('stops calling back once unsubscribed', () => {
    const listener = vi.fn()
    const stop = createLivePrdFlowPorts().subscribe(listener)
    stop()

    for (const [, change] of changes) change()

    expect(listener).not.toHaveBeenCalled()
  })
})
