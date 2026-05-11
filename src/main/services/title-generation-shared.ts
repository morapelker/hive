import { Effect } from 'effect'
import { createLogger } from './logger'
import { maybeExtractJsonTitle } from '@shared/title-utils'
import {
  SpawnFailed,
  SpawnNonZeroExit,
  SpawnOutputCapExceeded,
  SpawnSignalled,
  SpawnTimeout
} from '../effect/spawn/errors'
import { getRuntime } from '../effect/spawn/runtime'
import { Spawn } from '../effect/spawn/service'

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
export type SpawnCliFailureKind =
  | 'timeout'
  | 'stdout_too_large'
  | 'stderr_too_large'
  | 'spawn_error'
  | 'non_zero_exit'

export class SpawnCliError extends Error {
  readonly kind: SpawnCliFailureKind
  readonly command: string
  readonly code?: number | null
  readonly stdoutPreview?: string
  readonly stderrPreview?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly cwd?: string

  constructor(
    message: string,
    detail: {
      kind: SpawnCliFailureKind
      command: string
      code?: number | null
      stdoutPreview?: string
      stderrPreview?: string
      timeoutMs?: number
      maxOutputBytes?: number
      cwd?: string
    }
  ) {
    super(message)
    this.name = 'SpawnCliError'
    this.kind = detail.kind
    this.command = detail.command
    this.code = detail.code
    this.stdoutPreview = detail.stdoutPreview
    this.stderrPreview = detail.stderrPreview
    this.timeoutMs = detail.timeoutMs
    this.maxOutputBytes = detail.maxOutputBytes
    this.cwd = detail.cwd
  }
}

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
  timeoutMs: number = TITLE_TIMEOUT_MS,
  cwd?: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  log.info('spawnCLI: starting', {
    command,
    argCount: args.length,
    inputLength: input.length,
    timeoutMs,
    cwd
  })
  return getRuntime()
    .runPromise(
      Effect.flatMap(Spawn, (spawn) =>
        spawn.runOnce({
          command,
          args,
          stdin: input,
          timeout: timeoutMs,
          maxOutputBytes: MAX_OUTPUT_SIZE,
          collectStderr: true,
          env: env ?? process.env,
          cwd
        })
      )
    )
    .then((result) => {
      log.info('spawnCLI: success', { command, stdoutLength: result.stdout.length })
      return result.stdout
    })
    .catch((error: unknown) => {
      throw toSpawnCliError(error, command, cwd)
    })
}

function toSpawnCliError(error: unknown, command: string, cwd?: string): SpawnCliError {
  if (error instanceof SpawnTimeout) {
    return new SpawnCliError(`${command} timed out after ${error.durationMs}ms`, {
      kind: 'timeout',
      command,
      stdoutPreview: error.stdoutPreview,
      stderrPreview: error.stderrPreview,
      timeoutMs: error.durationMs,
      cwd
    })
  }

  if (error instanceof SpawnOutputCapExceeded) {
    const kind = error.stream === 'stdout' ? 'stdout_too_large' : 'stderr_too_large'
    return new SpawnCliError(`${command} ${error.stream} exceeded ${error.limit} bytes`, {
      kind,
      command,
      maxOutputBytes: error.limit,
      cwd
    })
  }

  if (error instanceof SpawnNonZeroExit) {
    log.warn('spawnCLI: non-zero exit', {
      command,
      code: error.exitCode,
      stdoutPreview: error.stdoutPreview,
      stderrPreview: error.stderrPreview
    })
    return new SpawnCliError(`${command} exited with code ${error.exitCode}: ${error.stderrPreview}`, {
      kind: 'non_zero_exit',
      command,
      code: error.exitCode,
      stdoutPreview: error.stdoutPreview,
      stderrPreview: error.stderrPreview,
      cwd
    })
  }

  if (error instanceof SpawnFailed) {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
    log.warn('spawnCLI: spawn error', { command, error: cause })
    return new SpawnCliError(`Failed to spawn ${command}: ${cause}`, {
      kind: 'spawn_error',
      command,
      cwd
    })
  }

  if (error instanceof SpawnSignalled) {
    return new SpawnCliError(`${command} exited from signal ${error.signal ?? 'unknown'}`, {
      kind: 'spawn_error',
      command,
      stdoutPreview: error.stdoutPreview,
      stderrPreview: error.stderrPreview,
      cwd
    })
  }

  const message = error instanceof Error ? error.message : String(error)
  return new SpawnCliError(`Failed to spawn ${command}: ${message}`, {
    kind: 'spawn_error',
    command,
    cwd
  })
}
