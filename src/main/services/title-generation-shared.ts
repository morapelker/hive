import { spawn } from 'node:child_process'
import { createLogger } from './logger'
import { maybeExtractJsonTitle } from '@shared/title-utils'

const log = createLogger({ component: 'TitleGenerationShared' })

// ── Constants ─────────────────────────────────────────────────────────

export const TITLE_SYSTEM_PROMPT = `You write concise thread titles for coding conversations.
Return a JSON object with key: title.

Rules:
- Title should summarize the user's request, not restate it verbatim.
- Keep it short and specific (3-8 words).
- Use the same language as the user message.
- Keep exact: technical terms, numbers, filenames, HTTP codes.
- Avoid quotes, filler, prefixes, and trailing punctuation.
- Never include tool names (e.g. "read tool", "bash tool").
- If the input is minimal (e.g. "hello"), return a contextual title like "Quick greeting".`

export const TITLE_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false
})

export const TITLE_TIMEOUT_MS = 30_000

export const MAX_MESSAGE_LENGTH = 2000

const MAX_OUTPUT_SIZE = 1024 * 1024 // 1 MB

const MAX_SANITIZED_LENGTH = 50

// ── sanitizeTitle ─────────────────────────────────────────────────────

/**
 * T3 Code-style sanitizer: first line only, strip quotes/backticks,
 * normalize whitespace, truncate at 50 chars.
 * Returns null if the result is empty.
 */
export function sanitizeTitle(raw: string): string | null {
  // If the title value is itself a JSON string with a "title" field, extract it.
  // This handles cases where the model double-wraps: structured_output.title = '{"title": "..."}'
  let title = maybeExtractJsonTitle(raw)

  // First line only
  title = title.split('\n')[0] ?? ''

  // Strip surrounding quotes and backticks
  title = title.replace(/^[`"']+|[`"']+$/g, '')

  // Normalize whitespace
  title = title.replace(/\s+/g, ' ').trim()

  if (!title) return null

  // Truncate at 50 chars with ellipsis
  if (title.length > MAX_SANITIZED_LENGTH) {
    return title.slice(0, MAX_SANITIZED_LENGTH) + '...'
  }

  return title
}

// ── extractTitleFromJSON ──────────────────────────────────────────────

/**
 * Parse title from CLI JSON output.
 * Tries multiple formats: Claude -p envelope, direct JSON, embedded JSON.
 */
export function extractTitleFromJSON(response: string): string | null {
  const trimmed = response.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed)

    // 1. Claude `-p` envelope: { result: "...", structured_output: { title } }
    if (parsed?.structured_output?.title) {
      return String(parsed.structured_output.title)
    }

    // 2. Direct JSON: { title: "..." }
    if (parsed?.title) {
      return String(parsed.title)
    }

    // 3. Nested result string: { result: "{\"title\":\"...\"}" }
    if (typeof parsed?.result === 'string') {
      try {
        const inner = JSON.parse(parsed.result)
        if (inner?.title) {
          return String(inner.title)
        }
      } catch {
        // result wasn't JSON, ignore
      }
    }
  } catch {
    // Not valid JSON at top level — try to find embedded JSON
  }

  // 4. Fallback: find { ... } in text and try to parse
  const match = trimmed.match(/\{[^}]*"title"\s*:\s*"[^"]*"[^}]*\}/)
  if (match) {
    try {
      const embedded = JSON.parse(match[0])
      if (embedded?.title) {
        return String(embedded.title)
      }
    } catch {
      // Couldn't parse embedded JSON
    }
  }

  return null
}

// ── spawnCLI ──────────────────────────────────────────────────────────

/**
 * Spawn a CLI command with stdin input and collect stdout.
 * Reuses the proven spawnWithStdin pattern from text-generation-router.ts.
 */
export function spawnCLI(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number = TITLE_TIMEOUT_MS
): Promise<string> {
  log.info('spawnCLI: starting', { command, argCount: args.length, inputLength: input.length, timeoutMs })
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    const timeout = setTimeout(() => {
      if (!killed) {
        killed = true
        proc.kill('SIGKILL')
        reject(new Error(`${command} timed out after ${timeoutMs}ms`))
      }
    }, timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > MAX_OUTPUT_SIZE) {
        killed = true
        proc.kill('SIGKILL')
        clearTimeout(timeout)
        reject(new Error(`${command} stdout exceeded ${MAX_OUTPUT_SIZE} bytes`))
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_OUTPUT_SIZE) {
        killed = true
        proc.kill('SIGKILL')
        clearTimeout(timeout)
        reject(new Error(`${command} stderr exceeded ${MAX_OUTPUT_SIZE} bytes`))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      log.warn('spawnCLI: spawn error', { command, error: err.message })
      reject(new Error(`Failed to spawn ${command}: ${err.message}`))
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (killed) return
      if (code === 0) {
        log.info('spawnCLI: success', { command, stdoutLength: stdout.length })
        resolve(stdout)
      } else {
        log.warn('spawnCLI: non-zero exit', { command, code, stderr: stderr.slice(0, 500) })
        reject(new Error(`${command} exited with code ${code}: ${stderr.slice(0, 500)}`))
      }
    })

    proc.stdin?.end(input)
  })
}
