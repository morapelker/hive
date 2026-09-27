import { parseGhosttyConfig, resolveGhosttyConfigPath, type GhosttyConfig } from './ghostty-config'

/**
 * Launch-time cache for the user's Ghostty config.
 *
 * Automatic reads use only the XDG config locations. Ghostty's Application
 * Support directory is protected by macOS: allowing access lasts only until
 * the app quits, so warming that directory at launch still prompts every run.
 * Only an explicit user re-sync may read it. Cache the parsed result for the
 * rest of this run; do not poll protected files for changes.
 */

let configMemo: GhosttyConfig | null = null
let pathMemo: string | undefined
let pathResolved = false

/** Test hook: reset the module-level memos between test cases. */
export function clearGhosttyConfigMemo(): void {
  configMemo = null
  pathMemo = undefined
  pathResolved = false
}

/**
 * Parse the Ghostty config, reading from disk only on the first call (app
 * launch) or when `refresh` is set (explicit user re-sync).
 */
export function getGhosttyTerminalConfig(opts?: { refresh?: boolean }): GhosttyConfig {
  if (!opts?.refresh && configMemo) {
    return configMemo
  }
  configMemo = parseGhosttyConfig({ includeAppSupport: opts?.refresh === true })
  return configMemo
}

/**
 * Resolve the Ghostty config file path, stat-ing the candidates only on the
 * first call. Native runtime initialization must always avoid the protected
 * Application Support directory, including when refreshing its path cache.
 */
export function getGhosttyConfigPathOnce(opts?: { refresh?: boolean }): string | undefined {
  if (!pathResolved || opts?.refresh) {
    pathMemo = resolveGhosttyConfigPath({ includeAppSupport: false })
    pathResolved = true
  }
  return pathMemo
}

/**
 * Warm the automatic (XDG-only) config and native path caches at launch.
 */
export function warmUpGhosttyConfig(): void {
  getGhosttyConfigPathOnce()
  getGhosttyTerminalConfig()
}
