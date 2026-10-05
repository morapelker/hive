import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isDesktopCommandRequest,
  makeDesktopCommandResult,
  type DesktopCommandRequest as AnyDesktopCommandRequest
} from '../../shared/desktop-command'
import {
  makeLiveTerminalOpsRpcService,
  makeTerminalOpsRpcHandlers,
  type TerminalOpsRpcService
} from '../rpc/domains/terminal-ops'
import type { RpcContext, RpcHandler } from '../rpc/router'

vi.mock('../../main/services/ghostty-config-store', () => ({
  getGhosttyTerminalConfig: vi.fn(() => ({}))
}))

vi.mock('../../main/services/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

vi.mock('../../main/services/pty-service', () => ({
  ptyService: {
    has: vi.fn(),
    create: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    destroy: vi.fn(),
    write: vi.fn(),
    writeRemote: vi.fn(),
    resize: vi.fn()
  }
}))

/** The two requests under test always carry a payload. */
type DesktopCommandRequest = AnyDesktopCommandRequest & { payload?: unknown }

const NOT_AVAILABLE = {
  success: false,
  error: 'Shell commands are not available in this environment'
}

const METHODS = ['terminalOps.runShellCommand', 'terminalOps.attachShellCommand'] as const

const originalSend = process.send

const call = (handler: RpcHandler, params: unknown): Promise<unknown> =>
  Effect.runPromise(handler(params, {} as RpcContext))

const setProcessSend = (value: typeof process.send): void => {
  Object.defineProperty(process, 'send', { configurable: true, value })
}

/**
 * Stands in for the Electron main process: records the desktop command the service
 * sends and answers it through the 'message' listener the service registered. The
 * listener is captured instead of emitting on the real process, whose 'message' event
 * also carries the test runner's own traffic.
 */
const answerDesktopCommands = (
  answer: (request: DesktopCommandRequest) => unknown
): DesktopCommandRequest[] => {
  const requests: DesktopCommandRequest[] = []
  const listeners = new Set<(message: unknown) => void>()
  const realOn = process.on.bind(process)
  const realOff = process.off.bind(process)
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: never) => {
    if (event !== 'message') return realOn(event, listener)
    listeners.add(listener)
    return process
  }) as typeof process.on)
  vi.spyOn(process, 'off').mockImplementation(((event: string, listener: never) => {
    if (event !== 'message') return realOff(event, listener)
    listeners.delete(listener)
    return process
  }) as typeof process.off)
  setProcessSend(((message: unknown, callback?: (error: Error | null) => void) => {
    if (!isDesktopCommandRequest(message)) return false
    requests.push(message)
    callback?.(null)
    setImmediate(() => {
      const result = makeDesktopCommandResult(message.id, { ok: true, value: answer(message) })
      for (const listener of [...listeners]) listener(result)
    })
    return true
  }) as typeof process.send)
  return requests
}

describe('terminal ops shell command RPC', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    setProcessSend(originalSend)
  })

  describe.each(METHODS)('%s', (method) => {
    const member = method === METHODS[0] ? 'runShellCommand' : 'attachShellCommand'

    it('rejects params with an extra key or an empty sessionId', async () => {
      const fake = vi.fn(() => Effect.succeed({ success: true }))
      const service = { ...makeLiveTerminalOpsRpcService(), [member]: fake }
      const handler = makeTerminalOpsRpcHandlers(service).get(method)!

      await expect(call(handler, { sessionId: 'session-1', cwd: '/tmp' })).rejects.toBeDefined()
      await expect(call(handler, { sessionId: '' })).rejects.toBeDefined()
      await expect(call(handler, {})).rejects.toBeDefined()
      await expect(call(handler, undefined)).rejects.toBeDefined()
      expect(fake).not.toHaveBeenCalled()
    })

    it('forwards the session id to the service and returns its value', async () => {
      const value = { success: true, cols: 100, rows: 30 }
      const fake = vi.fn(() => Effect.succeed(value))
      const service = { ...makeLiveTerminalOpsRpcService(), [member]: fake }
      const handler = makeTerminalOpsRpcHandlers(service).get(method)!

      await expect(call(handler, { sessionId: 'session-1' })).resolves.toEqual(value)
      expect(fake).toHaveBeenCalledTimes(1)
      expect(fake).toHaveBeenCalledWith('session-1')
    })

    it('answers "not available" when the service has no such member', async () => {
      const service: TerminalOpsRpcService = {
        ...makeLiveTerminalOpsRpcService(),
        [member]: undefined
      }
      const handler = makeTerminalOpsRpcHandlers(service).get(method)!

      await expect(call(handler, { sessionId: 'session-1' })).resolves.toEqual(NOT_AVAILABLE)
    })

    it('resolves a transport error without process.send', async () => {
      setProcessSend(undefined)
      const handler = makeTerminalOpsRpcHandlers(makeLiveTerminalOpsRpcService()).get(method)!

      await expect(call(handler, { sessionId: 'session-1' })).resolves.toEqual({
        success: false,
        error: 'Desktop command transport is not available'
      })
    })
  })

  it('sends terminalRunShellCommand to the desktop and returns its result', async () => {
    const requests = answerDesktopCommands(() => ({
      success: false,
      alreadyRunning: true,
      error: 'Command is already running'
    }))
    const service = makeLiveTerminalOpsRpcService()

    await expect(Effect.runPromise(service.runShellCommand!('session-1'))).resolves.toEqual({
      success: false,
      alreadyRunning: true,
      error: 'Command is already running'
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].command).toBe('terminalRunShellCommand')
    expect(requests[0].payload).toEqual({ sessionId: 'session-1' })
    expect(requests[0].id).toMatch(/^terminal-run-shell-command-/)
  })

  it('sends terminalAttachShellCommand to the desktop and returns its result', async () => {
    const value = {
      success: true,
      cols: 80,
      rows: 24,
      state: 'failed',
      exitCode: 3,
      runId: 'run-1'
    }
    const requests = answerDesktopCommands(() => value)
    const service = makeLiveTerminalOpsRpcService()

    await expect(Effect.runPromise(service.attachShellCommand!('session-1'))).resolves.toEqual(
      value
    )
    expect(requests).toHaveLength(1)
    expect(requests[0].command).toBe('terminalAttachShellCommand')
    expect(requests[0].payload).toEqual({ sessionId: 'session-1' })
    expect(requests[0].id).toMatch(/^terminal-attach-shell-command-/)
  })

  it('rejects a malformed desktop answer instead of passing it on', async () => {
    answerDesktopCommands((request) =>
      request.command === 'terminalAttachShellCommand'
        ? { success: true, state: 'exploded' }
        : { success: true, alreadyRunning: 'yes' }
    )
    const service = makeLiveTerminalOpsRpcService()

    await expect(Effect.runPromise(service.attachShellCommand!('session-1'))).resolves.toEqual({
      success: false,
      error: 'Invalid desktop command response for terminalAttachShellCommand'
    })
    await expect(Effect.runPromise(service.runShellCommand!('session-1'))).resolves.toEqual({
      success: false,
      error: 'Invalid desktop command response for terminalRunShellCommand'
    })
  })
})
