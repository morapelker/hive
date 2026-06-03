// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { CliHookTransportRouter, type CliHookTransport } from '../cli-hook-transport-router'

const makeTransport = (name: string, registered: boolean): CliHookTransport => ({
  name,
  isRegistered: vi.fn(() => registered),
  onHook: vi.fn(() => true),
  cancelAll: vi.fn()
})

describe('CliHookTransportRouter', () => {
  it('routes a hook to the first registered transport only', () => {
    const first = makeTransport('first', true)
    const second = makeTransport('second', true)
    const router = new CliHookTransportRouter([first, second])
    const res = {} as ServerResponse
    const body = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }

    expect(router.routeHook('session-1', body, res)).toBe(true)

    expect(first.onHook).toHaveBeenCalledWith('session-1', body, res)
    expect(second.onHook).not.toHaveBeenCalled()
  })

  it('returns false when no transport owns the session', () => {
    const transport = makeTransport('none', false)
    const router = new CliHookTransportRouter([transport])

    expect(router.routeHook('session-1', {}, {} as ServerResponse)).toBe(false)
    expect(transport.onHook).not.toHaveBeenCalled()
  })

  it('fans cancelAll out to all transports', () => {
    const first = makeTransport('first', false)
    const second = makeTransport('second', false)
    const router = new CliHookTransportRouter([first, second])

    router.cancelAll()

    expect(first.cancelAll).toHaveBeenCalledTimes(1)
    expect(second.cancelAll).toHaveBeenCalledTimes(1)
  })
})
