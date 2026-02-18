import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeTranscriptReader' })

/**
 * Encode a worktree path the same way Claude CLI does:
 * replace every `/` and `.` with `-`.
 */
export function encodePath(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, '-')
}

interface ClaudeContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  // tool_result fields
  tool_use_id?: string
  is_error?: boolean
  content?: string | { type: string; text?: string }[]
  // Resolved output/error attached during two-pass correlation
  _resolvedOutput?: string
  _resolvedError?: string
  [key: string]: unknown
}

interface ClaudeJsonlEntry {
  type: string
  uuid?: string
  timestamp?: string
  message?: {
    role?: string
    content?: ClaudeContentBlock[] | string
  }
  isSidechain?: boolean
}

function extractTextFromContent(content: ClaudeContentBlock[] | string | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function parseTimestamp(timestamp: string | undefined): number {
  if (!timestamp) return 0
  const ms = new Date(timestamp).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

function translateContentBlock(
  block: ClaudeContentBlock,
  index: number,
  timestamp: string | undefined
): Record<string, unknown> | null {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : null

    case 'tool_use': {
      const toolUse: Record<string, unknown> = {
        id: block.id ?? `tool-${index}`,
        name: block.name ?? 'Unknown',
        input: block.input ?? {},
        status: 'success',
        startTime: parseTimestamp(timestamp)
      }
      // output/error may be attached by mergeToolResults() after initial translation
      if (block._resolvedOutput !== undefined) {
        toolUse.output = block._resolvedOutput
      }
      if (block._resolvedError !== undefined) {
        toolUse.error = block._resolvedError
        toolUse.status = 'error'
      }
      return { type: 'tool_use', toolUse }
    }

    case 'thinking':
      return typeof block.thinking === 'string' ? { type: 'reasoning', text: block.thinking } : null

    case 'tool_result':
      return null

    default:
      return null
  }
}

function translateEntry(entry: ClaudeJsonlEntry, index: number): Record<string, unknown> | null {
  if (entry.type !== 'user' && entry.type !== 'assistant') return null
  if (entry.isSidechain === true) return null

  const content = Array.isArray(entry.message?.content) ? entry.message.content : []
  const parts = content
    .map((block, i) => translateContentBlock(block, i, entry.timestamp))
    .filter((p): p is Record<string, unknown> => p !== null)

  log.debug('TOOL_LIFECYCLE: translateEntry', {
    type: entry.type,
    blockTypes: content.map((b) => b.type),
    keptParts: parts.length,
    droppedBlocks: content.length - parts.length
  })

  return {
    id: entry.uuid ?? `entry-${index}`,
    role: entry.message?.role ?? entry.type,
    timestamp: entry.timestamp ?? new Date(0).toISOString(),
    content: extractTextFromContent(entry.message?.content),
    parts
  }
}

/**
 * Read a Claude CLI transcript JSONL file and translate it into the format
 * expected by `mapOpencodeMessagesToSessionViewMessages()`.
 *
 * Returns `[]` if the file doesn't exist or can't be parsed.
 */
export async function readClaudeTranscript(
  worktreePath: string,
  claudeSessionId: string
): Promise<unknown[]> {
  const encoded = encodePath(worktreePath)
  const filePath = join(homedir(), '.claude', 'projects', encoded, `${claudeSessionId}.jsonl`)

  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err) {
    log.debug('Transcript file not found or unreadable', {
      filePath,
      error: err instanceof Error ? err.message : String(err)
    })
    return []
  }

  const lines = raw.split('\n')

  // Pass 1: Parse all JSONL entries
  const entries: ClaudeJsonlEntry[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as ClaudeJsonlEntry)
    } catch {
      log.debug('Skipping malformed JSONL line', { line: trimmed.slice(0, 100) })
    }
  }

  // Pass 2: For each user entry with tool_result blocks, merge output into
  // the preceding assistant entry's tool_use blocks so they survive translation.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.type !== 'user') continue
    const content = Array.isArray(entry.message?.content) ? entry.message!.content : []
    const toolResults = content.filter((b) => b.type === 'tool_result')
    if (toolResults.length === 0) continue

    // Find the preceding assistant entry
    for (let j = i - 1; j >= 0; j--) {
      if (entries[j].type !== 'assistant') continue
      const assistantContent = Array.isArray(entries[j].message?.content)
        ? entries[j].message!.content!
        : []
      if (!Array.isArray(assistantContent)) break
      for (const tr of toolResults) {
        const toolUseBlock = (assistantContent as ClaudeContentBlock[]).find(
          (b) => b.type === 'tool_use' && b.id === tr.tool_use_id
        )
        if (!toolUseBlock) continue
        // Extract text output from tool_result content
        let output: string | undefined
        if (typeof tr.content === 'string') {
          output = tr.content
        } else if (Array.isArray(tr.content)) {
          output = (tr.content as { type: string; text?: string }[])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n')
        }
        if (tr.is_error) {
          toolUseBlock._resolvedError = output
        } else {
          toolUseBlock._resolvedOutput = output
        }
      }
      break
    }
  }

  // Pass 3: Translate entries, skipping tool_result-only and subagent messages
  const messages: unknown[] = []
  for (const entry of entries) {
    // Skip subagent messages — they have parent_tool_use_id set and belong
    // to child session transcripts, not the main conversation.
    const rawEntry = entry as Record<string, unknown>
    if (rawEntry.parent_tool_use_id) {
      continue
    }

    // Skip user messages that only contain tool_result blocks
    if (entry.type === 'user') {
      const content = Array.isArray(entry.message?.content) ? entry.message!.content : []
      if (content.length > 0 && content.every((b) => b.type === 'tool_result')) {
        continue
      }
    }

    const translated = translateEntry(entry, messages.length)
    if (translated) {
      messages.push(translated)
    }
  }

  log.info('Read Claude transcript', {
    filePath,
    totalLines: lines.length,
    parsedEntries: entries.length,
    messageCount: messages.length
  })

  return messages
}

// Export helpers for testing
export { translateEntry, translateContentBlock, extractTextFromContent }
export type { ClaudeJsonlEntry, ClaudeContentBlock }
