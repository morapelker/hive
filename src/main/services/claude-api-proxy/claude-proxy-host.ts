/**
 * Claude API proxy host: the loopback tunnel every Claude Code process talks
 * to, running as an Electron utility process instead of inside main.
 *
 * Why a separate process: the tunnel needs nothing from main but a port and
 * an upstream URL, and main hosts PTYs, file watchers, SQLite, the usage sweep
 * and the hook server — all of which share one libuv thread pool and one
 * event loop with whatever runs there. When that pool wedged, every session's
 * API request hung for ten minutes and the only cure was restarting the app.
 * Here a wedge takes down this process alone, its own probe notices within
 * seconds, and main restarts it on the same port.
 *
 * Forked by `claude-proxy-host-manager.ts`; bundled as its own entry by
 * electron-vite (`out/main/claude-proxy-host.js`). Must stay free of
 * `electron`, the DB and the account store: only `http`/`https`, the tunnel,
 * the header parser and the perf logger.
 */
import { getPerfLogger } from '../perf-logging/perf-logger'
import { startThreadpoolProbe, type ThreadpoolProbe } from '../perf-logging/threadpool-probe'
import { extractClaudeAccountUuid } from './anthropic-rate-limit-headers'
import {
  CLAUDE_PROXY_HOST_EXIT_CRASHED,
  CLAUDE_PROXY_HOST_EXIT_STALLED,
  isClaudeProxyHostCommand,
  type ClaudeProxyHostCommand,
  type ClaudeProxyHostEvent,
  type ClaudeProxyHostHealth,
  type ClaudeProxyHostStartCommand
} from './claude-proxy-host-protocol'
import { startLocalApiProxy, type LocalApiProxy, type LocalApiProxyLogger } from './local-api-proxy'

const parentPort = (process as unknown as { parentPort: Electron.ParentPort }).parentPort

const perf = getPerfLogger('claude-proxy')
const startedAt = Date.now()

let proxy: LocalApiProxy | null = null
let probe: ThreadpoolProbe | null = null
let currentUpstream = ''
let shuttingDown = false

function post(event: ClaudeProxyHostEvent): void {
  try {
    parentPort.postMessage(event)
  } catch {
    // The parent is gone; nothing to report to.
  }
}

const log: LocalApiProxyLogger & { error: LocalApiProxyLogger['warn'] } = {
  debug: (message, data) => post({ type: 'log', level: 'debug', message, data }),
  info: (message, data) => post({ type: 'log', level: 'info', message, data }),
  warn: (message, data) => post({ type: 'log', level: 'warn', message, data }),
  error: (message, data) => post({ type: 'log', level: 'warn', message, data })
}

function health(): ClaudeProxyHostHealth {
  const last = probe?.last() ?? null
  return {
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    stats: proxy?.stats() ?? {
      inFlight: 0,
      byPhase: { connecting: 0, sending: 0, waiting: 0, streaming: 0, done: 0 },
      upstreamSockets: { active: 0, free: 0 },
      dns: null,
      totals: {
        exchanges: 0,
        clientAborts: 0,
        upstreamErrors: 0,
        connectTimeouts: 0,
        status4xx: 0,
        status5xx: 0,
        midStreamDrops: 0
      }
    },
    probe: last
      ? {
          ok: last.ok,
          consecutiveMisses: probe?.consecutiveMisses() ?? 0,
          fsMs: last.fsMs,
          dnsMs: last.dnsMs,
          pendingRequests: last.requests.requests,
          pendingLookups: last.requests.pendingLookups
        }
      : null
  }
}

function exitAfterFlush(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  try {
    perf.flush()
    perf.stop()
  } catch {
    // best effort
  }
  // Let the last messages drain before the process goes away.
  setTimeout(() => process.exit(code), 100).unref?.()
}

async function handleStart(command: ClaudeProxyHostStartCommand): Promise<void> {
  if (proxy) {
    post({ type: 'listening', port: proxy.port, host: proxy.host, baseUrl: proxy.baseUrl })
    return
  }
  currentUpstream = command.upstream
  if (command.perfEnabled) perf.start()
  try {
    proxy = await startLocalApiProxy({
      port: command.port,
      host: command.host,
      bindRetryMs: command.bindRetryMs,
      connectTimeoutMs: command.connectTimeoutMs,
      resolveUpstream: () => currentUpstream,
      upstreamTls: { ca: command.ca },
      log,
      onExchange: (exchange) => {
        const accountUuid =
          exchange.requestBody === null ? null : extractClaudeAccountUuid(exchange.requestBody)
        post({
          type: 'exchange',
          exchange: { ...exchange, requestBody: null, accountUuid }
        })
      },
      onRequestRecord: (record) => {
        // Only the outcomes main acts on (recovery, diagnostics); the full
        // per-request record goes to this process's own perf log.
        if (record.outcome !== 'ok') post({ type: 'request', record })
      }
    })
  } catch (error) {
    post({ type: 'start-failed', error: error instanceof Error ? error.message : String(error) })
    return
  }
  perf.registerGauge('proxyHost', () => {
    const h = health()
    return {
      uptimeMin: Math.round(h.uptimeMs / 60_000),
      rssMb: h.rssMb,
      inFlight: h.stats.inFlight,
      socketsActive: h.stats.upstreamSockets.active,
      socketsFree: h.stats.upstreamSockets.free,
      probeMisses: h.probe?.consecutiveMisses ?? 0
    }
  })
  // The host's own thread-pool heartbeat. The tunnel itself no longer needs
  // the pool (c-ares DNS, no file I/O), but the perf log writer and the
  // fallback resolver do — and a wedge here means something is wrong with
  // this process; main restarts it on the same port.
  probe = startThreadpoolProbe({
    log,
    onStall: (result, misses) => {
      const detail = {
        consecutiveMisses: misses,
        fsMs: result.fsMs,
        dnsMs: result.dnsMs,
        pendingRequests: result.requests.requests,
        requestsByType: result.requests.requestsByType,
        pendingLookups: result.requests.pendingLookups,
        inFlight: proxy?.stats().inFlight ?? 0
      }
      log.warn('Proxy host thread pool stalled; exiting so main can restart it', detail)
      perf.dumpHandles('threadpool-stall', detail)
      post({ type: 'stall', detail })
      exitAfterFlush(CLAUDE_PROXY_HOST_EXIT_STALLED)
    }
  })
  post({ type: 'listening', port: proxy.port, host: proxy.host, baseUrl: proxy.baseUrl })
}

async function handleCommand(command: ClaudeProxyHostCommand): Promise<void> {
  switch (command.type) {
    case 'start':
      await handleStart(command)
      return
    case 'upstream':
      currentUpstream = command.url
      return
    case 'perf':
      if (command.enabled) perf.start()
      else perf.stop()
      return
    case 'drop-idle-sockets':
      proxy?.dropUpstreamSockets()
      return
    case 'ping':
      post({ type: 'pong', id: command.id, health: health() })
      return
    case 'probe-upstream': {
      const result = proxy
        ? await proxy.probeUpstream(command.timeoutMs)
        : { ok: false, status: null, ms: 0, error: 'proxy not started' }
      post({ type: 'probe-result', id: command.id, result })
      return
    }
    case 'dump-handles':
      perf.dumpHandles(command.reason, { health: health() })
      return
    case 'shutdown':
      if (proxy) await proxy.close()
      probe?.stop()
      exitAfterFlush(0)
      return
  }
}

parentPort.on('message', (event: { data: unknown }) => {
  const command = event.data
  if (!isClaudeProxyHostCommand(command)) return
  handleCommand(command).catch((error) => {
    log.warn('Proxy host command failed', {
      command: command.type,
      error: error instanceof Error ? error.message : String(error)
    })
  })
})

process.on('uncaughtException', (error) => {
  log.warn('Proxy host uncaught exception; exiting so main can restart it', {
    error: error.message,
    stack: error.stack ?? null
  })
  exitAfterFlush(CLAUDE_PROXY_HOST_EXIT_CRASHED)
})
process.on('unhandledRejection', (reason) => {
  log.warn('Proxy host unhandled rejection', {
    error: reason instanceof Error ? reason.message : String(reason)
  })
})
