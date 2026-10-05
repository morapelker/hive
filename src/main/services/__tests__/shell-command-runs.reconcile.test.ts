import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionShellCommandSnapshot,
  parseSessionShellCommand,
  serializeSessionShellCommand,
  type SessionShellCommand
} from '@shared/lib/shell-commands'
import {
  SHELL_COMMAND_RUN_FILES,
  getShellCommandRunDir,
  getShellCommandRunsDir,
  getShellCommandSessionRunsDir
} from '../shell-command-paths'
import { RUN_DIR_ORPHAN_MAX_AGE_MS, type RunHostSink } from '../shell-command-run-host'
import {
  attachShellCommandTerminal,
  getLiveShellCommandSessionIds,
  reconcileShellCommandRuns,
  runShellCommandTerminal,
  setShellCommandRunHostFactoriesForTests,
  sweepShellCommandRunDirs,
  writeShellCommandRun
} from '../shell-command-runs'

const mocks = vi.hoisted(() => {
  const state = {
    events: [] as Array<{ channel: string; payload: unknown }>,
    sessions: new Map<string, Record<string, unknown>>(),
    /** Run directories that still existed when stopDetachedRun was called on them. */
    stopped: [] as string[]
  }
  return {
    state,
    db: {
      getSession: (id: string) => {
        const row = state.sessions.get(id)
        return row ? { ...row } : null
      },
      updateSession: (id: string, data: { shell_command?: string | null }) => {
        const row = state.sessions.get(id)
        if (!row) return null
        if (data.shell_command !== undefined) row.shell_command = data.shell_command
        return { ...row }
      },
      getShellCommandSessionsInStates: (states: readonly string[]) =>
        [...state.sessions.values()]
          .filter((row) => {
            try {
              return states.includes(JSON.parse(String(row.shell_command)).state)
            } catch {
              return false
            }
          })
          .map((row) => ({ ...row })),
      getWorktree: () => null,
      getProject: () => null,
      getSetting: () => null
    },
    publish: vi.fn(async (channel: string, payload: unknown) => {
      state.events.push({ channel, payload })
      return true
    }),
    stopDetachedRun: vi.fn(async (_runDir: string) => {})
  }
})

vi.mock('../../db', () => ({ getDatabase: () => mocks.db }))
vi.mock('../../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publish
}))
vi.mock('../pty-service', () => ({ ptyService: {} }))
vi.mock('../env-vars', () => ({ getUserEnvironmentVariables: () => ({}) }))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../shell-command-detached-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shell-command-detached-host')>()),
  stopDetachedRun: mocks.stopDetachedRun
}))

const describePosix = describe.skipIf(process.platform === 'win32')

describePosix('shell command run reconcile and sweep', () => {
  let baseDir: string
  const savedDbPath = process.env.HIVE_SERVER_DB_PATH
  const { state } = mocks
  const heldFds: number[] = []
  const adoptDetached = vi.fn()
  const createInApp = vi.fn()
  const createDetached = vi.fn()
  let adoptedSink: RunHostSink | null

  const secondsAgo = (seconds: number): string =>
    new Date(Date.now() - seconds * 1000).toISOString()

  const addSession = (
    id: string,
    overrides: Partial<SessionShellCommand>,
    updatedAt = secondsAgo(600)
  ): void => {
    const snapshot: SessionShellCommand = {
      ...createSessionShellCommandSnapshot({ id: 'cmd-1', name: 'Build', commands: 'make' }),
      ...overrides
    }
    state.sessions.set(id, {
      id,
      agent_sdk: 'terminal',
      session_type: 'shell-command',
      worktree_id: 'wt-1',
      project_id: 'project-1',
      shell_command: serializeSessionShellCommand(snapshot),
      updated_at: updatedAt
    })
  }

  const stored = (id: string): SessionShellCommand => {
    const snapshot = parseSessionShellCommand(state.sessions.get(id)?.shell_command)
    if (!snapshot) throw new Error('no snapshot stored')
    return snapshot
  }

  const makeRunDir = (sessionId: string, runId: string): string => {
    const runDir = getShellCommandRunDir(sessionId, runId)
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    return runDir
  }

  /** Makes the run look owned: its FIFO gets a reader (this test process). */
  const holdFifo = (runDir: string): void => {
    const stdinPath = join(runDir, SHELL_COMMAND_RUN_FILES.stdin)
    execFileSync('mkfifo', ['-m', '600', stdinPath], { stdio: 'ignore' })
    heldFds.push(openSync(stdinPath, constants.O_RDWR | constants.O_NONBLOCK))
  }

  const writeControlFiles = (runDir: string): void => {
    const files = SHELL_COMMAND_RUN_FILES
    writeFileSync(join(runDir, files.log), 'transcript\r\n')
    writeFileSync(join(runDir, files.hostPid), '999999\n')
    writeFileSync(join(runDir, files.feederPid), '999998\n')
    writeFileSync(join(runDir, files.inner), 'pid=999997\ntty=/dev/ttys999\n')
    writeFileSync(join(runDir, files.innerExit), '0\n')
    writeFileSync(join(runDir, files.hostErr), '')
    execFileSync('mkfifo', ['-m', '600', join(runDir, files.stdin)], { stdio: 'ignore' })
  }

  const age = (path: string, ms: number): void => {
    const when = new Date(Date.now() - ms)
    utimesSync(path, when, when)
  }

  const statuses = (): Array<{ sessionId: string; state: string }> =>
    state.events
      .filter((event) => event.channel === 'shell-command:status')
      .map((event) => event.payload as { sessionId: string; state: string })

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'shellcmd-reconcile-'))
    process.env.HIVE_SERVER_DB_PATH = join(baseDir, 'hive.db')
  })

  afterAll(() => {
    if (savedDbPath === undefined) delete process.env.HIVE_SERVER_DB_PATH
    else process.env.HIVE_SERVER_DB_PATH = savedDbPath
    rmSync(baseDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    state.events.length = 0
    state.sessions.clear()
    state.stopped.length = 0
    adoptedSink = null
    mocks.stopDetachedRun.mockReset().mockImplementation(async (runDir: string) => {
      if (existsSync(runDir)) state.stopped.push(runDir)
    })
    adoptDetached.mockReset().mockImplementation((options: { sink: RunHostSink }) => {
      adoptedSink = options.sink
      // An adopted host replays the log through the sink while it is being built.
      options.sink.data('replayed tail\r\n')
      return {
        mode: 'detached',
        start: vi.fn(async () => {}),
        write: vi.fn(),
        resize: vi.fn(),
        stop: vi.fn(async () => {}),
        detach: vi.fn()
      }
    })
    createInApp.mockReset()
    createDetached.mockReset()
    setShellCommandRunHostFactoriesForTests(null)
    setShellCommandRunHostFactoriesForTests({ adoptDetached, createInApp, createDetached })
  })

  afterEach(() => {
    for (const fd of heldFds.splice(0)) closeSync(fd)
    setShellCommandRunHostFactoriesForTests(null)
    rmSync(getShellCommandRunsDir(), { recursive: true, force: true })
  })

  describe('reconcileShellCommandRuns', () => {
    it('interrupts a stale pending session and leaves a fresh one alone', async () => {
      addSession('stale', { state: 'pending' }, secondsAgo(120))
      addSession('fresh', { state: 'pending' }, secondsAgo(5))

      await reconcileShellCommandRuns()

      expect(stored('stale')).toMatchObject({ state: 'interrupted', exitCode: null })
      expect(stored('stale').finishedAt).not.toBeNull()
      expect(stored('fresh').state).toBe('pending')
      expect(statuses()).toEqual([expect.objectContaining({ sessionId: 'stale' })])
    })

    it('interrupts a running session without a run id', async () => {
      addSession('no-run', { state: 'running', runId: null })

      await reconcileShellCommandRuns()

      expect(stored('no-run').state).toBe('interrupted')
    })

    it('ignores sessions that already finished', async () => {
      addSession('done', { state: 'succeeded', runId: 'run-1', exitCode: 0 })

      await reconcileShellCommandRuns()

      expect(stored('done')).toMatchObject({ state: 'succeeded', exitCode: 0 })
      expect(state.events).toEqual([])
    })

    it('finalizes a finished detached run from its exit file', async () => {
      addSession('ok', { state: 'running', runId: 'run-ok', detached: true })
      const runDir = makeRunDir('ok', 'run-ok')
      writeControlFiles(runDir)
      writeFileSync(join(runDir, SHELL_COMMAND_RUN_FILES.exit), 'script=0\nwrapper=0\n')

      await reconcileShellCommandRuns()

      expect(stored('ok')).toMatchObject({ state: 'succeeded', exitCode: 0, runId: 'run-ok' })
      expect(stored('ok').finishedAt).not.toBeNull()
      expect(statuses()).toEqual([
        expect.objectContaining({ sessionId: 'ok', state: 'succeeded', runId: 'run-ok' })
      ])
      const files = SHELL_COMMAND_RUN_FILES
      for (const name of [
        files.stdin,
        files.hostPid,
        files.feederPid,
        files.inner,
        files.innerExit,
        files.hostErr
      ]) {
        expect(existsSync(join(runDir, name)), name).toBe(false)
      }
      expect(readFileSync(join(runDir, files.log), 'utf8')).toBe('transcript\r\n')
      expect(existsSync(join(runDir, files.exit))).toBe(true)
      expect(adoptDetached).not.toHaveBeenCalled()
    })

    it('finalizes a failed detached run with its exit code and keeps a non-empty host.err', async () => {
      addSession('bad', { state: 'running', runId: 'run-bad', detached: true })
      const runDir = makeRunDir('bad', 'run-bad')
      writeControlFiles(runDir)
      writeFileSync(join(runDir, SHELL_COMMAND_RUN_FILES.hostErr), 'script: boom\n')
      writeFileSync(join(runDir, SHELL_COMMAND_RUN_FILES.exit), 'script=3\nwrapper=3\n')

      await reconcileShellCommandRuns()

      expect(stored('bad')).toMatchObject({ state: 'failed', exitCode: 3 })
      expect(existsSync(join(runDir, SHELL_COMMAND_RUN_FILES.hostErr))).toBe(true)
      expect(existsSync(join(runDir, SHELL_COMMAND_RUN_FILES.log))).toBe(true)
    })

    it('adopts a detached run whose owner is alive', async () => {
      addSession('live', { state: 'running', runId: 'run-live', detached: true })
      const runDir = makeRunDir('live', 'run-live')
      holdFifo(runDir)

      await reconcileShellCommandRuns()

      expect(adoptDetached).toHaveBeenCalledTimes(1)
      expect(adoptDetached).toHaveBeenCalledWith({
        sessionId: 'live',
        runDir,
        sink: expect.any(Object)
      })
      expect(getLiveShellCommandSessionIds()).toEqual(['live'])
      expect(stored('live').state).toBe('running')
      expect(writeShellCommandRun('live', 'x')).toBe(true)
      // The registry never writes a detached run's log itself.
      expect(existsSync(join(runDir, SHELL_COMMAND_RUN_FILES.log))).toBe(false)

      // A second launch is refused, a view gets the replayed transcript.
      await expect(runShellCommandTerminal('live')).resolves.toMatchObject({
        success: false,
        alreadyRunning: true
      })
      state.events.length = 0
      expect(attachShellCommandTerminal('live')).toMatchObject({
        success: true,
        state: 'running',
        runId: 'run-live'
      })
      expect(state.events.at(-1)?.payload).toContain('replayed tail')

      // The adopted run finishes like any other.
      adoptedSink!.exit({ kind: 'exited', exitCode: 4, signal: null, abnormal: false })
      expect(stored('live')).toMatchObject({ state: 'failed', exitCode: 4 })
      expect(getLiveShellCommandSessionIds()).toEqual([])
    })

    it('leaves an in-app run owned by another app instance untouched', async () => {
      addSession('theirs', { state: 'running', runId: 'run-theirs', detached: false })
      holdFifo(makeRunDir('theirs', 'run-theirs'))
      const before = state.sessions.get('theirs')!.shell_command

      await reconcileShellCommandRuns()

      expect(state.sessions.get('theirs')!.shell_command).toBe(before)
      expect(state.events).toEqual([])
      expect(getLiveShellCommandSessionIds()).toEqual([])
      expect(adoptDetached).not.toHaveBeenCalled()
    })

    it('interrupts runs whose owner is gone', async () => {
      addSession('in-app', { state: 'running', runId: 'run-a', detached: false })
      addSession('detached', { state: 'running', runId: 'run-d', detached: true })
      addSession('no-dir', { state: 'running', runId: 'run-n', detached: false })
      makeRunDir('in-app', 'run-a')
      const detachedDir = makeRunDir('detached', 'run-d')
      writeControlFiles(detachedDir)

      await reconcileShellCommandRuns()

      expect(stored('in-app').state).toBe('interrupted')
      expect(stored('detached').state).toBe('interrupted')
      expect(stored('no-dir').state).toBe('interrupted')
      expect(statuses().map((status) => status.state)).toEqual([
        'interrupted',
        'interrupted',
        'interrupted'
      ])
      expect(existsSync(join(detachedDir, SHELL_COMMAND_RUN_FILES.log))).toBe(true)
      expect(existsSync(join(detachedDir, SHELL_COMMAND_RUN_FILES.hostPid))).toBe(false)
      expect(adoptDetached).not.toHaveBeenCalled()
    })

    it('never rejects, also when the database is unavailable', async () => {
      const spy = vi.spyOn(mocks.db, 'getShellCommandSessionsInStates').mockImplementation(() => {
        throw new Error('db is closed')
      })

      await expect(reconcileShellCommandRuns()).resolves.toBeUndefined()
      spy.mockRestore()
    })
  })

  describe('sweepShellCommandRunDirs', () => {
    const TWO_MINUTES = 2 * 60 * 1000

    it('keeps the run a session refers to, however old', async () => {
      addSession('kept', { state: 'succeeded', runId: 'run-kept', exitCode: 0 })
      const runDir = makeRunDir('kept', 'run-kept')
      age(runDir, RUN_DIR_ORPHAN_MAX_AGE_MS * 2)

      await sweepShellCommandRunDirs()

      expect(existsSync(runDir)).toBe(true)
    })

    it('removes an old unreferenced run and its empty session directory', async () => {
      const runDir = makeRunDir('gone-session', 'run-old')
      writeFileSync(join(runDir, SHELL_COMMAND_RUN_FILES.log), 'old')
      age(runDir, RUN_DIR_ORPHAN_MAX_AGE_MS + TWO_MINUTES)

      await sweepShellCommandRunDirs()

      expect(existsSync(runDir)).toBe(false)
      expect(existsSync(getShellCommandSessionRunsDir('gone-session'))).toBe(false)
    })

    it('removes an old run that its session no longer refers to', async () => {
      addSession('moved-on', { state: 'succeeded', runId: 'run-new', exitCode: 0 })
      const oldDir = makeRunDir('moved-on', 'run-old')
      const newDir = makeRunDir('moved-on', 'run-new')
      age(oldDir, RUN_DIR_ORPHAN_MAX_AGE_MS + TWO_MINUTES)
      age(newDir, RUN_DIR_ORPHAN_MAX_AGE_MS + TWO_MINUTES)

      await sweepShellCommandRunDirs()

      expect(existsSync(oldDir)).toBe(false)
      expect(existsSync(newDir)).toBe(true)
    })

    it('keeps a young unreferenced run', async () => {
      const fresh = makeRunDir('gone-session', 'run-fresh')
      const recent = makeRunDir('gone-session', 'run-recent')
      age(recent, RUN_DIR_ORPHAN_MAX_AGE_MS - TWO_MINUTES)

      await sweepShellCommandRunDirs()

      expect(existsSync(fresh)).toBe(true)
      expect(existsSync(recent)).toBe(true)
      expect(mocks.stopDetachedRun).not.toHaveBeenCalled()
    })

    it('never removes a live in-app run of another app instance', async () => {
      const runDir = makeRunDir('gone-session', 'run-in-app')
      holdFifo(runDir)
      age(runDir, RUN_DIR_ORPHAN_MAX_AGE_MS * 2)

      await sweepShellCommandRunDirs()

      expect(existsSync(runDir)).toBe(true)
      expect(mocks.stopDetachedRun).not.toHaveBeenCalled()
    })

    it('stops, then removes, a live detached run nothing refers to', async () => {
      const runDir = makeRunDir('gone-session', 'run-detached')
      holdFifo(runDir)
      writeFileSync(join(runDir, SHELL_COMMAND_RUN_FILES.hostPid), '999999\n')
      age(runDir, TWO_MINUTES)

      await sweepShellCommandRunDirs()

      expect(mocks.stopDetachedRun).toHaveBeenCalledTimes(1)
      // It was stopped while its files were still there, and removed afterwards.
      expect(state.stopped).toEqual([runDir])
      expect(existsSync(runDir)).toBe(false)
    })

    it('leaves a live detached run alone while it is younger than a minute', async () => {
      const runDir = makeRunDir('gone-session', 'run-starting')
      holdFifo(runDir)
      writeFileSync(join(runDir, SHELL_COMMAND_RUN_FILES.hostPid), '999999\n')

      await sweepShellCommandRunDirs()

      expect(mocks.stopDetachedRun).not.toHaveBeenCalled()
      expect(existsSync(runDir)).toBe(true)
    })

    it('does nothing when there is no runs directory', async () => {
      await expect(sweepShellCommandRunDirs()).resolves.toBeUndefined()
    })
  })
})
