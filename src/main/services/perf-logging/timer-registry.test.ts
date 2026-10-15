import { afterEach, describe, expect, it } from 'vitest'
import {
  captureOrigin,
  installTimerRegistry,
  isTimerRegistryInstalled,
  snapshotTimerRegistry,
  uninstallTimerRegistry
} from './timer-registry'

describe('timer registry', () => {
  afterEach(() => {
    uninstallTimerRegistry()
  })

  it('counts live intervals and timeouts by origin and forgets cleared ones', async () => {
    const originalSetInterval = globalThis.setInterval
    installTimerRegistry()
    expect(isTimerRegistryInstalled()).toBe(true)
    expect(globalThis.setInterval).not.toBe(originalSetInterval)

    const interval = setInterval(() => undefined, 10_000)
    const timeout = setTimeout(() => undefined, 10_000)
    let snapshot = snapshotTimerRegistry()
    expect(snapshot.intervals).toBe(1)
    expect(snapshot.timeouts).toBe(1)
    expect(snapshot.byOrigin[0]?.origin).toContain('timer-registry.test.ts')

    clearInterval(interval)
    clearTimeout(timeout)
    snapshot = snapshotTimerRegistry()
    expect(snapshot.intervals).toBe(0)
    expect(snapshot.timeouts).toBe(0)

    // A timeout that fires removes itself.
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
    expect(snapshotTimerRegistry().timeouts).toBe(0)

    uninstallTimerRegistry()
    expect(globalThis.setInterval).toBe(originalSetInterval)
    expect(isTimerRegistryInstalled()).toBe(false)
  })

  it('keeps timer handles usable (unref/refresh) and promisified setTimeout working', async () => {
    installTimerRegistry()
    const handle = setTimeout(() => undefined, 50)
    expect(typeof handle.unref).toBe('function')
    handle.unref()
    handle.refresh()
    clearTimeout(handle)
    const { promisify } = await import('node:util')
    const sleep = promisify(setTimeout)
    await expect(sleep(1)).resolves.toBeUndefined()
  })

  it('captures a short origin for the current call site', () => {
    const origin = captureOrigin()
    expect(origin).toMatch(/timer-registry\.test\.ts:\d+$/)
  })
})
