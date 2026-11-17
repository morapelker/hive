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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
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
  ClaudeDebugLogUsagePerfCounters,
  type ClaudeDebugLogPerfEvent,
  type ClaudeDebugLogPerfWindow,
  type ClaudeDebugLogUsagePerf
} from '../claude-debug-log-usage-perf'
import {
  ClaudeDebugLogUsageSource,
  DEBUG_LOG_ACTIVE_CHECK_INTERVAL_MS,
  DEBUG_LOG_ACTIVITY_HOLD_MS,
  DEBUG_LOG_IDLE_CHECK_INTERVAL_MS,
  type ClaudeDebugLogHealthChange,
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
    it('submits one observation per response entry: the line time, the organization and whose log it was, nothing else', () => {
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
        // The app's own id of the session, not something read from the log (T18).
        'sessionId',
        'snapshot'
      ])
      expect(submitted[0].sessionId).toBe('a')
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
        degradedSignals: 0,
        statusLines: 0,
        turnsCompleted: 0,
        health: null,
        timesDegraded: 0
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
        // The one `succeeded with status` line among them.
        statusLines: 1,
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

  describe('health: a log that gives no readings (T18)', () => {
    /** The SDK's one-line report of a successful response: no headers, no entry. */
    const STATUS_LINE = NOT_ENTRIES[2]
    /** What the CLI logs without talking to the API. */
    const STARTUP_LINES = [NOT_ENTRIES[10], NOT_ENTRIES[11], NOT_ENTRIES[12]]
    /** A response entry after an update renamed it: the parser no longer knows the line. */
    const RENAMED_ENTRY = STREAMING.replace('response start', 'response begin')

    let changes: ClaudeDebugLogHealthChange[]

    function watched(deps: Partial<ClaudeDebugLogUsageSourceDeps> = {}): ClaudeDebugLogUsageSource {
      changes = []
      const source = makeSource(deps)
      source.onHealthChange((change) => changes.push(change))
      return source
    }

    /** One turn of a session: the prompt is submitted, `during` happens, the Stop hook fires. */
    function turn(source: ClaudeDebugLogUsageSource, session: string, during?: () => void): void {
      source.setTurnInProgress(session, true)
      during?.()
      clock.advance(3_000)
      source.setTurnInProgress(session, false)
      source.turnCompleted(session)
    }

    const reasons = (): Array<string | null> =>
      changes.map((change) => change.degradation?.reason ?? null)

    it('is degraded when a turn completes and the log never appeared', () => {
      const source = watched()
      register(source, 'a')

      turn(source, 'a')

      expect(source.facts('a')).toMatchObject({
        bytesRead: 0,
        turnsCompleted: 1,
        health: { reason: 'log-empty', detail: null, at: START + 3_000 },
        timesDegraded: 1,
        // Not one of the follower's signals.
        degraded: null,
        degradedSignals: 0
      })
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({
        sessionId: 'a',
        degradation: { reason: 'log-empty', detail: null, at: START + 3_000 },
        facts: { sessionId: 'a', bytesRead: 0, turnsCompleted: 1 }
      })
    })

    it('is degraded when a turn completes and the log is there and empty', () => {
      const source = watched()
      mkdirSync(join(dir, 'a'))
      writeFileSync(logPath('a'), '')
      register(source, 'a')

      turn(source, 'a')

      expect(reasons()).toEqual(['log-empty'])
    })

    it('judges the log as it is when the turn completes, not as the last pass left it', () => {
      const source = watched()
      // Nothing fires a pass here: only the completed turn looks at the log.
      register(source, 'a')
      source.setTurnInProgress('a', true)
      append('a', ONE_REQUEST.trimEnd())

      source.turnCompleted('a')

      expect(source.facts('a')).toMatchObject({ entriesParsed: 1, health: null })
      expect(changes).toEqual([])
    })

    it('is degraded when responses were logged and none could be read', () => {
      const source = watched()
      register(source, 'a')

      turn(source, 'a', () => {
        // A log level without headers, or a format the parser does not know.
        append('a', NOT_ENTRIES[0], STATUS_LINE, RENAMED_ENTRY, NOT_ENTRIES[6])
      })

      expect(source.facts('a')).toMatchObject({
        statusLines: 1,
        entriesParsed: 0,
        observations: 0,
        health: { reason: 'unparsed-responses', detail: null },
        timesDegraded: 1
      })
      expect(source.facts('a')!.bytesRead).toBeGreaterThan(0)
      expect(reasons()).toEqual(['unparsed-responses'])
      expect(submitted).toEqual([])
    })

    it('is degraded when the entries are there and none can be read, status line or not', () => {
      const source = watched()
      register(source, 'with-status')
      register(source, 'without-status')

      turn(source, 'with-status', () => append('with-status', STATUS_LINE, STREAMING.slice(0, 700)))
      // The status line changed too: the entry that cannot be read says a response was logged.
      turn(source, 'without-status', () => append('without-status', FABLE.slice(0, 700)))

      expect(source.facts('with-status')).toMatchObject({
        statusLines: 1,
        parseFailures: 1,
        entriesParsed: 0,
        health: { reason: 'unparsed-responses' }
      })
      expect(source.facts('without-status')).toMatchObject({
        statusLines: 0,
        parseFailures: 1,
        entriesParsed: 0,
        health: { reason: 'unparsed-responses' }
      })
    })

    it('is not degraded by one entry that cannot be read among entries that can', () => {
      const source = watched()
      register(source, 'a')

      turn(source, 'a', () => append('a', STATUS_LINE, STREAMING.slice(0, 700), STATUS_LINE, FABLE))

      expect(source.facts('a')).toMatchObject({
        parseFailures: 1,
        entriesParsed: 1,
        health: null
      })
      expect(changes).toEqual([])
    })

    it('leaves a session alone that completed a turn without a request to the API', () => {
      const source = watched()
      register(source, 'a')

      // A local command: the CLI logged, and sent nothing.
      turn(source, 'a', () => append('a', ...STARTUP_LINES))
      turn(source, 'a')

      expect(source.facts('a')).toMatchObject({
        turnsCompleted: 2,
        statusLines: 0,
        entriesParsed: 0,
        health: null,
        timesDegraded: 0
      })
      expect(source.facts('a')!.bytesRead).toBeGreaterThan(0)
      expect(changes).toEqual([])
    })

    it('leaves a session alone that has not completed a turn, however long its log stays empty', () => {
      const source = watched()
      register(source, 'a')

      clock.advance(10 * 60_000)
      // Waiting for the person in the middle of a turn is not the end of it.
      source.setTurnInProgress('a', true)
      clock.advance(60_000)
      source.setTurnInProgress('a', false)
      clock.advance(60_000)

      expect(source.facts('a')).toMatchObject({ bytesRead: 0, turnsCompleted: 0, health: null })
      expect(changes).toEqual([])
    })

    it('does not judge the responses before the turn completes', () => {
      const source = watched()
      register(source, 'a')
      source.setTurnInProgress('a', true)

      // The status line is written just before the entry: a pass can fall between the two.
      append('a', NOT_ENTRIES[0], STATUS_LINE)
      clock.advance(ACTIVE)
      expect(source.facts('a')).toMatchObject({ statusLines: 1, entriesParsed: 0, health: null })

      append('a', STREAMING)
      source.setTurnInProgress('a', false)
      source.turnCompleted('a')

      expect(source.facts('a')).toMatchObject({ entriesParsed: 1, health: null })
      expect(changes).toEqual([])
    })

    it('stays healthy over turns whose responses can be read', () => {
      const source = watched()
      register(source, 'a')

      turn(source, 'a', () => append('a', ONE_REQUEST.trimEnd()))
      // An entry without usage is an entry that was read (a 404, a temporary throttle).
      turn(source, 'a', () => append('a', STATUS_LINE, NOT_FOUND))

      expect(source.facts('a')).toMatchObject({
        turnsCompleted: 2,
        statusLines: 2,
        entriesParsed: 2,
        health: null
      })
      expect(changes).toEqual([])
    })

    it('is degraded the moment the follower deletes a log past the hard cap, turn or no turn', () => {
      const source = watched({ follower: { hardCapBytes: 8 * 1024 } })
      register(source, 'a')
      append('a', STREAMING)
      clock.advance(ACTIVE)
      expect(source.facts('a')!.health).toBeNull()

      append('a', ...Array.from({ length: 6 }, () => NOT_ENTRIES[0]))
      clock.advance(ACTIVE)

      expect(source.facts('a')).toMatchObject({
        turnsCompleted: 0,
        health: { reason: 'hard-cap', detail: null, at: START + 2 * ACTIVE },
        timesDegraded: 1
      })
      expect(reasons()).toEqual(['hard-cap'])
    })

    posixOnly('is degraded the moment the follower refuses an unsafe file', () => {
      const source = watched()
      mkdirSync(join(dir, 'a'))
      writeFileSync(join(dir, 'elsewhere.log'), '')
      symlinkSync(join(dir, 'elsewhere.log'), logPath('a'))
      register(source, 'a')

      clock.advance(1_000)

      expect(source.facts('a')!.health).toEqual({
        reason: 'unsafe-file',
        detail: 'symlink',
        at: START + ACTIVE
      })
      expect(changes).toHaveLength(1)
      expect(changes[0].degradation).toMatchObject({ reason: 'unsafe-file', detail: 'symlink' })
      // Told once, though the file is refused on every pass.
      clock.advance(10 * IDLE)
      expect(changes).toHaveLength(1)
    })

    it('is healthy again, and submits again, when entries that can be read appear', () => {
      const source = watched({ follower: { hardCapBytes: 8 * 1024 } })
      register(source, 'a')
      append('a', ...Array.from({ length: 6 }, () => NOT_ENTRIES[0]))
      clock.advance(ACTIVE)
      expect(reasons()).toEqual(['hard-cap'])
      expect(submitted).toEqual([])

      // The CLI makes the file again with its next line: other lines change nothing...
      append('a', ...STARTUP_LINES)
      clock.advance(ACTIVE)
      expect(source.facts('a')!.health).toMatchObject({ reason: 'hard-cap' })

      // ...a response entry does.
      append('a', FABLE)
      clock.advance(ACTIVE)

      expect(reasons()).toEqual(['hard-cap', null])
      expect(changes[1]).toMatchObject({ sessionId: 'a', degradation: null })
      expect(submitted.map((observation) => observation.observedAt)).toEqual([FABLE_AT])
      expect(source.facts('a')).toMatchObject({
        health: null,
        timesDegraded: 1,
        // The follower's signal is kept as it was given.
        degraded: { reason: 'hard-cap' },
        degradedSignals: 1
      })
    })

    it('recovers from an empty log and from unread responses alike', () => {
      const source = watched()
      register(source, 'empty')
      register(source, 'unread')
      turn(source, 'empty')
      turn(source, 'unread', () => append('unread', STATUS_LINE, RENAMED_ENTRY))
      expect(reasons()).toEqual(['log-empty', 'unparsed-responses'])

      append('empty', STREAMING)
      append('unread', billedTo(FABLE, ORG_A))
      clock.advance(ACTIVE)

      expect(changes.slice(2).map((change) => [change.sessionId, change.degradation])).toEqual([
        ['empty', null],
        ['unread', null]
      ])
      expect(submitted).toHaveLength(2)
      // A later turn finds nothing wrong: the entries count for good.
      turn(source, 'empty')
      turn(source, 'unread', () => append('unread', STATUS_LINE))
      expect(source.facts('empty')!.health).toBeNull()
      expect(source.facts('unread')!.health).toBeNull()
      expect(changes).toHaveLength(4)
    })

    it('tells a change once: a degraded session is not degraded again by its next turn', () => {
      const source = watched()
      register(source, 'a')

      turn(source, 'a')
      turn(source, 'a')
      turn(source, 'a', () => append('a', STATUS_LINE))

      // Still the first reason: the session was never healthy in between.
      expect(reasons()).toEqual(['log-empty'])
      expect(source.facts('a')).toMatchObject({
        turnsCompleted: 3,
        health: { reason: 'log-empty', at: START + 3_000 },
        timesDegraded: 1
      })
    })

    it('can become degraded again after it recovered', () => {
      const source = watched({ follower: { hardCapBytes: 8 * 1024 } })
      register(source, 'a')
      turn(source, 'a')
      append('a', STREAMING)
      clock.advance(ACTIVE)

      append('a', ...Array.from({ length: 6 }, () => NOT_ENTRIES[0]))
      clock.advance(ACTIVE)

      expect(reasons()).toEqual(['log-empty', null, 'hard-cap'])
      expect(source.facts('a')!.timesDegraded).toBe(2)
    })

    it('tells every listener, whatever one of them does, until it is taken off', () => {
      const viaDeps: ClaudeDebugLogHealthChange[] = []
      const source = watched({ onHealthChange: (change) => viaDeps.push(change) })
      const late: ClaudeDebugLogHealthChange[] = []
      source.onHealthChange(() => {
        throw new Error('a listener in trouble')
      })
      const off = source.onHealthChange((change) => late.push(change))
      register(source, 'a')
      register(source, 'b')

      turn(source, 'a')
      off()
      turn(source, 'b')

      expect(changes.map((change) => change.sessionId)).toEqual(['a', 'b'])
      expect(viaDeps.map((change) => change.sessionId)).toEqual(['a', 'b'])
      expect(late.map((change) => change.sessionId)).toEqual(['a'])
      // The log is followed all the same.
      append('a', STREAMING)
      clock.advance(ACTIVE)
      expect(submitted).toHaveLength(1)
    })

    it('judges only a session it follows', () => {
      const source = watched()
      register(source, 'a')

      expect(source.turnCompleted('nobody')).toBe(false)
      expect(source.turnCompleted('a')).toBe(true)
      source.unregister('a')
      expect(source.turnCompleted('a')).toBe(false)
      expect(reasons()).toEqual(['log-empty'])
    })

    it('says nothing about what shutting down finds', () => {
      const source = watched({ follower: { hardCapBytes: 8 * 1024 } })
      register(source, 'a')
      append('a', ...Array.from({ length: 6 }, () => NOT_ENTRIES[0]))

      source.dispose()

      expect(changes).toEqual([])
    })

    it("logs nothing of its own: the warning is the listener's", () => {
      const source = watched()
      register(source, 'a')
      turn(source, 'a', () => append('a', STATUS_LINE, RENAMED_ENTRY))

      expect(logged.filter((entry) => !entry.startsWith('debug Following'))).toEqual([])
      source.unregister('a')
      expect(logged.at(-1)).toContain('"health":"unparsed-responses"')
    })
  })

  describe('performance counters (T20)', () => {
    /** A session id that would stand out in a record. */
    const SESSION = 'session-in-code-mode'
    /** A second one. */
    const OTHER = 'another-session-in-code-mode'
    /** The SDK's one-line report of a successful response: no headers, no entry. */
    const STATUS_LINE = NOT_ENTRIES[2]
    /** A response entry the parser does not know. */
    const RENAMED_ENTRY = STREAMING.replace('response start', 'response begin')
    /** A response entry cut off inside its headers: it starts like one and cannot be read. */
    const CUT_OFF = STREAMING.slice(0, 700)
    const HARD_CAP = 8 * 1024

    const WINDOW_KEYS = [
      'bytesRead',
      'checkMaxMs',
      'checkTotalMs',
      'checks',
      'degraded',
      'entriesParsed',
      'parseFailures',
      'passMaxMs',
      'passTotalMs',
      'passes',
      'rotations',
      'sessions'
    ]
    const CAUSES = ['own', 'replaced', 'removed', 'truncated']
    const REASONS = ['log-empty', 'unparsed-responses', 'hard-cap', 'unsafe-file']
    const DETAILS = ['symlink', 'not-regular-file', 'foreign-owner']

    /** Whether performance logging is on; a test switches it. */
    let logging: boolean
    /** Times the counters' clock was read. Every reading moves it by half a millisecond. */
    let clockReads: number
    /** The records handed to the performance log, in order. */
    let records: Array<{ kind: string; data: ClaudeDebugLogPerfEvent }>
    /** Every value of the gauge a test read. */
    let windows: ClaudeDebugLogPerfWindow[]

    beforeEach(() => {
      logging = true
      clockReads = 0
      records = []
      windows = []
    })

    afterEach(() => {
      expectNumbersAndReasonsOnly()
    })

    /**
     * Verification 3 of the ticket, for whatever a test produced: a gauge value is twelve
     * numbers, a record is an event with a code or two, and nothing of a log line, of a path,
     * of an organization or of a session's name is in either.
     */
    function expectNumbersAndReasonsOnly(): void {
      for (const window of windows) {
        expect(Object.keys(window).sort()).toEqual(WINDOW_KEYS)
        for (const value of Object.values(window)) {
          expect(typeof value).toBe('number')
          expect(Number.isFinite(value) && value >= 0).toBe(true)
        }
      }
      for (const { kind, data } of records) {
        expect(kind).toBe('claude-debug-log')
        const { event, ...rest } = data as Record<string, unknown>
        if (event === 'rotated') {
          expect(Object.keys(rest)).toEqual(['cause'])
          expect(CAUSES).toContain(rest.cause)
        } else {
          expect(event).toBe('degraded')
          expect(REASONS).toContain(rest.reason)
          if (rest.reason === 'unsafe-file') {
            expect(Object.keys(rest).sort()).toEqual(['detail', 'reason'])
            expect(DETAILS).toContain(rest.detail)
          } else {
            expect(Object.keys(rest)).toEqual(['reason'])
          }
        }
      }
      const output = JSON.stringify({ records, windows })
      const found = written.flatMap(rawPieces).filter((piece) => output.includes(piece))
      // Counted, not shown: a failure must not print the piece either.
      expect(found.length).toBe(0)
      for (const secret of [dir, ORG_A, ORG_B, SESSION, OTHER, 'usage.log']) {
        expect(output.includes(secret)).toBe(false)
      }
    }

    /** A source with the real counters, on a clock that moves 0.5 ms each time it is read. */
    function counted(deps: Partial<ClaudeDebugLogUsageSourceDeps> = {}): {
      source: ClaudeDebugLogUsageSource
      /** Read the gauge, as the performance logger does for a sample. */
      take: () => ClaudeDebugLogPerfWindow
    } {
      const counters = new ClaudeDebugLogUsagePerfCounters({
        isEnabled: () => logging,
        record: (kind, data) => records.push({ kind, data }),
        now: () => {
          clockReads += 1
          return clockReads * 0.5
        }
      })
      const source = makeSource({ perf: counters, ...deps })
      return {
        source,
        take: () => {
          const window = counters.takeWindow(source.stats().sessions)
          windows.push(window)
          return window
        }
      }
    }

    const nothing = (sessions: number): ClaudeDebugLogPerfWindow => ({
      sessions,
      passes: 0,
      checks: 0,
      bytesRead: 0,
      entriesParsed: 0,
      parseFailures: 0,
      checkTotalMs: 0,
      checkMaxMs: 0,
      passTotalMs: 0,
      passMaxMs: 0,
      rotations: 0,
      degraded: 0
    })

    const bytesOf = (...lines: string[]): number =>
      lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)

    /** One turn of a session: the prompt is submitted, `during` happens, the Stop hook fires. */
    function turn(source: ClaudeDebugLogUsageSource, session: string, during?: () => void): void {
      source.setTurnInProgress(session, true)
      during?.()
      clock.advance(3_000)
      source.setTurnInProgress(session, false)
      source.turnCompleted(session)
    }

    describe('while performance logging is on', () => {
      it('counts what a session that makes requests costs and finds: sessions, passes, checks, bytes, entries, parse failures and how long it took', () => {
        const { source, take } = counted()
        register(source, SESSION)

        // A request, its response, a response cut off inside its headers, another response.
        append(SESSION, NOT_ENTRIES[0], STREAMING, CUT_OFF, FABLE)
        clock.advance(ACTIVE)
        // And a pass that finds nothing new.
        clock.advance(ACTIVE)

        expect(take()).toEqual({
          sessions: 1,
          passes: 2,
          checks: 2,
          bytesRead: statSync(logPath(SESSION)).size,
          entriesParsed: 2,
          parseFailures: 1,
          // Half a millisecond per reading of the clock: a check is one step long, and a pass
          // with one check in it three.
          checkTotalMs: 1,
          checkMaxMs: 0.5,
          passTotalMs: 3,
          passMaxMs: 1.5,
          rotations: 0,
          degraded: 0
        })
        // The same numbers the source keeps for itself.
        expect(source.stats()).toMatchObject({ sessions: 1, passes: 2, checks: 2 })
        expect(source.facts(SESSION)).toMatchObject({
          bytesRead: bytesOf(NOT_ENTRIES[0], STREAMING, CUT_OFF, FABLE),
          entriesParsed: 2,
          parseFailures: 1
        })
        expect(submitted.length).toBe(2)
        expect(records).toEqual([])
      })

      it('gives each sample the time since the one before, and the sessions registered now', () => {
        const { source, take } = counted()
        register(source, SESSION)
        append(SESSION, STREAMING)
        clock.advance(ACTIVE)
        expect(take()).toMatchObject({ sessions: 1, passes: 1, checks: 1, entriesParsed: 1 })

        register(source, OTHER)
        append(SESSION, FABLE)
        clock.advance(2 * ACTIVE)

        expect(take()).toMatchObject({
          sessions: 2,
          passes: 2,
          checks: 4,
          bytesRead: bytesOf(FABLE),
          entriesParsed: 1,
          parseFailures: 0
        })
        expect(take()).toEqual(nothing(2))
      })

      it('times a pass over several sessions as a whole, and each of its checks', () => {
        const { source, take } = counted()
        for (const session of [SESSION, OTHER, 'a-third-session-in-code-mode']) {
          register(source, session)
        }

        clock.advance(ACTIVE)

        // Eight readings of the clock: around the pass, and around each of its three checks.
        expect(clockReads).toBe(8)
        expect(take()).toMatchObject({
          sessions: 3,
          passes: 1,
          checks: 3,
          checkTotalMs: 1.5,
          checkMaxMs: 0.5,
          passTotalMs: 3.5,
          passMaxMs: 3.5
        })
      })

      it('counts the checks made outside a pass: when a turn ends, when it completes, on request, and the final read of a session that ends', () => {
        const { source, take } = counted()
        register(source, SESSION)
        register(source, OTHER)

        source.setTurnInProgress(SESSION, true)
        append(SESSION, STREAMING)
        source.setTurnInProgress(SESSION, false)
        source.turnCompleted(SESSION)
        source.checkNow()
        source.checkNow(OTHER)
        append(SESSION, FABLE, CUT_OFF)
        source.unregister(SESSION)

        expect(take()).toEqual({
          sessions: 1,
          passes: 0,
          checks: 6,
          bytesRead: bytesOf(STREAMING, FABLE, CUT_OFF),
          entriesParsed: 2,
          parseFailures: 1,
          checkTotalMs: 3,
          checkMaxMs: 0.5,
          passTotalMs: 0,
          passMaxMs: 0,
          rotations: 0,
          degraded: 0
        })
        expect(source.stats().checks).toBe(6)
      })

      describe('rotations', () => {
        const rotations: Array<{
          cause: string
          deps?: Partial<ClaudeDebugLogUsageSourceDeps>
          rotate: () => void
        }> = [
          {
            // The follower retires a log it has read to its end once it is past this size:
            // the first read does it.
            cause: 'own',
            deps: { follower: { rotateBytes: 256 } },
            rotate: () => undefined
          },
          {
            // The CLI's own rotation: the log is moved aside and written anew.
            cause: 'replaced',
            rotate: () => {
              renameSync(logPath(SESSION), logPath(SESSION) + '.1')
              append(SESSION, FABLE)
            }
          },
          { cause: 'removed', rotate: () => unlinkSync(logPath(SESSION)) },
          {
            cause: 'truncated',
            rotate: () => {
              truncateSync(logPath(SESSION), 0)
              append(SESSION, NOT_ENTRIES[0])
            }
          }
        ]

        for (const { cause, deps, rotate } of rotations) {
          it(`writes a record when a log is rotated (${cause}), and counts it`, () => {
            const { source, take } = counted(deps)
            register(source, SESSION)
            append(SESSION, STREAMING)
            clock.advance(ACTIVE)

            rotate()
            clock.advance(ACTIVE)

            expect(records).toEqual([
              { kind: 'claude-debug-log', data: { event: 'rotated', cause } }
            ])
            expect(source.facts(SESSION)!.follower.rotations).toBe(1)
            expect(take()).toMatchObject({ rotations: 1, degraded: 0 })
          })
        }
      })

      describe('degraded events', () => {
        it('writes a record when a turn completes and the log never appeared (log-empty)', () => {
          const { source, take } = counted()
          register(source, SESSION)

          turn(source, SESSION)

          expect(records).toEqual([
            { kind: 'claude-debug-log', data: { event: 'degraded', reason: 'log-empty' } }
          ])
          expect(take()).toMatchObject({ degraded: 1, rotations: 0, bytesRead: 0 })
        })

        it('writes a record when responses were logged and none could be read (unparsed-responses)', () => {
          const { source, take } = counted()
          register(source, SESSION)

          turn(source, SESSION, () => append(SESSION, STATUS_LINE, RENAMED_ENTRY, CUT_OFF))

          expect(records).toEqual([
            { kind: 'claude-debug-log', data: { event: 'degraded', reason: 'unparsed-responses' } }
          ])
          expect(take()).toMatchObject({ degraded: 1, entriesParsed: 0, parseFailures: 1 })
        })

        it('writes a record when the follower deletes a log past the hard cap (hard-cap)', () => {
          const { source, take } = counted({ follower: { hardCapBytes: HARD_CAP } })
          register(source, SESSION)
          append(SESSION, STREAMING)
          clock.advance(ACTIVE)

          append(SESSION, ...Array.from({ length: 6 }, () => NOT_ENTRIES[0]))
          clock.advance(ACTIVE)

          expect(records).toEqual([
            { kind: 'claude-debug-log', data: { event: 'degraded', reason: 'hard-cap' } }
          ])
          expect(take()).toMatchObject({ degraded: 1, entriesParsed: 1 })
        })

        posixOnly(
          'writes a record when the follower refuses an unsafe file, with what was wrong with it (unsafe-file)',
          () => {
            const { source, take } = counted()
            mkdirSync(join(dir, SESSION))
            writeFileSync(join(dir, 'elsewhere.log'), '')
            symlinkSync(join(dir, 'elsewhere.log'), logPath(SESSION))
            register(source, SESSION)

            clock.advance(1_000)

            expect(records).toEqual([
              {
                kind: 'claude-debug-log',
                data: { event: 'degraded', reason: 'unsafe-file', detail: 'symlink' }
              }
            ])
            expect(take()).toMatchObject({ degraded: 1, passes: 4 })
          }
        )

        it('records a signal of the follower for a session that is degraded already', () => {
          const { source, take } = counted({ follower: { hardCapBytes: HARD_CAP } })
          register(source, SESSION)
          turn(source, SESSION)

          mkdirSync(join(dir, SESSION), { recursive: true })
          writeFileSync(logPath(SESSION), '')
          truncateSync(logPath(SESSION), HARD_CAP + 1)
          clock.advance(IDLE)

          expect(records.map((record) => record.data)).toEqual([
            { event: 'degraded', reason: 'log-empty' },
            { event: 'degraded', reason: 'hard-cap' }
          ])
          // Two events, one degraded session.
          expect(source.facts(SESSION)).toMatchObject({
            timesDegraded: 1,
            health: { reason: 'log-empty' }
          })
          expect(take()).toMatchObject({ degraded: 2 })
        })

        it('records a session once for as long as it stays degraded, nothing when it recovers, and again when it is degraded again', () => {
          const { source, take } = counted()
          register(source, SESSION)
          turn(source, SESSION)
          turn(source, SESSION)
          expect(records.length).toBe(1)

          append(SESSION, STREAMING)
          clock.advance(IDLE)
          expect(source.facts(SESSION)!.health).toBeNull()
          expect(records.length).toBe(1)

          // Everything it ever read is forgotten with a new log for the same session.
          source.register({ sessionId: SESSION, logPath: logPath(OTHER) })
          turn(source, SESSION)
          expect(records.map((record) => record.data)).toEqual([
            { event: 'degraded', reason: 'log-empty' },
            { event: 'degraded', reason: 'log-empty' }
          ])
          expect(take()).toMatchObject({ degraded: 2, entriesParsed: 1 })
        })

        it('says nothing about what shutting down finds', () => {
          const { source, take } = counted({ follower: { hardCapBytes: HARD_CAP } })
          register(source, SESSION)
          append(SESSION, ...Array.from({ length: 6 }, () => NOT_ENTRIES[0]))

          source.dispose()

          expect(records).toEqual([])
          expect(take()).toEqual(nothing(0))
        })
      })

      it('records numbers and reasons only: no header value, no organization, no path, no session and nothing else of a line', () => {
        // A cap the lines of this test stay under, until the log is blown up past it.
        const cap = 64 * 1024
        const { source, take } = counted({ follower: { hardCapBytes: cap } })
        register(source, SESSION)
        register(source, OTHER)
        append(
          SESSION,
          NOT_ENTRIES[0],
          STREAMING,
          FABLE,
          PLAN_LIMIT,
          NOT_FOUND,
          CUT_OFF,
          STATUS_LINE
        )
        clock.advance(ACTIVE)
        renameSync(logPath(SESSION), logPath(SESSION) + '.1')
        append(SESSION, RENAMED_ENTRY)
        clock.advance(ACTIVE)
        turn(source, OTHER, () => append(OTHER, STATUS_LINE, RENAMED_ENTRY))
        truncateSync(logPath(SESSION), cap + 1)
        clock.advance(ACTIVE)
        source.unregister(SESSION)

        const window = take()
        expect(window).toMatchObject({ sessions: 1, entriesParsed: 4, parseFailures: 1 })
        expect(window.bytesRead).toBeGreaterThan(0)
        expect(window.rotations).toBeGreaterThan(0)
        expect(records.map((record) => record.data)).toEqual(
          expect.arrayContaining([
            { event: 'rotated', cause: 'replaced' },
            { event: 'degraded', reason: 'unparsed-responses' },
            { event: 'degraded', reason: 'hard-cap' }
          ])
        )
        // The readings went where they belong, organization and all: only not to the counters.
        expect(submitted.map((observation) => observation.organizationUuid)).toEqual([
          ORG_A,
          ORG_B,
          ORG_A
        ])
        expectNumbersAndReasonsOnly()
      })
    })

    describe('while performance logging is off', () => {
      /** Everything the counters hear about while logging is on: requests, a rotation, both kinds of degraded event. */
      function eventful(source: ClaudeDebugLogUsageSource, session: string) {
        register(source, session)
        append(session, NOT_ENTRIES[0], STREAMING, CUT_OFF)
        clock.advance(ACTIVE)
        source.setTurnInProgress(session, true)
        renameSync(logPath(session), logPath(session) + '.1')
        append(session, STATUS_LINE)
        clock.advance(ACTIVE)
        source.setTurnInProgress(session, false)
        source.turnCompleted(session)
        source.checkNow()
        truncateSync(logPath(session), HARD_CAP + 1)
        clock.advance(ACTIVE)
        append(session, FABLE)
        const facts = source.unregister(session)!
        // It all happened.
        expect(facts).toMatchObject({
          entriesParsed: 2,
          parseFailures: 1,
          degradedSignals: 1,
          timesDegraded: 1
        })
        expect(facts.follower.rotations).toBeGreaterThan(0)
        return facts
      }

      it('asks whether it is on and does nothing else: no clock is read, nothing is counted, nothing is written', () => {
        const calls: string[] = []
        const note = (name: string) => (): void => {
          calls.push(name)
        }
        const perf: ClaudeDebugLogUsagePerf = {
          isEnabled: () => {
            calls.push('isEnabled')
            return false
          },
          now: () => {
            calls.push('now')
            return 0
          },
          pass: note('pass'),
          check: note('check'),
          rotated: note('rotated'),
          degraded: note('degraded')
        }
        const source = makeSource({ perf, follower: { hardCapBytes: HARD_CAP } })

        eventful(source, SESSION)
        source.dispose()

        expect(calls.length).toBeGreaterThan(0)
        expect([...new Set(calls)]).toEqual(['isEnabled'])
      })

      it('leaves the counters empty and the performance log untouched', () => {
        logging = false
        const { source, take } = counted({ follower: { hardCapBytes: HARD_CAP } })

        eventful(source, SESSION)

        expect(clockReads).toBe(0)
        expect(records).toEqual([])
        expect(take()).toEqual(nothing(0))
      })

      it('costs not one fs call more than a source without counters, and reads the same', () => {
        logging = false
        const plain = countingFs()
        const withCounters = countingFs()

        const factsPlain = eventful(
          makeSource({ follower: { fs: plain.fs, hardCapBytes: HARD_CAP } }),
          SESSION
        )
        const factsWithCounters = eventful(
          counted({ follower: { fs: withCounters.fs, hardCapBytes: HARD_CAP } }).source,
          OTHER
        )

        expect(plain.total()).toBeGreaterThan(0)
        for (const name of FS_CALLS) expect(withCounters.of(name)).toBe(plain.of(name))
        expect(factsWithCounters.follower).toEqual(factsPlain.follower)
        expect(clockReads).toBe(0)
      })

      it('counts from the moment it is switched on, and not what happened before', () => {
        logging = false
        const { source, take } = counted()
        register(source, SESSION)
        append(SESSION, STREAMING, CUT_OFF)
        clock.advance(2 * ACTIVE)

        logging = true
        append(SESSION, FABLE)
        clock.advance(ACTIVE)

        expect(take()).toEqual({
          sessions: 1,
          passes: 1,
          checks: 1,
          bytesRead: bytesOf(FABLE),
          entriesParsed: 1,
          parseFailures: 0,
          checkTotalMs: 0.5,
          checkMaxMs: 0.5,
          passTotalMs: 1.5,
          passMaxMs: 1.5,
          rotations: 0,
          degraded: 0
        })
        expect(source.stats()).toMatchObject({ passes: 3, checks: 3 })
      })

      it('drops what no sample took when it is switched off, so that it is not reported later as new', () => {
        const { source, take } = counted()
        register(source, SESSION)
        append(SESSION, STREAMING)
        clock.advance(ACTIVE)

        logging = false
        clock.advance(ACTIVE)
        logging = true

        expect(take()).toEqual(nothing(1))
        clock.advance(ACTIVE)
        expect(take()).toMatchObject({ passes: 1, checks: 1, bytesRead: 0 })
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

  // PF-4 is a budget for the main thread: it holds with the performance counters measuring too (T20).
  for (const counting of [false, true]) {
    it(`checks 50 registered sessions in under 2 ms when nothing changed and under 10 ms when every file changed${counting ? ', with performance logging on' : ''}`, () => {
      const SESSIONS = 50
      const perf = counting
        ? new ClaudeDebugLogUsagePerfCounters({ isEnabled: () => true, record: () => undefined })
        : undefined
      // The pass is driven by hand, so that it can be timed on its own.
      let fire: (() => void) | null = null
      let observations = 0
      const source = new ClaudeDebugLogUsageSource({
        submit: () => {
          observations += 1
        },
        perf,
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
        perf?.takeWindow(SESSIONS)

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

        if (perf) {
          // The counters saw the same passes from the inside.
          const window = perf.takeWindow(source.stats().sessions)
          expect(window).toMatchObject({
            sessions: SESSIONS,
            passes: 360,
            checks: 360 * SESSIONS,
            bytesRead: 60 * SESSIONS * Buffer.byteLength(ONE_REQUEST),
            entriesParsed: 60 * SESSIONS,
            parseFailures: 0,
            rotations: 0,
            degraded: 0
          })
          const outside = [...unchanged, ...changed]
          const total = outside.reduce((sum, ms) => sum + ms, 0)
          expect(window.checkTotalMs).toBeGreaterThan(0)
          expect(window.checkTotalMs).toBeLessThanOrEqual(window.passTotalMs)
          // To the rounding of a microsecond.
          expect(window.passTotalMs).toBeLessThanOrEqual(total + 0.001)
          expect(window.passMaxMs).toBeLessThanOrEqual(Math.max(...outside) + 0.001)
          expect(window.checkMaxMs).toBeLessThanOrEqual(window.passMaxMs)
        }
      } finally {
        source.dispose()
      }
    }, 60_000)
  }
})
