import { perfDiagnosticsApi } from '@/api/perf-diagnostics-api'
import { getRendererRpcClient, type RendererRpcClient } from '@/api/rpc-client'

/**
 * Renderer half of performance logging (Settings → Advanced). While enabled it samples this
 * window every 10 s and ships the records to the server, which persists them as
 * `~/.hive/logs/perf/perf-renderer.jsonl` next to the server and Electron main logs:
 *
 *   sample  long tasks (count/total/max), slow input events, JS heap, DOM node and xterm
 *           instance counts, store sizes, RPC latency per method, WebSocket inbound traffic
 *           per channel, pending requests, subscription counts, event-loop blocks
 *   slow    one RPC round trip or long task over its threshold
 *   mark    visibility / online changes, socket (re)connects
 *
 * Off by default: `instrumentRendererRpcClient` costs one flag check per RPC when disabled.
 */

const SAMPLE_INTERVAL_MS = 10_000
const SLOW_RPC_MS = 500
const SLOW_LONGTASK_MS = 250
const BLOCK_PROBE_MS = 250
const BLOCK_MS = 200
const MAX_QUEUED_RECORDS = 300
const MAX_SLOW_PER_WINDOW = 40
const MAX_RPC_SAMPLES = 256
const TOP_N = 25

type PerfRecord = Record<string, unknown>

interface RpcWindowEntry {
  count: number
  errors: number
  totalMs: number
  maxMs: number
  samples: number[]
}

interface StoreReader {
  readonly name: string
  readonly read: () => unknown
  /** Raw gauges are reported as returned; store readers are reduced to shallow sizes. */
  readonly raw: boolean
}

let enabled = false
let queue: PerfRecord[] = []
let rpcWindow = new Map<string, RpcWindowEntry>()
let rpcInflight = 0
let rpcInflightMax = 0
let slowThisWindow = 0
let longTasks = { count: 0, totalMs: 0, maxMs: 0 }
let inputEvents = { count: 0, maxMs: 0, worst: '' }
let blocks = { count: 0, totalMs: 0, maxMs: 0 }
let lastBlockProbeAt = 0
let stopHandle: (() => void) | null = null
const storeReaders: StoreReader[] = []

const round = (value: number): number => Math.round(value * 100) / 100
const nowIso = (): string => new Date().toISOString()

const push = (record: PerfRecord): void => {
  if (!enabled) return
  queue.push({ t: nowIso(), ...record })
  if (queue.length > MAX_QUEUED_RECORDS) queue = queue.slice(-MAX_QUEUED_RECORDS)
}

const slow = (what: string, ms: number, detail?: PerfRecord): void => {
  if (!enabled) return
  slowThisWindow += 1
  if (slowThisWindow > MAX_SLOW_PER_WINDOW) return
  push({ kind: 'slow', what, ms: round(ms), ...(detail ?? {}) })
}

export const isRendererPerfLoggingEnabled = (): boolean => enabled

/** Marks are cheap to call from anywhere (session open, ticket move…). */
export const rendererPerfMark = (name: string, data?: PerfRecord): void => {
  if (!enabled) return
  push({ kind: 'mark', name, ...(data ?? {}) })
}

/** Stores whose shallow sizes are reported on every sample (see `shallowSizes`). */
export const registerPerfStore = (name: string, read: () => unknown): (() => void) =>
  registerReader({ name, read, raw: false })

/** A gauge whose value (number or record of numbers) is written as is on every sample. */
export const registerPerfGauge = (
  name: string,
  read: () => number | Record<string, number>
): (() => void) => registerReader({ name, read, raw: true })

const registerReader = (reader: StoreReader): (() => void) => {
  storeReaders.push(reader)
  return () => {
    const index = storeReaders.indexOf(reader)
    if (index >= 0) storeReaders.splice(index, 1)
  }
}

/**
 * Wraps `request` so round trips are timed while logging is enabled. Everything else on the
 * client (subscribe, onOpen, stats, close) passes through untouched.
 */
export const instrumentRendererRpcClient = <T extends RendererRpcClient>(client: T): T => {
  const request = client.request.bind(client)
  const timed: RendererRpcClient['request'] = <R = unknown>(
    method: string,
    params?: unknown
  ): Promise<R> => {
    if (!enabled) return request<R>(method, params)
    const started = performance.now()
    rpcInflight += 1
    if (rpcInflight > rpcInflightMax) rpcInflightMax = rpcInflight
    const finish = (ok: boolean): void => {
      rpcInflight = Math.max(0, rpcInflight - 1)
      const ms = performance.now() - started
      let entry = rpcWindow.get(method)
      if (!entry) {
        entry = { count: 0, errors: 0, totalMs: 0, maxMs: 0, samples: [] }
        rpcWindow.set(method, entry)
      }
      entry.count += 1
      if (!ok) entry.errors += 1
      entry.totalMs += ms
      if (ms > entry.maxMs) entry.maxMs = ms
      if (entry.samples.length < MAX_RPC_SAMPLES) entry.samples.push(ms)
      if (ms >= SLOW_RPC_MS) slow('rpc', ms, { method, ok })
    }
    return request<R>(method, params).then(
      (value) => {
        finish(true)
        return value
      },
      (error: unknown) => {
        finish(false)
        throw error
      }
    )
  }
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'request') return timed
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

export const startRendererPerfCollector = (): void => {
  if (enabled) return
  enabled = true
  const cleanups: Array<() => void> = []

  const observe = (
    entryTypes: string[],
    callback: (entry: PerformanceEntry) => void,
    options: Record<string, unknown> = {}
  ): void => {
    if (typeof PerformanceObserver === 'undefined') return
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) callback(entry)
      })
      observer.observe({ entryTypes, ...options } as PerformanceObserverInit)
      cleanups.push(() => observer.disconnect())
    } catch {
      // entry type unsupported in this runtime
    }
  }

  observe(['longtask'], (entry) => {
    longTasks.count += 1
    longTasks.totalMs += entry.duration
    if (entry.duration > longTasks.maxMs) longTasks.maxMs = entry.duration
    if (entry.duration >= SLOW_LONGTASK_MS) {
      const attribution = (entry as PerformanceEntry & { attribution?: Array<{ containerName?: string; containerSrc?: string }> }).attribution?.[0]
      slow('longtask', entry.duration, {
        name: entry.name,
        container: attribution?.containerName ?? attribution?.containerSrc ?? null
      })
    }
  })
  observe(
    ['event'],
    (entry) => {
      inputEvents.count += 1
      if (entry.duration > inputEvents.maxMs) {
        inputEvents.maxMs = entry.duration
        inputEvents.worst = entry.name
      }
    },
    { durationThreshold: 104 }
  )

  lastBlockProbeAt = performance.now()
  const blockTimer = window.setInterval(() => {
    const now = performance.now()
    const drift = now - lastBlockProbeAt - BLOCK_PROBE_MS
    lastBlockProbeAt = now
    if (drift < BLOCK_MS || document.hidden) return
    blocks.count += 1
    blocks.totalMs += drift
    if (drift > blocks.maxMs) blocks.maxMs = drift
  }, BLOCK_PROBE_MS)
  cleanups.push(() => window.clearInterval(blockTimer))

  const onVisibility = (): void => rendererPerfMark('visibility', { hidden: document.hidden })
  const onOnline = (): void => rendererPerfMark('online')
  const onOffline = (): void => rendererPerfMark('offline')
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  cleanups.push(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  })

  const client = tryGetClient()
  if (client && typeof client.onOpen === 'function') {
    cleanups.push(client.onOpen(() => rendererPerfMark('ws-open')))
  }

  const sampleTimer = window.setInterval(() => {
    void flush(sample())
  }, SAMPLE_INTERVAL_MS)
  cleanups.push(() => window.clearInterval(sampleTimer))

  push({
    kind: 'start',
    url: location.href,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null
  })
  void flush()

  stopHandle = () => {
    for (const cleanup of cleanups) cleanup()
  }
}

export const stopRendererPerfCollector = (): void => {
  if (!enabled) return
  push({ kind: 'stop' })
  const pending = sample()
  stopHandle?.()
  stopHandle = null
  // Disable synchronously so a quick off→on toggle restarts cleanly; the final flush is
  // already queued and still goes out.
  enabled = false
  resetWindow()
  void flush(pending)
}

const tryGetClient = (): (RendererRpcClient & { onOpen?: (l: () => void) => () => void; stats?: (o?: { reset?: boolean }) => unknown }) | null => {
  try {
    return getRendererRpcClient()
  } catch {
    return null
  }
}

const sample = (): PerfRecord => {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
  }).memory
  const client = tryGetClient()
  const ws = typeof client?.stats === 'function' ? client.stats({ reset: true }) : null
  const record: PerfRecord = {
    kind: 'sample',
    hidden: document.hidden,
    mem: memory
      ? {
          heapUsed: memory.usedJSHeapSize,
          heapTotal: memory.totalJSHeapSize,
          heapLimit: memory.jsHeapSizeLimit
        }
      : null,
    dom: {
      nodes: document.getElementsByTagName('*').length,
      xterms: document.querySelectorAll('.xterm').length,
      canvases: document.getElementsByTagName('canvas').length
    },
    longTasks: { ...longTasks, totalMs: round(longTasks.totalMs), maxMs: round(longTasks.maxMs) },
    inputEvents: { ...inputEvents, maxMs: round(inputEvents.maxMs) },
    blocks: { ...blocks, totalMs: round(blocks.totalMs), maxMs: round(blocks.maxMs) },
    rpc: summarizeRpc(),
    ws: ws ? compactWs(ws) : null,
    stores: readStores()
  }
  resetWindow()
  return record
}

const summarizeRpc = (): PerfRecord => {
  const methods = [...rpcWindow.entries()]
    .map(([method, entry]) => {
      const sorted = [...entry.samples].sort((a, b) => a - b)
      const p95 = sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))]
        : 0
      return {
        method,
        count: entry.count,
        errors: entry.errors,
        avgMs: round(entry.totalMs / Math.max(1, entry.count)),
        p95Ms: round(p95),
        maxMs: round(entry.maxMs),
        totalMs: round(entry.totalMs)
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs)
  return {
    count: methods.reduce((sum, m) => sum + m.count, 0),
    totalMs: round(methods.reduce((sum, m) => sum + m.totalMs, 0)),
    inflightNow: rpcInflight,
    inflightMax: rpcInflightMax,
    top: methods.slice(0, TOP_N)
  }
}

const compactWs = (stats: unknown): PerfRecord => {
  const s = stats as {
    connected: boolean
    pendingRequests: number
    channels: number
    listeners: number
    reconnects: number
    inboundMessages: number
    inboundBytes: number
    inboundByChannel: Record<string, { count: number; bytes: number }>
  }
  const top = Object.entries(s.inboundByChannel ?? {})
    .map(([channel, entry]) => ({ channel, ...entry }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP_N)
  return {
    connected: s.connected,
    pendingRequests: s.pendingRequests,
    channels: s.channels,
    listeners: s.listeners,
    reconnects: s.reconnects,
    inboundMessages: s.inboundMessages,
    inboundBytes: s.inboundBytes,
    top
  }
}

const readStores = (): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const started = performance.now()
  for (const reader of storeReaders) {
    // Keep the sampler itself cheap: stop sizing stores after a few ms.
    if (performance.now() - started > 8) {
      out[reader.name] = 'skipped'
      continue
    }
    try {
      out[reader.name] = reader.raw ? reader.read() : shallowSizes(reader.read())
    } catch {
      out[reader.name] = 'error'
    }
  }
  return out
}

/**
 * Sizes of a store's top-level collections (array length, Map/Set size, object key count),
 * plus the summed size one level down for records-of-collections such as `messagesBySession`.
 * Functions and primitives are skipped; nothing is serialized.
 */
export const shallowSizes = (state: unknown): Record<string, number> => {
  const out: Record<string, number> = {}
  if (!state || typeof state !== 'object') return out
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    const size = collectionSize(value)
    if (size === null) continue
    out[key] = size
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set)) {
      let nested = 0
      let sawNested = false
      for (const inner of Object.values(value as Record<string, unknown>)) {
        const innerSize = collectionSize(inner)
        if (innerSize === null) continue
        sawNested = true
        nested += innerSize
      }
      if (sawNested) out[`${key}.*`] = nested
    } else if (value instanceof Map) {
      let nested = 0
      let sawNested = false
      for (const inner of value.values()) {
        const innerSize = collectionSize(inner)
        if (innerSize === null) continue
        sawNested = true
        nested += innerSize
      }
      if (sawNested) out[`${key}.*`] = nested
    }
  }
  return out
}

const collectionSize = (value: unknown): number | null => {
  if (Array.isArray(value)) return value.length
  if (value instanceof Map || value instanceof Set) return value.size
  if (value && typeof value === 'object') return Object.keys(value).length
  return null
}

const resetWindow = (): void => {
  rpcWindow = new Map()
  rpcInflightMax = rpcInflight
  slowThisWindow = 0
  longTasks = { count: 0, totalMs: 0, maxMs: 0 }
  inputEvents = { count: 0, maxMs: 0, worst: '' }
  blocks = { count: 0, totalMs: 0, maxMs: 0 }
}

let flushing = false
const flush = async (extra?: PerfRecord): Promise<void> => {
  if (extra) queue.push({ t: nowIso(), ...extra })
  if (flushing || queue.length === 0) return
  flushing = true
  const batch = queue
  queue = []
  try {
    await perfDiagnosticsApi.appendRecords('renderer', batch)
  } catch {
    // Backend unreachable or saturated: keep the most recent records for the next attempt.
    queue = [...batch, ...queue].slice(-MAX_QUEUED_RECORDS)
  } finally {
    flushing = false
  }
}
