import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPrdFlowRepromptPrompt,
  buildPrdPrompt,
  buildTasksPrompt,
  type PrdFlowRepromptReason
} from '@shared/document-flow/prd-flow'
import { PrdFlowDriver } from './driver'
import {
  APP_STARTED_AT,
  CWD,
  PRD_PATH,
  PREFIX,
  PROMPTED_AT,
  SESSION_ID,
  TEST_NOW,
  TICKET_ID,
  advance,
  createWorld,
  makeFlow,
  settle,
  type PrdFlowWorld
} from './driver-fakes'
import {
  PRD_FLOW_API_ERROR_BACKOFF_MS,
  PRD_FLOW_MAX_RESUMES,
  PRD_FLOW_TURN_POLL_MS,
  PRD_FLOW_UNCONFIRMED_WORK_MS,
  PRD_FLOW_UNDELIVERED_GRACE_MS,
  PRD_FLOW_WAIT_FOR_WORK_MS
} from './ports'

// A turn that did not come to its end, and a page that was not there to see it: an API error,
// a session that went away (with the app, or on its own), a prompt that never arrived, a
// window reloaded while the session worked or while it was being started. The driver asks the
// session to carry on a few times, reads what the main process recorded while the page was
// away, and picks a launch up where it was left.

const API_ERROR_WAIT = 'The session ended on an API error. It is asked to continue shortly.'
const SESSION_HELD =
  'Waiting for you: the session has not started. Open it and answer what it asks.'
/** A minute before the fake app instance started: a prompt no agent survived. */
const BEFORE_APP_START = Date.parse(APP_STARTED_AT) - 60_000

/** The prompt the PRD stage began with, as the flow of the fakes sends it. */
const prdPrompt = buildPrdPrompt({
  prompt: makeFlow().prompt,
  prefix: PREFIX,
  research: true,
  clarify: true,
  sdk: 'claude-code-cli'
})
const tasksPrompt = buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })

const iso = (ms: number): string => new Date(ms).toISOString()

const carryOn = (reason: PrdFlowRepromptReason, document: 'prd' | 'tasks' = 'prd'): string =>
  buildPrdFlowRepromptPrompt({
    document,
    reason,
    prefix: PREFIX,
    path: `${CWD}/${PREFIX}_${document === 'prd' ? 'PRD' : 'TASKS'}.html`
  })

describe('PrdFlowDriver: resuming a session and picking a flow up again', () => {
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

  describe('an API error', () => {
    it('leaves the session alone for the backoff, then asks it to continue', async () => {
      const world = createWorld()
      start(world)
      await advance(500)

      const endedAt = Date.now()
      world.endTurn({ apiError: 'overloaded_error' })
      await settle()

      expect(world.sent).toEqual([])
      expect(world.flow()).toMatchObject({
        status: 'running',
        detail: API_ERROR_WAIT,
        retryAt: endedAt + PRD_FLOW_API_ERROR_BACKOFF_MS
      })

      await advance(PRD_FLOW_API_ERROR_BACKOFF_MS - 15_000)
      expect(world.sent).toEqual([])

      await advance(15_000)
      expect(world.prompts()).toEqual([carryOn('api_error')])
      expect(world.flow()).toMatchObject({
        stage: 'prd',
        status: 'running',
        resumes: 1,
        reprompts: 0,
        retryAt: null,
        detail: null,
        promptedAt: world.sent[0].at
      })
      expect(world.notices).toEqual([])
    })

    it('goes on without waiting when the document is there in spite of the error', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      start(world)

      world.endTurn({ apiError: 'overloaded_error' })
      await settle()

      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })])
      expect(world.flow()).toMatchObject({ stage: 'tasks', retryAt: null, resumes: 0 })
    })

    it('asks the session to continue a few times, then stops and says that it keeps failing', async () => {
      const world = createWorld()
      start(world)

      for (let attempt = 1; attempt <= PRD_FLOW_MAX_RESUMES; attempt += 1) {
        await advance(1_000)
        world.endTurn({ apiError: 'overloaded_error' })
        await advance(PRD_FLOW_API_ERROR_BACKOFF_MS + 5_000)
        expect(world.sent).toHaveLength(attempt)
        expect(world.flow()).toMatchObject({ status: 'running', resumes: attempt })
      }
      expect(world.prompts()).toEqual(Array(PRD_FLOW_MAX_RESUMES).fill(carryOn('api_error')))

      await advance(1_000)
      world.endTurn({ apiError: 'overloaded_error' })
      await advance(PRD_FLOW_API_ERROR_BACKOFF_MS + 5_000)

      expect(world.sent).toHaveLength(PRD_FLOW_MAX_RESUMES)
      expect(world.flow()).toMatchObject({
        status: 'needs_attention',
        attention: 'api_error',
        detail: 'The session keeps ending on an API error.',
        retryAt: null
      })
      expect(world.column()).toBe('review')
      expect(world.noticesOf('warning')).toEqual([
        'PRD flow of “Code mode”: The session keeps ending on an API error.'
      ])
    })
  })

  describe('a session that went away', () => {
    it('asks a session that had got to work on the prompt before the app restarted to carry on: its agent died with the app', async () => {
      const world = createWorld({ flow: { promptedAt: BEFORE_APP_START }, signal: null })
      world.recordTurn({
        state: 'working',
        hook_event: 'Working',
        completion: null,
        updated_at: iso(BEFORE_APP_START + 10_000)
      })
      start(world)

      await advance(500)

      expect(world.prompts()).toEqual([carryOn('interrupted')])
      expect(world.flow()).toMatchObject({
        stage: 'prd',
        status: 'running',
        resumes: 1,
        promptedAt: world.sent[0].at
      })
      expect(world.sent[0].at).toBeGreaterThan(Date.parse(APP_STARTED_AT))
    })

    it('sends the PRD prompt itself again when the app quit before the prompt was delivered', async () => {
      // Stamped, and nothing recorded of the session since: the prompt never left the app.
      const world = createWorld({ flow: { promptedAt: BEFORE_APP_START }, signal: null })
      start(world)

      await advance(500)

      expect(world.prompts()).toEqual([prdPrompt])
      expect(world.flow()).toMatchObject({ stage: 'prd', status: 'running', resumes: 1 })
    })

    it('sends the tasks prompt itself again when all that was recorded is the turn before it', async () => {
      const world = createWorld({
        flow: { stage: 'tasks', prdPath: PRD_PATH, promptedAt: BEFORE_APP_START },
        signal: null
      })
      // The end of the PRD turn, which the tasks prompt was stamped after.
      world.recordTurn({ updated_at: iso(BEFORE_APP_START - 5_000) })
      start(world)

      await advance(500)

      expect(world.prompts()).toEqual([tasksPrompt])
      expect(world.flow()).toMatchObject({ stage: 'tasks', status: 'running', resumes: 1 })
    })

    it('does not take the start of the process, recorded after the stamp, for the prompt arriving', async () => {
      const world = createWorld({ flow: { promptedAt: BEFORE_APP_START }, signal: null })
      world.recordTurn({ hook_event: 'SessionStart', updated_at: iso(BEFORE_APP_START + 10_000) })
      start(world)

      await advance(500)

      expect(world.prompts()).toEqual([prdPrompt])
    })

    it('does not wait for work a turn left running before the app restarted: it asks for the file at once', async () => {
      const world = createWorld({ flow: { promptedAt: BEFORE_APP_START }, signal: null })
      world.recordTurn({ background_work: 2, updated_at: iso(BEFORE_APP_START + 30_000) })
      start(world)

      await advance(500)

      expect(world.prompts()).toEqual([carryOn('missing')])
      expect(world.flow()).toMatchObject({ reprompts: 1, waitingSince: null, detail: null })
    })

    it('asks a session that had paused for its own work before the app restarted to carry on, instead of waiting for work that is gone', async () => {
      const world = createWorld({ flow: { promptedAt: BEFORE_APP_START }, signal: null })
      world.recordTurn({ completion: 'waiting', updated_at: iso(BEFORE_APP_START + 30_000) })
      start(world)

      await advance(500)

      expect(world.prompts()).toEqual([carryOn('interrupted')])
      expect(world.flow()).toMatchObject({ resumes: 1, waitingSince: null, detail: null })
    })

    it('still waits for the work of a pause this app instance recorded', async () => {
      const world = createWorld({ signal: null })
      world.recordTurn({ completion: 'waiting' })
      start(world)

      await advance(PRD_FLOW_WAIT_FOR_WORK_MS - 60_000)

      expect(world.sent).toEqual([])
      expect(world.flow().detail).toBe('Waiting for work the session left running.')
    })

    it('goes on from a PRD that was written before the app went away', async () => {
      const world = createWorld({ flow: { promptedAt: BEFORE_APP_START }, signal: null })
      world.writeFile(PRD_PATH)
      start(world)

      await advance(500)

      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })])
      expect(world.flow()).toMatchObject({ stage: 'tasks', resumes: 0 })
    })

    it('does not take a session for dead while the app does not know when it started', async () => {
      const world = createWorld({ flow: { promptedAt: BEFORE_APP_START }, signal: null })
      world.ports.appStartedAt.mockResolvedValue(0)
      start(world)

      await advance(500)

      // No turn end, no start time: only the silence since the prompt speaks, and it is long.
      expect(world.prompts()).toEqual([prdPrompt])
    })

    it('asks a session whose process went away in the middle of its turn to carry on', async () => {
      const world = createWorld()
      start(world)
      await advance(500)

      world.endTurn({ completion: 'none', reason: 'pty_exit' })
      await settle()

      expect(world.prompts()).toEqual([carryOn('interrupted')])
      expect(world.flow()).toMatchObject({ status: 'running', resumes: 1 })
    })

    it('sends the prompt itself again when the process went away before the prompt reached it', async () => {
      // A new session whose process exits before its first word: the person said no to what
      // it asked on opening, or its command failed. Nothing was ever recorded of it.
      const world = createWorld({
        flow: { promptedAt: Date.now() },
        signal: { kind: 'working', since: Date.now() }
      })
      start(world)
      await advance(500)

      world.endTurn({ completion: 'none', reason: 'pty_exit' })
      await settle()

      expect(world.prompts()).toEqual([prdPrompt])
      expect(world.flow()).toMatchObject({ status: 'running', resumes: 1 })
    })

    it('sends the prompt itself again when all that was recorded of a process that went away is the turn before the prompt', async () => {
      const world = createWorld({
        flow: { stage: 'tasks', prdPath: PRD_PATH, promptedAt: Date.now() },
        signal: { kind: 'working', since: Date.now() }
      })
      world.recordTurn({ updated_at: iso(Date.now() - 60_000) })
      start(world)
      await advance(500)

      world.endTurn({ completion: 'none', hookEvent: 'SessionEnd' })
      await settle()

      expect(world.prompts()).toEqual([tasksPrompt])
    })

    it('asks the main process afresh whether the prompt had reached a process that went away, not what it answered a moment ago', async () => {
      const world = createWorld({ flow: { promptedAt: Date.now() }, signal: null })
      start(world)
      // The page knows nothing of the session yet: the main process is asked, and has nothing.
      await advance(500)
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(1)

      // The prompt arrives, the session goes to work on it, and its process goes away.
      world.recordTurn({
        state: 'working',
        hook_event: 'Working',
        completion: null,
        updated_at: iso(Date.now())
      })
      world.endTurn({ completion: 'none', reason: 'pty_exit' })
      await advance(3_500)

      // Within the poll interval of the first answer, which said nothing was recorded.
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(2)
      expect(world.prompts()).toEqual([carryOn('interrupted')])
    })

    it('does not prompt a session whose process went away before the prompt reached it and is there again, held before its first word', async () => {
      const world = createWorld({
        flow: { promptedAt: Date.now() },
        signal: { kind: 'working', since: Date.now() }
      })
      start(world)
      await advance(500)

      // The process exits; the person opens the session again, and it asks them something.
      world.endTurn({ completion: 'none', reason: 'pty_exit' })
      world.heldSessions.add(SESSION_ID)
      await advance(10 * 60_000)

      expect(world.sent).toEqual([])
      expect(world.flow()).toMatchObject({ status: 'running', resumes: 0, detail: SESSION_HELD })
    })

    it('stops once the session kept going away, and says which file is missing', async () => {
      const world = createWorld({
        flow: { stage: 'tasks', prdPath: PRD_PATH, resumes: PRD_FLOW_MAX_RESUMES }
      })
      start(world)

      world.endTurn({ completion: 'none', hookEvent: 'SessionEnd' })
      await settle()

      expect(world.sent).toEqual([])
      expect(world.flow()).toMatchObject({
        status: 'needs_attention',
        attention: 'interrupted',
        detail: 'The session keeps stopping before CODE_MODE_TASKS.html is written.'
      })
      expect(world.column()).toBe('review')
    })
  })

  describe('a prompt that did not arrive', () => {
    it('sends the PRD prompt again when nothing shows of it after the grace period', async () => {
      const world = createWorld({
        flow: { promptedAt: Date.now(), research: false, clarify: true },
        signal: null
      })
      start(world)

      await advance(PRD_FLOW_UNDELIVERED_GRACE_MS - 1_000)
      expect(world.sent).toEqual([])

      await advance(2_000)
      expect(world.prompts()).toEqual([
        buildPrdPrompt({
          prompt: 'Add a code mode to the editor.',
          prefix: PREFIX,
          research: false,
          clarify: true,
          sdk: 'claude-code-cli'
        })
      ])
      expect(world.flow()).toMatchObject({ stage: 'prd', status: 'running', resumes: 1 })
    })

    it('sends the tasks prompt again, naming the PRD where it was found', async () => {
      const prdInApi = `${CWD}/api/${PREFIX}_PRD.html`
      const world = createWorld({
        flow: { stage: 'tasks', prdPath: prdInApi, promptedAt: Date.now() },
        signal: null
      })
      start(world)

      await advance(PRD_FLOW_UNDELIVERED_GRACE_MS + 1_000)

      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: prdInApi })])
    })

    it('goes on instead when the document is there after the grace period', async () => {
      const world = createWorld({ flow: { promptedAt: Date.now() }, signal: null })
      world.writeFile(PRD_PATH)
      start(world)

      await advance(PRD_FLOW_UNDELIVERED_GRACE_MS + 1_000)

      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })])
      expect(world.flow()).toMatchObject({ stage: 'tasks', resumes: 0 })
    })

    it('gives up on a session no prompt reaches, and stays stopped', async () => {
      const world = createWorld({ flow: { promptedAt: Date.now() }, signal: null })
      world.silentSessions.add(SESSION_ID)
      start(world)

      // Nothing shows of the launch prompt: it is sent again, which shows the session as
      // working on the word of the send alone.
      await advance(PRD_FLOW_UNDELIVERED_GRACE_MS + 1_000)
      expect(world.sent).toHaveLength(1)
      expect(world.ports.signal(SESSION_ID)).toMatchObject({ kind: 'working' })

      // Each time that status has stood too long with nothing behind it, the prompt goes again.
      for (let resume = 2; resume <= PRD_FLOW_MAX_RESUMES; resume += 1) {
        await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)
        expect(world.sent).toHaveLength(resume)
        expect(world.flow()).toMatchObject({ status: 'running', resumes: resume })
      }
      expect(world.prompts()).toEqual(Array(PRD_FLOW_MAX_RESUMES).fill(prdPrompt))

      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)
      expect(world.sent).toHaveLength(PRD_FLOW_MAX_RESUMES)
      expect(world.flow()).toMatchObject({
        status: 'needs_attention',
        attention: 'interrupted',
        detail: 'The session keeps stopping before CODE_MODE_PRD.html is written.'
      })
      expect(world.notices).toHaveLength(1)

      // The status no session stood behind is gone: nothing puts the flow back on by itself.
      expect(world.ports.signal(SESSION_ID)).toEqual({ kind: 'unknown' })
      await advance(60 * 60_000)
      expect(world.flow().status).toBe('needs_attention')
      expect(world.sent).toHaveLength(PRD_FLOW_MAX_RESUMES)
      expect(world.notices).toHaveLength(1)
    })
  })

  describe('a session that shows as working on the word of the send alone', () => {
    /**
     * A flow whose prompt was just sent: the page shows the session as working, which is the
     * send's own status, and the main process has recorded nothing of the session since.
     */
    const justSent = (flow: Parameters<typeof makeFlow>[0] = {}): PrdFlowWorld =>
      createWorld({
        flow: { promptedAt: Date.now(), ...flow },
        signal: { kind: 'working', since: Date.now() }
      })

    it('takes the status at its word for a while, then sends the prompt again when the main process never saw the session', async () => {
      const world = justSent()
      start(world)

      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS - 5_000)
      expect(world.sent).toEqual([])
      expect(world.ports.sessionTurn).not.toHaveBeenCalled()
      expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()

      await advance(6_000)
      expect(world.prompts()).toEqual([prdPrompt])
      expect(world.flow()).toMatchObject({
        stage: 'prd',
        status: 'running',
        resumes: 1,
        promptedAt: world.sent[0].at
      })
      // The status nothing stood behind was dropped before the prompt went again.
      expect(world.ports.forgetSessionStatus).toHaveBeenCalledTimes(1)
      expect(world.ports.forgetSessionStatus).toHaveBeenCalledWith(SESSION_ID)
      expect(world.ports.forgetSessionStatus.mock.invocationCallOrder[0]).toBeLessThan(
        world.ports.sendPrompt.mock.invocationCallOrder[0]
      )
      expect(world.notices).toEqual([])
    })

    it('sends the prompt again when the last the main process saw of the session is the turn before the prompt', async () => {
      const world = justSent({ stage: 'tasks', prdPath: PRD_PATH })
      world.recordTurn({ updated_at: iso(Date.now() - 60_000) })
      start(world)

      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)

      expect(world.prompts()).toEqual([tasksPrompt])
      expect(world.flow()).toMatchObject({ stage: 'tasks', status: 'running', resumes: 1 })
      expect(world.ports.forgetSessionStatus).toHaveBeenCalledWith(SESSION_ID)
      // The session took a turn before: it is past whatever a process shows before its first.
      expect(world.ports.isSessionStarted).not.toHaveBeenCalled()
    })

    it.each([
      ['at work', { state: 'working', hook_event: 'Working', completion: null }],
      ['waiting for the person', { state: 'blocked', hook_event: 'answering', completion: null }],
      ['ending a turn', {}]
    ] as const)(
      'believes the status once the main process recorded the session %s after the prompt, and does not ask again',
      async (_what, turn) => {
        const world = justSent()
        world.recordTurn({ ...turn, updated_at: iso(Date.now() + 5_000) })
        start(world)

        await advance(2 * 60 * 60_000)

        expect(world.sent).toEqual([])
        expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
        expect(world.ports.sessionTurn).toHaveBeenCalledTimes(1)
        expect(world.flow()).toEqual(makeFlow({ promptedAt: Date.parse(TEST_NOW) }))
      }
    )

    it('believes a status that is older than the stamp once the main process recorded the session at work after that status', async () => {
      // The session was put to work a moment before the flow's stamp was written, and the
      // main process saw it at work in between: that record stands behind the status.
      const world = createWorld({
        flow: { promptedAt: Date.now() },
        signal: { kind: 'working', since: Date.now() - 10_000 }
      })
      world.recordTurn({
        state: 'working',
        hook_event: 'Working',
        completion: null,
        updated_at: iso(Date.now() - 9_000)
      })
      start(world)

      await advance(2 * 60 * 60_000)

      expect(world.sent).toEqual([])
      expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
      // Asked once, and not about whether the session has a process: the record said enough.
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(1)
      expect(world.ports.isSessionStarted).not.toHaveBeenCalled()
    })

    it('asks about the next prompt of the same session again', async () => {
      const world = justSent()
      world.recordTurn({
        state: 'working',
        hook_event: 'Working',
        completion: null,
        updated_at: iso(Date.now() + 5_000)
      })
      world.silentSessions.add(SESSION_ID)
      world.writeFile(PRD_PATH)
      start(world)
      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(1)

      // The PRD turn ends; the tasks prompt is sent, and this one the session never gets.
      world.recordTurn({ updated_at: iso(Date.now()) })
      world.endTurn()
      await settle()
      expect(world.prompts()).toEqual([tasksPrompt])

      // Asked again about this prompt, and once more, afresh, before it is sent again.
      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(3)
      expect(world.ports.forgetSessionStatus).toHaveBeenCalledTimes(1)
      expect(world.prompts()).toEqual([tasksPrompt, tasksPrompt])
    })

    it('keeps waiting when the main process only knows the session at work from before the prompt: that cannot say', async () => {
      const world = justSent()
      world.recordTurn({
        state: 'working',
        hook_event: 'Working',
        completion: null,
        updated_at: iso(Date.now() - 60_000)
      })
      start(world)

      await advance(30 * 60_000)

      expect(world.sent).toEqual([])
      expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
      expect(world.flow()).toEqual(makeFlow({ promptedAt: Date.parse(TEST_NOW) }))
      // The session has a process, which is all that speaks for it being at work.
      expect(world.ports.isSessionStarted).toHaveBeenCalledWith(SESSION_ID)
      // It looks again on later ticks, in case the record moves on.
      expect(world.ports.sessionTurn.mock.calls.length).toBeGreaterThan(1)

      // And it does: the session ended a turn it never began for this prompt.
      world.recordTurn({ updated_at: iso(Date.parse(TEST_NOW) - 30_000) })
      await advance(30_000)
      expect(world.prompts()).toEqual([prdPrompt])
    })

    describe('when the main process only knows the session at work from before the prompt', () => {
      /** The session died in the middle of a turn, which left its record saying "working". */
      const staleWork = (): PrdFlowWorld => {
        const world = justSent()
        world.recordTurn({
          state: 'working',
          hook_event: 'Working',
          completion: null,
          updated_at: iso(Date.now() - 60_000)
        })
        return world
      }

      it.each([
        ['at work', { state: 'working', hook_event: 'Working' }],
        ['waiting for the person', { state: 'blocked', hook_event: 'answering' }]
      ] as const)(
        'sends the prompt again when that record says %s and the session has no process: its revival died before its first word',
        async (_what, turn) => {
          const world = staleWork()
          world.recordTurn({ ...turn, completion: null, updated_at: iso(Date.now() - 60_000) })
          world.unstartedSessions.add(SESSION_ID)
          start(world)

          await advance(PRD_FLOW_UNCONFIRMED_WORK_MS - 5_000)
          expect(world.ports.isSessionStarted).not.toHaveBeenCalled()
          expect(world.sent).toEqual([])

          await advance(6_000)
          expect(world.ports.isSessionStarted).toHaveBeenCalledWith(SESSION_ID)
          expect(world.prompts()).toEqual([prdPrompt])
          expect(world.flow()).toMatchObject({ status: 'running', resumes: 1 })
          expect(world.ports.forgetSessionStatus).toHaveBeenCalledWith(SESSION_ID)
          expect(world.ports.forgetSessionStatus.mock.invocationCallOrder[0]).toBeLessThan(
            world.ports.sendPrompt.mock.invocationCallOrder[0]
          )
        }
      )

      it('keeps waiting while it cannot find out whether the session has a process, and asks again', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const world = staleWork()
        world.unstartedSessions.add(SESSION_ID)
        world.ports.isSessionStarted.mockRejectedValueOnce(new Error('WebSocket is not open'))
        start(world)

        await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)
        expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(1)
        expect(world.sent).toEqual([])
        expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
        expect(world.flow()).toEqual(makeFlow({ promptedAt: Date.parse(TEST_NOW) }))
        expect(warn).toHaveBeenCalledTimes(1)

        await advance(15_000)
        expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(2)
        expect(world.prompts()).toEqual([prdPrompt])
      })

      it('leaves a session that came to life while it was asked whether it has a process', async () => {
        const world = staleWork()
        let answer: (started: boolean) => void = () => {}
        world.ports.isSessionStarted.mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve) => {
              answer = resolve
            })
        )
        start(world)
        await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)
        expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(1)

        // The person sends the session a message of their own meanwhile.
        world.setSignal(SESSION_ID, { kind: 'working' }, { recorded: false })
        answer(false)
        await advance(1_000)

        expect(world.sent).toEqual([])
        expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
      })

      it('asks whether the session has a process at most once per poll interval, however often it looks', async () => {
        const world = staleWork()
        const running = start(world)
        await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)
        expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(1)

        for (let look = 0; look < 4; look += 1) {
          running.requestTick()
          await advance(1_000)
        }
        expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(1)

        await advance(PRD_FLOW_TURN_POLL_MS)
        running.requestTick()
        await advance(1_000)
        expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(2)
        expect(world.sent).toEqual([])
      })
    })

    it('goes on, instead of sending the prompt again, when the document is there after all', async () => {
      const world = justSent()
      world.writeFile(PRD_PATH)
      start(world)

      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)

      expect(world.prompts()).toEqual([tasksPrompt])
      expect(world.flow()).toMatchObject({ stage: 'tasks', resumes: 0, prdPath: PRD_PATH })
      expect(world.ports.forgetSessionStatus).toHaveBeenCalledWith(SESSION_ID)
    })

    it('leaves a status that moved on while the main process was asked: that one is the session own', async () => {
      const world = justSent()
      let answer: (turn: null) => void = () => {}
      world.ports.sessionTurn.mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            answer = resolve
          })
      )
      start(world)
      await advance(PRD_FLOW_UNCONFIRMED_WORK_MS + 1_000)
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(1)

      // The session asks the person something while the main process is slow to answer.
      world.setSignal(SESSION_ID, { kind: 'blocked', reason: 'question', detail: 'Which one?' })
      answer(null)
      await advance(1_000)

      expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
      expect(world.sent).toEqual([])
      expect(world.flow().detail).toBe('Waiting for you: Which one?')
    })
  })

  describe('a session that has a process and has not taken a turn: it is held before its first word', () => {
    // The process asks the person whether the folder is trusted, or to log in, or is slow to
    // start. Nothing is recorded of such a session, and a prompt sent into it is typed into
    // whatever it shows.

    /** The two looks that find a prompt undelivered, each with the wait it takes. */
    const LOOKS = [
      [
        'shows as working on the word of the send alone',
        { kind: 'working', since: Date.parse(TEST_NOW) },
        PRD_FLOW_UNCONFIRMED_WORK_MS
      ],
      ['shows nothing of the prompt', null, PRD_FLOW_UNDELIVERED_GRACE_MS]
    ] as const

    const justPrompted = (signal: (typeof LOOKS)[number][1]): PrdFlowWorld =>
      createWorld({ flow: { promptedAt: Date.now() }, signal })

    /** Every `detail` the driver wrote, in order, whether or not the write changed anything. */
    const detailsWritten = (world: PrdFlowWorld): unknown[] =>
      world.ports.patch.mock.calls
        .map(([, patch]) => patch)
        .filter((patch) => 'detail' in patch)
        .map((patch) => patch.detail)

    describe.each(LOOKS)('when the session %s', (_what, signal, wait) => {
      it('sends nothing, counts no resume and says that it waits for the person', async () => {
        const world = justPrompted(signal)
        world.heldSessions.add(SESSION_ID)
        start(world)

        await advance(wait - 5_000)
        expect(world.ports.isSessionStarted).not.toHaveBeenCalled()
        expect(world.flow().detail).toBeNull()

        await advance(6_000)
        expect(world.ports.isSessionStarted).toHaveBeenCalledWith(SESSION_ID)
        expect(world.sent).toEqual([])
        expect(world.flow()).toEqual(
          makeFlow({ promptedAt: Date.parse(TEST_NOW), detail: SESSION_HELD })
        )
        // The status the page shows of the session is not touched, and nobody is alarmed.
        expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
        expect(world.notices).toEqual([])
        expect(world.moves).toEqual([])
      })

      it('goes on saying so for as long as the session is held, writing the sentence once', async () => {
        const world = justPrompted(signal)
        world.heldSessions.add(SESSION_ID)
        start(world)
        await advance(wait + 1_000)
        expect(world.flow().detail).toBe(SESSION_HELD)
        const written = detailsWritten(world).length

        await advance(60 * 60_000)

        expect(world.sent).toEqual([])
        expect(world.flow()).toEqual(
          makeFlow({ promptedAt: Date.parse(TEST_NOW), detail: SESSION_HELD })
        )
        // Nothing took the sentence away to put it back on a later look.
        expect(detailsWritten(world).slice(written)).toEqual([])
      })

      it('goes on by itself once the session gets to work', async () => {
        const world = justPrompted(signal)
        world.heldSessions.add(SESSION_ID)
        world.writeFile(PRD_PATH)
        start(world)
        await advance(wait + 1_000)
        expect(world.flow().detail).toBe(SESSION_HELD)

        // The person answers what it asked: the prompt that waited in it is taken up.
        world.heldSessions.delete(SESSION_ID)
        world.setSignal(SESSION_ID, { kind: 'working' })
        await advance(15_000)
        expect(world.flow()).toMatchObject({ status: 'running', detail: null, resumes: 0 })
        expect(world.sent).toEqual([])

        world.endTurn()
        await settle()
        expect(world.prompts()).toEqual([tasksPrompt])
      })

      it('does nothing on a look that could not find out whether the session has a process, and asks again', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const world = justPrompted(signal)
        world.heldSessions.add(SESSION_ID)
        world.ports.isSessionStarted.mockRejectedValueOnce(new Error('WebSocket is not open'))
        start(world)

        await advance(wait + 1_000)
        expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(1)
        expect(world.sent).toEqual([])
        expect(world.flow()).toEqual(makeFlow({ promptedAt: Date.parse(TEST_NOW) }))
        expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledTimes(1)

        await advance(15_000)
        expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(2)
        expect(world.sent).toEqual([])
        expect(world.flow().detail).toBe(SESSION_HELD)
      })

      it('sends the prompt again to a session that has no process and nothing on record, as an SDK session that was never prompted has', async () => {
        const world = justPrompted(signal)
        world.ports.isSessionStarted.mockResolvedValue(false)
        start(world)

        await advance(wait + 1_000)

        expect(world.ports.isSessionStarted).toHaveBeenCalledWith(SESSION_ID)
        expect(world.ports.isSessionStarted.mock.invocationCallOrder[0]).toBeLessThan(
          world.ports.sendPrompt.mock.invocationCallOrder[0]
        )
        expect(world.prompts()).toEqual([prdPrompt])
        expect(world.flow()).toMatchObject({ status: 'running', resumes: 1, detail: null })
      })

      it('asks about a held session at most once per poll interval, however often it looks', async () => {
        const world = justPrompted(signal)
        world.heldSessions.add(SESSION_ID)
        const running = start(world)
        await advance(wait + 1_000)
        const asked = world.ports.isSessionStarted.mock.calls.length
        const read = world.ports.sessionTurn.mock.calls.length

        for (let look = 0; look < 3; look += 1) {
          running.requestTick()
          await advance(1_000)
        }

        expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(asked)
        expect(world.ports.sessionTurn).toHaveBeenCalledTimes(read)
      })
    })

    it('sends nothing when the main process has the prompt on record by the time it would be sent again, whatever it answered a moment ago', async () => {
      const world = justPrompted(null)
      const running = start(world)
      await advance(PRD_FLOW_UNDELIVERED_GRACE_MS - 2_000)

      // Asked two seconds before the wait is over: nothing is recorded. Then the prompt arrives.
      running.requestTick()
      await advance(1_000)
      const read = world.ports.sessionTurn.mock.calls.length
      world.recordTurn({
        state: 'working',
        hook_event: 'Working',
        completion: null,
        updated_at: iso(Date.now())
      })
      await advance(1_500)

      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(read + 1)
      expect(world.sent).toEqual([])
      expect(world.ports.isSessionStarted).not.toHaveBeenCalled()
      expect(world.flow()).toEqual(makeFlow({ promptedAt: Date.parse(TEST_NOW) }))
    })

    it('leaves a session the person put to work while it was asked whether the session has a process', async () => {
      const world = justPrompted(null)
      let answer: (started: boolean) => void = () => {}
      world.ports.isSessionStarted.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          })
      )
      start(world)
      await advance(PRD_FLOW_UNDELIVERED_GRACE_MS + 1_000)
      expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(1)

      world.setSignal(SESSION_ID, { kind: 'working' }, { recorded: false })
      answer(false)
      await advance(1_000)

      expect(world.sent).toEqual([])
      expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
    })

    it('stops waiting for a held session whose process went away: the prompt is sent again', async () => {
      const world = justPrompted(null)
      world.heldSessions.add(SESSION_ID)
      start(world)
      await advance(PRD_FLOW_UNDELIVERED_GRACE_MS + 1_000)
      expect(world.flow().detail).toBe(SESSION_HELD)

      world.heldSessions.delete(SESSION_ID)
      await advance(15_000)

      expect(world.prompts()).toEqual([prdPrompt])
      expect(world.flow()).toMatchObject({ resumes: 1, detail: null })
    })
  })

  describe('a page that was reloaded while the session worked', () => {
    it('goes on from a turn end the main process recorded while the page was away', async () => {
      const world = createWorld({ signal: null })
      world.recordTurn()
      world.writeFile(PRD_PATH)
      start(world)

      await advance(500)

      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })])
    })

    it('asks again after a recorded turn end that left no file', async () => {
      const world = createWorld({ signal: null })
      world.recordTurn()
      start(world)

      await advance(500)

      expect(world.prompts()).toEqual([carryOn('missing')])
      expect(world.flow().reprompts).toBe(1)
    })

    it('ignores a turn end recorded before the prompt', async () => {
      const world = createWorld({ flow: { promptedAt: Date.now() }, signal: null })
      world.recordTurn({ updated_at: new Date(PROMPTED_AT).toISOString() })
      world.writeFile(PRD_PATH)
      start(world)

      await advance(30_000)

      expect(world.sent).toEqual([])
    })

    it('waits for a session the main process recorded at work since the prompt', async () => {
      const world = createWorld({ signal: null })
      world.recordTurn({ state: 'working', hook_event: 'Working', completion: null })
      start(world)

      await advance(30 * 60_000)

      expect(world.sent).toEqual([])
      expect(world.flow()).toEqual(makeFlow())
    })

    it('says that the session waits for the person when the main process recorded that', async () => {
      const world = createWorld({ signal: null })
      world.recordTurn({ state: 'blocked', hook_event: 'answering', completion: null })
      start(world)

      await advance(500)

      expect(world.flow().detail).toBe('Waiting for you: a question')
      expect(world.sent).toEqual([])
    })

    it('makes a recorded end wait out the settle delay too', async () => {
      const world = createWorld({ signal: null })
      world.recordTurn({ updated_at: new Date(Date.now() - 1_000).toISOString() })
      world.writeFile(PRD_PATH)
      start(world)

      await advance(1_000)
      expect(world.sent).toEqual([])

      await advance(10_000)
      expect(world.sent).toHaveLength(1)
    })

    it('asks the main process about a session at most once per poll interval', async () => {
      const world = createWorld({ flow: { promptedAt: Date.now() }, signal: null })
      const running = start(world)

      for (let second = 0; second < 4; second += 1) {
        running.requestTick()
        await advance(1_000)
      }
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(1)

      await advance(PRD_FLOW_TURN_POLL_MS)
      running.requestTick()
      await advance(1_000)
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(2)
    })
  })

  describe('a page that was reloaded while the session was being started', () => {
    it('adopts the session the launch linked to the ticket, keeping the stamp of its prompt', async () => {
      const world = createWorld({
        flow: { stage: 'launching', sessionId: null },
        ticket: { sessionId: 'session-9' },
        signal: null
      })
      world.setSignal('session-9', { kind: 'working' })
      start(world)

      await advance(500)

      expect(world.ports.isSessionStarted).toHaveBeenCalledWith('session-9')
      expect(world.flow()).toEqual(makeFlow({ stage: 'prd', sessionId: 'session-9' }))
      expect(world.sent).toEqual([])
      expect(world.discarded).toEqual([])
      expect(world.notices).toEqual([])
    })

    it('closes a session whose agent was never started, returns its ticket to To Do and waits for Retry', async () => {
      // The launch was cut off between linking the ticket and starting the agent.
      const world = createWorld({
        flow: { stage: 'launching', sessionId: 'session-9' },
        ticket: { sessionId: 'session-9' },
        signal: null
      })
      world.unstartedSessions.add('session-9')
      start(world)

      await advance(500)

      expect(world.discarded).toEqual([{ ticketId: TICKET_ID, sessionId: 'session-9' }])
      expect(world.ticket(TICKET_ID)).toMatchObject({ column: 'todo', sessionId: null })
      expect(world.flow()).toMatchObject({
        stage: 'launching',
        status: 'needs_attention',
        attention: 'launch_failed',
        detail: 'The session was not started.',
        sessionId: null
      })
      expect(world.noticesOf('warning')).toEqual([
        'PRD flow of “Code mode”: The session was not started.'
      ])
      expect(world.sent).toEqual([])

      // The ticket has no session now: the flow stays, for Retry to launch it afresh.
      await advance(60 * 60_000)
      expect(world.hasFlow()).toBe(true)
      expect(world.discarded).toHaveLength(1)
      expect(world.notices).toHaveLength(1)
    })

    it('decides nothing while it cannot tell whether the session was started, and asks again', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const world = createWorld({
        flow: { stage: 'launching', sessionId: null },
        ticket: { sessionId: 'session-9' },
        signal: null
      })
      world.setSignal('session-9', { kind: 'working' })
      world.ports.isSessionStarted.mockRejectedValueOnce(new Error('WebSocket is not open'))
      start(world)

      await advance(500)
      expect(world.flow()).toEqual(makeFlow({ stage: 'launching', sessionId: null }))
      expect(world.discarded).toEqual([])
      expect(world.notices).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)

      await advance(15_000)
      expect(world.ports.isSessionStarted).toHaveBeenCalledTimes(2)
      expect(world.flow()).toMatchObject({ stage: 'prd', sessionId: 'session-9' })
    })

    it('does not act on the answer about a session the ticket no longer points at', async () => {
      const world = createWorld({
        flow: { stage: 'launching', sessionId: null },
        ticket: { sessionId: 'session-9' },
        signal: null
      })
      let answer: (started: boolean) => void = () => {}
      world.ports.isSessionStarted.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          })
      )
      start(world)
      await advance(500)

      world.setSignal('session-10', { kind: 'working' })
      world.setTicket({ sessionId: 'session-10' })
      answer(false)
      await advance(1_000)

      // Neither closed nor adopted on that answer; the ticket's session now is asked about.
      expect(world.discarded).toEqual([])
      expect(world.ports.isSessionStarted).toHaveBeenLastCalledWith('session-10')
      expect(world.flow()).toMatchObject({ stage: 'prd', sessionId: 'session-10' })
    })

    it('follows the adopted session like any other', async () => {
      const world = createWorld({
        flow: { stage: 'launching', sessionId: null },
        ticket: { sessionId: 'session-9' },
        signal: null
      })
      world.setSignal('session-9', { kind: 'working' })
      world.writeFile(PRD_PATH)
      start(world)
      await advance(500)

      world.endTurn({}, 'session-9')
      await settle()

      expect(world.sent.map((entry) => entry.sessionId)).toEqual(['session-9'])
      expect(world.flow().stage).toBe('tasks')
    })

    it('says that the session was not started when the ticket has none', async () => {
      const world = createWorld({
        flow: { stage: 'launching', sessionId: null },
        ticket: { sessionId: null, column: 'todo' },
        signal: null
      })
      start(world)

      await advance(500)

      expect(world.flow()).toMatchObject({
        stage: 'launching',
        status: 'needs_attention',
        attention: 'launch_failed',
        detail: 'The session was not started.',
        sessionId: null
      })
      expect(world.column()).toBe('todo')
      expect(world.moves).toEqual([])
      expect(world.noticesOf('warning')).toEqual([
        'PRD flow of “Code mode”: The session was not started.'
      ])

      // It waits for Retry, which starts the session again; the driver does nothing meanwhile.
      await advance(60 * 60_000)
      expect(world.notices).toHaveLength(1)
      expect(world.sent).toEqual([])
    })

    describe('a launch that failed and waits for Retry', () => {
      const failed = {
        stage: 'launching',
        status: 'needs_attention',
        attention: 'launch_failed',
        detail: 'The session could not be started: no model.',
        sessionId: null
      } as const

      it('is left to Retry for as long as its ticket has no session', async () => {
        const world = createWorld({ flow: failed, ticket: { sessionId: null, column: 'todo' } })
        start(world)

        await advance(60 * 60_000)

        expect(world.flow()).toEqual(makeFlow(failed))
        expect(world.notices).toEqual([])
        expect(world.ports.isSessionStarted).not.toHaveBeenCalled()
      })

      it('is forgotten once somebody launched its ticket by hand: Retry would put a second session over theirs', async () => {
        const world = createWorld({ flow: failed, ticket: { sessionId: null, column: 'todo' } })
        start(world)
        await advance(1_000)

        world.setTicket({ sessionId: 'session-9', column: 'in_progress' })
        await advance(1_000)

        expect(world.hasFlow()).toBe(false)
        expect(world.notices).toEqual([
          {
            level: 'info',
            message: 'PRD flow of “Code mode” stopped: its ticket was given another session.'
          }
        ])
        // Their session and their ticket are left exactly as they are.
        expect(world.discarded).toEqual([])
        expect(world.moves).toEqual([])
        expect(world.sent).toEqual([])
      })

      it('is left to Retry while its ticket still points at a closed session, though the flow does not know it for its own', async () => {
        // The ticket could not be put back when the launch failed, and the board of this page
        // did not show the link then.
        const world = createWorld({
          flow: failed,
          ticket: { sessionId: 'session-9', column: 'in_progress' }
        })
        world.closedSessions.add('session-9')
        start(world)

        await advance(60_000)

        expect(world.flow()).toEqual(makeFlow(failed))
        expect(world.notices).toEqual([])
      })

      it.each([
        ['which was closed', true],
        ['which could not be closed either', false]
      ] as const)(
        'remembers the session a cut-off launch left when the ticket could not be put back (%s), and is not forgotten over it',
        async (_what, closed) => {
          const world = createWorld({
            flow: { stage: 'launching', sessionId: null },
            ticket: { sessionId: 'session-9' },
            signal: null
          })
          world.unstartedSessions.add('session-9')
          // The ticket keeps its link to the session, and the port says so.
          world.ports.discardLaunch.mockImplementationOnce(async (_flow, sessionId) => {
            if (closed) world.closedSessions.add(sessionId)
            return true
          })
          start(world)

          await advance(60 * 60_000)

          expect(world.flow()).toMatchObject({
            stage: 'launching',
            status: 'needs_attention',
            attention: 'launch_failed',
            sessionId: 'session-9'
          })
          expect(world.noticesOf('info')).toEqual([])
          expect(world.ports.discardLaunch).toHaveBeenCalledTimes(1)
          // Its own session is known for what it is: nobody is asked whether it is closed.
          expect(world.ports.isSessionClosed).not.toHaveBeenCalled()
        }
      )

      it('is left to Retry while its ticket points at its own failed session, though that session is still open', async () => {
        // Neither the session nor the ticket could be taken back when the launch failed.
        const world = createWorld({
          flow: { ...failed, sessionId: 'session-9' },
          ticket: { sessionId: 'session-9', column: 'in_progress' }
        })
        start(world)

        await advance(60 * 60_000)

        expect(world.flow()).toEqual(makeFlow({ ...failed, sessionId: 'session-9' }))
        expect(world.notices).toEqual([])
        expect(world.ports.isSessionClosed).not.toHaveBeenCalled()
        expect(world.sent).toEqual([])
      })

      it('is forgotten all the same once the ticket has a session that is not its own', async () => {
        const world = createWorld({
          flow: { ...failed, sessionId: 'session-9' },
          ticket: { sessionId: 'session-9', column: 'in_progress' }
        })
        start(world)
        await advance(1_000)

        world.setTicket({ sessionId: 'session-10' })
        await advance(1_000)

        expect(world.hasFlow()).toBe(false)
        expect(world.noticesOf('info')).toEqual([
          'PRD flow of “Code mode” stopped: its ticket was given another session.'
        ])
        expect(world.discarded).toEqual([])
      })
    })

    it('keeps off a flow whose session this page is starting', async () => {
      const world = createWorld({
        flow: { stage: 'launching', sessionId: null, promptedAt: Date.now() },
        ticket: { sessionId: null, column: 'todo' },
        signal: null
      })
      world.launching.add(TICKET_ID)
      start(world)

      await advance(5 * 60_000)

      expect(world.flow()).toEqual(
        makeFlow({ stage: 'launching', sessionId: null, promptedAt: Date.parse(TEST_NOW) })
      )
      expect(world.notices).toEqual([])
      expect(world.sent).toEqual([])
      expect(world.ports.sessionTurn).not.toHaveBeenCalled()
    })

    it('keeps off for as long as the launch lasts, whatever stage the launch has written', async () => {
      const world = createWorld({ flow: { promptedAt: Date.now() }, signal: null })
      world.launching.add(TICKET_ID)
      start(world)

      await advance(5 * 60_000)
      expect(world.sent).toEqual([])
      expect(world.ports.sessionTurn).not.toHaveBeenCalled()

      // The launch is over: the flow is the driver's from here.
      world.launching.delete(TICKET_ID)
      await advance(15_000)
      expect(world.sent).toHaveLength(1)
    })

    it('judges nothing before the board is loaded', async () => {
      const world = createWorld({
        flow: { stage: 'launching', sessionId: null },
        ticket: 'loading',
        signal: null
      })
      start(world)

      await advance(60_000)
      expect(world.flow()).toEqual(makeFlow({ stage: 'launching', sessionId: null }))
      expect(world.notices).toEqual([])

      world.setTicket({ sessionId: 'session-9' })
      world.setSignal('session-9', { kind: 'working' })
      await advance(1_000)
      expect(world.flow()).toMatchObject({ stage: 'prd', sessionId: 'session-9' })
    })

    it('sends a document stage that lost its session back to the start, where the ticket is asked', async () => {
      const world = createWorld({
        flow: { stage: 'prd', sessionId: null },
        ticket: { sessionId: null, column: 'todo' },
        signal: null
      })
      start(world)

      await advance(1_000)

      expect(world.flow()).toMatchObject({
        stage: 'launching',
        status: 'needs_attention',
        attention: 'launch_failed'
      })
      expect(world.sent).toEqual([])
    })
  })
})
