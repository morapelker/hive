import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks'
import type { IntervalHistogram } from 'node:perf_hooks'
import * as v8 from 'node:v8'
import { Session as InspectorSession } from 'node:inspector'
import { PerfLogWriter } from './perf-log-writer'
import {
  installTimerRegistry,
  snapshotTimerRegistry,
  uninstallTimerRegistry,
  type TimerRegistrySnapshot
} from './timer-registry'

/**
 * Opt-in performance logging (Settings → Advanced → Performance logging).
 *
 * One instance per Node process (the backend server child and the Electron main process each
 * run their own; the renderer ships its records to the server through `perfLoggingOps`).
 * Every record is one JSON line in `~/.hive/logs/perf/perf-<role>.jsonl`:
 *
 *   kind: 'sample'  every 30 s: memory, CPU, event-loop delay histogram, GC, active handles by
 *                   type, live timers by origin, registered gauges, and the RPC / event-bus /
 *                   SQLite aggregates of the window that just ended
 *   kind: 'slow'    one RPC, SQLite statement, or event-loop block that crossed its threshold
 *   kind: 'mark'    a lifecycle point worth correlating with (session start/stop, reconnect,
 *                   sleep/wake, backend restart …)
 *   kind: 'alert'   a threshold crossed for several windows in a row; may be paired with a
 *                   heap snapshot (`capture`) written next to the log
 *
 * Everything is a no-op while disabled: hooks check one boolean.
 */

export type PerfProcessRole = 'server' | 'electron-main' | 'renderer'

export type GaugeValue = number | Record<string, number>

export interface PerfLoggerOptions {
  readonly role: PerfProcessRole
  readonly logDir?: string
  readonly sampleIntervalMs?: number
  /** Event-loop p99 (ms) that, sustained for `alertWindows` samples, raises an alert. */
  readonly loopP99AlertMs?: number
  readonly alertWindows?: number
  /** RSS (bytes) above which an alert is raised. */
  readonly rssAlertBytes?: number
  readonly slowRpcMs?: number
  readonly slowDbMs?: number
  readonly blockMs?: number
  readonly captureHeapSnapshots?: boolean
  readonly maxAutoHeapSnapshots?: number
  readonly minHeapSnapshotGapMs?: number
}

interface RpcWindowEntry {
  count: number
  errors: number
  totalMs: number
  maxMs: number
  samples: number[]
}

interface DbWindowEntry {
  count: number
  totalMs: number
  maxMs: number
}

interface EventWindowEntry {
  count: number
  bytes: number
  maxListeners: number
}

export interface PerfLoggerStatus {
  enabled: boolean
  role: PerfProcessRole
  pid: number
  logDir: string
  filePath: string | null
  startedAt: string | null
  samples: number
  alerts: number
  captures: string[]
}

const DEFAULT_SAMPLE_INTERVAL_MS = 30_000
const DEFAULT_LOOP_P99_ALERT_MS = 500
const DEFAULT_ALERT_WINDOWS = 3
const DEFAULT_RSS_ALERT_BYTES = 3 * 1024 * 1024 * 1024
const DEFAULT_SLOW_RPC_MS = 500
const DEFAULT_SLOW_DB_MS = 25
const DEFAULT_BLOCK_MS = 200
const BLOCK_PROBE_MS = 250
const MAX_SLOW_RECORDS_PER_WINDOW = 60
const MAX_RPC_SAMPLES = 256
const TOP_N = 15
const DEFAULT_MAX_AUTO_HEAP_SNAPSHOTS = 2
const CPU_PROFILE_MS = 15_000
const DEFAULT_MIN_HEAP_SNAPSHOT_GAP_MS = 30 * 60_000
/** Heap snapshots of very large heaps take long and can themselves exhaust memory. */
const MAX_HEAP_FOR_SNAPSHOT_BYTES = 1.5 * 1024 * 1024 * 1024

export const PERF_LOG_VERSION = 'perf-v1'

export const defaultPerfLogDir = (): string => join(homedir(), '.hive', 'logs', 'perf')

const nowIso = (): string => new Date().toISOString()

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export class PerfLogger {
  readonly role: PerfProcessRole
  private readonly options: Required<
    Pick<
      PerfLoggerOptions,
      | 'sampleIntervalMs'
      | 'loopP99AlertMs'
      | 'alertWindows'
      | 'rssAlertBytes'
      | 'slowRpcMs'
      | 'slowDbMs'
      | 'blockMs'
      | 'captureHeapSnapshots'
      | 'maxAutoHeapSnapshots'
      | 'minHeapSnapshotGapMs'
    >
  >
  private readonly logDir: string
  private writer: PerfLogWriter | null = null
  private enabled = false
  private startedAt: string | null = null
  private sampleTimer: ReturnType<typeof setInterval> | null = null
  private blockTimer: ReturnType<typeof setInterval> | null = null
  private lastBlockProbeAt = 0
  private loopHistogram: IntervalHistogram | null = null
  private gcObserver: PerformanceObserver | null = null
  private prevCpu: NodeJS.CpuUsage | null = null
  private prevCpuAt = 0
  private readonly gauges = new Map<string, () => GaugeValue>()
  private rpcWindow = new Map<string, RpcWindowEntry>()
  private rpcInflight = 0
  private rpcInflightMax = 0
  private dbWindow = new Map<string, DbWindowEntry>()
  private eventWindow = new Map<string, EventWindowEntry>()
  private gcWindow = { count: 0, totalMs: 0, maxMs: 0 }
  private blocksWindow = { count: 0, totalMs: 0, maxMs: 0 }
  private slowRecordsThisWindow = 0
  private consecutiveLoopAlerts = 0
  private sampleCount = 0
  private alertCount = 0
  private autoHeapSnapshots = 0
  private lastHeapSnapshotAt = 0
  private cpuProfileRunning = false
  private readonly captures: string[] = []

  constructor(options: PerfLoggerOptions) {
    this.role = options.role
    this.logDir = options.logDir ?? defaultPerfLogDir()
    this.options = {
      sampleIntervalMs: options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
      loopP99AlertMs: options.loopP99AlertMs ?? DEFAULT_LOOP_P99_ALERT_MS,
      alertWindows: options.alertWindows ?? DEFAULT_ALERT_WINDOWS,
      rssAlertBytes: options.rssAlertBytes ?? DEFAULT_RSS_ALERT_BYTES,
      slowRpcMs: options.slowRpcMs ?? DEFAULT_SLOW_RPC_MS,
      slowDbMs: options.slowDbMs ?? DEFAULT_SLOW_DB_MS,
      blockMs: options.blockMs ?? DEFAULT_BLOCK_MS,
      captureHeapSnapshots: options.captureHeapSnapshots ?? true,
      maxAutoHeapSnapshots: options.maxAutoHeapSnapshots ?? DEFAULT_MAX_AUTO_HEAP_SNAPSHOTS,
      minHeapSnapshotGapMs: options.minHeapSnapshotGapMs ?? DEFAULT_MIN_HEAP_SNAPSHOT_GAP_MS
    }
  }

  private readonly onProcessWarning = (warning: Error): void => {
    this.mark('process-warning', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack?.split('\n').slice(0, 6).join('\n') ?? null
    })
  }

  // ---------------------------------------------------------------- lifecycle

  isEnabled(): boolean {
    return this.enabled
  }

  getLogDir(): string {
    return this.logDir
  }

  start(): void {
    if (this.enabled) return
    this.enabled = true
    this.startedAt = nowIso()
    this.writer = new PerfLogWriter({
      dir: this.logDir,
      fileName: `perf-${this.role}.jsonl`,
      onError: (error) => {
        // Diagnostics must never take the app down; surface once on the console.
        console.warn('[perf-logging] write failed', error)
      }
    })
    installTimerRegistry()
    this.loopHistogram = monitorEventLoopDelay({ resolution: 20 })
    this.loopHistogram.enable()
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.gcWindow.count += 1
          this.gcWindow.totalMs += entry.duration
          this.gcWindow.maxMs = Math.max(this.gcWindow.maxMs, entry.duration)
        }
      })
      this.gcObserver.observe({ entryTypes: ['gc'] })
    } catch {
      this.gcObserver = null
    }
    this.prevCpu = process.cpuUsage()
    this.prevCpuAt = performance.now()
    this.lastBlockProbeAt = performance.now()
    this.blockTimer = setInterval(() => this.probeBlock(), BLOCK_PROBE_MS)
    this.blockTimer.unref?.()
    this.sampleTimer = setInterval(() => this.sample(), this.options.sampleIntervalMs)
    this.sampleTimer.unref?.()
    // MaxListenersExceededWarning and friends are the earliest sign of a listener leak; in a
    // packaged app their stderr is lost, so keep them with the samples.
    process.on('warning', this.onProcessWarning)
    this.write({
      kind: 'start',
      version: PERF_LOG_VERSION,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      platform: process.platform,
      arch: process.arch,
      argv1: process.argv[1] ?? null,
      options: this.options
    })
  }

  stop(): void {
    if (!this.enabled) return
    this.write({ kind: 'stop', samples: this.sampleCount, alerts: this.alertCount })
    this.enabled = false
    if (this.sampleTimer) clearInterval(this.sampleTimer)
    if (this.blockTimer) clearInterval(this.blockTimer)
    this.sampleTimer = null
    this.blockTimer = null
    this.loopHistogram?.disable()
    this.loopHistogram = null
    this.gcObserver?.disconnect()
    this.gcObserver = null
    process.off('warning', this.onProcessWarning)
    uninstallTimerRegistry()
    this.writer?.close()
    this.writer = null
    for (const writer of this.externalWriters.values()) writer.flush()
    this.resetWindow()
    this.consecutiveLoopAlerts = 0
  }

  /** Flushes queued records (quit hook). */
  flush(): void {
    this.writer?.flush()
    for (const writer of this.externalWriters.values()) writer.flush()
  }

  getStatus(): PerfLoggerStatus {
    return {
      enabled: this.enabled,
      role: this.role,
      pid: process.pid,
      logDir: this.logDir,
      filePath: this.writer?.filePath ?? null,
      startedAt: this.startedAt,
      samples: this.sampleCount,
      alerts: this.alertCount,
      captures: [...this.captures]
    }
  }

  /** Files in the perf log dir with their sizes, for the settings page. */
  listLogFiles(): Array<{ name: string; bytes: number; modifiedAt: string }> {
    if (!existsSync(this.logDir)) return []
    return readdirSync(this.logDir)
      .map((name) => {
        try {
          const stats = statSync(join(this.logDir, name))
          return { name, bytes: stats.size, modifiedAt: stats.mtime.toISOString() }
        } catch {
          return null
        }
      })
      .filter((entry): entry is { name: string; bytes: number; modifiedAt: string } => !!entry)
      .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1))
  }

  // ---------------------------------------------------------------- hooks

  /**
   * A named value read on every sample. Register counts that can only grow by mistake:
   * sessions, watchers, sockets, listeners, map sizes. Returning a record nests sub-counts.
   */
  registerGauge(name: string, read: () => GaugeValue): () => void {
    this.gauges.set(name, read)
    return () => {
      if (this.gauges.get(name) === read) this.gauges.delete(name)
    }
  }

  /** Listener totals of an EventEmitter-like object as a gauge. */
  registerEmitterGauge(
    name: string,
    emitter: () => { eventNames(): Array<string | symbol>; listenerCount(event: string | symbol): number } | null
  ): () => void {
    return this.registerGauge(name, () => {
      const target = emitter()
      if (!target) return -1
      let total = 0
      for (const event of target.eventNames()) total += target.listenerCount(event)
      return total
    })
  }

  rpcBegin(): void {
    if (!this.enabled) return
    this.rpcInflight += 1
    if (this.rpcInflight > this.rpcInflightMax) this.rpcInflightMax = this.rpcInflight
  }

  rpcEnd(method: string, ms: number, ok: boolean, detail?: Record<string, unknown>): void {
    if (!this.enabled) return
    this.rpcInflight = Math.max(0, this.rpcInflight - 1)
    let entry = this.rpcWindow.get(method)
    if (!entry) {
      entry = { count: 0, errors: 0, totalMs: 0, maxMs: 0, samples: [] }
      this.rpcWindow.set(method, entry)
    }
    entry.count += 1
    if (!ok) entry.errors += 1
    entry.totalMs += ms
    if (ms > entry.maxMs) entry.maxMs = ms
    if (entry.samples.length < MAX_RPC_SAMPLES) entry.samples.push(ms)
    if (ms >= this.options.slowRpcMs) {
      this.slow('rpc', ms, { method, ok, ...(detail ?? {}) })
    }
  }

  recordDb(sql: string, ms: number): void {
    if (!this.enabled) return
    let entry = this.dbWindow.get(sql)
    if (!entry) {
      entry = { count: 0, totalMs: 0, maxMs: 0 }
      this.dbWindow.set(sql, entry)
    }
    entry.count += 1
    entry.totalMs += ms
    if (ms > entry.maxMs) entry.maxMs = ms
    if (ms >= this.options.slowDbMs) this.slow('db', ms, { sql })
  }

  /** One publish on the event bus; bytes arrive separately from the connection that sends it. */
  recordEvent(channel: string, listeners: number): void {
    if (!this.enabled) return
    const entry = this.eventEntry(channel)
    entry.count += 1
    if (listeners > entry.maxListeners) entry.maxListeners = listeners
  }

  /** Serialized size of an event as written to one socket (no extra serialization). */
  recordEventBytes(channel: string, bytes: number): void {
    if (!this.enabled) return
    this.eventEntry(channel).bytes += bytes
  }

  private eventEntry(channel: string): EventWindowEntry {
    const key = collapseChannel(channel)
    let entry = this.eventWindow.get(key)
    if (!entry) {
      entry = { count: 0, bytes: 0, maxListeners: 0 }
      this.eventWindow.set(key, entry)
    }
    return entry
  }

  mark(name: string, data?: Record<string, unknown>): void {
    if (!this.enabled) return
    this.write({ kind: 'mark', name, ...(data ?? {}) })
  }

  /** One slow operation. Rate-limited per window so a storm cannot flood the log. */
  slow(what: string, ms: number, detail?: Record<string, unknown>): void {
    if (!this.enabled) return
    this.slowRecordsThisWindow += 1
    if (this.slowRecordsThisWindow > MAX_SLOW_RECORDS_PER_WINDOW) return
    this.write({ kind: 'slow', what, ms: round(ms), ...(detail ?? {}) })
  }

  /**
   * Records sent by another process (the renderer) that this process persists for it. A
   * writer that already exists keeps accepting records after `stop()` so the renderer's own
   * final sample (sent after the toggle) still lands.
   */
  writeExternal(role: PerfProcessRole, records: Array<Record<string, unknown>>): void {
    if (role === this.role) return
    if (!this.enabled && !this.externalWriters.has(role)) return
    const writer = this.externalWriter(role)
    for (const record of records) {
      writer.write({ ...record, role, t: typeof record.t === 'string' ? record.t : nowIso() })
    }
  }

  /** Writes a heap snapshot + handle dump now (the "Capture diagnostics" button). */
  captureNow(reason: string): { files: string[] } {
    const files: string[] = []
    const stamp = nowIso().replace(/[:.]/g, '-')
    const handlesPath = join(this.logDir, `handles-${this.role}-${stamp}.json`)
    try {
      writeFileSync(
        handlesPath,
        JSON.stringify(
          {
            t: nowIso(),
            role: this.role,
            pid: process.pid,
            reason,
            handles: describeHandles(),
            timers: snapshotTimerRegistry(200),
            gauges: this.readGauges()
          },
          null,
          1
        )
      )
      files.push(handlesPath)
    } catch (error) {
      console.warn('[perf-logging] handle dump failed', error)
    }
    const heapPath = this.writeHeapSnapshot(stamp)
    if (heapPath) files.push(heapPath)
    for (const file of files) this.captures.push(file)
    if (this.enabled) this.write({ kind: 'capture', reason, files })
    // A CPU profile shows *what* is eating the loop (sweep, GC, transcript parse …); it runs
    // in the background and is reported by its own `capture` record when it lands.
    void this.captureCpuProfile(reason, stamp)
    return { files }
  }

  /** Samples the JS stack for `durationMs` and writes a .cpuprofile (DevTools → Performance). */
  async captureCpuProfile(reason: string, stamp?: string, durationMs = CPU_PROFILE_MS): Promise<string | null> {
    if (this.cpuProfileRunning) return null
    this.cpuProfileRunning = true
    const path = join(this.logDir, `cpu-${this.role}-${stamp ?? nowIso().replace(/[:.]/g, '-')}.cpuprofile`)
    const session = new InspectorSession()
    const post = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
      new Promise((resolve, reject) => {
        session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result)))
      })
    try {
      session.connect()
      await post('Profiler.enable')
      await post('Profiler.setSamplingInterval', { interval: 1000 })
      await post('Profiler.start')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, durationMs)
        timer.unref?.()
      })
      const { profile } = (await post('Profiler.stop')) as { profile: unknown }
      pruneCaptureFiles(this.logDir)
      writeFileSync(path, JSON.stringify(profile))
      this.captures.push(path)
      if (this.enabled) this.write({ kind: 'capture', reason: `${reason}:cpu-profile`, files: [path] })
      return path
    } catch (error) {
      console.warn('[perf-logging] cpu profile failed', error)
      return null
    } finally {
      try {
        session.disconnect()
      } catch {
        // already disconnected
      }
      this.cpuProfileRunning = false
    }
  }

  // ---------------------------------------------------------------- sampling

  /** Builds the sample for the window that just ended and resets the window. */
  sample(): Record<string, unknown> {
    const mem = process.memoryUsage()
    const cpu = process.cpuUsage()
    const now = performance.now()
    let cpuPercent = 0
    if (this.prevCpu) {
      const elapsedUs = (now - this.prevCpuAt) * 1000
      if (elapsedUs > 0) {
        cpuPercent =
          ((cpu.user - this.prevCpu.user + (cpu.system - this.prevCpu.system)) / elapsedUs) * 100
      }
    }
    this.prevCpu = cpu
    this.prevCpuAt = now

    const heap = v8.getHeapStatistics()
    const heapSpaces: Record<string, number> = {}
    try {
      for (const space of v8.getHeapSpaceStatistics()) {
        if (space.space_name === 'old_space' || space.space_name === 'large_object_space' || space.space_name === 'new_space') {
          heapSpaces[`${space.space_name}Used`] = space.space_used_size
        }
      }
    } catch {
      // not available on this runtime
    }
    const loop = this.readLoopHistogram()
    const handles = describeHandles()
    const rpc = this.summarizeRpc()
    const events = this.summarizeEvents()
    const db = this.summarizeDb()
    const timers = snapshotTimerRegistry()

    const record: Record<string, unknown> = {
      kind: 'sample',
      uptimeS: Math.round(process.uptime()),
      cpuPct: round(cpuPercent),
      mem: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        heapLimit: heap.heap_size_limit,
        malloced: heap.malloced_memory,
        nativeContexts: heap.number_of_native_contexts,
        detachedContexts: heap.number_of_detached_contexts,
        ...heapSpaces
      },
      loop,
      blocks: { ...this.blocksWindow, totalMs: round(this.blocksWindow.totalMs), maxMs: round(this.blocksWindow.maxMs) },
      gc: { ...this.gcWindow, totalMs: round(this.gcWindow.totalMs), maxMs: round(this.gcWindow.maxMs) },
      handles,
      timers: compactTimers(timers),
      gauges: this.readGauges(),
      rpc,
      events,
      db
    }

    this.sampleCount += 1
    this.write(record)
    this.evaluateAlerts(loop.p99, mem.rss, mem.heapUsed)
    this.resetWindow()
    return record
  }

  private probeBlock(): void {
    const now = performance.now()
    const drift = now - this.lastBlockProbeAt - BLOCK_PROBE_MS
    this.lastBlockProbeAt = now
    if (drift < this.options.blockMs) return
    this.blocksWindow.count += 1
    this.blocksWindow.totalMs += drift
    if (drift > this.blocksWindow.maxMs) this.blocksWindow.maxMs = drift
    this.slow('loop-block', drift, {
      rpcInflight: this.rpcInflight
    })
  }

  private readLoopHistogram(): {
    mean: number
    p50: number
    p95: number
    p99: number
    max: number
    exceeds: number
  } {
    const histogram = this.loopHistogram
    if (!histogram) return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0, exceeds: 0 }
    const toMs = (ns: number): number => round(ns / 1e6)
    const result = {
      mean: Number.isFinite(histogram.mean) ? toMs(histogram.mean) : 0,
      p50: toMs(histogram.percentile(50)),
      p95: toMs(histogram.percentile(95)),
      p99: toMs(histogram.percentile(99)),
      max: toMs(histogram.max),
      exceeds: histogram.exceeds
    }
    histogram.reset()
    return result
  }

  private summarizeRpc(): Record<string, unknown> {
    const methods = [...this.rpcWindow.entries()]
      .map(([method, entry]) => {
        const sorted = [...entry.samples].sort((a, b) => a - b)
        return {
          method,
          count: entry.count,
          errors: entry.errors,
          avgMs: round(entry.totalMs / Math.max(1, entry.count)),
          p95Ms: round(percentile(sorted, 95)),
          maxMs: round(entry.maxMs),
          totalMs: round(entry.totalMs)
        }
      })
      .sort((a, b) => b.totalMs - a.totalMs)
    const totalCount = methods.reduce((sum, m) => sum + m.count, 0)
    const totalMs = methods.reduce((sum, m) => sum + m.totalMs, 0)
    return {
      count: totalCount,
      totalMs: round(totalMs),
      inflightNow: this.rpcInflight,
      inflightMax: this.rpcInflightMax,
      top: methods.slice(0, TOP_N)
    }
  }

  private summarizeEvents(): Record<string, unknown> {
    const channels = [...this.eventWindow.entries()]
      .map(([channel, entry]) => ({
        channel,
        count: entry.count,
        bytes: entry.bytes,
        maxListeners: entry.maxListeners
      }))
      .sort((a, b) => b.bytes - a.bytes)
    return {
      count: channels.reduce((sum, c) => sum + c.count, 0),
      bytes: channels.reduce((sum, c) => sum + c.bytes, 0),
      channels: this.eventWindow.size,
      top: channels.slice(0, TOP_N)
    }
  }

  private summarizeDb(): Record<string, unknown> {
    const statements = [...this.dbWindow.entries()]
      .map(([sql, entry]) => ({
        sql,
        count: entry.count,
        totalMs: round(entry.totalMs),
        avgMs: round(entry.totalMs / Math.max(1, entry.count)),
        maxMs: round(entry.maxMs)
      }))
      .sort((a, b) => b.totalMs - a.totalMs)
    return {
      count: statements.reduce((sum, s) => sum + s.count, 0),
      totalMs: round(statements.reduce((sum, s) => sum + s.totalMs, 0)),
      top: statements.slice(0, TOP_N)
    }
  }

  private readGauges(): Record<string, GaugeValue> {
    const out: Record<string, GaugeValue> = {}
    for (const [name, read] of this.gauges) {
      try {
        out[name] = read()
      } catch {
        out[name] = -1
      }
    }
    return out
  }

  private resetWindow(): void {
    this.rpcWindow = new Map()
    this.rpcInflightMax = this.rpcInflight
    this.dbWindow = new Map()
    this.eventWindow = new Map()
    this.gcWindow = { count: 0, totalMs: 0, maxMs: 0 }
    this.blocksWindow = { count: 0, totalMs: 0, maxMs: 0 }
    this.slowRecordsThisWindow = 0
  }

  private evaluateAlerts(loopP99: number, rss: number, heapUsed: number): void {
    if (loopP99 >= this.options.loopP99AlertMs) this.consecutiveLoopAlerts += 1
    else this.consecutiveLoopAlerts = 0

    const loopAlert = this.consecutiveLoopAlerts === this.options.alertWindows
    const rssAlert = rss >= this.options.rssAlertBytes
    if (!loopAlert && !rssAlert) return

    this.alertCount += 1
    const reason = loopAlert ? 'event-loop-p99' : 'rss'
    const record: Record<string, unknown> = {
      kind: 'alert',
      reason,
      loopP99,
      rss,
      consecutiveWindows: this.consecutiveLoopAlerts
    }
    if (
      this.options.captureHeapSnapshots &&
      this.autoHeapSnapshots < this.options.maxAutoHeapSnapshots &&
      Date.now() - this.lastHeapSnapshotAt >= this.options.minHeapSnapshotGapMs &&
      heapUsed < MAX_HEAP_FOR_SNAPSHOT_BYTES
    ) {
      this.autoHeapSnapshots += 1
      const { files } = this.captureNow(`alert:${reason}`)
      record.files = files
      // The snapshot itself stalled the loop; do not let it feed the next window's alert.
      this.loopHistogram?.reset()
      this.lastBlockProbeAt = performance.now()
    }
    this.write(record)
    // An RSS alert fires on every sample otherwise; let the loop counter re-arm naturally.
    if (loopAlert) this.consecutiveLoopAlerts = 0
  }

  private writeHeapSnapshot(stamp: string): string | null {
    if (Date.now() - this.lastHeapSnapshotAt < 5_000) return null
    this.lastHeapSnapshotAt = Date.now()
    const path = join(this.logDir, `heap-${this.role}-${stamp}.heapsnapshot`)
    try {
      pruneCaptureFiles(this.logDir)
      // Blocks the process for a few seconds; acceptable for an explicit capture.
      v8.writeHeapSnapshot(path)
      return path
    } catch (error) {
      console.warn('[perf-logging] heap snapshot failed', error)
      return null
    }
  }

  private readonly externalWriters = new Map<PerfProcessRole, PerfLogWriter>()

  private externalWriter(role: PerfProcessRole): PerfLogWriter {
    let writer = this.externalWriters.get(role)
    if (!writer) {
      writer = new PerfLogWriter({ dir: this.logDir, fileName: `perf-${role}.jsonl` })
      this.externalWriters.set(role, writer)
    }
    return writer
  }

  private write(record: Record<string, unknown>): void {
    if (!this.writer) return
    this.writer.write({ t: nowIso(), role: this.role, pid: process.pid, ...record })
  }
}

// ------------------------------------------------------------------ helpers

const CAPTURE_FILE_PATTERN = /^(heap|cpu|handles)-.*\.(heapsnapshot|cpuprofile|json)$/
const MAX_CAPTURE_FILES = 8
const MAX_CAPTURE_BYTES = 3 * 1024 * 1024 * 1024

/** Keeps the capture directory bounded: newest files first, by count and total size. */
export function pruneCaptureFiles(dir: string): void {
  try {
    if (!existsSync(dir)) return
    const files = readdirSync(dir)
      .filter((name) => CAPTURE_FILE_PATTERN.test(name))
      .map((name) => {
        const stats = statSync(join(dir, name))
        return { name, bytes: stats.size, mtimeMs: stats.mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    let total = 0
    files.forEach((file, index) => {
      total += file.bytes
      if (index >= MAX_CAPTURE_FILES - 1 || total > MAX_CAPTURE_BYTES) {
        try {
          unlinkSync(join(dir, file.name))
        } catch {
          // ignore
        }
      }
    })
  } catch {
    // ignore: pruning is best effort
  }
}

/** `peer:<id>:session:<uuid>` → `peer:*:session:*` so per-entity channels aggregate. */
export const collapseChannel = (channel: string): string =>
  channel
    .split(':')
    .map((part) => (looksLikeId(part) ? '*' : part))
    .join(':')

const looksLikeId = (part: string): boolean =>
  /^[0-9a-f-]{16,}$/i.test(part) ||
  /^\d{4,}$/.test(part) ||
  (part.includes('-') && /\d/.test(part) && part.length >= 12) ||
  part.length > 40

export function describeHandles(): {
  active: number
  requests: number
  byType: Record<string, number>
} {
  const proc = process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[]
    _getActiveRequests?: () => unknown[]
  }
  let handles: unknown[] = []
  let requests = -1
  try {
    handles = proc._getActiveHandles?.() ?? []
    requests = proc._getActiveRequests?.()?.length ?? -1
  } catch {
    // private API; ignore
  }
  const byType: Record<string, number> = {}
  for (const handle of handles) {
    const name =
      (handle as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'Unknown'
    byType[name] = (byType[name] ?? 0) + 1
  }
  // Public counterpart (Node ≥ 17) that also counts timers and immediates.
  try {
    const resources = (
      process as NodeJS.Process & { getActiveResourcesInfo?: () => string[] }
    ).getActiveResourcesInfo?.()
    if (resources) {
      for (const name of resources) {
        const key = `resource:${name}`
        byType[key] = (byType[key] ?? 0) + 1
      }
    }
  } catch {
    // ignore
  }
  return { active: handles.length, requests, byType }
}

const compactTimers = (
  snapshot: TimerRegistrySnapshot
): { timeouts: number; intervals: number; top: Array<[string, number, number, number]> } => ({
  timeouts: snapshot.timeouts,
  intervals: snapshot.intervals,
  // [origin, intervals, timeouts, oldestSeconds]
  top: snapshot.byOrigin.map((s) => [s.origin, s.intervals, s.timeouts, Math.round(s.oldestMs / 1000)])
})

// ------------------------------------------------------------------ singleton

let instance: PerfLogger | null = null

/** The process-wide logger. The role is fixed the first time it is resolved. */
export const getPerfLogger = (role?: PerfProcessRole): PerfLogger => {
  if (!instance) {
    instance = new PerfLogger({ role: role ?? inferRole() })
  } else if (role && role !== instance.role) {
    console.warn(`[perf-logging] logger already created as ${instance.role}, ignoring ${role}`)
  }
  return instance
}

export const resetPerfLoggerForTests = (): void => {
  instance?.stop()
  instance = null
}

const inferRole = (): PerfProcessRole =>
  (process as NodeJS.Process & { type?: string }).type === 'browser' ? 'electron-main' : 'server'

/** Cheap no-op facade for hot paths: every call first checks the enabled flag. */
export const perfLog = {
  isEnabled: (): boolean => instance?.isEnabled() ?? false,
  rpcBegin: (): void => instance?.rpcBegin(),
  rpcEnd: (method: string, ms: number, ok: boolean, detail?: Record<string, unknown>): void =>
    instance?.rpcEnd(method, ms, ok, detail),
  recordDb: (sql: string, ms: number): void => instance?.recordDb(sql, ms),
  recordEvent: (channel: string, listeners: number): void =>
    instance?.recordEvent(channel, listeners),
  recordEventBytes: (channel: string, bytes: number): void =>
    instance?.recordEventBytes(channel, bytes),
  mark: (name: string, data?: Record<string, unknown>): void => instance?.mark(name, data),
  slow: (what: string, ms: number, detail?: Record<string, unknown>): void =>
    instance?.slow(what, ms, detail),
  registerGauge: (name: string, read: () => GaugeValue): (() => void) =>
    getPerfLogger().registerGauge(name, read),
  registerEmitterGauge: (
    name: string,
    emitter: () => { eventNames(): Array<string | symbol>; listenerCount(event: string | symbol): number } | null
  ): (() => void) => getPerfLogger().registerEmitterGauge(name, emitter)
}
