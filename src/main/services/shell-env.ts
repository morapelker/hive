import { execFileSync } from 'child_process'
import { createLogger } from './logger'

const log = createLogger({ component: 'ShellEnv' })

/**
 * Load the full shell environment into `process.env`.
 *
 * On macOS, GUI apps launched from Finder/Dock/Spotlight inherit a minimal
 * environment that is missing user-configured variables (e.g. AWS credentials,
 * CLAUDE_CODE_USE_BEDROCK, custom PATHs). This function spawns the user's
 * login shell, captures every exported variable, and merges them into the
 * current process so that all child-process spawns behave identically to a
 * terminal launch.
 *
 * Must be called once at app startup, before any child process spawning.
 */
export function loadShellEnv(): void {
  if (process.platform !== 'darwin') return

  const shell = process.env.SHELL || '/bin/zsh'

  try {
    // Use null-delimited output (`env -0`) to safely handle values that
    // contain newlines.  Falls back to newline-delimited `env` if `-0` is
    // not supported (unlikely on macOS, but defensive).
    let raw: string
    let delimiter: string

    try {
      raw = execFileSync(shell, ['-ilc', 'env -0'], {
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024
      })
      delimiter = '\0'
    } catch {
      raw = execFileSync(shell, ['-ilc', 'env'], {
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024
      })
      delimiter = '\n'
    }

    const parsed: Record<string, string> = {}

    for (const entry of raw.split(delimiter)) {
      if (!entry) continue
      const idx = entry.indexOf('=')
      if (idx <= 0) continue
      const key = entry.slice(0, idx)
      const value = entry.slice(idx + 1)
      parsed[key] = value
    }

    Object.assign(process.env, parsed)

    log.info('Loaded shell environment', {
      shell,
      varsLoaded: Object.keys(parsed).length
    })
  } catch (err) {
    log.warn('Failed to load shell environment, continuing with default env', {
      shell,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}
