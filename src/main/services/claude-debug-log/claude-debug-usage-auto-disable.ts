/**
 * Stops using the debug log for a version of the Claude CLI it does not work with (Code Mode
 * T19; CODE_MODE_PRD.html FR-32).
 *
 * The debug log's format is the CLI's own. After an update that changes it, every new Code
 * Mode session would start with debug logging on, give no readings and fall back to the usage
 * poll (T18): the cost of the log, the banner the CLI shows for it, and nothing in return. So
 * the launches are counted by how they turn out, per CLI version:
 *
 *   a failure   the launch's log became degraded before one response in it could be read
 *               (whatever the reason T18 gives: an empty log, responses that cannot be read, a
 *               log past the hard cap, a file that was refused).
 *   healthy     a response in the launch's log could be read: the log works with this version.
 *   neither     everything else: a launch that made no request or completed no turn, one that
 *               was never on the debug log, one whose CLI version is not known.
 *
 * Three failures in a row on one version switch the debug log off for it: `blocks()` then
 * says so to whoever decides the transport of a new launch, which starts with `none` instead
 * (off the proxy as it asked, no debug flags, usage from the poll). A healthy launch in
 * between starts the count again. Each launch counts once: as a failure the first time it
 * degrades without a reading, and as healthy the first time it gives one (also after it was
 * counted as a failure, since it has shown that the log can work).
 *
 * The switch-off is for one CLI version on one app version. It is kept in the database, so it
 * survives a restart, and it is lifted by the first launch that finds either version changed:
 * another CLI may write a log that can be read, another app may read the one this CLI writes.
 * Nothing else lifts it. A launch that started before the switch-off and turns out healthy
 * after it changes nothing: three launches said otherwise, and the person has been told.
 *
 * The person is told once per switch-off. `onBlocked` is the cue for it: called when the
 * third failure comes, and again with every launch that is kept off the debug log for as long
 * as nobody has claimed the notice (no window was there to take the first cue).
 * `claimClaudeDebugUsageAutoDisableNotice` gives the notice out exactly once; it runs where
 * the windows' requests are answered, on the same database.
 *
 * What is stored is two version strings, a count and a time. Nothing of a log (SEC-5).
 *
 * When in doubt the debug log stays on: a database that cannot be read, a record that is not
 * one, a CLI or app version that is not known all mean "not blocked", and are not counted.
 */
import type { ClaudeCodeModeUsageUnavailablePayload } from '@shared/types/claude-live-usage'
import { createLogger } from '../logger'

const log = createLogger({ component: 'ClaudeDebugUsageAutoDisable' })

/** Failed launches in a row, on one CLI version, that switch the debug log off for it (FR-32). */
export const CLAUDE_DEBUG_USAGE_AUTO_DISABLE_AFTER = 3

/** The `settings` row with the count and the switch-off (`ClaudeDebugUsageAutoDisableState`). */
export const CLAUDE_DEBUG_USAGE_AUTO_DISABLE_STATE_KEY = 'claude_code_mode_usage.auto_disable'

/** The `settings` row that says which switch-off the person has been told about. */
export const CLAUDE_DEBUG_USAGE_AUTO_DISABLE_NOTICE_KEY =
  'claude_code_mode_usage.auto_disable_notice'

/** The key-value settings of the app's database. */
export interface ClaudeDebugUsageAutoDisableStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  deleteSetting(key: string): void
}

/** What is kept between launches, and between runs of the app. */
export interface ClaudeDebugUsageAutoDisableState {
  /** The CLI version the count is for. */
  cliVersion: string
  /** The app version the count was made by. */
  appVersion: string
  /** Launches in a row whose log gave no reading. */
  failures: number
  /** When the debug log was switched off for these versions (epoch ms); null while it is on. */
  blockedAt: number | null
}

/** What one `debug-log` launch reports about itself. Neither call throws; each counts once. */
export interface ClaudeDebugUsageLaunchOutcome {
  /** Its log became degraded before one response in it could be read. */
  degraded(): void
  /** A response in its log could be read. */
  healthy(): void
}

export interface ClaudeDebugUsageAutoDisableDeps {
  /** The app's database. May throw: nothing is counted or blocked then. */
  readonly store: () => ClaudeDebugUsageAutoDisableStore
  /** The running app's version (`app.getVersion()`). */
  readonly appVersion: () => string
  /**
   * The version of the CLI binary at `path` as it is on disk now, or null when it cannot be
   * told. Asked once per `debug-log` launch, and once per launch decision while a switch-off
   * is stored.
   */
  readonly cliVersion: (path: string) => Promise<string | null>
  /**
   * The debug log is switched off for this CLI version and nobody has been told yet. Must
   * return at once.
   */
  readonly onBlocked?: (notice: ClaudeCodeModeUsageUnavailablePayload) => void
  /** Defaults to `CLAUDE_DEBUG_USAGE_AUTO_DISABLE_AFTER`. */
  readonly threshold?: number
  readonly now?: () => number
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isVersion = (value: unknown): value is string => typeof value === 'string' && value !== ''

function parseState(raw: string | null): ClaudeDebugUsageAutoDisableState | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (typeof value !== 'object' || value === null) return null
    const { cliVersion, appVersion, failures, blockedAt } = value
    if (!isVersion(cliVersion) || !isVersion(appVersion)) return null
    if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 1) return null
    if (blockedAt !== null && (typeof blockedAt !== 'number' || !Number.isFinite(blockedAt))) {
      return null
    }
    return { cliVersion, appVersion, failures, blockedAt }
  } catch {
    return null
  }
}

/** The stored count and switch-off, or null when there is none (or none that can be read). */
export function readClaudeDebugUsageAutoDisableState(
  store: Pick<ClaudeDebugUsageAutoDisableStore, 'getSetting'>
): ClaudeDebugUsageAutoDisableState | null {
  return parseState(store.getSetting(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_STATE_KEY))
}

/** Whether the notice of exactly this switch-off was given out before. */
function noticeClaimed(
  store: Pick<ClaudeDebugUsageAutoDisableStore, 'getSetting'>,
  state: ClaudeDebugUsageAutoDisableState
): boolean {
  const raw = store.getSetting(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_NOTICE_KEY)
  if (!raw) return false
  try {
    const claimed = JSON.parse(raw) as Record<string, unknown> | null
    return (
      typeof claimed === 'object' &&
      claimed !== null &&
      claimed.cliVersion === state.cliVersion &&
      claimed.appVersion === state.appVersion &&
      claimed.blockedAt === state.blockedAt
    )
  } catch {
    return false
  }
}

/**
 * The notice of the stored switch-off, for whoever asks first: null when the debug log is
 * not switched off, and to everybody who asks after the first. A switch-off that was lifted
 * and came back is a new one, and is told again.
 *
 * Runs in the process that answers the windows (it shares the database with the one that
 * counts), so two windows that ask at the same moment get one notice between them.
 */
export function claimClaudeDebugUsageAutoDisableNotice(
  store: Pick<ClaudeDebugUsageAutoDisableStore, 'getSetting' | 'setSetting'>,
  now: number = Date.now()
): ClaudeCodeModeUsageUnavailablePayload | null {
  const state = readClaudeDebugUsageAutoDisableState(store)
  if (!state || state.blockedAt === null) return null
  if (noticeClaimed(store, state)) return null
  store.setSetting(
    CLAUDE_DEBUG_USAGE_AUTO_DISABLE_NOTICE_KEY,
    JSON.stringify({
      cliVersion: state.cliVersion,
      appVersion: state.appVersion,
      blockedAt: state.blockedAt,
      claimedAt: now
    })
  )
  return { provider: 'anthropic', cliVersion: state.cliVersion }
}

export class ClaudeDebugUsageAutoDisable {
  private readonly deps: ClaudeDebugUsageAutoDisableDeps
  private readonly threshold: number

  constructor(deps: ClaudeDebugUsageAutoDisableDeps) {
    this.deps = deps
    this.threshold = Math.max(
      1,
      Math.floor(deps.threshold ?? CLAUDE_DEBUG_USAGE_AUTO_DISABLE_AFTER)
    )
  }

  /**
   * Whether a launch of the CLI at `cliPath` that would get the debug log has to do without:
   * the debug log is switched off for this CLI version on this app version. A stored
   * switch-off for another version of either is lifted here. Never throws.
   *
   * Costs one database read while nothing is switched off; the CLI's version is only asked
   * for when there is a switch-off to compare it with.
   */
  async blocks(cliPath: string | null | undefined): Promise<boolean> {
    try {
      const appVersion = this.appVersion()
      const stored = this.read()
      if (!stored || stored.blockedAt === null || appVersion === null) return false
      if (stored.appVersion !== appVersion) {
        this.lift(stored, { appVersion })
        return false
      }
      const cliVersion = await this.cliVersion(cliPath)
      if (cliVersion === null) {
        log.warn(
          'Live usage in Code Mode is switched off for a version of the Claude CLI, and the version of this launch is not known: it gets its debug log',
          { blockedCliVersion: stored.cliVersion }
        )
        return false
      }
      // The version took a moment: what is stored may be another launch's doing by now.
      const current = this.read()
      if (!current || current.blockedAt === null || current.appVersion !== appVersion) return false
      if (current.cliVersion !== cliVersion) {
        this.lift(current, { cliVersion })
        return false
      }
      this.announce(current)
      return true
    } catch (error) {
      log.warn('Could not tell whether the debug log is switched off for this Claude CLI', {
        error: errorText(error)
      })
      return false
    }
  }

  /**
   * A `debug-log` launch of the CLI at `cliPath` begins. Its version is asked for now, while
   * the binary on disk is the one that starts, and what the launch reports later is counted
   * for that version. Never throws.
   */
  launch(cliPath: string | null | undefined): ClaudeDebugUsageLaunchOutcome {
    const version = this.cliVersion(cliPath)
    let failed = false
    let gaveReading = false
    return {
      degraded: () => {
        if (failed || gaveReading) return
        failed = true
        void version.then((cliVersion) => this.noteFailure(cliVersion))
      },
      healthy: () => {
        if (gaveReading) return
        gaveReading = true
        void version.then((cliVersion) => this.noteHealthy(cliVersion))
      }
    }
  }

  /** The stored count and switch-off, or null. Never throws. */
  state(): ClaudeDebugUsageAutoDisableState | null {
    try {
      return this.read()
    } catch {
      return null
    }
  }

  private noteFailure(cliVersion: string | null): void {
    try {
      const appVersion = this.appVersion()
      if (cliVersion === null || appVersion === null) return
      const stored = this.read()
      const sameVersions =
        stored !== null && stored.cliVersion === cliVersion && stored.appVersion === appVersion
      // Switched off already: a launch that started before that adds nothing.
      if (sameVersions && stored.blockedAt !== null) return
      const failures = (sameVersions ? stored.failures : 0) + 1
      const state: ClaudeDebugUsageAutoDisableState = {
        cliVersion,
        appVersion,
        failures,
        blockedAt: failures >= this.threshold ? (this.deps.now ?? Date.now)() : null
      }
      this.deps.store().setSetting(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_STATE_KEY, JSON.stringify(state))
      if (state.blockedAt === null) return
      log.warn(
        'Live usage in Code Mode is switched off for this version of the Claude CLI: its debug log gave no readings in several launches in a row. New Code Mode sessions get their usage from the usage poll until the CLI or the app is updated',
        { cliVersion, appVersion, failures }
      )
      this.announce(state)
    } catch (error) {
      log.warn('Could not count a Code Mode launch without usage readings', {
        error: errorText(error)
      })
    }
  }

  private noteHealthy(cliVersion: string | null): void {
    try {
      const appVersion = this.appVersion()
      if (cliVersion === null || appVersion === null) return
      const stored = this.read()
      if (!stored || stored.blockedAt !== null) return
      if (stored.cliVersion !== cliVersion || stored.appVersion !== appVersion) return
      this.deps.store().deleteSetting(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_STATE_KEY)
    } catch (error) {
      log.warn('Could not count a Code Mode launch with usage readings', {
        error: errorText(error)
      })
    }
  }

  /** The switch-off is for versions that are not the ones running now: it is over. */
  private lift(
    state: ClaudeDebugUsageAutoDisableState,
    found: { appVersion: string } | { cliVersion: string }
  ): void {
    const store = this.deps.store()
    store.deleteSetting(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_STATE_KEY)
    store.deleteSetting(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_NOTICE_KEY)
    log.info(
      'Live usage in Code Mode is tried again: the version it was switched off for changed',
      {
        blockedCliVersion: state.cliVersion,
        blockedAppVersion: state.appVersion,
        ...found
      }
    )
  }

  /** Give the cue to tell the person, unless they have been told about this switch-off. */
  private announce(state: ClaudeDebugUsageAutoDisableState): void {
    if (!this.deps.onBlocked) return
    try {
      if (noticeClaimed(this.deps.store(), state)) return
      this.deps.onBlocked({ provider: 'anthropic', cliVersion: state.cliVersion })
    } catch (error) {
      log.warn('Could not say that live usage in Code Mode is switched off', {
        error: errorText(error)
      })
    }
  }

  private read(): ClaudeDebugUsageAutoDisableState | null {
    return readClaudeDebugUsageAutoDisableState(this.deps.store())
  }

  /** The app's version, or null when it cannot be told. */
  private appVersion(): string | null {
    try {
      const version = this.deps.appVersion()
      return isVersion(version) ? version : null
    } catch {
      return null
    }
  }

  /** The version of the CLI at `cliPath`, or null when it cannot be told. Never rejects. */
  private async cliVersion(cliPath: string | null | undefined): Promise<string | null> {
    if (!cliPath) return null
    try {
      const version = await this.deps.cliVersion(cliPath)
      return isVersion(version) ? version : null
    } catch {
      return null
    }
  }
}
