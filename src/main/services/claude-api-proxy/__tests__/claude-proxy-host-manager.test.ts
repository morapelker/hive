// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ClaudeProxyHostManager, type ProxyHostChild } from '../claude-proxy-host-manager'
import type { ClaudeProxyHostCommand, ClaudeProxyHostEvent, ClaudeProxyHostHealth } from '../claude-proxy-host-protocol'

/** A scripted stand-in for the utility process: answers `start` and `ping`, can be made to hang or die. */
class FakeChild implements ProxyHostChild {
  static nextPid = 100
  pid = FakeChild.nextPid++
  commands: ClaudeProxyHostCommand[] = []
  killed = false
  answerPings = true
  listenPort: number
  private readonly listeners = { message: [] as Array<(m: unknown) => void>, exit: [] as Array<(c: number) => void> }
  constructor(listenPort = 42411) {
    this.listenPort = listenPort
  }
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'message' | 'exit', listener: (arg: never) => void): unknown {
    this.listeners[event].push(listener as never)
    return this
  }
  emit(event: ClaudeProxyHostEvent): void {
    for (const listener of this.listeners.message) listener(event)
  }
  exit(code: number): void {
    for (const listener of this.listeners.exit) listener(code)
  }
  postMessage(message: unknown): void {
    const command = message as ClaudeProxyHostCommand
    this.commands.push(command)
    if (command.type === 'start') {
      setTimeout(
        () => this.emit({ type: 'listening', port: this.listenPort, host: '127.0.0.1', baseUrl: `http://127.0.0.1:${this.listenPort}` }),
        0
      )
    } else if (command.type === 'ping' && this.answerPings) {
      setTimeout(() => this.emit({ type: 'pong', id: command.id, health: fakeHealth(this.pid) }), 0)
    } else if (command.type === 'probe-upstream') {
      setTimeout(() => this.emit({ type: 'probe-result', id: command.id, result: { ok: true, status: 401, ms: 3, error: null } }), 0)
    } else if (command.type === 'shutdown') {
      setTimeout(() => this.exit(0), 0)
    }
  }
  kill(): boolean {
    this.killed = true
    setTimeout(() => this.exit(-1), 0)
    return true
  }
}

const fakeHealth = (pid: number): ClaudeProxyHostHealth => ({
  pid,
  uptimeMs: 1,
  rssMb: 50,
  stats: {
    inFlight: 0,
    byPhase: { connecting: 0, sending: 0, waiting: 0, streaming: 0, done: 0 },
    upstreamSockets: { active: 0, free: 0 },
    dns: null,
    totals: { exchanges: 0, clientAborts: 0, upstreamErrors: 0, connectTimeouts: 0, status4xx: 0, status5xx: 0, midStreamDrops: 0 }
  },
  probe: null
})

function makeManager(opts: { children?: FakeChild[]; events?: Array<[string, Record<string, unknown>]> } = {}) {
  const children: FakeChild[] = opts.children ?? []
  const events = opts.events ?? []
  const exchanges: unknown[] = []
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const manager = new ClaudeProxyHostManager({
    scriptPath: '/fake/claude-proxy-host.js',
    fork: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
    port: 42411,
    host: '127.0.0.1',
    resolveUpstream: () => 'https://api.anthropic.com',
    ca: [],
    perfEnabled: () => false,
    onExchange: (exchange) => exchanges.push(exchange),
    onEvent: (name, data) => events.push([name, data]),
    log,
    pingIntervalMs: 60_000,
    pingTimeoutMs: 20,
    missesBeforeRestart: 2,
    startTimeoutMs: 500,
    restartWindowMs: 60_000,
    maxRestartsPerWindow: 2,
    restartBackoffMs: 30
  })
  return { manager, children, events, exchanges, log }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('ClaudeProxyHostManager', () => {
  it('starts the host, sends it the start command and relays its exchanges and log lines', async () => {
    const { manager, children, exchanges, log } = makeManager()
    const info = await manager.start()
    expect(info).toEqual({ port: 42411, host: '127.0.0.1', baseUrl: 'http://127.0.0.1:42411' })
    expect(children[0].commands[0]).toMatchObject({ type: 'start', port: 42411, upstream: 'https://api.anthropic.com' })
    children[0].emit({
      type: 'exchange',
      exchange: {
        method: 'POST',
        path: '/v1/messages',
        requestHeaders: {},
        credentialFingerprint: 'fp',
        requestBody: null,
        accountUuid: 'uuid',
        status: 200,
        responseHeaders: {},
        observedAt: 1,
        latencyMs: 1
      }
    })
    children[0].emit({ type: 'log', level: 'warn', message: 'hello', data: { a: 1 } })
    expect(exchanges).toHaveLength(1)
    expect(log.warn).toHaveBeenCalledWith('hello', { a: 1 })
    expect(manager.status()).toMatchObject({ state: 'running', port: 42411, restarts: 0 })
    await manager.stop()
    expect(manager.status().state).toBe('stopped')
  })

  it('answers upstream probes through the host', async () => {
    const { manager } = makeManager()
    await manager.start()
    expect(await manager.probeUpstream(50)).toEqual({ ok: true, status: 401, ms: 3, error: null })
    await manager.stop()
  })

  it('restarts the host on the same port when it exits unexpectedly', async () => {
    const { manager, children, events } = makeManager()
    await manager.start()
    children[0].exit(70)
    await tick()
    await tick()
    expect(children).toHaveLength(2)
    expect(manager.status()).toMatchObject({ state: 'running', restarts: 1, lastExit: expect.objectContaining({ code: 70, reason: 'threadpool-stall' }) })
    expect(events.map(([name]) => name)).toEqual(['proxy-host-start', 'proxy-host-exit', 'proxy-host-restart', 'proxy-host-restarted'])
    await manager.stop()
  })

  it('recycles a host that stops answering pings', async () => {
    const { manager, children, events } = makeManager()
    await manager.start()
    children[0].answerPings = false
    await manager.watchdogTick()
    expect(manager.status().missedPings).toBe(1)
    expect(children[0].killed).toBe(false)
    await manager.watchdogTick()
    await tick()
    await tick()
    expect(children[0].killed).toBe(true)
    expect(children).toHaveLength(2)
    expect(manager.status()).toMatchObject({ state: 'running', restarts: 1, missedPings: 0 })
    expect(events.map(([name]) => name)).toContain('proxy-host-recycle')
    await manager.stop()
  })

  it('backs off once the restart budget is spent, then tries again', async () => {
    const { manager, children, events } = makeManager()
    await manager.start()
    children[0].exit(71)
    await tick()
    await tick()
    children[1].exit(71)
    await tick()
    await tick()
    expect(children).toHaveLength(3)
    children[2].exit(71)
    await tick()
    expect(manager.status().state).toBe('failed')
    expect(events.map(([name]) => name)).toContain('proxy-host-backoff')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(children).toHaveLength(4)
    expect(manager.status().state).toBe('running')
    await manager.stop()
  })

  it('does not restart a host it stopped itself', async () => {
    const { manager, children } = makeManager()
    await manager.start()
    await manager.stop()
    await tick()
    expect(children).toHaveLength(1)
    expect(children[0].commands.at(-1)).toEqual({ type: 'shutdown' })
  })
})
