/**
 * Tracks live `setTimeout` / `setInterval` timers by the call site that created them, so a
 * performance log can answer "which interval is multiplying?" instead of just "there are
 * 900 Timer handles". Installed only while performance logging is on: creating a timer then
 * costs one short stack capture.
 *
 * Only timers created through the globals after `install()` are tracked; modules that bound
 * `setTimeout` from `node:timers` at import time keep the originals and are invisible here.
 */

type TimerHandle = ReturnType<typeof setTimeout>

interface TrackedTimer {
  readonly kind: 'timeout' | 'interval'
  readonly origin: string
  readonly createdAt: number
}

export interface TimerOriginStat {
  origin: string
  timeouts: number
  intervals: number
  /** Age in ms of the oldest live timer from this origin. */
  oldestMs: number
}

export interface TimerRegistrySnapshot {
  installed: boolean
  timeouts: number
  intervals: number
  byOrigin: TimerOriginStat[]
}

const live = new Map<object, TrackedTimer>()
let installed = false
let originals: {
  setTimeout: typeof setTimeout
  setInterval: typeof setInterval
  clearTimeout: typeof clearTimeout
  clearInterval: typeof clearInterval
} | null = null

const STACK_LIMIT = 8

/**
 * The caller's frame, trimmed to its last path segments. `skipFrames` is how many frames above
 * `captureOrigin` itself belong to the registry (the timer wrapper), so the result survives
 * bundling where every frame shares one file name.
 */
export function captureOrigin(skipFrames = 0): string {
  const previousLimit = Error.stackTraceLimit
  Error.stackTraceLimit = STACK_LIMIT + skipFrames
  const stack = new Error().stack ?? ''
  Error.stackTraceLimit = previousLimit
  // Line 0 is the "Error" header, line 1 is captureOrigin itself.
  const lines = stack.split('\n').slice(2 + skipFrames)
  for (const line of lines) {
    const trimmed = line.trim()
    if (
      trimmed.length === 0 ||
      trimmed.includes('node:internal') ||
      trimmed.startsWith('at new Promise')
    ) {
      continue
    }
    return shortenFrame(trimmed)
  }
  return 'unknown'
}

function shortenFrame(frame: string): string {
  // "at fn (/a/b/c/d.ts:12:3)" | "at /a/b/c/d.ts:12:3"
  const match = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(frame)
  if (!match) return frame.replace(/^at\s+/, '').slice(0, 120)
  const [, file, line] = match
  const segments = file.split(/[\\/]/).filter(Boolean)
  const tail = segments.slice(-3).join('/')
  const fnMatch = /^at\s+([^\s(]+)\s*\(/.exec(frame)
  const fn = fnMatch && fnMatch[1] !== 'Timeout._onTimeout' ? `${fnMatch[1]} ` : ''
  return `${fn}${tail}:${line}`
}

export function installTimerRegistry(): void {
  if (installed) return
  installed = true
  const g = globalThis as unknown as {
    setTimeout: typeof setTimeout
    setInterval: typeof setInterval
    clearTimeout: typeof clearTimeout
    clearInterval: typeof clearInterval
  }
  originals = {
    setTimeout: g.setTimeout,
    setInterval: g.setInterval,
    clearTimeout: g.clearTimeout,
    clearInterval: g.clearInterval
  }
  const { setTimeout: origSetTimeout, setInterval: origSetInterval } = originals
  const { clearTimeout: origClearTimeout, clearInterval: origClearInterval } = originals

  const wrappedSetTimeout = function (
    this: unknown,
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): TimerHandle {
    if (typeof callback !== 'function') {
      return Reflect.apply(origSetTimeout, globalThis, [callback, delay, ...args]) as TimerHandle
    }
    const origin = captureOrigin(1)
    let handle: TimerHandle | null = null
    const wrappedCallback = function (this: unknown, ...callbackArgs: unknown[]): void {
      if (handle) live.delete(handle as unknown as object)
      callback.apply(this, callbackArgs)
    }
    handle = Reflect.apply(origSetTimeout, globalThis, [wrappedCallback, delay, ...args]) as TimerHandle
    if (typeof handle === 'object' && handle !== null) {
      live.set(handle as unknown as object, { kind: 'timeout', origin, createdAt: Date.now() })
    }
    return handle
  }
  const wrappedSetInterval = function (
    this: unknown,
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): TimerHandle {
    if (typeof callback !== 'function') {
      return Reflect.apply(origSetInterval, globalThis, [callback, delay, ...args]) as TimerHandle
    }
    const origin = captureOrigin(1)
    const handle = Reflect.apply(origSetInterval, globalThis, [callback, delay, ...args]) as TimerHandle
    if (typeof handle === 'object' && handle !== null) {
      live.set(handle as unknown as object, { kind: 'interval', origin, createdAt: Date.now() })
    }
    return handle
  }
  const wrappedClearTimeout = function (this: unknown, handle?: TimerHandle | string | number): void {
    if (typeof handle === 'object' && handle !== null) live.delete(handle as unknown as object)
    origClearTimeout.call(globalThis, handle as TimerHandle)
  }
  const wrappedClearInterval = function (
    this: unknown,
    handle?: TimerHandle | string | number
  ): void {
    if (typeof handle === 'object' && handle !== null) live.delete(handle as unknown as object)
    origClearInterval.call(globalThis, handle as TimerHandle)
  }

  // Keep `util.promisify(setTimeout)` and friends working: copy symbol/own props.
  copyOwnProps(origSetTimeout, wrappedSetTimeout)
  copyOwnProps(origSetInterval, wrappedSetInterval)

  g.setTimeout = wrappedSetTimeout as unknown as typeof setTimeout
  g.setInterval = wrappedSetInterval as unknown as typeof setInterval
  g.clearTimeout = wrappedClearTimeout as unknown as typeof clearTimeout
  g.clearInterval = wrappedClearInterval as unknown as typeof clearInterval
}

export function uninstallTimerRegistry(): void {
  if (!installed || !originals) return
  const g = globalThis as unknown as Record<string, unknown>
  g.setTimeout = originals.setTimeout
  g.setInterval = originals.setInterval
  g.clearTimeout = originals.clearTimeout
  g.clearInterval = originals.clearInterval
  originals = null
  installed = false
  live.clear()
}

export function isTimerRegistryInstalled(): boolean {
  return installed
}

export function snapshotTimerRegistry(limit = 25): TimerRegistrySnapshot {
  const now = Date.now()
  const byOrigin = new Map<string, TimerOriginStat>()
  let timeouts = 0
  let intervals = 0
  for (const timer of live.values()) {
    if (timer.kind === 'timeout') timeouts += 1
    else intervals += 1
    let stat = byOrigin.get(timer.origin)
    if (!stat) {
      stat = { origin: timer.origin, timeouts: 0, intervals: 0, oldestMs: 0 }
      byOrigin.set(timer.origin, stat)
    }
    if (timer.kind === 'timeout') stat.timeouts += 1
    else stat.intervals += 1
    stat.oldestMs = Math.max(stat.oldestMs, now - timer.createdAt)
  }
  const sorted = [...byOrigin.values()].sort(
    (a, b) => b.intervals + b.timeouts - (a.intervals + a.timeouts)
  )
  return { installed, timeouts, intervals, byOrigin: sorted.slice(0, limit) }
}

function copyOwnProps(from: object, to: object): void {
  for (const key of Reflect.ownKeys(from)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue
    const descriptor = Object.getOwnPropertyDescriptor(from, key)
    if (!descriptor) continue
    try {
      Object.defineProperty(to, key, descriptor)
    } catch {
      // non-configurable props on the target: ignore
    }
  }
}
