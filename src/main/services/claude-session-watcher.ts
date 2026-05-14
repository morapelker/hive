import { watch, existsSync, readdirSync, statSync, type FSWatcher } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { encodePath } from './claude-transcript-reader'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeSessionWatcher' })

function listJsonlFiles(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir).filter((name) => name.endsWith('.jsonl')))
  } catch {
    return new Set()
  }
}

function newestJsonlCreatedAfter(dir: string, existing: Set<string>, startedAtMs: number): string | null {
  let newest: { name: string; mtimeMs: number } | null = null
  for (const name of listJsonlFiles(dir)) {
    if (existing.has(name)) continue
    try {
      const stat = statSync(join(dir, name))
      if (stat.mtimeMs + 1000 < startedAtMs) continue
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { name, mtimeMs: stat.mtimeMs }
      }
    } catch {
      // File can disappear between readdir and stat; ignore this scan tick.
    }
  }
  return newest ? basename(newest.name, '.jsonl') : null
}

export interface ClaudeSessionWatchHandle {
  close(): void
}

export function watchForClaudeSessionId(
  worktreePath: string,
  onSessionId: (sessionId: string) => void
): ClaudeSessionWatchHandle {
  const dir = join(homedir(), '.claude', 'projects', encodePath(worktreePath))
  const existing = listJsonlFiles(dir)
  const startedAtMs = Date.now()
  let closed = false
  let watcher: FSWatcher | null = null
  let interval: NodeJS.Timeout | null = null

  const complete = (sessionId: string): void => {
    if (closed) return
    closed = true
    if (interval) clearInterval(interval)
    watcher?.close()
    log.info('Detected Claude CLI session id', { worktreePath, sessionId })
    onSessionId(sessionId)
  }

  const scan = (): void => {
    const sessionId = newestJsonlCreatedAfter(dir, existing, startedAtMs)
    if (sessionId) complete(sessionId)
  }

  try {
    if (existsSync(dir)) {
      watcher = watch(dir, (_eventType, filename) => {
        if (typeof filename === 'string' && filename.endsWith('.jsonl')) {
          scan()
        }
      })
    } else {
      log.info('Claude project transcript directory does not exist yet', { dir })
    }
  } catch (error) {
    log.warn('Unable to watch Claude transcript directory', {
      dir,
      error: error instanceof Error ? error.message : String(error)
    })
  }

  interval = setInterval(scan, 1000)
  scan()

  return {
    close: () => {
      if (closed) return
      closed = true
      if (interval) clearInterval(interval)
      watcher?.close()
    }
  }
}
