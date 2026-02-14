import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeTranscriptReader' })

/**
 * Encode a worktree path the same way Claude CLI does:
 * replace every `/` with `-`.
 */
export function encodePath(worktreePath: string): string {
  return worktreePath.replace(/\//g, '-')
}

interface ClaudeContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
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

function translateContentBlock(
  block: ClaudeContentBlock,
  index: number
): Record<string, unknown> | null {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : null

    case 'tool_use':
      return {
        type: 'tool_use',
        toolUse: {
          id: block.id ?? `tool-${index}`,
          name: block.name ?? 'Unknown',
          input: block.input ?? {},
          status: 'success',
          startTime: Date.now()
        }
      }

    case 'thinking':
      return typeof block.thinking === 'string' ? { type: 'reasoning', text: block.thinking } : null

    case 'tool_result':
      return null

    default:
      return null
  }
}

function translateEntry(entry: ClaudeJsonlEntry): Record<string, unknown> | null {
  if (entry.type !== 'user' && entry.type !== 'assistant') return null
  if (entry.isSidechain === true) return null

  const content = Array.isArray(entry.message?.content) ? entry.message.content : []
  const parts = content
    .map((block, i) => translateContentBlock(block, i))
    .filter((p): p is Record<string, unknown> => p !== null)

  return {
    id: entry.uuid ?? `entry-${Date.now()}`,
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
  const messages: unknown[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let entry: ClaudeJsonlEntry
    try {
      entry = JSON.parse(trimmed) as ClaudeJsonlEntry
    } catch {
      log.debug('Skipping malformed JSONL line', { line: trimmed.slice(0, 100) })
      continue
    }

    const translated = translateEntry(entry)
    if (translated) {
      messages.push(translated)
    }
  }

  log.info('Read Claude transcript', {
    filePath,
    totalLines: lines.length,
    messageCount: messages.length
  })

  return messages
}

// Export helpers for testing
export { translateEntry, translateContentBlock, extractTextFromContent }
export type { ClaudeJsonlEntry, ClaudeContentBlock }
