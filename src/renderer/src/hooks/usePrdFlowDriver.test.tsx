// The hook that keeps the PRD flows of a window moving: one driver over the live ports while
// its host is mounted, stopped with it, and still one driver at work when React mounts the
// host twice in a row (StrictMode).
import { cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePrdFlowDriver } from './usePrdFlowDriver'

const mocks = vi.hoisted(() => {
  /** Every driver the hook made, in order, with whether it is at work. */
  const drivers: { ports: unknown; running: boolean; starts: number; stops: number }[] = []
  class PrdFlowDriver {
    private readonly record: (typeof drivers)[number]
    constructor(ports: unknown) {
      this.record = { ports, running: false, starts: 0, stops: 0 }
      drivers.push(this.record)
    }
    start(): void {
      this.record.running = true
      this.record.starts++
    }
    stop(): void {
      this.record.running = false
      this.record.stops++
    }
  }
  let made = 0
  return { drivers, PrdFlowDriver, createLivePrdFlowPorts: vi.fn(() => ({ ports: ++made })) }
})

vi.mock('@/lib/prd-flow/driver', () => ({ PrdFlowDriver: mocks.PrdFlowDriver }))
vi.mock('@/lib/prd-flow/live-ports', () => ({
  createLivePrdFlowPorts: mocks.createLivePrdFlowPorts
}))

function Host(): null {
  usePrdFlowDriver()
  return null
}

const atWork = (): number => mocks.drivers.filter((driver) => driver.running).length

beforeEach(() => {
  mocks.drivers.length = 0
  mocks.createLivePrdFlowPorts.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('usePrdFlowDriver', () => {
  it('starts one driver over the live ports when its host mounts', () => {
    render(<Host />)

    expect(mocks.createLivePrdFlowPorts).toHaveBeenCalledTimes(1)
    expect(mocks.drivers).toHaveLength(1)
    expect(mocks.drivers[0].ports).toBe(mocks.createLivePrdFlowPorts.mock.results[0].value)
    expect(mocks.drivers[0]).toMatchObject({ running: true, starts: 1, stops: 0 })
  })

  it('keeps the same driver at work while the host renders again', () => {
    const { rerender } = render(<Host />)

    rerender(<Host />)
    rerender(<Host />)

    expect(mocks.drivers).toHaveLength(1)
    expect(mocks.drivers[0]).toMatchObject({ running: true, starts: 1, stops: 0 })
  })

  it('stops the driver when its host unmounts', () => {
    const { unmount } = render(<Host />)

    unmount()

    expect(mocks.drivers[0]).toMatchObject({ running: false, starts: 1, stops: 1 })
    expect(atWork()).toBe(0)
  })

  it('leaves one driver at work, on ports of its own, when React mounts the host twice', () => {
    render(
      <StrictMode>
        <Host />
      </StrictMode>
    )

    // The first mount's driver was stopped before the second one's was started.
    expect(mocks.drivers).toHaveLength(2)
    expect(mocks.drivers[0]).toMatchObject({ running: false, starts: 1, stops: 1 })
    expect(mocks.drivers[1]).toMatchObject({ running: true, starts: 1, stops: 0 })
    expect(mocks.drivers[1].ports).not.toBe(mocks.drivers[0].ports)
    expect(atWork()).toBe(1)
  })
})
