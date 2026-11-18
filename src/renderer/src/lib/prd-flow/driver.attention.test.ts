import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPrdFlowRepromptPrompt,
  buildPrdPrompt,
  buildTasksPrompt
} from '@shared/document-flow/prd-flow'
import type { PrdFlow } from '@/stores/usePrdFlowStore'
import { PrdFlowDriver } from './driver'
import {
  PRD_PATH,
  PREFIX,
  SESSION_ID,
  TEST_NOW,
  TICKET_ID,
  advance,
  createWorld,
  makeFlow,
  settle,
  type PrdFlowWorld
} from './driver-fakes'
import { PRD_FLOW_UNCONFIRMED_WORK_MS } from './ports'

// A flow that needs the person: what stops it without a prompt (they stopped or closed the
// session), how it comes back (by itself when they put the session to work or the document
// appears, or when they press Retry), and what ends it for good (its ticket is no longer
// there to work for).

const USER_STOPPED = 'You stopped the session. Retry continues the flow.'
const SESSION_CLOSED =
  'The session was closed. Retry reopens it and asks for CODE_MODE_PRD.html again.'

const askAgain = buildPrdFlowRepromptPrompt({
  document: 'prd',
  reason: 'missing',
  prefix: PREFIX,
  path: PRD_PATH
})
const tasksPrompt = buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })
/** The prompt the PRD stage began with, as the flow of the fakes sends it. */
const prdPrompt = buildPrdPrompt({
  prompt: makeFlow().prompt,
  prefix: PREFIX,
  research: true,
  clarify: true,
  sdk: 'claude-code-cli'
})

/** A flow that stopped at the PRD, with its ticket in Review as the driver left it. */
const stopped = (
  attention: PrdFlow['attention'],
  overrides: Partial<PrdFlow> = {}
): Partial<PrdFlow> => ({
  status: 'needs_attention',
  attention,
  detail: 'It stopped.',
  ...overrides
})

describe('PrdFlowDriver: a flow that needs attention', () => {
  let driver: PrdFlowDriver | null = null

  const start = (world: PrdFlowWorld): PrdFlowDriver => {
    driver = new PrdFlowDriver(world.ports)
    driver.start()
    return driver
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TEST_NOW))
  })

  afterEach(() => {
    driver?.stop()
    driver = null
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('stopping without a prompt', () => {
    it('stops when the person stopped the session, whatever is on disk', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      start(world)
      await advance(500)

      world.endTurn({ completion: 'none', reason: 'user_interrupt' })
      await settle()

      expect(world.sent).toEqual([])
      expect(world.ports.fileExists).not.toHaveBeenCalled()
      expect(world.flow()).toMatchObject({
        stage: 'prd',
        status: 'needs_attention',
        attention: 'user_stopped',
        detail: USER_STOPPED
      })
      expect(world.column()).toBe('review')
      expect(world.moves).toEqual([{ ticketId: TICKET_ID, column: 'review' }])
      expect(world.notices).toEqual([
        { level: 'warning', message: `PRD flow of “Code mode”: ${USER_STOPPED}` }
      ])

      await advance(60 * 60_000)
      expect(world.sent).toEqual([])
      expect(world.notices).toHaveLength(1)
    })

    it('stops when the person closed the session, and says what Retry does', async () => {
      const world = createWorld()
      start(world)
      await advance(500)

      world.closeSession()
      await advance(1_000)

      expect(world.sent).toEqual([])
      expect(world.flow()).toMatchObject({
        status: 'needs_attention',
        attention: 'session_closed',
        detail: SESSION_CLOSED
      })
      expect(world.column()).toBe('review')
      expect(world.noticesOf('warning')).toEqual([`PRD flow of “Code mode”: ${SESSION_CLOSED}`])
    })

    it('takes the work the main process recorded of a session for over once the session is closed', async () => {
      const world = createWorld()
      world.recordTurn({ state: 'working', hook_event: 'Working', completion: null })
      start(world)
      await advance(500)

      world.closeSession()
      await advance(1_000)

      expect(world.flow()).toMatchObject({
        status: 'needs_attention',
        attention: 'session_closed'
      })
    })

    it('goes on from a closed session whose document is there', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      start(world)
      await advance(500)

      world.closeSession()
      await advance(1_000)

      expect(world.prompts()).toEqual([tasksPrompt])
      expect(world.flow()).toMatchObject({ stage: 'tasks', status: 'running' })
      expect(world.notices).toEqual([])
    })

    it('leaves a ticket that is not In Progress where it is', async () => {
      const world = createWorld({ ticket: { column: 'todo' } })
      start(world)

      world.endTurn({ reason: 'user_interrupt' })
      await settle()

      expect(world.flow().attention).toBe('user_stopped')
      expect(world.moves).toEqual([])
      expect(world.column()).toBe('todo')
    })

    it('tells the person though the ticket could not be moved to Review', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const world = createWorld()
      world.ports.moveTicket.mockRejectedValueOnce(new Error('The board is not reachable.'))
      start(world)

      world.endTurn({ reason: 'user_interrupt' })
      await settle()

      expect(world.flow().status).toBe('needs_attention')
      expect(world.notices).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })

  describe('coming back by itself', () => {
    it('is on again, with its counts fresh, when the person puts the session to work', async () => {
      const world = createWorld({
        flow: stopped('user_stopped', { reprompts: 1, resumes: 2 }),
        ticket: { column: 'review' },
        signal: null
      })
      world.endTurn({ at: Date.now() - 10_000, reason: 'user_interrupt' })
      start(world)
      await advance(60_000)
      expect(world.flow().status).toBe('needs_attention')

      world.setSignal(SESSION_ID, { kind: 'working' })
      await advance(1_000)

      expect(world.flow()).toEqual(makeFlow())
      expect(world.sent).toEqual([])
      expect(world.notices).toEqual([])

      // From here its turn ends count again.
      world.writeFile(PRD_PATH)
      world.endTurn()
      await settle()
      expect(world.prompts()).toEqual([tasksPrompt])
    })

    it('is on again when the session asks the person something', async () => {
      const world = createWorld({ flow: stopped('send_failed'), ticket: { column: 'review' } })
      world.setSignal(SESSION_ID, { kind: 'blocked', reason: 'question', detail: 'Which one?' })
      start(world)

      await advance(1_000)

      expect(world.flow()).toMatchObject({
        status: 'running',
        attention: null,
        detail: 'Waiting for you: Which one?'
      })
    })

    it.each([
      ['at work', { state: 'working', hook_event: 'Working', completion: null }],
      ['waiting for the person', { state: 'blocked', hook_event: 'answering', completion: null }]
    ] as const)(
      'stays stopped when only the main process recorded the session %s: that may be older than the stop',
      async (_what, turn) => {
        // The person interrupted the turn, which records nothing; the page was reloaded since.
        const world = createWorld({
          flow: stopped('user_stopped'),
          ticket: { column: 'review' },
          signal: null
        })
        world.recordTurn(turn)
        start(world)

        await advance(10 * 60_000)

        expect(world.flow()).toEqual(makeFlow(stopped('user_stopped')))
        expect(world.column()).toBe('review')
        expect(world.sent).toEqual([])

        // What the page itself sees of the session is another matter.
        world.setSignal(SESSION_ID, { kind: 'working' })
        await advance(1_000)
        expect(world.flow()).toMatchObject({ status: 'running', attention: null })
      }
    )

    it('goes on when the document it could not get appears, putting the ticket back In Progress first', async () => {
      const world = createWorld({
        flow: stopped('missing_file', { reprompts: 1 }),
        ticket: { column: 'review' },
        signal: null
      })
      world.endTurn({ at: Date.now() - 10_000 })
      start(world)

      await advance(10 * 60_000)
      expect(world.sent).toEqual([])
      expect(world.flow().status).toBe('needs_attention')

      world.writeFile(PRD_PATH)
      await advance(10_000)

      expect(world.prompts()).toEqual([tasksPrompt])
      expect(world.flow()).toMatchObject({
        stage: 'tasks',
        status: 'running',
        attention: null,
        detail: null,
        reprompts: 0,
        prdPath: PRD_PATH
      })
      expect(world.moves).toEqual([{ ticketId: TICKET_ID, column: 'in_progress' }])
      expect(world.ports.moveTicket.mock.invocationCallOrder[0]).toBeLessThan(
        world.ports.sendPrompt.mock.invocationCallOrder[0]
      )
      expect(world.notices).toEqual([])
    })

    it.each(['api_error', 'interrupted'] as const)(
      'goes on when the document appears after it stopped on %s',
      async (attention) => {
        const world = createWorld({
          flow: stopped(attention, { resumes: 3 }),
          ticket: { column: 'review' },
          signal: null
        })
        world.writeFile(PRD_PATH)
        start(world)

        await advance(1_000)

        expect(world.prompts()).toEqual([tasksPrompt])
        expect(world.flow()).toMatchObject({ stage: 'tasks', status: 'running', resumes: 0 })
      }
    )

    it.each(['user_stopped', 'session_closed', 'send_failed'] as const)(
      'stays stopped on %s though the document is there: that takes the person',
      async (attention) => {
        const world = createWorld({
          flow: stopped(attention),
          ticket: { column: 'review' },
          signal: null
        })
        world.writeFile(PRD_PATH)
        start(world)

        await advance(10 * 60_000)

        expect(world.sent).toEqual([])
        expect(world.flow()).toEqual(makeFlow(stopped(attention)))
      }
    )

    it('waits for a new turn end to settle before it looks for the document', async () => {
      const world = createWorld({
        flow: stopped('missing_file', { reprompts: 1 }),
        ticket: { column: 'review' },
        signal: null
      })
      world.writeFile(PRD_PATH)
      world.endTurn({ at: Date.now() })
      start(world)

      await advance(1_000)
      expect(world.sent).toEqual([])

      await advance(3_000)
      expect(world.prompts()).toEqual([tasksPrompt])
    })
  })

  describe('a session the person puts back to work long after the flow last prompted it', () => {
    // They type a message into the session: the page shows it as working at once, on the word
    // of that send alone, as it does for a prompt of the flow. The main process records the
    // session at work a moment later, when the message has reached it.

    /** Half an hour before the test clock: the flow's last prompt, long past any wait. */
    const LONG_AGO = Date.parse(TEST_NOW) - 30 * 60_000

    /** A flow that stopped long ago; `row`: what the main process has of the session, if anything. */
    const STOPPED_LONG_AGO = [
      ['could not send its prompt, with the turn before it on record', 'send_failed', true],
      ['kept being interrupted, with nothing on record', 'interrupted', false]
    ] as const

    const stoppedLongAgo = (attention: PrdFlow['attention'], row: boolean): PrdFlowWorld => {
      const world = createWorld({
        flow: stopped(attention, { promptedAt: LONG_AGO, resumes: 3 }),
        ticket: { column: 'review' },
        signal: null
      })
      if (row) world.recordTurn({ updated_at: new Date(LONG_AGO - 60_000).toISOString() })
      return world
    }

    describe.each(STOPPED_LONG_AGO)('a flow that %s', (_what, attention, row) => {
      it('is on again and sends nothing on top of their message: the wait runs from their send, not from its own old prompt', async () => {
        const world = stoppedLongAgo(attention, row)
        start(world)
        await advance(1_000)

        world.setSignal(SESSION_ID, { kind: 'working' }, { recorded: false })
        await advance(PRD_FLOW_UNCONFIRMED_WORK_MS - 5_000)

        expect(world.flow()).toMatchObject({ status: 'running', attention: null, resumes: 0 })
        expect(world.sent).toEqual([])
        expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
        // Nobody was asked anything yet: the status is taken at its word for the while.
        expect(world.ports.isSessionStarted).not.toHaveBeenCalled()
      })

      it('believes their send for good once the main process records the session at work after it', async () => {
        const world = stoppedLongAgo(attention, row)
        start(world)
        await advance(1_000)

        world.setSignal(SESSION_ID, { kind: 'working' }, { recorded: false })
        await advance(2_000)
        world.recordTurn({
          state: 'working',
          hook_event: 'Working',
          completion: null,
          updated_at: new Date().toISOString()
        })
        await advance(2 * 60 * 60_000)

        expect(world.flow()).toMatchObject({ status: 'running', attention: null })
        expect(world.sent).toEqual([])
        expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
      })

      it('takes their send for one that never arrived only when nothing was recorded of the session for the whole wait after it', async () => {
        const world = stoppedLongAgo(attention, row)
        start(world)
        await advance(1_000)

        world.setSignal(SESSION_ID, { kind: 'working' }, { recorded: false })
        await advance(PRD_FLOW_UNCONFIRMED_WORK_MS - 5_000)
        expect(world.sent).toEqual([])

        await advance(10_000)
        expect(world.ports.forgetSessionStatus).toHaveBeenCalledWith(SESSION_ID)
        expect(world.prompts()).toEqual([prdPrompt])
        expect(world.flow()).toMatchObject({ status: 'running', resumes: 1 })
      })
    })

    it('measures the wait anew from a second message of theirs', async () => {
      const world = stoppedLongAgo('send_failed', true)
      start(world)
      await advance(1_000)

      world.setSignal(SESSION_ID, { kind: 'working' }, { recorded: false })
      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS - 5_000)
      world.setSignal(SESSION_ID, { kind: 'working' }, { recorded: false })
      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS - 5_000)

      expect(world.sent).toEqual([])
      expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
    })

    it('still asks about a prompt of its own that it sends later into the same session', async () => {
      const world = stoppedLongAgo('send_failed', true)
      world.writeFile(PRD_PATH)
      start(world)
      await advance(1_000)

      // Their message arrives and the session works on it; the main process says so.
      world.setSignal(SESSION_ID, { kind: 'working' })
      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)
      expect(world.sent).toEqual([])

      // The turn ends with the PRD written: the tasks prompt goes out, and never arrives.
      world.silentSessions.add(SESSION_ID)
      world.recordTurn({ updated_at: new Date().toISOString() })
      world.endTurn()
      await settle()
      expect(world.prompts()).toEqual([tasksPrompt])

      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)
      expect(world.prompts()).toEqual([tasksPrompt, tasksPrompt])
    })
  })

  describe('Retry', () => {
    it('asks for the file again after the person had stopped the session', async () => {
      const world = createWorld({
        flow: stopped('user_stopped'),
        ticket: { column: 'review' },
        signal: null
      })
      world.endTurn({ at: Date.now() - 10_000, reason: 'user_interrupt' })
      start(world)
      await advance(1_000)

      world.retry()
      await advance(1_000)

      expect(world.prompts()).toEqual([askAgain])
      expect(world.flow()).toMatchObject({
        status: 'running',
        attention: null,
        detail: null,
        reprompts: 1,
        forcePrompt: false,
        promptedAt: world.sent[0].at
      })
      expect(world.column()).toBe('in_progress')
    })

    it('goes on after Retry when the document is there', async () => {
      const world = createWorld({
        flow: stopped('user_stopped'),
        ticket: { column: 'review' },
        signal: null
      })
      world.endTurn({ at: Date.now() - 10_000, reason: 'user_interrupt' })
      world.writeFile(PRD_PATH)
      start(world)
      await advance(1_000)

      world.retry()
      await advance(1_000)

      expect(world.prompts()).toEqual([tasksPrompt])
      expect(world.flow()).toMatchObject({ stage: 'tasks', forcePrompt: false })
    })

    it('reopens a closed session with the request for the file', async () => {
      const world = createWorld({
        flow: stopped('session_closed'),
        ticket: { column: 'review' },
        signal: null
      })
      world.closedSessions.add(SESSION_ID)
      start(world)
      await advance(1_000)

      world.retry()
      await advance(1_000)

      expect(world.prompts()).toEqual([askAgain])
      expect(world.flow()).toMatchObject({ status: 'running', reprompts: 1, forcePrompt: false })
      // It stays on: the session that was reopened is not taken for closed again.
      await advance(60_000)
      expect(world.flow().status).toBe('running')
      expect(world.sent).toHaveLength(1)
    })

    it('prompts a session at rest at once, without waiting out the grace period', async () => {
      const world = createWorld({
        flow: stopped('missing_file', { reprompts: 1, promptedAt: Date.now() }),
        ticket: { column: 'review' },
        signal: null
      })
      start(world)
      await advance(1_000)

      world.retry()
      await advance(1_000)

      expect(world.prompts()).toEqual([askAgain])
      expect(world.flow()).toMatchObject({ reprompts: 1, forcePrompt: false })
    })

    it('does not prompt a session it finds at work, and lets a later stop of the person stand', async () => {
      const world = createWorld({ flow: { forcePrompt: true } })
      start(world)

      await advance(60_000)
      expect(world.sent).toEqual([])
      expect(world.flow()).toEqual(makeFlow())

      world.endTurn({ reason: 'user_interrupt' })
      await settle()
      expect(world.sent).toEqual([])
      expect(world.flow()).toMatchObject({ status: 'needs_attention', attention: 'user_stopped' })
    })

    it('stops again when the session comes to rest without the file after the one request Retry bought', async () => {
      const world = createWorld({
        flow: stopped('missing_file', { reprompts: 1 }),
        ticket: { column: 'review' },
        signal: null
      })
      world.endTurn({ at: Date.now() - 10_000 })
      start(world)
      await advance(1_000)

      world.retry()
      await advance(1_000)
      expect(world.prompts()).toEqual([askAgain])

      await advance(60_000)
      world.endTurn()
      await settle()

      expect(world.prompts()).toEqual([askAgain])
      expect(world.flow()).toMatchObject({ status: 'needs_attention', attention: 'missing_file' })
      expect(world.column()).toBe('review')
    })
  })

  describe('a ticket that is no longer there to work for', () => {
    it.each([
      ['removed', 'gone', 'was removed'],
      ['archived', { archived: true }, 'was archived'],
      ['moved to Done', { column: 'done' }, 'was moved to Done'],
      ['merged', { column: 'merged' }, 'was moved to Done'],
      ['given another session', { sessionId: 'session-2' }, 'was given another session'],
      ['left without its session', { sessionId: null }, 'was taken off its session']
    ] as const)(
      'forgets the flow of a ticket that was %s, says so once, and prompts nothing',
      async (_what, ticket, reason) => {
        const world = createWorld()
        world.writeFile(PRD_PATH)
        start(world)
        await advance(500)

        world.setTicket(ticket)
        world.endTurn()
        await advance(60_000)

        expect(world.hasFlow()).toBe(false)
        expect(world.sent).toEqual([])
        expect(world.moves).toEqual([])
        expect(world.notices).toEqual([
          { level: 'info', message: `PRD flow of “Code mode” stopped: its ticket ${reason}.` }
        ])
      }
    )

    it('forgets a flow that needed attention the same way', async () => {
      const world = createWorld({ flow: stopped('missing_file'), ticket: 'gone' })
      start(world)

      await advance(1_000)

      expect(world.hasFlow()).toBe(false)
      expect(world.noticesOf('info')).toEqual([
        'PRD flow of “Code mode” stopped: its ticket was removed.'
      ])
    })

    it('forgets a flow whose ticket went away while its session was being started', async () => {
      const world = createWorld({
        flow: { stage: 'launching', sessionId: null },
        ticket: 'gone',
        signal: null
      })
      start(world)

      await advance(1_000)

      expect(world.hasFlow()).toBe(false)
      expect(world.noticesOf('warning')).toEqual([])
    })
  })
})
