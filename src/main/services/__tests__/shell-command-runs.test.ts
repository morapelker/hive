import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionShellCommandSnapshot,
  parseSessionShellCommand,
  serializeSessionShellCommand,
  type SessionShellCommand
} from '@shared/lib/shell-commands'
import { wrapShellCommandReplay } from '@shared/shell-command-events'
import { SHELL_COMMAND_RUN_FILES, getShellCommandRunDir } from '../shell-command-paths'
import {
  SHELL_COMMAND_INTERRUPTED_MARKER,
  SHELL_COMMAND_STOPPED_MARKER,
  type RunHostExit,
  type ShellCommandRunHost,
  type ShellCommandRunHostOptions
} from '../shell-command-run-host'
import {
  attachShellCommandTerminal,
  cancelShellCommandRunIfLive,
  detachShellCommandRunsForQuit,
  getLiveShellCommandSessionIds,
  resizeShellCommandRun,
  runShellCommandTerminal,
  setShellCommandRunHostFactoriesForTests,
  writeShellCommandRun
} from '../shell-command-runs'

interface FakeRow {
  id: string
  agent_sdk: string
  session_type: string
  worktree_id: string | null
  project_id: string
  shell_command: string | null
  updated_at: string
}

const mocks = vi.hoisted(() => {
  const state = {
    /** Every observable step, in order: persists, publishes and host calls. */
    order: [] as string[],
    events: [] as Array<{ channel: string; payload: unknown }>,
    logCalls: [] as unknown[][],
    sessions: new Map<string, Record<string, unknown>>(),
    worktrees: new Map<string, Record<string, unknown>>()
  }
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      state.logCalls.push([level, ...args])
    }
  return {
    state,
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error')
    },
    db: {
      getSession: (id: string) => {
        const row = state.sessions.get(id)
        return row ? { ...row } : null
      },
      updateSession: (id: string, data: { shell_command?: string | null }) => {
        const row = state.sessions.get(id)
        if (!row) return null
        if (data.shell_command !== undefined) {
          row.shell_command = data.shell_command
          const parsed = JSON.parse(data.shell_command ?? '{}') as { state?: string }
          state.order.push(`persist:${parsed.state}`)
        }
        return { ...row }
      },
      getWorktree: (id: string) => state.worktrees.get(id) ?? null,
      getProject: (id: string) => ({ id, path: '/projects/main' }),
      getSetting: () => null
    },
    publish: vi.fn(async (channel: string, payload: unknown) => {
      state.events.push({ channel, payload })
      if (channel === 'shell-command:status') {
        state.order.push(`status:${(payload as { state: string }).state}`)
      } else {
        state.order.push(`event:${channel}`)
      }
      return true
    })
  }
})

vi.mock('../../db', () => ({ getDatabase: () => mocks.db }))
vi.mock('../../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publish
}))
vi.mock('../pty-service', () => ({ ptyService: {} }))
vi.mock('../env-vars', () => ({
  getUserEnvironmentVariables: () => ({ USER_SECRET: 'ENV_VALUE_TOKEN' })
}))
vi.mock('../logger', () => ({ createLogger: () => mocks.logger }))

const SCRIPT = 'echo SCRIPT_TEXT_TOKEN\nmake build'
const SESSION = 'session-1'
const DATA_CHANNEL = `terminal:data:${SESSION}`

interface FakeHost extends ShellCommandRunHost {
  options: ShellCommandRunHostOptions
  start: ReturnType<typeof vi.fn<() => Promise<void>>>
  write: ReturnType<typeof vi.fn<(data: string) => void>>
  resize: ReturnType<typeof vi.fn<(cols: number, rows: number) => void>>
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>
  detach: ReturnType<typeof vi.fn<() => void>>
}

const describePosix = describe.skipIf(process.platform === 'win32')

describePosix('shell command run registry', () => {
  let baseDir: string
  let worktreeDir: string
  const savedDbPath = process.env.HIVE_SERVER_DB_PATH
  const { state } = mocks
  let hosts: FakeHost[]
  let startImpl: () => Promise<void>
  const createInApp = vi.fn<(options: ShellCommandRunHostOptions) => ShellCommandRunHost>()
  const createDetached = vi.fn<(options: ShellCommandRunHostOptions) => ShellCommandRunHost>()
  const adoptDetached = vi.fn()

  const makeHost = (mode: 'in-app' | 'detached', options: ShellCommandRunHostOptions): FakeHost => {
    const host: FakeHost = {
      mode,
      options,
      start: vi.fn(() => {
        state.order.push('host.start')
        return startImpl()
      }),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(async () => {
        state.order.push('host.stop')
      }),
      detach: vi.fn(() => {
        state.order.push('host.detach')
      })
    }
    hosts.push(host)
    return host
  }

  const addSession = (
    overrides: Partial<SessionShellCommand> = {},
    row: Partial<FakeRow> = {}
  ): void => {
    const snapshot: SessionShellCommand = {
      ...createSessionShellCommandSnapshot({ id: 'cmd-1', name: 'Build', commands: SCRIPT }),
      ...overrides
    }
    state.sessions.set(SESSION, {
      id: SESSION,
      agent_sdk: 'terminal',
      session_type: 'shell-command',
      worktree_id: 'wt-1',
      project_id: 'project-1',
      shell_command: serializeSessionShellCommand(snapshot),
      updated_at: new Date().toISOString(),
      ...row
    })
  }

  const stored = (): SessionShellCommand => {
    const snapshot = parseSessionShellCommand(state.sessions.get(SESSION)?.shell_command)
    if (!snapshot) throw new Error('no snapshot stored')
    return snapshot
  }

  const statusStates = (): string[] =>
    state.events
      .filter((event) => event.channel === 'shell-command:status')
      .map((event) => (event.payload as { state: string }).state)

  const dataChunks = (): string[] =>
    state.events
      .filter((event) => event.channel === DATA_CHANNEL)
      .map((event) => event.payload as string)

  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  const exited = (exitCode: number, extra: Partial<RunHostExit> = {}): RunHostExit =>
    ({ kind: 'exited', exitCode, signal: null, abnormal: false, ...extra }) as RunHostExit

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'shellcmd-runs-'))
    worktreeDir = join(baseDir, 'worktree')
    mkdirSync(worktreeDir)
    process.env.HIVE_SERVER_DB_PATH = join(baseDir, 'hive.db')
  })

  afterAll(() => {
    if (savedDbPath === undefined) delete process.env.HIVE_SERVER_DB_PATH
    else process.env.HIVE_SERVER_DB_PATH = savedDbPath
    rmSync(baseDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    hosts = []
    startImpl = async () => {}
    state.order.length = 0
    state.events.length = 0
    state.logCalls.length = 0
    state.sessions.clear()
    state.worktrees.clear()
    state.worktrees.set('wt-1', { id: 'wt-1', project_id: 'project-1', path: worktreeDir })
    createInApp.mockReset().mockImplementation((options) => makeHost('in-app', options))
    createDetached.mockReset().mockImplementation((options) => makeHost('detached', options))
    adoptDetached.mockReset()
    setShellCommandRunHostFactoriesForTests(null)
    setShellCommandRunHostFactoriesForTests({ createInApp, createDetached, adoptDetached })
  })

  afterEach(async () => {
    // Let pending stop() chains finish before the registry state is dropped.
    await tick()
    setShellCommandRunHostFactoriesForTests(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('runShellCommandTerminal', () => {
    it('rejects a session that is not a shell command without persisting', async () => {
      addSession({}, { session_type: 'default' })

      await expect(runShellCommandTerminal(SESSION)).resolves.toEqual({
        success: false,
        error: 'Session is not a shell command session'
      })
      await expect(runShellCommandTerminal('missing')).resolves.toEqual({
        success: false,
        error: 'Session is not a shell command session'
      })
      expect(state.order).toEqual([])
      expect(createInApp).not.toHaveBeenCalled()
    })

    it('rejects a second run while one is live and changes nothing', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      const before = stored()
      state.order.length = 0

      await expect(runShellCommandTerminal(SESSION)).resolves.toEqual({
        success: false,
        alreadyRunning: true,
        error: 'Command is already running'
      })
      expect(state.order).toEqual([])
      expect(stored()).toEqual(before)
      expect(hosts).toHaveLength(1)
    })

    it('fails the start on Windows', async () => {
      addSession()
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

      await expect(runShellCommandTerminal(SESSION)).resolves.toEqual({
        success: false,
        error: 'Shell commands are not supported on Windows'
      })
      expect(stored()).toMatchObject({
        state: 'failed',
        reason: 'start-failed',
        error: 'Shell commands are not supported on Windows',
        exitCode: null,
        runId: null
      })
      expect(state.order).toEqual(['persist:failed', 'status:failed'])
      expect(createInApp).not.toHaveBeenCalled()
    })

    it('fails the start when the worktree folder is gone', async () => {
      addSession()
      state.worktrees.set('wt-1', {
        id: 'wt-1',
        project_id: 'project-1',
        path: join(baseDir, 'gone')
      })

      const result = await runShellCommandTerminal(SESSION)

      expect(result).toEqual({
        success: false,
        error: 'The worktree folder for this command no longer exists'
      })
      expect(stored()).toMatchObject({ state: 'failed', reason: 'start-failed' })
      expect(stored().finishedAt).not.toBeNull()
      expect(statusStates()).toEqual(['failed'])
      expect(createInApp).not.toHaveBeenCalled()
    })

    it('fails the start when the worktree row is missing', async () => {
      addSession()
      state.worktrees.clear()

      const result = await runShellCommandTerminal(SESSION)

      expect(result.error).toBe('The worktree folder for this command no longer exists')
      expect(statusStates()).toEqual(['failed'])
    })

    it('fails the start for a teleported worktree', async () => {
      addSession()
      state.worktrees.set('wt-1', {
        id: 'wt-1',
        project_id: 'project-1',
        path: worktreeDir,
        teleported_to: 'other-mac'
      })

      const result = await runShellCommandTerminal(SESSION)

      expect(result).toEqual({ success: false, error: 'This worktree lives on another machine' })
      expect(stored()).toMatchObject({ state: 'failed', reason: 'start-failed' })
      expect(statusStates()).toEqual(['failed'])
    })

    it('fails the start when the script has no runnable lines', async () => {
      addSession({ script: '# only a comment\n\n' })

      const result = await runShellCommandTerminal(SESSION)

      expect(result).toEqual({ success: false, error: 'Command has no runnable lines' })
      expect(stored()).toMatchObject({ state: 'failed', reason: 'start-failed' })
      expect(statusStates()).toEqual(['failed'])
    })

    it('persists running before the spawn, then publishes status and an empty replay', async () => {
      addSession()

      const result = await runShellCommandTerminal(SESSION, { cols: 132, rows: 40 })

      expect(result).toEqual({ success: true, cols: 132, rows: 40 })
      expect(state.order).toEqual([
        'persist:running',
        'status:running',
        `event:${DATA_CHANNEL}`,
        'host.start'
      ])
      expect(dataChunks()).toEqual([wrapShellCommandReplay('')])
      const snapshot = stored()
      expect(snapshot).toMatchObject({
        state: 'running',
        exitCode: null,
        signal: null,
        reason: null,
        error: null,
        finishedAt: null
      })
      expect(snapshot.runId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(snapshot.startedAt).not.toBeNull()
      expect(state.events[0].payload).toMatchObject({
        sessionId: SESSION,
        runId: snapshot.runId,
        state: 'running',
        detached: false
      })
      expect(getLiveShellCommandSessionIds()).toEqual([SESSION])

      expect(createInApp).toHaveBeenCalledTimes(1)
      expect(createDetached).not.toHaveBeenCalled()
      expect(hosts[0].options).toMatchObject({
        sessionId: SESSION,
        runDir: getShellCommandRunDir(SESSION, snapshot.runId!),
        cwd: worktreeDir,
        steps: ['echo SCRIPT_TEXT_TOKEN', 'make build'],
        cols: 132,
        rows: 40,
        env: {
          USER_SECRET: 'ENV_VALUE_TOKEN',
          HIVE_PROJECT_PATH: '/projects/main',
          HIVE_WORKTREE_PATH: worktreeDir
        }
      })
      expect(existsSync(hosts[0].options.runDir)).toBe(true)
    })

    it('uses the detached factory for a detached snapshot', async () => {
      addSession({ detached: true })

      await expect(runShellCommandTerminal(SESSION)).resolves.toMatchObject({ success: true })
      expect(createDetached).toHaveBeenCalledTimes(1)
      expect(createInApp).not.toHaveBeenCalled()
      expect(state.events[0].payload).toMatchObject({ state: 'running', detached: true })
    })

    it('records a rejected host start as failed/start-failed with the host message', async () => {
      addSession()
      startImpl = async () => {
        throw new Error('The command host did not start')
      }

      const result = await runShellCommandTerminal(SESSION)

      expect(result).toEqual({ success: false, error: 'The command host did not start' })
      const snapshot = stored()
      expect(snapshot).toMatchObject({
        state: 'failed',
        reason: 'start-failed',
        error: 'The command host did not start',
        exitCode: null
      })
      // The failed attempt keeps its own run id; its directory is gone.
      expect(snapshot.runId).not.toBeNull()
      expect(existsSync(hosts[0].options.runDir)).toBe(false)
      expect(statusStates()).toEqual(['running', 'failed'])
      expect(getLiveShellCommandSessionIds()).toEqual([])
      expect(writeShellCommandRun(SESSION, 'x')).toBe(false)
    })

    it('issues a new run id on Run again and removes the previous run directory', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      const first = stored().runId!
      const firstDir = hosts[0].options.runDir
      hosts[0].options.sink.data('first run\r\n')
      hosts[0].options.sink.exit(exited(0))
      expect(existsSync(join(firstDir, SHELL_COMMAND_RUN_FILES.log))).toBe(true)
      state.events.length = 0

      await expect(runShellCommandTerminal(SESSION)).resolves.toMatchObject({ success: true })

      const second = stored().runId!
      expect(second).not.toBe(first)
      expect(stored()).toMatchObject({ state: 'running', exitCode: null, finishedAt: null })
      expect(existsSync(firstDir)).toBe(false)
      expect(existsSync(hosts[1].options.runDir)).toBe(true)
      // Every attached view is cleared for the new run.
      expect(dataChunks()).toEqual([wrapShellCommandReplay('')])
    })

    it('starts at the size the view last reported', async () => {
      addSession()
      attachShellCommandTerminal(SESSION)
      resizeShellCommandRun(SESSION, 150, 50)

      await expect(runShellCommandTerminal(SESSION)).resolves.toEqual({
        success: true,
        cols: 150,
        rows: 50
      })
      expect(hosts[0].options).toMatchObject({ cols: 150, rows: 50 })
    })
  })

  describe('output and exit', () => {
    it('coalesces output onto the terminal data channel and into the log', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      state.events.length = 0

      hosts[0].options.sink.data('one ')
      hosts[0].options.sink.data('two ')
      hosts[0].options.sink.data('three')
      expect(dataChunks()).toEqual([])
      await tick()

      expect(dataChunks()).toEqual(['one two three'])
      expect(readFileSync(join(hosts[0].options.runDir, SHELL_COMMAND_RUN_FILES.log), 'utf8')).toBe(
        'one two three'
      )
    })

    it('records exit 0 as succeeded, after flushing the last output', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      state.order.length = 0

      hosts[0].options.sink.data('last line\r\n')
      hosts[0].options.sink.exit(exited(0))

      expect(state.order).toEqual([
        `event:${DATA_CHANNEL}`,
        'persist:succeeded',
        'status:succeeded'
      ])
      expect(stored()).toMatchObject({ state: 'succeeded', exitCode: 0, reason: null })
      expect(stored().finishedAt).not.toBeNull()
      expect(getLiveShellCommandSessionIds()).toEqual([])
      expect(writeShellCommandRun(SESSION, 'x')).toBe(false)
    })

    it('records a non-zero exit as failed with its exit code', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)

      hosts[0].options.sink.exit(exited(3))

      expect(stored()).toMatchObject({ state: 'failed', exitCode: 3, signal: null, reason: null })
      expect(state.events.at(-1)).toMatchObject({
        channel: 'shell-command:status',
        payload: { sessionId: SESSION, state: 'failed', exitCode: 3 }
      })
    })

    it('carries the output-limit reason and the signal', async () => {
      addSession({ detached: true })
      await runShellCommandTerminal(SESSION)

      hosts[0].options.sink.exit(
        exited(153, { signal: 25, abnormal: true, reason: 'output-limit' } as Partial<RunHostExit>)
      )

      expect(stored()).toMatchObject({
        state: 'failed',
        exitCode: 153,
        signal: 25,
        reason: 'output-limit'
      })
    })

    it('records a lost run as interrupted', async () => {
      addSession({ detached: true })
      await runShellCommandTerminal(SESSION)

      hosts[0].options.sink.exit({ kind: 'lost' })

      expect(stored()).toMatchObject({ state: 'interrupted', exitCode: null, signal: null })
      expect(statusStates()).toEqual(['running', 'interrupted'])
    })

    it('settles once: a second exit is ignored', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)

      hosts[0].options.sink.exit(exited(0))
      hosts[0].options.sink.exit(exited(9))

      expect(stored()).toMatchObject({ state: 'succeeded', exitCode: 0 })
      expect(statusStates()).toEqual(['running', 'succeeded'])
    })

    it('never publishes on the terminal exit channel', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      hosts[0].options.sink.data('x')
      hosts[0].options.sink.exit(exited(1))
      await runShellCommandTerminal(SESSION)
      cancelShellCommandRunIfLive(SESSION)
      await tick()

      const channels = new Set(state.events.map((event) => event.channel))
      expect([...channels].sort()).toEqual(['shell-command:status', DATA_CHANNEL].sort())
    })

    it('keeps the stored verdict when the row no longer shows this run as running', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      // Another app instance on the same database finalized the run first.
      const theirs: SessionShellCommand = { ...stored(), state: 'interrupted', finishedAt: 'then' }
      state.sessions.get(SESSION)!.shell_command = serializeSessionShellCommand(theirs)
      state.order.length = 0

      hosts[0].options.sink.exit(exited(0))

      expect(stored()).toEqual(theirs)
      expect(state.order).toEqual(['status:interrupted'])
      expect(getLiveShellCommandSessionIds()).toEqual([])
    })

    it('keeps the stored verdict when the row shows a different run', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      const theirs: SessionShellCommand = { ...stored(), runId: 'another-run' }
      state.sessions.get(SESSION)!.shell_command = serializeSessionShellCommand(theirs)
      state.order.length = 0

      hosts[0].options.sink.exit(exited(0))

      expect(stored()).toEqual(theirs)
      expect(state.order).toEqual(['status:running'])
    })
  })

  describe('attachShellCommandTerminal', () => {
    it('rejects a session that is not a shell command', () => {
      expect(attachShellCommandTerminal('missing')).toEqual({
        success: false,
        error: 'Session is not a shell command session'
      })
      expect(state.events).toEqual([])
    })

    it('flushes, then replays the transcript of a live run, without spawning', async () => {
      addSession()
      await runShellCommandTerminal(SESSION, { cols: 100, rows: 30 })
      const runId = stored().runId
      hosts[0].options.sink.data('hello ')
      await tick()
      hosts[0].options.sink.data('world')
      state.events.length = 0
      state.order.length = 0

      const result = attachShellCommandTerminal(SESSION)

      expect(result).toEqual({
        success: true,
        cols: 100,
        rows: 30,
        state: 'running',
        exitCode: null,
        runId
      })
      // The pending chunk goes out first, the replay (which contains it) second.
      expect(dataChunks()).toEqual(['world', wrapShellCommandReplay('hello world')])
      expect(state.order).toEqual([`event:${DATA_CHANNEL}`, `event:${DATA_CHANNEL}`])
      expect(createInApp).toHaveBeenCalledTimes(1)
      expect(hosts[0].start).toHaveBeenCalledTimes(1)
    })

    it('replays the log tail of a finished run', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      hosts[0].options.sink.data('all done\r\n')
      hosts[0].options.sink.exit(exited(2))
      const runId = stored().runId
      state.events.length = 0

      const result = attachShellCommandTerminal(SESSION)

      expect(result).toMatchObject({ success: true, state: 'failed', exitCode: 2, runId })
      expect(dataChunks()).toEqual([wrapShellCommandReplay('all done\r\n')])
      expect(createInApp).toHaveBeenCalledTimes(1)
      expect(hosts).toHaveLength(1)
    })

    it('publishes nothing for a pending session and never creates a host', () => {
      addSession()

      const result = attachShellCommandTerminal(SESSION)

      expect(result).toEqual({
        success: true,
        cols: 80,
        rows: 24,
        state: 'pending',
        exitCode: null,
        runId: null
      })
      expect(state.events).toEqual([])
      expect(state.order).toEqual([])
      expect(createInApp).not.toHaveBeenCalled()
      expect(createDetached).not.toHaveBeenCalled()
      expect(adoptDetached).not.toHaveBeenCalled()
    })
  })

  describe('write, resize and live ids', () => {
    it('handles input and resize only for sessions it knows', async () => {
      expect(writeShellCommandRun(SESSION, 'x')).toBe(false)
      expect(resizeShellCommandRun(SESSION, 90, 20)).toBe(false)
      expect(getLiveShellCommandSessionIds()).toEqual([])

      addSession()
      await runShellCommandTerminal(SESSION)

      expect(writeShellCommandRun(SESSION, 'y\n')).toBe(true)
      expect(hosts[0].write).toHaveBeenCalledWith('y\n')
      expect(resizeShellCommandRun(SESSION, 90, 20)).toBe(true)
      expect(hosts[0].resize).toHaveBeenCalledWith(90, 20)
      expect(attachShellCommandTerminal(SESSION)).toMatchObject({ cols: 90, rows: 20 })
      expect(writeShellCommandRun('other-terminal', 'x')).toBe(false)
      expect(resizeShellCommandRun('other-terminal', 90, 20)).toBe(false)

      hosts[0].options.sink.exit(exited(0))

      // Finished: input is nobody's, but the size is still remembered for Run again.
      expect(writeShellCommandRun(SESSION, 'x')).toBe(false)
      expect(resizeShellCommandRun(SESSION, 111, 33)).toBe(true)
      expect(hosts[0].resize).toHaveBeenCalledTimes(1)
      expect(attachShellCommandTerminal(SESSION)).toMatchObject({ cols: 111, rows: 33 })
    })
  })

  describe('cancelShellCommandRunIfLive', () => {
    it('returns false when nothing is live', async () => {
      expect(cancelShellCommandRunIfLive(SESSION)).toBe(false)

      addSession()
      await runShellCommandTerminal(SESSION)
      hosts[0].options.sink.exit(exited(0))
      state.order.length = 0

      expect(cancelShellCommandRunIfLive(SESSION)).toBe(false)
      expect(state.order).toEqual([])
      expect(hosts[0].stop).not.toHaveBeenCalled()
    })

    it('persists cancelled before the host is stopped and ignores the later exit', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      hosts[0].options.sink.data('partial')
      state.order.length = 0
      state.events.length = 0

      expect(cancelShellCommandRunIfLive(SESSION)).toBe(true)

      expect(state.order).toEqual([
        `event:${DATA_CHANNEL}`,
        'persist:cancelled',
        'status:cancelled',
        `event:${DATA_CHANNEL}`,
        'host.stop'
      ])
      expect(dataChunks()).toEqual(['partial', SHELL_COMMAND_STOPPED_MARKER])
      expect(stored()).toMatchObject({ state: 'cancelled', exitCode: null })
      expect(stored().finishedAt).not.toBeNull()
      expect(getLiveShellCommandSessionIds()).toEqual([])

      // What the dying tree reports is meaningless.
      hosts[0].options.sink.exit(exited(1))
      await tick()

      expect(stored()).toMatchObject({ state: 'cancelled', exitCode: null })
      expect(statusStates()).toEqual(['cancelled'])
      expect(cancelShellCommandRunIfLive(SESSION)).toBe(false)
      expect(readFileSync(join(hosts[0].options.runDir, SHELL_COMMAND_RUN_FILES.log), 'utf8')).toBe(
        `partial${SHELL_COMMAND_STOPPED_MARKER}`
      )
    })

    it('appends the stopped marker to the log of a detached run', async () => {
      addSession({ detached: true })
      await runShellCommandTerminal(SESSION)
      const logFile = join(hosts[0].options.runDir, SHELL_COMMAND_RUN_FILES.log)
      // script(1) owns a detached run's log.
      writeFileSync(logFile, 'from script\r\n')

      expect(cancelShellCommandRunIfLive(SESSION)).toBe(true)
      await tick()

      expect(hosts[0].stop).toHaveBeenCalledTimes(1)
      expect(readFileSync(logFile, 'utf8')).toBe(`from script\r\n${SHELL_COMMAND_STOPPED_MARKER}`)
    })

    it('lets a re-run wait for the stop that is still in flight', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      let finishStop: () => void = () => {}
      hosts[0].stop.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishStop = resolve
          })
      )
      cancelShellCommandRunIfLive(SESSION)

      const rerun = runShellCommandTerminal(SESSION)
      await tick()
      expect(hosts).toHaveLength(1)

      finishStop()
      await expect(rerun).resolves.toMatchObject({ success: true })
      expect(hosts).toHaveLength(2)
      expect(stored().state).toBe('running')
    })
  })

  describe('detachShellCommandRunsForQuit', () => {
    it('releases a detached run without stopping it and leaves it running', async () => {
      addSession({ detached: true })
      await runShellCommandTerminal(SESSION)
      state.order.length = 0

      detachShellCommandRunsForQuit()

      expect(hosts[0].detach).toHaveBeenCalledTimes(1)
      expect(hosts[0].stop).not.toHaveBeenCalled()
      expect(stored().state).toBe('running')
      expect(state.order).toEqual(['host.detach'])
      expect(getLiveShellCommandSessionIds()).toEqual([])
    })

    it('records an in-app run as interrupted without publishing a status', async () => {
      addSession()
      await runShellCommandTerminal(SESSION)
      hosts[0].options.sink.data('working')
      await tick()
      state.events.length = 0

      detachShellCommandRunsForQuit()

      expect(stored()).toMatchObject({ state: 'interrupted', exitCode: null })
      expect(hosts[0].detach).toHaveBeenCalledTimes(1)
      expect(hosts[0].stop).not.toHaveBeenCalled()
      expect(statusStates()).toEqual([])
      expect(readFileSync(join(hosts[0].options.runDir, SHELL_COMMAND_RUN_FILES.log), 'utf8')).toBe(
        `working${SHELL_COMMAND_INTERRUPTED_MARKER}`
      )
      expect(getLiveShellCommandSessionIds()).toEqual([])

      // The PTY's exit arrives after the listeners were released: nothing changes.
      hosts[0].options.sink.exit(exited(129))
      expect(stored().state).toBe('interrupted')
    })
  })

  it('never logs script text, steps or environment values', async () => {
    addSession()
    await runShellCommandTerminal(SESSION)
    hosts[0].options.sink.data('output')
    attachShellCommandTerminal(SESSION)
    hosts[0].options.sink.exit(exited(3))
    await runShellCommandTerminal(SESSION)
    cancelShellCommandRunIfLive(SESSION)
    await tick()
    startImpl = async () => {
      throw new Error('The command host did not start')
    }
    await runShellCommandTerminal(SESSION)

    expect(state.logCalls.length).toBeGreaterThan(0)
    const logged = JSON.stringify(state.logCalls)
    expect(logged).not.toContain('SCRIPT_TEXT_TOKEN')
    expect(logged).not.toContain('make build')
    expect(logged).not.toContain('ENV_VALUE_TOKEN')
    expect(logged).not.toContain('Build')
  })
})
