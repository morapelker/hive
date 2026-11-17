import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { ScriptRunner } from './script-runner'

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

describe('ScriptRunner backend event mirroring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes output events to the backend event bus without renderer IPC', async () => {
    const runner = new ScriptRunner()
    const proc = new MockChildProcess(4001)

    spawnMock.mockReturnValue(proc)

    await runner.runPersistent(['echo run'], '/tmp', 'script:run:worktree-1')

    proc.stdout.emit('data', Buffer.from('A'))
    proc.stderr.emit('data', Buffer.from('B'))
    vi.advanceTimersByTime(20)

    const payload = { type: 'output', data: 'AB' }
    await vi.waitFor(() => {
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        'script:run:worktree-1',
        payload
      )
    })
  })

  it('publishes script output through an injected backend event publisher', async () => {
    const runner = new ScriptRunner()
    const proc = new MockChildProcess(4002)
    const publish = vi.fn()

    spawnMock.mockReturnValue(proc)
    runner.setEventPublisher(publish)

    const pending = runner.runSequential(['echo setup'], '/tmp', 'script:setup:worktree-1')

    expect(publish).toHaveBeenCalledWith('script:setup:worktree-1', {
      type: 'command-start',
      command: 'echo setup'
    })

    proc.emit('close', 0)
    await pending
    await vi.waitFor(() => {
      expect(publish).toHaveBeenCalledWith('script:setup:worktree-1', { type: 'done' })
    })
  })
})

describe('ScriptRunner.isRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is false for a key nothing was started under', () => {
    expect(new ScriptRunner().isRunning('script:run:worktree-1')).toBe(false)
  })

  it('follows a run script from its start to its exit', async () => {
    const runner = new ScriptRunner()
    const proc = new MockChildProcess(4101)
    spawnMock.mockReturnValue(proc)

    await runner.runPersistent(['pnpm dev'], '/tmp', 'script:run:worktree-1')

    expect(runner.isRunning('script:run:worktree-1')).toBe(true)
    // Keys are per script kind and worktree.
    expect(runner.isRunning('script:setup:worktree-1')).toBe(false)
    expect(runner.isRunning('script:run:worktree-2')).toBe(false)

    proc.emit('close', 0)

    expect(runner.isRunning('script:run:worktree-1')).toBe(false)
  })

  it('follows a setup script while one of its commands runs', async () => {
    const runner = new ScriptRunner()
    const proc = new MockChildProcess(4102)
    spawnMock.mockReturnValue(proc)

    const pending = runner.runSequential(['pnpm install'], '/tmp', 'script:setup:worktree-1')

    expect(runner.isRunning('script:setup:worktree-1')).toBe(true)

    proc.emit('close', 0)
    await pending

    expect(runner.isRunning('script:setup:worktree-1')).toBe(false)
  })

  it('is false for a process that has exited or was killed before its close event arrived', async () => {
    const runner = new ScriptRunner()
    const exited = new MockChildProcess(4103)
    const killed = new MockChildProcess(4104)
    spawnMock.mockReturnValueOnce(exited).mockReturnValueOnce(killed)

    await runner.runPersistent(['pnpm dev'], '/tmp', 'script:run:worktree-1')
    await runner.runPersistent(['pnpm dev'], '/tmp', 'script:run:worktree-2')
    exited.exitCode = 0
    killed.signalCode = 'SIGTERM'

    expect(runner.isRunning('script:run:worktree-1')).toBe(false)
    expect(runner.isRunning('script:run:worktree-2')).toBe(false)
  })

  it('is false after every script was stopped', async () => {
    const runner = new ScriptRunner()
    spawnMock.mockReturnValue(new MockChildProcess(4105))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      await runner.runPersistent(['pnpm dev'], '/tmp', 'script:run:worktree-1')
      runner.killAll()
    } finally {
      kill.mockRestore()
    }

    expect(runner.isRunning('script:run:worktree-1')).toBe(false)
  })
})
