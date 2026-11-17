/* eslint-disable @typescript-eslint/no-explicit-any */
// The usage transport of a Claude CLI session, from the start of its process to its end
// (Code Mode T17): what `createClaudeCliTerminal` prepares and launches for a session that
// asks for Code Mode, what it leaves alone for one that does not, and what each way of
// ending a session does to the launch.
//
// The real pieces are in play: the transport decision (reading Settings → Environment
// Variables from the stubbed database and an empty Claude config dir), the launch
// directories in a temporary place, the debug-log usage source with a collecting `submit`,
// and the spawn builder. Only the PTYs are stand-ins: destroying one forgets its id at
// once, and its process ends when a test says so, as node-pty reports it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

interface FakePty {
  readonly options: {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string>
    unsetEnv?: readonly string[]
  }
  readonly exitListeners: Array<(code: number, signal: number) => void>
}

const mocks = vi.hoisted(() => {
  const ptys = new Map<string, any>()
  const statusSubscribers = new Set<(payload: unknown) => void>()
  return {
    ptys,
    statusSubscribers,
    getDatabase: vi.fn(),
    getClaudeHookServer: vi.fn(),
    buildClaudeCliHookSettings: vi.fn(),
    publishClaudeCliStatus: vi.fn(),
    publishDesktopBackendEvent: vi.fn(),
    ptyService: {
      has: vi.fn((id: string) => ptys.has(id)),
      // As the real one: a PTY that exists under the id is reused, whatever was asked for.
      create: vi.fn((id: string, options: any) => {
        if (!ptys.has(id)) ptys.set(id, { options, exitListeners: [] })
        return { cols: 120, rows: 40 }
      }),
      onData: vi.fn(() => vi.fn()),
      // On the PTY itself: a listener outlives the id being forgotten.
      onExit: vi.fn((id: string, callback: (code: number, signal: number) => void) => {
        const pty = ptys.get(id)
        if (!pty) return () => {}
        pty.exitListeners.push(callback)
        return () => {
          const index = pty.exitListeners.indexOf(callback)
          if (index !== -1) pty.exitListeners.splice(index, 1)
        }
      }),
      write: vi.fn(),
      resize: vi.fn(),
      // The id is forgotten at once; the process ends later.
      destroy: vi.fn((id: string) => {
        ptys.delete(id)
      }),
      destroyAll: vi.fn(),
      destroyAllAndReap: vi.fn(async () => {
        ptys.clear()
      })
    }
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class {},
  // The app's version is what a switch-off of the debug log is kept for (T19).
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.4.0') }
}))

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LoggerService: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
}))

vi.mock('./pty-service', () => ({
  ptyService: mocks.ptyService
}))

vi.mock('./ghostty-service', () => ({
  ghosttyService: { shutdown: vi.fn() }
}))

vi.mock('./ghostty-config', () => ({
  parseGhosttyConfig: vi.fn(() => ({}))
}))

vi.mock('../db', () => ({
  getDatabase: mocks.getDatabase
}))

vi.mock('./claude-binary-resolver', () => ({
  resolveClaudeBinaryPath: vi.fn(() => '/usr/local/bin/claude'),
  logClaudeBinaryVersion: vi.fn(),
  getClaudeBinaryVersion: vi.fn((path: string) =>
    path === '/usr/local/bin/claude' ? '2.1.326' : null
  ),
  // What the binary on disk reports when a launch asks it (T19).
  readClaudeBinaryVersion: vi.fn(async (path: string) =>
    path === '/usr/local/bin/claude' ? '2.1.326' : null
  )
}))

vi.mock('./codex-binary-resolver', () => ({
  resolveCodexBinaryPath: vi.fn(() => '/usr/local/bin/codex')
}))

vi.mock('./codex-cli-rollout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codex-cli-rollout')>()),
  watchForCodexSessionId: vi.fn(() => ({ close: vi.fn() }))
}))

vi.mock('./claude-cli-plan-handoff', () => ({
  externalizeGoalHandoffPlan: vi.fn((prompt: string) => prompt)
}))

vi.mock('./claude-trust', () => ({
  ensureProjectTrustCheck: vi.fn(async () => {}),
  reassertSessionFolderTrust: vi.fn(async () => ({ wasMissing: true }))
}))

vi.mock('./claude-cli-pty-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-cli-pty-prompt')>()),
  reassertClaudeCliPromptSubmit: vi.fn()
}))

vi.mock('./claude-session-watcher', () => ({
  watchForClaudeSessionId: vi.fn(() => ({ close: vi.fn() }))
}))

vi.mock('./claude-plan-followup-watcher', () => ({
  watchForClaudePlanFollowup: vi.fn(() => ({ close: vi.fn() }))
}))

vi.mock('./claude-hook-server', () => ({
  getClaudeHookServer: mocks.getClaudeHookServer,
  buildClaudeCliHookSettings: mocks.buildClaudeCliHookSettings,
  getLastClaudeCliStatus: vi.fn(),
  publishClaudeCliStatus: mocks.publishClaudeCliStatus,
  resetClaudeCliBackgroundWork: vi.fn(),
  subscribeClaudeCliStatus: vi.fn((subscriber: (payload: unknown) => void) => {
    mocks.statusSubscribers.add(subscriber)
    return () => mocks.statusSubscribers.delete(subscriber)
  }),
  subscribeCliHookEvents: vi.fn(() => vi.fn())
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

// The real builder, wrapped so that a test can see what the bridge asked it for.
vi.mock('./claude-cli-spawner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claude-cli-spawner')>()
  return { ...actual, buildClaudeCliPtySpawn: vi.fn(actual.buildClaudeCliPtySpawn) }
})

import type { Session } from '../db/types'
import {
  CLAUDE_CODE_MODE_USAGE_UNAVAILABLE_CHANNEL,
  CLAUDE_LIVE_USAGE_HEALTH_CHANNEL,
  isClaudeCodeModeUsageUnavailablePayload,
  isClaudeLiveUsageHealthPayload
} from '@shared/types/claude-live-usage'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import type { ClaudeUsageObservation } from './claude-api-proxy/claude-usage-live-updater'
import { setClaudeApiProxyBaseUrl } from './claude-api-proxy/claude-api-proxy-env'
import { getClaudeBinaryVersion, readClaudeBinaryVersion } from './claude-binary-resolver'
import { CLAUDE_CLI_DEBUG_DIRNAME, ClaudeCliDebugDirs } from './claude-cli-debug-dir'
import { buildClaudeCliPtySpawn } from './claude-cli-spawner'
import type { ClaudeCliUsageLaunches } from './claude-cli-usage-launches'
import {
  __setClaudeCliUsageLaunchesForTests,
  createClaudeCliUsageLaunches,
  startClaudeCliUsageSweeps
} from './claude-cli-usage-launches-live'
import {
  __resetClaudeDebugLogUsageSourceForTests,
  getClaudeDebugLogUsageSource
} from './claude-debug-log/claude-debug-log-usage'
import { ClaudeDebugLogUsageSource } from './claude-debug-log/claude-debug-log-usage-source'
import {
  CLAUDE_DEBUG_USAGE_AUTO_DISABLE_STATE_KEY,
  claimClaudeDebugUsageAutoDisableNotice
} from './claude-debug-log/claude-debug-usage-auto-disable'
import { resolveClaudeUsageTransport } from './claude-usage-transport'
import {
  cleanupTerminals,
  createClaudeCliTerminal,
  destroyNodePtyTerminal,
  reapCliTerminal
} from './terminal-pty-bridge'
import { __resetRuntimeRegistryForTests } from '../effect/_shared/runtime'

// Owner-only directories and a POSIX shell file: the launch directories exist on POSIX only.
const describePosix = describe.skipIf(process.platform === 'win32')

const SESSION = 'hive-session-1'
const WORKTREE = '/repo/worktree'
/** The app's API proxy, as it exports itself on the app's environment while it runs. */
const PROXY_URL = 'http://127.0.0.1:47999'
const PROXY_VARIABLES = ['ANTHROPIC_BASE_URL', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL']
const CODE_MODE = { key: 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', value: '1' }

/** A streaming 200 with usage headers and an organization, as the CLI logs it (T05 fixture). */
const RESPONSE_LINE = readFileSync(
  join(__dirname, 'claude-debug-log', '__fixtures__', 'response-start-streaming.txt'),
  'utf8'
)
  .split('\n')
  .filter((line) => line !== '')[0]

let base: string
/** `<data dir>/claude-cli-debug`. */
let root: string
let aliveInstances: Set<string>
let observations: ClaudeUsageObservation[]
let source: ClaudeDebugLogUsageSource
let launches: ClaudeCliUsageLaunches
/** An empty Claude config dir: the decision reads this one, never the developer's own. */
let claudeConfigDir: string
/** The real transport decision, wrapped so that a test can see when it was asked. */
let resolveTransport: ReturnType<typeof vi.fn<typeof resolveClaudeUsageTransport>>
/** The hourly sweep, when it was asked for. */
let sweepTimers: Array<{ fn: () => void; ms: number }>
/** The rows of the `settings` table the app itself writes: they outlive a restart (T19). */
let settingsRows: Map<string, string>

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'haiku',
    model_variant: null,
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  } as Session
}

/**
 * The database the bridge reads: one session, and the settings blob the renderer saves
 * (Settings → Environment Variables, the Advanced switch, custom providers).
 */
function setupDb(
  settings: Record<string, unknown> = {},
  session: Session = makeSession()
): { session: Session } {
  const state = { session }
  mocks.getDatabase.mockReturnValue({
    getSession: vi.fn(() => state.session),
    getWorktree: vi.fn(() => ({ path: WORKTREE })),
    getConnection: vi.fn(() => ({ path: '/repo/connection' })),
    getProject: vi.fn(() => ({ id: session.project_id, path: '/repo', kind: 'git' })),
    getSetting: vi.fn((key: string) =>
      key === APP_SETTINGS_DB_KEY ? JSON.stringify(settings) : (settingsRows.get(key) ?? null)
    ),
    setSetting: vi.fn((key: string, value: string) => void settingsRows.set(key, value)),
    deleteSetting: vi.fn((key: string) => void settingsRows.delete(key)),
    getSessionByClaudeSessionId: vi.fn(() => null),
    updateSession: vi.fn(),
    updateProjectTrustCheck: vi.fn()
  })
  return state
}

const codeModeSettings = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  environmentVariables: [CODE_MODE],
  ...extra
})

const pty = (sessionId = SESSION): FakePty => {
  const found = mocks.ptys.get(sessionId) as FakePty | undefined
  if (!found) throw new Error(`No PTY for ${sessionId}`)
  return found
}

/**
 * The process of a PTY ends, as pty-service.ts reports it: whoever still listens is called in
 * a row over the list itself (a listener that takes itself off meanwhile costs the next one
 * its turn), then the id is forgotten if it still names this PTY.
 */
const exitPty = (ended: FakePty, code = 0): void => {
  for (const listener of ended.exitListeners) listener(code, 0)
  for (const [sessionId, known] of mocks.ptys) if (known === ended) mocks.ptys.delete(sessionId)
}

/** The launch directories on disk, by name. */
const launchDirs = (): string[] => (existsSync(root) ? readdirSync(root).sort() : [])

/** The value that follows an option on a command line. */
const argAfter = (args: string[], option: string): string | undefined => {
  const index = args.indexOf(option)
  return index === -1 ? undefined : args[index + 1]
}

const lastBuilderInput = (): Record<string, unknown> =>
  vi.mocked(buildClaudeCliPtySpawn).mock.calls.at(-1)![0] as unknown as Record<string, unknown>

const tellStatus = (status: string, sessionId = SESSION): void => {
  for (const subscriber of [...mocks.statusSubscribers]) subscriber({ sessionId, status })
}

/**
 * The launches as the app builds them, over this test's directories, usage source and
 * environment. `env` adds to what the app's environment holds that the decision reads; it
 * never holds anything of the developer's.
 */
function installLaunches(
  env: NodeJS.ProcessEnv = {},
  { appSource = false }: { appSource?: boolean } = {}
): ClaudeCliUsageLaunches {
  launches = createClaudeCliUsageLaunches({
    dirs: new ClaudeCliDebugDirs({
      root,
      instanceId: 'app1',
      isInstanceAlive: (instanceId) => aliveInstances.has(instanceId)
    }),
    // Left out, the launches follow their logs with the source the app itself uses.
    ...(appSource ? {} : { source }),
    resolveTransport,
    env: { ANTHROPIC_BASE_URL: PROXY_URL, CLAUDE_CONFIG_DIR: claudeConfigDir, ...env },
    setInterval: (fn, ms) => {
      sweepTimers.push({ fn, ms })
      return sweepTimers.length
    },
    clearInterval: () => {}
  })
  __setClaudeCliUsageLaunchesForTests(launches)
  return launches
}

beforeEach(() => {
  mocks.ptys.clear()
  mocks.statusSubscribers.clear()
  vi.clearAllMocks()
  __resetRuntimeRegistryForTests()

  base = mkdtempSync(join(tmpdir(), 'bridge-usage-launch-'))
  root = join(base, 'data', CLAUDE_CLI_DEBUG_DIRNAME)
  mkdirSync(dirname(root))
  claudeConfigDir = join(base, 'claude-config')
  mkdirSync(claudeConfigDir)
  aliveInstances = new Set()
  observations = []
  sweepTimers = []
  settingsRows = new Map()

  // The proxy runs: its address is on the app's environment, where every PTY inherits it.
  setClaudeApiProxyBaseUrl(PROXY_URL)
  vi.stubEnv('ANTHROPIC_BASE_URL', PROXY_URL)

  source = new ClaudeDebugLogUsageSource({
    submit: (observation) => observations.push(observation),
    // The source's own timer never fires here: a log is read when a launch ends.
    setTimer: () => ({}),
    clearTimer: () => {}
  })
  resolveTransport = vi.fn(resolveClaudeUsageTransport)
  installLaunches()

  setupDb()
  mocks.getClaudeHookServer.mockResolvedValue({ port: 45678 })
  mocks.buildClaudeCliHookSettings.mockReturnValue('{"hooks":{"mock":true}}')
  mocks.publishDesktopBackendEvent.mockResolvedValue(true)
})

afterEach(async () => {
  await cleanupTerminals()
  __setClaudeCliUsageLaunchesForTests(null)
  source.dispose()
  setClaudeApiProxyBaseUrl(null)
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

describe('a Claude CLI session that does not ask for Code Mode', () => {
  it('launches through the proxy as before: nothing prepared, nothing followed', async () => {
    const result = await createClaudeCliTerminal(SESSION, { pendingPrompt: 'Say hi' })

    expect(result).toEqual({ success: true, cols: 120, rows: 40 })
    expect(lastBuilderInput()).not.toHaveProperty('usage')
    const { options } = pty()
    expect(options.env).toMatchObject({
      ANTHROPIC_BASE_URL: PROXY_URL,
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1'
    })
    expect(options).not.toHaveProperty('unsetEnv')
    expect(options.args.join(' ')).not.toContain('--debug')
    expect(options.env).not.toHaveProperty('ANTHROPIC_LOG')
    expect(options.env).not.toHaveProperty('CLAUDE_ENV_FILE')
    expect(existsSync(root)).toBe(false)
    expect(source.stats().sessions).toBe(0)
    expect(launches.transport(SESSION)).toBeNull()
    // The bridge's own exit listener, and no other.
    expect(pty().exitListeners).toHaveLength(1)
  })

  it('ends as before, by every route', async () => {
    // Its process exits: the terminal's own exit handling, and nothing else, hears of it.
    await createClaudeCliTerminal(SESSION)
    expect(pty().exitListeners).toHaveLength(1)
    exitPty(pty())
    await vi.waitFor(() =>
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(`terminal:exit:${SESSION}`, 0)
    )

    // It is closed.
    await createClaudeCliTerminal(SESSION)
    expect(pty().exitListeners).toHaveLength(1)
    destroyNodePtyTerminal(SESSION)
    expect(mocks.ptyService.destroy).toHaveBeenCalledWith(SESSION)

    // The app quits.
    await createClaudeCliTerminal(SESSION)
    await cleanupTerminals()
    expect(mocks.ptyService.destroyAllAndReap).toHaveBeenCalledTimes(1)

    // No usage launch was ever involved.
    expect(launches.liveSessionIds().size).toBe(0)
    expect(existsSync(root)).toBe(false)
    expect(source.stats().sessions).toBe(0)
  })

  it('does not strand the prompt of a launch that arrives while the mounting view is being decided for', async () => {
    // The decision reads a file. Each read ends in a turn of the event loop of its own.
    const decided: Array<() => void> = []
    resolveTransport.mockImplementation(
      () => new Promise((resolve) => decided.push(() => resolve('proxy')))
    )

    // The session view mounts, without a prompt...
    const view = createClaudeCliTerminal(SESSION)
    await vi.waitFor(() => expect(decided).toHaveLength(1))
    // ...and the launch path brings the prompt while that decision is still being read.
    const launch = createClaudeCliTerminal(SESSION, { pendingPrompt: 'Say hi' })
    await vi.waitFor(() => expect(decided).toHaveLength(2))
    decided[0]()
    await new Promise((resolve) => setImmediate(resolve))
    decided[1]()

    expect(await view).toMatchObject({ success: true })
    expect(await launch).toMatchObject({ success: true })
    // The view started the process, so the launch found it running and pasted its prompt:
    // neither wait sat between a start's look at the PTY and its spawn.
    expect(mocks.ptys.size).toBe(1)
    expect(pty().options.args).not.toContain('Say hi')
    const pasted = (mocks.ptyService.write.mock.calls as unknown[][]).filter(
      ([id, data]) => id === SESSION && String(data).includes('Say hi')
    )
    expect(pasted).toHaveLength(1)
  })

  it('stays on the proxy when the setting says 0, whatever the shell exported', async () => {
    setupDb({ environmentVariables: [{ key: CODE_MODE.key, value: '0' }] })
    // The app was started from a shell that exports the variable.
    installLaunches({ [CODE_MODE.key]: '1' })

    await createClaudeCliTerminal(SESSION)

    // Decided, once, and for the proxy: Settings come before the environment.
    expect(resolveTransport).toHaveBeenCalledTimes(1)
    await expect(resolveTransport.mock.results[0].value).resolves.toBe('proxy')
    expect(lastBuilderInput()).not.toHaveProperty('usage')
    expect(pty().options.env).toMatchObject({ ANTHROPIC_BASE_URL: PROXY_URL })
    expect(existsSync(root)).toBe(false)
  })
})

describePosix('a Claude CLI session that asks for Code Mode, with live usage on', () => {
  beforeEach(() => {
    setupDb(codeModeSettings())
  })

  it('prepares one directory, follows its log and launches with the debug-log arguments', async () => {
    const result = await createClaudeCliTerminal(SESSION, { pendingPrompt: 'Say hi' })

    expect(result).toEqual({ success: true, cols: 120, rows: 40 })
    expect(launchDirs()).toHaveLength(1)
    const dir = join(root, launchDirs()[0])
    expect(launchDirs()[0]).toMatch(new RegExp(`^${SESSION}-app1-[0-9a-f]{16}$`))
    expect(lstatSync(dir).mode & 0o777).toBe(0o700)

    // Registered with the usage source, under the session's id and this launch's log.
    expect(source.stats().sessions).toBe(1)
    expect(source.facts(SESSION)?.logPath).toBe(join(dir, 'usage.log'))
    expect(launches.transport(SESSION)).toBe('debug-log')

    // The launch T15 builds for those files.
    expect(lastBuilderInput().usage).toEqual({
      transport: 'debug-log',
      debugLogFile: join(dir, 'usage.log'),
      envFile: join(dir, 'env.sh')
    })
    const { options } = pty()
    expect(argAfter(options.args, '--debug-file')).toBe(join(dir, 'usage.log'))
    expect(options.args).toContain('--debug=console.log')
    // Options first, the prompt last.
    expect(options.args.at(-1)).toBe('Say hi')
    expect(options.args.indexOf('--debug-file')).toBeLessThan(options.args.length - 1)
    expect(options.env).toMatchObject({
      ANTHROPIC_LOG: 'debug',
      CLAUDE_ENV_FILE: join(dir, 'env.sh'),
      CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1'
    })
    // Off the proxy: its variables are neither given nor inherited.
    for (const name of PROXY_VARIABLES) expect(options.env).not.toHaveProperty(name)
    expect(options.unsetEnv).toEqual(PROXY_VARIABLES)
    expect(readFileSync(join(dir, 'env.sh'), 'utf8')).toBe('unset ANTHROPIC_LOG\n')
  })

  it("follows the log with the app's own usage source, the one that feeds the live updater", async () => {
    installLaunches({}, { appSource: true })
    try {
      await createClaudeCliTerminal(SESSION)

      const logFile = join(root, launchDirs()[0], 'usage.log')
      expect(getClaudeDebugLogUsageSource().facts(SESSION)?.logPath).toBe(logFile)
      expect(source.stats().sessions).toBe(0)

      exitPty(pty())
      expect(getClaudeDebugLogUsageSource().facts(SESSION)).toBeNull()
      expect(launchDirs()).toEqual([])
    } finally {
      __resetClaudeDebugLogUsageSourceForTests()
    }
  })

  it('takes the request from the environment the app runs in as well', async () => {
    // Nothing in Settings: the shell the app was started from exports the variable.
    setupDb()
    installLaunches({ [CODE_MODE.key]: '1' })

    await createClaudeCliTerminal(SESSION)

    await expect(resolveTransport.mock.results[0].value).resolves.toBe('debug-log')
    expect(launchDirs()).toHaveLength(1)
    expect(argAfter(pty().options.args, '--debug-file')).toBe(
      join(root, launchDirs()[0], 'usage.log')
    )
  })

  it('follows the log before the process exists', async () => {
    let followedAtSpawn: string | undefined
    let dirsAtSpawn = -1
    mocks.ptyService.create.mockImplementationOnce((id: string, options: any) => {
      followedAtSpawn = source.facts(id)?.logPath
      dirsAtSpawn = launchDirs().length
      mocks.ptys.set(id, { options, exitListeners: [] })
      return { cols: 120, rows: 40 }
    })

    await createClaudeCliTerminal(SESSION)

    expect(dirsAtSpawn).toBe(1)
    expect(followedAtSpawn).toBe(join(root, launchDirs()[0], 'usage.log'))
  })

  it("chains the user's own environment file from Settings", async () => {
    setupDb(
      codeModeSettings({
        environmentVariables: [CODE_MODE, { key: 'CLAUDE_ENV_FILE', value: 'my env.sh' }]
      })
    )

    await createClaudeCliTerminal(SESSION)

    const envFile = pty().options.env.CLAUDE_ENV_FILE
    // The session is pointed at the app's file, which sources theirs from where the CLI starts.
    expect(envFile).toBe(join(root, launchDirs()[0], 'env.sh'))
    expect(readFileSync(envFile, 'utf8')).toBe(
      "if [ -f '/repo/worktree/my env.sh' ]; then . '/repo/worktree/my env.sh'; fi\n" +
        'unset ANTHROPIC_LOG\n'
    )
  })

  it('prepares and follows nothing again when a view attaches to the running session', async () => {
    await createClaudeCliTerminal(SESSION, { pendingPrompt: 'Say hi' })
    const [dir] = launchDirs()
    const registeredAt = source.facts(SESSION)?.registeredAt
    expect(resolveTransport).toHaveBeenCalledTimes(1)
    const builderCalls = vi.mocked(buildClaudeCliPtySpawn).mock.calls.length

    // The session view mounts, then the ticket modal: both come through here.
    await createClaudeCliTerminal(SESSION)
    await createClaudeCliTerminal(SESSION, { pendingPrompt: 'Say hi' })

    expect(launchDirs()).toEqual([dir])
    expect(source.stats().sessions).toBe(1)
    expect(source.facts(SESSION)?.registeredAt).toBe(registeredAt)
    expect(source.facts(SESSION)?.logPath).toBe(join(root, dir, 'usage.log'))
    // Not decided again either: the process keeps the transport it was started with.
    expect(resolveTransport).toHaveBeenCalledTimes(1)
    expect(vi.mocked(buildClaudeCliPtySpawn).mock.calls.length).toBe(builderCalls + 2)
    expect(lastBuilderInput()).not.toHaveProperty('usage')
    expect(mocks.ptys.size).toBe(1)
    expect(pty().exitListeners).toHaveLength(2)
  })

  it('decides again for a process started in place of one that went away meanwhile', async () => {
    await createClaudeCliTerminal(SESSION)
    const [oldDir] = launchDirs()
    const oldProcess = pty()
    // A view attaches: it sees the PTY. While it waits for the hook server, the session is
    // closed from elsewhere, and what this call then starts is a new process.
    mocks.getClaudeHookServer.mockImplementationOnce(async () => {
      destroyNodePtyTerminal(SESSION)
      return { port: 45678 }
    })

    await createClaudeCliTerminal(SESSION)

    // The new process was decided for and has a launch of its own...
    expect(resolveTransport).toHaveBeenCalledTimes(2)
    const newDir = launchDirs().find((name) => name !== oldDir)!
    expect(newDir).toBeDefined()
    expect(pty()).not.toBe(oldProcess)
    expect(argAfter(pty().options.args, '--debug-file')).toBe(join(root, newDir, 'usage.log'))
    for (const name of PROXY_VARIABLES) expect(pty().options.env).not.toHaveProperty(name)
    expect(source.facts(SESSION)?.logPath).toBe(join(root, newDir, 'usage.log'))
    // ...and the old one keeps its directory until it has ended.
    expect(launchDirs()).toHaveLength(2)
    exitPty(oldProcess)
    expect(launchDirs()).toEqual([newDir])
    expect(source.facts(SESSION)?.logPath).toBe(join(root, newDir, 'usage.log'))
  })

  it('prepares one directory when two starts of the session race', async () => {
    // The launch path and the mounting view: neither sees a PTY when it begins.
    const [first, second] = await Promise.all([
      createClaudeCliTerminal(SESSION, { pendingPrompt: 'Say hi' }),
      createClaudeCliTerminal(SESSION, { pendingPrompt: 'Say hi' })
    ])

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(launchDirs()).toHaveLength(1)
    expect(source.stats().sessions).toBe(1)
    const dir = join(root, launchDirs()[0])
    expect(source.facts(SESSION)?.logPath).toBe(join(dir, 'usage.log'))
    // The process that runs is the one that was told about that directory.
    expect(argAfter(pty().options.args, '--debug-file')).toBe(join(dir, 'usage.log'))
    expect(mocks.ptyService.create).toHaveBeenCalledTimes(2)
  })

  it('reads faster while the turn runs, from the hook status of the session', async () => {
    await createClaudeCliTerminal(SESSION)
    expect(source.facts(SESSION)?.turnInProgress).toBe(false)

    tellStatus('working')
    expect(source.facts(SESSION)?.turnInProgress).toBe(true)

    appendFileSync(source.facts(SESSION)!.logPath, `${RESPONSE_LINE}\n`)
    tellStatus('completed')
    expect(source.facts(SESSION)?.turnInProgress).toBe(false)
    // The end of a turn reads the log at once.
    expect(observations).toHaveLength(1)
  })

  it('tells the usage UI when a turn completes over a log that stayed empty, and when it gives readings again (T18)', async () => {
    await createClaudeCliTerminal(SESSION)
    const healthEvents = (): unknown[] =>
      mocks.publishDesktopBackendEvent.mock.calls
        .filter(([channel]) => channel === CLAUDE_LIVE_USAGE_HEALTH_CHANNEL)
        .map(([, payload]) => payload)

    // Reported idle before any turn: an empty log is no trouble yet.
    tellStatus('completed')
    expect(healthEvents()).toEqual([])

    tellStatus('working')
    tellStatus('completed')

    expect(launches.degradedReason(SESSION)).toBe('log-empty')
    expect(healthEvents()).toEqual([
      {
        provider: 'anthropic',
        sessionId: SESSION,
        degraded: true,
        reason: 'log-empty',
        at: expect.any(Number)
      }
    ])
    expect(healthEvents().every(isClaudeLiveUsageHealthPayload)).toBe(true)
    // The warning names the version of the binary this launch runs.
    expect(vi.mocked(getClaudeBinaryVersion)).toHaveBeenCalledWith('/usr/local/bin/claude')
    // The session itself is untouched: same process, still followed.
    expect(mocks.ptyService.destroy).not.toHaveBeenCalled()
    expect(source.facts(SESSION)).not.toBeNull()

    tellStatus('working')
    appendFileSync(source.facts(SESSION)!.logPath, `${RESPONSE_LINE}\n`)
    tellStatus('completed')

    expect(launches.degradedReason(SESSION)).toBeNull()
    expect(observations).toHaveLength(1)
    // The reading says whose log it came from.
    expect(observations[0].sessionId).toBe(SESSION)
    expect(healthEvents()).toHaveLength(2)
    expect(healthEvents()[1]).toMatchObject({ sessionId: SESSION, degraded: false, reason: null })
  })

  it('never judges a session that goes through the proxy', async () => {
    resolveTransport.mockResolvedValue('proxy')
    await createClaudeCliTerminal(SESSION)

    tellStatus('working')
    tellStatus('completed')

    expect(launches.degradedReason(SESSION)).toBeNull()
    expect(
      mocks.publishDesktopBackendEvent.mock.calls.filter(
        ([channel]) => channel === CLAUDE_LIVE_USAGE_HEALTH_CHANNEL
      )
    ).toEqual([])
  })

  describe('ends its launch', () => {
    /** A started session with a response in its log that no scheduled check has read. */
    const startWithUnreadResponse = async (): Promise<{ dir: string; process: FakePty }> => {
      await createClaudeCliTerminal(SESSION)
      const dir = join(root, launchDirs()[0])
      appendFileSync(join(dir, 'usage.log'), `${RESPONSE_LINE}\n`)
      return { dir, process: pty() }
    }

    const expectEnded = (dir: string): void => {
      expect(existsSync(dir)).toBe(false)
      expect(launchDirs()).toEqual([])
      expect(source.stats().sessions).toBe(0)
      expect(source.facts(SESSION)).toBeNull()
      expect(launches.transport(SESSION)).toBeNull()
      // The final read: what the CLI logged last still counts.
      expect(observations).toHaveLength(1)
    }

    it('when the process exits', async () => {
      const { dir, process } = await startWithUnreadResponse()

      exitPty(process)

      expectEnded(dir)
    })

    it("and leaves the terminal's own exit handling its turn", async () => {
      const { dir, process } = await startWithUnreadResponse()
      mocks.publishClaudeCliStatus.mockClear()

      // The launch and the terminal listen on the same PTY, the launch first.
      exitPty(process, 0)

      expectEnded(dir)
      expect(mocks.publishClaudeCliStatus).toHaveBeenCalledWith({
        sessionId: SESSION,
        status: 'completed',
        metadata: { reason: 'pty_exit' }
      })
      await vi.waitFor(() =>
        expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(`terminal:exit:${SESSION}`, 0)
      )
    })

    it('when the session is closed, once its process has ended', async () => {
      const { dir, process } = await startWithUnreadResponse()

      destroyNodePtyTerminal(SESSION)

      // The CLI was told to end and may still run: its directory stays out of its way.
      expect(mocks.ptyService.destroy).toHaveBeenCalledWith(SESSION)
      expect(existsSync(dir)).toBe(true)
      expect(source.facts(SESSION)).not.toBeNull()

      exitPty(process, 129)

      expectEnded(dir)
    })

    it('when the session is reaped, once its process has ended', async () => {
      const { dir, process } = await startWithUnreadResponse()

      expect(reapCliTerminal(SESSION)).toBe(true)
      expect(existsSync(dir)).toBe(true)

      exitPty(process, 129)

      expectEnded(dir)
      // A reaped session keeps the terminal's exit handling, which tells the view it ended.
      await vi.waitFor(() =>
        expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
          `terminal:exit:${SESSION}`,
          129
        )
      )
    })

    it('when the app quits, once its processes have been ended', async () => {
      const { dir } = await startWithUnreadResponse()
      let finishReap!: () => void
      mocks.ptyService.destroyAllAndReap.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishReap = () => {
              mocks.ptys.clear()
              resolve()
            }
          })
      )

      const quit = cleanupTerminals()
      await new Promise((resolve) => setImmediate(resolve))

      // The processes are being ended: nothing is read for the last time or deleted yet.
      expect(mocks.ptyService.destroyAllAndReap).toHaveBeenCalledTimes(1)
      expect(existsSync(dir)).toBe(true)
      expect(source.facts(SESSION)).not.toBeNull()
      expect(observations).toHaveLength(0)

      finishReap()
      await quit

      expectEnded(dir)
    })

    it('but not at a quit that could not end its processes', async () => {
      const { dir } = await startWithUnreadResponse()
      mocks.ptyService.destroyAllAndReap.mockImplementationOnce(async () => {
        throw new Error('reap failed')
      })

      await expect(cleanupTerminals()).rejects.toThrow('reap failed')

      // Its last lines count and its log is let go of; the directory of a CLI that may
      // still run stays, private, for the next start.
      expect(observations).toHaveLength(1)
      expect(source.stats().sessions).toBe(0)
      expect(launches.transport(SESSION)).toBeNull()
      expect(existsSync(dir)).toBe(true)
      expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    })

    it('but not at a quit that follows its close before its process has ended', async () => {
      const { dir } = await startWithUnreadResponse()
      // Closed a moment before the quit: told to end, and no PTY left for the quit to reap.
      destroyNodePtyTerminal(SESSION)

      await cleanupTerminals()

      // Its last lines count and its log is let go of...
      expect(observations).toHaveLength(1)
      expect(source.stats().sessions).toBe(0)
      expect(launches.transport(SESSION)).toBeNull()
      // ...but nothing says its CLI is gone, and one that still runs would make a deleted
      // directory again, readable by others. It stays private, for the next start:
      expect(existsSync(dir)).toBe(true)
      expect(lstatSync(dir).mode & 0o777).toBe(0o700)
      // the app process that made it is gone by then, and everything of it is swept.
      new ClaudeCliDebugDirs({ root, instanceId: 'app2', isInstanceAlive: () => false }).sweep(
        new Set()
      )
      expect(launchDirs()).toEqual([])
    })

    it('unregisters before it deletes the directory', async () => {
      const { dir, process } = await startWithUnreadResponse()
      const order: string[] = []
      const unregister = vi.spyOn(source, 'unregister').mockImplementation((sessionId) => {
        order.push(`unregister, directory ${existsSync(dir) ? 'there' : 'gone'}`)
        return ClaudeDebugLogUsageSource.prototype.unregister.call(source, sessionId)
      })

      exitPty(process)

      expect(order).toEqual(['unregister, directory there'])
      expect(existsSync(dir)).toBe(false)
      unregister.mockRestore()
    })
  })

  it('gives a resumed session a new directory and nothing of the old one', async () => {
    const state = setupDb(codeModeSettings())
    await createClaudeCliTerminal(SESSION)
    const [firstDir] = launchDirs()
    appendFileSync(join(root, firstDir, 'usage.log'), `${RESPONSE_LINE}\n`)
    exitPty(pty())
    expect(launchDirs()).toEqual([])

    // The row has its Claude session id by now: the next start resumes it.
    state.session = makeSession({ claude_session_id: 'claude-session-1' })
    await createClaudeCliTerminal(SESSION)

    expect(pty().options.args).toContain('--resume')
    const [secondDir] = launchDirs()
    expect(launchDirs()).toHaveLength(1)
    expect(secondDir).not.toBe(firstDir)
    expect(argAfter(pty().options.args, '--debug-file')).toBe(join(root, secondDir, 'usage.log'))
    expect(readFileSync(join(root, secondDir, 'usage.log'), 'utf8')).toBe('')
    expect(source.facts(SESSION)?.logPath).toBe(join(root, secondDir, 'usage.log'))
  })

  it('keeps a restarted session apart from the process it replaces', async () => {
    await createClaudeCliTerminal(SESSION)
    const [firstDir] = launchDirs()
    const oldProcess = pty()

    // Restart: closed and started again before the old process is gone.
    destroyNodePtyTerminal(SESSION)
    await createClaudeCliTerminal(SESSION)

    const secondDir = launchDirs().find((name) => name !== firstDir)!
    expect(launchDirs()).toHaveLength(2)
    expect(source.facts(SESSION)?.logPath).toBe(join(root, secondDir, 'usage.log'))

    exitPty(oldProcess, 129)

    expect(launchDirs()).toEqual([secondDir])
    expect(source.facts(SESSION)?.logPath).toBe(join(root, secondDir, 'usage.log'))
    expect(launches.transport(SESSION)).toBe('debug-log')
  })

  it('takes back what it prepared when the process cannot be started', async () => {
    mocks.ptyService.create.mockImplementationOnce(() => {
      throw new Error('posix_spawnp failed')
    })

    const result = await createClaudeCliTerminal(SESSION)

    expect(result).toEqual({ success: false, error: 'posix_spawnp failed' })
    expect(launchDirs()).toEqual([])
    expect(source.stats().sessions).toBe(0)
    expect(launches.transport(SESSION)).toBeNull()
  })

  it('starts a working session without live usage when the launch cannot be prepared', async () => {
    // Something that is not the app's sits where the directories would go.
    writeFileSync(root, 'not a directory')

    const result = await createClaudeCliTerminal(SESSION, { pendingPrompt: 'Say hi' })

    expect(result).toEqual({ success: true, cols: 120, rows: 40 })
    expect(lastBuilderInput().usage).toEqual({ transport: 'none' })
    const { options } = pty()
    // Still off the proxy, as a Code Mode session has to be, and without the debug log.
    for (const name of PROXY_VARIABLES) expect(options.env).not.toHaveProperty(name)
    expect(options.unsetEnv).toEqual(PROXY_VARIABLES)
    expect(options.args.join(' ')).not.toContain('--debug')
    expect(options.env).not.toHaveProperty('ANTHROPIC_LOG')
    expect(options.env).not.toHaveProperty('CLAUDE_ENV_FILE')
    expect(options.args.at(-1)).toBe('Say hi')
    expect(readFileSync(root, 'utf8')).toBe('not a directory')
    expect(source.stats().sessions).toBe(0)
    expect(launches.transport(SESSION)).toBe('none')
  })

  it('removes what a crash left behind at start, and keeps the directories of live sessions', async () => {
    await createClaudeCliTerminal(SESSION)
    const live = join(root, launchDirs()[0])
    // An app process that is gone, and a session of this one that no longer runs.
    const crashed = new ClaudeCliDebugDirs({ root, instanceId: 'app0' }).prepare('crashed')!
    const stale = new ClaudeCliDebugDirs({ root, instanceId: 'app1' }).prepare('stale')!
    appendFileSync(crashed.logFile, `${RESPONSE_LINE}\n`)
    aliveInstances.add('app2')
    const theirs = new ClaudeCliDebugDirs({ root, instanceId: 'app2' }).prepare('theirs')!

    startClaudeCliUsageSweeps()

    expect(existsSync(crashed.dir)).toBe(false)
    expect(existsSync(stale.dir)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(theirs.dir)).toBe(true)
    expect(source.facts(SESSION)).not.toBeNull()
    // ...and every hour from then on.
    expect(sweepTimers.map((timer) => timer.ms)).toEqual([60 * 60 * 1000])
    const later = new ClaudeCliDebugDirs({ root, instanceId: 'app0' }).prepare('crashed-later')!
    sweepTimers[0].fn()
    expect(existsSync(later.dir)).toBe(false)
    expect(existsSync(live)).toBe(true)
  })
})

describe('a Claude CLI session that asks for Code Mode, with live usage off', () => {
  const expectNoneLaunch = (): void => {
    expect(lastBuilderInput().usage).toEqual({ transport: 'none' })
    const { options } = pty()
    for (const name of PROXY_VARIABLES) expect(options.env).not.toHaveProperty(name)
    expect(options.unsetEnv).toEqual(PROXY_VARIABLES)
    expect(options.args.join(' ')).not.toContain('--debug')
    expect(options.env).not.toHaveProperty('ANTHROPIC_LOG')
    expect(options.env).not.toHaveProperty('CLAUDE_ENV_FILE')
    // Nothing on disk, nothing followed.
    expect(existsSync(root)).toBe(false)
    expect(source.stats().sessions).toBe(0)
    expect(launches.transport(SESSION)).toBe('none')
  }

  it('launches off the proxy with nothing on disk when the Advanced switch is off', async () => {
    setupDb(codeModeSettings({ claudeCodeModeLiveUsage: false }))

    const result = await createClaudeCliTerminal(SESSION)

    expect(result.success).toBe(true)
    expectNoneLaunch()
  })

  it('does the same under the kill switch', async () => {
    setupDb(codeModeSettings())
    // HIVE_DISABLE_CLAUDE_DEBUG_USAGE=1 in the environment the app was started in.
    installLaunches({ HIVE_DISABLE_CLAUDE_DEBUG_USAGE: '1' })

    await createClaudeCliTerminal(SESSION)

    expectNoneLaunch()
  })

  it('and under the kill switch set in Settings', async () => {
    setupDb(
      codeModeSettings({
        environmentVariables: [
          CODE_MODE,
          { key: 'HIVE_DISABLE_CLAUDE_DEBUG_USAGE', value: '1' }
        ]
      })
    )

    await createClaudeCliTerminal(SESSION)

    expectNoneLaunch()
  })

  it('forgets the launch when its process ends', async () => {
    setupDb(codeModeSettings({ claudeCodeModeLiveUsage: false }))
    await createClaudeCliTerminal(SESSION)

    exitPty(pty())

    expect(launches.transport(SESSION)).toBeNull()
    expect(existsSync(root)).toBe(false)
    // ...and the terminal's own exit handling had its turn.
    await vi.waitFor(() =>
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(`terminal:exit:${SESSION}`, 0)
    )
  })
})

describePosix('a CLI version whose debug log gives no readings (T19)', () => {
  const CLI = '/usr/local/bin/claude'

  const unavailableEvents = (): unknown[] =>
    mocks.publishDesktopBackendEvent.mock.calls
      .filter(([channel]) => channel === CLAUDE_CODE_MODE_USAGE_UNAVAILABLE_CHANNEL)
      .map(([, payload]) => payload)

  /** What a launch reported is counted once its CLI version has answered. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }

  /** A new Code Mode session: one turn over a log the CLI never wrote, then it is closed. */
  const degradedSession = async (): Promise<void> => {
    await createClaudeCliTerminal(SESSION)
    expect(launches.transport(SESSION)).toBe('debug-log')
    tellStatus('working')
    tellStatus('completed')
    expect(launches.degradedReason(SESSION)).toBe('log-empty')
    exitPty(pty())
    await settle()
  }

  const expectNoneLaunch = (): void => {
    expect(lastBuilderInput().usage).toEqual({ transport: 'none' })
    const { options } = pty()
    // Off the proxy as it asked, and without anything of the debug log.
    for (const name of PROXY_VARIABLES) expect(options.env).not.toHaveProperty(name)
    expect(options.unsetEnv).toEqual(PROXY_VARIABLES)
    expect(options.args.join(' ')).not.toContain('--debug')
    expect(options.env).not.toHaveProperty('ANTHROPIC_LOG')
    expect(options.env).not.toHaveProperty('CLAUDE_ENV_FILE')
    expect(options.env).toMatchObject({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' })
    expect(launchDirs()).toEqual([])
    expect(source.stats().sessions).toBe(0)
    expect(launches.transport(SESSION)).toBe('none')
  }

  beforeEach(() => {
    setupDb(codeModeSettings())
    vi.mocked(app.getVersion).mockReturnValue('1.4.0')
    vi.mocked(readClaudeBinaryVersion).mockImplementation(async (path: string) =>
      path === CLI ? '2.1.326' : null
    )
  })

  it('starts the fourth session with transport none after three degraded ones, and tells once', async () => {
    await degradedSession()
    await degradedSession()
    expect(unavailableEvents()).toEqual([])
    await degradedSession()

    // The cue for the windows, with the version and nothing else.
    expect(unavailableEvents()).toEqual([{ provider: 'anthropic', cliVersion: '2.1.326' }])
    expect(unavailableEvents().every(isClaudeCodeModeUsageUnavailablePayload)).toBe(true)
    expect(vi.mocked(readClaudeBinaryVersion)).toHaveBeenCalledWith(CLI)
    // The window claims the notice and shows it.
    const db = mocks.getDatabase()
    expect(claimClaudeDebugUsageAutoDisableNotice(db)).toEqual({
      provider: 'anthropic',
      cliVersion: '2.1.326'
    })

    const result = await createClaudeCliTerminal(SESSION, { pendingPrompt: 'Say hi' })

    expect(result).toEqual({ success: true, cols: 120, rows: 40 })
    expectNoneLaunch()
    expect(pty().options.args.at(-1)).toBe('Say hi')

    // A fifth, and the app started again on the same versions: still off, and nobody is told again.
    exitPty(pty())
    await createClaudeCliTerminal(SESSION)
    expectNoneLaunch()
    exitPty(pty())
    installLaunches()
    await createClaudeCliTerminal(SESSION)
    expectNoneLaunch()
    expect(unavailableEvents()).toHaveLength(1)
    expect(claimClaudeDebugUsageAutoDisableNotice(db)).toBeNull()
  })

  it('starts the count again with a healthy session between failures', async () => {
    await degradedSession()
    await degradedSession()

    await createClaudeCliTerminal(SESSION)
    tellStatus('working')
    appendFileSync(source.facts(SESSION)!.logPath, `${RESPONSE_LINE}\n`)
    tellStatus('completed')
    expect(launches.degradedReason(SESSION)).toBeNull()
    exitPty(pty())
    await settle()
    expect(settingsRows.has(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_STATE_KEY)).toBe(false)

    await degradedSession()
    await degradedSession()
    await createClaudeCliTerminal(SESSION)

    expect(launches.transport(SESSION)).toBe('debug-log')
    expect(unavailableEvents()).toEqual([])
  })

  it('gives sessions their debug log again once the CLI is another version', async () => {
    await degradedSession()
    await degradedSession()
    await degradedSession()
    await createClaudeCliTerminal(SESSION)
    expectNoneLaunch()
    exitPty(pty())

    // The CLI updated itself.
    vi.mocked(readClaudeBinaryVersion).mockResolvedValue('2.1.327')
    await createClaudeCliTerminal(SESSION)

    expect(launches.transport(SESSION)).toBe('debug-log')
    expect(argAfter(pty().options.args, '--debug-file')).toBe(
      join(root, launchDirs()[0], 'usage.log')
    )
    expect(settingsRows.size).toBe(0)
  })

  it('gives sessions their debug log again once the app is another version', async () => {
    await degradedSession()
    await degradedSession()
    await degradedSession()
    await createClaudeCliTerminal(SESSION)
    expectNoneLaunch()
    exitPty(pty())

    // The app was updated and started again.
    vi.mocked(app.getVersion).mockReturnValue('1.4.1')
    installLaunches()
    await createClaudeCliTerminal(SESSION)

    expect(launches.transport(SESSION)).toBe('debug-log')
    expect(settingsRows.size).toBe(0)
  })

  it('leaves a session without Code Mode on the proxy, and asks nothing about it', async () => {
    await degradedSession()
    await degradedSession()
    await degradedSession()
    const stored = new Map(settingsRows)
    vi.mocked(readClaudeBinaryVersion).mockClear()

    // Code Mode is no longer asked for.
    setupDb()
    const result = await createClaudeCliTerminal(SESSION, { pendingPrompt: 'Say hi' })

    expect(result).toEqual({ success: true, cols: 120, rows: 40 })
    expect(lastBuilderInput()).not.toHaveProperty('usage')
    const { options } = pty()
    expect(options.env).toMatchObject({
      ANTHROPIC_BASE_URL: PROXY_URL,
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1'
    })
    expect(options).not.toHaveProperty('unsetEnv')
    expect(options.args.join(' ')).not.toContain('--debug')
    expect(launches.transport(SESSION)).toBeNull()
    // Its CLI was not asked for its version, nothing was counted, nobody was told again.
    expect(vi.mocked(readClaudeBinaryVersion)).not.toHaveBeenCalled()
    expect(settingsRows).toEqual(stored)
    expect(unavailableEvents()).toHaveLength(1)
  })
})

describe('launches the usage transport does not touch', () => {
  it('decides nothing for a codex session', async () => {
    setupDb(codeModeSettings(), makeSession({ agent_sdk: 'codex-cli' }))

    const result = await createClaudeCliTerminal(SESSION)

    expect(result.success).toBe(true)
    expect(pty().options.command).toBe('/usr/local/bin/codex')
    expect(resolveTransport).not.toHaveBeenCalled()
    expect(existsSync(root)).toBe(false)
    expect(source.stats().sessions).toBe(0)
    expect(pty().exitListeners).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')(
    'leaves a custom provider session on the proxy, whatever it asks for',
    async () => {
      setupDb(
        codeModeSettings({
          customProviders: [{ id: 'provider-1', name: 'Proxy', command: 'claudex' }]
        }),
        makeSession({ custom_provider_id: 'provider-1' })
      )

      const result = await createClaudeCliTerminal(SESSION)

      expect(result.success).toBe(true)
      expect(lastBuilderInput()).not.toHaveProperty('usage')
      const { options } = pty()
      expect(options.args[1]).toContain('claudex')
      expect(options.env).toMatchObject({ ANTHROPIC_BASE_URL: PROXY_URL })
      expect(options).not.toHaveProperty('unsetEnv')
      expect(existsSync(root)).toBe(false)
      expect(source.stats().sessions).toBe(0)
    }
  )
})

describe('the quit of the app', () => {
  it('lets go of the usage source after the terminals and before the live usage updater', () => {
    // The terminals end every usage launch, whose last lines still count; the source they
    // were read by goes next, and the updater those readings went to after it (T16).
    const entry = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
    const steps = [...entry.matchAll(/\{\s*name: '([A-Za-z]+)',\s*run:/g)].map((step) => step[1])

    const at = (name: string): number => steps.indexOf(name)
    expect(at('cleanupTerminals')).toBeGreaterThanOrEqual(0)
    expect(at('claudeDebugLogUsage')).toBeGreaterThan(at('cleanupTerminals'))
    expect(at('claudeUsageLiveUpdater')).toBeGreaterThan(at('claudeDebugLogUsage'))
    expect(entry).toContain(
      "{ name: 'claudeDebugLogUsage', run: () => disposeClaudeDebugLogUsageSource() }"
    )
  })
})
