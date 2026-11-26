// @vitest-environment node
/**
 * From a line in a session's debug log to the `usage:claudeLive` event (Code
 * Mode T16): the app's own source (`getClaudeDebugLogUsageSource`) feeding the
 * real live updater, which is wired to a fake database (the organization
 * stored per account), a fake account store and a fake event publisher, as in
 * `claude-usage-live.organization.test.ts`.
 *
 * The logger is the real one. It writes to a temporary directory, at debug
 * level, and every test ends by searching what it wrote (and what went to the
 * console) for pieces of the lines the test put in a debug log.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Before any import can log: the logger picks its directory on first use, and
// that is ~/.hive/logs, the developer's own. The home directory is pointed at a
// temporary one for this file.
const env = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const keys = ['HOME', 'USERPROFILE', 'NODE_ENV'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const home = mkdtempSync(join(tmpdir(), 'debug-log-usage-app-log-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  // Debug lines are written too, and echoed to the console.
  process.env.NODE_ENV = 'development'
  return { home, logDir: join(home, '.hive', 'logs'), previous }
})

interface Row {
  id: string
  provider: string
  email: string
  last_usage_json: string | null
  org_uuid: string | null
}

const dbMocks = vi.hoisted(() => ({ rows: new Map<string, Row>() }))

const storeMocks = vi.hoisted(() => ({
  managed: new Set<string>(),
  listClaudeAccountTokenFingerprints: vi.fn(async () => []),
  readClaudeLiveTokenFingerprint: vi.fn(async () => null as string | null),
  isClaudeAccountManaged: vi.fn(async (email: string) => storeMocks.managed.has(email)),
  readClaudeAccountIndexUpdatedAt: vi.fn(async () => 0),
  readClaudeLiveIdentityCached: vi.fn(async () => ({
    email: null as string | null,
    uuid: null as string | null
  })),
  readClaudeLiveRawBlob: vi.fn(async () => null as string | null),
  addClaudeAccount: vi.fn(async () => '1'),
  rememberClaudeAccountUuid: vi.fn(async () => false)
}))

const publisherMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn(async () => true)
}))

vi.mock('../../../db', async () => {
  const types = await vi.importActual<typeof import('../../../db/types')>('../../../db/types')
  return {
    normalizeOrgUuid: types.normalizeOrgUuid,
    getDatabase: () => ({
      getSavedUsageAccountByProviderEmail: (_provider: string, email: string) =>
        dbMocks.rows.get(email) ?? null,
      upsertSavedUsageAccount: () => {
        throw new Error('no row should be created in these tests')
      },
      updateSavedUsageAccountLiveUsage: (id: string, lastUsageJson: string) => {
        for (const row of dbMocks.rows.values()) {
          if (row.id === id) {
            row.last_usage_json = lastUsageJson
            return row
          }
        }
        return null
      },
      getSavedUsageAccountOrganizations: (provider: string) =>
        [...dbMocks.rows.values()]
          .filter((row) => row.provider === provider)
          .map(({ id, email, org_uuid }) => ({ id, email, org_uuid }))
    })
  }
})

vi.mock('../../account-store-claude', () => storeMocks)
vi.mock('../../../desktop/backend-event-publisher', () => publisherMocks)

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_LIVE_USAGE_CHANNEL,
  isClaudeLiveUsagePayload,
  type ClaudeLiveUsagePayload
} from '@shared/types/claude-live-usage'
import type { UsageData } from '@shared/types/usage'
import {
  getClaudeUsageLiveUpdater,
  setClaudeOrganizationsNeededHandler,
  __resetClaudeUsageLiveUpdaterForTests
} from '../../claude-api-proxy/claude-usage-live'
import { getLogDir } from '../../logger'
import { getPerfLogger, perfLog, type PerfLogger } from '../../perf-logging/perf-logger'
import {
  disposeClaudeDebugLogUsageSource,
  getClaudeDebugLogUsageSource,
  __resetClaudeDebugLogUsageSourceForTests
} from '../claude-debug-log-usage'
import { parseClaudeDebugLogLine } from '../claude-debug-log-entry-parser'

const FIXTURES = join(__dirname, '..', '__fixtures__')

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
}

/** A streaming 200 billed to ORG_A at 12:39:34.892: 5h 3%, 7d 37%. */
const STREAMING = fixtureLines('response-start-streaming.txt')[0]
const STREAMING_AT = Date.UTC(2026, 10, 17, 12, 39, 34, 892)
/** A Fable-model 200 billed to ORG_B at 12:39:34.901: 7d 36%, Fable bucket 71%. */
const FABLE = fixtureLines('response-start-fable.txt')[0]
const FABLE_AT = Date.UTC(2026, 10, 17, 12, 39, 34, 901)
const NOT_FOUND = fixtureLines('response-error-404.txt')[0]
const NOT_ENTRIES = fixtureLines('not-entries.txt')

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const ORG_B = '00000000-0000-4000-8000-00000000000b'

const ME = 'me@example.com'
const OTHER = 'other@example.com'
const UUID_ME = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'

/** The same response, logged at another moment. */
function at(line: string, time: number): string {
  return new Date(time).toISOString() + line.slice('2026-01-01T00:00:00.000Z'.length)
}

function seed(email: string, orgUuid: string | null): void {
  storeMocks.managed.add(email)
  dbMocks.rows.set(email, {
    id: `row-${email}`,
    provider: 'anthropic',
    email,
    last_usage_json: null,
    org_uuid: orgUuid
  })
}

const events = (): Array<[string, ClaudeLiveUsagePayload]> =>
  publisherMocks.publishDesktopBackendEvent.mock.calls as unknown as Array<
    [string, ClaudeLiveUsagePayload]
  >

const published = (): ClaudeLiveUsagePayload[] => events().map(([, payload]) => payload)

const storedUsage = (email: string): UsageData | null => {
  const json = dbMocks.rows.get(email)?.last_usage_json
  return json ? (JSON.parse(json) as UsageData) : null
}

const settled = (): Promise<void> => getClaudeUsageLiveUpdater().settle()

/**
 * Pieces of a line that would give it away in a log: its header names, its ids, its address,
 * its timestamp. The usage values the app extracts on purpose are left out: they are what the
 * updater is for, and it names one of them (the representative claim) in a debug line of its own.
 */
function rawPieces(line: string): string[] {
  const parsed = parseClaudeDebugLogLine(line)
  const extracted = new Set(parsed.kind === 'entry' ? Object.values(parsed.entry.headers) : [])
  // The line's time is extracted too, and a line stamped "now" shares it with the app log's own.
  extracted.add(line.slice(0, '2026-01-01T00:00:00.000Z'.length))
  return line.split(/[\s'"`{},\\]+/).filter((piece) => piece.length >= 12 && !extracted.has(piece))
}

let dir: string
/** Every line a test wrote to a session's debug log. */
let written: string[]
let consoleOutput: string[]

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

function appLog(): string {
  return readdirSync(env.logDir)
    .map((name) => readFileSync(join(env.logDir, name), 'utf8'))
    .join('\n')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'debug-log-usage-'))
  written = []
  consoleOutput = []
  for (const method of ['log', 'debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(
        args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
      )
    })
  }
  dbMocks.rows.clear()
  storeMocks.managed.clear()
  publisherMocks.publishDesktopBackendEvent.mockClear()
  storeMocks.readClaudeLiveIdentityCached.mockResolvedValue({ email: ME, uuid: UUID_ME })
  storeMocks.readClaudeAccountIndexUpdatedAt.mockResolvedValue(0)
})

afterEach(async () => {
  await settled()
  __resetClaudeDebugLogUsageSourceForTests()
  __resetClaudeUsageLiveUpdaterForTests()
  rmSync(dir, { recursive: true, force: true })

  // SEC-5: search the app's log, and the console, for anything out of a debug log.
  expect(getLogDir()).toBe(env.logDir)
  const everything = appLog() + '\n' + consoleOutput.join('\n')
  // The search looks in the right place: this is where the source logs.
  expect(everything).toContain('[ClaudeDebugLogUsage]')
  const pieces = new Set(written.flatMap(rawPieces))
  expect(pieces.size).toBeGreaterThan(0)
  const found = [...pieces].filter((piece) => everything.includes(piece))
  // Counted, not shown: a failure must not print the piece either.
  expect(found.length).toBe(0)
  for (const marker of ['console.log:', '[log_', 'response start', 'anthropic-ratelimit']) {
    expect(everything.includes(marker)).toBe(false)
  }

  vi.restoreAllMocks()
  vi.clearAllMocks()
})

afterAll(() => {
  rmSync(env.home, { recursive: true, force: true })
  for (const [key, value] of Object.entries(env.previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('debug-log usage through the app source and the live updater', () => {
  it('turns a response entry appended to a registered session log into one live usage event for the account of its organization, at the entry time', async () => {
    seed(ME, ORG_A)
    seed(OTHER, ORG_B)
    const source = getClaudeDebugLogUsageSource()
    expect(getClaudeDebugLogUsageSource()).toBe(source)
    source.register({ sessionId: 'session-1', logPath: logPath('session-1') })

    // What one request leaves in the log, in the CLI's order.
    append('session-1', NOT_ENTRIES[0], STREAMING, NOT_ENTRIES[2], NOT_ENTRIES[6])
    source.checkNow()
    await settled()

    expect(events()).toHaveLength(1)
    const [channel, payload] = events()[0]
    expect(channel).toBe(CLAUDE_LIVE_USAGE_CHANNEL)
    expect(payload).toMatchObject({
      provider: 'anthropic',
      accountId: `row-${ME}`,
      email: ME,
      accountUuid: null,
      isLiveAccount: true,
      // The time in the log line (three days before this test runs), not the time it was read.
      observedAt: STREAMING_AT,
      // Whose log the reading came from: the usage UI takes "Live" back by it (T18).
      sessionId: 'session-1'
    })
    expect(isClaudeLiveUsagePayload(payload)).toBe(true)
    expect(payload.usage.seven_day?.utilization).toBe(37)
    expect(payload.usage.five_hour?.utilization).toBe(3)
    expect(storedUsage(ME)?.seven_day?.utilization).toBe(37)
    expect(storedUsage(OTHER)).toBeNull()
    // The debug log shows no credential: nothing about it touches the Keychain.
    expect(storeMocks.listClaudeAccountTokenFingerprints).not.toHaveBeenCalled()
    expect(storeMocks.readClaudeLiveTokenFingerprint).not.toHaveBeenCalled()
    source.unregister('session-1')
  })

  it('publishes on its own schedule, without being asked to check', async () => {
    seed(ME, ORG_A)
    const source = getClaudeDebugLogUsageSource()
    source.register({ sessionId: 'session-1', logPath: logPath('session-1') })
    source.setTurnInProgress('session-1', true)

    const stamped = Date.now()
    append('session-1', at(STREAMING, stamped))

    await vi.waitFor(() => expect(published()).toHaveLength(1), { timeout: 5_000, interval: 20 })
    expect(published()[0]).toMatchObject({ email: ME, observedAt: stamped })
    source.unregister('session-1')
  })

  it('publishes nothing for an error entry without usage headers or for unrelated lines', async () => {
    seed(ME, ORG_A)
    const learner = vi.fn()
    setClaudeOrganizationsNeededHandler(learner)
    const source = getClaudeDebugLogUsageSource()
    source.register({ sessionId: 'session-1', logPath: logPath('session-1') })

    append('session-1', ...NOT_ENTRIES, NOT_FOUND)
    source.checkNow()
    await settled()
    const facts = source.unregister('session-1')
    await settled()

    expect(events()).toHaveLength(0)
    expect(storedUsage(ME)).toBeNull()
    expect(learner).not.toHaveBeenCalled()
    expect(facts).toMatchObject({
      linesRead: NOT_ENTRIES.length + 1,
      entriesParsed: 1,
      observations: 0
    })
  })

  it('updates only their own accounts for two sessions on different accounts', async () => {
    seed(ME, ORG_A)
    seed(OTHER, ORG_B)
    const source = getClaudeDebugLogUsageSource()
    source.register({ sessionId: 'session-me', logPath: logPath('session-me') })
    source.register({ sessionId: 'session-other', logPath: logPath('session-other') })

    append('session-me', STREAMING)
    append('session-other', FABLE)
    source.checkNow()
    await settled()

    expect(published()).toHaveLength(2)
    const mine = published().find((payload) => payload.email === ME)!
    const theirs = published().find((payload) => payload.email === OTHER)!
    expect(mine).toMatchObject({ isLiveAccount: true, observedAt: STREAMING_AT })
    expect(theirs).toMatchObject({ isLiveAccount: false, liveEmail: ME, observedAt: FABLE_AT })
    // Each row holds its own reading and nothing of the other's.
    expect(storedUsage(ME)?.seven_day?.utilization).toBe(37)
    expect(storedUsage(ME)?.five_hour?.utilization).toBe(3)
    expect(storedUsage(OTHER)?.seven_day?.utilization).toBe(36)
    expect(storedUsage(OTHER)?.five_hour ?? null).toBeNull()
    expect(JSON.stringify(storedUsage(ME))).not.toContain('71')
    expect(JSON.stringify(storedUsage(OTHER))).toContain('71')
    expect(source.facts('session-me')).toMatchObject({ observations: 1 })
    expect(source.facts('session-other')).toMatchObject({ observations: 1 })
    source.unregister('session-me')
    source.unregister('session-other')
  })

  it('publishes what was written just before the session was unregistered', async () => {
    seed(ME, ORG_A)
    const source = getClaudeDebugLogUsageSource()
    source.register({ sessionId: 'session-1', logPath: logPath('session-1') })

    append('session-1', STREAMING)
    const facts = source.unregister('session-1')
    await settled()

    expect(published().map((payload) => [payload.email, payload.observedAt])).toEqual([
      [ME, STREAMING_AT]
    ])
    expect(facts).toMatchObject({ observations: 1, lastObservationAt: STREAMING_AT })
    expect(source.stats()).toMatchObject({ sessions: 0, timerArmed: false })
  })

  it('leaves a reading for an organization no account is mapped to with the updater, which asks for it to be learned', async () => {
    seed(ME, null)
    const learner = vi.fn()
    setClaudeOrganizationsNeededHandler(learner)
    const source = getClaudeDebugLogUsageSource()
    source.register({ sessionId: 'session-1', logPath: logPath('session-1') })

    append('session-1', at(STREAMING, Date.now()))
    source.checkNow()
    await settled()

    expect(events()).toHaveLength(0)
    expect(learner).toHaveBeenCalledTimes(1)
    expect(source.facts('session-1')).toMatchObject({ observations: 1 })
    source.unregister('session-1')
  })

  it('stops everything on dispose', async () => {
    seed(ME, ORG_A)
    const source = getClaudeDebugLogUsageSource()
    source.register({ sessionId: 'session-1', logPath: logPath('session-1') })
    append('session-1', STREAMING)

    disposeClaudeDebugLogUsageSource()
    await settled()

    expect(events()).toHaveLength(0)
    expect(source.stats()).toMatchObject({ sessions: 0, timerArmed: false })
    // The log check of this file needs a line from the source: a session that ends normally.
    source.register({ sessionId: 'session-2', logPath: logPath('session-2') })
    source.unregister('session-2')
  })
})

describe('performance counters of the app source (T20)', () => {
  const GAUGE_KEYS = [
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

  let perfDir: string
  let logger: PerfLogger

  beforeEach(() => {
    perfDir = mkdtempSync(join(tmpdir(), 'debug-log-usage-perf-'))
    // The process's own performance logger, the one the app source reports to, writing where
    // this test can read it and nowhere else.
    logger = getPerfLogger()
    ;(logger as unknown as { logDir: string }).logDir = perfDir
  })

  afterEach(() => {
    logger.stop()
    rmSync(perfDir, { recursive: true, force: true })
  })

  /** Everything in the performance log, as text. */
  function perfLogText(): string {
    logger.flush()
    return readdirSync(perfDir)
      .map((name) => readFileSync(join(perfDir, name), 'utf8'))
      .join('\n')
  }

  function perfRecords(): Array<Record<string, unknown>> {
    return perfLogText()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  const gaugeOf = (sample: Record<string, unknown>): Record<string, number> =>
    (sample.gauges as Record<string, Record<string, number>>).claudeDebugLog

  /**
   * Two sessions. The first makes requests (two responses that can be read, one that cannot)
   * and has its log rotated by the CLI in between; the second completes a turn without a log.
   * Then the source's own timer makes a pass.
   */
  async function sessionsAtWork(): Promise<ReturnType<typeof getClaudeDebugLogUsageSource>> {
    seed(ME, ORG_A)
    const source = getClaudeDebugLogUsageSource()
    source.register({ sessionId: 'session-1', logPath: logPath('session-1') })
    source.register({ sessionId: 'session-2', logPath: logPath('session-2') })

    append('session-1', NOT_ENTRIES[0], STREAMING, STREAMING.slice(0, 700), NOT_ENTRIES[2])
    source.checkNow('session-1')
    renameSync(logPath('session-1'), logPath('session-1') + '.1')
    append('session-1', NOT_ENTRIES[0], at(STREAMING, STREAMING_AT + 60_000))
    source.checkNow('session-1')
    source.turnCompleted('session-2')

    const passes = source.stats().passes
    await vi.waitFor(() => expect(source.stats().passes).toBeGreaterThan(passes), {
      timeout: 5_000,
      interval: 20
    })
    await settled()
    return source
  }

  it('writes the counters of sessions that make requests to the performance log while performance logging is on, and a record for each rotation and degraded event', async () => {
    logger.start()

    const source = await sessionsAtWork()
    logger.sample()
    const { passes, checks } = source.stats()
    const records = perfRecords()

    // Every counter of the ticket, in the sample the logger takes of all its gauges.
    const samples = records.filter((record) => record.kind === 'sample')
    expect(samples).toHaveLength(1)
    const gauge = gaugeOf(samples[0])
    expect(Object.keys(gauge).sort()).toEqual(GAUGE_KEYS)
    expect(gauge).toMatchObject({
      sessions: 2,
      passes,
      checks,
      bytesRead: written.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0),
      entriesParsed: 2,
      parseFailures: 1,
      rotations: 1,
      degraded: 1
    })
    expect(gauge.passes).toBeGreaterThanOrEqual(1)
    expect(gauge.checks).toBeGreaterThanOrEqual(5)
    expect(gauge.checkTotalMs).toBeGreaterThan(0)
    expect(gauge.checkMaxMs).toBeGreaterThan(0)
    expect(gauge.checkMaxMs).toBeLessThanOrEqual(gauge.checkTotalMs)
    expect(gauge.passTotalMs).toBeGreaterThan(0)
    expect(gauge.passMaxMs).toBeGreaterThan(0)
    expect(gauge.passMaxMs).toBeLessThanOrEqual(gauge.passTotalMs)
    for (const value of Object.values(gauge)) expect(Number.isFinite(value)).toBe(true)

    // The events, each as it happened: what the logger adds to a record, and a code.
    const eventRecords = records.filter((record) => record.kind === 'claude-debug-log')
    expect(eventRecords.map(({ t: _t, pid: _pid, role: _role, ...rest }) => rest)).toEqual([
      { kind: 'claude-debug-log', event: 'rotated', cause: 'replaced' },
      { kind: 'claude-debug-log', event: 'degraded', reason: 'log-empty' }
    ])
    for (const record of eventRecords) {
      expect(typeof record.t).toBe('string')
      expect(record.pid).toBe(process.pid)
    }

    // Numbers and reasons only: no session, no path, no organization in what the source
    // reported, and nothing of a line anywhere in the performance log.
    const reported = JSON.stringify([gauge, ...eventRecords])
    for (const secret of ['session-1', 'session-2', 'usage.log', dir, ORG_A, ORG_B, ME]) {
      expect(reported.includes(secret)).toBe(false)
    }
    const text = perfLogText()
    const pieces = new Set(
      written.flatMap((line) => line.split(/[\s'"`{},\\]+/).filter((piece) => piece.length >= 12))
    )
    expect(pieces.size).toBeGreaterThan(0)
    // Counted, not shown: a failure must not print the piece either.
    expect([...pieces].filter((piece) => text.includes(piece)).length).toBe(0)

    // The next sample starts from nothing.
    expect(gaugeOf(logger.sample())).toMatchObject({
      sessions: 2,
      bytesRead: 0,
      entriesParsed: 0,
      parseFailures: 0,
      rotations: 0,
      degraded: 0
    })
    source.unregister('session-1')
    source.unregister('session-2')
  })

  it('writes nothing to the performance log while performance logging is off, measures nothing, and keeps nothing for the day it is on', async () => {
    const asked = vi.spyOn(perfLog, 'isEnabled')
    const recorded = vi.spyOn(perfLog, 'record')
    const clock = vi.spyOn(performance, 'now')

    const source = await sessionsAtWork()
    const clockReads = clock.mock.calls.length
    source.checkNow()
    source.turnCompleted('session-1')

    // The source asked, was told no, and left it at that.
    expect(asked).toHaveBeenCalled()
    expect(asked.mock.results.every((result) => result.value === false)).toBe(true)
    expect(recorded).not.toHaveBeenCalled()
    expect(clock.mock.calls.length).toBe(clockReads)
    expect(logger.isEnabled()).toBe(false)
    expect(perfLogText()).toBe('')
    expect(readdirSync(perfDir)).toEqual([])
    // It all happened, though.
    expect(source.facts('session-1')).toMatchObject({ entriesParsed: 2, parseFailures: 1 })
    expect(source.facts('session-2')).toMatchObject({ health: { reason: 'log-empty' } })

    // Switched on now: the first sample has nothing of what went before.
    logger.start()
    expect(gaugeOf(logger.sample())).toEqual({
      sessions: 2,
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
    source.unregister('session-1')
    source.unregister('session-2')
  })
})
