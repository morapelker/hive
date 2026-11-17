// @vitest-environment node
// The usage launches of Claude CLI sessions (Code Mode T17): what a launch gets before its
// process starts, what every way of ending does and in which order, what a session started
// again shares with its earlier process (nothing), and what the sweep deletes. Runs against
// the real launch directories in a temporary place and the real debug-log usage source, with
// a collecting `submit` and timers that only fire when a test says so. The PTYs are stand-ins:
// an id that is forgotten when the PTY is destroyed, and a process that ends later.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import type { ClaudeUsageObservation } from './claude-api-proxy/claude-usage-live-updater'

/** The module's logger: what a degraded launch is reported with is looked at (T18). */
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('./logger', () => ({
  createLogger: () => logMock
}))

import {
  CLAUDE_CLI_DEBUG_DIRNAME,
  ClaudeCliDebugDirs,
  type ClaudeCliDebugLaunch
} from './claude-cli-debug-dir'
import {
  CLAUDE_CLI_USAGE_SWEEP_INTERVAL_MS,
  ClaudeCliUsageLaunches,
  type ClaudeCliUsageHealthChange,
  type ClaudeCliUsageLaunchesDeps
} from './claude-cli-usage-launches'
import { ClaudeDebugLogUsageSource } from './claude-debug-log/claude-debug-log-usage-source'
import {
  ClaudeDebugUsageAutoDisable,
  claimClaudeDebugUsageAutoDisableNotice,
  type ClaudeDebugUsageAutoDisableStore
} from './claude-debug-log/claude-debug-usage-auto-disable'
import type { ClaudeCodeModeUsageUnavailablePayload } from '@shared/types/claude-live-usage'
import type {
  ClaudeUsageTransport,
  ResolveClaudeUsageTransportOptions
} from './claude-usage-transport'

// Owner-only directories and a POSIX shell file: the launch directories exist on POSIX only.
const describePosix = describe.skipIf(process.platform === 'win32')

/** A streaming 200 with usage headers and an organization, as the CLI logs it (T05 fixture). */
const RESPONSE_LINE = readFileSync(
  join(__dirname, 'claude-debug-log', '__fixtures__', 'response-start-streaming.txt'),
  'utf8'
)
  .split('\n')
  .filter((line) => line !== '')[0]

const NOT_ENTRY_LINES = readFileSync(
  join(__dirname, 'claude-debug-log', '__fixtures__', 'not-entries.txt'),
  'utf8'
)
  .split('\n')
  .filter((line) => line !== '')
/** `sending request`, as the CLI logs it: about 2 KB, no entry. */
const REQUEST_LINE = NOT_ENTRY_LINES[0]
/** The SDK's one-line report of a successful response: no headers, no entry. */
const STATUS_LINE = NOT_ENTRY_LINES[2]
/** A line the CLI logs without talking to the API. */
const STARTUP_LINE = NOT_ENTRY_LINES[10]
/** A response entry after an update renamed it: the parser no longer knows the line. */
const RENAMED_RESPONSE_LINE = RESPONSE_LINE.replace('response start', 'response begin')

/** What every warning about a log without readings was logged with (T18). */
const degradedWarnings = (): Array<Record<string, unknown>> =>
  logMock.warn.mock.calls
    .filter(([message]) => String(message).includes('gives no usage readings'))
    .map(([, data]) => data as Record<string, unknown>)

const SESSION = 'session-1'
const OTHER_SESSION = 'session-2'
const WORKTREE = '/repo/worktree'

/** A PTY as the launches see one: listeners for the end of its process, kept as pty-service.ts keeps them. */
interface FakePty {
  readonly exitListeners: Array<() => void>
}

let base: string
/** `<data dir>/claude-cli-debug`. It does not exist until something is prepared. */
let root: string
/** App processes that are running, besides the one under test (`app1`). */
let aliveInstances: Set<string>
/** The PTYs known by their session id. Destroying one forgets the id; its process ends later. */
let ptys: Map<string, FakePty>
let observations: ClaudeUsageObservation[]
/** What happened, in order: `register`, `unregister` and `remove`, each with its session. */
let events: string[]
let dirs: ClaudeCliDebugDirs
let source: ClaudeDebugLogUsageSource
let resolveTransport: ReturnType<
  typeof vi.fn<(options: ResolveClaudeUsageTransportOptions) => Promise<ClaudeUsageTransport>>
>
let isFeatureEnabled: ReturnType<typeof vi.fn<(env: NodeJS.ProcessEnv) => boolean>>
/** The hourly sweep, when it was asked for: its function and its interval. */
let sweepTimers: Array<{ fn: () => void; ms: number; cleared: boolean }>

const settingsDb = (
  environmentVariables: Array<{ key: string; value: string }> = []
): { getSetting(key: string): string | null } => ({
  getSetting: (key) =>
    key === APP_SETTINGS_DB_KEY ? JSON.stringify({ environmentVariables }) : null
})

const launchesOf = (overrides: Partial<ClaudeCliUsageLaunchesDeps> = {}): ClaudeCliUsageLaunches =>
  new ClaudeCliUsageLaunches({
    dirs: {
      prepare: (sessionId, options) => dirs.prepare(sessionId, options),
      remove: (launch) => {
        events.push(`remove ${basenameSession(launch.dir)}`)
        dirs.remove(launch)
      },
      sweep: (live) => dirs.sweep(live)
    },
    source: {
      register: (registration) => {
        events.push(`register ${registration.sessionId}`)
        return source.register(registration)
      },
      unregister: (sessionId) => {
        events.push(`unregister ${sessionId}`)
        return source.unregister(sessionId)
      },
      setTurnInProgress: (sessionId, inProgress) => source.setTurnInProgress(sessionId, inProgress),
      turnCompleted: (sessionId) => source.turnCompleted(sessionId),
      onHealthChange: (listener) => source.onHealthChange(listener),
      facts: (sessionId) => source.facts(sessionId)
    },
    isFeatureEnabled,
    resolveTransport,
    onProcessExit: (sessionId, listener) => {
      const pty = ptys.get(sessionId)
      if (!pty) return () => {}
      pty.exitListeners.push(listener)
      return () => {
        const index = pty.exitListeners.indexOf(listener)
        if (index !== -1) pty.exitListeners.splice(index, 1)
      }
    },
    hasLiveProcess: (sessionId) => ptys.has(sessionId),
    env: {},
    setInterval: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      sweepTimers.push(timer)
      return timer
    },
    clearInterval: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    ...overrides
  })

/** `<sessionId>-<app process>-<nonce>` back to its session id. */
const basenameSession = (dir: string): string =>
  dir
    .split('/')
    .pop()!
    .replace(/-[A-Za-z0-9_]+-[0-9a-f]{16}$/, '')

/** The launch directories on disk, by name. */
const launchDirs = (): string[] => (existsSync(root) ? readdirSync(root).sort() : [])

/** The session's process starts: its PTY exists under its id. */
const spawnPty = (sessionId: string): FakePty => {
  const pty: FakePty = { exitListeners: [] }
  ptys.set(sessionId, pty)
  return pty
}

/** The PTY is destroyed: its id is forgotten at once, its process has not ended yet. */
const destroyPty = (sessionId: string): FakePty => {
  const pty = ptys.get(sessionId)
  if (!pty) throw new Error(`No PTY for ${sessionId}`)
  ptys.delete(sessionId)
  return pty
}

/**
 * The process of a PTY ends, as pty-service.ts reports it: whoever listens is called in a row
 * over the list itself (a listener that takes itself off meanwhile costs the next one its
 * turn), then the id is forgotten if it still names this PTY.
 */
const exitPty = (pty: FakePty): void => {
  for (const listener of pty.exitListeners) listener()
  for (const [sessionId, known] of ptys) if (known === pty) ptys.delete(sessionId)
}

/** Begin a `debug-log` launch and start its process. */
const startDebugLogLaunch = (
  launches: ClaudeCliUsageLaunches,
  sessionId = SESSION
): { files: { debugLogFile: string; envFile: string; dir: string }; pty: FakePty } => {
  const usage = launches.begin(sessionId, 'debug-log', { cwd: WORKTREE, db: settingsDb() })
  if (usage?.transport !== 'debug-log') throw new Error('The launch was not prepared')
  const pty = spawnPty(sessionId)
  launches.started(sessionId)
  return {
    files: {
      debugLogFile: usage.debugLogFile,
      envFile: usage.envFile,
      dir: dirname(usage.debugLogFile)
    },
    pty
  }
}

beforeEach(() => {
  for (const fn of Object.values(logMock)) fn.mockClear()
  base = mkdtempSync(join(tmpdir(), 'claude-cli-usage-launches-'))
  root = join(base, 'data', CLAUDE_CLI_DEBUG_DIRNAME)
  mkdirSync(dirname(root))
  aliveInstances = new Set()
  ptys = new Map()
  observations = []
  events = []
  sweepTimers = []
  dirs = new ClaudeCliDebugDirs({
    root,
    instanceId: 'app1',
    isInstanceAlive: (instanceId) => aliveInstances.has(instanceId)
  })
  source = new ClaudeDebugLogUsageSource({
    submit: (observation) => observations.push(observation),
    // The source's own timer never fires here: a log is read when a test ends its launch.
    setTimer: () => ({}),
    clearTimer: () => {}
  })
  resolveTransport = vi.fn(async () => 'proxy' as ClaudeUsageTransport)
  isFeatureEnabled = vi.fn(() => true)
})

afterEach(() => {
  source.dispose()
  rmSync(base, { recursive: true, force: true })
})

describe('ClaudeCliUsageLaunches.decide', () => {
  it('asks the transport decision with the feature state, the provider command and the settings', async () => {
    resolveTransport.mockResolvedValue('debug-log')
    const env = { HOME: '/home/someone' }
    const db = settingsDb()
    const launches = launchesOf({ env })

    const transport = await launches.decide({ db, customProviderCommand: 'kimi' })

    expect(transport).toBe('debug-log')
    expect(resolveTransport).toHaveBeenCalledWith({
      db,
      featureEnabled: true,
      customProviderCommand: 'kimi',
      env
    })
  })

  it('passes a switched-off feature on to the decision', async () => {
    isFeatureEnabled.mockReturnValue(false)
    resolveTransport.mockResolvedValue('none')
    const launches = launchesOf()

    expect(await launches.decide({ db: settingsDb() })).toBe('none')
    expect(resolveTransport.mock.calls[0][0].featureEnabled).toBe(false)
  })

  it('reads the kill switch from Settings over the environment of the app', async () => {
    const launches = launchesOf({
      env: { HIVE_DISABLE_CLAUDE_DEBUG_USAGE: '1', PATH: '/usr/bin' }
    })

    await launches.decide({
      db: settingsDb([{ key: 'HIVE_DISABLE_CLAUDE_DEBUG_USAGE', value: '0' }])
    })
    await launches.decide({ db: settingsDb() })

    expect(isFeatureEnabled.mock.calls[0][0]).toMatchObject({
      HIVE_DISABLE_CLAUDE_DEBUG_USAGE: '0',
      PATH: '/usr/bin'
    })
    expect(isFeatureEnabled.mock.calls[1][0]).toMatchObject({
      HIVE_DISABLE_CLAUDE_DEBUG_USAGE: '1'
    })
  })

  it('stays on the proxy when the decision cannot be made', async () => {
    resolveTransport.mockRejectedValue(new Error('settings unreadable'))
    expect(await launchesOf().decide({ db: settingsDb() })).toBe('proxy')
  })

  it('stays on the proxy when the state of the feature cannot be read', async () => {
    // The decision itself would have taken the launch off the proxy.
    resolveTransport.mockResolvedValue('debug-log')
    isFeatureEnabled.mockImplementation(() => {
      throw new Error('database closed')
    })

    expect(await launchesOf().decide({ db: settingsDb() })).toBe('proxy')
    expect(resolveTransport).not.toHaveBeenCalled()
  })
})

describePosix('ClaudeCliUsageLaunches.begin', () => {
  it('prepares one private directory and follows its log before there is a process', () => {
    const launches = launchesOf()

    const usage = launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb() })

    expect(launchDirs()).toHaveLength(1)
    const dir = join(root, launchDirs()[0])
    expect(usage).toEqual({
      transport: 'debug-log',
      debugLogFile: join(dir, 'usage.log'),
      envFile: join(dir, 'env.sh')
    })
    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(dir, 'usage.log'), 'utf8')).toBe('')
    // Followed already, with no PTY in sight (FR-15).
    expect(ptys.has(SESSION)).toBe(false)
    expect(source.facts(SESSION)?.logPath).toBe(join(dir, 'usage.log'))
    expect(events).toEqual([`register ${SESSION}`])
    expect(launches.transport(SESSION)).toBe('debug-log')
  })

  it('makes nothing for a launch on the proxy', () => {
    const launches = launchesOf()

    expect(launches.begin(SESSION, 'proxy', { cwd: WORKTREE, db: settingsDb() })).toBeNull()

    expect(existsSync(root)).toBe(false)
    expect(source.stats().sessions).toBe(0)
    expect(events).toEqual([])
    expect(launches.transport(SESSION)).toBeNull()
    expect(launches.liveSessionIds().size).toBe(0)
  })

  it('makes nothing on disk for a launch without live usage', () => {
    const launches = launchesOf()

    expect(launches.begin(SESSION, 'none', { cwd: WORKTREE, db: settingsDb() })).toEqual({
      transport: 'none'
    })

    expect(existsSync(root)).toBe(false)
    expect(source.stats().sessions).toBe(0)
    expect(launches.transport(SESSION)).toBe('none')
  })

  it("has the launch's environment file source the user's own, from Settings first", () => {
    const launches = launchesOf({ env: { CLAUDE_ENV_FILE: '/home/someone/from-shell.sh' } })

    const fromSettings = launches.begin(SESSION, 'debug-log', {
      cwd: WORKTREE,
      db: settingsDb([{ key: 'CLAUDE_ENV_FILE', value: 'relative/env.sh' }])
    })
    const fromShell = launches.begin(OTHER_SESSION, 'debug-log', {
      cwd: WORKTREE,
      db: settingsDb()
    })

    if (fromSettings?.transport !== 'debug-log' || fromShell?.transport !== 'debug-log') {
      throw new Error('The launches were not prepared')
    }
    // A relative one is read from where the CLI starts, as the CLI would have read it.
    expect(readFileSync(fromSettings.envFile, 'utf8')).toBe(
      "if [ -f '/repo/worktree/relative/env.sh' ]; then . '/repo/worktree/relative/env.sh'; fi\n" +
        'unset ANTHROPIC_LOG\n'
    )
    expect(readFileSync(fromShell.envFile, 'utf8')).toBe(
      "if [ -f '/home/someone/from-shell.sh' ]; then . '/home/someone/from-shell.sh'; fi\n" +
        'unset ANTHROPIC_LOG\n'
    )
  })

  it('starts a launch that cannot be prepared without live usage, and leaves nothing behind', () => {
    // Something that is not the app's is where the directories would go.
    writeFileSync(root, 'not a directory')
    const launches = launchesOf()

    const usage = launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb() })

    expect(usage).toEqual({ transport: 'none' })
    expect(readFileSync(root, 'utf8')).toBe('not a directory')
    expect(source.stats().sessions).toBe(0)
    expect(launches.transport(SESSION)).toBe('none')
  })

  it('starts a launch whose directory others could read without live usage', () => {
    mkdirSync(root, { mode: 0o755 })
    chmodSync(root, 0o755)
    const launches = launchesOf()

    expect(launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb() })).toEqual({
      transport: 'none'
    })
    expect(launchDirs()).toEqual([])
  })

  it('takes the directory back when its log cannot be followed', () => {
    const launches = launchesOf({
      source: {
        register: () => {
          throw new TypeError('A debug-log session needs an absolute log path')
        },
        unregister: (sessionId) => source.unregister(sessionId),
        setTurnInProgress: () => false,
        turnCompleted: () => false,
        onHealthChange: () => () => {},
        facts: () => null
      }
    })

    expect(launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb() })).toEqual({
      transport: 'none'
    })
    expect(launchDirs()).toEqual([])
    expect(launches.transport(SESSION)).toBe('none')
  })

  it('never throws, whatever the directories do', () => {
    const launches = launchesOf({
      dirs: {
        prepare: () => {
          throw new Error('disk full')
        },
        remove: () => {},
        sweep: () => {}
      }
    })

    expect(launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb() })).toEqual({
      transport: 'none'
    })
  })
})

describePosix('the end of a usage launch', () => {
  it('reads the log one last time, lets go of it, then deletes the directory when the process exits', () => {
    const launches = launchesOf()
    const { files, pty } = startDebugLogLaunch(launches)
    // Written by the CLI just before it ended, and never seen by a scheduled check.
    appendFileSync(files.debugLogFile, `${RESPONSE_LINE}\n`)

    exitPty(pty)

    expect(observations).toHaveLength(1)
    expect(events).toEqual([`register ${SESSION}`, `unregister ${SESSION}`, `remove ${SESSION}`])
    expect(source.facts(SESSION)).toBeNull()
    expect(existsSync(files.dir)).toBe(false)
    expect(launches.transport(SESSION)).toBeNull()
    expect(launches.liveSessionIds().size).toBe(0)
  })

  it('leaves whoever else listens for the end of the process their turn', () => {
    const launches = launchesOf()
    const { files, pty } = startDebugLogLaunch(launches)
    launches.begin(OTHER_SESSION, 'none', { cwd: WORKTREE, db: settingsDb() })
    const otherPty = spawnPty(OTHER_SESSION)
    launches.started(OTHER_SESSION)
    // The terminal's own exit handling listens on the same PTY, after the launch does.
    const terminalExit = vi.fn()
    const otherTerminalExit = vi.fn()
    pty.exitListeners.push(terminalExit)
    otherPty.exitListeners.push(otherTerminalExit)

    exitPty(pty)
    exitPty(otherPty)

    // A launch that took its own listener off while they are being called would cost the
    // terminal its exit: no "session ended", nothing cleaned up.
    expect(terminalExit).toHaveBeenCalledTimes(1)
    expect(otherTerminalExit).toHaveBeenCalledTimes(1)
    expect(existsSync(files.dir)).toBe(false)
    expect(launches.liveSessionIds().size).toBe(0)
  })

  it('keeps the directory of a closed session until its process has ended', () => {
    const launches = launchesOf()
    const { files } = startDebugLogLaunch(launches)

    // The session is closed (or reaped): its PTY is destroyed, its process told to end.
    const pty = destroyPty(SESSION)

    // A CLI that still runs would make a deleted directory again, and not a private one.
    expect(existsSync(files.dir)).toBe(true)
    expect(source.facts(SESSION)).not.toBeNull()
    expect(launches.liveSessionIds()).toEqual(new Set([SESSION]))

    exitPty(pty)

    expect(events).toEqual([`register ${SESSION}`, `unregister ${SESSION}`, `remove ${SESSION}`])
    expect(existsSync(files.dir)).toBe(false)
    expect(source.facts(SESSION)).toBeNull()
  })

  it('takes back what was prepared for a process that never started', () => {
    const launches = launchesOf()
    const usage = launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb() })
    if (usage?.transport !== 'debug-log') throw new Error('The launch was not prepared')

    launches.abandon(SESSION)

    expect(events).toEqual([`register ${SESSION}`, `unregister ${SESSION}`, `remove ${SESSION}`])
    expect(launchDirs()).toEqual([])
    expect(source.stats().sessions).toBe(0)
    expect(launches.transport(SESSION)).toBeNull()
  })

  it('does not abandon a launch whose process exists', () => {
    const launches = launchesOf()
    const { files } = startDebugLogLaunch(launches)

    launches.abandon(SESSION)

    expect(existsSync(files.dir)).toBe(true)
    expect(source.facts(SESSION)).not.toBeNull()
  })

  it('ends every launch when the app quits, once its PTYs have been reaped and in order', () => {
    const launches = launchesOf()
    const first = startDebugLogLaunch(launches, SESSION)
    const second = startDebugLogLaunch(launches, OTHER_SESSION)
    appendFileSync(second.files.debugLogFile, `${RESPONSE_LINE}\n`)

    // The quit path asks before it ends every PTY...
    const endLaunches = launches.quit()
    destroyPty(SESSION)
    destroyPty(OTHER_SESSION)
    // ...and nothing is touched while the processes are being ended.
    expect(events).toEqual([`register ${SESSION}`, `register ${OTHER_SESSION}`])
    expect(launchDirs()).toHaveLength(2)

    // Reaped; no process reported its exit in time.
    endLaunches()

    expect(observations).toHaveLength(1)
    expect(launchDirs()).toEqual([])
    expect(source.stats().sessions).toBe(0)
    expect(events.slice(2)).toEqual([
      `unregister ${SESSION}`,
      `remove ${SESSION}`,
      `unregister ${OTHER_SESSION}`,
      `remove ${OTHER_SESSION}`
    ])

    // An exit reported after all, and a second quit step, find nothing left to do.
    exitPty(first.pty)
    exitPty(second.pty)
    endLaunches()
    launches.quit()()
    expect(events).toHaveLength(6)
  })

  it('leaves every directory to the next start when the PTYs could not be reaped', () => {
    const launches = launchesOf()
    const running = startDebugLogLaunch(launches, SESSION)
    appendFileSync(running.files.debugLogFile, `${RESPONSE_LINE}\n`)
    const neverStarted = launches.begin(OTHER_SESSION, 'debug-log', {
      cwd: WORKTREE,
      db: settingsDb()
    })
    if (neverStarted?.transport !== 'debug-log') throw new Error('The launch was not prepared')

    const endLaunches = launches.quit()
    // Ending the PTYs failed: nothing says the CLI is gone.
    endLaunches(false)

    // Its last lines count and its log is let go of; its directory stays, private.
    expect(observations).toHaveLength(1)
    expect(source.stats().sessions).toBe(0)
    expect(existsSync(running.files.dir)).toBe(true)
    expect(lstatSync(running.files.dir).mode & 0o777).toBe(0o700)
    // What never had a process is taken back as ever.
    expect(existsSync(dirname(neverStarted.debugLogFile))).toBe(false)
    expect(events.filter((event) => event.startsWith('remove'))).toEqual([
      `remove ${OTHER_SESSION}`
    ])
    expect(launches.liveSessionIds().size).toBe(0)
  })

  it('leaves the directory of a process told to end before the quit to the next start', () => {
    const launches = launchesOf()
    const closed = startDebugLogLaunch(launches, SESSION)
    const running = startDebugLogLaunch(launches, OTHER_SESSION)
    appendFileSync(closed.files.debugLogFile, `${RESPONSE_LINE}\n`)
    // Closed a moment before the quit: told to end, not ended, and no PTY left to reap.
    const closedPty = destroyPty(SESSION)

    const endLaunches = launches.quit()
    destroyPty(OTHER_SESSION)
    endLaunches()

    // Its last lines count, and its log is let go of...
    expect(observations).toHaveLength(1)
    expect(source.stats().sessions).toBe(0)
    expect(events.slice(2)).toEqual([
      `unregister ${SESSION}`,
      `unregister ${OTHER_SESSION}`,
      `remove ${OTHER_SESSION}`
    ])
    // ...but nothing says its CLI is gone, and one that still runs would make a deleted
    // directory again, readable by others. It stays, private as it was made.
    expect(existsSync(closed.files.dir)).toBe(true)
    expect(lstatSync(closed.files.dir).mode & 0o777).toBe(0o700)
    expect(existsSync(running.files.dir)).toBe(false)
    expect(launches.liveSessionIds().size).toBe(0)

    // Its exit, when it comes, finds nothing to do here...
    exitPty(closedPty)
    expect(events).toHaveLength(5)
    // ...and the next app process deletes the directory at its start: this one is gone by then.
    new ClaudeCliDebugDirs({ root, instanceId: 'app2', isInstanceAlive: () => false }).sweep(
      new Set()
    )
    expect(launchDirs()).toEqual([])
  })

  it('leaves the directory of a restarted session\'s old process at the quit too', () => {
    const launches = launchesOf()
    const old = startDebugLogLaunch(launches, SESSION)
    // Restarted just before the quit: the old process was told to end and has not ended.
    destroyPty(SESSION)
    const current = startDebugLogLaunch(launches, SESSION)

    const endLaunches = launches.quit()
    destroyPty(SESSION)
    endLaunches()

    expect(existsSync(old.files.dir)).toBe(true)
    expect(existsSync(current.files.dir)).toBe(false)
    expect(source.stats().sessions).toBe(0)
    expect(launches.liveSessionIds().size).toBe(0)
  })

  it('takes back a launch that was prepared and never started when the app quits', () => {
    const launches = launchesOf()
    const usage = launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb() })
    if (usage?.transport !== 'debug-log') throw new Error('The launch was not prepared')

    launches.quit()()

    // No process was ever started on it.
    expect(launchDirs()).toEqual([])
    expect(source.stats().sessions).toBe(0)
  })

  it('forgets a launch without live usage when its process ends', () => {
    const launches = launchesOf()
    launches.begin(SESSION, 'none', { cwd: WORKTREE, db: settingsDb() })
    const pty = spawnPty(SESSION)
    launches.started(SESSION)
    expect(launches.transport(SESSION)).toBe('none')

    exitPty(pty)

    expect(launches.transport(SESSION)).toBeNull()
    expect(events).toEqual([])
  })

  it('still deletes the directory when letting go of the log fails', () => {
    const launches = launchesOf({
      source: {
        register: (registration) => source.register(registration),
        unregister: () => {
          throw new Error('the follower is stuck')
        },
        setTurnInProgress: () => false,
        turnCompleted: () => false,
        onHealthChange: () => () => {},
        facts: () => null
      }
    })
    const { files, pty } = startDebugLogLaunch(launches)

    exitPty(pty)

    expect(existsSync(files.dir)).toBe(false)
  })
})

describePosix('a session that is started again', () => {
  it('gets a new directory after its earlier process ended, and nothing of the old one', () => {
    const launches = launchesOf()
    const first = startDebugLogLaunch(launches)
    appendFileSync(first.files.debugLogFile, `${RESPONSE_LINE}\n`)
    exitPty(first.pty)

    // A resume: the same session, a new process.
    const second = startDebugLogLaunch(launches)

    expect(second.files.dir).not.toBe(first.files.dir)
    expect(launchDirs()).toEqual([second.files.dir.split('/').pop()])
    expect(readFileSync(second.files.debugLogFile, 'utf8')).toBe('')
    expect(source.facts(SESSION)?.logPath).toBe(second.files.debugLogFile)
    expect(source.facts(SESSION)?.bytesRead).toBe(0)
  })

  it('leaves the new launch alone when the process it replaced ends late', () => {
    const launches = launchesOf()
    const first = startDebugLogLaunch(launches)
    // A restart: the old PTY is destroyed and the session started again at once.
    const oldPty = destroyPty(SESSION)
    const second = startDebugLogLaunch(launches)

    // Both directories are in use: the old process has not ended yet.
    expect(existsSync(first.files.dir)).toBe(true)
    expect(existsSync(second.files.dir)).toBe(true)
    expect(source.facts(SESSION)?.logPath).toBe(second.files.debugLogFile)
    expect(launches.liveSessionIds()).toEqual(new Set([SESSION]))

    exitPty(oldPty)

    // Only the old launch ended.
    expect(existsSync(first.files.dir)).toBe(false)
    expect(existsSync(second.files.dir)).toBe(true)
    expect(source.facts(SESSION)?.logPath).toBe(second.files.debugLogFile)
    expect(launches.transport(SESSION)).toBe('debug-log')
    expect(events).toEqual([
      `register ${SESSION}`,
      // The old log is let go of before the session id names the new one.
      `unregister ${SESSION}`,
      `register ${SESSION}`,
      `remove ${SESSION}`
    ])

    exitPty(second.pty)
    expect(launchDirs()).toEqual([])
    expect(source.stats().sessions).toBe(0)
  })

  it('lets go of the old log when the session comes back on the proxy', () => {
    const launches = launchesOf()
    const first = startDebugLogLaunch(launches)
    const oldPty = destroyPty(SESSION)

    // Code Mode is no longer asked for: the new process goes through the proxy.
    expect(launches.begin(SESSION, 'proxy', { cwd: WORKTREE, db: settingsDb() })).toBeNull()
    spawnPty(SESSION)
    launches.started(SESSION)

    expect(launches.transport(SESSION)).toBeNull()
    expect(source.facts(SESSION)).toBeNull()
    expect(existsSync(first.files.dir)).toBe(true)

    exitPty(oldPty)
    expect(launchDirs()).toEqual([])
  })

  it('takes back a launch that was prepared and never started before preparing the next', () => {
    const launches = launchesOf()
    const first = launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb() })
    const second = launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb() })

    if (first?.transport !== 'debug-log' || second?.transport !== 'debug-log') {
      throw new Error('The launches were not prepared')
    }
    expect(launchDirs()).toEqual([dirname(second.debugLogFile).split('/').pop()])
    expect(source.facts(SESSION)?.logPath).toBe(second.debugLogFile)
  })
})

describePosix('ClaudeCliUsageLaunches.noteStatus', () => {
  it('follows the log on the fast schedule while a turn runs', () => {
    const launches = launchesOf()
    startDebugLogLaunch(launches)

    launches.noteStatus(SESSION, 'working')
    expect(source.facts(SESSION)?.turnInProgress).toBe(true)
    launches.noteStatus(SESSION, 'completed')
    expect(source.facts(SESSION)?.turnInProgress).toBe(false)
    launches.noteStatus(SESSION, 'planning')
    expect(source.facts(SESSION)?.turnInProgress).toBe(true)
    // Waiting for the person: nothing is sent to the API meanwhile.
    for (const status of ['permission', 'answering', 'plan_ready', 'unread'] as const) {
      launches.noteStatus(SESSION, 'working')
      launches.noteStatus(SESSION, status)
      expect(source.facts(SESSION)?.turnInProgress).toBe(false)
    }
  })

  it('reads what the turn left in the log the moment it ends', () => {
    const launches = launchesOf()
    const { files } = startDebugLogLaunch(launches)
    launches.noteStatus(SESSION, 'working')
    appendFileSync(files.debugLogFile, `${RESPONSE_LINE}\n`)

    launches.noteStatus(SESSION, 'completed')

    expect(observations).toHaveLength(1)
  })

  it('says nothing about a session that is not followed', () => {
    const setTurnInProgress = vi.fn(() => true)
    const turnCompleted = vi.fn(() => true)
    const launches = launchesOf({
      source: {
        register: (registration) => source.register(registration),
        unregister: (sessionId) => source.unregister(sessionId),
        setTurnInProgress,
        turnCompleted,
        onHealthChange: (listener) => source.onHealthChange(listener),
        facts: (sessionId) => source.facts(sessionId)
      }
    })
    launches.begin(SESSION, 'none', { cwd: WORKTREE, db: settingsDb() })
    spawnPty(SESSION)
    launches.started(SESSION)

    launches.noteStatus(SESSION, 'working')
    launches.noteStatus(OTHER_SESSION, 'working')
    launches.noteStatus(SESSION, 'completed')
    launches.noteStatus(OTHER_SESSION, 'completed')

    expect(setTurnInProgress).not.toHaveBeenCalled()
    expect(turnCompleted).not.toHaveBeenCalled()
    expect(launches.degradedReason(SESSION)).toBeNull()
    expect(degradedWarnings()).toEqual([])
  })
})

// Code Mode T18: a log that gives no readings. The usage source says when (its own tests
// cover every way a log goes quiet); here is what the launch does about it.
describePosix('ClaudeCliUsageLaunches health', () => {
  const CLI = '/opt/claude/bin/claude'
  const CLI_VERSION = '2.1.326'

  let changes: ClaudeCliUsageHealthChange[]

  const healthLaunches = (
    overrides: Partial<ClaudeCliUsageLaunchesDeps> = {}
  ): ClaudeCliUsageLaunches => {
    changes = []
    return launchesOf({
      cliVersion: (path) => (path === CLI ? CLI_VERSION : null),
      onHealthChange: (change) => changes.push(change),
      ...overrides
    })
  }

  /** Begin a `debug-log` launch of the CLI at `CLI` and start its process. */
  const start = (
    launches: ClaudeCliUsageLaunches,
    sessionId = SESSION,
    cliPath: string | null = CLI
  ): { logFile: string; pty: FakePty } => {
    const usage = launches.begin(sessionId, 'debug-log', {
      cwd: WORKTREE,
      db: settingsDb(),
      cliPath
    })
    if (usage?.transport !== 'debug-log') throw new Error('The launch was not prepared')
    const pty = spawnPty(sessionId)
    launches.started(sessionId)
    return { logFile: usage.debugLogFile, pty }
  }

  /** One turn: the prompt is submitted, the CLI logs `lines`, the Stop hook fires. */
  const turn = (
    launches: ClaudeCliUsageLaunches,
    logFile: string | null,
    lines: string[] = [],
    sessionId = SESSION
  ): void => {
    launches.noteStatus(sessionId, 'working')
    if (logFile) for (const line of lines) appendFileSync(logFile, `${line}\n`)
    launches.noteStatus(sessionId, 'completed')
  }

  /** A source whose followers delete a log past 8 KiB, in place of the test's own. */
  const useSmallHardCap = (): void => {
    source.dispose()
    source = new ClaudeDebugLogUsageSource({
      submit: (observation) => observations.push(observation),
      setTimer: () => ({}),
      clearTimer: () => {},
      follower: { hardCapBytes: 8 * 1024 }
    })
  }

  /** Enough of a request to pass 8 KiB: no entry among them. */
  const overTheCap = (): string[] => Array.from({ length: 6 }, () => REQUEST_LINE)

  it('warns once, with the reason and the CLI version, when a turn completes over an empty log', () => {
    const launches = healthLaunches()
    start(launches)

    turn(launches, null)

    expect(launches.degradedReason(SESSION)).toBe('log-empty')
    expect(degradedWarnings()).toEqual([
      expect.objectContaining({
        sessionId: SESSION,
        reason: 'log-empty',
        cliVersion: CLI_VERSION,
        turnsCompleted: 1,
        bytesRead: 0,
        statusLines: 0,
        entriesParsed: 0,
        parseFailures: 0
      })
    ])
    expect(changes).toEqual([
      {
        sessionId: SESSION,
        degraded: true,
        reason: 'log-empty',
        cliVersion: CLI_VERSION,
        at: expect.any(Number)
      }
    ])
    // It stays the launch it was: nothing is switched, the poll covers it.
    expect(launches.transport(SESSION)).toBe('debug-log')
    expect(source.facts(SESSION)).not.toBeNull()
  })

  it('warns when the log cannot be written: the file is gone and cannot be made again', () => {
    const launches = healthLaunches()
    const { logFile } = start(launches)
    // What an unwritable location amounts to: the CLI writes nothing and says nothing.
    rmSync(logFile)
    chmodSync(dirname(logFile), 0o500)

    try {
      turn(launches, null)
    } finally {
      chmodSync(dirname(logFile), 0o700)
    }

    expect(degradedWarnings()).toEqual([
      expect.objectContaining({ reason: 'log-empty', cliVersion: CLI_VERSION })
    ])
  })

  it('warns when responses were logged and none could be read', () => {
    const launches = healthLaunches()
    const { logFile } = start(launches)

    turn(launches, logFile, [REQUEST_LINE, STATUS_LINE, RENAMED_RESPONSE_LINE])

    expect(launches.degradedReason(SESSION)).toBe('unparsed-responses')
    expect(degradedWarnings()).toEqual([
      expect.objectContaining({
        reason: 'unparsed-responses',
        cliVersion: CLI_VERSION,
        statusLines: 1,
        entriesParsed: 0
      })
    ])
    expect(changes.map((change) => change.reason)).toEqual(['unparsed-responses'])
    expect(observations).toEqual([])
  })

  it('warns the moment a log past the hard cap is deleted, without waiting for a turn', () => {
    useSmallHardCap()
    const launches = healthLaunches()
    const { logFile } = start(launches)
    for (const line of overTheCap()) appendFileSync(logFile, `${line}\n`)

    source.checkNow(SESSION)

    expect(existsSync(logFile)).toBe(false)
    expect(degradedWarnings()).toEqual([
      expect.objectContaining({ reason: 'hard-cap', cliVersion: CLI_VERSION })
    ])
    expect(changes.map((change) => change.reason)).toEqual(['hard-cap'])
  })

  it('warns the moment the follower refuses what is at the path of the log', () => {
    const launches = healthLaunches()
    const { logFile } = start(launches)
    rmSync(logFile)
    writeFileSync(join(base, 'elsewhere.log'), `${RESPONSE_LINE}\n`)
    symlinkSync(join(base, 'elsewhere.log'), logFile)

    source.checkNow(SESSION)

    expect(degradedWarnings()).toEqual([
      expect.objectContaining({ reason: 'unsafe-file', detail: 'symlink', cliVersion: CLI_VERSION })
    ])
    expect(changes.map((change) => change.reason)).toEqual(['unsafe-file'])
    expect(observations).toEqual([])
  })

  it('leaves a healthy session alone, also one whose turn sent nothing to the API', () => {
    const launches = healthLaunches()
    const { logFile } = start(launches)

    turn(launches, logFile, [REQUEST_LINE, STATUS_LINE, RESPONSE_LINE])
    // A local command: the CLI logged a line and made no request.
    turn(launches, logFile, [STARTUP_LINE])
    turn(launches, logFile)

    expect(launches.degradedReason(SESSION)).toBeNull()
    expect(degradedWarnings()).toEqual([])
    expect(changes).toEqual([])
    expect(observations).toHaveLength(1)
  })

  it('does not judge a session that was reported idle before it ran a turn', () => {
    const launches = healthLaunches()
    start(launches)

    launches.noteStatus(SESSION, 'completed')
    launches.noteStatus(SESSION, 'unread')

    expect(source.facts(SESSION)).toMatchObject({ turnsCompleted: 0, health: null })
    expect(degradedWarnings()).toEqual([])
  })

  it('does not judge a turn that waits for the person, only one that completed', () => {
    const launches = healthLaunches()
    start(launches)

    launches.noteStatus(SESSION, 'working')
    for (const status of ['permission', 'answering', 'command_approval', 'plan_ready'] as const) {
      launches.noteStatus(SESSION, status)
      launches.noteStatus(SESSION, 'planning')
    }
    expect(source.facts(SESSION)).toMatchObject({ turnsCompleted: 0, health: null })
    expect(degradedWarnings()).toEqual([])

    // The Stop hook, seen while the session's tab is not looked at.
    launches.noteStatus(SESSION, 'unread')

    expect(source.facts(SESSION)).toMatchObject({ turnsCompleted: 1 })
    expect(degradedWarnings()).toHaveLength(1)
    // One completed turn is one judgement: `completed` after `unread` is the same turn.
    launches.noteStatus(SESSION, 'completed')
    expect(source.facts(SESSION)).toMatchObject({ turnsCompleted: 1 })
  })

  it('is healthy again when readings resume, and says so', () => {
    const launches = healthLaunches()
    const { logFile } = start(launches)
    turn(launches, null)
    expect(launches.degradedReason(SESSION)).toBe('log-empty')

    // The log is written after all: the next response is read like any other.
    turn(launches, logFile, [REQUEST_LINE, STATUS_LINE, RESPONSE_LINE])

    expect(launches.degradedReason(SESSION)).toBeNull()
    expect(observations).toHaveLength(1)
    expect(changes).toEqual([
      expect.objectContaining({ sessionId: SESSION, degraded: true, reason: 'log-empty' }),
      {
        sessionId: SESSION,
        degraded: false,
        reason: null,
        cliVersion: CLI_VERSION,
        at: expect.any(Number)
      }
    ])
    expect(logMock.info).toHaveBeenCalledWith(expect.stringContaining('gives readings again'), {
      sessionId: SESSION
    })
  })

  it('logs exactly one warning for a session, however often it degrades', () => {
    useSmallHardCap()
    const launches = healthLaunches()
    const { logFile } = start(launches)

    turn(launches, null)
    turn(launches, null)
    turn(launches, logFile, [RESPONSE_LINE])
    for (const line of overTheCap()) appendFileSync(logFile, `${line}\n`)
    source.checkNow(SESSION)
    turn(launches, null)

    expect(changes.map((change) => change.reason)).toEqual(['log-empty', null, 'hard-cap'])
    expect(launches.degradedReason(SESSION)).toBe('hard-cap')
    expect(degradedWarnings()).toEqual([expect.objectContaining({ reason: 'log-empty' })])
  })

  it('warns once per session when several degrade', () => {
    const launches = healthLaunches()
    start(launches, SESSION)
    start(launches, OTHER_SESSION, null)

    turn(launches, null, [], SESSION)
    turn(launches, null, [], OTHER_SESSION)
    turn(launches, null, [], SESSION)

    expect(degradedWarnings().map((data) => [data.sessionId, data.cliVersion])).toEqual([
      [SESSION, CLI_VERSION],
      // Nobody said which binary runs: the warning says the version is not known.
      [OTHER_SESSION, 'unknown']
    ])
    expect(changes.map((change) => [change.sessionId, change.cliVersion])).toEqual([
      [SESSION, CLI_VERSION],
      [OTHER_SESSION, null]
    ])
  })

  it('writes nothing of the log into the warning', () => {
    const launches = healthLaunches()
    const { logFile } = start(launches)
    const lines = [REQUEST_LINE, STATUS_LINE, RENAMED_RESPONSE_LINE]

    turn(launches, logFile, lines)

    expect(degradedWarnings()).toHaveLength(1)
    const logged = JSON.stringify([
      ...logMock.warn.mock.calls,
      ...logMock.info.mock.calls,
      ...logMock.debug.mock.calls
    ])
    // Header names and values, ids, URLs: anything of a line long enough to give it away.
    const pieces = lines.flatMap((line) =>
      line.split(/[\s'"`{},\\]+/).filter((piece) => piece.length >= 12)
    )
    expect(pieces.length).toBeGreaterThan(20)
    for (const piece of pieces) expect(logged.includes(piece)).toBe(false)
    expect(logged).not.toContain(logFile)
  })

  it('still warns when the version cannot be asked or the listener fails', () => {
    const launches = healthLaunches({
      cliVersion: () => {
        throw new Error('the binary is gone')
      },
      onHealthChange: () => {
        throw new Error('nobody listens')
      }
    })
    const { logFile } = start(launches)

    turn(launches, null)
    turn(launches, logFile, [RESPONSE_LINE])

    expect(degradedWarnings()).toEqual([
      expect.objectContaining({ reason: 'log-empty', cliVersion: 'unknown' })
    ])
    expect(launches.degradedReason(SESSION)).toBeNull()
    expect(observations).toHaveLength(1)
  })

  it('says nothing for a launch that has ended, and starts the next one healthy', () => {
    const launches = healthLaunches()
    const first = start(launches)
    turn(launches, null)
    expect(degradedWarnings()).toHaveLength(1)

    // The last read of a log that is let go of turns up a response: nobody is told.
    appendFileSync(first.logFile, `${RESPONSE_LINE}\n`)
    exitPty(first.pty)
    expect(changes).toHaveLength(1)
    expect(launches.degradedReason(SESSION)).toBeNull()

    // The session is started again: a new launch, judged on its own.
    start(launches)
    expect(launches.degradedReason(SESSION)).toBeNull()
    turn(launches, null)

    expect(degradedWarnings()).toHaveLength(2)
    expect(changes.map((change) => change.degraded)).toEqual([true, true])
  })
})

describePosix('a CLI version whose debug log gives no readings (T19)', () => {
  const CLI = '/usr/local/bin/claude'

  /** The `settings` table: what the app still has after a restart. */
  let rows: Map<string, string>
  let store: ClaudeDebugUsageAutoDisableStore
  /** What the binary at `CLI` reports right now. */
  let cliVersion: string | null
  let appVersion: string
  /** Every cue to tell the person, in order. */
  let cues: ClaudeCodeModeUsageUnavailablePayload[]
  /** Sessions started so far: each launch below is a new session. */
  let started: number

  /** The app starts (again): new launches and a new count, over the same database. */
  const startApp = (): ClaudeCliUsageLaunches =>
    launchesOf({
      autoDisable: new ClaudeDebugUsageAutoDisable({
        store: () => store,
        appVersion: () => appVersion,
        cliVersion: async () => cliVersion,
        onBlocked: (notice) => cues.push(notice)
      })
    })

  /** What a launch reported is counted once its CLI version has answered. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }

  /** Decide for a new Code Mode session and start it with what was decided. */
  const launchSession = async (
    launches: ClaudeCliUsageLaunches
  ): Promise<{
    sessionId: string
    transport: ClaudeUsageTransport
    logFile: string | null
    pty: FakePty
  }> => {
    started += 1
    const sessionId = `session-${started}`
    const db = settingsDb()
    const transport = await launches.decide({ db, cliPath: CLI })
    const usage = launches.begin(sessionId, transport, { cwd: WORKTREE, db, cliPath: CLI })
    const pty = spawnPty(sessionId)
    launches.started(sessionId)
    return {
      sessionId,
      transport: usage?.transport ?? 'proxy',
      logFile: usage?.transport === 'debug-log' ? usage.debugLogFile : null,
      pty
    }
  }

  /** One turn of a session: the prompt, what the CLI logs meanwhile, the Stop hook. */
  const turn = async (
    launches: ClaudeCliUsageLaunches,
    session: { sessionId: string; logFile: string | null },
    lines: string[] = []
  ): Promise<void> => {
    launches.noteStatus(session.sessionId, 'working')
    if (session.logFile) for (const line of lines) appendFileSync(session.logFile, `${line}\n`)
    launches.noteStatus(session.sessionId, 'completed')
    await settle()
  }

  /** A new Code Mode session whose log gives nothing to read: a turn, then it is closed. */
  const degradedSession = async (
    launches: ClaudeCliUsageLaunches
  ): Promise<ClaudeUsageTransport> => {
    const session = await launchSession(launches)
    // What an update that renamed the entry leaves: responses were logged, none can be read.
    await turn(launches, session, [REQUEST_LINE, STATUS_LINE, RENAMED_RESPONSE_LINE])
    exitPty(session.pty)
    await settle()
    return session.transport
  }

  /** A new Code Mode session whose log gives a reading. */
  const healthySession = async (
    launches: ClaudeCliUsageLaunches
  ): Promise<ClaudeUsageTransport> => {
    const session = await launchSession(launches)
    await turn(launches, session, [REQUEST_LINE, STATUS_LINE, RESPONSE_LINE])
    exitPty(session.pty)
    await settle()
    return session.transport
  }

  const blockedLaunchLogs = (): unknown[][] =>
    logMock.info.mock.calls.filter(([message]) =>
      String(message).includes('the debug log is switched off for this version')
    )

  beforeEach(() => {
    rows = new Map()
    store = {
      getSetting: (key) => rows.get(key) ?? null,
      setSetting: (key, value) => void rows.set(key, value),
      deleteSetting: (key) => void rows.delete(key)
    }
    cliVersion = '2.1.326'
    appVersion = '1.4.0'
    cues = []
    started = 0
    // Every session below asks for Code Mode and may have it.
    resolveTransport.mockResolvedValue('debug-log')
  })

  it('starts the fourth session without a debug log after three degraded ones, and gives one cue', async () => {
    const launches = startApp()

    expect(await degradedSession(launches)).toBe('debug-log')
    expect(await degradedSession(launches)).toBe('debug-log')
    expect(cues).toEqual([])
    expect(await degradedSession(launches)).toBe('debug-log')
    expect(cues).toEqual([{ provider: 'anthropic', cliVersion: '2.1.326' }])

    const fourth = await launchSession(launches)

    expect(fourth.transport).toBe('none')
    expect(launches.transport(fourth.sessionId)).toBe('none')
    // Nothing was made for it: no directory, no follower.
    expect(launchDirs()).toEqual([])
    expect(source.facts(fourth.sessionId)).toBeNull()
    expect(blockedLaunchLogs()).toHaveLength(1)
  })

  it('counts every reason a log gives no readings for', async () => {
    const launches = startApp()

    // The CLI could not write its log.
    const empty = await launchSession(launches)
    await turn(launches, empty)
    expect(launches.degradedReason(empty.sessionId)).toBe('log-empty')
    // Responses were logged and none can be read.
    const unread = await launchSession(launches)
    await turn(launches, unread, [REQUEST_LINE, STATUS_LINE, RENAMED_RESPONSE_LINE])
    expect(launches.degradedReason(unread.sessionId)).toBe('unparsed-responses')
    // What is at the path is not a file the follower reads.
    const refused = await launchSession(launches)
    rmSync(refused.logFile!)
    symlinkSync(join(base, 'elsewhere.txt'), refused.logFile!)
    writeFileSync(join(base, 'elsewhere.txt'), `${RESPONSE_LINE}\n`)
    await turn(launches, refused)
    expect(launches.degradedReason(refused.sessionId)).toBe('unsafe-file')

    expect((await launchSession(launches)).transport).toBe('none')
  })

  it('starts the count again with a healthy session between failures', async () => {
    const launches = startApp()

    await degradedSession(launches)
    await degradedSession(launches)
    expect(await healthySession(launches)).toBe('debug-log')
    await degradedSession(launches)
    await degradedSession(launches)

    expect((await launchSession(launches)).transport).toBe('debug-log')
    expect(cues).toEqual([])
    expect(blockedLaunchLogs()).toEqual([])
  })

  it('starts the count again with a healthy session that is still running', async () => {
    const launches = startApp()
    await degradedSession(launches)
    await degradedSession(launches)

    // Its first turn gave a reading; it is not closed.
    const running = await launchSession(launches)
    await turn(launches, running, [REQUEST_LINE, STATUS_LINE, RESPONSE_LINE])

    await degradedSession(launches)
    await degradedSession(launches)
    expect((await launchSession(launches)).transport).toBe('debug-log')
    expect(cues).toEqual([])
  })

  it('takes a session whose readings only turn up in the final read as healthy', async () => {
    const launches = startApp()
    await degradedSession(launches)
    await degradedSession(launches)

    // Closed in the middle of its first turn, after a response was logged.
    const session = await launchSession(launches)
    launches.noteStatus(session.sessionId, 'working')
    appendFileSync(session.logFile!, `${RESPONSE_LINE}\n`)
    exitPty(session.pty)
    await settle()

    await degradedSession(launches)
    await degradedSession(launches)
    expect((await launchSession(launches)).transport).toBe('debug-log')
  })

  it('takes a session that recovers as healthy', async () => {
    const launches = startApp()
    await degradedSession(launches)

    // The second failure in a row, until its log is written after all.
    const recovering = await launchSession(launches)
    await turn(launches, recovering)
    expect(launches.degradedReason(recovering.sessionId)).toBe('log-empty')
    await turn(launches, recovering, [RESPONSE_LINE])
    expect(launches.degradedReason(recovering.sessionId)).toBeNull()

    await degradedSession(launches)
    await degradedSession(launches)

    expect((await launchSession(launches)).transport).toBe('debug-log')
    expect(cues).toEqual([])
  })

  it('counts neither a session that made no request nor one that completed no turn', async () => {
    const launches = startApp()
    await degradedSession(launches)
    await degradedSession(launches)

    // A turn without a request: the log has lines, none about a response.
    const quiet = await launchSession(launches)
    await turn(launches, quiet, [STARTUP_LINE])
    expect(launches.degradedReason(quiet.sessionId)).toBeNull()
    exitPty(quiet.pty)
    // Opened and closed.
    const unused = await launchSession(launches)
    exitPty(unused.pty)
    await settle()

    // Neither failed, and neither showed that the log works: the count stands at two.
    expect(cues).toEqual([])
    await degradedSession(launches)
    expect(cues).toHaveLength(1)
    expect((await launchSession(launches)).transport).toBe('none')
  })

  it('does not count a session that degrades after it gave readings', async () => {
    source.dispose()
    source = new ClaudeDebugLogUsageSource({
      submit: (observation) => observations.push(observation),
      setTimer: () => ({}),
      clearTimer: () => {},
      follower: { hardCapBytes: 8 * 1024 }
    })
    const launches = startApp()
    await degradedSession(launches)
    await degradedSession(launches)

    const session = await launchSession(launches)
    await turn(launches, session, [RESPONSE_LINE])
    // Its log passes the hard cap in the next turn and is deleted.
    await turn(
      launches,
      session,
      Array.from({ length: 6 }, () => REQUEST_LINE)
    )
    expect(launches.degradedReason(session.sessionId)).toBe('hard-cap')
    exitPty(session.pty)
    await settle()

    // It counted as healthy: two more failures do not make three.
    await degradedSession(launches)
    await degradedSession(launches)
    expect((await launchSession(launches)).transport).toBe('debug-log')
  })

  it('leaves the sessions that are running on their debug log when the block comes', async () => {
    const launches = startApp()
    const running = await launchSession(launches)

    await degradedSession(launches)
    await degradedSession(launches)
    await degradedSession(launches)

    expect(launches.transport(running.sessionId)).toBe('debug-log')
    await turn(launches, running, [RESPONSE_LINE])
    expect(observations).toHaveLength(1)
    // And what it shows changes nothing for the sessions that start now.
    expect((await launchSession(launches)).transport).toBe('none')
  })

  it('keeps the block across a restart of the app on the same versions', async () => {
    const before = startApp()
    await degradedSession(before)
    await degradedSession(before)
    await degradedSession(before)

    const after = startApp()

    expect((await launchSession(after)).transport).toBe('none')
    expect((await launchSession(after)).transport).toBe('none')
  })

  it('gives sessions their debug log again once the CLI is another version', async () => {
    const launches = startApp()
    await degradedSession(launches)
    await degradedSession(launches)
    await degradedSession(launches)
    expect((await launchSession(launches)).transport).toBe('none')

    // The CLI updated itself while the app runs.
    cliVersion = '2.1.327'

    const session = await launchSession(launches)
    expect(session.transport).toBe('debug-log')
    expect(source.facts(session.sessionId)).not.toBeNull()
    expect(rows.size).toBe(0)
  })

  it('gives sessions their debug log again once the app is another version', async () => {
    const before = startApp()
    await degradedSession(before)
    await degradedSession(before)
    await degradedSession(before)

    appVersion = '1.4.1'
    const after = startApp()

    expect((await launchSession(after)).transport).toBe('debug-log')
    expect(rows.size).toBe(0)
  })

  it('tells the person once: not per session, and not again after a restart', async () => {
    const launches = startApp()
    await degradedSession(launches)
    await degradedSession(launches)
    await degradedSession(launches)
    // The window takes the cue: it claims the notice and shows it.
    expect(cues).toHaveLength(1)
    expect(claimClaudeDebugUsageAutoDisableNotice(store)).toEqual({
      provider: 'anthropic',
      cliVersion: '2.1.326'
    })

    await launchSession(launches)
    await launchSession(launches)
    const after = startApp()
    await launchSession(after)

    expect(cues).toHaveLength(1)
    expect(claimClaudeDebugUsageAutoDisableNotice(store)).toBeNull()
  })

  it('gives the cue again with the next blocked session while no window has claimed the notice', async () => {
    const launches = startApp()
    await degradedSession(launches)
    await degradedSession(launches)
    await degradedSession(launches)
    expect(cues).toHaveLength(1)

    await launchSession(launches)
    expect(cues).toHaveLength(2)

    // Two windows got it: one notice between them.
    expect(claimClaudeDebugUsageAutoDisableNotice(store)).not.toBeNull()
    expect(claimClaudeDebugUsageAutoDisableNotice(store)).toBeNull()
    await launchSession(launches)
    expect(cues).toHaveLength(2)
  })

  it('leaves sessions without Code Mode as they are, before and during the block', async () => {
    const blocks = vi.fn(async () => true)
    const launch = vi.fn(() => ({ degraded: vi.fn(), healthy: vi.fn() }))
    const launches = launchesOf({ autoDisable: { blocks, launch } })
    resolveTransport.mockResolvedValue('proxy')
    const db = settingsDb()

    expect(await launches.decide({ db, cliPath: CLI })).toBe('proxy')
    expect(launches.begin(SESSION, 'proxy', { cwd: WORKTREE, db, cliPath: CLI })).toBeNull()

    // Nobody was asked, nothing is counted, nothing is kept for the session.
    expect(blocks).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(launches.transport(SESSION)).toBeNull()
    expect(events).toEqual([])
    expect(launchDirs()).toEqual([])
  })

  it('stays on the proxy for sessions without Code Mode while the debug log is switched off', async () => {
    const launches = startApp()
    await degradedSession(launches)
    await degradedSession(launches)
    await degradedSession(launches)
    const stored = new Map(rows)

    resolveTransport.mockResolvedValue('proxy')
    const session = await launchSession(launches)

    expect(session.transport).toBe('proxy')
    expect(launches.transport(session.sessionId)).toBeNull()
    expect(rows).toEqual(stored)
    expect(cues).toHaveLength(1)
  })

  it('does not ask about a launch the feature switch already keeps off the debug log', async () => {
    const blocks = vi.fn(async () => true)
    const launch = vi.fn(() => ({ degraded: vi.fn(), healthy: vi.fn() }))
    const launches = launchesOf({ autoDisable: { blocks, launch } })
    resolveTransport.mockResolvedValue('none')
    const db = settingsDb()

    expect(await launches.decide({ db, cliPath: CLI })).toBe('none')
    launches.begin(SESSION, 'none', { cwd: WORKTREE, db, cliPath: CLI })

    expect(blocks).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('asks with the binary the launch will run, and gives the debug log when it cannot ask', async () => {
    const blocks = vi.fn(async (): Promise<boolean> => {
      throw new Error('database is closed')
    })
    const launches = launchesOf({
      autoDisable: {
        blocks,
        launch: () => {
          throw new Error('database is closed')
        }
      }
    })
    const db = settingsDb()

    expect(await launches.decide({ db, cliPath: CLI })).toBe('debug-log')
    expect(blocks).toHaveBeenCalledWith(CLI)
    // And the launch still starts, on its debug log, counted by nobody.
    expect(launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db, cliPath: CLI })).toMatchObject(
      {
        transport: 'debug-log'
      }
    )
    spawnPty(SESSION)
    launches.started(SESSION)
    launches.noteStatus(SESSION, 'working')
    expect(() => launches.noteStatus(SESSION, 'completed')).not.toThrow()
  })

  it('does not count a launch that could not be prepared: it never had a debug log', async () => {
    const launch = vi.fn(() => ({ degraded: vi.fn(), healthy: vi.fn() }))
    const launches = launchesOf({
      autoDisable: { blocks: async () => false, launch },
      dirs: { prepare: () => null, remove: () => {}, sweep: () => {} }
    })

    expect(
      launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb(), cliPath: CLI })
    ).toEqual({
      transport: 'none'
    })

    expect(launch).not.toHaveBeenCalled()
  })

  it('keeps nothing of a log in what it stores and logs', async () => {
    const launches = startApp()
    await degradedSession(launches)
    await degradedSession(launches)
    await degradedSession(launches)
    await launchSession(launches)
    claimClaudeDebugUsageAutoDisableNotice(store)

    const kept = JSON.stringify([
      [...rows],
      cues,
      logMock.warn.mock.calls,
      logMock.info.mock.calls,
      logMock.debug.mock.calls
    ])
    const pieces = [REQUEST_LINE, STATUS_LINE, RENAMED_RESPONSE_LINE].flatMap((line) =>
      line.split(/[\s'"`{},\\]+/).filter((piece) => piece.length >= 12)
    )
    expect(pieces.length).toBeGreaterThan(20)
    for (const piece of pieces) expect(kept.includes(piece)).toBe(false)
  })
})

describePosix('ClaudeCliUsageLaunches.sweep', () => {
  /** A launch directory nobody tracks: what a crashed app process left behind. */
  const leftover = (sessionId: string, instanceId: string): string => {
    const made = new ClaudeCliDebugDirs({ root, instanceId }).prepare(sessionId)
    if (!made) throw new Error('No leftover was made')
    appendFileSync(made.logFile, `${RESPONSE_LINE}\n`)
    return made.dir
  }

  it('deletes what a crash left behind and keeps the directories of live sessions', () => {
    const launches = launchesOf()
    const running = startDebugLogLaunch(launches, SESSION)
    // Prepared, its PTY not there yet: the directory exists before the process does.
    const aboutToStart = launches.begin(OTHER_SESSION, 'debug-log', {
      cwd: WORKTREE,
      db: settingsDb()
    })
    if (aboutToStart?.transport !== 'debug-log') throw new Error('The launch was not prepared')
    const ofDeadApp = leftover('crashed-session', 'app0')
    const ofThisAppEarlier = leftover('gone-session', 'app1')
    aliveInstances.add('app2')
    const ofRunningApp = leftover('their-session', 'app2')

    launches.sweep()

    expect(existsSync(ofDeadApp)).toBe(false)
    expect(existsSync(ofThisAppEarlier)).toBe(false)
    expect(existsSync(running.files.dir)).toBe(true)
    expect(existsSync(dirname(aboutToStart.debugLogFile))).toBe(true)
    // Another app process that is running sweeps after itself.
    expect(existsSync(ofRunningApp)).toBe(true)
    expect(source.facts(SESSION)).not.toBeNull()
    expect(source.facts(OTHER_SESSION)).not.toBeNull()
  })

  it('keeps the directory of a process that was told to end and has not ended yet', () => {
    const launches = launchesOf()
    const { files } = startDebugLogLaunch(launches)
    const pty = destroyPty(SESSION)

    launches.sweep()

    expect(existsSync(files.dir)).toBe(true)
    expect(source.facts(SESSION)).not.toBeNull()

    exitPty(pty)
    expect(existsSync(files.dir)).toBe(false)
  })

  it('ends a launch that is still without a PTY at the next sweep, whatever became of its exit', () => {
    const launches = launchesOf()
    const { files } = startDebugLogLaunch(launches)
    appendFileSync(files.debugLogFile, `${RESPONSE_LINE}\n`)
    // Destroyed, and the end of its process is never reported.
    destroyPty(SESSION)

    launches.sweep()
    expect(existsSync(files.dir)).toBe(true)

    launches.sweep()

    expect(existsSync(files.dir)).toBe(false)
    expect(source.facts(SESSION)).toBeNull()
    expect(observations).toHaveLength(1)
    expect(launches.liveSessionIds().size).toBe(0)
    expect(events).toEqual([`register ${SESSION}`, `unregister ${SESSION}`, `remove ${SESSION}`])
  })

  it('does not count a sweep against a launch whose process runs', () => {
    const launches = launchesOf()
    const { files } = startDebugLogLaunch(launches)

    launches.sweep()
    launches.sweep()
    launches.sweep()

    expect(existsSync(files.dir)).toBe(true)
    expect(source.facts(SESSION)).not.toBeNull()
  })

  it('keeps the directory of a process that was told to end when its session came back on the proxy', () => {
    const launches = launchesOf()
    const first = startDebugLogLaunch(launches)
    const oldPty = destroyPty(SESSION)
    // Restarted without Code Mode: the session's new process has no launch of its own, and
    // the old one, still ending, is all that says the directory is in use.
    expect(launches.begin(SESSION, 'proxy', { cwd: WORKTREE, db: settingsDb() })).toBeNull()
    spawnPty(SESSION)

    launches.sweep()

    expect(launches.liveSessionIds()).toEqual(new Set([SESSION]))
    expect(existsSync(first.files.dir)).toBe(true)

    exitPty(oldPty)
    expect(launchDirs()).toEqual([])
    expect(launches.liveSessionIds().size).toBe(0)
  })

  it('ends a replaced launch whose process never reported its end', () => {
    const launches = launchesOf()
    const first = startDebugLogLaunch(launches)
    destroyPty(SESSION)
    const second = startDebugLogLaunch(launches)

    launches.sweep()
    expect(existsSync(first.files.dir)).toBe(true)
    launches.sweep()

    expect(existsSync(first.files.dir)).toBe(false)
    // The running one is untouched.
    expect(existsSync(second.files.dir)).toBe(true)
    expect(source.facts(SESSION)?.logPath).toBe(second.files.debugLogFile)
  })

  it('never throws', () => {
    const launches = launchesOf({
      dirs: {
        prepare: () => null,
        remove: () => {},
        sweep: () => {
          throw new Error('the data directory is gone')
        }
      }
    })

    expect(() => launches.sweep()).not.toThrow()
  })

  it('sweeps at start and every hour from then on', () => {
    const launches = launchesOf()
    const atStart = leftover('crashed-session', 'app0')

    launches.startSweeping()

    expect(existsSync(atStart)).toBe(false)
    expect(sweepTimers).toHaveLength(1)
    expect(sweepTimers[0].ms).toBe(CLAUDE_CLI_USAGE_SWEEP_INTERVAL_MS)
    expect(CLAUDE_CLI_USAGE_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000)

    const anHourLater = leftover('crashed-later', 'app0')
    sweepTimers[0].fn()
    expect(existsSync(anHourLater)).toBe(false)

    // Asked again, it sweeps once more and keeps its one timer.
    const again = leftover('crashed-again', 'app0')
    launches.startSweeping()
    expect(existsSync(again)).toBe(false)
    expect(sweepTimers).toHaveLength(1)

    // The app quits: no sweep while its PTYs are being ended.
    launches.quit()
    expect(sweepTimers[0].cleared).toBe(true)
  })

  it('does not keep the process alive for its hourly sweep', () => {
    vi.useFakeTimers()
    try {
      const unref = vi.fn()
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>)
      const launches = launchesOf({ setInterval: undefined, clearInterval: undefined })

      launches.startSweeping()

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        CLAUDE_CLI_USAGE_SWEEP_INTERVAL_MS
      )
      expect(unref).toHaveBeenCalledTimes(1)
      launches.stopSweeping()
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })
})

describe('ClaudeCliUsageLaunches on a platform without launch directories', () => {
  it('starts a Code Mode launch without live usage', () => {
    const windowsDirs = new ClaudeCliDebugDirs({ root, instanceId: 'app1', platform: 'win32' })
    const launches = launchesOf({
      dirs: {
        prepare: (sessionId, options) => windowsDirs.prepare(sessionId, options),
        remove: (launch: Pick<ClaudeCliDebugLaunch, 'dir'>) => windowsDirs.remove(launch),
        sweep: (live) => windowsDirs.sweep(live)
      }
    })

    expect(launches.begin(SESSION, 'debug-log', { cwd: WORKTREE, db: settingsDb() })).toEqual({
      transport: 'none'
    })
    expect(existsSync(root)).toBe(false)
    expect(source.stats().sessions).toBe(0)
  })
})
