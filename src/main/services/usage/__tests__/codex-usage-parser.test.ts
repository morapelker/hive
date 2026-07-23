import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseCodexRolloutIncrement, type CodexFileState } from '../codex-usage-parser'
import { setModelPricingTable, type RawPricingTable } from '../pricing'
import pricingFixture from './model-pricing-fixture.json'

// The runtime table comes from Hive Enterprise; tests load a LiteLLM snapshot
// fixture directly.
setModelPricingTable(pricingFixture as RawPricingTable)

// gpt-5.6-sol rates from the snapshot fixture:
const IN = 5e-6
const OUT = 3e-5
const READ = 5e-7

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-usage-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function turnContext(model: string, ts = '2026-07-21T10:00:01.000Z'): string {
  return JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { model } }) + '\n'
}

interface Totals {
  input: number
  cached: number
  output: number
  reasoning?: number
}

function tokenCount(opts: { ts: string; last?: Totals | null; total: Totals }): string {
  const mk = (t: Totals): Record<string, number> => ({
    input_tokens: t.input,
    cached_input_tokens: t.cached,
    output_tokens: t.output,
    reasoning_output_tokens: t.reasoning ?? 0,
    total_tokens: t.input + t.output
  })
  const info: Record<string, unknown> = { total_token_usage: mk(opts.total) }
  if (opts.last !== null) info.last_token_usage = mk(opts.last ?? opts.total)
  return (
    JSON.stringify({
      timestamp: opts.ts,
      type: 'event_msg',
      payload: { type: 'token_count', info }
    }) + '\n'
  )
}

function sum(buckets: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }>): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
} {
  const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
  for (const b of Object.values(buckets)) {
    t.inputTokens += b.inputTokens
    t.outputTokens += b.outputTokens
    t.cacheReadTokens += b.cacheReadTokens
    t.cacheWriteTokens += b.cacheWriteTokens
    t.costUsd += b.costUsd
  }
  return t
}

describe('parseCodexRolloutIncrement', () => {
  it('reports changed=false when no new bytes were consumed', async () => {
    const f = join(dir, 'rollout.jsonl')
    writeFileSync(
      f,
      turnContext('gpt-5.6-sol') +
        tokenCount({ ts: '2026-07-21T10:00:10Z', total: { input: 100, cached: 0, output: 5 } })
    )
    const r1 = await parseCodexRolloutIncrement(f, null)
    expect(r1.changed).toBe(true)

    const r2 = await parseCodexRolloutIncrement(f, JSON.parse(JSON.stringify(r1.state)) as CodexFileState)
    expect(r2.changed).toBe(false)

    appendFileSync(f, tokenCount({ ts: '2026-07-21T10:00:20Z', total: { input: 200, cached: 0, output: 9 } }))
    const r3 = await parseCodexRolloutIncrement(f, r2.state)
    expect(r3.changed).toBe(true)
  })

  it('sums last_token_usage deltas, splitting cached input into cacheRead', async () => {
    const f = join(dir, 'rollout.jsonl')
    writeFileSync(
      f,
      turnContext('gpt-5.6-sol') +
        tokenCount({ ts: '2026-07-21T10:00:10Z', last: { input: 1000, cached: 600, output: 50 }, total: { input: 1000, cached: 600, output: 50 } }) +
        tokenCount({ ts: '2026-07-21T10:05:00Z', last: { input: 2000, cached: 1500, output: 70 }, total: { input: 3000, cached: 2100, output: 120 } })
    )
    const { buckets } = await parseCodexRolloutIncrement(f, null)
    const t = sum(buckets)
    // input reported net of cached
    expect(t.inputTokens).toBe(1000 - 600 + (2000 - 1500))
    expect(t.cacheReadTokens).toBe(600 + 1500)
    expect(t.outputTokens).toBe(50 + 70)
    expect(t.cacheWriteTokens).toBe(0)
    expect(t.costUsd).toBeCloseTo((400 + 500) * IN + (600 + 1500) * READ + 120 * OUT, 10)
    expect(Object.keys(buckets)).toEqual(['gpt-5.6-sol|2026-07-21T10:00:00.000Z'])
  })

  it('computes deltas from cumulative totals when last_token_usage is absent', async () => {
    const f = join(dir, 'rollout.jsonl')
    writeFileSync(
      f,
      turnContext('gpt-5.6-sol') +
        tokenCount({ ts: '2026-07-21T10:00:10Z', last: null, total: { input: 1000, cached: 600, output: 50 } }) +
        tokenCount({ ts: '2026-07-21T10:05:00Z', last: null, total: { input: 3000, cached: 2100, output: 120 } })
    )
    const { buckets } = await parseCodexRolloutIncrement(f, null)
    const t = sum(buckets)
    expect(t.inputTokens).toBe(3000 - 2100)
    expect(t.cacheReadTokens).toBe(2100)
    expect(t.outputTokens).toBe(120)
  })

  it('keeps model attribution across an offset resume', async () => {
    const f = join(dir, 'rollout.jsonl')
    writeFileSync(
      f,
      turnContext('gpt-5.6-sol') +
        tokenCount({ ts: '2026-07-21T10:00:10Z', last: { input: 100, cached: 0, output: 10 }, total: { input: 100, cached: 0, output: 10 } })
    )
    const r1 = await parseCodexRolloutIncrement(f, null)
    appendFileSync(
      f,
      tokenCount({ ts: '2026-07-21T10:20:00Z', last: { input: 200, cached: 0, output: 20 }, total: { input: 300, cached: 0, output: 30 } })
    )
    const r2 = await parseCodexRolloutIncrement(f, JSON.parse(JSON.stringify(r1.state)) as CodexFileState)
    expect(Object.keys(r2.buckets).every((k) => k.startsWith('gpt-5.6-sol|'))).toBe(true)
    expect(sum(r2.buckets).inputTokens).toBe(300)
  })

  it('incremental parse equals one-shot parse', async () => {
    const f = join(dir, 'rollout.jsonl')
    const part1 =
      turnContext('gpt-5.6-sol') +
      tokenCount({ ts: '2026-07-21T10:00:10Z', last: { input: 100, cached: 40, output: 10 }, total: { input: 100, cached: 40, output: 10 } })
    const part2 = tokenCount({
      ts: '2026-07-21T11:00:10Z',
      last: null,
      total: { input: 350, cached: 200, output: 45 }
    })
    writeFileSync(f, part1)
    const r1 = await parseCodexRolloutIncrement(f, null)
    appendFileSync(f, part2)
    const r2 = await parseCodexRolloutIncrement(f, r1.state)
    const oneShot = await parseCodexRolloutIncrement(f, null)
    expect(r2.buckets).toEqual(oneShot.buckets)
  })

  it('skips forked-session replay events in the head same-second burst but seeds totals', async () => {
    const f = join(dir, 'rollout.jsonl')
    writeFileSync(
      f,
      JSON.stringify({
        timestamp: '2026-07-21T09:59:59Z',
        type: 'session_meta',
        payload: { forked_from_id: 'parent-123' }
      }) +
        '\n' +
        turnContext('gpt-5.6-sol') +
        // replayed history: two token_counts in the same second
        tokenCount({ ts: '2026-07-21T10:00:00Z', last: { input: 500, cached: 0, output: 50 }, total: { input: 500, cached: 0, output: 50 } }) +
        tokenCount({ ts: '2026-07-21T10:00:00Z', last: { input: 700, cached: 0, output: 70 }, total: { input: 1200, cached: 0, output: 120 } }) +
        // genuine new turn
        tokenCount({ ts: '2026-07-21T10:03:00Z', last: null, total: { input: 1500, cached: 0, output: 150 } })
    )
    const { buckets } = await parseCodexRolloutIncrement(f, null)
    const t = sum(buckets)
    expect(t.inputTokens).toBe(300)
    expect(t.outputTokens).toBe(30)
  })

  it('resets and reparses when the file shrinks below the cursor', async () => {
    const f = join(dir, 'rollout.jsonl')
    writeFileSync(
      f,
      turnContext('gpt-5.6-sol') +
        tokenCount({ ts: '2026-07-21T10:00:10Z', last: { input: 100, cached: 0, output: 10 }, total: { input: 100, cached: 0, output: 10 } })
    )
    const r1 = await parseCodexRolloutIncrement(f, null)
    writeFileSync(
      f,
      turnContext('gpt-5.6-sol') + tokenCount({ ts: '2026-07-21T10:00:10Z', last: { input: 7, cached: 0, output: 7 }, total: { input: 7, cached: 0, output: 7 } })
    )
    const r2 = await parseCodexRolloutIncrement(f, r1.state)
    expect(sum(r2.buckets).inputTokens).toBe(7)
  })

  it('skips all-zero deltas and missing files', async () => {
    const f = join(dir, 'rollout.jsonl')
    writeFileSync(
      f,
      turnContext('gpt-5.6-sol') +
        tokenCount({ ts: '2026-07-21T10:00:10Z', last: { input: 0, cached: 0, output: 0 }, total: { input: 0, cached: 0, output: 0 } })
    )
    const r = await parseCodexRolloutIncrement(f, null)
    expect(r.buckets).toEqual({})
    const missing = await parseCodexRolloutIncrement(join(dir, 'nope.jsonl'), null)
    expect(missing.buckets).toEqual({})
  })
})
