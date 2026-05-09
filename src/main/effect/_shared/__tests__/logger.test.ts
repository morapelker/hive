// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

import { LogLevel } from '../../../services/logger'
import { LoggerLive, withLogComponent } from '../logger'

type LogCall =
  | {
      readonly level: 'debug' | 'info' | 'warn'
      readonly component: string
      readonly message: string
      readonly data?: Record<string, unknown>
    }
  | {
      readonly level: 'error'
      readonly component: string
      readonly message: string
      readonly error?: Error
      readonly data?: Record<string, unknown>
    }

const { calls } = vi.hoisted(() => ({ calls: [] as LogCall[] }))

vi.mock('../../../services/logger', () => {
  const service = {
    debug: vi.fn((component: string, message: string, data?: Record<string, unknown>) => {
      calls.push({ level: 'debug', component, message, data })
    }),
    info: vi.fn((component: string, message: string, data?: Record<string, unknown>) => {
      calls.push({ level: 'info', component, message, data })
    }),
    warn: vi.fn((component: string, message: string, data?: Record<string, unknown>) => {
      calls.push({ level: 'warn', component, message, data })
    }),
    error: vi.fn(
      (component: string, message: string, error?: Error, data?: Record<string, unknown>) => {
        calls.push({ level: 'error', component, message, error, data })
      }
    )
  }

  return {
    LogLevel: {
      DEBUG: 0,
      INFO: 1,
      WARN: 2,
      ERROR: 3
    },
    LoggerService: {
      getInstance: vi.fn(() => service)
    }
  }
})

const runLogged = (effect: Effect.Effect<void>) =>
  Effect.runPromise(effect.pipe(Effect.provide(LoggerLive)))

describe('LoggerLive', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('bridges info logs with component annotation and structured data', async () => {
    await runLogged(Effect.logInfo('hi', { foo: 'bar' }).pipe(withLogComponent('TestProbe')))

    expect(calls).toEqual([
      {
        level: 'info',
        component: 'TestProbe',
        message: 'hi',
        data: { foo: 'bar' }
      }
    ])
    expect(LogLevel.INFO).toBe(1)
  })

  it('defaults component when no annotation is provided', async () => {
    await runLogged(Effect.logInfo('hi'))

    expect(calls).toEqual([
      {
        level: 'info',
        component: 'EffectIsland',
        message: 'hi',
        data: undefined
      }
    ])
  })

  it('passes Error instances to LoggerService.error', async () => {
    const error = new Error('x')

    await runLogged(Effect.logError('boom', error).pipe(withLogComponent('TestProbe')))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      level: 'error',
      component: 'TestProbe',
      message: 'boom',
      data: undefined
    })
    expect(calls[0]).toHaveProperty('error', error)
  })
})
