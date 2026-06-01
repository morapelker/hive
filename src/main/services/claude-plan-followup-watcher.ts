import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { encodePath } from './claude-transcript-reader'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudePlanFollowupWatcher' })

export interface ClaudePlanFollowupWatchHandle {
  close(): void
}

function resolveProjectsDir(): string {
  const configuredDir = process.env.CLAUDE_CONFIG_DIR
  const configRoot =
    typeof configuredDir === 'string' && configuredDir.trim().length > 0
      ? configuredDir
      : join(homedir(), '.claude')

  return join(configRoot.normalize('NFC'), 'projects')
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

export function findClaudePlanFollowupAfterLine(
  raw: string,
  startLine: number
): { found: boolean; nextLine: number } {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const exitPlanToolIds = new Set<string>()

  for (let index = 0; index < lines.length; index++) {
    try {
      const entry = JSON.parse(lines[index]) as Record<string, unknown>
      collectExitPlanToolIds(entry, exitPlanToolIds)
      if (index >= Math.max(0, startLine) && hasExitPlanFollowup(entry, exitPlanToolIds)) {
        return { found: true, nextLine: lines.length }
      }
    } catch {
      // Ignore malformed transcript lines but keep advancing the baseline.
    }
  }

  return { found: false, nextLine: lines.length }
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
      if (baselineLine === null) {
        baselineLine = findClaudePlanFollowupAfterLine(raw, Number.MAX_SAFE_INTEGER).nextLine
        return
      }

      const result = findClaudePlanFollowupAfterLine(raw, baselineLine)
      baselineLine = result.nextLine
      if (result.found) {
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
