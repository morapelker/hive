// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startThreadpoolProbe, type ThreadpoolProbe } from './threadpool-probe'

const probes: ThreadpoolProbe[] = []
afterEach(() => {
  while (probes.length > 0) probes.pop()!.stop()
})

const never = () => new Promise<never>(() => {})

describe('startThreadpoolProbe', () => {
  it('reports a healthy pool with timings', async () => {
    const probe = startThreadpoolProbe({
      intervalMs: 60_000,
      stat: async () => ({}),
      lookup: async () => undefined
    })
    probes.push(probe)
    const result = await probe.tick()
    expect(result.ok).toBe(true)
    expect(result.fsMs).toBeGreaterThanOrEqual(0)
    expect(result.dnsMs).toBeGreaterThanOrEqual(0)
    expect(probe.consecutiveMisses()).toBe(0)
  })

  it('declares a stall after consecutive missed deadlines, naming the pending lookups, and recovery after', async () => {
    const log = { warn: vi.fn(), info: vi.fn() }
    const onStall = vi.fn()
    const onRecover = vi.fn()
    let stuck = true
    const probe = startThreadpoolProbe({
      intervalMs: 60_000,
      deadlineMs: 20,
      stallAfter: 2,
      log,
      onStall,
      onRecover,
      stat: () => (stuck ? never() : Promise.resolve({})),
      lookup: () => (stuck ? never() : Promise.resolve())
    })
    probes.push(probe)

    const first = await probe.tick()
    expect(first.ok).toBe(false)
    expect(first.fsMs).toBeNull()
    expect(first.dnsMs).toBeNull()
    expect(onStall).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      'Thread pool probe missed its deadline',
      expect.objectContaining({ consecutiveMisses: 1 })
    )

    await probe.tick()
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall.mock.calls[0][1]).toBe(2)
    expect(probe.consecutiveMisses()).toBe(2)

    stuck = false
    const recovered = await probe.tick()
    expect(recovered.ok).toBe(true)
    expect(onRecover).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), 2)
    expect(probe.consecutiveMisses()).toBe(0)
  })

  it('treats an errored stat as an answer (the thread came back)', async () => {
    const probe = startThreadpoolProbe({
      intervalMs: 60_000,
      stat: async () => {
        throw new Error('ENOENT')
      },
      lookup: async () => undefined
    })
    probes.push(probe)
    expect((await probe.tick()).ok).toBe(true)
  })

  it('runs on its interval and stops cleanly', async () => {
    const stat = vi.fn(async () => ({}))
    const probe = startThreadpoolProbe({ intervalMs: 5, stat, lookup: async () => undefined })
    probes.push(probe)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const calls = stat.mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(2)
    probe.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stat.mock.calls.length).toBe(calls)
  })
})
