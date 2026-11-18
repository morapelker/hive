import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSignal } from '@/lib/document-flow/session-signal'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePrdFlowStore, type PrdFlow } from '@/stores/usePrdFlowStore'
import { beginTicketLaunch, useTicketLaunchStore } from '@/stores/useTicketLaunchStore'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'
import { cancelPrdFlow, retryPrdFlow } from './actions'

// "Retry PRD flow" and "Cancel PRD flow" as the ticket's card calls them, against the real flow
// store and board: what a retry puts back on (and that it prompts nothing itself), and what a
// cancel leaves behind.

const mocks = vi.hoisted(() => ({
  launchPrdFlowSession: vi.fn(),
  discardPrdFlowLaunch: vi.fn(),
  getSessionSignal: vi.fn(),
  isSessionClosed: vi.fn(),
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
vi.mock('./start', () => ({
  launchPrdFlowSession: mocks.launchPrdFlowSession,
  discardPrdFlowLaunch: mocks.discardPrdFlowLaunch
}))
vi.mock('@/lib/document-flow/session-signal', () => ({
  getSessionSignal: mocks.getSessionSignal
}))
vi.mock('@/lib/document-flow/runner-ports', () => ({ isSessionClosed: mocks.isSessionClosed }))
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }))

const PROJECT = 'project-shop'
const TICKET = 'ticket-prd'
const SESSION = 's-prd'
const TOP_OF_COLUMN = 512
const NOW = Date.parse('2026-11-18T09:00:00.000Z')

const WORKING: SessionSignal = { kind: 'working' }
const ENDED: SessionSignal = {
  kind: 'ended',
  at: NOW - 30_000,
  completion: 'completed',
  apiError: null,
  reason: null,
  hookEvent: 'Stop',
  hasBackgroundWork: false
}

const initialFlowState = usePrdFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()

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
    createdAt: NOW - 900_000,
    ...overrides
  }
}

/** A flow that stopped: its document was not written, also after it was asked for again. */
const stoppedFlow = (overrides: Partial<PrdFlow> = {}): PrdFlow =>
  makeFlow({
    status: 'needs_attention',
    attention: 'missing_file',
    detail: 'CODE_MODE_PRD.html was not created.',
    reprompts: 1,
    resumes: 2,
    waitingSince: NOW - 120_000,
    retryAt: NOW + 60_000,
    ...overrides
  })

const ticket = (column: KanbanTicketColumn, overrides: Partial<KanbanTicket> = {}): KanbanTicket =>
  ({
    id: TICKET,
    project_id: PROJECT,
    title: 'Code mode',
    column,
    sort_order: 0,
    current_session_id: SESSION,
    archived_at: null,
    ...overrides
  }) as KanbanTicket

/** The flow in the store, and its ticket on the board in that column. */
function seed(
  flow: PrdFlow,
  column: KanbanTicketColumn | null,
  overrides: Partial<KanbanTicket> = {}
): void {
  usePrdFlowStore.getState().putFlow(flow)
  useKanbanStore.setState({
    tickets: new Map([
      [
        PROJECT,
        [
          ...(column ? [ticket(column, overrides)] : []),
          ticket(column ?? 'review', { id: 'other' })
        ]
      ]
    ])
  })
}

const flowInStore = (): PrdFlow | undefined => usePrdFlowStore.getState().flows[TICKET]

let moveTicket: ReturnType<typeof vi.fn>
let computeSortOrder: ReturnType<typeof vi.fn>

beforeAll(
  () =>
    // Absorb the settings store's one-shot import timer so it cannot reset state mid-test.
    new Promise((resolve) => setTimeout(resolve, 220))
)

beforeEach(() => {
  vi.clearAllMocks()
  usePrdFlowStore.setState(initialFlowState, true)
  moveTicket = vi.fn(async () => undefined)
  computeSortOrder = vi.fn(() => TOP_OF_COLUMN)
  useKanbanStore.setState(
    { ...initialKanbanState, tickets: new Map(), moveTicket, computeSortOrder } as never,
    true
  )
  mocks.launchPrdFlowSession.mockResolvedValue(undefined)
  mocks.discardPrdFlowLaunch.mockResolvedValue(false)
  useTicketLaunchStore.setState({ phaseByTicket: {} })
  mocks.getSessionSignal.mockReturnValue(WORKING)
  mocks.isSessionClosed.mockResolvedValue(false)
})

describe('retryPrdFlow', () => {
  it('does nothing for a ticket that has no flow', async () => {
    await expect(retryPrdFlow('ticket-plain')).resolves.toBeUndefined()

    expect(usePrdFlowStore.getState().flows).toEqual({})
    expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it.each(['launching', 'prd', 'tasks', 'creating_run'] as const)(
    'does nothing for a flow at "%s" that is on: there is nothing to retry',
    async (stage) => {
      const flow = makeFlow({ stage, reprompts: 1, resumes: 2 })
      seed(flow, 'review')

      await retryPrdFlow(TICKET)

      // The very object: not even a write that changes nothing else.
      expect(flowInStore()).toBe(flow)
      expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
      expect(moveTicket).not.toHaveBeenCalled()
    }
  )

  describe('a flow whose session never started', () => {
    const failedLaunch = (): PrdFlow =>
      stoppedFlow({
        stage: 'launching',
        sessionId: null,
        attention: 'launch_failed',
        detail: 'The session could not be started: offline'
      })

    /** The failed launch took its session off the ticket again. */
    const UNLINKED = { current_session_id: null }

    it('stops asking for attention at once and launches the session again', async () => {
      seed(failedLaunch(), 'todo', UNLINKED)
      let atLaunch: PrdFlow | undefined
      mocks.launchPrdFlowSession.mockImplementation(async () => {
        atLaunch = flowInStore()
      })

      await retryPrdFlow(TICKET)

      expect(mocks.launchPrdFlowSession).toHaveBeenCalledTimes(1)
      expect(atLaunch).toMatchObject({ status: 'running', attention: null, detail: null })
      // The launch gets the flow as it is now, not as it was when it stopped.
      expect(mocks.launchPrdFlowSession).toHaveBeenCalledWith(atLaunch)
    })

    it('leaves the ticket in To Do for the launch to place, and prompts no session', async () => {
      seed(failedLaunch(), 'todo', UNLINKED)

      await retryPrdFlow(TICKET)

      expect(moveTicket).not.toHaveBeenCalled()
      expect(flowInStore()).toMatchObject({ stage: 'launching', forcePrompt: false })
    })

    it('does not wait for the launch', async () => {
      seed(failedLaunch(), 'todo', UNLINKED)
      mocks.launchPrdFlowSession.mockReturnValue(new Promise(() => {}))

      await expect(retryPrdFlow(TICKET)).resolves.toBeUndefined()
    })

    it('launches also when its ticket is not on the board of this page', async () => {
      seed(failedLaunch(), null)

      await retryPrdFlow(TICKET)

      expect(mocks.isSessionClosed).not.toHaveBeenCalled()
      expect(mocks.discardPrdFlowLaunch).not.toHaveBeenCalled()
      expect(mocks.launchPrdFlowSession).toHaveBeenCalledTimes(1)
    })

    it('launches nothing beside a launch of the ticket that is under way, and says so', async () => {
      // Somebody started the ticket by hand: its worktree is still being made, and it has no
      // session yet.
      const flow = failedLaunch()
      seed(flow, 'todo', UNLINKED)
      const theirs = beginTicketLaunch(TICKET, 'worktree')

      await retryPrdFlow(TICKET)

      expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
      // The flow waits as it was: the driver ends it once their session is on the ticket.
      expect(flowInStore()).toBe(flow)
      expect(mocks.toast.info).toHaveBeenCalledTimes(1)
      expect(mocks.toast.info).toHaveBeenCalledWith(
        'PRD flow of “Code mode” was not retried: its ticket is already starting.'
      )

      // Their launch came to nothing: the retry is free to launch.
      theirs.release()
      await retryPrdFlow(TICKET)
      expect(mocks.launchPrdFlowSession).toHaveBeenCalledTimes(1)
    })

    it('launches nothing beside a launch of the ticket that began while its session was looked at', async () => {
      const flow = failedLaunch()
      seed(flow, 'in_progress', { current_session_id: 's-failed' })
      mocks.isSessionClosed.mockImplementation(async () => {
        beginTicketLaunch(TICKET, 'worktree')
        return true
      })

      await retryPrdFlow(TICKET)

      expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
      expect(flowInStore()).toBe(flow)
      expect(mocks.toast.info).toHaveBeenCalledWith(
        'PRD flow of “Code mode” was not retried: its ticket is already starting.'
      )
    })

    it('takes nothing off a ticket somebody is launching: the session its failed launch left stays until their launch is over', async () => {
      const flow: PrdFlow = { ...failedLaunch(), sessionId: 's-failed' }
      seed(flow, 'in_progress', { current_session_id: 's-failed' })
      beginTicketLaunch(TICKET, 'worktree')

      await retryPrdFlow(TICKET)

      expect(mocks.discardPrdFlowLaunch).not.toHaveBeenCalled()
      expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
      expect(flowInStore()).toBe(flow)
    })

    describe('whose failed launch left its session on the ticket', () => {
      /** Neither the session nor the ticket could be taken back, and the flow remembers it. */
      const leftover = (): PrdFlow => ({ ...failedLaunch(), sessionId: 's-failed' })
      const LINKED = { current_session_id: 's-failed' }

      it('discards that session once more before it launches', async () => {
        const flow = leftover()
        seed(flow, 'in_progress', LINKED)
        mocks.discardPrdFlowLaunch.mockImplementation(async () => {
          // This time the ticket could be put back.
          seed(flow, 'todo', UNLINKED)
          return false
        })

        await retryPrdFlow(TICKET)

        expect(mocks.discardPrdFlowLaunch).toHaveBeenCalledTimes(1)
        expect(mocks.discardPrdFlowLaunch).toHaveBeenCalledWith(flow, 's-failed')
        expect(mocks.launchPrdFlowSession).toHaveBeenCalledTimes(1)
        expect(mocks.discardPrdFlowLaunch.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.launchPrdFlowSession.mock.invocationCallOrder[0]
        )
        expect(mocks.toast.info).not.toHaveBeenCalled()
      })

      it('launches over it all the same when it is still on the ticket, open or not: it is the flow own, not somebody else session', async () => {
        seed(leftover(), 'in_progress', LINKED)
        mocks.discardPrdFlowLaunch.mockResolvedValue(true)

        await retryPrdFlow(TICKET)

        // Known for the flow's own: nobody is asked whether it is closed.
        expect(mocks.isSessionClosed).not.toHaveBeenCalled()
        expect(mocks.launchPrdFlowSession).toHaveBeenCalledTimes(1)
        expect(flowInStore()).toMatchObject({ status: 'running', attention: null })
        expect(mocks.toast.info).not.toHaveBeenCalled()
      })

      it('ends the flow instead when the ticket has somebody else session by now', async () => {
        seed(leftover(), 'in_progress', { current_session_id: 's-by-hand' })

        await retryPrdFlow(TICKET)

        expect(mocks.discardPrdFlowLaunch).toHaveBeenCalledWith(expect.anything(), 's-failed')
        expect(mocks.isSessionClosed).toHaveBeenCalledWith('s-by-hand')
        expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
        expect(flowInStore()).toBeUndefined()
      })

      it('does nothing more for a flow that was cancelled while the session was discarded', async () => {
        seed(leftover(), 'in_progress', LINKED)
        mocks.discardPrdFlowLaunch.mockImplementation(async () => {
          usePrdFlowStore.getState().removeFlow(TICKET)
          return true
        })

        await retryPrdFlow(TICKET)

        expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
        expect(mocks.toast.info).not.toHaveBeenCalled()
      })

      it('launches nothing, keeps the flow and says so when the session could not be discarded', async () => {
        const flow = leftover()
        seed(flow, 'in_progress', LINKED)
        mocks.discardPrdFlowLaunch.mockRejectedValue(new Error('WebSocket is not open'))

        await expect(retryPrdFlow(TICKET)).resolves.toBeUndefined()

        expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
        expect(flowInStore()).toBe(flow)
        expect(mocks.toast.error).toHaveBeenCalledWith(
          'PRD flow of “Code mode” could not be retried: WebSocket is not open'
        )
      })
    })

    describe('whose ticket has a session by now', () => {
      it('ends the flow instead of launching when somebody launched the ticket by hand: theirs is not replaced', async () => {
        seed(failedLaunch(), 'in_progress', { current_session_id: 's-by-hand' })

        await retryPrdFlow(TICKET)

        expect(mocks.isSessionClosed).toHaveBeenCalledWith('s-by-hand')
        expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
        expect(flowInStore()).toBeUndefined()
        expect(mocks.toast.info).toHaveBeenCalledTimes(1)
        expect(mocks.toast.info).toHaveBeenCalledWith(
          'PRD flow of “Code mode” stopped: its ticket was given another session.'
        )
        expect(moveTicket).not.toHaveBeenCalled()
      })

      it('launches over a closed session, which is what the failed launch could not take off the ticket', async () => {
        seed(failedLaunch(), 'in_progress', { current_session_id: 's-failed' })
        mocks.isSessionClosed.mockResolvedValue(true)

        await retryPrdFlow(TICKET)

        expect(mocks.isSessionClosed).toHaveBeenCalledWith('s-failed')
        expect(mocks.launchPrdFlowSession).toHaveBeenCalledTimes(1)
        expect(mocks.launchPrdFlowSession).toHaveBeenCalledWith(flowInStore())
        expect(flowInStore()).toMatchObject({ status: 'running', attention: null })
        expect(mocks.toast.info).not.toHaveBeenCalled()
      })

      it('launches nothing, keeps the flow and says so when that session could not be looked up', async () => {
        const flow = failedLaunch()
        seed(flow, 'in_progress', { current_session_id: 's-unknown' })
        mocks.isSessionClosed.mockRejectedValue(new Error('WebSocket is not open'))

        await expect(retryPrdFlow(TICKET)).resolves.toBeUndefined()

        expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
        expect(flowInStore()).toBe(flow)
        expect(mocks.toast.error).toHaveBeenCalledWith(
          'PRD flow of “Code mode” could not be retried: WebSocket is not open'
        )
      })

      it('does nothing more for a flow that was cancelled while the session was looked up', async () => {
        seed(failedLaunch(), 'in_progress', { current_session_id: 's-by-hand' })
        mocks.isSessionClosed.mockImplementation(async () => {
          usePrdFlowStore.getState().removeFlow(TICKET)
          return true
        })

        await retryPrdFlow(TICKET)

        expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
        expect(mocks.toast.info).not.toHaveBeenCalled()
      })
    })
  })

  describe('a flow that stopped at one of its documents', () => {
    it.each(['prd', 'tasks'] as const)(
      'puts a flow at "%s" back on, to be prompted whatever its session is found doing',
      async (stage) => {
        const flow = stoppedFlow({ stage })
        seed(flow, 'review')

        await retryPrdFlow(TICKET)

        expect(flowInStore()).toEqual({
          ...flow,
          status: 'running',
          attention: null,
          detail: null,
          reprompts: 0,
          resumes: 0,
          waitingSince: null,
          retryAt: null,
          forcePrompt: true
        })
        // The driver prompts on its next look; the retry itself starts nothing.
        expect(mocks.launchPrdFlowSession).not.toHaveBeenCalled()
      }
    )

    it.each(['review', 'todo'] as const)(
      'returns its ticket from "%s" to the top of In Progress, session untouched',
      async (column) => {
        seed(stoppedFlow(), column)

        await retryPrdFlow(TICKET)

        expect(computeSortOrder).toHaveBeenCalledWith([], 0)
        expect(moveTicket).toHaveBeenCalledTimes(1)
        expect(moveTicket).toHaveBeenCalledWith(TICKET, PROJECT, 'in_progress', TOP_OF_COLUMN, {
          skipCompletionEffects: true,
          keepSession: true
        })
      }
    )

    it('moves the ticket only once the flow is on again, so the board keeps it there', async () => {
      seed(stoppedFlow(), 'review')
      let statusAtMove: string | undefined
      moveTicket.mockImplementation(async () => {
        statusAtMove = flowInStore()?.status
      })

      await retryPrdFlow(TICKET)

      expect(moveTicket).toHaveBeenCalledTimes(1)
      expect(statusAtMove).toBe('running')
    })

    it.each(['in_progress', 'done'] as const)(
      'leaves a ticket in "%s" where it is',
      async (column) => {
        seed(stoppedFlow(), column)

        await retryPrdFlow(TICKET)

        expect(flowInStore()?.status).toBe('running')
        expect(moveTicket).not.toHaveBeenCalled()
      }
    )

    it('puts the flow back on also when its ticket is not on the board of this page', async () => {
      seed(stoppedFlow(), null)

      await retryPrdFlow(TICKET)

      expect(flowInStore()).toMatchObject({ status: 'running', forcePrompt: true })
      expect(moveTicket).not.toHaveBeenCalled()
    })

    it('does not reject when the ticket could not be moved', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      seed(stoppedFlow(), 'review')
      moveTicket.mockRejectedValue(new Error('database is locked'))

      await expect(retryPrdFlow(TICKET)).resolves.toBeUndefined()

      expect(flowInStore()).toMatchObject({ status: 'running', forcePrompt: true })
      warn.mockRestore()
    })
  })

  it('retries the orchestrator ticket alone when both documents exist: no session is prompted', async () => {
    const flow = stoppedFlow({
      stage: 'creating_run',
      attention: 'run_failed',
      detail: 'The orchestrator ticket could not be created: offline',
      prdPath: '/repo/shop/CODE_MODE_PRD.html',
      tasksPath: '/repo/shop/CODE_MODE_TASKS.html'
    })
    seed(flow, 'review')

    await retryPrdFlow(TICKET)

    expect(flowInStore()).toMatchObject({
      stage: 'creating_run',
      status: 'running',
      attention: null,
      detail: null,
      forcePrompt: false,
      tasksPath: '/repo/shop/CODE_MODE_TASKS.html'
    })
    expect(moveTicket).toHaveBeenCalledWith(
      TICKET,
      PROJECT,
      'in_progress',
      TOP_OF_COLUMN,
      expect.anything()
    )
  })
})

describe('cancelPrdFlow', () => {
  it('does nothing, and says nothing, for a ticket that has no flow', async () => {
    await expect(cancelPrdFlow('ticket-plain')).resolves.toBeUndefined()

    expect(mocks.toast.info).not.toHaveBeenCalled()
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('forgets the flow and says that its ticket and session stay', async () => {
    seed(makeFlow(), 'in_progress')
    usePrdFlowStore.getState().putFlow(makeFlow({ ticketId: 'ticket-other', name: 'Checkout' }))

    await cancelPrdFlow(TICKET)

    expect(Object.keys(usePrdFlowStore.getState().flows)).toEqual(['ticket-other'])
    expect(mocks.toast.info).toHaveBeenCalledTimes(1)
    expect(mocks.toast.info).toHaveBeenCalledWith(
      'PRD flow of “Code mode” cancelled. Its ticket and session stay as they are.'
    )
  })

  it('leaves the ticket In Progress while its session is still at work', async () => {
    seed(makeFlow(), 'in_progress')
    mocks.getSessionSignal.mockReturnValue(WORKING)

    await cancelPrdFlow(TICKET)

    expect(mocks.getSessionSignal).toHaveBeenCalledWith(SESSION)
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('moves the ticket to Review when its session had already ended its turn', async () => {
    seed(makeFlow(), 'in_progress')
    mocks.getSessionSignal.mockReturnValue(ENDED)
    let flowAtMove: PrdFlow | undefined | 'not moved' = 'not moved'
    moveTicket.mockImplementation(async () => {
      flowAtMove = flowInStore()
    })

    await cancelPrdFlow(TICKET)

    expect(moveTicket).toHaveBeenCalledTimes(1)
    expect(moveTicket).toHaveBeenCalledWith(TICKET, PROJECT, 'review', TOP_OF_COLUMN, {
      skipCompletionEffects: true,
      keepSession: true
    })
    // The flow is gone by then: nothing holds the ticket In Progress any more.
    expect(flowAtMove).toBeUndefined()
  })

  it.each([
    ['paused its turn for work it started', 'waiting'],
    ['stopped without a Stop of its own', 'none']
  ] as const)(
    'leaves the ticket In Progress when its session only %s: the board keeps such a ticket there too',
    async (_what, completion) => {
      seed(makeFlow(), 'in_progress')
      mocks.getSessionSignal.mockReturnValue({ ...ENDED, completion })

      await cancelPrdFlow(TICKET)

      expect(flowInStore()).toBeUndefined()
      expect(moveTicket).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['an older Claude that cannot say what is pending', { completion: 'unknown' }],
    ['a session of an agent that reports no completion', { completion: undefined }],
    ['a pause that ended on an API error', { completion: 'waiting', apiError: 'overloaded_error' }]
  ] as const)('moves the ticket to Review after the turn end of %s', async (_what, end) => {
    seed(makeFlow(), 'in_progress')
    mocks.getSessionSignal.mockReturnValue({ ...ENDED, ...end })

    await cancelPrdFlow(TICKET)

    expect(moveTicket).toHaveBeenCalledTimes(1)
    expect(moveTicket).toHaveBeenCalledWith(
      TICKET,
      PROJECT,
      'review',
      TOP_OF_COLUMN,
      expect.anything()
    )
  })

  it.each(['todo', 'review', 'done'] as const)(
    'leaves a ticket in "%s" where it is, whatever its session did',
    async (column) => {
      seed(makeFlow(), column)
      mocks.getSessionSignal.mockReturnValue(ENDED)

      await cancelPrdFlow(TICKET)

      expect(flowInStore()).toBeUndefined()
      expect(moveTicket).not.toHaveBeenCalled()
    }
  )

  it('leaves the ticket of a flow that never had a session', async () => {
    seed(makeFlow({ stage: 'launching', sessionId: null }), 'in_progress')
    mocks.getSessionSignal.mockReturnValue(ENDED)

    await cancelPrdFlow(TICKET)

    expect(flowInStore()).toBeUndefined()
    expect(mocks.getSessionSignal).not.toHaveBeenCalled()
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('cancels a flow that needs attention as well', async () => {
    seed(stoppedFlow(), 'review')

    await cancelPrdFlow(TICKET)

    expect(flowInStore()).toBeUndefined()
    expect(mocks.toast.info).toHaveBeenCalledTimes(1)
  })

  it('does not reject when the ticket could not be moved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seed(makeFlow(), 'in_progress')
    mocks.getSessionSignal.mockReturnValue(ENDED)
    moveTicket.mockRejectedValue(new Error('database is locked'))

    await expect(cancelPrdFlow(TICKET)).resolves.toBeUndefined()

    expect(flowInStore()).toBeUndefined()
    warn.mockRestore()
  })
})
