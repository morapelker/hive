import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collapseChannel, PerfLogger } from './perf-logger'

const readRecords = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe('PerfLogger', () => {
  let dir: string
  let logger: PerfLogger

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perf-logger-'))
    logger = new PerfLogger({
      role: 'server',
      logDir: dir,
      sampleIntervalMs: 60_000,
      captureHeapSnapshots: false
    })
  })

  afterEach(() => {
    logger.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is a no-op while disabled', () => {
    logger.rpcBegin()
    logger.rpcEnd('x', 1, true)
    logger.recordDb('select 1', 1)
    logger.mark('nothing')
    expect(logger.getStatus().enabled).toBe(false)
    expect(logger.listLogFiles()).toEqual([])
  })

  it('writes start, sample, slow, mark and stop records with window aggregates', () => {
    logger.start()
    logger.registerGauge('sessions', () => 3)
    logger.registerGauge('nested', () => ({ a: 1, b: 2 }))
    logger.rpcBegin()
    logger.rpcBegin()
    logger.rpcEnd('db.listSessions', 12, true)
    logger.rpcEnd('db.listSessions', 700, false)
    logger.recordDb('SELECT * FROM sessions', 2)
    logger.recordDb('SELECT * FROM sessions', 40)
    logger.recordEvent('session:abc-123-def-456-ghi:stream', 2)
    logger.recordEventBytes('session:abc-123-def-456-ghi:stream', 1_000)
    logger.recordEvent('session:zzz-123-def-456-yyy:stream', 1)
    logger.recordEventBytes('session:zzz-123-def-456-yyy:stream', 500)
    logger.mark('session-start', { sessionId: 's1' })

    const sample = logger.sample()
    logger.stop()

    const status = logger.getStatus()
    expect(status.samples).toBe(1)
    const records = readRecords(join(dir, 'perf-server.jsonl'))
    const kinds = records.map((r) => r.kind)
    expect(kinds[0]).toBe('start')
    expect(kinds).toContain('sample')
    expect(kinds).toContain('mark')
    expect(kinds[kinds.length - 1]).toBe('stop')

    const slow = records.filter((r) => r.kind === 'slow')
    expect(slow.map((r) => r.what)).toEqual(expect.arrayContaining(['rpc', 'db']))

    const rpc = sample.rpc as {
      count: number
      inflightMax: number
      top: Array<{ method: string; count: number; errors: number; maxMs: number }>
    }
    expect(rpc.count).toBe(2)
    expect(rpc.inflightMax).toBe(2)
    expect(rpc.top[0]).toMatchObject({ method: 'db.listSessions', count: 2, errors: 1, maxMs: 700 })

    const db = sample.db as { top: Array<{ sql: string; count: number; maxMs: number }> }
    expect(db.top[0]).toMatchObject({ sql: 'SELECT * FROM sessions', count: 2, maxMs: 40 })

    const events = sample.events as { top: Array<{ channel: string; count: number; bytes: number }> }
    expect(events.top).toEqual([{ channel: 'session:*:stream', count: 2, bytes: 1_500, maxListeners: 2 }])

    expect(sample.gauges).toEqual({ sessions: 3, nested: { a: 1, b: 2 } })
    expect((sample.timers as { installed: boolean }).installed ?? true).toBeTruthy()
    expect(sample.loop).toMatchObject({ p99: expect.any(Number) })
    expect(sample.handles).toMatchObject({ active: expect.any(Number) })
    expect(logger.listLogFiles().map((f) => f.name)).toEqual(['perf-server.jsonl'])
  })

  it('raises an alert after the configured number of consecutive slow windows', () => {
    const alerting = new PerfLogger({
      role: 'server',
      logDir: dir,
      sampleIntervalMs: 60_000,
      loopP99AlertMs: 0,
      alertWindows: 2,
      captureHeapSnapshots: false
    })
    alerting.start()
    alerting.sample()
    alerting.sample()
    alerting.sample()
    alerting.stop()
    const alerts = readRecords(join(dir, 'perf-server.jsonl')).filter((r) => r.kind === 'alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ reason: 'event-loop-p99', consecutiveWindows: 2 })
  })

  it('persists records from another process under that role, never under its own', () => {
    logger.start()
    logger.writeExternal('renderer', [{ kind: 'sample', t: '2026-01-01T00:00:00.000Z', x: 1 }])
    logger.writeExternal('server', [{ kind: 'sample', x: 2 }])
    logger.stop()
    // The renderer's final sample arrives after the toggle: still accepted and flushed.
    logger.writeExternal('renderer', [{ kind: 'stop', t: '2026-01-01T00:00:10.000Z' }])
    logger.flush()
    const records = readRecords(join(dir, 'perf-renderer.jsonl'))
    expect(records).toEqual([
      { kind: 'sample', t: '2026-01-01T00:00:00.000Z', x: 1, role: 'renderer' },
      { kind: 'stop', t: '2026-01-01T00:00:10.000Z', role: 'renderer' }
    ])
    expect(readRecords(join(dir, 'perf-server.jsonl')).some((r) => r.x === 2)).toBe(false)
  })

  it('writes a handle dump on captureNow', () => {
    logger.start()
    const { files } = logger.captureNow('test')
    logger.stop()
    expect(files.some((f) => f.includes('handles-server-'))).toBe(true)
    const dump = JSON.parse(readFileSync(files[0], 'utf8')) as { reason: string; handles: unknown }
    expect(dump.reason).toBe('test')
    expect(dump.handles).toBeDefined()
  })
})

describe('collapseChannel', () => {
  it('replaces ids with * so per-entity channels aggregate', () => {
    expect(collapseChannel('session:0f8c1b2e-1111-2222-3333-444455556666:stream')).toBe(
      'session:*:stream'
    )
    expect(collapseChannel('peer:abcdef0123456789abcdef:db:changed')).toBe('peer:*:db:changed')
    expect(collapseChannel('db:changed')).toBe('db:changed')
  })
})
