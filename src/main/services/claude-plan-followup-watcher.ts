import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { join } from 'path'
import { encodePath, resolveProjectsDir } from './claude-transcript-reader'
import { createLogger } from './logger'
import { perfLog } from './perf-logging/perf-logger'

const log = createLogger({ component: 'ClaudePlanFollowupWatcher' })

// Open watchers, surfaced in the perf log so a runaway plan-session count is visible.
let liveCount = 0
perfLog.registerGauge('claudePlanFollowupWatchers', () => liveCount)

export interface ClaudePlanFollowupWatchHandle {
  close(): void
}

function messageContentBlocks(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = entry.message
  if (!message || typeof message !== 'object') return []
  const content = (message as { content?: unknown }).content
  return Array.isArray(content)
    ? content.filter((block): block is Record<string, unknown> => {
        return block !== null && typeof block === 'object'
      })
    : []
}

function collectExitPlanToolIds(entry: Record<string, unknown>, toolIds: Set<string>): void {
  for (const block of messageContentBlocks(entry)) {
    if (block.type !== 'tool_use' || block.name !== 'ExitPlanMode') continue
    if (typeof block.id === 'string' && block.id.length > 0) {
      toolIds.add(block.id)
    }
  }
}

function toolResultContentText(block: Record<string, unknown>): string | null {
  const content = block.content
  if (typeof content === 'string') return content

  if (!Array.isArray(content)) return null
  const text = content
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const typed = item as { type?: unknown; text?: unknown }
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
    })
    .join('')

  return text.length > 0 ? text : null
}

function hasExitPlanFollowup(
  entry: Record<string, unknown>,
  exitPlanToolIds: Set<string>
): boolean {
  for (const block of messageContentBlocks(entry)) {
    if (block.type !== 'tool_result') continue
    if (block.is_error !== true) continue
    if (typeof block.tool_use_id !== 'string') continue
    if (!exitPlanToolIds.has(block.tool_use_id)) continue
    if (toolResultContentText(block) !== null) return true
  }
  return false
}

function splitTranscriptLines(raw: string): string[] {
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
}

// Scan lines[fromIndex..], accumulating every ExitPlanMode tool_use id into the
// caller-owned `exitPlanToolIds` set, and report the first error tool_result (a
// plan follow-up) at or after `baselineLine`. The set is passed in so a caller
// can keep it across incremental calls instead of re-parsing the whole file.
export function scanPlanFollowupLines(
  lines: string[],
  fromIndex: number,
  baselineLine: number,
  exitPlanToolIds: Set<string>
): boolean {
  for (let index = Math.max(0, fromIndex); index < lines.length; index++) {
    try {
      const entry = JSON.parse(lines[index]) as Record<string, unknown>
      collectExitPlanToolIds(entry, exitPlanToolIds)
      if (index >= Math.max(0, baselineLine) && hasExitPlanFollowup(entry, exitPlanToolIds)) {
        return true
      }
    } catch {
      // Ignore malformed / partially-written transcript lines.
    }
  }
  return false
}

export function findClaudePlanFollowupAfterLine(
  raw: string,
  startLine: number
): { found: boolean; nextLine: number } {
  const lines = splitTranscriptLines(raw)
  const found = scanPlanFollowupLines(lines, 0, startLine, new Set<string>())
  return { found, nextLine: lines.length }
}

export interface TranscriptAppend {
  lines: string[]
  offset: number
  size: number
  truncated: boolean
}

/**
 * Read the transcript bytes appended since `offset`. Only complete lines are
 * consumed; a partial trailing line is left for the next call (so a line split
 * across writes is never parsed in halves, and a multi-byte character is never
 * decoded in halves). A shrunken file (rewritten transcript) is reported so
 * the caller can restart from scratch.
 */
export function readTranscriptAppend(filePath: string, offset: number): TranscriptAppend {
  const fd = openSync(filePath, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < offset) return { lines: [], offset: 0, size, truncated: true }
    if (size === offset) return { lines: [], offset, size, truncated: false }

    const buffer = Buffer.alloc(size - offset)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, offset)
    if (bytesRead <= 0) return { lines: [], offset, size, truncated: false }

    const data = buffer.subarray(0, bytesRead)
    const lastNewline = data.lastIndexOf(0x0a)
    if (lastNewline === -1) return { lines: [], offset, size, truncated: false }

    return {
      lines: splitTranscriptLines(data.subarray(0, lastNewline + 1).toString('utf8')),
      offset: offset + lastNewline + 1,
      size,
      truncated: false
    }
  } finally {
    closeSync(fd)
  }
}

export function watchForClaudePlanFollowup(
  worktreePath: string,
  claudeSessionId: string,
  onPlanFollowup: () => void,
  intervalMs = 1000
): ClaudePlanFollowupWatchHandle {
  const filePath = join(resolveProjectsDir(), encodePath(worktreePath), `${claudeSessionId}.jsonl`)
  let closed = false
  let interval: NodeJS.Timeout | null = null

  // Incremental reader state. The transcript can grow to many MB during a plan
  // review, so each tick reads only the bytes appended since the last one and
  // keeps the ExitPlanMode tool ids across ticks. `baselined` flips once the
  // content present when the watcher started has been parsed (to seed the
  // ids); only lines appended after that count as follow-ups.
  const exitPlanToolIds = new Set<string>()
  let offset = 0
  let baselined = false

  liveCount += 1
  const close = (): void => {
    if (closed) return
    closed = true
    liveCount -= 1
    if (interval) clearInterval(interval)
    interval = null
  }

  const poll = (): void => {
    if (closed) return
    try {
      const result = readTranscriptAppend(filePath, offset)
      if (result.truncated) {
        // Rewritten transcript: start over and re-seed from whatever is on disk.
        offset = 0
        exitPlanToolIds.clear()
        baselined = false
        return
      }
      offset = result.offset

      if (!baselined) {
        scanPlanFollowupLines(result.lines, 0, Number.MAX_SAFE_INTEGER, exitPlanToolIds)
        // A torn trailing line predates the watcher too; wait for it to settle.
        baselined = result.offset === result.size
        return
      }

      if (result.lines.length === 0) return
      const found = scanPlanFollowupLines(result.lines, 0, 0, exitPlanToolIds)
      if (found) {
        log.info('Detected Claude CLI plan follow-up in transcript', {
          worktreePath,
          claudeSessionId
        })
        close()
        onPlanFollowup()
      }
    } catch (error) {
      log.debug('Claude CLI plan follow-up transcript poll skipped', {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // The watcher is armed from the hook HTTP handler; the seeding read of a large transcript
  // must not sit on that response path.
  setImmediate(poll)
  interval = setInterval(poll, intervalMs)

  return { close }
}
