/**
 * A heartbeat for the libuv thread pool.
 *
 * Async file I/O and `dns.lookup` run on four pool threads shared by the whole
 * process. When those threads are stuck (a resolver that never answers, a read
 * on a hung mount), the event loop stays perfectly responsive — timers fire,
 * HTTP is served — while every `fs.promises.*` and every new outbound
 * connection waits forever. Nothing in the app noticed that for a whole night.
 *
 * Every `intervalMs` this runs one tiny stat and one local name lookup, each
 * with a deadline. A miss is logged with the requests still pending on the
 * pool (`FSReqCallback`, `GetAddrInfoReqWrap` + hostnames), which is the
 * evidence that names the stuck call; `onStall` fires after `stallAfter`
 * consecutive misses so the host can act (dump handles, restart a worker).
 */
import dns from 'dns'
import { promises as fsp } from 'fs'
import { homedir } from 'os'
import { describeActiveRequests } from './perf-logger'
import { perfLog } from './perf-logger'

export interface ThreadpoolProbeResult {
  /** Milliseconds the stat took, or null when it missed the deadline. */
  fsMs: number | null
  /** Milliseconds the lookup took, or null when it missed the deadline. */
  dnsMs: number | null
  ok: boolean
  requests: ReturnType<typeof describeActiveRequests>
}

export interface ThreadpoolProbeOptions {
  intervalMs?: number
  deadlineMs?: number
  /** Consecutive misses before `onStall`. Default 2. */
  stallAfter?: number
  /** A tick slower than this (but within the deadline) is logged as `slow`. Default 1000. */
  slowMs?: number
  /** Path to stat. Default: the home directory. */
  path?: string
  /** Name to resolve. Default `localhost` (answered locally, exercises `getaddrinfo` without the network). */
  hostname?: string
  onStall?: (result: ThreadpoolProbeResult, consecutiveMisses: number) => void
  onRecover?: (result: ThreadpoolProbeResult, missedTicks: number) => void
  log?: {
    warn: (message: string, data?: Record<string, unknown>) => void
    info: (message: string, data?: Record<string, unknown>) => void
  }
  /** Injectable for tests. */
  stat?: (path: string) => Promise<unknown>
  lookup?: (hostname: string) => Promise<unknown>
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

export interface ThreadpoolProbe {
  stop: () => void
  /** Run one tick now (tests, or a caller that wants a fresh verdict). */
  tick: () => Promise<ThreadpoolProbeResult>
  last: () => ThreadpoolProbeResult | null
  consecutiveMisses: () => number
}

const DEFAULT_INTERVAL_MS = 15_000
const DEFAULT_DEADLINE_MS = 10_000
const DEFAULT_STALL_AFTER = 2
const DEFAULT_SLOW_MS = 1_000

/** Resolves to the elapsed ms, or null once the deadline passes (the work is left to finish on its own). */
function timed(work: Promise<unknown>, deadlineMs: number): Promise<number | null> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), deadlineMs)
    timer.unref?.()
    work.then(
      () => {
        clearTimeout(timer)
        resolve(Date.now() - startedAt)
      },
      () => {
        // An error is an answer: the pool thread came back.
        clearTimeout(timer)
        resolve(Date.now() - startedAt)
      }
    )
  })
}

export function startThreadpoolProbe(options: ThreadpoolProbeOptions = {}): ThreadpoolProbe {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  const stallAfter = options.stallAfter ?? DEFAULT_STALL_AFTER
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS
  const path = options.path ?? homedir()
  const hostname = options.hostname ?? 'localhost'
  const stat = options.stat ?? ((target: string) => fsp.stat(target))
  const lookup =
    options.lookup ??
    ((name: string) =>
      new Promise<void>((resolve, reject) => {
        dns.lookup(name, (error) => (error ? reject(error) : resolve()))
      }))
  const schedule = options.setInterval ?? setInterval
  const unschedule = options.clearInterval ?? clearInterval

  let last: ThreadpoolProbeResult | null = null
  let misses = 0
  let ticking = false
  let stopped = false

  const tick = async (): Promise<ThreadpoolProbeResult> => {
    if (ticking && last) return last
    ticking = true
    try {
      const [fsMs, dnsMs] = await Promise.all([
        timed(stat(path), deadlineMs),
        timed(lookup(hostname), deadlineMs)
      ])
      const ok = fsMs !== null && dnsMs !== null
      const result: ThreadpoolProbeResult = {
        fsMs,
        dnsMs,
        ok,
        requests: describeActiveRequests()
      }
      last = result
      if (ok) {
        const worst = Math.max(fsMs, dnsMs)
        if (worst >= slowMs) {
          perfLog.slow('threadpool-probe', worst, { fsMs, dnsMs, ...summary(result) })
        }
        if (misses > 0) {
          const missed = misses
          misses = 0
          options.log?.info('Thread pool answering again', { missedTicks: missed, fsMs, dnsMs })
          perfLog.mark('threadpool-recovered', { missedTicks: missed, fsMs, dnsMs })
          options.onRecover?.(result, missed)
        }
      } else {
        misses += 1
        const detail = { fsMs, dnsMs, deadlineMs, consecutiveMisses: misses, ...summary(result) }
        options.log?.warn('Thread pool probe missed its deadline', detail)
        perfLog.mark('threadpool-stall', detail)
        if (misses >= stallAfter) options.onStall?.(result, misses)
      }
      return result
    } finally {
      ticking = false
    }
  }

  const timer = schedule(() => {
    if (stopped) return
    void tick()
  }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()

  return {
    stop: () => {
      stopped = true
      unschedule(timer)
    },
    tick,
    last: () => last,
    consecutiveMisses: () => misses
  }
}

const summary = (result: ThreadpoolProbeResult): Record<string, unknown> => ({
  pendingRequests: result.requests.requests,
  requestsByType: result.requests.requestsByType,
  pendingLookups: result.requests.pendingLookups
})
