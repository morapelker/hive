import {
  parseGhosttyConfig,
  resolveGhosttyConfigPath,
  type GhosttyConfig
} from './ghostty-config'

/**
 * Launch-time cache for the user's Ghostty config.
 *
 * The config may live in Ghostty's Application Support dir, which macOS TCC
 * guards with the "access data from other apps" prompt. To keep that prompt
 * from appearing mid-flow, the protected dir is touched exactly once — at app
 * launch (warmUpGhosttyConfig) — and every later consumer is served from the
 * in-memory memo. There is deliberately no mtime-based freshness check (even a
 * stat re-triggers TCC); the only mid-run re-reads are explicit user re-syncs.
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
  configMemo = parseGhosttyConfig({ includeAppSupport: true })
  return configMemo
}

/**
 * Resolve the Ghostty config file path, stat-ing the candidates only on the
 * first call. Used by the native ghostty runtime init in the main process.
 */
export function getGhosttyConfigPathOnce(opts?: { refresh?: boolean }): string | undefined {
  if (!pathResolved || opts?.refresh) {
    pathMemo = resolveGhosttyConfigPath({ includeAppSupport: true })
    pathResolved = true
  }
  return pathMemo
}

/**
 * Launch-time warm-up: perform the one TCC-relevant disk read now, so any
 * macOS permission prompt appears at app launch rather than mid-flow.
 */
export function warmUpGhosttyConfig(): void {
  getGhosttyConfigPathOnce()
  getGhosttyTerminalConfig()
}
