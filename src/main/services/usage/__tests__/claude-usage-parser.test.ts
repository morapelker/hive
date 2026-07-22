import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseClaudeSessionIncrement, type ClaudeSessionState } from '../claude-usage-parser'
import { setModelPricingTable, type RawPricingTable } from '../pricing'
import pricingFixture from './model-pricing-fixture.json'

// The runtime table comes from Hive Enterprise; tests load a LiteLLM snapshot
// fixture directly.
setModelPricingTable(pricingFixture as RawPricingTable)

// claude-fable-5 rates from the snapshot fixture:
const IN = 1e-5
const OUT = 5e-5
const C5M = 1.25e-5
const C1H = 2e-5
const READ = 1e-6

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-usage-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface EntryOpts {
  id: string
  requestId?: string
  model?: string
  ts?: string
  input?: number
  output?: number
  cacheRead?: number
  cache5m?: number
  cache1h?: number
  sidechain?: boolean
  costUSD?: number
  speed?: string
}

function entry(opts: EntryOpts): string {
  const usage: Record<string, unknown> = {
    input_tokens: opts.input ?? 0,
    output_tokens: opts.output ?? 0,
    cache_read_input_tokens: opts.cacheRead ?? 0,
    cache_creation_input_tokens: (opts.cache5m ?? 0) + (opts.cache1h ?? 0)
  }
  if (opts.cache5m !== undefined || opts.cache1h !== undefined) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: opts.cache5m ?? 0,
      ephemeral_1h_input_tokens: opts.cache1h ?? 0
    }
  }
  if (opts.speed) usage.speed = opts.speed
  const line: Record<string, unknown> = {
    type: 'assistant',
    timestamp: opts.ts ?? '2026-07-21T10:15:00.000Z',
    sessionId: 'sess-1',
    requestId: opts.requestId ?? 'req-' + opts.id,
    message: { id: opts.id, model: opts.model ?? 'claude-fable-5', usage }
  }
  if (opts.sidechain !== undefined) line.isSidechain = opts.sidechain
  if (opts.costUSD !== undefined) line.costUSD = opts.costUSD
  return JSON.stringify(line) + '\n'
}

function sumBuckets(buckets: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }>): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
} {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
  for (const b of Object.values(buckets)) {
    total.inputTokens += b.inputTokens
    total.outputTokens += b.outputTokens
    total.cacheReadTokens += b.cacheReadTokens
    total.cacheWriteTokens += b.cacheWriteTokens
    total.costUsd += b.costUsd
  }
  return total
}

describe('parseClaudeSessionIncrement', () => {
  it('sums assistant usage into per-model per-hour buckets with cost', async () => {
    const f = join(dir, 's.jsonl')
    writeFileSync(
      f,
      '{"type":"user","message":{"role":"user","content":"hi"}}\n' +
        entry({ id: 'm1', input: 100, output: 50, cacheRead: 1000, cache5m: 200, cache1h: 300, ts: '2026-07-21T10:05:00Z' }) +
        entry({ id: 'm2', input: 10, output: 20, ts: '2026-07-21T11:59:59Z' })
    )
    const { buckets } = await parseClaudeSessionIncrement([f], null)
    expect(Object.keys(buckets).sort()).toEqual([
      'claude-fable-5|2026-07-21T10:00:00.000Z',
      'claude-fable-5|2026-07-21T11:00:00.000Z'
    ])
    const b10 = buckets['claude-fable-5|2026-07-21T10:00:00.000Z']
    expect(b10.inputTokens).toBe(100)
    expect(b10.outputTokens).toBe(50)
    expect(b10.cacheReadTokens).toBe(1000)
    expect(b10.cacheWriteTokens).toBe(500)
    expect(b10.costUsd).toBeCloseTo(100 * IN + 50 * OUT + 1000 * READ + 200 * C5M + 300 * C1H, 10)
  })

  it('dedupes identical (message.id, requestId) pairs', async () => {
    const f = join(dir, 's.jsonl')
    const e = entry({ id: 'm1', requestId: 'r1', input: 100, output: 10 })
    writeFileSync(f, e + e + e)
    const { buckets } = await parseClaudeSessionIncrement([f], null)
    expect(sumBuckets(buckets).inputTokens).toBe(100)
  })

  it('replaces an entry when a re-log with larger usage arrives (streaming)', async () => {
    const f = join(dir, 's.jsonl')
    writeFileSync(
      f,
      entry({ id: 'm1', requestId: 'r1', input: 100, output: 10 }) +
        entry({ id: 'm1', requestId: 'r1', input: 100, output: 400 })
    )
    const { buckets } = await parseClaudeSessionIncrement([f], null)
    const total = sumBuckets(buckets)
    expect(total.inputTokens).toBe(100)
    expect(total.outputTokens).toBe(400)
  })

  it('dedupes sidechain replays of the same message id under a new requestId', async () => {
    const main = join(dir, 's.jsonl')
    writeFileSync(main, entry({ id: 'm1', requestId: 'r1', input: 500, output: 100 }))
    const sub = join(dir, 'sub.jsonl')
    writeFileSync(sub, entry({ id: 'm1', requestId: 'r2-replay', input: 500, output: 100, sidechain: true }))
    const { buckets } = await parseClaudeSessionIncrement([main, sub], null)
    const total = sumBuckets(buckets)
    expect(total.inputTokens).toBe(500)
    expect(total.outputTokens).toBe(100)
  })

  it('incremental parse across appends equals one-shot parse', async () => {
    const f = join(dir, 's.jsonl')
    const part1 = entry({ id: 'm1', input: 10, output: 1 }) + entry({ id: 'm2', input: 20, output: 2 })
    const part2 = entry({ id: 'm3', input: 30, output: 3 }) + entry({ id: 'm1', input: 10, output: 99 })
    writeFileSync(f, part1)
    const r1 = await parseClaudeSessionIncrement([f], null)
    appendFileSync(f, part2)
    const r2 = await parseClaudeSessionIncrement([f], r1.state)

    const oneShot = await parseClaudeSessionIncrement([f], null)
    expect(r2.buckets).toEqual(oneShot.buckets)
    expect(sumBuckets(r2.buckets).outputTokens).toBe(2 + 3 + 99)
  })

  it('does not consume a torn trailing line, then picks it up once completed', async () => {
    const f = join(dir, 's.jsonl')
    const full = entry({ id: 'm1', input: 10, output: 1 })
    const torn = entry({ id: 'm2', input: 20, output: 2 })
    writeFileSync(f, full + torn.slice(0, 25))
    const r1 = await parseClaudeSessionIncrement([f], null)
    expect(sumBuckets(r1.buckets).inputTokens).toBe(10)
    appendFileSync(f, torn.slice(25))
    const r2 = await parseClaudeSessionIncrement([f], r1.state)
    expect(sumBuckets(r2.buckets).inputTokens).toBe(30)
  })

  it('falls back to a full reparse when a file shrinks below its cursor', async () => {
    const f = join(dir, 's.jsonl')
    writeFileSync(f, entry({ id: 'm1', input: 10, output: 1 }) + entry({ id: 'm2', input: 20, output: 2 }))
    const r1 = await parseClaudeSessionIncrement([f], null)
    expect(sumBuckets(r1.buckets).inputTokens).toBe(30)
    // Rewrite the file smaller (e.g. compaction/replacement)
    truncateSync(f, 0)
    writeFileSync(f, entry({ id: 'm9', input: 7, output: 7 }))
    const r2 = await parseClaudeSessionIncrement([f], r1.state)
    expect(sumBuckets(r2.buckets).inputTokens).toBe(7)
  })

  it('honors embedded costUSD over computed cost', async () => {
    const f = join(dir, 's.jsonl')
    writeFileSync(f, entry({ id: 'm1', input: 1000000, output: 0, costUSD: 1.23 }))
    const { buckets } = await parseClaudeSessionIncrement([f], null)
    expect(sumBuckets(buckets).costUsd).toBeCloseTo(1.23, 10)
  })

  it('counts synthetic-model tokens with zero cost', async () => {
    const f = join(dir, 's.jsonl')
    writeFileSync(f, entry({ id: 'm1', model: '<synthetic>', input: 55, output: 44 }))
    const { buckets } = await parseClaudeSessionIncrement([f], null)
    const total = sumBuckets(buckets)
    expect(total.inputTokens).toBe(55)
    expect(total.costUsd).toBe(0)
  })

  it('picks up a subagent file that appears between increments', async () => {
    const main = join(dir, 's.jsonl')
    writeFileSync(main, entry({ id: 'm1', input: 10, output: 1 }))
    const r1 = await parseClaudeSessionIncrement([main], null)
    const sub = join(dir, 'agent-1.jsonl')
    writeFileSync(sub, entry({ id: 'a1', input: 40, output: 4, sidechain: true }))
    const r2 = await parseClaudeSessionIncrement([main, sub], r1.state)
    expect(sumBuckets(r2.buckets).inputTokens).toBe(50)
  })

  it('handles a missing file gracefully (session not materialized yet)', async () => {
    const missing = join(dir, 'nope.jsonl')
    const r = await parseClaudeSessionIncrement([missing], null)
    expect(r.buckets).toEqual({})
  })

  it('attributes a resumed giant session’s new prompt to its own hour, leaving prior days untouched (ccusage-style date bucketing)', async () => {
    const f = join(dir, 's.jsonl')
    // A large session with activity spread across two "yesterday" hours.
    let giant = ''
    for (let i = 0; i < 50; i++) {
      giant += entry({ id: `y1-${i}`, input: 100, output: 10, ts: '2026-07-20T09:10:00Z' })
      giant += entry({ id: `y2-${i}`, input: 200, output: 20, ts: '2026-07-20T15:45:00Z' })
    }
    writeFileSync(f, giant)
    const r1 = await parseClaudeSessionIncrement([f], null)
    const yesterday9 = { ...r1.buckets['claude-fable-5|2026-07-20T09:00:00.000Z'] }
    const yesterday15 = { ...r1.buckets['claude-fable-5|2026-07-20T15:00:00.000Z'] }
    expect(yesterday9.inputTokens).toBe(5000)
    expect(yesterday15.inputTokens).toBe(10000)

    // Resume the session "today" with a single prompt.
    appendFileSync(f, entry({ id: 'today-1', input: 7, output: 3, ts: '2026-07-21T08:05:00Z' }))
    const r2 = await parseClaudeSessionIncrement([f], r1.state)

    // Yesterday's buckets are byte-identical — the resume adds ONLY a new
    // bucket under today's hour, so date-ranged dashboards attribute the new
    // prompt to today and nothing to yesterday.
    expect(r2.buckets['claude-fable-5|2026-07-20T09:00:00.000Z']).toEqual(yesterday9)
    expect(r2.buckets['claude-fable-5|2026-07-20T15:00:00.000Z']).toEqual(yesterday15)
    expect(r2.buckets['claude-fable-5|2026-07-21T08:00:00.000Z']).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 7 * IN + 3 * OUT
    })
    expect(Object.keys(r2.buckets)).toHaveLength(3)
  })

  it('serializes state through JSON round-trip', async () => {
    const f = join(dir, 's.jsonl')
    writeFileSync(f, entry({ id: 'm1', input: 10, output: 1 }))
    const r1 = await parseClaudeSessionIncrement([f], null)
    const roundTripped = JSON.parse(JSON.stringify(r1.state)) as ClaudeSessionState
    appendFileSync(f, entry({ id: 'm2', input: 20, output: 2 }))
    const r2 = await parseClaudeSessionIncrement([f], roundTripped)
    expect(sumBuckets(r2.buckets).inputTokens).toBe(30)
  })
})
