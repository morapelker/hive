import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTasksPrompt } from '@shared/document-flow/prd-flow'
import { PrdFlowDriver } from './driver'
import {
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
import { PRD_FLOW_SETTLE_MS } from './ports'

// The driver's way from one document to the next: what it takes for a turn end to count, what
// it does when the PRD is there, and that a flow is never worked on twice at the same time.

describe('PrdFlowDriver: from the PRD to the tasks prompt', () => {
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

  describe('a finished turn', () => {
    it('sends the tasks prompt into the same session once the PRD exists, stamping the flow before the prompt goes', async () => {
      const world = createWorld()
      start(world)
      await advance(500)

      world.writeFile(PRD_PATH)
      world.endTurn()
      await settle()

      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })])
      const [sent] = world.sent
      expect(sent.sessionId).toBe(SESSION_ID)
      // The store held the stamp, and the new stage, when the prompt left.
      expect(sent.flow).toMatchObject({
        stage: 'tasks',
        status: 'running',
        promptedAt: sent.at,
        prdPath: PRD_PATH
      })
      expect(sent.at).toBeGreaterThan(PROMPTED_AT)
      expect(world.flow()).toMatchObject({
        stage: 'tasks',
        status: 'running',
        attention: null,
        detail: null,
        reprompts: 0,
        resumes: 0,
        prdPath: PRD_PATH,
        tasksPath: null
      })
      expect(world.column()).toBe('in_progress')
      expect(world.moves).toEqual([])
      expect(world.notices).toEqual([])
    })

    it('starts the tasks stage with its counts fresh, whatever the PRD took', async () => {
      const world = createWorld({ flow: { reprompts: 1, resumes: 2 } })
      world.writeFile(PRD_PATH)
      start(world)

      world.endTurn()
      await settle()

      expect(world.flow()).toMatchObject({ stage: 'tasks', reprompts: 0, resumes: 0 })
    })

    it('acts on a finished turn only after it stood for the settle delay', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      start(world)
      await advance(500)

      world.endTurn()
      await advance(PRD_FLOW_SETTLE_MS - 500)
      expect(world.sent).toEqual([])
      expect(world.ports.fileExists).not.toHaveBeenCalled()
      expect(world.flow().stage).toBe('prd')

      await advance(1_000)
      expect(world.sent).toHaveLength(1)
      expect(world.flow().stage).toBe('tasks')
    })

    it('ignores an end that bounces back to working within the settle delay', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      start(world)

      world.endTurn()
      await advance(2_000)
      world.setSignal(SESSION_ID, { kind: 'working' })
      await advance(60_000)

      expect(world.sent).toEqual([])
      expect(world.flow()).toEqual(makeFlow())
    })

    it('ignores an end left over from before the prompt', async () => {
      const world = createWorld({
        flow: { promptedAt: Date.now() },
        signal: {
          kind: 'ended',
          at: Date.now() - 1_000,
          completion: 'completed',
          apiError: null,
          reason: null,
          hookEvent: 'Stop',
          hasBackgroundWork: false
        }
      })
      world.writeFile(PRD_PATH)
      start(world)

      await advance(30_000)

      expect(world.sent).toEqual([])
      expect(world.ports.fileExists).not.toHaveBeenCalled()
      expect(world.flow().stage).toBe('prd')
    })

    it('does not take the blip of a session that is starting up for a turn end', async () => {
      const world = createWorld({ flow: { promptedAt: Date.now() - 1_000 }, signal: null })
      world.writeFile(PRD_PATH)
      start(world)

      world.endTurn({ hookEvent: 'SessionStart' })
      await advance(30_000)
      expect(world.sent).toEqual([])

      // The launch prompt puts it to work, and its real end counts.
      world.setSignal(SESSION_ID, { kind: 'working' })
      await advance(1_000)
      world.endTurn({ hookEvent: 'Stop' })
      await settle()
      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })])
    })

    it('finds a PRD the agent wrote into a member repository of a connection directory', async () => {
      const inApi = `${CWD}/api/${PREFIX}_PRD.html`
      const world = createWorld({
        flow: {
          checkout: { kind: 'connection', connectionId: 'conn-base' },
          memberDirs: ['web', 'api']
        }
      })
      world.writeFile(inApi)
      start(world)

      world.endTurn()
      await settle()

      expect(world.ports.fileExists.mock.calls.map(([path]) => path)).toEqual([
        PRD_PATH,
        `${CWD}/web/${PREFIX}_PRD.html`,
        inApi
      ])
      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: inApi })])
      expect(world.flow().prdPath).toBe(inApi)
    })
  })

  describe('a session that is not done', () => {
    it('waits while the session works, however long, without looking for the file', async () => {
      const world = createWorld()
      start(world)

      await advance(2 * 60 * 60_000)

      expect(world.sent).toEqual([])
      expect(world.ports.fileExists).not.toHaveBeenCalled()
      // The main process is asked once whether the session really got to the prompt, and
      // never again once it said so.
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(1)
      expect(world.ports.forgetSessionStatus).not.toHaveBeenCalled()
      expect(world.flow()).toEqual(makeFlow())
      expect(world.notices).toEqual([])
    })

    it('says that the session waits for the person, and prompts nothing', async () => {
      const world = createWorld()
      start(world)

      world.setSignal(SESSION_ID, {
        kind: 'blocked',
        reason: 'question',
        detail: 'Which database do we use?'
      })
      await advance(10 * 60_000)

      expect(world.flow()).toMatchObject({
        status: 'running',
        detail: 'Waiting for you: Which database do we use?'
      })
      expect(world.sent).toEqual([])
      expect(world.column()).toBe('in_progress')
      expect(world.notices).toEqual([])
    })

    it('names what a blocked session waits for when the session did not say', async () => {
      const world = createWorld()
      start(world)

      world.setSignal(SESSION_ID, { kind: 'blocked', reason: 'permission', detail: null })
      await advance(1_000)

      expect(world.flow().detail).toBe('Waiting for you: a permission request')
    })

    it('stops saying so once the person answered and the session is back at work', async () => {
      const world = createWorld()
      start(world)
      world.setSignal(SESSION_ID, { kind: 'blocked', reason: 'plan', detail: null })
      await advance(1_000)
      expect(world.flow().detail).toBe('Waiting for you: a plan to review')

      world.setSignal(SESSION_ID, { kind: 'working' })
      await advance(1_000)

      expect(world.flow().detail).toBeNull()
    })
  })

  describe('ticks', () => {
    it('never starts a second step for a flow while one is in flight', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      let answer: (exists: boolean) => void = () => {}
      world.ports.fileExists.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          })
      )
      const running = start(world)
      world.endTurn({ at: Date.now() - 10_000 })
      await advance(500)
      expect(world.ports.fileExists).toHaveBeenCalledTimes(1)

      // The disk is slow to answer; ticks keep coming.
      running.requestTick()
      await advance(500)
      world.setSignal(SESSION_ID, { ...world.ports.signal(SESSION_ID) })
      await advance(30_000)
      expect(world.ports.fileExists).toHaveBeenCalledTimes(1)
      expect(world.sent).toEqual([])

      answer(true)
      await advance(1_000)
      expect(world.sent).toHaveLength(1)
    })

    it('looks at a flow again as soon as its step ends when a tick passed it over meanwhile', async () => {
      const world = createWorld({ flow: { promptedAt: Date.now() }, signal: null })
      let answer: (turn: null) => void = () => {}
      world.ports.sessionTurn.mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            answer = resolve
          })
      )
      start(world)
      await advance(500)

      // The ticket goes while the main process is slow to answer about the session.
      world.setTicket('gone')
      await advance(500)
      expect(world.hasFlow()).toBe(true)

      answer(null)
      await advance(500)
      expect(world.hasFlow()).toBe(false)
    })

    it('drops a step whose flow was written under it', async () => {
      const world = createWorld({ flow: { promptedAt: Date.now() - 2 * 60_000 }, signal: null })
      let answer: (turn: null) => void = () => {}
      world.ports.sessionTurn.mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            answer = resolve
          })
      )
      start(world)
      await advance(500)

      // The step read a flow whose prompt went unanswered for too long; while it asks about
      // the session, the flow is prompted from elsewhere.
      world.patchFlow({ promptedAt: Date.now() })
      answer(null)
      await advance(1_000)

      expect(world.sent).toEqual([])
      expect(world.flow().resumes).toBe(0)
    })

    it('finishes nothing once it is stopped: a step in flight sends no prompt', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      let answer: (exists: boolean) => void = () => {}
      world.ports.fileExists.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          })
      )
      const running = start(world)
      world.endTurn({ at: Date.now() - 10_000 })
      await advance(500)
      expect(world.ports.fileExists).toHaveBeenCalledTimes(1)

      running.stop()
      answer(true)
      await advance(1_000)

      expect(world.sent).toEqual([])
      expect(world.flow()).toEqual(makeFlow())
    })

    it('sends a prompt once when ticks come while it is on its way', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      let delivered: () => void = () => {}
      world.ports.sendPrompt.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            delivered = resolve
          })
      )
      const running = start(world)
      world.endTurn({ at: Date.now() - 10_000 })
      await advance(500)
      expect(world.ports.sendPrompt).toHaveBeenCalledTimes(1)

      running.requestTick()
      await advance(45_000)
      expect(world.ports.sendPrompt).toHaveBeenCalledTimes(1)

      delivered()
      world.setSignal(SESSION_ID, { kind: 'working' })
      await advance(10 * 60_000)
      expect(world.ports.sendPrompt).toHaveBeenCalledTimes(1)
      expect(world.flow()).toMatchObject({ stage: 'tasks', status: 'running' })
    })

    it('leaves a flow whose step threw alone for five seconds, then looks at it again', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const world = createWorld({ flow: { promptedAt: Date.now() }, signal: null })
      world.ports.sessionTurn.mockRejectedValueOnce(new Error('The server is not reachable.'))
      const running = start(world)

      await advance(500)
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledTimes(1)

      running.requestTick()
      await advance(4_000)
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(1)

      await advance(1_500)
      expect(world.ports.sessionTurn).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(world.flow()).toEqual(makeFlow({ promptedAt: Date.parse(TEST_NOW) }))
    })

    it('drives every flow in the store, each on its own', async () => {
      const world = createWorld()
      world.putFlow(
        makeFlow({
          ticketId: 'ticket-2',
          sessionId: 'session-2',
          name: 'Billing',
          prefix: 'BILLING'
        })
      )
      world.setTicket({}, 'ticket-2')
      world.setSignal('session-2', { kind: 'working' })
      world.writeFile(`${CWD}/BILLING_PRD.html`)
      start(world)

      world.endTurn({}, 'session-2')
      await settle()

      expect(world.sent.map((entry) => entry.sessionId)).toEqual(['session-2'])
      expect(world.flow('ticket-2').stage).toBe('tasks')
      expect(world.flow(TICKET_ID).stage).toBe('prd')
    })

    it('does nothing once it is stopped, and stops twice without complaint', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      const running = start(world)
      await advance(500)

      running.stop()
      running.stop()
      world.endTurn()
      running.requestTick()
      await advance(60_000)

      expect(world.sent).toEqual([])
      expect(world.flow().stage).toBe('prd')
    })

    it('starts once however often it is started', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      const running = start(world)
      running.start()

      world.endTurn()
      await settle()

      expect(world.sent).toHaveLength(1)
    })
  })
})
