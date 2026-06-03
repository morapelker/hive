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
