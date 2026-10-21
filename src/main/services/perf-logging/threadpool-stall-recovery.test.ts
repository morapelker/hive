// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ThreadpoolProbeResult } from './threadpool-probe'
import { createThreadpoolStallRecovery } from './threadpool-stall-recovery'

const stalled: ThreadpoolProbeResult = {
  fsMs: null,
  dnsMs: null,
  ok: false,
  requests: { requests: 2, requestsByType: {}, pendingLookups: [] } as never
}

function setup() {
  const wake = vi.fn(() => ({ found: 4, signalled: 4 }))
  const promptRestart = vi.fn()
  const dumpHandles = vi.fn()
  const log = { warn: vi.fn(), info: vi.fn() }
  const recovery = createThreadpoolStallRecovery({
    stallAfter: 2,
    promptRestartAfter: 8,
    log,
    wake,
    promptRestart,
    dumpHandles
  })
  return { recovery, wake, promptRestart, dumpHandles, log }
}

describe('createThreadpoolStallRecovery', () => {
  it('wakes the pool on the first stalled ticks, then every tenth', () => {
    const { recovery, wake } = setup()
    const wokeAt: number[] = []
    for (let misses = 2; misses <= 40; misses++) {
      const before = wake.mock.calls.length
      recovery.onStall(stalled, misses)
      if (wake.mock.calls.length > before) wokeAt.push(misses)
    }
    expect(wokeAt).toEqual([2, 3, 4, 12, 22, 32])
  })

  it('offers a restart once per stall, and again after a recovery and a new stall', () => {
    const { recovery, promptRestart } = setup()
    for (let misses = 2; misses <= 20; misses++) recovery.onStall(stalled, misses)
    expect(promptRestart).toHaveBeenCalledTimes(1)

    recovery.onRecover(stalled, 20)
    for (let misses = 2; misses <= 7; misses++) recovery.onStall(stalled, misses)
    expect(promptRestart).toHaveBeenCalledTimes(1)
    recovery.onStall(stalled, 8)
    expect(promptRestart).toHaveBeenCalledTimes(2)
  })

  it('dumps handles on the first stalled tick and every 40th after, not every tick', () => {
    const { recovery, dumpHandles } = setup()
    for (let misses = 2; misses <= 100; misses++) recovery.onStall(stalled, misses)
    expect(dumpHandles).toHaveBeenCalledTimes(3) // misses 2, 42, 82
  })

  it('logs each wake with its outcome', () => {
    const { recovery, log } = setup()
    recovery.onStall(stalled, 2)
    expect(log.warn).toHaveBeenCalledWith('Waking the thread-pool workers', {
      consecutiveMisses: 2,
      attempt: 1,
      found: 4,
      signalled: 4
    })
  })
})
