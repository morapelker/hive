/**
 * Epoch of the last successful Claude account switch in this process.
 *
 * Sessions created before this moment were spawned with the PREVIOUS
 * account's credentials — the burn-rate token tally must not attribute
 * their transcript growth to the newly active account, or calibration
 * (new account's percent deltas ÷ mixed-account token deltas) skews low
 * and the predictor misses early refreshes. Mirrors the renderer-side rule
 * the rate-limit event listener applies via anthropicAccountSwitchedAt.
 *
 * In-memory only: after a restart the epoch is unknown (null) and every
 * session counts, matching pre-switch behavior.
 */

let lastClaudeSwitchAt: number | null = null

export function markClaudeAccountSwitch(): void {
  lastClaudeSwitchAt = Date.now()
}

export function getLastClaudeSwitchAt(): number | null {
  return lastClaudeSwitchAt
}

export function __resetClaudeSwitchEpochForTests(): void {
  lastClaudeSwitchAt = null
}
