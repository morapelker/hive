import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '../../shared/rpc/protocol'
import { makeEventBus } from '../events/event-bus'
import { makeLiveTerminalOpsRpcService } from '../rpc/domains/terminal-ops'

const ptyServiceMocks = vi.hoisted(() => ({
  has: vi.fn(),
  create: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
  destroy: vi.fn(),
  write: vi.fn(),
  resize: vi.fn()
}))

vi.mock('../../main/services/ghostty-config', () => ({
  parseGhosttyConfig: vi.fn(() => ({}))
}))

vi.mock('../../main/services/pty-service', () => ({
  ptyService: ptyServiceMocks
}))

const waitImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('terminal ops RPC live service', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates backend-owned PTYs and publishes buffered data and exit events', async () => {
    const removeData = vi.fn()
    const removeExit = vi.fn()
    let dataCallback: ((data: string) => void) | null = null
    let exitCallback: ((code: number, signal: number) => void) | null = null
    ptyServiceMocks.has.mockReturnValue(false)
    ptyServiceMocks.create.mockReturnValue({ cols: 120, rows: 32 })
    ptyServiceMocks.onData.mockImplementation((_terminalId, callback) => {
      dataCallback = callback
      return removeData
    })
    ptyServiceMocks.onExit.mockImplementation((_terminalId, callback) => {
      exitCallback = callback
      return removeExit
    })
    const eventBus = makeEventBus()
    const events: ServerEvent[] = []
    await Effect.runPromise(eventBus.subscribeAll((event) => events.push(event)))

    const service = makeLiveTerminalOpsRpcService(eventBus)
    const result = await Effect.runPromise(service.create('terminal-1', '/tmp/project', '/bin/zsh'))

    expect(result).toEqual({ success: true, cols: 120, rows: 32 })
    expect(ptyServiceMocks.create).toHaveBeenCalledWith('terminal-1', {
      cwd: '/tmp/project',
      shell: '/bin/zsh'
    })
    expect(ptyServiceMocks.onData).toHaveBeenCalledWith('terminal-1', expect.any(Function))
    expect(ptyServiceMocks.onExit).toHaveBeenCalledWith('terminal-1', expect.any(Function))

    dataCallback?.('hel')
    dataCallback?.('lo')
    await waitImmediate()

    exitCallback?.(7, 0)
    await Promise.resolve()

    expect(events).toEqual([
      { channel: 'terminal:data:terminal-1', payload: 'hello' },
      { channel: 'terminal:exit:terminal-1', payload: 7 }
    ])
    expect(removeData).toHaveBeenCalledTimes(1)
    expect(removeExit).toHaveBeenCalledTimes(1)
  })

  it('writes to backend-owned PTYs without using the desktop command fallback', async () => {
    ptyServiceMocks.has.mockReturnValue(true)

    const service = makeLiveTerminalOpsRpcService(makeEventBus())

    await expect(Effect.runPromise(service.write('terminal-1', 'ls\n'))).resolves.toBeUndefined()

    expect(ptyServiceMocks.has).toHaveBeenCalledWith('terminal-1')
    expect(ptyServiceMocks.write).toHaveBeenCalledWith('terminal-1', 'ls\n')
  })

  it('resizes backend-owned PTYs without using the desktop command fallback', async () => {
    ptyServiceMocks.has.mockReturnValue(true)

    const service = makeLiveTerminalOpsRpcService(makeEventBus())

    await expect(Effect.runPromise(service.resize('terminal-1', 120, 32))).resolves.toBeUndefined()

    expect(ptyServiceMocks.has).toHaveBeenCalledWith('terminal-1')
    expect(ptyServiceMocks.resize).toHaveBeenCalledWith('terminal-1', 120, 32)
  })

  it('destroys backend-owned PTYs after detaching event listeners', async () => {
    const removeData = vi.fn()
    const removeExit = vi.fn()
    ptyServiceMocks.has.mockReturnValueOnce(false).mockReturnValueOnce(true)
    ptyServiceMocks.create.mockReturnValue({ cols: 120, rows: 32 })
    ptyServiceMocks.onData.mockReturnValue(removeData)
    ptyServiceMocks.onExit.mockReturnValue(removeExit)
    const service = makeLiveTerminalOpsRpcService(makeEventBus())

    await Effect.runPromise(service.create('terminal-1', '/tmp/project', '/bin/zsh'))
    await expect(Effect.runPromise(service.destroy('terminal-1'))).resolves.toBeUndefined()

    expect(removeData).toHaveBeenCalledTimes(1)
    expect(removeExit).toHaveBeenCalledTimes(1)
    expect(ptyServiceMocks.destroy).toHaveBeenCalledWith('terminal-1')
  })

  it('reports Ghostty unavailable without a desktop command transport', async () => {
    const originalSend = process.send
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLiveTerminalOpsRpcService(makeEventBus())

      await expect(Effect.runPromise(service.ghosttyIsAvailable())).resolves.toEqual({
        available: false,
        initialized: false,
        platform: process.platform
      })
    } finally {
      Object.defineProperty(process, 'send', {
        configurable: true,
        value: originalSend
      })
    }
  })
})
