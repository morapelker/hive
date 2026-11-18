import { describe, expect, it } from 'vitest'
import type { SessionFinalMessage } from '@shared/types/document-flow'
import { USER_ABORT_REASON, type SessionSignal } from '@/lib/document-flow/session-signal'
import { observeRecord, observeSignal, recordShowsDelivery } from './observe'
import { PRD_FLOW_SETTLE_MS } from './ports'

// What a PRD flow reads from its session: the page's own status of it (observeSignal) and the
// main process's record of its last turn state (observeRecord), each measured against the
// stamp of the flow's last prompt.

const APP_STARTED_AT = Date.parse('2026-05-04T09:00:00.000Z')
const PROMPTED_AT = Date.parse('2026-05-04T09:59:00.000Z')
const NOW = Date.parse('2026-05-04T10:00:00.000Z')
/** Half a minute after the prompt: long enough before NOW to have settled. */
const ENDED_AT = PROMPTED_AT + 30_000

type EndedSignal = Extract<SessionSignal, { kind: 'ended' }>

const ended = (overrides: Partial<EndedSignal> = {}): EndedSignal => ({
  kind: 'ended',
  at: ENDED_AT,
  completion: 'completed',
  apiError: null,
  reason: null,
  hookEvent: 'Stop',
  hasBackgroundWork: false,
  ...overrides
})

const recorded = (overrides: Partial<SessionFinalMessage> = {}): SessionFinalMessage => ({
  session_id: 'session-1',
  state: 'ended',
  text: 'All done.',
  completion: 'completed',
  api_error: null,
  hook_event: 'Stop',
  detail: null,
  background_work: null,
  updated_at: new Date(ENDED_AT).toISOString(),
  ...overrides
})

const iso = (ms: number): string => new Date(ms).toISOString()

describe('observeSignal', () => {
  it('reports a session at work as working, whenever it began', () => {
    expect(
      observeSignal({ kind: 'working', since: PROMPTED_AT - 5_000 }, PROMPTED_AT, NOW)
    ).toEqual({ kind: 'working' })
  })

  it('says nothing when the page has no status for the session', () => {
    expect(observeSignal({ kind: 'unknown' }, PROMPTED_AT, NOW)).toBeNull()
  })

  it('reports what a blocked session waits for in its own words when it gave any', () => {
    expect(
      observeSignal(
        { kind: 'blocked', reason: 'question', detail: 'Which database do we use?' },
        PROMPTED_AT,
        NOW
      )
    ).toEqual({ kind: 'blocked', detail: 'Which database do we use?' })
  })

  it.each([
    ['question', 'a question'],
    ['permission', 'a permission request'],
    ['command_approval', 'a command to approve'],
    ['plan', 'a plan to review']
  ] as const)('names a blocked session with no detail by its reason: %s', (reason, label) => {
    expect(observeSignal({ kind: 'blocked', reason, detail: null }, PROMPTED_AT, NOW)).toEqual({
      kind: 'blocked',
      detail: label
    })
  })

  it('reports a settled turn end newer than the prompt as ended', () => {
    expect(observeSignal(ended(), PROMPTED_AT, NOW)).toEqual({
      kind: 'ended',
      hasBackgroundWork: false
    })
  })

  it('ignores a turn end that is not newer than the prompt', () => {
    expect(observeSignal(ended({ at: PROMPTED_AT - 1 }), PROMPTED_AT, NOW)).toBeNull()
    expect(observeSignal(ended({ at: PROMPTED_AT }), PROMPTED_AT, NOW)).toBeNull()
  })

  it('does not take the blip a CLI publishes while it starts for a turn end', () => {
    expect(observeSignal(ended({ hookEvent: 'SessionStart' }), PROMPTED_AT, NOW)).toBeNull()
    expect(
      observeSignal(ended({ hookEvent: null, reason: 'pty_start' }), PROMPTED_AT, NOW)
    ).toBeNull()
  })

  it('makes every kind of end wait out the settle delay', () => {
    const at = NOW - (PRD_FLOW_SETTLE_MS - 1)
    const until = at + PRD_FLOW_SETTLE_MS
    expect(observeSignal(ended({ at }), PROMPTED_AT, NOW)).toEqual({ kind: 'settling', until })
    expect(observeSignal(ended({ at, apiError: 'overloaded' }), PROMPTED_AT, NOW)).toEqual({
      kind: 'settling',
      until
    })
    expect(observeSignal(ended({ at: NOW - PRD_FLOW_SETTLE_MS }), PROMPTED_AT, NOW)).toEqual({
      kind: 'ended',
      hasBackgroundWork: false
    })
  })

  it('reports an end on an API error with when it happened', () => {
    expect(observeSignal(ended({ apiError: 'overloaded_error' }), PROMPTED_AT, NOW)).toEqual({
      kind: 'api_error',
      at: ENDED_AT,
      error: 'overloaded_error'
    })
  })

  it.each(['user_interrupt', 'codex_turn_aborted', USER_ABORT_REASON])(
    'reports an end with the reason %s as the person stopping the turn',
    (reason) => {
      expect(observeSignal(ended({ reason, completion: undefined }), PROMPTED_AT, NOW)).toEqual({
        kind: 'user_stopped'
      })
    }
  )

  it('reports a session whose process went away without a Stop as died, and does not say whether the prompt had reached it', () => {
    // The page knows that the process went away, not what it had got: a process that exits
    // before its first word ends the same way.
    const died = { kind: 'died', delivered: null }
    expect(observeSignal(ended({ completion: 'none', hookEvent: null }), PROMPTED_AT, NOW)).toEqual(
      died
    )
    expect(
      observeSignal(ended({ completion: undefined, reason: 'pty_exit' }), PROMPTED_AT, NOW)
    ).toEqual(died)
    expect(
      observeSignal(ended({ completion: undefined, hookEvent: 'SessionEnd' }), PROMPTED_AT, NOW)
    ).toEqual(died)
  })

  it('reports the person stopping a CLI turn as their stop, though no Stop hook ended it', () => {
    expect(
      observeSignal(ended({ completion: 'none', reason: 'user_interrupt' }), PROMPTED_AT, NOW)
    ).toEqual({ kind: 'user_stopped' })
  })

  it('reports a turn the agent paused for work it started as paused', () => {
    expect(observeSignal(ended({ completion: 'waiting' }), PROMPTED_AT, NOW)).toEqual({
      kind: 'paused'
    })
  })

  it('reports work left running at a finished turn', () => {
    expect(observeSignal(ended({ hasBackgroundWork: true }), PROMPTED_AT, NOW)).toEqual({
      kind: 'ended',
      hasBackgroundWork: true
    })
    expect(
      observeSignal(
        ended({ completion: 'unknown', pending: { monitors: [], wakeups: 1, agents: 0 } }),
        PROMPTED_AT,
        NOW
      )
    ).toEqual({ kind: 'ended', hasBackgroundWork: true })
  })

  it('takes an end of an older claude, which cannot say what is pending, for a finished turn', () => {
    expect(observeSignal(ended({ completion: 'unknown' }), PROMPTED_AT, NOW)).toEqual({
      kind: 'ended',
      hasBackgroundWork: false
    })
  })
})

describe('observeRecord', () => {
  const observe = (turn: SessionFinalMessage | null, promptedAt: number = PROMPTED_AT) =>
    observeRecord(turn, promptedAt, APP_STARTED_AT, NOW)

  it('says nothing without a record, or with one whose time cannot be read', () => {
    expect(observe(null)).toBeNull()
    expect(observe(recorded({ updated_at: 'not a date' }))).toBeNull()
  })

  it('reports a recorded turn end newer than the prompt as ended', () => {
    expect(observe(recorded())).toEqual({ kind: 'ended', hasBackgroundWork: false })
  })

  it('ignores a recorded turn end that is not newer than the prompt', () => {
    expect(observe(recorded({ updated_at: iso(PROMPTED_AT) }))).toBeNull()
    expect(observe(recorded({ updated_at: iso(PROMPTED_AT - 60_000) }))).toBeNull()
  })

  it('keeps a turn end recorded before this app instance started: an end stays true', () => {
    const beforeStart = APP_STARTED_AT - 60_000
    expect(observe(recorded({ updated_at: iso(beforeStart) }), beforeStart - 60_000)).toEqual({
      kind: 'ended',
      hasBackgroundWork: false
    })
  })

  it('ignores a working or blocked state recorded before this app instance started', () => {
    const beforeStart = iso(APP_STARTED_AT - 60_000)
    const promptedAt = APP_STARTED_AT - 120_000
    expect(
      observe(
        recorded({ state: 'working', hook_event: 'Working', updated_at: beforeStart }),
        promptedAt
      )
    ).toBeNull()
    expect(
      observe(
        recorded({ state: 'blocked', hook_event: 'answering', updated_at: beforeStart }),
        promptedAt
      )
    ).toBeNull()
  })

  it('ignores a working or blocked state recorded before the prompt', () => {
    const before = iso(PROMPTED_AT - 1_000)
    expect(
      observe(recorded({ state: 'working', hook_event: 'Working', updated_at: before }))
    ).toBeNull()
    expect(
      observe(recorded({ state: 'blocked', hook_event: 'permission', updated_at: before }))
    ).toBeNull()
  })

  it('reports a session recorded at work since the prompt as working', () => {
    expect(
      observe(recorded({ state: 'working', hook_event: 'Working', completion: null }))
    ).toEqual({ kind: 'working' })
  })

  it.each([
    ['answering', 'a question'],
    ['permission', 'a permission request'],
    ['command_approval', 'a command to approve'],
    ['plan_ready', 'a plan to review']
  ])('names a recorded block by the status that recorded it: %s', (hookEvent, label) => {
    expect(
      observe(recorded({ state: 'blocked', hook_event: hookEvent, completion: null }))
    ).toEqual({ kind: 'blocked', detail: label })
  })

  it('reports a recorded block with what the main process knew of it', () => {
    expect(
      observe(
        recorded({ state: 'blocked', hook_event: 'permission', completion: null, detail: 'Bash' })
      )
    ).toEqual({ kind: 'blocked', detail: 'Bash' })
  })

  it('does not take a recorded session start for a turn end', () => {
    expect(observe(recorded({ hook_event: 'SessionStart' }))).toBeNull()
  })

  it('makes a recorded end wait out the settle delay', () => {
    const at = NOW - 1_000
    expect(observe(recorded({ updated_at: iso(at) }))).toEqual({
      kind: 'settling',
      until: at + PRD_FLOW_SETTLE_MS
    })
  })

  it('reports a recorded end on an API error with when it happened', () => {
    expect(
      observe(recorded({ hook_event: 'StopFailure', completion: null, api_error: 'rate_limit' }))
    ).toEqual({ kind: 'api_error', at: ENDED_AT, error: 'rate_limit' })
  })

  it('reports a recorded interrupt as the person stopping the turn', () => {
    expect(observe(recorded({ hook_event: 'Interrupt', completion: null }))).toEqual({
      kind: 'user_stopped'
    })
  })

  it('reports a recorded pause as paused', () => {
    expect(observe(recorded({ completion: 'waiting' }))).toEqual({ kind: 'paused' })
  })

  it('reports the work the recorded Stop said was left running', () => {
    expect(observe(recorded({ background_work: 2 }))).toEqual({
      kind: 'ended',
      hasBackgroundWork: true
    })
    expect(observe(recorded({ background_work: 0 }))).toEqual({
      kind: 'ended',
      hasBackgroundWork: false
    })
  })

  describe('a turn end recorded before this app instance started', () => {
    const endedAt = APP_STARTED_AT - 60_000
    const promptedAt = endedAt - 60_000

    it('does not report the work that end left running: it went away with the app', () => {
      expect(
        observe(recorded({ background_work: 2, updated_at: iso(endedAt) }), promptedAt)
      ).toEqual({ kind: 'ended', hasBackgroundWork: false })
    })

    it('reports a pause as a session that went away over a prompt it had got: nothing is left to wake it', () => {
      expect(
        observe(recorded({ completion: 'waiting', updated_at: iso(endedAt) }), promptedAt)
      ).toEqual({ kind: 'died', delivered: true })
    })

    it('still reports an API error and a stop of the person as what they were', () => {
      expect(
        observe(
          recorded({
            hook_event: 'StopFailure',
            api_error: 'overloaded',
            updated_at: iso(endedAt)
          }),
          promptedAt
        )
      ).toEqual({ kind: 'api_error', at: endedAt, error: 'overloaded' })
      expect(
        observe(
          recorded({ hook_event: 'Interrupt', completion: 'waiting', updated_at: iso(endedAt) }),
          promptedAt
        )
      ).toEqual({ kind: 'user_stopped' })
    })

    it('keeps the pause and the work while the app does not know when it started', () => {
      const unknownStart = 0
      expect(
        observeRecord(
          recorded({ completion: 'waiting', updated_at: iso(endedAt) }),
          promptedAt,
          unknownStart,
          NOW
        )
      ).toEqual({ kind: 'paused' })
      expect(
        observeRecord(
          recorded({ background_work: 1, updated_at: iso(endedAt) }),
          promptedAt,
          unknownStart,
          NOW
        )
      ).toEqual({ kind: 'ended', hasBackgroundWork: true })
    })

    it('keeps the pause and the work of an end this app instance recorded, from its first moment on', () => {
      const atStart = iso(APP_STARTED_AT)
      expect(observe(recorded({ completion: 'waiting', updated_at: atStart }), promptedAt)).toEqual(
        {
          kind: 'paused'
        }
      )
      expect(observe(recorded({ background_work: 1, updated_at: atStart }), promptedAt)).toEqual({
        kind: 'ended',
        hasBackgroundWork: true
      })
    })
  })
})

describe('recordShowsDelivery', () => {
  it.each([
    ['work', { state: 'working', hook_event: 'Working', completion: null }],
    ['a question', { state: 'blocked', hook_event: 'answering', completion: null }],
    ['a turn end', {}]
  ] as const)('takes %s recorded after the prompt for the prompt having arrived', (_what, turn) => {
    expect(recordShowsDelivery(recorded(turn), PROMPTED_AT)).toBe(true)
  })

  it('says the prompt did not arrive when nothing was recorded of the session', () => {
    expect(recordShowsDelivery(null, PROMPTED_AT)).toBe(false)
  })

  it('says the prompt did not arrive when the record is not newer than it', () => {
    expect(recordShowsDelivery(recorded({ updated_at: iso(PROMPTED_AT) }), PROMPTED_AT)).toBe(false)
    expect(recordShowsDelivery(recorded({ updated_at: iso(PROMPTED_AT - 1) }), PROMPTED_AT)).toBe(
      false
    )
  })

  it('does not take the start of the process, or a record whose time cannot be read, for the prompt arriving', () => {
    expect(recordShowsDelivery(recorded({ hook_event: 'SessionStart' }), PROMPTED_AT)).toBe(false)
    expect(recordShowsDelivery(recorded({ updated_at: 'not a date' }), PROMPTED_AT)).toBe(false)
  })
})
