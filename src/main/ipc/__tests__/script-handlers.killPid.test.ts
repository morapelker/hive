/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    })
  },
  BrowserWindow: class {},
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LoggerService: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
}))

vi.mock('../../db', () => ({
  getDatabase: vi.fn()
}))

vi.mock('../../services/port-registry', () => ({
  getAssignedPort: vi.fn(() => null),
  assignPort: vi.fn(() => 3000)
}))

vi.mock('../../services/telemetry-service', () => ({
  telemetryService: { track: vi.fn() }
}))

import { registerScriptHandlers } from '../script-handlers'
import { __resetRuntimeRegistryForTests } from '../../effect/_shared/runtime'

const mockEvent = {} as any

describe('script:killPid handler', () => {
  const originalKill = process.kill

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    __resetRuntimeRegistryForTests()
    registerScriptHandlers({} as any)
  })

  afterEach(() => {
    process.kill = originalKill
    vi.useRealTimers()
  })

  it('returns ESRCH when the initial SIGTERM reports no such process', async () => {
    process.kill = vi.fn(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    }) as unknown as typeof process.kill

    const result = await handlers.get('script:killPid')!(mockEvent, { pid: 12345 })

    expect(result).toEqual({
      success: true,
      value: { killed: false, reason: 'ESRCH' }
    })
  })

  it('resolves killed when the PID exits after SIGTERM', async () => {
    process.kill = vi.fn((_pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        const error = new Error('no such process') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      return true
    }) as unknown as typeof process.kill

    const pending = handlers.get('script:killPid')!(mockEvent, { pid: 12345 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(pending).resolves.toEqual({
      success: true,
      value: { killed: true }
    })
  })

  it('falls back to SIGKILL when the process remains alive after SIGTERM polling', async () => {
    const kill = vi.fn(() => true)
    process.kill = kill as unknown as typeof process.kill

    const pending = handlers.get('script:killPid')!(mockEvent, { pid: 12345 })
    await vi.advanceTimersByTimeAsync(1300)
    const result = await pending

    expect(kill).toHaveBeenCalledWith(12345, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(12345, 'SIGKILL')
    expect(result).toEqual({
      success: true,
      value: { killed: false, reason: 'still alive after SIGKILL' }
    })
  })

  it.each([0, 1, process.pid])('rejects invalid PID %s', async (pid) => {
    const kill = vi.fn(() => true)
    process.kill = kill as unknown as typeof process.kill

    const result = await handlers.get('script:killPid')!(mockEvent, { pid })

    expect(kill).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: true,
      value: { killed: false, reason: 'EINVAL' }
    })
  })
})
