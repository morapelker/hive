import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrdFlow } from '@/stores/usePrdFlowStore'
import { PrdFlowDriver } from './driver'
import {
  CWD,
  PRD_PATH,
  PREFIX,
  RUN_ID,
  RUN_TICKET_ID,
  TASKS_PATH,
  TEST_NOW,
  TICKET_ID,
  advance,
  createWorld,
  makeFlow,
  settle,
  type PrdFlowWorld
} from './driver-fakes'
import type { PrdFlowRun } from './ports'

// The end of a flow: the tasks document exists, an orchestrator ticket is made of it (once),
// the planning ticket becomes its child and goes to Review, and the flow is forgotten. Or the
// orchestrator cannot be made, and the flow waits for Retry.

const SUCCESS = {
  level: 'success',
  message:
    '“Code mode”: CODE_MODE_TASKS.html became an orchestrator ticket in To Do. Launch it once its tickets are extracted.'
} as const

/** A flow whose session was asked for the tasks document. */
const atTasks = (overrides: Partial<PrdFlow> = {}): Partial<PrdFlow> => ({
  stage: 'tasks',
  prdPath: PRD_PATH,
  ...overrides
})

describe('PrdFlowDriver: from the tasks document to the orchestrator ticket', () => {
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

  describe('the tasks document exists', () => {
    it('makes one orchestrator of it, puts the planning ticket under it and in Review, forgets the flow and says so', async () => {
      const world = createWorld({ flow: atTasks() })
      world.writeFile(TASKS_PATH)
      start(world)
      await advance(500)

      world.endTurn()
      await settle()

      expect(world.ports.createRun).toHaveBeenCalledTimes(1)
      expect(world.ports.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: TICKET_ID, stage: 'creating_run' }),
        TASKS_PATH
      )
      expect(world.links).toEqual([{ ticketId: TICKET_ID, runTicketId: RUN_TICKET_ID }])
      expect(world.hasFlow()).toBe(false)
      expect(world.column()).toBe('review')
      expect(world.moves).toEqual([{ ticketId: TICKET_ID, column: 'review' }])
      expect(world.notices).toEqual([SUCCESS])
      // The session is asked for nothing more: it stays open as it is.
      expect(world.sent).toEqual([])

      await advance(60 * 60_000)
      expect(world.ports.createRun).toHaveBeenCalledTimes(1)
      expect(world.notices).toHaveLength(1)
    })

    it('records where the document is, and the run, before the flow ends', async () => {
      const world = createWorld({ flow: atTasks() })
      world.writeFile(TASKS_PATH)
      start(world)

      world.endTurn()
      await settle()

      const writes = world.ports.patch.mock.calls.map(([, patch]) => patch)
      expect(writes).toEqual([
        {
          stage: 'creating_run',
          tasksPath: TASKS_PATH,
          status: 'running',
          attention: null,
          detail: null,
          forcePrompt: false,
          waitingSince: null,
          retryAt: null
        },
        { runId: RUN_ID }
      ])
      expect(world.ports.patch.mock.invocationCallOrder[1]).toBeLessThan(
        world.ports.remove.mock.invocationCallOrder[0]
      )
      // The hold ends before the ticket is moved to Review.
      expect(world.ports.remove.mock.invocationCallOrder[0]).toBeLessThan(
        world.ports.moveTicket.mock.invocationCallOrder[0]
      )
    })

    it('makes the orchestrator of a tasks document the agent wrote into a member repository', async () => {
      const inWeb = `${CWD}/web/${PREFIX}_TASKS.html`
      const world = createWorld({
        flow: atTasks({
          checkout: { kind: 'connection', connectionId: 'conn-base' },
          memberDirs: ['web', 'api']
        })
      })
      world.writeFile(inWeb)
      start(world)

      world.endTurn()
      await settle()

      expect(world.ports.createRun).toHaveBeenCalledWith(expect.anything(), inWeb)
      expect(world.hasFlow()).toBe(false)
    })

    it('adopts a run the server already made of the document instead of making a second one', async () => {
      const world = createWorld({ flow: atTasks() })
      world.writeFile(TASKS_PATH)
      world.runs.set(TASKS_PATH, { runId: 'run-0', ticketId: 'ticket-run-0' })
      start(world)

      world.endTurn()
      await settle()

      expect(world.ports.findRun).toHaveBeenCalledWith(expect.anything(), TASKS_PATH)
      expect(world.ports.createRun).not.toHaveBeenCalled()
      expect(world.links).toEqual([{ ticketId: TICKET_ID, runTicketId: 'ticket-run-0' }])
      expect(world.hasFlow()).toBe(false)
      expect(world.column()).toBe('review')
      expect(world.notices).toEqual([SUCCESS])
    })

    it('asks the server for nothing when the flow already recorded its run', async () => {
      const world = createWorld({
        flow: { stage: 'creating_run', prdPath: PRD_PATH, tasksPath: TASKS_PATH, runId: RUN_ID },
        signal: null
      })
      start(world)

      await advance(1_000)

      expect(world.ports.findRun).not.toHaveBeenCalled()
      expect(world.ports.createRun).not.toHaveBeenCalled()
      expect(world.links).toEqual([])
      expect(world.hasFlow()).toBe(false)
      expect(world.column()).toBe('review')
      expect(world.notices).toEqual([SUCCESS])
    })

    it('makes the run of a flow that was reloaded just before it could', async () => {
      const world = createWorld({
        flow: { stage: 'creating_run', prdPath: PRD_PATH, tasksPath: TASKS_PATH },
        signal: null
      })
      start(world)

      await advance(1_000)

      expect(world.ports.createRun).toHaveBeenCalledTimes(1)
      expect(world.ports.createRun).toHaveBeenCalledWith(expect.anything(), TASKS_PATH)
      // Nothing is asked of the session at this stage: not even how it is.
      expect(world.ports.sessionTurn).not.toHaveBeenCalled()
      expect(world.hasFlow()).toBe(false)
    })

    it('makes the orchestrator when the tasks document appears while the flow needs attention', async () => {
      const world = createWorld({
        flow: atTasks({
          status: 'needs_attention',
          attention: 'missing_file',
          detail: 'CODE_MODE_TASKS.html was not created.',
          reprompts: 1
        }),
        ticket: { column: 'review' },
        signal: null
      })
      world.endTurn({ at: Date.now() - 10_000 })
      start(world)
      await advance(60_000)
      expect(world.ports.createRun).not.toHaveBeenCalled()

      world.writeFile(TASKS_PATH)
      await advance(10_000)

      expect(world.ports.createRun).toHaveBeenCalledTimes(1)
      expect(world.hasFlow()).toBe(false)
      // The ticket already waits in Review.
      expect(world.moves).toEqual([])
      expect(world.notices).toEqual([SUCCESS])
    })

    it('never makes two runs when ticks come while the first is being made', async () => {
      const world = createWorld({ flow: atTasks() })
      world.writeFile(TASKS_PATH)
      let made: (run: PrdFlowRun) => void = () => {}
      world.ports.createRun.mockImplementationOnce(
        () =>
          new Promise<PrdFlowRun>((resolve) => {
            made = resolve
          })
      )
      const running = start(world)
      world.endTurn({ at: Date.now() - 10_000 })
      await advance(500)
      expect(world.ports.createRun).toHaveBeenCalledTimes(1)

      running.requestTick()
      await advance(60_000)
      expect(world.ports.createRun).toHaveBeenCalledTimes(1)
      expect(world.flow()).toMatchObject({ stage: 'creating_run', status: 'running', runId: null })

      made({ runId: RUN_ID, ticketId: RUN_TICKET_ID })
      await advance(1_000)
      expect(world.hasFlow()).toBe(false)
      expect(world.notices).toEqual([SUCCESS])
    })

    it('does nothing more when the flow was cancelled while the run was being made', async () => {
      const world = createWorld({ flow: atTasks() })
      world.writeFile(TASKS_PATH)
      let made: (run: PrdFlowRun) => void = () => {}
      world.ports.createRun.mockImplementationOnce(
        () =>
          new Promise<PrdFlowRun>((resolve) => {
            made = resolve
          })
      )
      start(world)
      world.endTurn({ at: Date.now() - 10_000 })
      await advance(500)

      world.ports.remove(TICKET_ID)
      made({ runId: RUN_ID, ticketId: RUN_TICKET_ID })
      await advance(1_000)

      expect(world.links).toEqual([])
      expect(world.moves).toEqual([])
      expect(world.notices).toEqual([])
    })
  })

  describe('putting the planning ticket under the orchestrator', () => {
    it('leaves a ticket that is not of the database board unlinked', async () => {
      const world = createWorld({ flow: atTasks(), ticket: { linkable: false } })
      world.writeFile(TASKS_PATH)
      start(world)

      world.endTurn()
      await settle()

      expect(world.ports.linkToRun).not.toHaveBeenCalled()
      expect(world.hasFlow()).toBe(false)
      expect(world.column()).toBe('review')
      expect(world.notices).toEqual([SUCCESS])
    })

    it('links nothing when the run has no ticket on the board', async () => {
      const world = createWorld({ flow: atTasks() })
      world.writeFile(TASKS_PATH)
      world.ports.createRun.mockResolvedValueOnce({ runId: RUN_ID, ticketId: null })
      start(world)

      world.endTurn()
      await settle()

      expect(world.ports.linkToRun).not.toHaveBeenCalled()
      expect(world.hasFlow()).toBe(false)
      expect(world.notices).toEqual([SUCCESS])
    })

    it('ends the flow all the same when the link could not be written', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const world = createWorld({ flow: atTasks() })
      world.writeFile(TASKS_PATH)
      world.ports.linkToRun.mockRejectedValueOnce(new Error('The board is not reachable.'))
      start(world)

      world.endTurn()
      await settle()

      expect(warn).toHaveBeenCalledTimes(1)
      expect(world.hasFlow()).toBe(false)
      expect(world.column()).toBe('review')
      expect(world.notices).toEqual([SUCCESS])
    })
  })

  describe('the orchestrator cannot be made', () => {
    const failing = async (): Promise<PrdFlowWorld> => {
      const world = createWorld({ flow: atTasks() })
      world.writeFile(TASKS_PATH)
      world.ports.createRun.mockRejectedValueOnce(new Error('The document lists no tickets.'))
      start(world)
      world.endTurn()
      await settle()
      return world
    }

    it('stops with the reason, moves the ticket to Review and tries nothing by itself', async () => {
      const world = await failing()

      expect(world.flow()).toEqual(
        makeFlow({
          stage: 'creating_run',
          prdPath: PRD_PATH,
          tasksPath: TASKS_PATH,
          status: 'needs_attention',
          attention: 'run_failed',
          detail: 'The orchestrator ticket could not be created: The document lists no tickets.'
        })
      )
      expect(world.column()).toBe('review')
      expect(world.notices).toEqual([
        {
          level: 'warning',
          message:
            'PRD flow of “Code mode”: The orchestrator ticket could not be created: The document lists no tickets.'
        }
      ])

      await advance(60 * 60_000)
      expect(world.ports.createRun).toHaveBeenCalledTimes(1)
      expect(world.notices).toHaveLength(1)
      expect(world.sent).toEqual([])
    })

    it('makes it after Retry, without a word to the session', async () => {
      const world = await failing()

      world.retry()
      await advance(1_000)

      expect(world.ports.createRun).toHaveBeenCalledTimes(2)
      expect(world.sent).toEqual([])
      expect(world.hasFlow()).toBe(false)
      expect(world.column()).toBe('review')
      expect(world.links).toEqual([{ ticketId: TICKET_ID, runTicketId: RUN_TICKET_ID }])
      expect(world.notices.at(-1)).toEqual(SUCCESS)
    })

    it('stops the same way when the server cannot say which runs exist', async () => {
      const world = createWorld({ flow: atTasks() })
      world.writeFile(TASKS_PATH)
      world.ports.findRun.mockRejectedValueOnce(new Error('The server is not reachable.'))
      start(world)

      world.endTurn()
      await settle()

      expect(world.ports.createRun).not.toHaveBeenCalled()
      expect(world.flow()).toMatchObject({
        stage: 'creating_run',
        status: 'needs_attention',
        attention: 'run_failed',
        detail: 'The orchestrator ticket could not be created: The server is not reachable.'
      })
    })
  })
})
