import { watch, existsSync, readdirSync, statSync, type FSWatcher } from 'fs'
import { join, basename } from 'path'
import { encodePath, resolveProjectsDir } from './claude-transcript-reader'
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
  const dir = join(resolveProjectsDir(), encodePath(worktreePath))
  const existing = listJsonlFiles(dir)
  const startedAtMs = Date.now()
  let closed = false
  let watcher: FSWatcher | null = null
  let interval: NodeJS.Timeout | null = null
  let scanScheduled: NodeJS.Timeout | null = null

  const stopTimers = (): void => {
    if (interval) clearInterval(interval)
    interval = null
    if (scanScheduled) clearTimeout(scanScheduled)
    scanScheduled = null
  }

  const complete = (sessionId: string): void => {
    if (closed) return
    closed = true
    stopTimers()
    watcher?.close()
    log.info('Detected Claude CLI session id', { worktreePath, sessionId })
    onSessionId(sessionId)
  }

  const scan = (): void => {
    const sessionId = newestJsonlCreatedAfter(dir, existing, startedAtMs)
    if (sessionId) complete(sessionId)
  }

  // Coalesce bursts of fs events (the CLI appends many lines while a transcript
  // is created) into a single directory scan.
  const requestScan = (): void => {
    if (closed || scanScheduled) return
    scanScheduled = setTimeout(() => {
      scanScheduled = null
      if (!closed) scan()
    }, 50)
  }

  try {
    if (existsSync(dir)) {
      watcher = watch(dir, (_eventType, filename) => {
        if (typeof filename === 'string' && filename.endsWith('.jsonl')) {
          requestScan()
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

  // Poll only as a fallback when fs.watch could not be attached (most commonly
  // because the transcript directory does not exist yet). When the watcher is
  // active its events drive detection, so the periodic full scan is redundant.
  if (!watcher) {
    interval = setInterval(scan, 1000)
  }
  scan()

  return {
    close: () => {
      if (closed) return
      closed = true
      stopTimers()
      watcher?.close()
    }
  }
}
