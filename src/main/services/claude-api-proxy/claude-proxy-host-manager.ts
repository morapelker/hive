/**
 * Runs the Claude API proxy host (`claude-proxy-host.ts`) as a child of the
 * Electron main process and keeps it alive.
 *
 * - forks it, waits for `listening`, relays its exchanges and log lines;
 * - pings it on a timer; two missed pongs, a `stall` report or an unexpected
 *   exit restart it on the SAME port (the port is baked into every running
 *   CLI's environment), with a budget so a host that cannot start does not
 *   spin;
 * - pushes the upstream URL and the perf-logging switch down to it;
 * - answers "can the upstream be reached right now?" for the session
 *   recovery service.
 *
 * `fork` is injectable so this can be tested without Electron.
 */
import type {
  ClaudeProxyExchange,
  ClaudeProxyHostCommand,
  ClaudeProxyHostEvent,
  ClaudeProxyHostHealth
} from './claude-proxy-host-protocol'
import { isClaudeProxyHostEvent } from './claude-proxy-host-protocol'
import type { LocalApiProxyProbeResult, LocalApiProxyRequestRecord } from './local-api-proxy'

/** The slice of Electron's `UtilityProcess` the manager uses. */
export interface ProxyHostChild {
  pid?: number
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  postMessage(message: unknown): void
  kill(): boolean
  stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
}

export type ProxyHostFork = (scriptPath: string) => ProxyHostChild

export type ProxyHostState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed'

export interface ProxyHostStatus {
  state: ProxyHostState
  pid: number | null
  port: number | null
  baseUrl: string | null
  startedAt: number | null
  restarts: number
  lastExit: { code: number; at: number; reason: string } | null
  missedPings: number
  lastPongAt: number | null
  lastHealth: ClaudeProxyHostHealth | null
}

export interface ProxyHostLogger {
  debug: (message: string, data?: Record<string, unknown>) => void
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
}

export interface ClaudeProxyHostManagerOptions {
  scriptPath: string
  fork: ProxyHostFork
  port: number
  host: string
  resolveUpstream: () => string
  ca: string[]
  connectTimeoutMs?: number
  perfEnabled: () => boolean
  onExchange: (exchange: ClaudeProxyExchange) => void
  onRequestRecord?: (record: LocalApiProxyRequestRecord) => void
  /** Lifecycle events for the perf log / app log (`proxy-host-start`, `proxy-host-restart`, …). */
  onEvent?: (name: string, data: Record<string, unknown>) => void
  /** The host came (back) up: `baseUrl` may differ from before when the port could not be reused. */
  onListening?: (info: { port: number; host: string; baseUrl: string; restarted: boolean }) => void
  log: ProxyHostLogger
  startTimeoutMs?: number
  pingIntervalMs?: number
  pingTimeoutMs?: number
  missesBeforeRestart?: number
  upstreamRefreshMs?: number
  bindRetryMs?: number
  maxRestartsPerWindow?: number
  restartWindowMs?: number
  restartBackoffMs?: number
  /** Injectable clock/timers for tests. */
  now?: () => number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

interface Pending<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_START_TIMEOUT_MS = 20_000
const DEFAULT_PING_INTERVAL_MS = 15_000
const DEFAULT_PING_TIMEOUT_MS = 10_000
const DEFAULT_MISSES_BEFORE_RESTART = 2
const DEFAULT_UPSTREAM_REFRESH_MS = 15_000
const DEFAULT_BIND_RETRY_MS = 8_000
const DEFAULT_MAX_RESTARTS_PER_WINDOW = 5
const DEFAULT_RESTART_WINDOW_MS = 10 * 60_000
const DEFAULT_RESTART_BACKOFF_MS = 60_000
const KILL_WAIT_MS = 3_000

export class ClaudeProxyHostManager {
  private readonly options: ClaudeProxyHostManagerOptions
  private child: ProxyHostChild | null = null
  private state: ProxyHostState = 'stopped'
  private port: number | null = null
  private baseUrl: string | null = null
  private startedAt: number | null = null
  private restarts = 0
  private restartTimes: number[] = []
  private lastExit: ProxyHostStatus['lastExit'] = null
  private missedPings = 0
  private lastPongAt: number | null = null
  private lastHealth: ClaudeProxyHostHealth | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private upstreamTimer: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private lastUpstream = ''
  private nextId = 1
  private readonly pendingPongs = new Map<number, Pending<ClaudeProxyHostHealth>>()
  private readonly pendingProbes = new Map<number, Pending<LocalApiProxyProbeResult>>()
  private startWaiter: Pending<{ port: number; host: string; baseUrl: string }> | null = null
  private stopping = false
  private restarting: Promise<void> | null = null

  constructor(options: ClaudeProxyHostManagerOptions) {
    this.options = options
  }

  status(): ProxyHostStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      port: this.port,
      baseUrl: this.baseUrl,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastExit: this.lastExit,
      missedPings: this.missedPings,
      lastPongAt: this.lastPongAt,
      lastHealth: this.lastHealth
    }
  }

  /** Spawn the host and wait for it to listen. Rejects when it cannot bind at all. */
  async start(): Promise<{ port: number; host: string; baseUrl: string }> {
    this.stopping = false
    const info = await this.spawn(false)
    this.startTimers()
    return info
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.stopTimers()
    if (this.restartTimer) this.clearTimeoutFn(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    this.child = null
    this.rejectPending(new Error('proxy host stopped'))
    if (child) {
      this.send(child, { type: 'shutdown' })
      await this.waitForExit(child, KILL_WAIT_MS)
    }
    this.state = 'stopped'
    this.options.onEvent?.('proxy-host-stop', {})
  }

  dropIdleSockets(): void {
    if (this.child) this.send(this.child, { type: 'drop-idle-sockets' })
  }

  setPerfEnabled(enabled: boolean): void {
    if (this.child) this.send(this.child, { type: 'perf', enabled })
  }

  dumpHandles(reason: string): void {
    if (this.child) this.send(this.child, { type: 'dump-handles', reason })
  }

  /** Re-read the upstream now (settings changed) instead of waiting for the refresh tick. */
  refreshUpstream(): void {
    this.pushUpstream()
  }

  probeUpstream(timeoutMs = 10_000): Promise<LocalApiProxyProbeResult> {
    const child = this.child
    if (!child || this.state !== 'running') {
      return Promise.resolve({
        ok: false,
        status: null,
        ms: 0,
        error: `proxy host is ${this.state}`
      })
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = this.setTimeoutFn(() => {
        this.pendingProbes.delete(id)
        resolve({ ok: false, status: null, ms: timeoutMs, error: 'proxy host did not answer the probe' })
      }, timeoutMs + 2_000)
      this.pendingProbes.set(id, { resolve, reject, timer })
      this.send(child, { type: 'probe-upstream', id, timeoutMs })
    })
  }

  ping(): Promise<ClaudeProxyHostHealth> {
    const child = this.child
    if (!child) return Promise.reject(new Error('proxy host not running'))
    const id = this.nextId++
    const timeoutMs = this.options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = this.setTimeoutFn(() => {
        this.pendingPongs.delete(id)
        reject(new Error(`proxy host did not answer a ping within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pendingPongs.set(id, { resolve, reject, timer })
      this.send(child, { type: 'ping', id })
    })
  }

  // ------------------------------------------------------------------ internals

  private get now(): number {
    return (this.options.now ?? Date.now)()
  }

  private get setTimeoutFn(): typeof setTimeout {
    return this.options.setTimeout ?? setTimeout
  }

  private get clearTimeoutFn(): typeof clearTimeout {
    return this.options.clearTimeout ?? clearTimeout
  }

  private send(child: ProxyHostChild, command: ClaudeProxyHostCommand): void {
    try {
      child.postMessage(command)
    } catch (error) {
      this.options.log.warn('Could not message the proxy host', {
        command: command.type,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private spawn(restarted: boolean): Promise<{ port: number; host: string; baseUrl: string }> {
    this.state = restarted ? 'restarting' : 'starting'
    const child = this.options.fork(this.options.scriptPath)
    this.child = child
    this.missedPings = 0
    this.lastHealth = null
    this.options.log.info(restarted ? 'Restarting Claude API proxy host' : 'Starting Claude API proxy host', {
      scriptPath: this.options.scriptPath,
      port: this.options.port,
      pid: child.pid ?? null
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.options.log.debug('proxy host stdout', { text })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.options.log.warn('proxy host stderr', { text })
    })
    child.on('message', (message) => {
      if (this.child !== child) return
      if (!isClaudeProxyHostEvent(message)) return
      this.handleEvent(message)
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.handleExit(code)
    })

    this.lastUpstream = this.options.resolveUpstream()
    this.send(child, {
      type: 'start',
      port: this.options.port,
      host: this.options.host,
      upstream: this.lastUpstream,
      ca: this.options.ca,
      connectTimeoutMs: this.options.connectTimeoutMs,
      bindRetryMs: this.options.bindRetryMs ?? DEFAULT_BIND_RETRY_MS,
      perfEnabled: this.options.perfEnabled()
    })

    return new Promise((resolve, reject) => {
      const timer = this.setTimeoutFn(() => {
        this.startWaiter = null
        reject(new Error('proxy host did not start in time'))
      }, this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
      this.startWaiter = {
        timer,
        resolve: (info) => {
          this.clearTimeoutFn(timer)
          this.startWaiter = null
          if (restarted) this.options.log.info('Claude API proxy host is back', { ...info, pid: child.pid ?? null })
          resolve(info)
        },
        reject: (error) => {
          this.clearTimeoutFn(timer)
          this.startWaiter = null
          reject(error)
        }
      }
    })
  }

  private handleEvent(event: ClaudeProxyHostEvent): void {
    switch (event.type) {
      case 'listening': {
        const previousPort = this.port
        this.port = event.port
        this.baseUrl = event.baseUrl
        this.startedAt = this.now
        const restarted = this.state === 'restarting'
        this.state = 'running'
        this.options.onEvent?.(restarted ? 'proxy-host-restarted' : 'proxy-host-start', {
          port: event.port,
          pid: this.child?.pid ?? null,
          restarts: this.restarts
        })
        if (restarted && previousPort !== null && previousPort !== event.port) {
          this.options.log.warn(
            'Claude API proxy host came back on a different port; sessions started before this keep the old one',
            { previousPort, port: event.port }
          )
        }
        this.options.onListening?.({ ...event, restarted })
        this.startWaiter?.resolve({ port: event.port, host: event.host, baseUrl: event.baseUrl })
        return
      }
      case 'start-failed':
        this.options.log.warn('Claude API proxy host could not start', { error: event.error })
        this.startWaiter?.reject(new Error(event.error))
        return
      case 'exchange':
        try {
          this.options.onExchange(event.exchange)
        } catch (error) {
          this.options.log.warn('Exchange handler threw', {
            error: error instanceof Error ? error.message : String(error)
          })
        }
        return
      case 'request':
        try {
          this.options.onRequestRecord?.(event.record)
        } catch (error) {
          this.options.log.warn('Request record handler threw', {
            error: error instanceof Error ? error.message : String(error)
          })
        }
        return
      case 'log':
        this.options.log[event.level](event.message, event.data)
        return
      case 'pong': {
        const pending = this.pendingPongs.get(event.id)
        if (pending) {
          this.pendingPongs.delete(event.id)
          this.clearTimeoutFn(pending.timer)
          pending.resolve(event.health)
        }
        this.lastPongAt = this.now
        this.lastHealth = event.health
        this.missedPings = 0
        return
      }
      case 'probe-result': {
        const pending = this.pendingProbes.get(event.id)
        if (!pending) return
        this.pendingProbes.delete(event.id)
        this.clearTimeoutFn(pending.timer)
        pending.resolve(event.result)
        return
      }
      case 'stall':
        this.options.log.warn('Claude API proxy host reported a thread-pool stall', event.detail)
        this.options.onEvent?.('proxy-host-stall', event.detail)
        // The host exits on its own right after this; `handleExit` restarts it.
        return
    }
  }

  private handleExit(code: number): void {
    const reason = this.stopping ? 'stopped' : code === 70 ? 'threadpool-stall' : code === 71 ? 'crash' : 'exit'
    this.lastExit = { code, at: this.now, reason }
    this.rejectPending(new Error(`proxy host exited (code ${code})`))
    this.child = null
    if (this.stopping) {
      this.state = 'stopped'
      return
    }
    this.options.log.warn('Claude API proxy host exited unexpectedly', { code, reason })
    this.options.onEvent?.('proxy-host-exit', { code, reason })
    this.startWaiter?.reject(new Error(`proxy host exited during start (code ${code})`))
    void this.scheduleRestart(reason)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingPongs.values()) {
      this.clearTimeoutFn(pending.timer)
      pending.reject(error)
    }
    this.pendingPongs.clear()
    for (const pending of this.pendingProbes.values()) {
      this.clearTimeoutFn(pending.timer)
      pending.resolve({ ok: false, status: null, ms: 0, error: error.message })
    }
    this.pendingProbes.clear()
  }

  private async scheduleRestart(reason: string): Promise<void> {
    if (this.restarting) return this.restarting
    this.restarting = (async () => {
      const windowMs = this.options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS
      const maxRestarts = this.options.maxRestartsPerWindow ?? DEFAULT_MAX_RESTARTS_PER_WINDOW
      const cutoff = this.now - windowMs
      this.restartTimes = this.restartTimes.filter((at) => at > cutoff)
      let delayMs = 0
      if (this.restartTimes.length >= maxRestarts) {
        delayMs = this.options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
        this.state = 'failed'
        this.options.log.warn('Claude API proxy host restart budget exhausted; backing off', {
          restartsInWindow: this.restartTimes.length,
          windowMs,
          delayMs
        })
        this.options.onEvent?.('proxy-host-backoff', { restartsInWindow: this.restartTimes.length, delayMs })
      }
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          this.restartTimer = this.setTimeoutFn(() => {
            this.restartTimer = null
            resolve()
          }, delayMs)
        })
      }
      if (this.stopping) return
      this.restarts += 1
      this.restartTimes.push(this.now)
      this.options.onEvent?.('proxy-host-restart', { reason, restarts: this.restarts })
      try {
        await this.spawn(true)
      } catch (error) {
        this.options.log.warn('Claude API proxy host restart failed', {
          error: error instanceof Error ? error.message : String(error)
        })
        // A failed spawn leaves no child; try again (the budget caps the rate).
        if (this.child) {
          const child = this.child
          this.child = null
          child.kill()
        }
        this.restarting = null
        void this.scheduleRestart('start-failed')
      }
    })().finally(() => {
      this.restarting = null
    })
    return this.restarting
  }

  /** Kill the current host (unresponsive) and let the exit handler restart it. */
  private async recycle(reason: string): Promise<void> {
    const child = this.child
    if (!child) return
    this.options.log.warn('Recycling the Claude API proxy host', { reason, pid: child.pid ?? null })
    this.options.onEvent?.('proxy-host-recycle', { reason, missedPings: this.missedPings })
    this.child = null
    this.rejectPending(new Error(`proxy host recycled (${reason})`))
    this.state = 'restarting'
    child.kill()
    const exited = await this.waitForExit(child, KILL_WAIT_MS)
    if (!exited) this.options.log.warn('Proxy host did not exit after kill; spawning a replacement anyway')
    this.lastExit = { code: -1, at: this.now, reason }
    void this.scheduleRestart(reason)
  }

  private waitForExit(child: ProxyHostChild, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const timer = this.setTimeoutFn(() => {
        if (done) return
        done = true
        resolve(false)
      }, timeoutMs)
      child.on('exit', () => {
        if (done) return
        done = true
        this.clearTimeoutFn(timer)
        resolve(true)
      })
    })
  }

  private startTimers(): void {
    const schedule = this.options.setInterval ?? setInterval
    this.pingTimer = schedule(() => void this.watchdogTick(), this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS)
    ;(this.pingTimer as { unref?: () => void }).unref?.()
    this.upstreamTimer = schedule(() => this.pushUpstream(), this.options.upstreamRefreshMs ?? DEFAULT_UPSTREAM_REFRESH_MS)
    ;(this.upstreamTimer as { unref?: () => void }).unref?.()
  }

  private stopTimers(): void {
    const unschedule = this.options.clearInterval ?? clearInterval
    if (this.pingTimer) unschedule(this.pingTimer)
    if (this.upstreamTimer) unschedule(this.upstreamTimer)
    this.pingTimer = null
    this.upstreamTimer = null
  }

  private pushUpstream(): void {
    if (!this.child || this.state !== 'running') return
    let upstream: string
    try {
      upstream = this.options.resolveUpstream()
    } catch {
      return
    }
    if (upstream === this.lastUpstream) return
    this.lastUpstream = upstream
    this.options.log.info('Claude API proxy upstream changed', { upstream })
    this.send(this.child, { type: 'upstream', url: upstream })
  }

  /** One watchdog tick: ping; count misses; recycle after too many. Exposed for tests. */
  async watchdogTick(): Promise<void> {
    if (!this.child || this.state !== 'running' || this.stopping) return
    try {
      const health = await this.ping()
      if (health.probe && !health.probe.ok) {
        this.options.log.warn('Claude API proxy host reports its thread pool is stalling', {
          consecutiveMisses: health.probe.consecutiveMisses,
          pendingLookups: health.probe.pendingLookups
        })
      }
    } catch (error) {
      if (!this.child || this.stopping) return
      this.missedPings += 1
      this.options.log.warn('Claude API proxy host missed a ping', {
        missedPings: this.missedPings,
        error: error instanceof Error ? error.message : String(error)
      })
      this.options.onEvent?.('proxy-host-missed-ping', { missedPings: this.missedPings })
      if (this.missedPings >= (this.options.missesBeforeRestart ?? DEFAULT_MISSES_BEFORE_RESTART)) {
        await this.recycle('unresponsive')
      }
    }
  }
}
