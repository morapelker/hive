import { writeFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { createLogger } from './logger'
import { logCodexLifecycleEvent } from './codex-debug-logger'
import { resolveCodexBinaryPath } from './codex-binary-resolver'
import { getCodexCliEnv } from './codex-cli-env'
import {
  TITLE_SYSTEM_PROMPT,
  TITLE_JSON_SCHEMA,
  TITLE_TIMEOUT_MS,
  MAX_MESSAGE_LENGTH,
  sanitizeTitle,
  extractTitleFromJSON,
  spawnCLI,
  SpawnCliError
} from './title-generation-shared'

const log = createLogger({ component: 'CodexSessionTitle' })
const MAX_LOG_PREVIEW = 300

function previewText(value: string, maxLength: number = MAX_LOG_PREVIEW): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength) + '...'
}

export async function generateCodexSessionTitle(
  message: string,
  worktreePath?: string,
  codexBinaryPath?: string | null
): Promise<string | null> {
  const truncatedMessage =
    message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) + '...' : message

  const prompt = TITLE_SYSTEM_PROMPT + '\n\nUser message:\n' + truncatedMessage
  const resolvedBinary = resolveCodexBinaryPath()
  const binary = codexBinaryPath || resolvedBinary || 'codex'
  const spawnEnv = getCodexCliEnv()

  const schemaFile = join(tmpdir(), `title-schema-${randomUUID()}.json`)
  const outputFile = join(tmpdir(), `title-output-${randomUUID()}.json`)
  const spawnArgs = [
    'exec',
    '--ephemeral',
    '-s',
    'read-only',
    '--model',
    'gpt-5.4-mini',
    '--config',
    'model_reasoning_effort="low"',
    '--output-schema',
    schemaFile,
    '--output-last-message',
    outputFile,
    '-'
  ]

  log.info('generateCodexSessionTitle: starting', {
    messageLength: message.length,
    promptLength: prompt.length,
    codexBinaryPath: codexBinaryPath ?? '(not provided)',
    resolvedBinary: resolvedBinary ?? '(null)',
    usingBinary: binary,
    worktreePath: worktreePath ?? '(not provided)',
    schemaFile,
    outputFile
  })
  logCodexLifecycleEvent('title/start', {
    cwd: worktreePath ?? null,
    messageLength: message.length,
    promptPreview: previewText(prompt)
  })

  try {
    await writeFile(schemaFile, TITLE_JSON_SCHEMA)
    await writeFile(outputFile, '')
    log.info('generateCodexSessionTitle: temp files initialized', {
      schemaFile,
      outputFile
    })

    log.info('generateCodexSessionTitle: spawning codex exec', {
      binary,
      argsPreview: spawnArgs.join(' '),
      worktreePath: worktreePath ?? '(not provided)'
    })
    await spawnCLI(binary, spawnArgs, prompt, TITLE_TIMEOUT_MS, worktreePath, spawnEnv)
    logCodexLifecycleEvent('title/spawn_success', {
      binary,
      cwd: worktreePath ?? null,
      outputFile
    })

    const content = await readFile(outputFile, 'utf-8')
    log.info('generateCodexSessionTitle: read output file', {
      outputLength: content.length,
      outputPreview: previewText(content)
    })
    logCodexLifecycleEvent('title/output_read', {
      cwd: worktreePath ?? null,
      outputLength: content.length,
      outputPreview: previewText(content)
    })

    const rawTitle = extractTitleFromJSON(content)
    log.info('generateCodexSessionTitle: extracted raw title', {
      rawTitle: rawTitle ?? null
    })
    if (!rawTitle) {
      log.warn('generateCodexSessionTitle: no title extracted from output', {
        outputPreview: previewText(content)
      })
      logCodexLifecycleEvent('title/extract_failed', {
        cwd: worktreePath ?? null,
        outputPreview: previewText(content)
      })
      return null
    }

    const title = sanitizeTitle(rawTitle)
    log.info('generateCodexSessionTitle: sanitized title', {
      rawTitle,
      title: title ?? null
    })
    if (!title) {
      log.warn('generateCodexSessionTitle: title sanitized to empty', { rawTitle })
      logCodexLifecycleEvent('title/sanitize_failed', {
        cwd: worktreePath ?? null,
        rawTitle: previewText(rawTitle)
      })
      return null
    }

    log.info('generateCodexSessionTitle: generated', { title })
    return title
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const lifecycleDetail: Record<string, unknown> = {
      cwd: worktreePath ?? null,
      error: errorMessage
    }

    if (err instanceof SpawnCliError) {
      lifecycleDetail.kind = err.kind
      lifecycleDetail.code = err.code ?? null
      lifecycleDetail.stdoutPreview = err.stdoutPreview ?? null
      lifecycleDetail.stderrPreview = err.stderrPreview ?? null
      lifecycleDetail.timeoutMs = err.timeoutMs ?? null
      lifecycleDetail.maxOutputBytes = err.maxOutputBytes ?? null
    }

    log.warn('generateCodexSessionTitle: failed', lifecycleDetail)
    logCodexLifecycleEvent('title/spawn_failure', lifecycleDetail)
    return null
  } finally {
    try { await unlink(schemaFile) } catch { /* ignore */ }
    try { await unlink(outputFile) } catch { /* ignore */ }
  }
}
