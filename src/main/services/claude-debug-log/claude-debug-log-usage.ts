/**
 * The app's one debug-log usage source (Code Mode T16): the source of
 * `claude-debug-log-usage-source.ts` connected to the live updater every other
 * usage source feeds (`submitClaudeUsageObservation`), so that a reading from
 * a Code Mode session ends up on the same `usage:claudeLive` event and in the
 * same account row as one the proxy saw (PRD FR-40).
 *
 * One instance on purpose: all sessions share its one timer.
 *
 * It reports its performance counters to the app's performance log (Code Mode
 * T20): the `claudeDebugLog` gauge of every sample, and a `claude-debug-log`
 * record per rotation or degraded event. Only while performance logging is on.
 *
 * Sessions are registered and unregistered from the session lifecycle
 * (`claude-cli-usage-launches.ts`).
 */
import { submitClaudeUsageObservation } from '../claude-api-proxy/claude-usage-live'
import { createLogger } from '../logger'
import { perfLog } from '../perf-logging/perf-logger'
import {
  CLAUDE_DEBUG_LOG_PERF_GAUGE,
  ClaudeDebugLogUsagePerfCounters
} from './claude-debug-log-usage-perf'
import { ClaudeDebugLogUsageSource } from './claude-debug-log-usage-source'

const log = createLogger({ component: 'ClaudeDebugLogUsage' })

let source: ClaudeDebugLogUsageSource | null = null
let removeGauge: (() => void) | null = null

/** The source every Code Mode session registers with. Built on first use, then kept. */
export function getClaudeDebugLogUsageSource(): ClaudeDebugLogUsageSource {
  if (source === null) {
    const counters = new ClaudeDebugLogUsagePerfCounters({
      isEnabled: () => perfLog.isEnabled(),
      record: (kind, data) => perfLog.record(kind, data)
    })
    const created = new ClaudeDebugLogUsageSource({
      submit: submitClaudeUsageObservation,
      log,
      perf: counters
    })
    // Read by the performance logger alone, for one of its samples or a capture.
    removeGauge = perfLog.registerGauge(CLAUDE_DEBUG_LOG_PERF_GAUGE, () =>
      counters.takeWindow(created.stats().sessions)
    )
    source = created
  }
  return source
}

/**
 * App shutdown: stop the timer and let go of every log without submitting
 * anything more. Sessions whose last lines should still count are
 * unregistered first.
 */
export function disposeClaudeDebugLogUsageSource(): void {
  source?.dispose()
}

/** Tests only: forget the source and every session registered with it. */
export function __resetClaudeDebugLogUsageSourceForTests(): void {
  source?.dispose()
  source = null
  removeGauge?.()
  removeGauge = null
}
