import type { ClaudeTokenTally } from '@shared/types/usage'

/**
 * Burn-rate predictor for auto account switching.
 *
 * The usage endpoint can only be polled every few minutes, but a heavy
 * multi-session run (subagent fan-outs) can burn from below an armed switch
 * threshold to 100% inside a single polling gap — the sessions die before the
 * switcher ever sees a percent at/over the threshold. This module estimates
 * the CURRENT utilization between polls from on-disk transcript token tallies:
 *
 *  - every usage fetch anchors (percent, diskTokens) pairs;
 *  - consecutive fetch anchors calibrate percent-per-token;
 *  - between fetches, the estimate is anchorPercent + tokensSince × ratio,
 *    extrapolated forward by the recent token slope.
 *
 * The estimate is deliberately never trusted to switch accounts — it only
 * decides "pull a REAL usage sample early" (floored at 30s), and the real
 * sample drives the switch. All functions are pure over PredictorState so the
 * math is unit-testable apart from the runner.
 */

/**
 * Rough per-token weights toward Anthropic's utilization accounting, mirroring
 * pricing ratios (output ≫ input ≫ cache reads). Calibration absorbs any
 * absolute scale error; the weights only reduce estimate drift when the
 * input/output/cache mix shifts between calibration and prediction.
 */
export const TOKEN_WEIGHTS = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheWrite: 1.25
} as const

export function weightedTokens(
  tally: Pick<
    ClaudeTokenTally,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
  >
): number {
  return (
    tally.inputTokens * TOKEN_WEIGHTS.input +
    tally.outputTokens * TOKEN_WEIGHTS.output +
    tally.cacheReadTokens * TOKEN_WEIGHTS.cacheRead +
    tally.cacheWriteTokens * TOKEN_WEIGHTS.cacheWrite
  )
}

export interface TallySample {
  at: number
  weighted: number
}

export interface UsageAnchor {
  /** Active utilization percent at anchor time. */
  percent: number
  /** Weighted disk-token tally at anchor time. */
  weighted: number
  at: number
  /**
   * True when the anchor came from a real usage fetch (calibration quality);
   * false for seeded/mirrored usage (e.g. post-switch seeding) — such anchors
   * re-baseline the estimate but never feed calibration.
   */
  fromFetch: boolean
}

export interface PredictorState {
  anchor: UsageAnchor | null
  /** EMA-smoothed percent-per-weighted-token calibration; null until known. */
  pointsPerToken: number | null
  samples: TallySample[]
}

export function createPredictorState(): PredictorState {
  return { anchor: null, pointsPerToken: null, samples: [] }
}

export function resetPredictorState(state: PredictorState): void {
  state.anchor = null
  state.pointsPerToken = null
  state.samples = []
}

/** Keep only samples inside the slope window. */
const SAMPLE_WINDOW_MS = 5 * 60_000
/** Minimum weighted-token delta between anchors for a trustworthy ratio. */
const MIN_CALIBRATION_TOKENS = 100_000
/** Percent delta bounds for calibration: tiny deltas are noise, huge ones
 * usually mean a window reset or account switch slipped through. */
const MIN_CALIBRATION_PERCENT = 0.5
const MAX_CALIBRATION_PERCENT = 40
const CALIBRATION_EMA_ALPHA = 0.5
/** Slope needs at least this much time between first/last sample. */
const MIN_SLOPE_SPAN_MS = 20_000

export function recordTallySample(state: PredictorState, sample: TallySample): void {
  const last = state.samples[state.samples.length - 1]
  // A drop means sessions aged out of the tally window (or state reset) —
  // old samples/anchors are no longer comparable to the new baseline.
  if (last && sample.weighted < last.weighted) {
    state.samples = []
    if (state.anchor) state.anchor = { ...state.anchor, weighted: sample.weighted, at: sample.at }
  }
  state.samples.push(sample)
  state.samples = state.samples.filter((s) => sample.at - s.at <= SAMPLE_WINDOW_MS)
}

/**
 * Re-baseline on fresh usage data. When both this and the previous anchor came
 * from real fetches and the deltas are sane, also update the
 * percent-per-token calibration.
 */
export function recordAnchor(
  state: PredictorState,
  anchor: { percent: number; weighted: number; at: number },
  opts: { fromFetch: boolean }
): void {
  const previous = state.anchor
  if (opts.fromFetch && previous?.fromFetch) {
    const tokenDelta = anchor.weighted - previous.weighted
    const percentDelta = anchor.percent - previous.percent
    if (
      tokenDelta >= MIN_CALIBRATION_TOKENS &&
      percentDelta >= MIN_CALIBRATION_PERCENT &&
      percentDelta <= MAX_CALIBRATION_PERCENT
    ) {
      const ratio = percentDelta / tokenDelta
      state.pointsPerToken =
        state.pointsPerToken === null
          ? ratio
          : state.pointsPerToken * (1 - CALIBRATION_EMA_ALPHA) + ratio * CALIBRATION_EMA_ALPHA
    }
  }
  state.anchor = { ...anchor, fromFetch: opts.fromFetch }
  // Burn before the anchor is already reflected in the anchored percent —
  // keeping older samples would let a past burst inflate the forward slope
  // long after the burn has flattened out.
  state.samples = state.samples.filter((s) => s.at >= anchor.at)
}

/** Weighted tokens per ms over the recent sample window, or null. */
export function tokenSlopePerMs(state: PredictorState): number | null {
  if (state.samples.length < 2) return null
  const first = state.samples[0]
  const last = state.samples[state.samples.length - 1]
  const span = last.at - first.at
  if (span < MIN_SLOPE_SPAN_MS) return null
  return (last.weighted - first.weighted) / span
}

/**
 * Estimated utilization percent at time `at` (>= the latest sample), or null
 * when the predictor lacks an anchor, calibration, or samples.
 */
export function predictPercentAt(state: PredictorState, at: number): number | null {
  if (!state.anchor || state.pointsPerToken === null || state.samples.length === 0) return null
  const latest = state.samples[state.samples.length - 1]
  const base =
    state.anchor.percent + (latest.weighted - state.anchor.weighted) * state.pointsPerToken
  const slope = tokenSlopePerMs(state)
  const projectedMs = Math.max(0, at - latest.at)
  const projected = slope === null ? base : base + slope * projectedMs * state.pointsPerToken
  return Math.min(150, projected)
}

/**
 * True when the estimate says utilization will be at/over the armed threshold
 * by the time the next scheduled usage refresh would land — i.e. waiting for
 * that refresh risks sailing past the threshold unseen, so a real sample
 * should be pulled now.
 */
export function shouldRefreshEarly(
  state: PredictorState,
  args: { thresholdPercent: number; nextScheduledRefreshAt: number }
): boolean {
  const predicted = predictPercentAt(state, args.nextScheduledRefreshAt)
  return predicted !== null && predicted >= args.thresholdPercent
}
