import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInAppRunHost } from '../shell-command-in-app-host'
import { SHELL_COMMAND_RUN_FILES, runHasLiveOwner } from '../shell-command-paths'
import type { RunHostExit, ShellCommandRunHostOptions } from '../shell-command-run-host'
import { buildShellCommandPtySpawn } from '../shell-command-spawner'

type DataListener = (data: string) => void
type ExitListener = (code: number, signal: number) => void

const ptyMocks = vi.hoisted(() => {
  const state = {
    live: new Set<string>(),
    dataListeners: [] as Array<(data: string) => void>,
    exitListeners: [] as Array<(code: number, signal: number) => void>
  }
  return {
    state,
    has: vi.fn((id: string) => state.live.has(id)),
    create: vi.fn((id: string, _opts: Record<string, unknown>) => {
      state.live.add(id)
      return { cols: 80, rows: 24 }
    }),
    onData: vi.fn((_id: string, listener: (data: string) => void) => {
      state.dataListeners.push(listener)
      return () => {
        state.dataListeners = state.dataListeners.filter((entry) => entry !== listener)
      }
    }),
    onExit: vi.fn((_id: string, listener: (code: number, signal: number) => void) => {
      state.exitListeners.push(listener)
      return () => {
        state.exitListeners = state.exitListeners.filter((entry) => entry !== listener)
      }
    }),
    write: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn((id: string) => {
      state.live.delete(id)
    })
  }
})

vi.mock('../pty-service', () => ({
  ptyService: ptyMocks
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

/** What the real pty-service does when the process exits: notify, then forget the id. */
function firePtyExit(id: string, code: number, signal: number): void {
  const listeners: ExitListener[] = [...ptyMocks.state.exitListeners]
  for (const listener of listeners) listener(code, signal)
  ptyMocks.state.live.delete(id)
}

function firePtyData(data: string): void {
  const listeners: DataListener[] = [...ptyMocks.state.dataListeners]
  for (const listener of listeners) listener(data)
}

describe.skipIf(process.platform === 'win32')('createInAppRunHost', () => {
  const SESSION_ID = 'session-in-app'
  let baseDir: string
  let runDir: string
  let data: string[]
  let exits: RunHostExit[]

  function options(
    overrides: Partial<ShellCommandRunHostOptions> = {}
  ): ShellCommandRunHostOptions {
    return {
      sessionId: SESSION_ID,
      runDir,
      cwd: baseDir,
      steps: ['echo one', 'echo two'],
      env: { HIVE_WORKTREE_PATH: '/w', CUSTOM: 'yes' },
      cols: 132,
      rows: 43,
      sink: {
        data: (chunk) => data.push(chunk),
        exit: (exit) => exits.push(exit)
      },
      ...overrides
    }
  }

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'shellcmd-inapp-'))
    runDir = join(baseDir, 'runs', SESSION_ID, 'run-1')
    data = []
    exits = []
    ptyMocks.state.live.clear()
    ptyMocks.state.dataListeners = []
    ptyMocks.state.exitListeners = []
    vi.clearAllMocks()
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('refuses to start when a terminal already uses the session id', async () => {
    ptyMocks.state.live.add(SESSION_ID)
    const host = createInAppRunHost(options())

    await expect(host.start()).rejects.toThrow('A terminal is already running for this session')

    expect(ptyMocks.create).not.toHaveBeenCalled()
    expect(existsSync(runDir)).toBe(false)
  })

  it('rejects before touching anything when there are no steps', async () => {
    const host = createInAppRunHost(options({ steps: [] }))
    await expect(host.start()).rejects.toThrow('Shell command has no runnable lines')
    expect(ptyMocks.create).not.toHaveBeenCalled()
    expect(existsSync(runDir)).toBe(false)
  })

  it('creates the PTY once from the spawn builder, without captureRemote', async () => {
    const host = createInAppRunHost(options())
    expect(host.mode).toBe('in-app')
    await host.start()

    const spawn = buildShellCommandPtySpawn(['echo one', 'echo two'])
    expect(ptyMocks.create).toHaveBeenCalledTimes(1)
    expect(ptyMocks.create).toHaveBeenCalledWith(SESSION_ID, {
      cwd: baseDir,
      command: spawn.command,
      args: spawn.args,
      env: { HIVE_WORKTREE_PATH: '/w', CUSTOM: 'yes' },
      cols: 132,
      rows: 43
    })
    const opts = ptyMocks.create.mock.calls[0][1]
    expect(opts).not.toHaveProperty('captureRemote')
    expect(opts).not.toHaveProperty('shell')
    expect(ptyMocks.onData).toHaveBeenCalledTimes(1)
    expect(ptyMocks.onExit).toHaveBeenCalledTimes(1)
    await host.stop()
  })

  it('holds the owner beacon while the run lives and releases it on exit', async () => {
    const host = createInAppRunHost(options())
    await host.start()

    expect(existsSync(join(runDir, SHELL_COMMAND_RUN_FILES.stdin))).toBe(true)
    expect(runHasLiveOwner(runDir)).toBe(true)

    firePtyExit(SESSION_ID, 0, 0)
    expect(runHasLiveOwner(runDir)).toBe(false)
  })

  it('forwards PTY data to the sink until the run ends', async () => {
    const host = createInAppRunHost(options())
    await host.start()

    firePtyData('hello ')
    firePtyData('world')
    expect(data).toEqual(['hello ', 'world'])

    await host.stop()
    firePtyData('late')
    expect(data).toEqual(['hello ', 'world'])
  })

  it.each([
    { code: 0, signal: 0, expected: { exitCode: 0, signal: null, abnormal: false } },
    { code: 3, signal: 0, expected: { exitCode: 3, signal: null, abnormal: false } },
    { code: 0, signal: 15, expected: { exitCode: 143, signal: 15, abnormal: true } },
    { code: 1, signal: 1, expected: { exitCode: 129, signal: 1, abnormal: true } },
    { code: -1, signal: 0, expected: { exitCode: 1, signal: null, abnormal: false } },
    { code: 300, signal: 0, expected: { exitCode: 1, signal: null, abnormal: false } }
  ])('maps PTY exit ($code, $signal) to the sink', async ({ code, signal, expected }) => {
    const host = createInAppRunHost(options())
    await host.start()

    firePtyExit(SESSION_ID, code, signal)

    expect(exits).toEqual([{ kind: 'exited', ...expected }])
  })

  it('write and resize reach the PTY while the run is live', async () => {
    const host = createInAppRunHost(options())
    host.write('too early')
    host.resize(10, 10)
    expect(ptyMocks.write).not.toHaveBeenCalled()
    expect(ptyMocks.resize).not.toHaveBeenCalled()

    await host.start()
    host.write('y\r')
    host.resize(100, 30)

    expect(ptyMocks.write).toHaveBeenCalledWith(SESSION_ID, 'y\r')
    expect(ptyMocks.resize).toHaveBeenCalledWith(SESSION_ID, 100, 30)
    await host.stop()
  })

  it('stop() removes the listeners, destroys once, and a later PTY exit is ignored', async () => {
    const host = createInAppRunHost(options())
    await host.start()

    await host.stop()

    expect(ptyMocks.destroy).toHaveBeenCalledTimes(1)
    expect(ptyMocks.destroy).toHaveBeenCalledWith(SESSION_ID)
    expect(ptyMocks.state.dataListeners).toHaveLength(0)
    expect(ptyMocks.state.exitListeners).toHaveLength(0)
    expect(runHasLiveOwner(runDir)).toBe(false)

    firePtyExit(SESSION_ID, 0, 1)
    expect(exits).toEqual([])

    await host.stop()
    expect(ptyMocks.destroy).toHaveBeenCalledTimes(1)
    expect(ptyMocks.write).not.toHaveBeenCalled()
  })

  it('never touches ptyService again after a natural exit', async () => {
    const host = createInAppRunHost(options())
    await host.start()
    firePtyExit(SESSION_ID, 0, 0)

    // The id now belongs to the next run's PTY (Run again).
    ptyMocks.state.live.add(SESSION_ID)
    vi.clearAllMocks()

    await host.stop()
    host.write('x')
    host.resize(90, 20)
    host.detach()

    expect(ptyMocks.destroy).not.toHaveBeenCalled()
    expect(ptyMocks.write).not.toHaveBeenCalled()
    expect(ptyMocks.resize).not.toHaveBeenCalled()
    expect(exits).toHaveLength(1)
  })

  it('detach() releases listeners and the beacon without killing anything', async () => {
    const host = createInAppRunHost(options())
    await host.start()

    host.detach()

    expect(ptyMocks.destroy).not.toHaveBeenCalled()
    expect(ptyMocks.state.dataListeners).toHaveLength(0)
    expect(ptyMocks.state.exitListeners).toHaveLength(0)
    expect(runHasLiveOwner(runDir)).toBe(false)

    host.write('x')
    host.resize(90, 20)
    await host.stop()
    expect(ptyMocks.write).not.toHaveBeenCalled()
    expect(ptyMocks.resize).not.toHaveBeenCalled()
    expect(ptyMocks.destroy).not.toHaveBeenCalled()
    expect(exits).toEqual([])
  })

  it('closes the beacon and rethrows when the PTY cannot be created', async () => {
    ptyMocks.create.mockImplementationOnce(() => {
      throw new Error('posix_spawnp failed.')
    })
    const host = createInAppRunHost(options())

    await expect(host.start()).rejects.toThrow('posix_spawnp failed.')

    expect(runHasLiveOwner(runDir)).toBe(false)
    expect(ptyMocks.onData).not.toHaveBeenCalled()
    host.write('x')
    expect(ptyMocks.write).not.toHaveBeenCalled()
  })

  it('still runs when the beacon cannot be created', async () => {
    // A directory where the run's FIFO should go: mkfifo fails.
    mkdirSync(join(runDir, SHELL_COMMAND_RUN_FILES.stdin), { recursive: true })
    const host = createInAppRunHost(options())

    await host.start()

    expect(ptyMocks.create).toHaveBeenCalledTimes(1)
    expect(runHasLiveOwner(runDir)).toBe(false)
    firePtyExit(SESSION_ID, 2, 0)
    expect(exits).toEqual([{ kind: 'exited', exitCode: 2, signal: null, abnormal: false }])
  })
})
