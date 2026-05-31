import { readFile } from 'fs/promises'
import { join } from 'path'
import { encodePath, resolveProjectsDir } from './claude-transcript-reader'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudePlanFollowupWatcher' })

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

export function watchForClaudePlanFollowup(
  worktreePath: string,
  claudeSessionId: string,
  onPlanFollowup: () => void,
  intervalMs = 1000
): ClaudePlanFollowupWatchHandle {
  const filePath = join(resolveProjectsDir(), encodePath(worktreePath), `${claudeSessionId}.jsonl`)
  let closed = false
  let baselineLine: number | null = null
  let interval: NodeJS.Timeout | null = null
  let polling = false

  // Persist parse progress across polls so we don't re-JSON.parse the whole
  // transcript every tick (it can grow to many MB during a plan review). The
  // ExitPlanMode tool ids accumulate across polls; `scannedThrough` leaves the
  // last line volatile so a partially-written final line is re-read once it
  // settles rather than skipped.
  const exitPlanToolIds = new Set<string>()
  let scannedThrough = 0

  const close = (): void => {
    if (closed) return
    closed = true
    if (interval) clearInterval(interval)
    interval = null
  }

  const poll = async (): Promise<void> => {
    if (closed || polling) return
    polling = true
    try {
      const raw = await readFile(filePath, 'utf-8')
      const lines = splitTranscriptLines(raw)

      if (baselineLine === null) {
        // First read: parse everything once to capture ExitPlanMode tool ids that
        // predate the watcher, but only treat lines appended after now as
        // candidates (a follow-up must come after the plan was proposed).
        scanPlanFollowupLines(lines, 0, Number.MAX_SAFE_INTEGER, exitPlanToolIds)
        baselineLine = lines.length
        scannedThrough = Math.max(0, lines.length - 1)
        return
      }

      const found = scanPlanFollowupLines(lines, scannedThrough, baselineLine, exitPlanToolIds)
      scannedThrough = Math.max(0, lines.length - 1)
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
    } finally {
      polling = false
    }
  }

  void poll()
  interval = setInterval(() => {
    void poll()
  }, intervalMs)

  return { close }
}
