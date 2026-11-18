import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPrdPrompt } from '@shared/document-flow/prd-flow'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import type {
  ConnectionSessionLaunchSpec,
  SessionLaunchResult,
  SessionLaunchSpec
} from '@/lib/ticket-launch'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePrdFlowStore, type PrdFlow } from '@/stores/usePrdFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { isTicketLaunching, useTicketLaunchStore } from '@/stores/useTicketLaunchStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type {
  KanbanTicket,
  KanbanTicketCreate,
  KanbanTicketUpdate,
  Session,
  Worktree
} from '../../../../main/db/types'
import {
  discardPrdFlowLaunch,
  isPrdFlowLaunching,
  launchPrdFlowSession,
  resetPrdFlowLaunchesForTests,
  startPrdFlow,
  type StartPrdFlowInput
} from './start'

// Starting a PRD flow, against the real flow, board, project, worktree and connection stores:
// what the form's answers are refused for, the ticket and the flow a start leaves behind, and
// the launch of the session (mocked where the agent would be started: the launch hands the
// session over before it starts the agent, as lib/ticket-launch does) with everything a failed
// or a cancelled launch takes back.

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  launchSessionWithModel: vi.fn(),
  launchSessionOnConnection: vi.fn(),
  resolveBadgeModel: vi.fn(),
  resolveCustomProviderBadge: vi.fn(),
  resolveDefaultLaunchConfig: vi.fn(),
  resetTicketToTodo: vi.fn(),
  discardSession: vi.fn(),
  autoPinForBoardPrompt: vi.fn(),
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
vi.mock('@/api/worktree-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/worktree-api')>()
  return { ...actual, worktreeApi: { ...actual.worktreeApi, exists: mocks.exists } }
})
vi.mock('@/lib/ticket-launch', () => ({
  launchSessionWithModel: mocks.launchSessionWithModel,
  launchSessionOnConnection: mocks.launchSessionOnConnection,
  resolveBadgeModel: mocks.resolveBadgeModel,
  resolveCustomProviderBadge: mocks.resolveCustomProviderBadge
}))
vi.mock('@/lib/document-flow/migrations', () => ({ discardSession: mocks.discardSession }))
vi.mock('@/lib/document-flow/runner-ports', () => ({
  resolveDefaultLaunchConfig: mocks.resolveDefaultLaunchConfig,
  resetTicketToTodo: mocks.resetTicketToTodo
}))
vi.mock('@/lib/auto-pin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auto-pin')>()),
  autoPinForBoardPrompt: mocks.autoPinForBoardPrompt
}))
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }))

const GIT_PROJECT = 'project-shop'
const CONNECTION_PROJECT = 'project-suite'
const MAIN_CHECKOUT = '/repo/shop'
const MAIN_WORKTREE = 'wt-main'
const BASE_INSTANCE = 'conn-base'
const BASE_PATH = '/connections/suite-base'
const TICKET = 'ticket-prd'
const SESSION = 's-prd'
const TOP_OF_IN_PROGRESS = 512

const NOW = Date.parse('2026-11-18T09:00:00.000Z')

/** What the form chose, and what the app launches with when the form chose nothing. */
const FORM_LAUNCH: DocumentRunLaunchConfig = {
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
const BADGE = { providerID: 'anthropic', modelID: 'opus', variant: null }

const initialFlowState = usePrdFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialSessionState = useSessionStore.getState()

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: TICKET,
    project_id: GIT_PROJECT,
    title: 'Code mode',
    description: 'Build a code mode.',
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    archived_at: null,
    ...overrides
  } as KanbanTicket
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    worktree_id: MAIN_WORKTREE,
    project_id: GIT_PROJECT,
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    ...overrides
  } as Session
}

function makeFlow(overrides: Partial<PrdFlow> = {}): PrdFlow {
  return {
    ticketId: TICKET,
    projectId: GIT_PROJECT,
    name: 'Code mode',
    prefix: 'CODE_MODE',
    prompt: 'Build a code mode.',
    research: true,
    clarify: true,
    launch: APP_LAUNCH,
    checkout: { kind: 'worktree', worktreeId: MAIN_WORKTREE },
    cwd: MAIN_CHECKOUT,
    memberDirs: [],
    sessionId: null,
    stage: 'launching',
    status: 'running',
    attention: null,
    detail: null,
    promptedAt: NOW - 60_000,
    reprompts: 0,
    resumes: 0,
    waitingSince: null,
    retryAt: null,
    forcePrompt: false,
    prdPath: null,
    tasksPath: null,
    runId: null,
    createdAt: NOW - 60_000,
    ...overrides
  }
}

const connectionFlow = (overrides: Partial<PrdFlow> = {}): PrdFlow =>
  makeFlow({
    projectId: CONNECTION_PROJECT,
    checkout: { kind: 'connection', connectionId: BASE_INSTANCE },
    cwd: BASE_PATH,
    memberDirs: ['web', 'api'],
    ...overrides
  })

const formInput = (overrides: Partial<StartPrdFlowInput> = {}): StartPrdFlowInput => ({
  projectId: GIT_PROJECT,
  name: 'Code mode',
  prompt: 'Build a code mode.',
  research: true,
  clarify: true,
  launch: null,
  ...overrides
})

const flowInStore = (ticketId = TICKET): PrdFlow | undefined =>
  usePrdFlowStore.getState().flows[ticketId]

const ticketOnBoard = (projectId = GIT_PROJECT): KanbanTicket | undefined =>
  useKanbanStore
    .getState()
    .tickets.get(projectId)
    ?.find((ticket) => ticket.id === TICKET)

function seedTickets(projectId: string, tickets: KanbanTicket[]): void {
  useKanbanStore.setState((state) => ({ tickets: new Map(state.tickets).set(projectId, tickets) }))
}

/** The reset of a ticket as lib/document-flow/runner-ports makes it when all is well: back in To Do, with no session. */
async function putTicketBack(projectId: string, ticketId: string): Promise<void> {
  seedTickets(
    projectId,
    (useKanbanStore.getState().tickets.get(projectId) ?? []).map((ticket) =>
      ticket.id === ticketId
        ? ({ ...ticket, column: 'todo', current_session_id: null } as KanbanTicket)
        : ticket
    )
  )
}

/** A flow that is in the store, with its ticket on the board: what a launch starts from. */
function seedFlow(flow: PrdFlow, ticket: Partial<KanbanTicket> = {}): PrdFlow {
  usePrdFlowStore.getState().putFlow(flow)
  seedTickets(flow.projectId, [makeTicket({ project_id: flow.projectId, ...ticket })])
  return flow
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type AnyLaunchSpec = SessionLaunchSpec | ConnectionSessionLaunchSpec

/**
 * A launch as lib/ticket-launch runs it, in a worktree or on a connection: the session is
 * handed to the caller before the agent is started, and a throw of the caller is a failed
 * launch that names the session.
 */
function launchEnds(
  end: (spec: AnyLaunchSpec) => SessionLaunchResult | Promise<SessionLaunchResult>,
  session: Session = makeSession()
): void {
  const launch = async (spec: AnyLaunchSpec): Promise<SessionLaunchResult> => {
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
  }
  mocks.launchSessionWithModel.mockImplementation(launch)
  mocks.launchSessionOnConnection.mockImplementation(launch)
}

/** The launch of a start is not awaited by it: over once the ticket is no longer launching. */
const launchIsOver = (): Promise<void> =>
  vi.waitFor(() => expect(isPrdFlowLaunching(TICKET)).toBe(false))

let createTicket: ReturnType<typeof vi.fn>
let updateTicket: ReturnType<typeof vi.fn>
let computeSortOrder: ReturnType<typeof vi.fn>
let updateSessionName: ReturnType<typeof vi.fn>

beforeAll(
  () =>
    // Absorb the settings store's one-shot import timer so it cannot reset state mid-test.
    new Promise((resolve) => setTimeout(resolve, 220))
)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  resetPrdFlowLaunchesForTests()
  usePrdFlowStore.setState(initialFlowState, true)
  useTicketLaunchStore.setState({ phaseByTicket: {} })

  // The board as it answers when all is well: a created ticket is on it, an update is applied.
  createTicket = vi.fn(async (projectId: string, data: KanbanTicketCreate) => {
    const ticket = makeTicket({
      project_id: projectId,
      title: data.title,
      description: data.description ?? null,
      column: data.column ?? 'todo'
    })
    seedTickets(projectId, [...(useKanbanStore.getState().tickets.get(projectId) ?? []), ticket])
    return ticket
  })
  updateTicket = vi.fn(async (ticketId: string, projectId: string, data: KanbanTicketUpdate) => {
    seedTickets(
      projectId,
      (useKanbanStore.getState().tickets.get(projectId) ?? []).map((ticket) =>
        ticket.id === ticketId ? ({ ...ticket, ...data } as KanbanTicket) : ticket
      )
    )
  })
  computeSortOrder = vi.fn(() => TOP_OF_IN_PROGRESS)
  useKanbanStore.setState(
    {
      ...initialKanbanState,
      tickets: new Map(),
      createTicket,
      updateTicket,
      computeSortOrder
    } as never,
    true
  )

  useProjectStore.setState(
    {
      ...initialProjectState,
      projects: [
        { id: GIT_PROJECT, name: 'Shop', path: MAIN_CHECKOUT, kind: 'git' },
        { id: CONNECTION_PROJECT, name: 'Suite', path: '/connections/suite', kind: 'connection' }
      ] as never
    },
    true
  )
  useWorktreeStore.setState(
    {
      ...initialWorktreeState,
      worktreesByProject: new Map([
        [
          GIT_PROJECT,
          [{ id: MAIN_WORKTREE, project_id: GIT_PROJECT, path: MAIN_CHECKOUT, is_default: true }]
        ]
      ]) as unknown as Map<string, Worktree[]>,
      loadWorktrees: vi.fn(async () => undefined)
    } as never,
    true
  )
  useConnectionStore.setState(
    {
      ...initialConnectionState,
      connections: [
        {
          id: BASE_INSTANCE,
          status: 'active',
          path: BASE_PATH,
          saved_project_id: CONNECTION_PROJECT,
          is_base: 1,
          members: [{ symlink_name: 'web' }, { symlink_name: 'api' }]
        }
      ],
      loadConnections: vi.fn(async () => undefined)
    } as never,
    true
  )
  updateSessionName = vi.fn(async () => true)
  useSessionStore.setState({ ...initialSessionState, updateSessionName } as never, true)
  // Every agent is installed on this Mac, and no custom provider is set up.
  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    customProviders: []
  })

  mocks.exists.mockResolvedValue(false)
  mocks.resolveDefaultLaunchConfig.mockReturnValue(APP_LAUNCH)
  mocks.resolveCustomProviderBadge.mockReturnValue(null)
  mocks.resolveBadgeModel.mockReturnValue(BADGE)
  mocks.resetTicketToTodo.mockImplementation(putTicketBack)
  mocks.discardSession.mockResolvedValue(undefined)
  mocks.autoPinForBoardPrompt.mockResolvedValue(undefined)
  launchEnds(() => ({ success: true, sessionId: SESSION }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startPrdFlow', () => {
  describe('what it refuses', () => {
    it.each([
      ['an empty name', { name: '   ' }, 'Give the ticket a name.'],
      [
        'a name without a letter or a digit',
        { name: ' -> ?! ' },
        'The name needs at least one letter or digit.'
      ],
      ['an empty prompt', { prompt: ' \n ' }, 'Say what you want to create.']
    ])('refuses %s before anything is looked at', async (_what, overrides, error) => {
      await expect(startPrdFlow(formInput(overrides))).resolves.toEqual({ ok: false, error })

      expect(mocks.exists).not.toHaveBeenCalled()
      expect(createTicket).not.toHaveBeenCalled()
      expect(usePrdFlowStore.getState().flows).toEqual({})
      expect(mocks.launchSessionWithModel).not.toHaveBeenCalled()
    })

    it('says the name is missing before it says the prompt is', async () => {
      await expect(startPrdFlow(formInput({ name: '', prompt: '' }))).resolves.toEqual({
        ok: false,
        error: 'Give the ticket a name.'
      })
    })

    it('refuses a project that has nowhere to run, with the reason', async () => {
      useWorktreeStore.setState({ worktreesByProject: new Map() })

      await expect(startPrdFlow(formInput())).resolves.toEqual({
        ok: false,
        error: 'This project has no main checkout to run in.'
      })
      await expect(startPrdFlow(formInput({ projectId: 'project-unknown' }))).resolves.toEqual({
        ok: false,
        error: 'The project was not found.'
      })
      expect(createTicket).not.toHaveBeenCalled()
    })

    it('refuses a name whose PRD is already in the directory', async () => {
      mocks.exists.mockImplementation(async (path: string) => path.endsWith('_PRD.html'))

      await expect(startPrdFlow(formInput())).resolves.toEqual({
        ok: false,
        error:
          'CODE_MODE_PRD.html already exists in /repo/shop. Pick another name, or remove the file.'
      })
      expect(createTicket).not.toHaveBeenCalled()
      expect(usePrdFlowStore.getState().flows).toEqual({})
    })

    it('names both documents when both are already there', async () => {
      mocks.exists.mockResolvedValue(true)

      await expect(startPrdFlow(formInput())).resolves.toEqual({
        ok: false,
        error:
          'CODE_MODE_PRD.html and CODE_MODE_TASKS.html already exist in /repo/shop. Pick another name, or remove the files.'
      })
    })

    it('refuses a name another flow is writing in the same directory, before its file exists', async () => {
      seedFlow(makeFlow({ ticketId: 'ticket-other', name: 'code-mode' }))

      await expect(startPrdFlow(formInput())).resolves.toEqual({
        ok: false,
        error:
          'The PRD flow of “code-mode” is already writing CODE_MODE_PRD.html in /repo/shop. Pick another name, or cancel that flow.'
      })
      expect(createTicket).not.toHaveBeenCalled()
    })

    it('starts beside a flow of the same name that runs in another directory', async () => {
      usePrdFlowStore.getState().putFlow(connectionFlow({ ticketId: 'ticket-other' }))

      await expect(startPrdFlow(formInput())).resolves.toEqual({ ok: true, ticketId: TICKET })
      await launchIsOver()
    })

    describe('an agent that is not available on this Mac', () => {
      const CODEX_MISSING =
        'Codex is not available on this system. Install it and restart Hive, or choose another provider.'
      const CLAUDE_CLI_MISSING =
        'Claude Code (CLI) is not available on this system. Install it and restart Hive, or choose another provider.'
      const BEDROCK = {
        id: 'provider-bedrock',
        name: 'Bedrock',
        command: 'claude-bedrock',
        usageProvider: 'none'
      } as const
      const withProvider = (customProviderId: string): DocumentRunLaunchConfig => ({
        ...APP_LAUNCH,
        customProviderId
      })

      it('refuses the agent the form chose in the words session creation would use, and leaves nothing behind', async () => {
        useSettingsStore.setState({
          availableAgentSdks: { opencode: true, claude: true, codex: false }
        })
        usePrdFlowStore.getState().setLaunchPref(APP_LAUNCH)

        await expect(startPrdFlow(formInput({ launch: FORM_LAUNCH }))).resolves.toEqual({
          ok: false,
          error: CODEX_MISSING
        })

        expect(createTicket).not.toHaveBeenCalled()
        expect(usePrdFlowStore.getState().flows).toEqual({})
        expect(mocks.launchSessionWithModel).not.toHaveBeenCalled()
        expect(isPrdFlowLaunching(TICKET)).toBe(false)
        // The agent that cannot run is not remembered for the next form.
        expect(usePrdFlowStore.getState().launchPref).toEqual(APP_LAUNCH)
      })

      it("refuses the app's default agent the same way when the form chose none", async () => {
        useSettingsStore.setState({
          availableAgentSdks: { opencode: true, claude: false, codex: true }
        })

        await expect(startPrdFlow(formInput({ launch: null }))).resolves.toEqual({
          ok: false,
          error: CLAUDE_CLI_MISSING
        })
        expect(createTicket).not.toHaveBeenCalled()
        expect(usePrdFlowStore.getState().flows).toEqual({})
      })

      it('refuses nothing while the app does not know yet which agents are installed', async () => {
        useSettingsStore.setState({ availableAgentSdks: null })

        await expect(startPrdFlow(formInput({ launch: FORM_LAUNCH }))).resolves.toEqual({
          ok: true,
          ticketId: TICKET
        })
        await launchIsOver()
      })

      it('starts with a custom provider though the stock Claude CLI is not installed: it runs its own command', async () => {
        useSettingsStore.setState({
          availableAgentSdks: { opencode: true, claude: false, codex: true },
          customProviders: [BEDROCK]
        })

        await expect(
          startPrdFlow(formInput({ launch: withProvider(BEDROCK.id) }))
        ).resolves.toEqual({ ok: true, ticketId: TICKET })
        await launchIsOver()
      })

      it.each([
        ['was deleted', []],
        ['has no command', [{ ...BEDROCK, command: '  ' }]]
      ])(
        'refuses a custom provider that %s: its session would be a plain Claude CLI one',
        async (_what, customProviders) => {
          useSettingsStore.setState({
            availableAgentSdks: { opencode: true, claude: false, codex: true },
            customProviders
          })

          await expect(
            startPrdFlow(formInput({ launch: withProvider(BEDROCK.id) }))
          ).resolves.toEqual({ ok: false, error: CLAUDE_CLI_MISSING })
          expect(createTicket).not.toHaveBeenCalled()
        }
      )
    })

    it('says so when the directory could not be looked at, and creates nothing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mocks.exists.mockRejectedValue(new Error('WebSocket is not open'))

      await expect(startPrdFlow(formInput())).resolves.toEqual({
        ok: false,
        error: 'The PRD flow could not be started: WebSocket is not open'
      })
      expect(createTicket).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('says so when the ticket could not be created, and leaves no flow', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      createTicket.mockRejectedValue(new Error('database is locked'))

      await expect(startPrdFlow(formInput())).resolves.toEqual({
        ok: false,
        error: 'The ticket could not be created.'
      })
      expect(usePrdFlowStore.getState().flows).toEqual({})
      expect(mocks.launchSessionWithModel).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('what it starts', () => {
    /** The launch hangs before a session exists: what the start itself left is all there is. */
    const launchHangs = (): ((result: SessionLaunchResult) => void) => {
      const pending = deferred<SessionLaunchResult>()
      mocks.launchSessionWithModel.mockReturnValue(pending.promise)
      mocks.launchSessionOnConnection.mockReturnValue(pending.promise)
      return pending.resolve
    }

    it('creates the ticket in To Do as the person: the name is its title, the prompt its description', async () => {
      const finish = launchHangs()

      await expect(
        startPrdFlow(formInput({ name: '  Code mode ', prompt: '\nBuild a code mode.\n' }))
      ).resolves.toEqual({ ok: true, ticketId: TICKET })

      expect(createTicket).toHaveBeenCalledTimes(1)
      expect(createTicket).toHaveBeenCalledWith(GIT_PROJECT, {
        project_id: GIT_PROJECT,
        title: 'Code mode',
        description: 'Build a code mode.',
        column: 'todo'
      })
      finish({ success: true, sessionId: SESSION })
      await launchIsOver()
    })

    it('records the flow as launching in the main checkout, with everything the form said', async () => {
      const finish = launchHangs()

      await startPrdFlow(
        formInput({ name: 'prd -> tasks', research: true, clarify: false, launch: FORM_LAUNCH })
      )

      expect(flowInStore()).toEqual({
        ticketId: TICKET,
        projectId: GIT_PROJECT,
        name: 'prd -> tasks',
        prefix: 'PRD_TASKS',
        prompt: 'Build a code mode.',
        research: true,
        clarify: false,
        launch: FORM_LAUNCH,
        checkout: { kind: 'worktree', worktreeId: MAIN_WORKTREE },
        cwd: MAIN_CHECKOUT,
        memberDirs: [],
        sessionId: null,
        stage: 'launching',
        status: 'running',
        attention: null,
        detail: null,
        promptedAt: NOW,
        reprompts: 0,
        resumes: 0,
        waitingSince: null,
        retryAt: null,
        forcePrompt: false,
        prdPath: null,
        tasksPath: null,
        runId: null,
        createdAt: NOW
      })
      finish({ success: true, sessionId: SESSION })
      await launchIsOver()
    })

    it('runs a connection project on its base instance, with its member directories', async () => {
      const finish = launchHangs()

      await startPrdFlow(formInput({ projectId: CONNECTION_PROJECT }))

      expect(flowInStore()).toMatchObject({
        projectId: CONNECTION_PROJECT,
        checkout: { kind: 'connection', connectionId: BASE_INSTANCE },
        cwd: BASE_PATH,
        memberDirs: ['web', 'api']
      })
      expect(mocks.launchSessionOnConnection).toHaveBeenCalledTimes(1)
      expect(mocks.launchSessionWithModel).not.toHaveBeenCalled()
      finish({ success: true, sessionId: SESSION })
      await launchIsOver()
    })

    it("launches with the app's default when the form chose no model, and remembers that", async () => {
      usePrdFlowStore.getState().setLaunchPref(FORM_LAUNCH)

      await startPrdFlow(formInput({ launch: null }))
      await launchIsOver()

      expect(mocks.resolveDefaultLaunchConfig).toHaveBeenCalledTimes(1)
      expect(mocks.launchSessionWithModel.mock.calls[0][0].modelConfig).toBe(APP_LAUNCH)
      expect(flowInStore()?.launch).toEqual(APP_LAUNCH)
      expect(usePrdFlowStore.getState().launchPref).toBeNull()
    })

    it('launches with the model the form chose, and remembers it for the next form', async () => {
      await startPrdFlow(formInput({ launch: FORM_LAUNCH }))
      await launchIsOver()

      expect(mocks.resolveDefaultLaunchConfig).not.toHaveBeenCalled()
      expect(mocks.launchSessionWithModel.mock.calls[0][0].modelConfig).toEqual(FORM_LAUNCH)
      expect(usePrdFlowStore.getState().launchPref).toEqual(FORM_LAUNCH)
      // The prompt names the question tool of that agent.
      expect(mocks.launchSessionWithModel.mock.calls[0][0].prompt).toContain(
        'use the request_user_input tool to ask me'
      )
    })

    it('sends the checkmarks the form had with the prompt', async () => {
      await startPrdFlow(formInput({ research: false, clarify: false }))
      await launchIsOver()

      expect(mocks.launchSessionWithModel.mock.calls[0][0].prompt).toBe(
        buildPrdPrompt({
          prompt: 'Build a code mode.',
          prefix: 'CODE_MODE',
          research: false,
          clarify: false,
          sdk: 'claude-code-cli'
        })
      )
    })

    it('answers as soon as the flow exists, without waiting for the session', async () => {
      const finish = launchHangs()

      await expect(startPrdFlow(formInput())).resolves.toEqual({ ok: true, ticketId: TICKET })

      expect(mocks.launchSessionWithModel).toHaveBeenCalledTimes(1)
      expect(isPrdFlowLaunching(TICKET)).toBe(true)
      // The card says the session is starting.
      expect(isTicketLaunching(TICKET)).toBe(true)

      finish({ success: true, sessionId: SESSION })
      await launchIsOver()
      expect(isTicketLaunching(TICKET)).toBe(false)
      expect(flowInStore()).toMatchObject({ sessionId: SESSION, stage: 'prd', status: 'running' })
    })

    it('marks the launch before the flow is in the store, so the driver never finds it unattended', async () => {
      const seen: boolean[] = []
      const stop = usePrdFlowStore.subscribe((state, previous) => {
        if (state.flows[TICKET] && !previous.flows[TICKET]) seen.push(isPrdFlowLaunching(TICKET))
      })

      await startPrdFlow(formInput())
      await launchIsOver()
      stop()

      expect(seen).toEqual([true])
    })
  })
})

describe('launchPrdFlowSession', () => {
  const launchedSpec = (): SessionLaunchSpec => mocks.launchSessionWithModel.mock.calls[0][0]

  it('launches a build session in the main checkout with the PRD prompt', async () => {
    const flow = seedFlow(makeFlow({ research: true, clarify: false }))

    await launchPrdFlowSession(flow)

    expect(mocks.launchSessionWithModel).toHaveBeenCalledTimes(1)
    expect(mocks.launchSessionWithModel).toHaveBeenCalledWith({
      projectId: GIT_PROJECT,
      worktreeId: MAIN_WORKTREE,
      prompt: buildPrdPrompt({
        prompt: 'Build a code mode.',
        prefix: 'CODE_MODE',
        research: true,
        clarify: false,
        sdk: 'claude-code-cli'
      }),
      mode: 'build',
      modelConfig: APP_LAUNCH,
      goalMode: false,
      goalSuccessCriteria: null,
      // The session is the flow's ticket's: no other ticket of the main checkout is handed it.
      skipKanbanAttach: true,
      onSessionCreated: expect.any(Function)
    })
    // Whatever the checkmarks add, the request for the file is the last thing the prompt says.
    expect(
      launchedSpec().prompt.endsWith(
        "Create CODE_MODE_PRD.html standalone, darkmode html file, containing everything discussed, research conclusions, and all decisions we've made"
      )
    ).toBe(true)
    expect(mocks.launchSessionOnConnection).not.toHaveBeenCalled()
    expect(mocks.autoPinForBoardPrompt).toHaveBeenCalledWith({
      projectId: GIT_PROJECT,
      worktreeId: MAIN_WORKTREE
    })
  })

  it('launches on the base instance of a connection project, in its directory', async () => {
    const flow = seedFlow(connectionFlow())
    launchEnds(
      () => ({ success: true, sessionId: SESSION }),
      makeSession({
        worktree_id: null,
        project_id: CONNECTION_PROJECT,
        connection_id: BASE_INSTANCE
      })
    )

    await launchPrdFlowSession(flow)

    expect(mocks.launchSessionOnConnection).toHaveBeenCalledTimes(1)
    expect(mocks.launchSessionOnConnection).toHaveBeenCalledWith({
      connectionId: BASE_INSTANCE,
      connectionPath: BASE_PATH,
      prompt: buildPrdPrompt({
        prompt: 'Build a code mode.',
        prefix: 'CODE_MODE',
        research: true,
        clarify: true,
        sdk: 'claude-code-cli'
      }),
      mode: 'build',
      modelConfig: APP_LAUNCH,
      goalMode: false,
      goalSuccessCriteria: null,
      onSessionCreated: expect.any(Function)
    })
    expect(mocks.launchSessionWithModel).not.toHaveBeenCalled()
    expect(mocks.autoPinForBoardPrompt).toHaveBeenCalledWith({
      projectId: CONNECTION_PROJECT,
      connectionId: BASE_INSTANCE
    })
    // No worktree to name on the ticket of a session that runs on an instance.
    expect(updateTicket).toHaveBeenCalledWith(
      TICKET,
      CONNECTION_PROJECT,
      expect.objectContaining({ current_session_id: SESSION, worktree_id: null })
    )
    expect(flowInStore()).toMatchObject({ sessionId: SESSION, stage: 'prd' })
  })

  it('stamps the prompt and clears what an earlier attempt left before anything is sent', async () => {
    const flow = seedFlow(
      makeFlow({
        sessionId: 's-earlier',
        status: 'needs_attention',
        attention: 'launch_failed',
        detail: 'The session could not be started: no such model',
        promptedAt: NOW - 3_600_000
      })
    )
    let atLaunch: PrdFlow | undefined
    mocks.launchSessionWithModel.mockImplementation(async () => {
      atLaunch = flowInStore()
      return { success: true, sessionId: SESSION }
    })

    await launchPrdFlowSession(flow)

    expect(atLaunch).toMatchObject({
      promptedAt: NOW,
      status: 'running',
      attention: null,
      detail: null,
      stage: 'launching',
      sessionId: null
    })
  })

  it('names the session, links the ticket and moves it In Progress before the agent is started', async () => {
    const flow = seedFlow(makeFlow())
    seedTickets(GIT_PROJECT, [
      makeTicket(),
      makeTicket({ id: 'ticket-busy', column: 'in_progress', sort_order: 1024 })
    ])
    const order: string[] = []
    updateSessionName.mockImplementation(async () => {
      order.push('named')
      return true
    })
    // What the card, the launch and the store say at each step: read there, judged below.
    type Seen = { cardStarting: boolean; launching: boolean; flow: PrdFlow | undefined }
    const look = (): Seen => ({
      cardStarting: isTicketLaunching(TICKET),
      launching: isPrdFlowLaunching(TICKET),
      flow: flowInStore()
    })
    let whileLinking: Seen | undefined
    let whileStarting: Seen | undefined
    updateTicket.mockImplementation(async () => {
      order.push('linked')
      whileLinking = look()
    })
    launchEnds(() => {
      // What the launch does next is start the agent: the ticket is the session's by now.
      order.push('agent started')
      whileStarting = look()
      return { success: true, sessionId: SESSION }
    })

    await launchPrdFlowSession(flow)

    expect(order).toEqual(['named', 'linked', 'agent started'])
    // Still shown as starting until the ticket has its session.
    expect(whileLinking?.cardStarting).toBe(true)
    expect(whileLinking?.flow).toMatchObject({ sessionId: SESSION, stage: 'launching' })
    expect(whileStarting?.cardStarting).toBe(false)
    // The driver keeps off until the prompt is delivered.
    expect(whileStarting?.launching).toBe(true)
    expect(flowInStore()).toMatchObject({ sessionId: SESSION, stage: 'prd', status: 'running' })
    expect(updateSessionName).toHaveBeenCalledWith(SESSION, 'PRD — Code mode')
    expect(computeSortOrder).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'ticket-busy' })],
      0
    )
    expect(updateTicket).toHaveBeenCalledTimes(1)
    expect(updateTicket).toHaveBeenCalledWith(TICKET, GIT_PROJECT, {
      current_session_id: SESSION,
      worktree_id: MAIN_WORKTREE,
      mode: 'build',
      column: 'in_progress',
      sort_order: TOP_OF_IN_PROGRESS,
      plan_ready: false,
      pending_launch_config: null,
      model_provider_id: 'anthropic',
      model_id: 'opus',
      model_variant: null
    })
    expect(isPrdFlowLaunching(TICKET)).toBe(false)
    expect(mocks.toast.error).not.toHaveBeenCalled()
    expect(mocks.discardSession).not.toHaveBeenCalled()
    expect(mocks.resetTicketToTodo).not.toHaveBeenCalled()
  })

  it('keeps the flow at its launch until the agent is started: a launch cut off before that left no session to wait for', async () => {
    const flow = seedFlow(makeFlow())
    const agentStarted = deferred<SessionLaunchResult>()
    launchEnds(() => agentStarted.promise)

    const launch = launchPrdFlowSession(flow)
    await vi.waitFor(() => expect(ticketOnBoard()?.current_session_id).toBe(SESSION))

    // The ticket is linked and the agent is not started yet: were the window reloaded now,
    // the driver would find a flow at its launch, and ask whether the session ever started.
    expect(flowInStore()).toMatchObject({ sessionId: SESSION, stage: 'launching' })

    agentStarted.resolve({ success: true, sessionId: SESSION })
    await launch
    expect(flowInStore()).toMatchObject({ sessionId: SESSION, stage: 'prd' })
  })

  it('stamps the badge of what really runs: the session row and the launch config', async () => {
    const flow = seedFlow(makeFlow({ launch: FORM_LAUNCH }))
    const session = makeSession({ model_provider_id: 'codex', model_id: 'gpt-5.5' })
    mocks.resolveBadgeModel.mockReturnValue({
      providerID: 'codex',
      modelID: 'gpt-5.5',
      variant: 'high'
    })
    launchEnds(() => ({ success: true, sessionId: SESSION }), session)

    await launchPrdFlowSession(flow)

    expect(mocks.resolveCustomProviderBadge).toHaveBeenCalledWith(null, FORM_LAUNCH.model)
    expect(mocks.resolveBadgeModel).toHaveBeenCalledWith(FORM_LAUNCH, session)
    expect(updateTicket).toHaveBeenCalledWith(
      TICKET,
      GIT_PROJECT,
      expect.objectContaining({
        model_provider_id: 'codex',
        model_id: 'gpt-5.5',
        model_variant: 'high'
      })
    )
  })

  it("stamps a custom provider's badge over the session row's model", async () => {
    const flow = seedFlow(makeFlow())
    mocks.resolveCustomProviderBadge.mockReturnValue({
      providerID: 'custom',
      modelID: 'Bedrock',
      variant: null
    })

    await launchPrdFlowSession(flow)

    expect(mocks.resolveBadgeModel).not.toHaveBeenCalled()
    expect(updateTicket).toHaveBeenCalledWith(
      TICKET,
      GIT_PROJECT,
      expect.objectContaining({ model_provider_id: 'custom', model_id: 'Bedrock' })
    )
  })

  it('launches all the same when the session could not be named', async () => {
    const flow = seedFlow(makeFlow())
    updateSessionName.mockRejectedValue(new Error('database is locked'))

    await launchPrdFlowSession(flow)

    expect(updateTicket).toHaveBeenCalledTimes(1)
    expect(flowInStore()).toMatchObject({ sessionId: SESSION, stage: 'prd', status: 'running' })
  })

  it('does not launch a second session while a launch of the flow is still running', async () => {
    const flow = seedFlow(makeFlow())
    const pending = deferred<SessionLaunchResult>()
    mocks.launchSessionWithModel.mockReturnValue(pending.promise)

    const first = launchPrdFlowSession(flow)
    await launchPrdFlowSession(flow)

    expect(mocks.launchSessionWithModel).toHaveBeenCalledTimes(1)
    pending.resolve({ success: true, sessionId: SESSION })
    await first
    expect(isPrdFlowLaunching(TICKET)).toBe(false)
  })

  describe('a session that could not be started', () => {
    const FAILED = {
      sessionId: null,
      stage: 'launching',
      status: 'needs_attention',
      attention: 'launch_failed'
    }

    it('leaves the flow needing attention and says why, when no session was made', async () => {
      const flow = seedFlow(makeFlow())
      mocks.launchSessionWithModel.mockResolvedValue({
        success: false,
        error: 'Claude CLI is not installed'
      })

      await launchPrdFlowSession(flow)

      expect(flowInStore()).toMatchObject({
        ...FAILED,
        detail: 'The session could not be started: Claude CLI is not installed'
      })
      expect(mocks.toast.error).toHaveBeenCalledTimes(1)
      expect(mocks.toast.error).toHaveBeenCalledWith(
        'PRD flow of “Code mode”: the session could not be started: Claude CLI is not installed'
      )
      // Nothing of the launch reached the ticket: it is left as it is.
      expect(mocks.discardSession).not.toHaveBeenCalled()
      expect(mocks.resetTicketToTodo).not.toHaveBeenCalled()
      expect(isPrdFlowLaunching(TICKET)).toBe(false)
      expect(isTicketLaunching(TICKET)).toBe(false)
    })

    it('closes the session it made and returns its ticket to To Do', async () => {
      const flow = seedFlow(makeFlow())
      const order: string[] = []
      mocks.discardSession.mockImplementation(async () => {
        order.push('session closed')
      })
      let statusAtReset: string | undefined
      mocks.resetTicketToTodo.mockImplementation(async (projectId: string, ticketId: string) => {
        order.push('ticket reset')
        statusAtReset = flowInStore()?.status
        await putTicketBack(projectId, ticketId)
      })
      launchEnds(() => ({ success: false, error: 'Could not send prompt', sessionId: SESSION }))

      await launchPrdFlowSession(flow)

      expect(mocks.discardSession).toHaveBeenCalledWith(SESSION)
      expect(mocks.resetTicketToTodo).toHaveBeenCalledWith(GIT_PROJECT, TICKET)
      expect(order).toEqual(['session closed', 'ticket reset'])
      // Still the flow's while its ticket is put back: nothing else moves it meanwhile.
      expect(statusAtReset).toBe('running')
      expect(flowInStore()).toMatchObject({
        ...FAILED,
        detail: 'The session could not be started: Could not send prompt'
      })
      expect(mocks.toast.error).toHaveBeenCalledWith(
        'PRD flow of “Code mode”: the session could not be started: Could not send prompt'
      )
    })

    it('needs attention all the same when the ticket could not be put back, and remembers the session that is still on it', async () => {
      const flow = seedFlow(makeFlow())
      mocks.resetTicketToTodo.mockRejectedValue(new Error('database is locked'))
      launchEnds(() => ({ success: false, error: 'Could not send prompt', sessionId: SESSION }))

      await expect(launchPrdFlowSession(flow)).resolves.toBeUndefined()

      // The ticket points at the launch's own session still: the flow knows it for its own,
      // so that nothing takes it for a session somebody else gave the ticket.
      expect(ticketOnBoard()).toMatchObject({ column: 'in_progress', current_session_id: SESSION })
      expect(flowInStore()).toMatchObject({ ...FAILED, sessionId: SESSION })
    })

    it('remembers the session its ticket is linked to when the launch throws after linking it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const flow = seedFlow(makeFlow())
      mocks.launchSessionWithModel.mockImplementation(async (spec: SessionLaunchSpec) => {
        await spec.onSessionCreated?.({
          session: makeSession(),
          customProviderId: null,
          model: spec.modelConfig.model
        })
        throw new Error('boom')
      })

      await launchPrdFlowSession(flow)

      expect(ticketOnBoard()).toMatchObject({ current_session_id: SESSION })
      expect(flowInStore()).toMatchObject({
        ...FAILED,
        sessionId: SESSION,
        detail: 'The session could not be started: boom'
      })
      warn.mockRestore()
    })

    it('keeps the session an earlier failed launch left on the ticket when the retry makes none', async () => {
      // The first launch could neither close its session nor take it off the ticket; Retry
      // could not clear it away either, and its own launch fails before it makes a session.
      const flow = seedFlow(makeFlow({ sessionId: 's-leftover' }), {
        column: 'in_progress',
        current_session_id: 's-leftover'
      })
      mocks.launchSessionWithModel.mockResolvedValue({ success: false, error: 'offline' })

      await launchPrdFlowSession(flow)

      expect(flowInStore()).toMatchObject({ ...FAILED, sessionId: 's-leftover' })
    })

    it('does not remember a session somebody else gave the ticket meanwhile', async () => {
      const flow = seedFlow(makeFlow({ sessionId: 's-leftover' }), {
        column: 'in_progress',
        current_session_id: 's-by-hand'
      })
      mocks.launchSessionWithModel.mockResolvedValue({ success: false, error: 'offline' })

      await launchPrdFlowSession(flow)

      expect(flowInStore()).toMatchObject(FAILED)
    })

    it('fails the launch before the agent is started when the ticket could not be linked', async () => {
      const flow = seedFlow(makeFlow())
      updateTicket.mockRejectedValue(new Error('database is locked'))
      const agentStarted = vi.fn(() => ({ success: true, sessionId: SESSION }))
      launchEnds(agentStarted)

      await launchPrdFlowSession(flow)

      expect(agentStarted).not.toHaveBeenCalled()
      expect(mocks.discardSession).toHaveBeenCalledWith(SESSION)
      // The link never landed: there is nothing to take off the ticket.
      expect(mocks.resetTicketToTodo).not.toHaveBeenCalled()
      expect(flowInStore()).toMatchObject({
        ...FAILED,
        detail: 'The session could not be started: database is locked'
      })
    })

    it('says a start that reported nothing could not be started', async () => {
      const flow = seedFlow(makeFlow())
      mocks.launchSessionWithModel.mockResolvedValue({ success: false })

      await launchPrdFlowSession(flow)

      expect(flowInStore()?.detail).toBe(
        'The session could not be started: The session could not be started.'
      )
    })

    it('never rejects, also when the launch itself throws', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const flow = seedFlow(makeFlow())
      mocks.launchSessionWithModel.mockRejectedValue(new Error('boom'))

      await expect(launchPrdFlowSession(flow)).resolves.toBeUndefined()

      expect(flowInStore()).toMatchObject({
        ...FAILED,
        detail: 'The session could not be started: boom'
      })
      expect(isPrdFlowLaunching(TICKET)).toBe(false)
      expect(isTicketLaunching(TICKET)).toBe(false)
      warn.mockRestore()
    })

    it('can be launched again: the retry starts a new session and clears the failure', async () => {
      const flow = seedFlow(makeFlow())
      mocks.launchSessionWithModel.mockResolvedValueOnce({ success: false, error: 'offline' })
      await launchPrdFlowSession(flow)
      expect(flowInStore()).toMatchObject(FAILED)

      await launchPrdFlowSession(flowInStore() as PrdFlow)

      expect(mocks.launchSessionWithModel).toHaveBeenCalledTimes(2)
      expect(flowInStore()).toMatchObject({
        sessionId: SESSION,
        stage: 'prd',
        status: 'running',
        attention: null,
        detail: null
      })
    })
  })

  describe('a flow cancelled while its session was starting', () => {
    const cancel = (): void => usePrdFlowStore.getState().removeFlow(TICKET)

    it('starts nothing for a flow that is no longer in the store', async () => {
      const flow = makeFlow()
      seedTickets(GIT_PROJECT, [makeTicket()])

      await launchPrdFlowSession(flow)

      expect(mocks.launchSessionWithModel).not.toHaveBeenCalled()
      expect(usePrdFlowStore.getState().flows).toEqual({})
      expect(isPrdFlowLaunching(TICKET)).toBe(false)
      expect(isTicketLaunching(TICKET)).toBe(false)
    })

    it('does not start the agent of a session made after the cancel, and closes that session', async () => {
      const flow = seedFlow(makeFlow())
      const agentStarted = vi.fn(() => ({ success: true, sessionId: SESSION }))
      mocks.launchSessionWithModel.mockImplementation(async (spec: SessionLaunchSpec) => {
        // Cancelled while the session row was being created.
        cancel()
        try {
          await spec.onSessionCreated?.({
            session: makeSession(),
            customProviderId: null,
            model: spec.modelConfig.model
          })
        } catch (error) {
          return { success: false, error: (error as Error).message, sessionId: SESSION }
        }
        return agentStarted()
      })

      await launchPrdFlowSession(flow)

      expect(agentStarted).not.toHaveBeenCalled()
      expect(mocks.discardSession).toHaveBeenCalledWith(SESSION)
      // The ticket was never linked: it stays as the person left it, and nothing is said.
      expect(updateTicket).not.toHaveBeenCalled()
      expect(mocks.resetTicketToTodo).not.toHaveBeenCalled()
      expect(ticketOnBoard()).toMatchObject({ column: 'todo', current_session_id: null })
      expect(usePrdFlowStore.getState().flows).toEqual({})
      expect(mocks.toast.error).not.toHaveBeenCalled()
    })

    it('touches nothing more when the prompt was already on its way', async () => {
      const flow = seedFlow(makeFlow())
      launchEnds(() => {
        cancel()
        return { success: true, sessionId: SESSION }
      })

      await launchPrdFlowSession(flow)

      // The session runs on, linked to its ticket, as the cancel said it would.
      expect(usePrdFlowStore.getState().flows).toEqual({})
      expect(ticketOnBoard()).toMatchObject({ column: 'in_progress', current_session_id: SESSION })
      expect(mocks.discardSession).not.toHaveBeenCalled()
      expect(mocks.resetTicketToTodo).not.toHaveBeenCalled()
      expect(mocks.toast.error).not.toHaveBeenCalled()
    })

    it('takes a failed start back without a word, and does not bring the flow back', async () => {
      const flow = seedFlow(makeFlow())
      launchEnds(() => {
        cancel()
        return { success: false, error: 'Could not send prompt', sessionId: SESSION }
      })

      await launchPrdFlowSession(flow)

      // A session that never ran is nothing to keep: closed, and its ticket back in To Do.
      expect(mocks.discardSession).toHaveBeenCalledWith(SESSION)
      expect(mocks.resetTicketToTodo).toHaveBeenCalledWith(GIT_PROJECT, TICKET)
      expect(usePrdFlowStore.getState().flows).toEqual({})
      expect(mocks.toast.error).not.toHaveBeenCalled()
    })
  })

  it('leaves alone a ticket that has another session by the time the launch failed', async () => {
    const flow = seedFlow(makeFlow())
    launchEnds(() => {
      seedTickets(GIT_PROJECT, [
        makeTicket({ column: 'in_progress', current_session_id: 's-other' })
      ])
      return { success: false, error: 'Could not send prompt', sessionId: SESSION }
    })

    await launchPrdFlowSession(flow)

    expect(mocks.discardSession).toHaveBeenCalledWith(SESSION)
    expect(mocks.resetTicketToTodo).not.toHaveBeenCalled()
    expect(ticketOnBoard()).toMatchObject({ column: 'in_progress', current_session_id: 's-other' })
  })
})

describe('discardPrdFlowLaunch', () => {
  it('closes the session and returns the ticket to To Do when it still points at that session', async () => {
    const flow = seedFlow(makeFlow(), { column: 'in_progress', current_session_id: SESSION })
    const order: string[] = []
    mocks.discardSession.mockImplementation(async () => {
      order.push('session closed')
    })
    mocks.resetTicketToTodo.mockImplementation(async (projectId: string, ticketId: string) => {
      order.push('ticket reset')
      await putTicketBack(projectId, ticketId)
    })

    // The ticket was put back: it does not point at the session any more.
    await expect(discardPrdFlowLaunch(flow, SESSION)).resolves.toBe(false)

    expect(mocks.discardSession).toHaveBeenCalledWith(SESSION)
    expect(mocks.resetTicketToTodo).toHaveBeenCalledWith(GIT_PROJECT, TICKET)
    expect(order).toEqual(['session closed', 'ticket reset'])
    expect(ticketOnBoard()).toMatchObject({ column: 'todo', current_session_id: null })
  })

  it.each([
    ['has another session by now', { column: 'in_progress', current_session_id: 's-other' }],
    ['was never linked', { column: 'todo', current_session_id: null }]
  ] as const)('closes the session and leaves a ticket that %s as it is', async (_what, ticket) => {
    const flow = seedFlow(makeFlow(), ticket)

    await expect(discardPrdFlowLaunch(flow, SESSION)).resolves.toBe(false)

    expect(mocks.discardSession).toHaveBeenCalledWith(SESSION)
    expect(mocks.resetTicketToTodo).not.toHaveBeenCalled()
    expect(ticketOnBoard()).toMatchObject(ticket)
  })

  it('does not reject when the ticket could not be put back, and says that it still points at the session', async () => {
    const flow = seedFlow(makeFlow(), { column: 'in_progress', current_session_id: SESSION })
    mocks.resetTicketToTodo.mockRejectedValue(new Error('database is locked'))

    await expect(discardPrdFlowLaunch(flow, SESSION)).resolves.toBe(true)
    expect(mocks.discardSession).toHaveBeenCalledWith(SESSION)
    expect(ticketOnBoard()).toMatchObject({ column: 'in_progress', current_session_id: SESSION })
  })
})
