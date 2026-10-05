import { execFileSync } from 'node:child_process'
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  SHELL_COMMAND_RUN_FILES,
  getShellCommandRunDir,
  getShellCommandRunsDir,
  getShellCommandSessionRunsDir,
  isValidShellCommandRunId,
  removeShellCommandSessionRunDirs,
  runHasLiveOwner
} from '../shell-command-paths'

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

const describePosix = describe.skipIf(process.platform === 'win32')

describePosix('shell-command-paths', () => {
  let baseDir: string
  const savedDbPath = process.env.HIVE_SERVER_DB_PATH
  const heldFds: number[] = []

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'shellcmd-paths-'))
    process.env.HIVE_SERVER_DB_PATH = join(baseDir, 'hive.db')
  })

  afterEach(() => {
    for (const fd of heldFds.splice(0)) closeSync(fd)
  })

  afterAll(() => {
    if (savedDbPath === undefined) delete process.env.HIVE_SERVER_DB_PATH
    else process.env.HIVE_SERVER_DB_PATH = savedDbPath
    rmSync(baseDir, { recursive: true, force: true })
  })

  function makeRunDir(sessionId: string, runId: string, withFifo = true): string {
    const runDir = getShellCommandRunDir(sessionId, runId)
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    if (withFifo) {
      execFileSync('mkfifo', ['-m', '600', join(runDir, SHELL_COMMAND_RUN_FILES.stdin)])
    }
    return runDir
  }

  function holdFifoOpen(runDir: string): number {
    const fd = openSync(
      join(runDir, SHELL_COMMAND_RUN_FILES.stdin),
      constants.O_RDWR | constants.O_NONBLOCK
    )
    heldFds.push(fd)
    return fd
  }

  it('places the runs directory beside the database', () => {
    expect(getShellCommandRunsDir()).toBe(join(baseDir, 'shell-command-runs'))
    expect(getShellCommandSessionRunsDir('session-1')).toBe(
      join(baseDir, 'shell-command-runs', 'session-1')
    )
    expect(getShellCommandRunDir('session-1', 'run_A')).toBe(
      join(baseDir, 'shell-command-runs', 'session-1', 'run_A')
    )
  })

  it('rejects ids that cannot be directory names', () => {
    expect(isValidShellCommandRunId('abc-DEF_123')).toBe(true)
    expect(isValidShellCommandRunId('')).toBe(false)
    expect(isValidShellCommandRunId('../x')).toBe(false)
    expect(isValidShellCommandRunId('a/b')).toBe(false)
    expect(isValidShellCommandRunId('x'.repeat(65))).toBe(false)
    expect(isValidShellCommandRunId(42)).toBe(false)
    expect(() => getShellCommandSessionRunsDir('../etc')).toThrow(
      'Invalid shell command session id'
    )
    expect(() => getShellCommandRunDir('ok', 'bad/run')).toThrow('Invalid shell command run id')
    expect(() => getShellCommandRunDir('bad id', 'ok')).toThrow('Invalid shell command session id')
  })

  it('runHasLiveOwner follows the FIFO reader', () => {
    const runDir = makeRunDir('live-session', 'run1')
    expect(runHasLiveOwner(runDir)).toBe(false)

    const fd = holdFifoOpen(runDir)
    expect(runHasLiveOwner(runDir)).toBe(true)

    closeSync(fd)
    heldFds.splice(heldFds.indexOf(fd), 1)
    expect(runHasLiveOwner(runDir)).toBe(false)

    expect(runHasLiveOwner(join(baseDir, 'does-not-exist'))).toBe(false)
  })

  it('removeShellCommandSessionRunDirs keeps live runs and removes dead ones', () => {
    const sessionId = 'cleanup-session'
    const liveRun = makeRunDir(sessionId, 'live')
    const deadRun = makeRunDir(sessionId, 'dead')
    const noFifoRun = makeRunDir(sessionId, 'nofifo', false)
    holdFifoOpen(liveRun)

    removeShellCommandSessionRunDirs(sessionId)

    expect(existsSync(liveRun)).toBe(true)
    expect(existsSync(deadRun)).toBe(false)
    expect(existsSync(noFifoRun)).toBe(false)
    expect(existsSync(getShellCommandSessionRunsDir(sessionId))).toBe(true)
  })

  it('removeShellCommandSessionRunDirs removes the session dir once nothing is live', () => {
    const sessionId = 'empty-after-session'
    makeRunDir(sessionId, 'one')
    makeRunDir(sessionId, 'two')

    removeShellCommandSessionRunDirs(sessionId)

    expect(existsSync(getShellCommandSessionRunsDir(sessionId))).toBe(false)
  })

  it('removeShellCommandSessionRunDirs ignores invalid and unknown ids', () => {
    expect(() => removeShellCommandSessionRunDirs('../../etc')).not.toThrow()
    expect(() => removeShellCommandSessionRunDirs('never-created')).not.toThrow()
    expect(existsSync(join(baseDir, 'etc'))).toBe(false)
  })
})
