import { useEffect } from 'react'
import { useAccountStore } from '@/stores/useAccountStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import {
  useUsageStore,
  resolveUsageProvider,
  USAGE_FETCH_DEBOUNCE_MS,
  EARLY_USAGE_REFRESH_FLOOR_MS
} from '@/stores/useUsageStore'
import {
  useAccountScheduleStore,
  getActiveUsagePercent,
  computeSweepExclusions
} from '@/stores/useAccountScheduleStore'
import {
  createPredictorState,
  recordAnchor,
  recordTallySample,
  resetPredictorState,
  shouldRefreshEarly,
  weightedTokens
} from '@/lib/burn-rate-predictor'
import { usageApi } from '@/api/usage-api'
import type { UsageProvider } from '@shared/types/usage'

const CHECK_INTERVAL_MS = 30_000
// While a session is actively running, keep usage fresh even when no prompt
// completes — long runs can burn through a window without ever going idle,
// and usage-based scheduled switches need current numbers to fire mid-session.
const SESSION_USAGE_REFRESH_MS = 5 * 60_000
// Once utilization gets within these margins of an armed usage-based switch
// threshold, a 5-minute sampling gap can blow far past the threshold before
// the switch fires — tighten to every 2 minutes in the last 10 points and
// every minute in the last 3 (still only while a session is running for the
// provider). These cadences override the store's 3-minute debounce (the
// runner passes them as the fetch's minIntervalMs) — they are real, not
// aspirational.
const NEAR_THRESHOLD_MARGIN_PERCENT = 10
const NEAR_THRESHOLD_REFRESH_MS = 2 * 60_000
const IMMINENT_THRESHOLD_MARGIN_PERCENT = 3
const IMMINENT_THRESHOLD_REFRESH_MS = 60_000

// Burn-rate predictor: within this margin of the armed threshold, poll the
// on-disk token tally each tick and estimate utilization between usage
// fetches; when the estimate says the threshold will be crossed before the
// next scheduled fetch, pull a real sample early (floored at
// EARLY_USAGE_REFRESH_FLOOR_MS so this can never hammer the endpoint).
const PREDICTOR_BAND_PERCENT = 15

// Auto-switch pre-warm: within the near-threshold margin, keep every viable
// candidate account's usage cache at most this old (the sweep skips rows
// fresher than this server-side), so the trigger-time sweep is a DB read
// instead of a serial network fetch right when the switch is urgent.
const PREWARM_MAX_AGE_MS = 150_000

/** Threshold of the armed usage-based switch (auto-switch or usage schedule), if any. */
function armedUsageThresholdPercent(provider: UsageProvider): number | null {
  const { autoSwitch, schedules } = useAccountScheduleStore.getState()
  const auto = autoSwitch[provider]
  if (auto) return auto.thresholdPercent
  const schedule = schedules[provider]
  if (schedule?.mode === 'usage') return schedule.thresholdPercent
  return null
}

function usageRefreshIntervalMs(provider: UsageProvider): number {
  const threshold = armedUsageThresholdPercent(provider)
  if (threshold === null) return SESSION_USAGE_REFRESH_MS
  const percent = getActiveUsagePercent(provider)
  if (percent === null || percent < threshold - NEAR_THRESHOLD_MARGIN_PERCENT) {
    return SESSION_USAGE_REFRESH_MS
  }
  if (percent >= threshold - IMMINENT_THRESHOLD_MARGIN_PERCENT) {
    return IMMINENT_THRESHOLD_REFRESH_MS
  }
  return NEAR_THRESHOLD_REFRESH_MS
}

function providersWithRunningSessions(): Set<UsageProvider> {
  const providers = new Set<UsageProvider>()
  const { sessionStatuses } = useWorktreeStatusStore.getState()
  const runningIds = Object.entries(sessionStatuses)
    .filter(([, entry]) => entry?.status === 'working' || entry?.status === 'planning')
    .map(([sessionId]) => sessionId)
  if (runningIds.length === 0) return providers

  const sessionStore = useSessionStore.getState()
  const allSessions = [
    ...[...sessionStore.sessionsByWorktree.values()].flat(),
    ...[...sessionStore.sessionsByConnection.values()].flat()
  ]
  for (const id of runningIds) {
    const session = allSessions.find((s) => s.id === id)
    if (session) providers.add(resolveUsageProvider(session))
  }
  return providers
}

// Failed fetches don't advance lastFetchedAt, so gate on our own attempt
// time too — otherwise a flaky network turns the 5-minute refresh into
// polling on every tick. Module scope so nextUsageRefreshAt can see it.
const lastAttemptAt: Partial<Record<UsageProvider, number>> = {}

/**
 * Mirrors fetchUsageForProvider's own gates (in-flight fetch; the full
 * debounce while an anthropic Retry-After is pending). Attempts that would
 * no-op must not advance lastAttemptAt: recording one postpones the NEXT
 * attempt by a whole interval, e.g. a 125s Retry-After hit at the 90s tick
 * would defer the sample to 210s instead of the first post-deadline tick.
 */
function fetchWouldNoOp(provider: UsageProvider, minIntervalMs: number): boolean {
  const usageStore = useUsageStore.getState()
  if (provider === 'anthropic') {
    if (usageStore.anthropicIsLoading) return true
    const floorMs =
      usageStore.anthropicLastRetryAfter !== null ? USAGE_FETCH_DEBOUNCE_MS : minIntervalMs
    return (
      usageStore.anthropicLastFetchedAt !== null &&
      Date.now() - usageStore.anthropicLastFetchedAt < floorMs
    )
  }
  if (usageStore.openaiIsLoading) return true
  return (
    usageStore.openaiLastFetchedAt !== null &&
    Date.now() - usageStore.openaiLastFetchedAt < minIntervalMs
  )
}

/**
 * When the runner will next fetch usage for `provider`, or null when no
 * refresh is scheduled (no running session for that provider). Mirrors the
 * tick's gating — interval since last fetch/attempt — floored by the store's
 * fetch debounce only when the cadence itself is slower than the debounce
 * (near/imminent cadences override it via minIntervalMs).
 */
export function nextUsageRefreshAt(provider: UsageProvider): number | null {
  if (!providersWithRunningSessions().has(provider)) return null
  const usageStore = useUsageStore.getState()
  const lastFetchedAt =
    provider === 'anthropic' ? usageStore.anthropicLastFetchedAt : usageStore.openaiLastFetchedAt
  const lastActivity = Math.max(lastFetchedAt ?? 0, lastAttemptAt[provider] ?? 0)
  const intervalMs = usageRefreshIntervalMs(provider)
  return Math.max(
    lastActivity + intervalMs,
    (lastFetchedAt ?? 0) + Math.min(USAGE_FETCH_DEBOUNCE_MS, intervalMs)
  )
}

// --- Burn-rate predictor state (anthropic only — disk tallies exist for
// Claude transcripts). Module scope: the runner is mounted once.
const predictor = createPredictorState()
let tallyInFlight = false
let lastAnchoredUsage: unknown = null
let lastSeenSwitchedAt: number | null = null

/** Test hook: predictor + attempt bookkeeping live at module scope. */
export function __resetAccountScheduleRunnerForTests(): void {
  resetPredictorState(predictor)
  tallyInFlight = false
  lastAnchoredUsage = null
  lastSeenSwitchedAt = null
  delete lastAttemptAt.anthropic
  delete lastAttemptAt.openai
}

async function maintainBurnRatePredictor(): Promise<void> {
  const threshold = armedUsageThresholdPercent('anthropic')
  if (threshold === null) {
    resetPredictorState(predictor)
    lastAnchoredUsage = null
    return
  }
  // Any account switch invalidates everything the predictor knows — the
  // anchor's percent and the calibration ratio describe the OLD account's
  // limits. Detect it via the switch timestamp rather than the seeded usage
  // object: a switch that happens while the predictor is idle can have its
  // seed replaced by the post-switch live refresh before any tick observes
  // it, which would silently carry the old calibration onto the new account.
  const switchedAt = useUsageStore.getState().anthropicAccountSwitchedAt
  if (switchedAt !== lastSeenSwitchedAt) {
    resetPredictorState(predictor)
    lastAnchoredUsage = null
    lastSeenSwitchedAt = switchedAt
  }

  if (!providersWithRunningSessions().has('anthropic')) return
  const percent = getActiveUsagePercent('anthropic')
  if (percent === null || percent < threshold - PREDICTOR_BAND_PERCENT) return
  if (tallyInFlight) return

  tallyInFlight = true
  let weighted: number
  try {
    weighted = weightedTokens(await usageApi.getClaudeTokenTally())
  } catch {
    return
  } finally {
    tallyInFlight = false
  }

  // A switch (and even its immediate live refresh) can complete while the
  // disk scan is pending — anchoring now would pair the new account's usage
  // with the old account's predictor state. Re-check and start clean.
  const switchedAfterScan = useUsageStore.getState().anthropicAccountSwitchedAt
  if (switchedAfterScan !== lastSeenSwitchedAt) {
    resetPredictorState(predictor)
    lastAnchoredUsage = null
    lastSeenSwitchedAt = switchedAfterScan
    return
  }

  const now = Date.now()
  recordTallySample(predictor, { at: now, weighted })

  // Fresh usage DATA landed since the last anchor (a successful fetch or a
  // post-switch seed replaced the usage object): re-baseline the estimate —
  // and calibrate percent-per-token only when the CURRENT usage object came
  // from a live fetch, which the store records as anthropicUsageFromFetch at
  // write time. Deliberately not inferred from history: a failed fetch's
  // retryAfter back-dates anthropicLastFetchedAt with no new data, and
  // fetches landing while the predictor is idle (below the band) would
  // desynchronize any counter the runner tried to keep — the flag rides on
  // the object itself, so a post-switch seed can never be mistaken for a
  // fetch no matter what happened in between.
  const usageStore = useUsageStore.getState()
  if (usageStore.anthropicUsage !== lastAnchoredUsage) {
    // Re-read the percent AFTER the tally await: a fetch completing during
    // the disk scan replaced the usage object, and anchoring the new object
    // at the pre-await percent would bake a stale baseline in for good
    // (lastAnchoredUsage advances, so the correct percent never anchors).
    const anchorPercent = getActiveUsagePercent('anthropic')
    if (anchorPercent !== null) {
      recordAnchor(
        predictor,
        { percent: anchorPercent, weighted, at: now },
        { fromFetch: usageStore.anthropicUsageFromFetch }
      )
      lastAnchoredUsage = usageStore.anthropicUsage
    }
  }

  const nextAt = nextUsageRefreshAt('anthropic')
  if (nextAt === null) return
  if (
    !shouldRefreshEarly(predictor, {
      thresholdPercent: threshold,
      nextScheduledRefreshAt: Math.max(nextAt, now)
    })
  ) {
    return
  }
  // The early-refresh floor is SHARED with the rate-limit event trigger via
  // the store's attempt timestamp — separate per-path floors would let the
  // two paths pair up requests under the advertised 30s endpoint floor
  // whenever fetches are failing (lastFetchedAt frozen).
  const lastActivity = Math.max(
    usageStore.anthropicLastFetchedAt ?? 0,
    usageStore.anthropicEarlyRefreshAttemptAt ?? 0,
    lastAttemptAt.anthropic ?? 0
  )
  if (now - lastActivity < EARLY_USAGE_REFRESH_FLOOR_MS) return
  if (fetchWouldNoOp('anthropic', EARLY_USAGE_REFRESH_FLOOR_MS)) return
  lastAttemptAt.anthropic = now
  useUsageStore.setState({ anthropicEarlyRefreshAttemptAt: now })
  usageStore
    .fetchUsageForProvider('anthropic', { minIntervalMs: EARLY_USAGE_REFRESH_FLOOR_MS })
    .catch(() => {})
}

/**
 * While auto-switch is armed and utilization sits inside the near-threshold
 * margin, keep candidate accounts' cached usage fresh in the background so
 * the trigger-time sweep (which skips rows younger than its maxAge) doesn't
 * spend the critical post-threshold seconds serially fetching every account.
 */
function prewarmAutoSwitchCandidates(): void {
  const running = providersWithRunningSessions()
  for (const provider of running) {
    const auto = useAccountScheduleStore.getState().autoSwitch[provider]
    if (!auto) continue
    const percent = getActiveUsagePercent(provider)
    if (percent === null || percent < auto.thresholdPercent - NEAR_THRESHOLD_MARGIN_PERCENT) {
      continue
    }
    // At/above the threshold the switch is due NOW: checkSchedules' own
    // trigger-time sweep owns the provider, and a pre-warm started in the
    // same tick would mark it refreshing and make that sweep skip its round.
    if (percent >= auto.thresholdPercent) continue
    const usageStore = useUsageStore.getState()
    if (usageStore.refreshingProviders[provider]) continue
    if (!usageStore.savedAccountsLoaded[provider]) continue
    if (usageStore.savedAccounts[provider].length < 2) continue
    const accountState = useAccountStore.getState()
    const activeEmail =
      provider === 'anthropic' ? accountState.anthropicEmail : accountState.openaiEmail
    const exclusions = computeSweepExclusions(provider, auto.thresholdPercent, activeEmail)
    // Fresh rows are skipped server-side, so ticking this every 30s costs a
    // round-trip when everything is warm and only re-fetches candidates
    // whose cache aged past the pre-warm window. Re-evaluate schedules once
    // the sweep settles: a usage update crossing the threshold MID-sweep
    // finds the provider refreshing and skips its round, and nothing else
    // subscribes to the refreshing→idle transition — without this the due
    // switch would wait out the rest of the tick interval.
    void usageStore
      .refreshAllForProvider(provider, exclusions, { maxAgeMs: PREWARM_MAX_AGE_MS })
      .catch(() => {}) // a failed sweep still cleared the refreshing flag —
      // the recheck below must run on BOTH outcomes, or a threshold crossing
      // that landed mid-sweep waits out the rest of the tick interval.
      .then(() => useAccountScheduleStore.getState().checkSchedules())
      .catch(() => {})
  }
}

/**
 * Drives scheduled account switches (see useAccountScheduleStore), the
 * mid-session usage refresh, the burn-rate predictor's early sampling, and
 * the auto-switch candidate pre-warm. Mount once at the app root.
 */
export function useAccountScheduleRunner(): void {
  useEffect(() => {
    const tick = (): void => {
      const usageStore = useUsageStore.getState()
      for (const provider of providersWithRunningSessions()) {
        const lastFetchedAt =
          provider === 'anthropic'
            ? usageStore.anthropicLastFetchedAt
            : usageStore.openaiLastFetchedAt
        const lastActivity = Math.max(lastFetchedAt ?? 0, lastAttemptAt[provider] ?? 0)
        const intervalMs = usageRefreshIntervalMs(provider)
        const minIntervalMs = Math.min(USAGE_FETCH_DEBOUNCE_MS, intervalMs)
        if (Date.now() - lastActivity >= intervalMs && !fetchWouldNoOp(provider, minIntervalMs)) {
          lastAttemptAt[provider] = Date.now()
          // fetchUsageForProvider is silent on failure and debounce-safe, so a
          // flaky refresh never toasts every 5 minutes. The near/imminent
          // cadences pass themselves as the debounce floor — a tightened
          // cadence must actually fetch, not be vetoed by the 3-minute default.
          usageStore.fetchUsageForProvider(provider, { minIntervalMs }).catch(() => {})
        }
      }
      void maintainBurnRatePredictor()
      // A due switch's trigger-time sweep starts synchronously inside
      // checkSchedules — running it BEFORE the pre-warm lets the pre-warm's
      // refreshing-guard yield to it (never the other way around, which
      // would starve the urgent switch round after round).
      useAccountScheduleStore
        .getState()
        .checkSchedules()
        .catch(() => {})
      prewarmAutoSwitchCandidates()
    }

    tick()
    const interval = setInterval(tick, CHECK_INTERVAL_MS)

    // Evaluate schedules the moment fresh usage data, rate-limit events, or
    // account-list changes land (e.g. a rejected window must trigger the
    // auto-switch immediately) instead of waiting for the next tick.
    const unsubscribe = useUsageStore.subscribe((state, prevState) => {
      if (
        state.anthropicUsage !== prevState.anthropicUsage ||
        state.openaiUsage !== prevState.openaiUsage ||
        state.anthropicRateLimit !== prevState.anthropicRateLimit ||
        state.savedAccounts !== prevState.savedAccounts
      ) {
        useAccountScheduleStore
          .getState()
          .checkSchedules()
          .catch(() => {})
      }
    })

    return () => {
      clearInterval(interval)
      unsubscribe()
    }
  }, [])
}
