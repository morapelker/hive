import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPrdFlowRepromptPrompt, buildTasksPrompt } from '@shared/document-flow/prd-flow'
import { PrdFlowDriver } from './driver'
import {
  PRD_PATH,
  PREFIX,
  SESSION_ID,
  TASKS_PATH,
  TEST_NOW,
  TICKET_ID,
  advance,
  createWorld,
  settle,
  type PrdFlowWorld
} from './driver-fakes'
import { PRD_FLOW_WAIT_FOR_WORK_MS } from './ports'

// A turn that ended without the stage's document: the session is asked for it once more when
// nothing is running any more, the flow waits while something is, and it stops, with the
// ticket in Review, when asking again did not help or the prompt could not be sent.

const WAITING_FOR_WORK = 'Waiting for work the session left running.'

const askAgain = (document: 'prd' | 'tasks'): string =>
  buildPrdFlowRepromptPrompt({
    document,
    reason: 'missing',
    prefix: PREFIX,
    path: document === 'prd' ? PRD_PATH : TASKS_PATH
  })

describe('PrdFlowDriver: a turn that ended without the document', () => {
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

  describe('with nothing running', () => {
    it('asks for the PRD exactly once more, then stops, moves the ticket to Review and says so once', async () => {
      const world = createWorld()
      start(world)
      await advance(500)

      world.endTurn()
      await settle()

      expect(world.prompts()).toEqual([askAgain('prd')])
      expect(world.flow()).toMatchObject({
        stage: 'prd',
        status: 'running',
        reprompts: 1,
        promptedAt: world.sent[0].at
      })
      expect(world.sent[0].flow).toMatchObject({ reprompts: 1, promptedAt: world.sent[0].at })
      expect(world.column()).toBe('in_progress')
      expect(world.notices).toEqual([])

      // The session works on that, and comes to rest without the file again.
      await advance(60_000)
      world.endTurn()
      await settle()

      expect(world.prompts()).toEqual([askAgain('prd')])
      expect(world.flow()).toMatchObject({
        stage: 'prd',
        status: 'needs_attention',
        attention: 'missing_file',
        detail: 'CODE_MODE_PRD.html was not created.',
        forcePrompt: false
      })
      expect(world.column()).toBe('review')
      expect(world.moves).toEqual([{ ticketId: TICKET_ID, column: 'review' }])
      expect(world.notices).toEqual([
        {
          level: 'warning',
          message: 'PRD flow of “Code mode”: CODE_MODE_PRD.html was not created.'
        }
      ])

      await advance(60 * 60_000)
      expect(world.prompts()).toEqual([askAgain('prd')])
      expect(world.notices).toHaveLength(1)
      expect(world.moves).toHaveLength(1)
    })

    it('asks for the tasks document exactly once more, then stops', async () => {
      const world = createWorld({ flow: { stage: 'tasks', prdPath: PRD_PATH } })
      world.writeFile(PRD_PATH)
      start(world)

      world.endTurn()
      await settle()
      expect(world.prompts()).toEqual([askAgain('tasks')])
      expect(world.flow()).toMatchObject({ stage: 'tasks', status: 'running', reprompts: 1 })

      await advance(60_000)
      world.endTurn()
      await settle()

      expect(world.prompts()).toEqual([askAgain('tasks')])
      expect(world.flow()).toMatchObject({
        stage: 'tasks',
        status: 'needs_attention',
        attention: 'missing_file',
        detail: 'CODE_MODE_TASKS.html was not created.'
      })
      expect(world.column()).toBe('review')
      expect(world.ports.createRun).not.toHaveBeenCalled()
    })

    it('goes on when the session wrote the file after it was asked again', async () => {
      const world = createWorld()
      start(world)
      world.endTurn()
      await settle()
      expect(world.prompts()).toEqual([askAgain('prd')])

      await advance(60_000)
      world.writeFile(PRD_PATH)
      world.endTurn()
      await settle()

      expect(world.prompts()).toEqual([
        askAgain('prd'),
        buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })
      ])
      expect(world.flow()).toMatchObject({ stage: 'tasks', status: 'running', reprompts: 0 })
      expect(world.notices).toEqual([])
    })

    it('puts a ticket that sat in Review back In Progress before the prompt goes', async () => {
      const world = createWorld({ ticket: { column: 'review' } })
      start(world)

      world.endTurn()
      await settle()

      expect(world.moves).toEqual([{ ticketId: TICKET_ID, column: 'in_progress' }])
      expect(world.sent).toHaveLength(1)
      expect(world.ports.moveTicket.mock.invocationCallOrder[0]).toBeLessThan(
        world.ports.sendPrompt.mock.invocationCallOrder[0]
      )
      expect(world.column()).toBe('in_progress')
    })

    it('sends the prompt though the ticket could not be moved', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const world = createWorld({ ticket: { column: 'todo' } })
      world.ports.moveTicket.mockRejectedValueOnce(new Error('The board is not reachable.'))
      start(world)

      world.endTurn()
      await settle()

      expect(world.prompts()).toEqual([askAgain('prd')])
      expect(world.flow().status).toBe('running')
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })

  describe('with work left running', () => {
    it('waits for work the session left running at the end of its turn, and goes on when the file appears', async () => {
      const world = createWorld()
      start(world)
      await advance(500)

      world.endTurn({ hasBackgroundWork: true })
      await settle()

      expect(world.sent).toEqual([])
      expect(world.flow()).toMatchObject({
        status: 'running',
        detail: WAITING_FOR_WORK,
        waitingSince: expect.any(Number)
      })

      await advance(10 * 60_000)
      expect(world.sent).toEqual([])

      world.writeFile(PRD_PATH)
      await advance(10_000)
      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })])
      expect(world.flow()).toMatchObject({ stage: 'tasks', detail: null, waitingSince: null })
      expect(world.notices).toEqual([])
    })

    it('asks for the file as soon as that work is over and the file is still missing', async () => {
      const world = createWorld()
      start(world)
      const endedAt = Date.now()
      world.endTurn({ hasBackgroundWork: true })
      await settle()
      expect(world.sent).toEqual([])

      // The same turn end, with nothing left running.
      await advance(5 * 60_000)
      world.endTurn({ at: endedAt, hasBackgroundWork: false })
      await advance(1_000)

      expect(world.prompts()).toEqual([askAgain('prd')])
      expect(world.flow()).toMatchObject({ reprompts: 1, detail: null, waitingSince: null })
    })

    it('asks for the file anyway once that work took too long', async () => {
      const world = createWorld()
      start(world)
      world.endTurn({ hasBackgroundWork: true })
      await settle()

      await advance(PRD_FLOW_WAIT_FOR_WORK_MS - 10_000)
      expect(world.sent).toEqual([])

      await advance(20_000)
      expect(world.prompts()).toEqual([askAgain('prd')])
      expect(world.flow()).toMatchObject({
        status: 'running',
        reprompts: 1,
        detail: null,
        waitingSince: null
      })
    })

    it('waits for a session that paused its turn for its own work, without looking for the file', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      start(world)

      world.endTurn({ completion: 'waiting', pending: { monitors: [], wakeups: 0, agents: 2 } })
      await settle()
      await advance(10 * 60_000)

      expect(world.sent).toEqual([])
      expect(world.ports.fileExists).not.toHaveBeenCalled()
      expect(world.flow()).toMatchObject({
        stage: 'prd',
        status: 'running',
        detail: WAITING_FOR_WORK,
        waitingSince: expect.any(Number)
      })
    })

    it('forgets the wait when the paused session wakes itself', async () => {
      const world = createWorld()
      start(world)
      world.endTurn({ completion: 'waiting' })
      await settle()
      expect(world.flow().waitingSince).not.toBeNull()

      world.setSignal(SESSION_ID, { kind: 'working' })
      await advance(1_000)

      expect(world.flow()).toMatchObject({ detail: null, waitingSince: null })
      expect(world.sent).toEqual([])
    })

    it('asks a session that stayed paused too long for the file', async () => {
      const world = createWorld()
      start(world)
      world.endTurn({ completion: 'waiting' })
      await settle()

      await advance(PRD_FLOW_WAIT_FOR_WORK_MS - 10_000)
      expect(world.sent).toEqual([])

      await advance(20_000)
      expect(world.prompts()).toEqual([askAgain('prd')])
    })

    it('goes on from a session that stayed paused too long when the file is there', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      start(world)
      world.endTurn({ completion: 'waiting' })
      await settle()

      await advance(PRD_FLOW_WAIT_FOR_WORK_MS + 10_000)

      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })])
    })
  })

  describe('a prompt that cannot be sent', () => {
    it('stops the flow, says why, and stays stopped', async () => {
      const world = createWorld()
      world.failNextSend(new Error('The session has no process.'))
      start(world)

      world.endTurn()
      await settle()

      expect(world.flow()).toMatchObject({
        stage: 'prd',
        status: 'needs_attention',
        attention: 'send_failed',
        detail: 'Could not send a message to the session: The session has no process.'
      })
      expect(world.column()).toBe('review')
      expect(world.noticesOf('warning')).toEqual([
        'PRD flow of “Code mode”: Could not send a message to the session: The session has no process.'
      ])

      // The send had shown the session as working before it failed; none of that is left,
      // so nothing takes the session for at work on a prompt it never got.
      expect(world.ports.signal(SESSION_ID)).toEqual({ kind: 'unknown' })

      // Nothing is tried again until the person says so, however often the driver looks.
      await advance(60 * 60_000)
      expect(world.flow()).toMatchObject({ status: 'needs_attention', attention: 'send_failed' })
      expect(world.ports.sendPrompt).toHaveBeenCalledTimes(1)
      expect(world.notices).toHaveLength(1)
    })

    it('asks for the file again after Retry', async () => {
      const world = createWorld()
      world.failNextSend(new Error('The session has no process.'))
      start(world)
      world.endTurn()
      await settle()
      expect(world.flow().attention).toBe('send_failed')
      await advance(10 * 60_000)
      expect(world.flow().attention).toBe('send_failed')

      world.retry()
      await advance(1_000)

      expect(world.prompts()).toEqual([askAgain('prd')])
      expect(world.flow()).toMatchObject({ status: 'running', attention: null, reprompts: 1 })
      expect(world.column()).toBe('in_progress')
    })

    it('keeps the flow at the PRD when the tasks prompt did not go, so that Retry sends that prompt', async () => {
      const world = createWorld()
      world.writeFile(PRD_PATH)
      world.failNextSend(new Error('The session has no process.'))
      start(world)

      world.endTurn()
      await settle()

      expect(world.flow()).toMatchObject({
        stage: 'prd',
        status: 'needs_attention',
        attention: 'send_failed',
        prdPath: PRD_PATH
      })
      expect(world.sent).toEqual([])
      await advance(60 * 60_000)
      expect(world.ports.sendPrompt).toHaveBeenCalledTimes(1)

      world.retry()
      await advance(1_000)

      expect(world.prompts()).toEqual([buildTasksPrompt({ prefix: PREFIX, prdPath: PRD_PATH })])
      expect(world.flow()).toMatchObject({
        stage: 'tasks',
        status: 'running',
        attention: null,
        forcePrompt: false
      })
    })
  })
})
