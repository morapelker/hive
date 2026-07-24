import { createHash } from 'crypto'
import { createLogger } from '../logger'

const log = createLogger({ component: 'UsagePricing' })

let tableRevision = ''

/**
 * Model pricing resolved from the server-provided LiteLLM price table. The
 * client bundles NO prices: the table is fetched from Hive Enterprise (which
 * caches the outside LiteLLM source in MySQL) and loaded here via
 * setModelPricingTable before any cost is computed — see
 * model-pricing-loader.ts. All rates are USD per token.
 */
export interface ModelPricing {
  input: number
  output: number
  cacheCreation?: number
  cacheCreation1h?: number
  cacheRead?: number
  above?: {
    threshold: number
    input?: number
    output?: number
    cacheRead?: number
    cacheCreation?: number
  }
}

export interface ClaudeUsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheCreation5m: number
  cacheCreation1h: number
}

export interface CodexUsageTokens {
  input: number
  cached: number
  output: number
}

type RawEntry = Record<string, unknown>

/** LiteLLM-shaped price table: model key -> raw per-token rate fields. */
export type RawPricingTable = Record<string, RawEntry>

const ABOVE_FIELD_RE = /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/

function toModelPricing(entry: RawEntry): ModelPricing | null {
  const input = entry.input_cost_per_token
  const output = entry.output_cost_per_token
  if (typeof input !== 'number' || typeof output !== 'number') return null

  const pricing: ModelPricing = { input, output }
  if (typeof entry.cache_creation_input_token_cost === 'number') {
    pricing.cacheCreation = entry.cache_creation_input_token_cost
  }
  if (typeof entry.cache_creation_input_token_cost_above_1hr === 'number') {
    pricing.cacheCreation1h = entry.cache_creation_input_token_cost_above_1hr
  }
  if (typeof entry.cache_read_input_token_cost === 'number') {
    pricing.cacheRead = entry.cache_read_input_token_cost
  }

  for (const [key, value] of Object.entries(entry)) {
    const match = ABOVE_FIELD_RE.exec(key)
    if (!match || typeof value !== 'number') continue
    const threshold = Number(match[2]) * 1000
    if (!pricing.above || pricing.above.threshold !== threshold) {
      pricing.above = { threshold }
    }
    if (match[1] === 'input_cost_per_token') pricing.above.input = value
    else if (match[1] === 'output_cost_per_token') pricing.above.output = value
    else if (match[1] === 'cache_read_input_token_cost') pricing.above.cacheRead = value
    else pricing.above.cacheCreation = value
  }

  return pricing
}

let entries: Array<{ key: string; normalized: string; pricing: ModelPricing }> = []
const exactIndex = new Map<string, ModelPricing>()
const normalizedIndex = new Map<string, ModelPricing>()
let tableLoaded = false

/**
 * (Re)load the price table. Replaces any previously loaded table and clears
 * the per-model resolution caches.
 */
export function setModelPricingTable(rawPricing: RawPricingTable): void {
  entries = []
  exactIndex.clear()
  normalizedIndex.clear()
  findCache.clear()
  warnedModels.clear()
  for (const [key, raw] of Object.entries(rawPricing)) {
    if (raw === null || typeof raw !== 'object') continue
    const pricing = toModelPricing(raw)
    if (!pricing) continue
    const normalized = normalizeKey(key)
    entries.push({ key, normalized, pricing })
    exactIndex.set(key, pricing)
    if (!normalizedIndex.has(normalized)) normalizedIndex.set(normalized, pricing)
  }
  tableLoaded = entries.length > 0
  tableRevision = createHash('sha256').update(JSON.stringify(rawPricing)).digest('hex').slice(0, 16)
}

export function hasModelPricingTable(): boolean {
  return tableLoaded
}

/**
 * Fingerprint of the loaded table. Changes only when the server publishes
 * different price content — reports verified under an older revision must
 * re-price their totals.
 */
export function getModelPricingRevision(): string {
  return tableRevision
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[.@]/g, '-')
}

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9]/i.test(ch)
}

/**
 * ccusage-style boundary-aware containment: `needle` occurs in `hay` with
 * non-alphanumeric boundaries, and a trailing `-<digits>` continuation after a
 * digit-final needle is only allowed when the digit run is exactly 8 (an
 * Anthropic YYYYMMDD date suffix). This lets claude-sonnet-4-5 match
 * claude-sonnet-4-5-20250929 while claude-sonnet-4 does NOT match
 * claude-sonnet-4-5.
 */
function fuzzyContains(hay: string, needle: string): boolean {
  if (needle.length === 0) return false
  let from = 0
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from)
    if (idx < 0) return false
    from = idx + 1
    if (isAlnum(hay[idx - 1])) continue
    const rest = hay.slice(idx + needle.length)
    if (rest === '') return true
    if (isAlnum(rest[0])) continue
    if (/[0-9]$/.test(needle)) {
      const dateSuffix = /^-([0-9]+)/.exec(rest)
      if (dateSuffix) {
        const digits = dateSuffix[1]
        const afterDigits = rest.slice(1 + digits.length)
        if (digits.length !== 8) continue
        if (isAlnum(afterDigits[0])) continue
      }
    }
    return true
  }
  return false
}

const findCache = new Map<string, ModelPricing | null>()

export function findModelPricing(model: string): ModelPricing | null {
  const cached = findCache.get(model)
  if (cached !== undefined) return cached
  const result = findUncached(model)
  findCache.set(model, result)
  return result
}

function findUncached(model: string): ModelPricing | null {
  const trimmed = model.trim()
  if (trimmed.length === 0 || trimmed === '<synthetic>') return null

  const exact = exactIndex.get(trimmed)
  if (exact) return exact

  const normalized = normalizeKey(trimmed)
  const normalizedHit = normalizedIndex.get(normalized)
  if (normalizedHit) return normalizedHit

  let best: { key: string; pricing: ModelPricing } | null = null
  for (const entry of entries) {
    if (!fuzzyContains(normalized, entry.normalized) && !fuzzyContains(entry.normalized, normalized)) {
      continue
    }
    if (
      !best ||
      entry.key.length > best.key.length ||
      (entry.key.length === best.key.length && entry.key < best.key)
    ) {
      best = { key: entry.key, pricing: entry.pricing }
    }
  }
  return best?.pricing ?? null
}

const warnedModels = new Set<string>()

function warnMissingPricing(model: string): void {
  if (warnedModels.has(model)) return
  warnedModels.add(model)
  log.warn(`No pricing found for model "${model}" — its tokens will be recorded with cost 0`)
}

/** Marginal two-tier pricing: first `threshold` tokens at base, remainder at above. */
function tieredCost(tokens: number, base: number, above: number | undefined, threshold: number): number {
  if (above === undefined || tokens <= threshold) return tokens * base
  return threshold * base + (tokens - threshold) * above
}

/**
 * Anthropic pricing: input/output/cacheRead at their rates; 5m cache writes at
 * the cache-creation rate (default input×1.25); 1h cache writes at the
 * above_1hr rate (default input×2 — matches ccusage's multiplier).
 * LiteLLM above-200k tiers (older Sonnet entries) are applied marginally.
 */
export function claudeCostUsd(model: string, u: ClaudeUsageTokens): number {
  const p = findModelPricing(model)
  if (!p) {
    warnMissingPricing(model)
    return 0
  }
  const cacheWrite5m = p.cacheCreation ?? p.input * 1.25
  const cacheWrite1h = p.cacheCreation1h ?? p.input * 2
  const cacheRead = p.cacheRead ?? p.input * 0.1

  if (p.above) {
    const t = p.above.threshold
    return (
      tieredCost(u.input, p.input, p.above.input, t) +
      tieredCost(u.output, p.output, p.above.output, t) +
      tieredCost(u.cacheRead, cacheRead, p.above.cacheRead, t) +
      tieredCost(u.cacheCreation5m, cacheWrite5m, p.above.cacheCreation, t) +
      u.cacheCreation1h * cacheWrite1h
    )
  }

  return (
    u.input * p.input +
    u.output * p.output +
    u.cacheRead * cacheRead +
    u.cacheCreation5m * cacheWrite5m +
    u.cacheCreation1h * cacheWrite1h
  )
}

/**
 * OpenAI/Codex pricing: `input` INCLUDES cached tokens; cached tokens bill at
 * the cache-read rate (input rate when absent — matches ccusage), the rest at
 * the input rate. OpenAI long-context pricing is whole-request: when the
 * event's total input exceeds the threshold, every bucket uses the above rate.
 */
export function codexCostUsd(model: string, u: CodexUsageTokens): number {
  const p = findModelPricing(model)
  if (!p) {
    warnMissingPricing(model)
    return 0
  }
  const nonCached = Math.max(0, u.input - u.cached)
  const cached = Math.min(u.cached, u.input)
  const long = p.above !== undefined && u.input > p.above.threshold

  const inputRate = long && p.above!.input !== undefined ? p.above!.input : p.input
  const outputRate = long && p.above!.output !== undefined ? p.above!.output : p.output
  const baseCacheRead = p.cacheRead ?? p.input
  const cacheReadRate = long && p.above!.cacheRead !== undefined ? p.above!.cacheRead : baseCacheRead

  return nonCached * inputRate + cached * cacheReadRate + u.output * outputRate
}

export function __resetPricingCacheForTests(): void {
  findCache.clear()
  warnedModels.clear()
}
