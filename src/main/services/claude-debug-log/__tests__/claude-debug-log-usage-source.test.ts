// @vitest-environment node
/**
 * The debug-log usage source on its own (Code Mode T16): real log files in a
 * temporary directory, written the way the CLI writes them (open, append,
 * close), a collecting `submit`, and an injected clock and timer so that the
 * schedule can be stepped. The two measured tests at the end run on real
 * timers. How a reading reaches an account and the `usage:claudeLive` event is
 * covered next door, in `claude-debug-log-usage.test.ts`.
 *
 * The lines come from ../__fixtures__ (see the parser test for where those
 * come from). Nothing here prints a line: assertions compare parsed values and
 * counters, so a failure shows numbers, never raw log content.
 */
import * as fs from 'node:fs'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeLiveUsagePayload } from '@shared/types/claude-live-usage'
import type { UsageData } from '@shared/types/usage'
import type { SavedUsageAccount } from '../../../db/types'
import {
  ClaudeUsageLiveUpdater,
  type ClaudeUsageObservation
} from '../../claude-api-proxy/claude-usage-live-updater'
import type { DebugLogFollowerFs } from '../../claude-debug-log-follower'
import {
  ClaudeDebugLogUsageSource,
  DEBUG_LOG_ACTIVE_CHECK_INTERVAL_MS,
  DEBUG_LOG_ACTIVITY_HOLD_MS,
  DEBUG_LOG_IDLE_CHECK_INTERVAL_MS,
  type ClaudeDebugLogUsageSourceDeps
} from '../claude-debug-log-usage-source'

const posixOnly = process.platform === 'win32' ? it.skip : it

const FIXTURES = join(__dirname, '..', '__fixtures__')

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
}

function fixtureLine(name: string): string {
  const lines = fixtureLines(name)
  if (lines.length !== 1) throw new Error(`${name}: expected one line, found ${lines.length}`)
  return lines[0]
}

/** A streaming 200 billed to ORG_A at 12:39:34.892: 5h 3%, 7d 37%. */
const STREAMING = fixtureLine('response-start-streaming.txt')
const STREAMING_AT = Date.UTC(2026, 10, 17, 12, 39, 34, 892)
/** A Fable-model 200 billed to ORG_B at 12:39:34.901: 7d 36%, Fable bucket 71%. */
const FABLE = fixtureLine('response-start-fable.txt')
const FABLE_AT = Date.UTC(2026, 10, 17, 12, 39, 34, 901)
/** A plan-limit 429 billed to ORG_A at 12:39:34.974: 5h 100% rejected, 7d 52%. */
const PLAN_LIMIT = fixtureLine('response-error-429-plan-limit.txt')
const PLAN_LIMIT_AT = Date.UTC(2026, 10, 17, 12, 39, 34, 974)
/** Error responses without any rate-limit header. */
const NOT_FOUND = fixtureLine('response-error-404.txt')
const NOT_FOUND_COMPACT = fixtureLine('response-error-404-compact-headers.txt')
/** Requests, status lines, parsed bodies, start-up lines: 14 lines, no entry among them. */
const NOT_ENTRIES = fixtureLines('not-entries.txt')

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const ORG_B = '00000000-0000-4000-8000-00000000000b'

/** The same response, logged at another moment. */
function at(line: string, time: number): string {
  return new Date(time).toISOString() + line.slice('2026-01-01T00:00:00.000Z'.length)
}

/** The same response, billed to another organization. */
function billedTo(line: string, organization: string): string {
  const changed = line.replace(
    /'anthropic-organization-id': '[^']*'/,
    `'anthropic-organization-id': '${organization}'`
  )
  if (changed === line) throw new Error('the fixture has no organization header')
  return changed
}

/**
 * A synthetic `response start` built the way the CLI builds one (see the parser test), for a
 * set of headers no capture has.
 */
function responseStart(headers: Record<string, string>, time: number): string {
  const details = {
    url: 'https://api.anthropic.com/v1/messages?beta=true',
    status: 200,
    headers,
    durationMs: 1550
  }
  const text = `console.log: [log_0a1b2c] response start ${inspect(details)}`
  return `${new Date(time).toISOString()} [DEBUG] ${text.includes('\n') ? JSON.stringify(text) : text}`
}

/** What a request leaves in the log, in the order the CLI writes it: about 4.4 KB. */
const ONE_REQUEST =
  [NOT_ENTRIES[0], STREAMING, NOT_ENTRIES[2], NOT_ENTRIES[5], NOT_ENTRIES[6], NOT_ENTRIES[7]].join(
    '\n'
  ) + '\n'

/** Long after the lines were logged, so that a reading stamped "now" would stand out. */
const START = Date.UTC(2026, 10, 20, 9, 0, 0)

const ACTIVE = DEBUG_LOG_ACTIVE_CHECK_INTERVAL_MS
const IDLE = DEBUG_LOG_IDLE_CHECK_INTERVAL_MS
const HOLD = DEBUG_LOG_ACTIVITY_HOLD_MS

const FS_CALLS = [
  'lstatSync',
  'openSync',
  'fstatSync',
  'readSync',
  'closeSync',
  'fchmodSync',
  'renameSync',
  'unlinkSync',
  'readdirSync'
] as const

type FsCall = (typeof FS_CALLS)[number]

/** The real fs with every call of the followers counted. */
function countingFs(): {
  fs: DebugLogFollowerFs
  total: () => number
  of: (name: FsCall) => number
} {
  const calls = Object.fromEntries(FS_CALLS.map((name) => [name, 0])) as Record<FsCall, number>
  const facade: Record<string, unknown> = {}
  for (const name of FS_CALLS) {
    const target = fs[name] as (...args: unknown[]) => unknown
    facade[name] = (...args: unknown[]): unknown => {
      calls[name] += 1
      return target(...args)
    }
  }
  return {
    fs: facade as unknown as DebugLogFollowerFs,
    total: () => FS_CALLS.reduce((sum, name) => sum + calls[name], 0),
    of: (name) => calls[name]
  }
}

interface Clock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Move the clock, firing every timer that falls due on the way, in order. */
  advance: (ms: number) => void
  /** Move the clock without firing anything on the way: the event loop was blocked. */
  stall: (ms: number) => void
  /** Timers armed right now. */
  armed: () => number
  /** The delay of every timer ever armed. */
  delays: number[]
}

function makeClock(): Clock {
  let now = START
  let nextId = 0
  const timers: Array<{ id: number; at: number; fn: () => void }> = []
  const delays: number[] = []
  const fireDue = (target: number, moveClock: boolean): void => {
    for (let guard = 0; guard < 100_000; guard += 1) {
      const due = timers
        .filter((timer) => timer.at <= target)
        .sort((x, y) => x.at - y.at || x.id - y.id)[0]
      if (due === undefined) return
      timers.splice(timers.indexOf(due), 1)
      if (moveClock) now = Math.max(now, due.at)
      due.fn()
    }
    throw new Error('timers never ran dry')
  }
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { id: nextId++, at: now + ms, fn }
      timers.push(timer)
      delays.push(ms)
      return timer
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number])
      if (index !== -1) timers.splice(index, 1)
    },
    advance: (ms) => {
      const target = now + ms
      fireDue(target, true)
      now = target
    },
    stall: (ms) => {
      now += ms
      // Everything that fell due meanwhile fires now, late, once each.
      const due = timers.filter((timer) => timer.at <= now)
      for (const timer of due) {
        const index = timers.indexOf(timer)
        if (index === -1) continue
        timers.splice(index, 1)
        timer.fn()
      }
    },
    armed: () => timers.length,
    delays
  }
}

describe('ClaudeDebugLogUsageSource', () => {
  let dir: string
  let clock: Clock
  let submitted: ClaudeUsageObservation[]
  /** Everything the source handed to its logger, as the log file would hold it. */
  let logged: string[]
  /** Every line written to a session's log in the test. */
  let written: string[]
  let sources: ClaudeDebugLogUsageSource[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'debug-log-usage-source-'))
    clock = makeClock()
    submitted = []
    logged = []
    written = []
    sources = []
  })

  afterEach(() => {
    for (const source of sources) source.dispose()
    rmSync(dir, { recursive: true, force: true })
    // SEC-5: whatever the test did, nothing of a log line was handed to the logger.
    const log = logged.join('\n')
    for (const line of written) {
      for (const piece of rawPieces(line)) expect(log.includes(piece)).toBe(false)
    }
  })

  /** Pieces of a line that would give it away in a log: its header names, values and ids. */
  function rawPieces(line: string): string[] {
    return line.split(/[\s'"`{},\\]+/).filter((piece) => piece.length >= 12)
  }

  function logPath(session: string): string {
    return join(dir, session, 'usage.log')
  }

  /** The CLI's way of writing: open, append, close on every write; whole lines. */
  function append(session: string, ...lines: string[]): void {
    mkdirSync(join(dir, session), { recursive: true })
    for (const line of lines) {
      written.push(line)
      appendFileSync(logPath(session), line + '\n')
    }
  }

  function makeSource(
    deps: Partial<ClaudeDebugLogUsageSourceDeps> = {}
  ): ClaudeDebugLogUsageSource {
    const record =
      (level: string) =>
      (message: string, data?: Record<string, unknown>): void => {
        logged.push(`${level} ${message} ${JSON.stringify(data ?? {})}`)
      }
    const source = new ClaudeDebugLogUsageSource({
      submit: (observation) => submitted.push(observation),
      log: { debug: record('debug'), info: record('info') },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ...deps
    })
    sources.push(source)
    return source
  }

  function register(source: ClaudeDebugLogUsageSource, session: string): boolean {
    return source.register({ sessionId: session, logPath: logPath(session) })
  }

  /** A registered session that has gone quiet: on the idle schedule, the timer armed for it. */
  function idleSession(source: ClaudeDebugLogUsageSource, session: string): void {
    register(source, session)
    clock.advance(HOLD + IDLE)
  }

  const checksOf = (source: ClaudeDebugLogUsageSource, session: string): number =>
    source.facts(session)!.follower.checks

  describe('observations', () => {
    it('submits one observation per response entry: the line time and the organization, nothing else', () => {
      const source = makeSource()
      register(source, 'a')

      append('a', STREAMING)
      clock.advance(ACTIVE)

      expect(submitted).toHaveLength(1)
      expect(submitted[0]).toMatchObject({
        credentialFingerprint: null,
        accountUuid: null,
        organizationUuid: ORG_A,
        // When the response was logged, days before it was read here.
        observedAt: STREAMING_AT
      })
      expect(Object.keys(submitted[0]).sort()).toEqual([
        'accountUuid',
        'credentialFingerprint',
        'observedAt',
        'organizationUuid',
        'snapshot'
      ])
      expect(submitted[0].snapshot.sevenDay).toEqual({
        utilizationPercent: 37,
        resetsAt: 1795435200,
        status: 'allowed',
        surpassedThreshold: null
      })
      expect(submitted[0].snapshot.fiveHour?.utilizationPercent).toBe(3)

      // Read once: later passes submit nothing again.
      clock.advance(10 * IDLE)
      expect(submitted).toHaveLength(1)
    })

    it('keeps the model-scoped bucket of a Fable response', () => {
      const source = makeSource()
      register(source, 'a')

      append('a', FABLE)
      clock.advance(ACTIVE)

      expect(submitted).toHaveLength(1)
      expect(submitted[0].organizationUuid).toBe(ORG_B)
      expect(submitted[0].observedAt).toBe(FABLE_AT)
      expect(submitted[0].snapshot.scoped.oi?.utilizationPercent).toBe(71)
      expect(submitted[0].snapshot.representativeClaim).toBe('seven_day_overage_included')
    })

    it('reports the usage of an error response that carries it (a plan-limit 429)', () => {
      const source = makeSource()
      register(source, 'a')

      append('a', PLAN_LIMIT)
      clock.advance(ACTIVE)

      expect(submitted).toHaveLength(1)
      expect(submitted[0].observedAt).toBe(PLAN_LIMIT_AT)
      expect(submitted[0].snapshot.status).toBe('rejected')
      expect(submitted[0].snapshot.fiveHour?.utilizationPercent).toBe(100)
      expect(submitted[0].snapshot.sevenDay?.utilizationPercent).toBe(52)
    })

    it('submits nothing for error entries without usage headers or for unrelated lines', () => {
      const source = makeSource()
      register(source, 'a')

      append('a', ...NOT_ENTRIES, NOT_FOUND, NOT_FOUND_COMPACT)
      clock.advance(ACTIVE)

      expect(submitted).toEqual([])
      expect(source.facts('a')).toMatchObject({
        linesRead: NOT_ENTRIES.length + 2,
        entriesParsed: 2,
        entriesWithoutUsage: 2,
        entriesWithoutOrganization: 0,
        observations: 0,
        parseFailures: 0,
        lastObservationAt: null
      })
    })

    it('submits nothing for a response whose rate-limit headers carry a verdict but no numbers', () => {
      const source = makeSource()
      register(source, 'a')

      append(
        'a',
        responseStart(
          {
            'anthropic-organization-id': ORG_A,
            'anthropic-ratelimit-unified-status': 'allowed',
            'anthropic-ratelimit-unified-representative-claim': 'seven_day',
            'anthropic-ratelimit-unified-reset': '1795435200'
          },
          STREAMING_AT
        )
      )
      clock.advance(ACTIVE)

      expect(submitted).toEqual([])
      expect(source.facts('a')).toMatchObject({
        entriesParsed: 1,
        entriesWithoutUsage: 1,
        observations: 0,
        parseFailures: 0
      })
    })

    it('submits nothing for usage whose organization is masked: there is nothing to attribute it by', () => {
      const source = makeSource()
      register(source, 'a')

      append('a', billedTo(STREAMING, '[REDACTED]'))
      clock.advance(ACTIVE)

      expect(submitted).toEqual([])
      expect(source.facts('a')).toMatchObject({
        entriesParsed: 1,
        entriesWithoutOrganization: 1,
        entriesWithoutUsage: 0,
        observations: 0
      })
    })

    it('counts an entry it cannot read and goes on to the next line', () => {
      const source = makeSource()
      register(source, 'a')

      // Cut off inside the headers object, as a truncated write would leave it.
      append('a', STREAMING.slice(0, 700), FABLE)
      clock.advance(ACTIVE)

      expect(submitted.map((observation) => observation.observedAt)).toEqual([FABLE_AT])
      expect(source.facts('a')).toMatchObject({ parseFailures: 1, entriesParsed: 1 })
    })

    it('waits for the rest of an entry that was split across two writes', () => {
      const source = makeSource()
      register(source, 'a')
      mkdirSync(join(dir, 'a'), { recursive: true })
      written.push(STREAMING)

      appendFileSync(logPath('a'), STREAMING.slice(0, 900))
      clock.advance(ACTIVE)
      expect(submitted).toEqual([])

      appendFileSync(logPath('a'), STREAMING.slice(900) + '\n')
      clock.advance(ACTIVE)
      expect(submitted).toHaveLength(1)
      expect(submitted[0].observedAt).toBe(STREAMING_AT)
      expect(source.facts('a')!.parseFailures).toBe(0)
    })

    it('submits every entry found in one check, in the order they were logged', () => {
      const source = makeSource()
      register(source, 'a')

      append('a', STREAMING, NOT_ENTRIES[2], FABLE, NOT_FOUND, PLAN_LIMIT)
      clock.advance(ACTIVE)

      expect(submitted.map((observation) => observation.observedAt)).toEqual([
        STREAMING_AT,
        FABLE_AT,
        PLAN_LIMIT_AT
      ])
      expect(source.facts('a')).toMatchObject({ entriesParsed: 4, observations: 3 })
    })

    it('reads a backlog larger than one check allows over the following passes', () => {
      const source = makeSource({ follower: { maxBytesPerCheck: 4 * 1024 } })
      register(source, 'a')

      const times = Array.from({ length: 12 }, (_, index) => STREAMING_AT + index * 1_000)
      append('a', ...times.map((time) => at(STREAMING, time)))
      clock.advance(ACTIVE)
      expect(submitted.length).toBeGreaterThan(0)
      expect(submitted.length).toBeLessThan(times.length)

      clock.advance(ACTIVE * 10)
      expect(submitted.map((observation) => observation.observedAt)).toEqual(times)
    })

    it('keeps the readings of two sessions on different accounts apart', () => {
      const source = makeSource()
      register(source, 'a')
      register(source, 'b')

      append('a', STREAMING)
      append('b', FABLE, at(FABLE, FABLE_AT + 5_000))
      clock.advance(ACTIVE)

      expect(
        submitted
          .map((observation) => `${observation.organizationUuid}@${observation.observedAt}`)
          .sort()
      ).toEqual([
        `${ORG_A}@${STREAMING_AT}`,
        `${ORG_B}@${FABLE_AT}`,
        `${ORG_B}@${FABLE_AT + 5_000}`
      ])
      expect(source.facts('a')).toMatchObject({ observations: 1, lastObservationAt: STREAMING_AT })
      expect(source.facts('b')).toMatchObject({
        observations: 2,
        lastObservationAt: FABLE_AT + 5_000
      })
    })

    it('survives a live updater that throws, and counts it', () => {
      let refuse = true
      const source = makeSource({
        submit: (observation) => {
          if (refuse) throw new Error('the updater is gone')
          submitted.push(observation)
        }
      })
      register(source, 'a')

      append('a', STREAMING)
      clock.advance(ACTIVE)
      refuse = false
      append('a', FABLE)
      clock.advance(ACTIVE)

      expect(submitted.map((observation) => observation.observedAt)).toEqual([FABLE_AT])
      expect(source.facts('a')).toMatchObject({
        submitFailures: 1,
        observations: 1,
        entriesParsed: 2
      })
    })
  })

  describe('registering and unregistering', () => {
    it('has no timer until a session is registered, one timer for any number, and none after the last left', () => {
      const source = makeSource()
      expect(clock.armed()).toBe(0)
      expect(source.stats()).toMatchObject({ sessions: 0, timerArmed: false })

      register(source, 'a')
      expect(clock.armed()).toBe(1)
      register(source, 'b')
      register(source, 'c')
      expect(clock.armed()).toBe(1)
      clock.advance(HOLD + 3 * IDLE)
      expect(clock.armed()).toBe(1)
      expect(source.stats()).toMatchObject({ sessions: 3, timerArmed: true })

      source.unregister('a')
      source.unregister('b')
      expect(clock.armed()).toBe(1)
      source.unregister('c')
      expect(clock.armed()).toBe(0)
      expect(source.stats()).toMatchObject({ sessions: 0, timerArmed: false })

      // And none comes back on its own.
      const armedBefore = clock.delays.length
      clock.advance(60_000)
      expect(clock.delays.length).toBe(armedBefore)
    })

    it('delivers the entries written just before unregistering, and never looks at the log again', () => {
      const counting = countingFs()
      const source = makeSource({ follower: { fs: counting.fs } })
      register(source, 'a')
      append('a', STREAMING)
      clock.advance(ACTIVE)
      expect(submitted).toHaveLength(1)

      // Written after the last check: only the final read can find them.
      append('a', NOT_ENTRIES[0], FABLE, PLAN_LIMIT)
      const final = source.unregister('a')

      expect(submitted.map((observation) => observation.observedAt)).toEqual([
        STREAMING_AT,
        FABLE_AT,
        PLAN_LIMIT_AT
      ])
      expect(final).toMatchObject({
        sessionId: 'a',
        observations: 3,
        entriesParsed: 3,
        linesRead: 4,
        lastObservationAt: PLAN_LIMIT_AT
      })
      expect(source.facts('a')).toBeNull()

      const fsCalls = counting.total()
      const passes = source.stats().passes
      append('a', at(STREAMING, STREAMING_AT + 60_000))
      clock.advance(10 * IDLE)
      source.checkNow()
      source.checkNow('a')

      expect(counting.total()).toBe(fsCalls)
      expect(source.stats().passes).toBe(passes)
      expect(clock.armed()).toBe(0)
      expect(submitted).toHaveLength(3)
    })

    it('reads a large backlog to its end on the final read, past the bound of a single check', () => {
      const source = makeSource({ follower: { maxBytesPerCheck: 4 * 1024 } })
      register(source, 'a')

      const times = Array.from({ length: 20 }, (_, index) => STREAMING_AT + index * 1_000)
      append('a', ...times.map((time) => at(STREAMING, time)))
      source.unregister('a')

      expect(submitted.map((observation) => observation.observedAt)).toEqual(times)
    })

    it('keeps checking the sessions that remain when one is unregistered', () => {
      const source = makeSource()
      register(source, 'a')
      register(source, 'b')
      source.unregister('a')

      append('b', FABLE)
      clock.advance(ACTIVE)

      expect(submitted.map((observation) => observation.organizationUuid)).toEqual([ORG_B])
    })

    it('changes nothing when a session that is already followed is registered again', () => {
      const source = makeSource()
      expect(register(source, 'a')).toBe(true)
      append('a', STREAMING)
      clock.advance(ACTIVE)
      const before = source.facts('a')!

      expect(register(source, 'a')).toBe(false)
      clock.advance(ACTIVE)

      // Not read a second time from the start, and the same registration.
      expect(submitted).toHaveLength(1)
      expect(source.facts('a')).toMatchObject({
        registeredAt: before.registeredAt,
        bytesRead: before.bytesRead,
        observations: 1
      })
      expect(source.stats().sessions).toBe(1)
      expect(clock.armed()).toBe(1)
    })

    it('finishes the old log and follows the new one when an id is registered with another path', () => {
      const source = makeSource()
      register(source, 'a')
      append('a', STREAMING)

      // A resumed session: a new launch, a new directory, the same id.
      mkdirSync(join(dir, 'a-resumed'))
      const resumedLog = join(dir, 'a-resumed', 'usage.log')
      expect(source.register({ sessionId: 'a', logPath: resumedLog })).toBe(true)
      expect(submitted.map((observation) => observation.observedAt)).toEqual([STREAMING_AT])

      written.push(FABLE)
      appendFileSync(resumedLog, FABLE + '\n')
      append('a', PLAN_LIMIT)
      clock.advance(ACTIVE)

      expect(submitted.map((observation) => observation.observedAt)).toEqual([
        STREAMING_AT,
        FABLE_AT
      ])
      expect(source.facts('a')).toMatchObject({ logPath: resumedLog, observations: 1 })
      expect(source.stats().sessions).toBe(1)
    })

    it('refuses a registration without an id or with a relative path', () => {
      const source = makeSource()
      expect(() => source.register({ sessionId: '', logPath: logPath('a') })).toThrow(TypeError)
      expect(() => source.register({ sessionId: 'a', logPath: 'usage.log' })).toThrow(TypeError)
      expect(source.stats()).toMatchObject({ sessions: 0, timerArmed: false })
    })

    it('answers for a session it does not know without doing anything', () => {
      const source = makeSource()
      expect(source.unregister('nobody')).toBeNull()
      expect(source.setTurnInProgress('nobody', true)).toBe(false)
      expect(source.facts('nobody')).toBeNull()
      expect(source.allFacts()).toEqual([])
      expect(clock.armed()).toBe(0)
    })

    it('lets go of everything on dispose and submits nothing more', () => {
      const counting = countingFs()
      const source = makeSource({ follower: { fs: counting.fs } })
      register(source, 'a')
      register(source, 'b')
      append('a', STREAMING)
      clock.advance(ACTIVE)
      expect(counting.of('openSync')).toBe(1)
      append('a', FABLE)
      append('b', PLAN_LIMIT)

      source.dispose()

      expect(submitted).toHaveLength(1)
      expect(clock.armed()).toBe(0)
      expect(source.stats()).toMatchObject({ sessions: 0, timerArmed: false })
      // Every descriptor that was opened is closed again.
      expect(counting.of('closeSync')).toBe(counting.of('openSync'))
      const fsCalls = counting.total()
      clock.advance(10 * IDLE)
      expect(counting.total()).toBe(fsCalls)
    })
  })

  describe('schedule', () => {
    it('checks a session with a turn in progress every 250 ms', () => {
      const source = makeSource()
      idleSession(source, 'a')
      source.setTurnInProgress('a', true)
      const before = checksOf(source, 'a')

      clock.advance(10_000)

      expect(checksOf(source, 'a') - before).toBe(10_000 / ACTIVE)
      expect(ACTIVE).toBe(250)
    })

    it('checks an idle session every 2 seconds', () => {
      const source = makeSource()
      idleSession(source, 'a')
      const before = checksOf(source, 'a')
      const armedBefore = clock.delays.length

      clock.advance(20_000)

      expect(checksOf(source, 'a') - before).toBe(20_000 / IDLE)
      expect(clock.delays.slice(armedBefore)).toEqual(new Array(20_000 / IDLE).fill(IDLE))
      expect(IDLE).toBe(2_000)
    })

    it('serves busy and idle sessions from one timer, each at its own pace', () => {
      const source = makeSource()
      for (const session of ['busy-1', 'busy-2', 'idle-1', 'idle-2', 'idle-3']) {
        register(source, session)
      }
      clock.advance(HOLD + IDLE)
      source.setTurnInProgress('busy-1', true)
      source.setTurnInProgress('busy-2', true)
      const before = new Map(source.allFacts().map((facts) => [facts.sessionId, facts]))
      const passesBefore = source.stats().passes

      for (let elapsed = 0; elapsed < 20_000; elapsed += 50) {
        clock.advance(50)
        expect(clock.armed()).toBe(1)
      }

      const checked = (session: string): number =>
        checksOf(source, session) - before.get(session)!.follower.checks
      expect(checked('busy-1')).toBe(20_000 / ACTIVE)
      expect(checked('busy-2')).toBe(20_000 / ACTIVE)
      for (const session of ['idle-1', 'idle-2', 'idle-3']) {
        expect(checked(session)).toBe(20_000 / IDLE)
      }
      // The idle sessions cost no wake-up of their own.
      expect(source.stats().passes - passesBefore).toBe(20_000 / ACTIVE)
    })

    it('picks up the first response of a turn within one fast interval of the turn starting', () => {
      const source = makeSource()
      idleSession(source, 'a')

      // The idle timer has most of its 2 seconds to go.
      clock.advance(100)
      source.setTurnInProgress('a', true)
      append('a', STREAMING)
      clock.advance(ACTIVE)

      expect(submitted).toHaveLength(1)
      expect(clock.armed()).toBe(1)
    })

    it('treats a session as busy from the moment it is registered: the CLI calls the API before any turn', () => {
      const source = makeSource()
      register(source, 'a')

      append('a', STREAMING)
      clock.advance(ACTIVE)
      expect(submitted).toHaveLength(1)

      // Quiet since: back to the idle pace once the hold is over.
      clock.advance(HOLD)
      const before = checksOf(source, 'a')
      clock.advance(10_000)
      expect(checksOf(source, 'a') - before).toBe(10_000 / IDLE)
    })

    it('moves an idle session whose log grew to the fast pace, and back when it goes quiet', () => {
      const source = makeSource()
      idleSession(source, 'a')

      // A request goes out with no turn announced (a background agent).
      append('a', NOT_ENTRIES[0])
      clock.advance(IDLE)
      expect(source.facts('a')!.linesRead).toBe(1)

      // Its response is then found at the fast pace.
      append('a', STREAMING)
      clock.advance(ACTIVE)
      expect(submitted).toHaveLength(1)

      const before = checksOf(source, 'a')
      clock.advance(HOLD - ACTIVE)
      expect(checksOf(source, 'a') - before).toBe((HOLD - ACTIVE) / ACTIVE)

      const quiet = checksOf(source, 'a')
      clock.advance(ACTIVE + 10_000)
      // One closing pass that finds nobody busy, then the idle pace.
      expect(checksOf(source, 'a') - quiet).toBeLessThanOrEqual(10_000 / IDLE + 1)
      expect(clock.delays[clock.delays.length - 1]).toBe(IDLE)
    })

    it('checks the log the moment a turn ends, and keeps the fast pace for what follows a turn', () => {
      const source = makeSource()
      idleSession(source, 'a')
      source.setTurnInProgress('a', true)
      clock.advance(60_000)

      // Written since the last pass; the turn ends before the next one.
      clock.advance(100)
      append('a', STREAMING)
      expect(source.setTurnInProgress('a', false)).toBe(true)
      expect(submitted).toHaveLength(1)
      expect(source.facts('a')).toMatchObject({ turnInProgress: false, observations: 1 })

      // Title generation and the like still arrive at the fast pace.
      clock.advance(HOLD / 2)
      append('a', FABLE)
      clock.advance(ACTIVE)
      expect(submitted).toHaveLength(2)

      clock.advance(HOLD + IDLE)
      const before = checksOf(source, 'a')
      clock.advance(10_000)
      expect(checksOf(source, 'a') - before).toBe(10_000 / IDLE)
    })

    it('stays on the fast pace after a turn that ended without the log growing', () => {
      const source = makeSource()
      idleSession(source, 'a')
      source.setTurnInProgress('a', true)
      clock.advance(60_000)
      source.setTurnInProgress('a', false)

      const before = checksOf(source, 'a')
      clock.advance(HOLD - ACTIVE)
      expect(checksOf(source, 'a') - before).toBe((HOLD - ACTIVE) / ACTIVE)

      // What follows a turn (a title, a summary) is found at that pace.
      append('a', STREAMING)
      clock.advance(ACTIVE)
      expect(submitted).toHaveLength(1)
    })

    it('does not make up for passes it missed while the event loop was blocked', () => {
      const source = makeSource()
      idleSession(source, 'a')
      source.setTurnInProgress('a', true)
      clock.advance(ACTIVE)
      const passes = source.stats().passes

      clock.stall(30_000)

      expect(source.stats().passes - passes).toBe(1)
      expect(clock.armed()).toBe(1)
      clock.advance(ACTIVE)
      expect(source.stats().passes - passes).toBe(2)
    })

    it('checks on request without disturbing the schedule', () => {
      const source = makeSource()
      idleSession(source, 'a')
      register(source, 'b')
      clock.advance(HOLD + IDLE)
      const armed = clock.delays.length

      append('a', STREAMING)
      append('b', FABLE)
      source.checkNow('a')
      expect(submitted.map((observation) => observation.organizationUuid)).toEqual([ORG_A])
      source.checkNow()
      expect(submitted.map((observation) => observation.organizationUuid)).toEqual([ORG_A, ORG_B])
      expect(clock.armed()).toBe(1)
      // Only the move to the fast pace armed a timer: the logs grew.
      expect(clock.delays.slice(armed)).toEqual([ACTIVE])
    })
  })

  describe('facts for health detection', () => {
    it('reports what was read, what it amounted to and when', () => {
      const source = makeSource()
      register(source, 'a')
      expect(source.facts('a')).toMatchObject({
        sessionId: 'a',
        logPath: logPath('a'),
        registeredAt: START,
        turnInProgress: false,
        lastCheckAt: null,
        bytesRead: 0,
        linesRead: 0,
        entriesParsed: 0,
        observations: 0,
        parseFailures: 0,
        lastObservationAt: null,
        lastObservationReadAt: null,
        degraded: null,
        degradedSignals: 0
      })

      const lines = [NOT_ENTRIES[0], STREAMING, NOT_ENTRIES[2], STREAMING.slice(0, 700), NOT_FOUND]
      append('a', ...lines)
      source.setTurnInProgress('a', true)
      clock.advance(ACTIVE)

      expect(source.facts('a')).toMatchObject({
        turnInProgress: true,
        lastCheckAt: START + ACTIVE,
        bytesRead: Buffer.byteLength(lines.join('\n') + '\n'),
        linesRead: 5,
        entriesParsed: 2,
        observations: 1,
        entriesWithoutUsage: 1,
        parseFailures: 1,
        oversizedLines: 0,
        // The time in the line, and the time the line was read.
        lastObservationAt: STREAMING_AT,
        lastObservationReadAt: START + ACTIVE,
        degraded: null
      })
      expect(source.allFacts().map((facts) => facts.sessionId)).toEqual(['a'])
    })

    it('shows a log that never appeared as nothing read, not as trouble', () => {
      const source = makeSource()
      register(source, 'a')
      source.setTurnInProgress('a', true)
      clock.advance(5_000)
      source.setTurnInProgress('a', false)

      expect(source.facts('a')).toMatchObject({
        bytesRead: 0,
        linesRead: 0,
        degraded: null,
        degradedSignals: 0
      })
      expect(source.facts('a')!.lastCheckAt).toBe(START + 5_000)
    })

    it('counts a line over the length limit without reading it', () => {
      const source = makeSource({ follower: { maxLineBytes: 2_048 } })
      register(source, 'a')

      append('a', STREAMING.slice(0, 1_000) + 'x'.repeat(4_000), FABLE)
      clock.advance(ACTIVE)

      expect(submitted.map((observation) => observation.observedAt)).toEqual([FABLE_AT])
      expect(source.facts('a')).toMatchObject({ oversizedLines: 1, parseFailures: 0 })
    })

    posixOnly('passes on the follower refusing an unsafe file', () => {
      const source = makeSource()
      mkdirSync(join(dir, 'a'))
      writeFileSync(join(dir, 'elsewhere.log'), '')
      symlinkSync(join(dir, 'elsewhere.log'), logPath('a'))
      register(source, 'a')

      clock.advance(1_000)

      expect(source.facts('a')).toMatchObject({
        degraded: { reason: 'unsafe-file', detail: 'symlink', at: START + ACTIVE },
        degradedSignals: 1,
        bytesRead: 0
      })
    })

    it('passes on the follower deleting a log past the hard cap, and still reads the log that replaces it', () => {
      const source = makeSource({ follower: { hardCapBytes: 8 * 1024 } })
      register(source, 'a')
      append('a', STREAMING)
      clock.advance(ACTIVE)

      append('a', ...Array.from({ length: 6 }, () => NOT_ENTRIES[0]))
      clock.advance(ACTIVE)
      expect(source.facts('a')).toMatchObject({
        degraded: { reason: 'hard-cap', detail: null, at: START + 2 * ACTIVE },
        degradedSignals: 1
      })

      // The CLI recreates the file on its next write: readings resume.
      append('a', FABLE)
      clock.advance(ACTIVE)
      expect(submitted.map((observation) => observation.observedAt)).toEqual([
        STREAMING_AT,
        FABLE_AT
      ])
      expect(source.facts('a')).toMatchObject({
        lastObservationAt: FABLE_AT,
        lastObservationReadAt: START + 3 * ACTIVE,
        degradedSignals: 1
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Measured, on real timers and real files. Set CLAUDE_DEBUG_LOG_USAGE_REPORT=1
// to have the numbers printed.
// ---------------------------------------------------------------------------

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function report(label: string, samples: number[]): { median: number; p95: number; max: number } {
  const sorted = [...samples].sort((x, y) => x - y)
  const result = {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]
  }
  if (process.env.CLAUDE_DEBUG_LOG_USAGE_REPORT) {
    console.log(
      `[measured] ${label}: n=${sorted.length} median=${result.median.toFixed(3)} ms ` +
        `p95=${result.p95.toFixed(3)} ms max=${result.max.toFixed(3)} ms`
    )
  }
  return result
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('ClaudeDebugLogUsageSource, measured', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'debug-log-usage-measured-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('publishes a reading within 500 ms of the response starting, at the 95th percentile, for a session with a turn in progress', async () => {
    // The real live updater between the source and the publish, so that its
    // coalescing is part of what is measured; its stores are in memory.
    const EMAIL = 'me@example.com'
    let usageJson: string | null = null
    const row = (): SavedUsageAccount => ({
      id: 'row-me',
      provider: 'anthropic',
      email: EMAIL,
      credentials_json: '',
      last_usage_json: usageJson,
      last_fetched_at: null,
      status: 'ok',
      last_error: null,
      org_uuid: ORG_A,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    })
    const publishedAt = new Map<number, number>()
    const updater = new ClaudeUsageLiveUpdater({
      listManagedAccounts: async () => [],
      readLiveIdentity: async () => ({ email: EMAIL, uuid: null }),
      readLiveTokenFingerprint: async () => null,
      isAccountManaged: async (email) => email === EMAIL,
      ensureLiveAccountManaged: async () => false,
      rememberAccountUuid: async () => false,
      readUsageRow: () => row(),
      writeLiveUsage: (_email: string, usage: UsageData) => {
        usageJson = JSON.stringify(usage)
        return row()
      },
      publish: (_channel: string, payload: ClaudeLiveUsagePayload) => {
        if (!publishedAt.has(payload.observedAt)) publishedAt.set(payload.observedAt, Date.now())
        return true
      },
      listAccountOrganizations: () => [{ email: EMAIL, organizationUuid: ORG_A }],
      readLastAccountSwitchAt: () => null,
      log: { debug: () => {}, info: () => {}, warn: () => {} }
    })
    const source = new ClaudeDebugLogUsageSource({
      submit: (observation) => updater.observe(observation)
    })
    const path = join(dir, 'usage.log')
    const SAMPLES = 30

    try {
      source.register({ sessionId: 'measured', logPath: path })
      source.setTurnInProgress('measured', true)
      // Let the registration's own pass go by, off the beat of what follows.
      await sleep(300)

      const startedAt: number[] = []
      for (let index = 0; index < SAMPLES; index += 1) {
        // The response starts now: the CLI logs its headers with this time.
        // The millisecond is unique per sample, which is how its publish is found.
        let now = Date.now()
        while (startedAt.includes(now)) now = Date.now()
        startedAt.push(now)
        appendFileSync(path, at(STREAMING, now) + '\n')
        // Anywhere in the 250 ms cycle, and clear of the previous reading's coalescing window.
        await sleep(270 + Math.floor(Math.random() * 250))
      }
      await sleep(600)
      await updater.settle()

      const latencies = startedAt.map((start) => {
        const published = publishedAt.get(start)
        return published === undefined ? Number.POSITIVE_INFINITY : published - start
      })
      expect(latencies.every((latency) => Number.isFinite(latency))).toBe(true)
      expect(source.facts('measured')).toMatchObject({ observations: SAMPLES })
      const { p95 } = report('response start to usage:claudeLive published', latencies)
      expect(p95).toBeLessThan(500)
    } finally {
      source.dispose()
      updater.dispose()
    }
  }, 60_000)

  it('checks 50 registered sessions in under 2 ms when nothing changed and under 10 ms when every file changed', () => {
    const SESSIONS = 50
    // The pass is driven by hand, so that it can be timed on its own.
    let fire: (() => void) | null = null
    let observations = 0
    const source = new ClaudeDebugLogUsageSource({
      submit: () => {
        observations += 1
      },
      setTimer: (fn) => {
        fire = fn
        return fn
      },
      clearTimer: () => {
        fire = null
      }
    })
    const pass = (): number => {
      const run = fire
      if (run === null) throw new Error('no timer is armed')
      const started = performance.now()
      run()
      return performance.now() - started
    }
    const paths = Array.from({ length: SESSIONS }, (_, index) => {
      const sessionDir = join(dir, `session-${index}`)
      mkdirSync(sessionDir)
      return join(sessionDir, 'usage.log')
    })

    try {
      paths.forEach((path, index) => {
        source.register({ sessionId: `session-${index}`, logPath: path })
        // A turn in progress everywhere: every pass checks all 50.
        source.setTurnInProgress(`session-${index}`, true)
      })
      const grow = (): void => {
        for (const path of paths) appendFileSync(path, ONE_REQUEST)
      }

      // Warm up: files opened, code compiled.
      for (let round = 0; round < 30; round += 1) {
        grow()
        pass()
        pass()
      }
      const checksBefore = source.stats().checks
      const observationsBefore = observations

      const unchanged: number[] = []
      for (let round = 0; round < 300; round += 1) unchanged.push(pass())
      expect(source.stats().checks - checksBefore).toBe(300 * SESSIONS)
      expect(observations).toBe(observationsBefore)

      const changed: number[] = []
      for (let round = 0; round < 60; round += 1) {
        grow()
        changed.push(pass())
      }
      // Every pass read one request from each of the 50 files.
      expect(observations - observationsBefore).toBe(60 * SESSIONS)

      const quiet = report('pass over 50 sessions, nothing changed', unchanged)
      const busy = report('pass over 50 sessions, every file changed', changed)
      expect(quiet.p95).toBeLessThan(2)
      expect(busy.p95).toBeLessThan(10)
    } finally {
      source.dispose()
    }
  }, 60_000)
})
