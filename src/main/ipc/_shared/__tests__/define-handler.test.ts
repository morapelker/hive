/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Effect } from 'effect'
import { z } from 'zod'

// Capture ipcMain.handle registrations in a Map (the canonical pattern from
// test/phase-21/session-5/ipc-messages-routing.test.ts).
const handlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    })
  },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('../../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LoggerService: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
}))

import { defineHandler } from '../define-handler'
import { __resetRuntimeRegistryForTests } from '../../../effect/_shared/runtime'

const mockEvent = {} as any

describe('defineHandler', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    __resetRuntimeRegistryForTests()
  })

  it('returns success envelope on success', async () => {
    defineHandler('test:echo', z.string(), (input) => Effect.succeed({ echoed: input }))
    const result = await handlers.get('test:echo')!(mockEvent, 'hello')
    expect(result).toEqual({ success: true, value: { echoed: 'hello' } })
  })

  it('returns ZodDecodeError envelope when input fails validation', async () => {
    defineHandler('test:echo', z.string(), (input) => Effect.succeed(input))
    const result = await handlers.get('test:echo')!(mockEvent, 42)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('ZodDecodeError')
    expect(result.error).toMatch(/expected string/i)
    expect(result.details).toBeDefined()
  })

  it('returns failure envelope with error _tag when handler fails', async () => {
    class BoomError {
      readonly _tag = 'BoomError'
      readonly message = 'kaboom'
      constructor(public readonly reason: string) {}
    }
    defineHandler('test:fail', z.string(), () => Effect.fail(new BoomError('bad input')))
    const result = await handlers.get('test:fail')!(mockEvent, 'x')
    expect(result).toMatchObject({
      success: false,
      errorCode: 'BoomError',
      details: { reason: 'bad input' }
    })
  })

  it('returns UnexpectedDefect envelope when handler throws', async () => {
    defineHandler('test:defect', z.string(), () =>
      Effect.sync(() => {
        throw new Error('synchronous boom')
      })
    )
    const result = await handlers.get('test:defect')!(mockEvent, 'x')
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('UnexpectedDefect')
  })

  it('decodes multi-arg invocations as a tuple', async () => {
    const schema = z.tuple([z.string(), z.number()])
    defineHandler('test:tuple', schema, ([s, n]) => Effect.succeed(`${s}:${n}`))
    const result = await handlers.get('test:tuple')!(mockEvent, 'foo', 7)
    expect(result).toEqual({ success: true, value: 'foo:7' })
  })

  it('decodes single-arg invocations as the raw value', async () => {
    defineHandler('test:object', z.object({ a: z.string() }), ({ a }) =>
      Effect.succeed(a.toUpperCase())
    )
    const result = await handlers.get('test:object')!(mockEvent, { a: 'hi' })
    expect(result).toEqual({ success: true, value: 'HI' })
  })
})
