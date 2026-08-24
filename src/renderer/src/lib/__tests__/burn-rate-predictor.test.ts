import { describe, expect, it } from 'vitest'

import {
  createPredictorState,
  predictPercentAt,
  recordAnchor,
  recordTallySample,
  resetPredictorState,
  shouldRefreshEarly,
  tokenSlopePerMs,
  weightedTokens,
  TOKEN_WEIGHTS
} from '../burn-rate-predictor'

const T0 = 1_800_000_000_000

function calibrated(): ReturnType<typeof createPredictorState> {
  // Two fetch anchors 5 points / 2M weighted tokens apart → 2.5e-6 pts/token.
  const state = createPredictorState()
  recordTallySample(state, { at: T0, weighted: 10_000_000 })
  recordAnchor(state, { percent: 80, weighted: 10_000_000, at: T0 }, { fromFetch: true })
  recordTallySample(state, { at: T0 + 120_000, weighted: 12_000_000 })
  recordAnchor(state, { percent: 85, weighted: 12_000_000, at: T0 + 120_000 }, { fromFetch: true })
  return state
}

describe('weightedTokens', () => {
  it('applies the pricing-ratio weights per component', () => {
    expect(
      weightedTokens({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 40
      })
    ).toBe(
      100 * TOKEN_WEIGHTS.input +
        10 * TOKEN_WEIGHTS.output +
        1_000 * TOKEN_WEIGHTS.cacheRead +
        40 * TOKEN_WEIGHTS.cacheWrite
    )
  })
})

describe('calibration via recordAnchor', () => {
  it('learns percent-per-token from two consecutive fetch anchors', () => {
    const state = calibrated()
    expect(state.pointsPerToken).toBeCloseTo(5 / 2_000_000)
  })

  it('does not calibrate from a seeded (non-fetch) anchor on either side', () => {
    const state = createPredictorState()
    recordAnchor(state, { percent: 80, weighted: 10_000_000, at: T0 }, { fromFetch: true })
    // Post-switch seed re-baselines but must not feed calibration…
    recordAnchor(state, { percent: 20, weighted: 12_000_000, at: T0 + 60_000 }, { fromFetch: false })
    expect(state.pointsPerToken).toBeNull()
    // …and the next real fetch calibrating against the seed anchor is fine
    // only when the seed itself was a fetch — it wasn't, so still null.
    recordAnchor(state, { percent: 25, weighted: 14_000_000, at: T0 + 120_000 }, { fromFetch: true })
    expect(state.pointsPerToken).toBeNull()
  })

  it('clears calibration on a seed anchor — the ratio belongs to the previous account', () => {
    const state = calibrated()
    expect(state.pointsPerToken).not.toBeNull()
    recordAnchor(state, { percent: 20, weighted: 13_000_000, at: T0 + 180_000 }, { fromFetch: false })
    expect(state.pointsPerToken).toBeNull()
  })

  it('rejects percent deltas that are negative, tiny, or implausibly large', () => {
    for (const delta of [-5, 0.2, 60]) {
      const state = createPredictorState()
      recordAnchor(state, { percent: 50, weighted: 10_000_000, at: T0 }, { fromFetch: true })
      recordAnchor(
        state,
        { percent: 50 + delta, weighted: 12_000_000, at: T0 + 120_000 },
        { fromFetch: true }
      )
      expect(state.pointsPerToken).toBeNull()
    }
  })

  it('rejects token deltas too small to be trustworthy', () => {
    const state = createPredictorState()
    recordAnchor(state, { percent: 50, weighted: 10_000_000, at: T0 }, { fromFetch: true })
    recordAnchor(state, { percent: 55, weighted: 10_050_000, at: T0 + 120_000 }, { fromFetch: true })
    expect(state.pointsPerToken).toBeNull()
  })

  it('EMA-smooths subsequent ratios', () => {
    const state = calibrated() // 2.5e-6
    recordAnchor(
      state,
      // +5 points over 1M tokens → instantaneous ratio 5e-6
      { percent: 90, weighted: 13_000_000, at: T0 + 240_000 },
      { fromFetch: true }
    )
    expect(state.pointsPerToken).toBeCloseTo((2.5e-6 + 5e-6) / 2)
  })
})

describe('prediction', () => {
  it('returns null without an anchor, calibration, or samples', () => {
    const state = createPredictorState()
    expect(predictPercentAt(state, T0)).toBeNull()
    recordTallySample(state, { at: T0, weighted: 1_000_000 })
    expect(predictPercentAt(state, T0)).toBeNull()
  })

  it('estimates current percent from tokens burned since the anchor', () => {
    const state = calibrated() // anchored at 85% / 12M
    recordTallySample(state, { at: T0 + 150_000, weighted: 13_000_000 })
    // +1M tokens × 2.5e-6 = +2.5 points
    expect(predictPercentAt(state, T0 + 150_000)).toBeCloseTo(87.5)
  })

  it('extrapolates forward using the post-anchor token slope only', () => {
    const state = calibrated()
    recordTallySample(state, { at: T0 + 150_000, weighted: 13_000_000 })
    recordTallySample(state, { at: T0 + 180_000, weighted: 14_000_000 })
    // Pre-anchor samples were dropped at anchor time: slope spans the
    // anchor's sample (T0+120s, 12M) to the latest (T0+180s, 14M).
    const slope = tokenSlopePerMs(state)
    expect(slope).toBeCloseTo(2_000_000 / 60_000)
    // Base at latest sample: 85 + 2M×2.5e-6 = 90; +60s of slope = +5 pts.
    expect(predictPercentAt(state, T0 + 240_000)).toBeCloseTo(90 + slope! * 60_000 * 2.5e-6)
  })

  it('re-baselines when the tally drops (sessions aged out of the window)', () => {
    const state = calibrated()
    recordTallySample(state, { at: T0 + 150_000, weighted: 5_000_000 })
    // Anchor tokens snapped to the new baseline: estimate = anchor percent.
    expect(predictPercentAt(state, T0 + 150_000)).toBeCloseTo(85)
    expect(state.samples).toHaveLength(1)
  })
})

describe('shouldRefreshEarly', () => {
  it('fires when the estimate crosses the threshold before the next scheduled refresh', () => {
    const state = calibrated()
    recordTallySample(state, { at: T0 + 150_000, weighted: 13_000_000 }) // est ≈ 87.5 now
    recordTallySample(state, { at: T0 + 180_000, weighted: 14_000_000 }) // est = 90 now
    expect(
      shouldRefreshEarly(state, { thresholdPercent: 90, nextScheduledRefreshAt: T0 + 180_000 })
    ).toBe(true)
  })

  it('stays quiet while the projection remains below the threshold', () => {
    const state = calibrated()
    recordTallySample(state, { at: T0 + 150_000, weighted: 12_100_000 }) // est ≈ 85.25, slow burn
    expect(
      shouldRefreshEarly(state, { thresholdPercent: 90, nextScheduledRefreshAt: T0 + 210_000 })
    ).toBe(false)
  })

  it('never fires without calibration', () => {
    const state = createPredictorState()
    recordAnchor(state, { percent: 89, weighted: 10_000_000, at: T0 }, { fromFetch: true })
    recordTallySample(state, { at: T0, weighted: 10_000_000 })
    recordTallySample(state, { at: T0 + 30_000, weighted: 99_000_000 })
    expect(
      shouldRefreshEarly(state, { thresholdPercent: 90, nextScheduledRefreshAt: T0 + 60_000 })
    ).toBe(false)
  })
})

describe('resetPredictorState', () => {
  it('clears anchor, calibration and samples', () => {
    const state = calibrated()
    resetPredictorState(state)
    expect(state.anchor).toBeNull()
    expect(state.pointsPerToken).toBeNull()
    expect(state.samples).toHaveLength(0)
  })
})
