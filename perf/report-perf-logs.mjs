#!/usr/bin/env node
// Summarizes ~/.hive/logs/perf/perf-*.jsonl (see docs/perf/performance-logging.md).
//   node apps/hive/perf/report-perf-logs.mjs [dir] [--hours N] [--step M]
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--')) ?? join(homedir(), '.hive', 'logs', 'perf')
const hours = Number(args[args.indexOf('--hours') + 1] || 0) || 12
const step = Number(args[args.indexOf('--step') + 1] || 0) || 10 // minutes per timeline row
const since = Date.now() - hours * 3_600_000

if (!existsSync(dir)) {
  console.error(`no such directory: ${dir}`)
  process.exit(1)
}

const files = readdirSync(dir).filter((f) => /^perf-.*\.jsonl(\.\d+)?$/.test(f)).sort()
const byRole = new Map()
for (const file of files) {
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (!line) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const t = Date.parse(r.t)
    if (!Number.isFinite(t) || t < since) continue
    const role = r.role ?? 'unknown'
    if (!byRole.has(role)) byRole.set(role, [])
    byRole.get(role).push({ ...r, _t: t })
  }
}

const mb = (n) => (typeof n === 'number' ? (n / 1048576).toFixed(0) : '-')
const pad = (s, w) => String(s).padEnd(w)
const num = (s, w) => String(s).padStart(w)
const top = (map, n, by) =>
  [...map.entries()].sort((a, b) => b[1][by] - a[1][by]).slice(0, n)

for (const [role, records] of byRole) {
  records.sort((a, b) => a._t - b._t)
  console.log(`\n=== ${role}: ${records.length} records from ${new Date(records[0]._t).toISOString()} to ${new Date(records[records.length - 1]._t).toISOString()}`)

  const samples = records.filter((r) => r.kind === 'sample')
  if (samples.length) {
    console.log(`\n-- timeline (every ${step} min; worst sample per row)`)
    console.log(
      pad('time', 17), num('loopP99', 8), num('blocks', 7), num('rssMB', 6), num('heapMB', 7),
      num('handles', 8), num('timers', 7), num('rpc/10s', 8), num('rpcMs', 7), num('dbMs', 7), '  gauges'
    )
    let bucket = null
    let worst = null
    const flush = () => {
      if (!worst) return
      const g = worst.gauges ?? {}
      const gaugeText = Object.entries(g)
        .filter(([, v]) => typeof v === 'number')
        .slice(0, 6)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
      const mem = worst.mem ?? {}
      console.log(
        pad(new Date(worst._t).toISOString().slice(5, 16).replace('T', ' '), 17),
        num(worst.loop?.p99 ?? worst.longTasks?.maxMs ?? '-', 8),
        num(worst.blocks?.count ?? '-', 7),
        num(mb(mem.rss), 6),
        num(mb(mem.heapUsed), 7),
        num(worst.handles?.active ?? worst.dom?.nodes ?? '-', 8),
        num(worst.timers ? worst.timers.intervals + worst.timers.timeouts : '-', 7),
        num(worst.rpc?.count ?? '-', 8),
        num(worst.rpc?.totalMs ?? '-', 7),
        num(worst.db?.totalMs ?? '-', 7),
        ' ', gaugeText
      )
    }
    for (const s of samples) {
      const b = Math.floor(s._t / (step * 60_000))
      if (b !== bucket) {
        flush()
        bucket = b
        worst = s
      } else if ((s.loop?.p99 ?? s.longTasks?.maxMs ?? 0) > (worst.loop?.p99 ?? worst.longTasks?.maxMs ?? 0)) {
        worst = s
      }
    }
    flush()

    const first = samples[0]
    const last = samples[samples.length - 1]
    console.log('\n-- growth first → last sample')
    const growth = []
    const walk = (prefix, a, b) => {
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return
      for (const key of Object.keys(b)) {
        const va = a[key]
        const vb = b[key]
        if (typeof va === 'number' && typeof vb === 'number') {
          if (vb - va !== 0) growth.push([`${prefix}${key}`, va, vb])
        } else if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(vb)) {
          walk(`${prefix}${key}.`, va, vb)
        }
      }
    }
    walk('', { mem: first.mem, handles: first.handles, gauges: first.gauges, timers: { intervals: first.timers?.intervals, timeouts: first.timers?.timeouts }, dom: first.dom, stores: first.stores, ws: { pendingRequests: first.ws?.pendingRequests, listeners: first.ws?.listeners } },
      { mem: last.mem, handles: last.handles, gauges: last.gauges, timers: { intervals: last.timers?.intervals, timeouts: last.timers?.timeouts }, dom: last.dom, stores: last.stores, ws: { pendingRequests: last.ws?.pendingRequests, listeners: last.ws?.listeners } })
    growth.sort((x, y) => Math.abs(y[2] - y[1]) / Math.max(1, Math.abs(y[1])) - Math.abs(x[2] - x[1]) / Math.max(1, Math.abs(x[1])))
    for (const [k, a, b] of growth.slice(0, 25)) console.log(`  ${pad(k, 48)} ${num(a, 12)} → ${num(b, 12)}`)

    const agg = (field, keyName, byField) => {
      const m = new Map()
      for (const s of samples) {
        for (const row of s[field]?.top ?? []) {
          const k = row[keyName]
          const cur = m.get(k) ?? { count: 0, totalMs: 0, maxMs: 0, bytes: 0 }
          cur.count += row.count ?? 0
          cur.totalMs += row.totalMs ?? 0
          cur.maxMs = Math.max(cur.maxMs, row.maxMs ?? 0)
          cur.bytes += row.bytes ?? 0
          m.set(k, cur)
        }
      }
      return top(m, 15, byField)
    }
    const rpc = agg('rpc', 'method', 'totalMs')
    if (rpc.length) {
      console.log('\n-- top RPC methods by total ms')
      for (const [k, v] of rpc) console.log(`  ${pad(k, 56)} n=${num(v.count, 7)} total=${num(v.totalMs.toFixed(0), 8)}ms max=${num(v.maxMs.toFixed(0), 7)}ms`)
    }
    const db = agg('db', 'sql', 'totalMs')
    if (db.length) {
      console.log('\n-- top SQL by total ms')
      for (const [k, v] of db) console.log(`  n=${num(v.count, 7)} total=${num(v.totalMs.toFixed(0), 8)}ms max=${num(v.maxMs.toFixed(0), 6)}ms  ${k.slice(0, 110)}`)
    }
    const ev = agg('events', 'channel', 'bytes')
    if (ev.length) {
      console.log('\n-- top event channels by bytes')
      for (const [k, v] of ev) console.log(`  ${pad(k, 56)} n=${num(v.count, 8)} ${num(mb(v.bytes), 6)}MB`)
    }
    const timers = new Map()
    for (const s of samples) {
      for (const [origin, intervals, timeouts] of s.timers?.top ?? []) {
        const cur = timers.get(origin) ?? { max: 0, last: 0 }
        cur.max = Math.max(cur.max, intervals + timeouts)
        cur.last = intervals + timeouts
        timers.set(origin, cur)
      }
    }
    const timerRows = top(timers, 15, 'max')
    if (timerRows.length) {
      console.log('\n-- timer origins (peak live count)')
      for (const [k, v] of timerRows) console.log(`  ${pad(k, 80)} peak=${num(v.max, 6)} last=${num(v.last, 6)}`)
    }
  }

  const slow = records.filter((r) => r.kind === 'slow')
  if (slow.length) {
    const m = new Map()
    for (const s of slow) {
      const k = `${s.what}:${s.method ?? s.sql?.slice(0, 60) ?? s.name ?? s.command ?? ''}`
      const cur = m.get(k) ?? { count: 0, totalMs: 0, maxMs: 0 }
      cur.count += 1
      cur.totalMs += s.ms
      cur.maxMs = Math.max(cur.maxMs, s.ms)
      m.set(k, cur)
    }
    console.log('\n-- slow operations')
    for (const [k, v] of top(m, 20, 'totalMs')) console.log(`  ${pad(k, 80)} n=${num(v.count, 6)} max=${num(v.maxMs.toFixed(0), 7)}ms`)
  }

  const marks = records.filter((r) => r.kind === 'mark' || r.kind === 'alert' || r.kind === 'capture' || r.kind === 'start' || r.kind === 'stop')
  if (marks.length) {
    console.log('\n-- marks / alerts')
    for (const m of marks.slice(-40)) {
      const { t, role: _r, pid: _p, kind, name, _t, ...rest } = m
      console.log(`  ${t} ${kind}${name ? ` ${name}` : ''} ${JSON.stringify(rest).slice(0, 160)}`)
    }
  }
}
