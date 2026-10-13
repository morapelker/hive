import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { USER_INTERRUPT_DETAIL, WAITING_FOR_WORK_PREFIX } from '@shared/document-flow/planning'
import { buildContinuePrompt, buildNudgePrompt } from '@shared/document-flow/prompts'
import type { DocumentRunItem, SessionFinalMessage } from '@shared/types/document-flow'
import {
  BACKOFF_MINUTES,
  DocumentFlowRunner,
  MAX_CONTINUE,
  MAX_NUDGES,
  SETTLE_MS,
  WAIT_FOR_WORK_MS
} from './runner'
import { TEST_NOW, advance, createWorld, makeVerdict, type RunnerWorld } from './runner-fakes'

const SESSION = 's-A'
/** After the fake server started (09:00), a minute before the test clock. */
const PROMPTED_AT = '2026-05-04T09:59:00.000Z'
const BEFORE_SERVER_START = '2026-05-04T08:00:00.000Z'
/** Half a minute after the prompt, long enough ago to have settled. */
const RECORDED_AT = '2026-05-04T09:59:30.000Z'

const runningItem = (overrides: Partial<DocumentRunItem> = {}): Partial<DocumentRunItem> => ({
  key: 'A',
  status: 'running',
  session_id: SESSION,
  worktree_id: 'wt-A',
  branch_name: 'a-task-a',
  started_at: PROMPTED_AT,
  last_prompt_at: PROMPTED_AT,
  ...overrides
})

const recordedTurn = (overrides: Partial<SessionFinalMessage> = {}): SessionFinalMessage => ({
  session_id: SESSION,
  state: 'ended',
  text: 'All done.',
  completion: 'completed',
  api_error: null,
  hook_event: 'Stop',
  detail: null,
  background_work: null,
  updated_at: RECORDED_AT,
  ...overrides
})

/** The server saw the session stop for the user, or get back to work, at `updated_at`. */
const recordedState = (
  state: 'blocked' | 'working',
  hookEvent: string,
  overrides: Partial<SessionFinalMessage> = {}
): SessionFinalMessage =>
  recordedTurn({
    state,
    hook_event: hookEvent,
    text: '',
    completion: null,
    ...overrides
  })

const clock = (ms: number): string => {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

describe('DocumentFlowRunner: watching sessions', () => {
  let runner: DocumentFlowRunner | null = null

  const start = (world: RunnerWorld): void => {
    runner = new DocumentFlowRunner(world.ports)
    runner.start()
  }

  const statusWrites = (world: RunnerWorld): string[] =>
    world.ports.updateItem.mock.calls.flatMap(([, , patch]) => (patch.status ? [patch.status] : []))

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TEST_NOW))
  })

  afterEach(() => {
    runner?.stop()
    runner = null
    vi.useRealTimers()
  })

  describe('turn ends', () => {
    it('acts on a finished turn only after it stood for the settle delay', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.setSignal(SESSION, { kind: 'working' })
      start(world)
      await advance(500)

      world.endTurn(SESSION)
      await advance(SETTLE_MS - 500)
      expect(world.item('A').status).toBe('running')
      expect(world.api.classify).not.toHaveBeenCalled()

      await advance(2000)
      expect(world.api.classify).toHaveBeenCalledTimes(1)
      expect(world.api.classify).toHaveBeenCalledWith({ runId: 'run-1', itemId: 'item-A' })
      expect(statusWrites(world)).toEqual(['checking', 'ready', 'merging', 'merged'])
    })

    it('ignores a completed signal that bounces back to working within the settle delay', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.endTurn(SESSION)
      await advance(2000)
      world.setSignal(SESSION, { kind: 'working' })
      await advance(20_000)

      expect(world.item('A').status).toBe('running')
      expect(world.api.classify).not.toHaveBeenCalled()
      expect(world.ports.updateItem).not.toHaveBeenCalled()
    })

    it('never checks a turn that only paused for background work', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.endTurn(SESSION, { completion: 'waiting', hasBackgroundWork: true })
      await advance(60_000)

      expect(world.item('A').status).toBe('running')
      expect(world.api.classify).not.toHaveBeenCalled()
      expect(world.followups).toEqual([])
    })

    it('ignores a completed signal left over from before the last prompt', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.setSignal(SESSION, {
        kind: 'ended',
        at: Date.parse(PROMPTED_AT) - 1000,
        completion: 'completed',
        apiError: null,
        reason: null,
        hookEvent: 'Stop',
        hasBackgroundWork: false
      })
      start(world)

      await advance(60_000)

      expect(world.item('A').status).toBe('running')
      expect(world.api.classify).not.toHaveBeenCalled()
      expect(world.followups).toEqual([])
    })

    it('treats sessions without a completion signal (SDK, codex) as finished when they end', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.endTurn(SESSION, { completion: undefined })
      await advance(SETTLE_MS + 1000)

      expect(world.api.classify).toHaveBeenCalledTimes(1)
    })

    it('does not mistake the bare completed a CLI publishes at startup for an interruption', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.endTurn(SESSION, { completion: 'none' })
      await advance(1000)
      world.setSignal(SESSION, { kind: 'working' })
      await advance(30_000)

      expect(world.followups).toEqual([])
      expect(world.item('A')).toMatchObject({ status: 'running', continue_attempts: 0 })
    })

    it('never reads the SessionStart hook as an interruption, however long the prompt takes', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.endTurn(SESSION, { completion: 'none', hookEvent: 'SessionStart' })
      await advance(30_000)

      expect(world.followups).toEqual([])
      expect(world.ports.updateItem).not.toHaveBeenCalled()
    })

    it('never reads the idle marker of a freshly started CLI process as an interruption', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.endTurn(SESSION, { completion: 'none', reason: 'pty_start' })
      await advance(30_000)

      expect(world.followups).toEqual([])
      expect(world.ports.updateItem).not.toHaveBeenCalled()
    })

    it('reads the SessionEnd hook as the process going away', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.endTurn(SESSION, { completion: 'none', hookEvent: 'SessionEnd' })
      await advance(SETTLE_MS + 500)

      expect(world.followups).toEqual([
        { sessionId: SESSION, ticketId: 'ticket-A', prompt: buildContinuePrompt('interrupted') }
      ])
    })
  })

  describe('waiting on the user', () => {
    it('moves a blocked session to needs_input, says why once, and back when it works again', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.setSignal(SESSION, { kind: 'blocked', reason: 'question', detail: 'Which currency?' })
      await advance(30_000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_input',
        status_detail: 'Waiting for you: Which currency?'
      })
      expect(world.notices).toEqual([
        { level: 'info', message: 'A is waiting for you: Waiting for you: Which currency?' }
      ])
      expect(world.followups).toEqual([])

      world.setSignal(SESSION, { kind: 'working' })
      await advance(500)

      expect(world.item('A')).toMatchObject({ status: 'running', status_detail: null })
    })

    it('names the kind of block when the session gives no text', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.setSignal(SESSION, { kind: 'blocked', reason: 'permission', detail: null })
      await advance(500)

      expect(world.item('A').status_detail).toBe('Waiting for you: a permission request')
    })

    it('checks the new turn after the user answered, and never the same turn twice', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.api.classify.mockResolvedValueOnce(
        makeVerdict({ status: 'needs_input', question: 'Which currency?', reason: 'It asks.' })
      )
      start(world)

      world.endTurn(SESSION)
      const firstEnd = Date.now()
      await advance(SETTLE_MS + 1000)
      expect(world.item('A')).toMatchObject({
        status: 'needs_input',
        status_detail: 'Which currency?',
        last_checked_at: new Date(firstEnd).toISOString()
      })

      // The same completed signal keeps standing while the user is away.
      await advance(120_000)
      expect(world.api.classify).toHaveBeenCalledTimes(1)
      expect(world.item('A').status).toBe('needs_input')

      world.setSignal(SESSION, { kind: 'working' })
      await advance(500)
      expect(world.item('A').status).toBe('running')

      world.endTurn(SESSION)
      await advance(SETTLE_MS + 1000)
      expect(world.api.classify).toHaveBeenCalledTimes(2)
      expect(world.item('A').status).toBe('merged')
    })

    it.each([
      ['Escape in a CLI', { completion: 'none' as const, reason: 'user_interrupt' }],
      ['Stop on an SDK session', { completion: undefined, reason: 'user_abort' }]
    ])('waits for the user after they interrupted the session (%s)', async (_how, end) => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.endTurn(SESSION, end)
      await advance(60_000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_input',
        status_detail: USER_INTERRUPT_DETAIL
      })
      expect(world.followups).toEqual([])
      expect(world.api.classify).not.toHaveBeenCalled()
    })

    it('waits for the user when the session was closed in the app', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.setSignal(SESSION, { kind: 'working' })
      start(world)
      await advance(500)

      // Closing the tab kills the process without a status and clears the entry.
      world.closedSessions.add(SESSION)
      world.setSignal(SESSION, { kind: 'unknown' })
      await advance(60_000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_input',
        status_detail: USER_INTERRUPT_DETAIL
      })
      expect(world.followups).toEqual([])
      expect(world.notices).toHaveLength(1)
      // Asked about on the poll interval, not on every tick.
      expect(world.ports.isSessionClosed.mock.calls.length).toBeLessThanOrEqual(14)
    })

    it('does not take the record of a closed session for a live one', async () => {
      const world = createWorld({ items: [runningItem()] })
      // The last hook before the tab was closed said the agent was working.
      world.turns.set(SESSION, recordedState('working', 'Working'))
      world.closedSessions.add(SESSION)
      start(world)

      await advance(2000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_input',
        status_detail: USER_INTERRUPT_DETAIL
      })
    })

    it('judges the last turn of a closed session when the user retries, instead of bouncing', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.turns.set(SESSION, recordedState('working', 'Working'))
      world.closedSessions.add(SESSION)
      start(world)
      await advance(2000)
      expect(world.item('A').status).toBe('needs_input')

      // Retry: the store sends an item that has a session back to `checking`.
      world.setItem('A', { status: 'checking', status_detail: null })
      await advance(10_000)

      // The record of the dead process must not stand for a live session: judged, not parked.
      expect(world.api.classify).toHaveBeenCalledTimes(1)
      expect(statusWrites(world)).toEqual(['needs_input', 'ready', 'merging', 'merged'])
      expect(world.item('A').status).toBe('merged')
    })

    it('still judges the turn a closed session had finished', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.turns.set(SESSION, recordedTurn())
      world.closedSessions.add(SESSION)
      start(world)

      await advance(2000)

      expect(world.api.classify).toHaveBeenCalledTimes(1)
      expect(world.item('A').status).toBe('merged')
    })

    it('never prompts a needs_input item on its own, even after a restart', async () => {
      const world = createWorld({
        items: [
          runningItem({
            status: 'needs_input',
            status_detail: 'Which currency?',
            last_prompt_at: BEFORE_SERVER_START
          })
        ]
      })
      start(world)

      await advance(60_000)

      expect(world.followups).toEqual([])
      expect(world.item('A').status).toBe('needs_input')
    })

    it('has a ticket parked on its agent’s question decide for itself once the run may no longer ask', async () => {
      const world = createWorld({
        items: [
          runningItem({
            status: 'needs_input',
            status_detail: 'Which currency?',
            last_checked_at: RECORDED_AT
          })
        ]
      })
      // The turn that asked: ended, and judged already.
      world.endTurn(SESSION, { at: Date.parse(RECORDED_AT) })
      world.api.classify.mockResolvedValue(
        makeVerdict({ status: 'needs_input', question: 'Which currency?', reason: 'It asks.' })
      )
      start(world)

      await advance(15_000)
      expect(world.api.classify).not.toHaveBeenCalled()
      expect(world.item('A').status).toBe('needs_input')

      // "Agents may ask me questions" is switched off: nobody is coming to answer.
      world.setRun({ config: { ...world.detail().run.config, interactive: false } })
      await advance(2000)

      expect(world.followups).toHaveLength(1)
      expect(world.followups[0].prompt).toContain('go-ahead from me:\nWhich currency?')
      expect(world.item('A')).toMatchObject({
        status: 'running',
        status_detail: 'Told to decide on its own: Which currency?',
        nudge_count: 1
      })
    })

    it.each([
      ['an open dialog', 'Waiting for you: a question'],
      ['a session the user interrupted', USER_INTERRUPT_DETAIL]
    ])('leaves a ticket waiting on %s alone in a run that may not ask', async (_what, detail) => {
      const world = createWorld({
        config: { interactive: false },
        items: [
          runningItem({
            status: 'needs_input',
            status_detail: detail,
            last_checked_at: RECORDED_AT
          })
        ]
      })
      world.endTurn(SESSION, { at: Date.parse(RECORDED_AT) })
      start(world)

      await advance(15_000)

      expect(world.api.classify).not.toHaveBeenCalled()
      expect(world.followups).toEqual([])
      expect(world.item('A')).toMatchObject({ status: 'needs_input', status_detail: detail })
    })

    it('picks up a turn the user finished with the session while the app was reloading', async () => {
      const world = createWorld({
        items: [runningItem({ status: 'needs_input', status_detail: 'Which currency?' })]
      })
      world.turns.set(SESSION, recordedTurn())
      start(world)

      await advance(2000)

      expect(world.api.classify).toHaveBeenCalledTimes(1)
    })
  })

  describe('waiting for background work', () => {
    const REASON = 'It waits for the typecheck, the unit tests and the lint it started.'
    /** An item parked by a `waiting` verdict: its last turn end was judged, the wait is on. */
    const waitingItem = (overrides: Partial<DocumentRunItem> = {}): Partial<DocumentRunItem> =>
      runningItem({
        status_detail: `${WAITING_FOR_WORK_PREFIX}${REASON}`,
        last_checked_at: RECORDED_AT,
        wait_until: new Date(Date.now() + WAIT_FOR_WORK_MS).toISOString(),
        ...overrides
      })
    const waitingWorld = (overrides: Partial<DocumentRunItem> = {}): RunnerWorld => {
      const world = createWorld({ items: [waitingItem(overrides)] })
      world.endTurn(SESSION, { at: Date.parse(RECORDED_AT), hasBackgroundWork: true })
      return world
    }

    it('keeps waiting until the deadline, then reminds the agent once without counting it', async () => {
      const world = waitingWorld()
      start(world)

      await advance(WAIT_FOR_WORK_MS - 60_000)
      expect(world.followups).toEqual([])
      expect(world.item('A').status).toBe('running')
      expect(world.api.classify).not.toHaveBeenCalled()

      await advance(70_000)
      expect(world.followups).toEqual([
        {
          sessionId: SESSION,
          ticketId: 'ticket-A',
          prompt: buildNudgePrompt({ status: 'waiting', reason: REASON })
        }
      ])
      expect(world.item('A')).toMatchObject({
        status: 'running',
        status_detail: `Told its wait ran out: ${REASON}`,
        wait_until: null,
        wait_timeouts: 1,
        nudge_count: 0
      })
      expect(world.events.map((event) => event.type)).toEqual(['wait_timed_out', 'nudged'])
    })

    it('ends the wait when the session wakes, and judges the turn that follows', async () => {
      const world = waitingWorld()
      start(world)
      await advance(1000)

      // A task notification resumed the agent.
      world.setSignal(SESSION, { kind: 'working' })
      await advance(1000)
      expect(world.item('A')).toMatchObject({
        status: 'running',
        status_detail: null,
        wait_until: null
      })

      world.endTurn(SESSION)
      world.api.classify.mockResolvedValue(makeVerdict({ status: 'done' }))
      world.api.prepareMerge.mockReturnValue(new Promise(() => {}))
      await advance(SETTLE_MS + 1000)
      expect(world.api.classify).toHaveBeenCalledTimes(1)
      expect(world.followups).toEqual([])
    })

    it('counts the next timeout as a nudge, and flags the ticket after the last one', async () => {
      const world = waitingWorld({ wait_timeouts: 1 })
      start(world)

      await advance(WAIT_FOR_WORK_MS + 10_000)
      expect(world.followups).toHaveLength(1)
      expect(world.item('A')).toMatchObject({
        status: 'running',
        status_detail: `Asked to finish: ${REASON}`,
        wait_until: null,
        wait_timeouts: 1,
        nudge_count: 1
      })

      const flagged = waitingWorld({ wait_timeouts: 1, nudge_count: MAX_NUDGES })
      runner?.stop()
      start(flagged)
      await advance(WAIT_FOR_WORK_MS + 10_000)
      expect(flagged.followups).toEqual([])
      expect(flagged.item('A')).toMatchObject({
        status: 'needs_attention',
        status_detail: REASON,
        wait_until: null
      })
    })

    it('merges a ticket of a run that may not ask as it is, once its waits are used up', async () => {
      const world = createWorld({
        config: { interactive: false },
        items: [waitingItem({ wait_timeouts: 1, nudge_count: MAX_NUDGES })]
      })
      world.endTurn(SESSION, { at: Date.parse(RECORDED_AT), hasBackgroundWork: true })
      world.api.prepareMerge.mockReturnValue(new Promise(() => {}))
      start(world)

      await advance(WAIT_FOR_WORK_MS + 10_000)
      expect(world.followups).toEqual([])
      expect(world.events).toContainEqual(expect.objectContaining({ type: 'accepted_as_is' }))
    })

    it('still handles an API error during a wait', async () => {
      const world = waitingWorld()
      start(world)
      await advance(1000)

      world.endTurn(SESSION, { completion: 'none', apiError: 'overloaded_error' })
      await advance(SETTLE_MS + 1000)

      expect(world.item('A').retry_at).not.toBeNull()
      expect(world.item('A').status_detail).toContain('API error (overloaded_error)')
    })
  })

  describe('API errors', () => {
    it('backs off, continues the session when the wait is over, and gives up after the last attempt', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      for (let attempt = 0; attempt < MAX_CONTINUE; attempt++) {
        world.endTurn(SESSION, { completion: 'none', apiError: 'rate_limit' })
        await advance(SETTLE_MS + 500)

        const retryAt = Date.parse(world.item('A').retry_at as string)
        const minutes = BACKOFF_MINUTES[attempt]
        expect(Math.round((retryAt - Date.now()) / 60_000)).toBe(minutes)
        expect(world.item('A')).toMatchObject({
          status: 'running',
          status_detail: `API error (rate_limit). Retrying at ${clock(retryAt)}.`,
          continue_attempts: attempt
        })
        expect(world.followups).toHaveLength(attempt)

        await advance(minutes * 60_000 - 5000)
        expect(world.followups).toHaveLength(attempt)

        await advance(10_000)
        expect(world.followups).toHaveLength(attempt + 1)
        expect(world.followups[attempt]).toEqual({
          sessionId: SESSION,
          ticketId: 'ticket-A',
          prompt: buildContinuePrompt('api_error')
        })
        expect(world.item('A')).toMatchObject({
          status: 'running',
          status_detail: null,
          retry_at: null,
          continue_attempts: attempt + 1
        })
      }

      world.endTurn(SESSION, { completion: 'none', apiError: 'rate_limit' })
      await advance(SETTLE_MS + 500)

      expect(world.item('A')).toMatchObject({
        status: 'needs_attention',
        status_detail: 'The session keeps failing with an API error (rate_limit).'
      })
      expect(world.followups).toHaveLength(MAX_CONTINUE)
    })

    it('stamps last_prompt_at before sending, so the old error signal cannot answer the new prompt', async () => {
      const world = createWorld({ items: [runningItem({ retry_at: PROMPTED_AT })] })
      world.endTurn(SESSION, {
        at: Date.parse(PROMPTED_AT) + 1000,
        completion: 'none',
        apiError: 'overloaded'
      })
      const promptedAtWhenSent: (string | null)[] = []
      world.ports.sendFollowup.mockImplementation(async () => {
        // The session stays silent: the errored signal from before the prompt is all there is.
        promptedAtWhenSent.push(world.item('A').last_prompt_at)
      })
      start(world)

      await advance(60_000)

      expect(promptedAtWhenSent).toEqual(['2026-05-04T10:00:00.100Z'])
      expect(world.ports.sendFollowup).toHaveBeenCalledTimes(1)
      expect(world.item('A')).toMatchObject({ continue_attempts: 1, retry_at: null })
    })

    it('forgets earlier failures once a turn ends cleanly', async () => {
      const world = createWorld({ items: [runningItem({ continue_attempts: 3 })] })
      world.api.classify.mockResolvedValueOnce(makeVerdict({ status: 'needs_input' }))
      start(world)

      world.endTurn(SESSION)
      await advance(SETTLE_MS + 1000)

      expect(world.item('A')).toMatchObject({ status: 'needs_input', continue_attempts: 0 })
    })

    it('drops the retry when the session went back to work by itself', async () => {
      const world = createWorld({
        items: [
          runningItem({
            retry_at: '2026-05-04T10:30:00.000Z',
            status_detail: 'API error (overloaded). Retrying at 10:30.'
          })
        ]
      })
      world.setSignal(SESSION, { kind: 'working' })
      start(world)

      await advance(40 * 60_000)

      expect(world.item('A')).toMatchObject({
        status: 'running',
        retry_at: null,
        status_detail: null
      })
      expect(world.followups).toEqual([])
    })

    it('flags the item when the continue prompt cannot be delivered', async () => {
      const world = createWorld({ items: [runningItem({ retry_at: PROMPTED_AT })] })
      world.endTurn(SESSION, { completion: 'none', apiError: 'overloaded' })
      world.ports.sendFollowup.mockRejectedValueOnce(new Error('Session not found: s-A'))
      start(world)

      await advance(SETTLE_MS + 1000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_attention',
        status_detail: 'Could not send a message to the session: Session not found: s-A'
      })
    })
  })

  describe('interrupted sessions and restarts', () => {
    it('resumes a session whose process went away', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      world.endTurn(SESSION, { completion: 'none', reason: 'pty_exit' })
      await advance(SETTLE_MS + 500)

      expect(world.followups).toEqual([
        { sessionId: SESSION, ticketId: 'ticket-A', prompt: buildContinuePrompt('interrupted') }
      ])
      expect(world.item('A')).toMatchObject({ status: 'running', continue_attempts: 1 })
      expect(Date.parse(world.item('A').last_prompt_at as string)).toBeGreaterThan(
        Date.parse(PROMPTED_AT)
      )
    })

    it('gives up on a session that keeps being interrupted', async () => {
      const world = createWorld({ items: [runningItem({ continue_attempts: MAX_CONTINUE })] })
      start(world)

      world.endTurn(SESSION, { completion: 'none', reason: 'pty_exit' })
      await advance(SETTLE_MS + 500)

      expect(world.item('A')).toMatchObject({
        status: 'needs_attention',
        status_detail: 'The session was interrupted and could not be resumed.'
      })
      expect(world.followups).toEqual([])
    })

    it('checks a turn the server recorded while the renderer had no signal', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.turns.set(SESSION, recordedTurn())
      start(world)

      await advance(2000)

      expect(world.api.sessionTurn).toHaveBeenCalledWith(SESSION)
      expect(world.api.classify).toHaveBeenCalledTimes(1)
      expect(world.followups).toEqual([])
      expect(world.item('A').status).toBe('merged')
    })

    it('does not check a recorded turn that was already checked', async () => {
      const world = createWorld({
        items: [runningItem({ status: 'needs_input', last_checked_at: '2026-05-04T09:59:30.000Z' })]
      })
      world.turns.set(SESSION, recordedTurn())
      start(world)

      await advance(30_000)

      expect(world.api.classify).not.toHaveBeenCalled()
    })

    it('reads a recorded API error like a live one', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.turns.set(
        SESSION,
        recordedTurn({ completion: null, api_error: 'rate_limit', hook_event: 'StopFailure' })
      )
      start(world)

      await advance(2000)

      expect(world.item('A').retry_at).not.toBeNull()
      expect(world.item('A').status_detail).toMatch(/^API error \(rate_limit\)\. Retrying at /)
      expect(world.api.classify).not.toHaveBeenCalled()
    })

    it('continues a session that was prompted before the app restarted and left no record', async () => {
      const world = createWorld({ items: [runningItem({ last_prompt_at: BEFORE_SERVER_START })] })
      start(world)

      await advance(2000)

      expect(world.followups).toEqual([
        { sessionId: SESSION, ticketId: 'ticket-A', prompt: buildContinuePrompt('interrupted') }
      ])
      expect(world.item('A')).toMatchObject({ status: 'running', continue_attempts: 1 })
    })

    it('continues after a restart when the last recorded turn was only a pause', async () => {
      const world = createWorld({ items: [runningItem({ last_prompt_at: BEFORE_SERVER_START })] })
      world.turns.set(
        SESSION,
        recordedTurn({ completion: 'waiting', updated_at: '2026-05-04T08:30:00.000Z' })
      )
      start(world)

      await advance(2000)

      expect(world.followups).toHaveLength(1)
      expect(world.api.classify).not.toHaveBeenCalled()
    })

    it('reads a recorded user interruption like a live one', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.turns.set(SESSION, recordedTurn({ completion: null, hook_event: 'Interrupt' }))
      start(world)

      await advance(2000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_input',
        status_detail: USER_INTERRUPT_DETAIL
      })
      expect(world.api.classify).not.toHaveBeenCalled()
    })

    it('waits on the user when the server saw the session stop for them while no window watched', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.turns.set(SESSION, recordedState('blocked', 'permission', { detail: 'Bash' }))
      start(world)

      await advance(2000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_input',
        status_detail: 'Waiting for you: Permission to use Bash'
      })
      expect(world.followups).toEqual([])
    })

    it.each([
      ['answering', 'Waiting for you: a question'],
      ['plan_ready', 'Waiting for you: a plan to approve'],
      ['command_approval', 'Waiting for you: a command to approve']
    ])('names a recorded %s block', async (hookEvent, detail) => {
      const world = createWorld({ items: [runningItem()] })
      world.turns.set(SESSION, recordedState('blocked', hookEvent))
      start(world)

      await advance(2000)

      expect(world.item('A')).toMatchObject({ status: 'needs_input', status_detail: detail })
    })

    it('knows a session is alive from a recorded working state, even across a server restart', async () => {
      const world = createWorld({ items: [runningItem({ last_prompt_at: BEFORE_SERVER_START })] })
      world.turns.set(SESSION, recordedState('working', 'Working'))
      start(world)

      await advance(60_000)

      expect(world.followups).toEqual([])
      expect(world.ports.updateItem).not.toHaveBeenCalled()
      expect(world.item('A').status).toBe('running')
    })

    it('does not trust a working or blocked state recorded before the app started', async () => {
      const world = createWorld({ items: [runningItem({ last_prompt_at: BEFORE_SERVER_START })] })
      world.turns.set(
        SESSION,
        recordedState('blocked', 'answering', { updated_at: '2026-05-04T08:30:00.000Z' })
      )
      start(world)

      await advance(2000)

      expect(world.followups).toEqual([
        { sessionId: SESSION, ticketId: 'ticket-A', prompt: buildContinuePrompt('interrupted') }
      ])
    })

    it('ignores a state recorded before the last prompt', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.turns.set(
        SESSION,
        recordedState('blocked', 'answering', { updated_at: '2026-05-04T09:58:00.000Z' })
      )
      start(world)

      await advance(60_000)

      expect(world.ports.updateItem).not.toHaveBeenCalled()
    })

    it('just waits when the signal is unknown but the app has not restarted since the prompt', async () => {
      const world = createWorld({ items: [runningItem()] })
      start(world)

      await advance(60_000)

      expect(world.followups).toEqual([])
      expect(world.ports.updateItem).not.toHaveBeenCalled()
      expect(world.item('A').status).toBe('running')
      // Asked again on later ticks, but never in a tight loop.
      const polls = world.api.sessionTurn.mock.calls.length
      expect(polls).toBeGreaterThan(1)
      expect(polls).toBeLessThanOrEqual(8)
    })
  })

  describe('a working status the renderer never saw end', () => {
    it('acts on a turn end the server recorded after the status was written', async () => {
      const world = createWorld({ items: [runningItem()] })
      // Written at the prompt; the view was unmounted when the session went idle.
      world.setSignal(SESSION, { kind: 'working', since: Date.parse(PROMPTED_AT) })
      world.turns.set(SESSION, recordedTurn({ hook_event: 'SdkIdle', completion: null }))
      start(world)

      await advance(2000)

      expect(world.api.classify).toHaveBeenCalledTimes(1)
      expect(world.item('A').status).toBe('merged')
    })

    it('keeps trusting a working status newer than the recorded turn end', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.setSignal(SESSION, { kind: 'working', since: Date.parse(RECORDED_AT) + 1000 })
      world.turns.set(SESSION, recordedTurn())
      start(world)

      await advance(60_000)

      expect(world.api.classify).not.toHaveBeenCalled()
      expect(world.item('A').status).toBe('running')
    })

    it('waits on the user when the server recorded a block the renderer missed', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.setSignal(SESSION, { kind: 'working', since: Date.parse(PROMPTED_AT) })
      world.turns.set(SESSION, recordedState('blocked', 'answering', { detail: 'Which one?' }))
      start(world)

      await advance(2000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_input',
        status_detail: 'Waiting for you: Which one?'
      })
    })

    it('asks the server at most once per poll interval while the session works', async () => {
      const world = createWorld({ items: [runningItem()] })
      world.setSignal(SESSION, { kind: 'working' })
      start(world)

      for (let burst = 0; burst < 40; burst++) {
        world.setSignal(SESSION, { kind: 'working' })
        await advance(250)
      }

      expect(world.api.sessionTurn.mock.calls.length).toBeLessThanOrEqual(3)
    })
  })

  it('flags a running item that has no session', async () => {
    const world = createWorld({ items: [runningItem({ session_id: null })] })
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'It has no session to watch.'
    })
  })
})
