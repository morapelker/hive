// The app's one set of Claude CLI usage launches (claude-cli-usage-launches.ts), wired to the
// live PTYs, the launch directories beside the database, the debug-log usage source and the
// transport decision. Kept apart from the class itself so its tests need neither node-pty
// nor the database module.
import {
  CLAUDE_LIVE_USAGE_HEALTH_CHANNEL,
  type ClaudeLiveUsageHealthPayload
} from '@shared/types/claude-live-usage'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import { isClaudeDebugUsageEnabled } from './claude-api-proxy/claude-debug-usage-setting'
import { getClaudeBinaryVersion } from './claude-binary-resolver'
import { claudeCliDebugDirs } from './claude-cli-debug-dir'
import {
  ClaudeCliUsageLaunches,
  type ClaudeCliUsageHealthChange,
  type ClaudeCliUsageLaunchesDeps
} from './claude-cli-usage-launches'
import { getClaudeDebugLogUsageSource } from './claude-debug-log/claude-debug-log-usage'
import { resolveClaudeUsageTransport } from './claude-usage-transport'
import { ptyService } from './pty-service'

/**
 * Tell the usage UI that a session's debug log stopped giving readings, or gives them again
 * (T18): it then no longer says "Live" on the strength of that session's last reading.
 */
function publishUsageHealth(change: ClaudeCliUsageHealthChange): void {
  const payload: ClaudeLiveUsageHealthPayload = {
    provider: 'anthropic',
    sessionId: change.sessionId,
    degraded: change.degraded,
    reason: change.reason,
    at: change.at
  }
  void Promise.resolve(publishDesktopBackendEvent(CLAUDE_LIVE_USAGE_HEALTH_CHANNEL, payload)).catch(
    () => undefined
  )
}

/**
 * The launches as the app runs them. `overrides` replaces single pieces (tests: directories
 * in a temporary place, an environment of their own).
 */
export function createClaudeCliUsageLaunches(
  overrides: Partial<ClaudeCliUsageLaunchesDeps> = {}
): ClaudeCliUsageLaunches {
  return new ClaudeCliUsageLaunches({
    isFeatureEnabled: isClaudeDebugUsageEnabled,
    resolveTransport: resolveClaudeUsageTransport,
    // The listener sits on the PTY itself, not on its id: it still fires for a PTY that was
    // destroyed (the id is forgotten at once, the process ends a moment later), which is
    // when a closed or reaped session's launch ends.
    onProcessExit: (sessionId, listener) => ptyService.onExit(sessionId, () => listener()),
    hasLiveProcess: (sessionId) => ptyService.has(sessionId),
    cliVersion: (path) => getClaudeBinaryVersion(path),
    onHealthChange: publishUsageHealth,
    ...overrides,
    dirs: overrides.dirs ?? claudeCliDebugDirs(),
    source: overrides.source ?? getClaudeDebugLogUsageSource()
  })
}

let defaultLaunches: ClaudeCliUsageLaunches | null = null

/**
 * The app's launches. In a test run every launch stays on the proxy unless a test installs
 * launches of its own: what a unit test starts must not depend on the environment and the
 * Claude settings of whoever runs it (as `claudeCliDebugDirs()` has no directory there).
 */
export function claudeCliUsageLaunches(): ClaudeCliUsageLaunches {
  if (!defaultLaunches) {
    defaultLaunches = createClaudeCliUsageLaunches(
      process.env.VITEST ? { resolveTransport: async () => 'proxy' } : {}
    )
  }
  return defaultLaunches
}

/**
 * App start: delete the launch directories a crash or a force quit left behind, now and
 * every hour (LF-7). The directories of running sessions are left alone.
 */
export function startClaudeCliUsageSweeps(): void {
  claudeCliUsageLaunches().startSweeping()
}

/**
 * App quit, before the PTYs are ended. Returns what to call once they have been reaped: it
 * ends every launch. The last lines of each log still count (the live usage updater is
 * disposed later in the quit chain), then its directory is deleted; with `false`, for a reap
 * that failed, the directories stay for the next start. The usage source itself is let go of
 * by its own quit step.
 */
export function quitClaudeCliUsageLaunches(): (processesEnded?: boolean) => void {
  return defaultLaunches?.quit() ?? (() => {})
}

/** Tests only: put launches of the test's own in the app's place, or take them out again. */
export function __setClaudeCliUsageLaunchesForTests(launches: ClaudeCliUsageLaunches | null): void {
  defaultLaunches = launches
}
