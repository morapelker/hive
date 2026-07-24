import { open, stat } from 'fs/promises'
import { codexCostUsd } from './pricing'
import { bucketKey, emptyBucket, type BucketMap } from './claude-usage-parser'

/**
 * Incremental ccusage-style parser for Codex rollout files
 * (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl).
 *
 * token_count events are deltas (last_token_usage) or cumulative totals
 * (total_token_usage, older CLIs) — so unlike the Claude parser the buckets
 * accumulate inside the persisted state. Codex `input_tokens` INCLUDES cached
 * tokens; we report input−cached as input and cached as cacheRead. Forked
 * sessions replay parent history as a same-second burst of token_count events
 * at the head of the file; those are skipped (ccusage heuristic) while still
 * seeding the cumulative baseline.
 */

export interface CodexTotals {
  input: number
  cached: number
  output: number
  reasoning: number
  total: number
}

interface PendingHeadEvent {
  model: string
  hour: string
  second: string
  input: number
  cached: number
  output: number
}

export interface CodexFileState {
  offset: number
  size: number
  mtimeMs: number
  previousTotals: CodexTotals | null
  currentModel: string | null
  headChecked: boolean
  forkMarker: boolean
  firstSecond: string | null
  headResolved: boolean
  skipSecond: string | null
  pending: PendingHeadEvent[]
  buckets: BucketMap
}

const CODEX_FALLBACK_MODEL = 'gpt-5'
const HEAD_SCAN_BYTES = 16 * 1024

function freshState(): CodexFileState {
  return {
    offset: 0,
    size: 0,
    mtimeMs: 0,
    previousTotals: null,
    currentModel: null,
    headChecked: false,
    forkMarker: false,
    firstSecond: null,
    headResolved: false,
    skipSecond: null,
    pending: [],
    buckets: {}
  }
}

function aliasNumber(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

function parseTotals(value: unknown): CodexTotals | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const input = aliasNumber(record, ['input_tokens', 'prompt_tokens', 'input'])
  const cached = Math.min(
    aliasNumber(record, ['cached_input_tokens', 'cache_read_input_tokens', 'cached_tokens']),
    input
  )
  const output = aliasNumber(record, ['output_tokens', 'completion_tokens', 'output'])
  const reasoning = aliasNumber(record, ['reasoning_output_tokens', 'reasoning_tokens'])
  const total = aliasNumber(record, ['total_tokens']) || input + output + reasoning
  return { input, cached, output, reasoning, total }
}

function subtractTotals(current: CodexTotals, previous: CodexTotals | null): CodexTotals {
  if (!previous) return current
  return {
    input: Math.max(0, current.input - previous.input),
    cached: Math.max(0, current.cached - previous.cached),
    output: Math.max(0, current.output - previous.output),
    reasoning: Math.max(0, current.reasoning - previous.reasoning),
    total: Math.max(0, current.total - previous.total)
  }
}

function isZeroDelta(t: CodexTotals): boolean {
  return t.input === 0 && t.cached === 0 && t.output === 0 && t.reasoning === 0
}

function utcSecond(timestamp: string): string | null {
  const ms = Date.parse(timestamp)
  if (Number.isNaN(ms)) return null
  return new Date(Math.floor(ms / 1000) * 1000).toISOString()
}

function utcHour(timestamp: string): string | null {
  const ms = Date.parse(timestamp)
  if (Number.isNaN(ms)) return null
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString()
}

function addUsage(
  buckets: BucketMap,
  model: string,
  hour: string,
  input: number,
  cached: number,
  output: number
): void {
  const bucket = (buckets[bucketKey(model, hour)] ??= emptyBucket())
  bucket.inputTokens += Math.max(0, input - cached)
  bucket.cacheReadTokens += cached
  bucket.outputTokens += output
  bucket.costUsd += codexCostUsd(model, { input, cached, output })
}

async function readRange(filePath: string, from: number, to: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(to - from)
    const { bytesRead } = await handle.read(buffer, 0, to - from, from)
    return bytesRead === to - from ? buffer : buffer.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

function resolveModel(payload: Record<string, unknown>, info: Record<string, unknown>, state: CodexFileState): string {
  const candidates = [payload.model, info.model]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return state.currentModel ?? CODEX_FALLBACK_MODEL
}

function processTokenCount(state: CodexFileState, timestamp: string, payload: Record<string, unknown>): void {
  const info = (payload.info ?? {}) as Record<string, unknown>
  if (info === null || typeof info !== 'object') return

  const last = parseTotals(info.last_token_usage)
  const total = parseTotals(info.total_token_usage)
  if (!last && !total) return

  const delta = last ?? subtractTotals(total!, state.previousTotals)
  if (total) state.previousTotals = total

  const second = utcSecond(timestamp)
  const hour = utcHour(timestamp)
  if (!second || !hour) return
  if (isZeroDelta(delta)) return

  const model = resolveModel(payload, info, state)

  if (state.forkMarker && !state.headResolved) {
    if (state.firstSecond === null) {
      state.firstSecond = second
      state.pending.push({ model, hour, second, input: delta.input, cached: delta.cached, output: delta.output })
      return
    }
    if (second === state.firstSecond) {
      // Fork replay confirmed: drop the held burst, skip everything in that second.
      state.headResolved = true
      state.skipSecond = state.firstSecond
      state.pending = []
      return
    }
    // Not a replay — flush the held event and continue normally.
    state.headResolved = true
    for (const held of state.pending) addUsage(state.buckets, held.model, held.hour, held.input, held.cached, held.output)
    state.pending = []
  }

  if (state.skipSecond !== null && second === state.skipSecond) return

  addUsage(state.buckets, model, hour, delta.input, delta.cached, delta.output)
}

export async function parseCodexRolloutIncrement(
  filePath: string,
  state: CodexFileState | null
): Promise<{ state: CodexFileState; buckets: BucketMap; changed: boolean }> {
  const stored =
    state && typeof state === 'object' && state.buckets && typeof state.offset === 'number'
      ? state
      : null
  let changed = !stored
  let working: CodexFileState = stored
    ? {
        ...freshState(),
        ...stored,
        pending: Array.isArray(stored.pending) ? [...stored.pending] : [],
        buckets: { ...stored.buckets }
      }
    : freshState()

  let info
  try {
    info = await stat(filePath)
  } catch {
    return { state: working, buckets: working.buckets, changed }
  }

  if (info.size < working.offset) {
    working = freshState()
    changed = true
  }

  if (!working.headChecked && info.size > 0) {
    const head = await readRange(filePath, 0, Math.min(HEAD_SCAN_BYTES, info.size))
    if (head) {
      const headText = head.toString('utf-8')
      working.forkMarker = headText.includes('thread_spawn') || headText.includes('forked_from_id')
      working.headChecked = true
      changed = true
    }
  }

  if (info.size <= working.offset) {
    working.size = info.size
    working.mtimeMs = info.mtimeMs
    return { state: working, buckets: working.buckets, changed }
  }

  const buffer = await readRange(filePath, working.offset, info.size)
  if (!buffer) return { state: working, buckets: working.buckets, changed }

  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline < 0) {
    working.size = info.size
    working.mtimeMs = info.mtimeMs
    return { state: working, buckets: working.buckets, changed }
  }

  const chunk = buffer.subarray(0, lastNewline + 1)
  let lineStart = 0
  while (lineStart < chunk.length) {
    let lineEnd = chunk.indexOf(0x0a, lineStart)
    if (lineEnd < 0) lineEnd = chunk.length
    const line = chunk.subarray(lineStart, lineEnd).toString('utf-8')
    lineStart = lineEnd + 1

    if (!line.includes('"turn_context"') && !line.includes('"token_count"')) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    const payload = record.payload as Record<string, unknown> | undefined
    if (!payload || typeof payload !== 'object') continue

    if (record.type === 'turn_context') {
      const metadata = payload.metadata as Record<string, unknown> | undefined
      const model = [payload.model, payload.model_name, metadata?.model].find(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
      if (model) working.currentModel = model
      continue
    }

    if (record.type === 'event_msg' && payload.type === 'token_count') {
      const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null
      if (!timestamp) continue
      processTokenCount(working, timestamp, payload)
    }
  }

  working.offset = working.offset + lastNewline + 1
  working.size = info.size
  working.mtimeMs = info.mtimeMs
  return { state: working, buckets: working.buckets, changed: true }
}
