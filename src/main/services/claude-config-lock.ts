import { mkdir, rm, stat } from 'fs/promises'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeConfigLock' })

/**
 * Cross-process lock on the claude CLI config file (`~/.claude.json`).
 *
 * The file is a shared read-modify-write target: every running claude CLI
 * rewrites it (startup counters, per-project state, session ids), a second
 * Hive instance (a dev build next to the installed app) runs the same
 * trust pre-flight, and account switching rewrites the identity block. A
 * writer that read the file before another write landed and wrote after it
 * silently drops that write — observed in production: a trust entry logged as
 * written was absent minutes later and the session sat on the trust dialog.
 *
 * The lock is the `<file>.lock` directory convention of the `proper-lockfile`
 * package (an `mkdir` is atomic). The claude CLI (2.1.299+) takes exactly this
 * lock — `lockfilePath: \`${configPath}.lock\`` — around its own config
 * writes, so holding it serialises us against the CLI and against another
 * Hive instance alike. A lock older than LOCK_STALE_MS belongs to a
 * dead process and is taken over, matching proper-lockfile's default.
 */
const LOCK_STALE_MS = 10_000
const LOCK_RETRY_MS = 25
const LOCK_WAIT_MS = 3_000

export async function withClaudeConfigLock<T>(
  configPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockPath = `${configPath}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  let acquired = false
  for (;;) {
    try {
      await mkdir(lockPath)
      acquired = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Parent directory missing: the config does not exist yet either.
        // Nothing can race us on a file that is not there.
        break
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) {
        log.warn('Claude config lock held too long; writing without it', { lockPath })
        break
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
  try {
    return await fn()
  } finally {
    if (acquired) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
  }
}
