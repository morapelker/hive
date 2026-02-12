import { EventEmitter } from 'events'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const spawnMock = vi.fn()

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  default: {
    spawn: (...args: unknown[]) => spawnMock(...args)
  }
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('electron', () => ({
  BrowserWindow: class {}
}))

import { ScriptRunner } from '../../../src/main/services/script-runner'

class MockChildProcess extends EventEmitter {
  pid: number
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

describe('ScriptRunner process lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('runPersistent uses latest PATH at spawn time', async () => {
    const runner = new ScriptRunner()
    const proc = new MockChildProcess(3001)
    const nextPath = '/tmp/hive-path-from-finder'
    const previousPath = process.env.PATH

    spawnMock.mockReturnValue(proc)

    process.env.PATH = nextPath

    try {
      await runner.runPersistent(['echo run'], '/tmp', 'script:run:env-check')

      const spawnOptions = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv }
      expect(spawnOptions.env.PATH).toBe(nextPath)
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
    }
  })

  test('runPersistent kills existing process before replacing same event key', async () => {
    const runner = new ScriptRunner()
    const killSpy = vi.spyOn(runner, 'killProcess').mockResolvedValue(true)
    const first = new MockChildProcess(1001)
    const second = new MockChildProcess(1002)

    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second)

    await runner.runPersistent(['echo first'], '/tmp', 'script:run:worktree-1')
    await runner.runPersistent(['echo second'], '/tmp', 'script:run:worktree-1')

    expect(killSpy).toHaveBeenCalledWith('script:run:worktree-1')
  })

  test('killProcess signals the Unix process group', async () => {
    const runner = new ScriptRunner()
    const proc = new MockChildProcess(2001)
    const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    spawnMock.mockReturnValue(proc)

    await runner.runPersistent(['echo run'], '/tmp', 'script:run:worktree-2')

    const killPromise = runner.killProcess('script:run:worktree-2')
    expect(processKillSpy).toHaveBeenCalledWith(-2001, 'SIGTERM')

    proc.emit('close', 0)
    await killPromise

    processKillSpy.mockRestore()
  })
})
