import { writeFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { createLogger } from './logger'
import {
  TITLE_SYSTEM_PROMPT,
  TITLE_JSON_SCHEMA,
  TITLE_TIMEOUT_MS,
  MAX_MESSAGE_LENGTH,
  sanitizeTitle,
  extractTitleFromJSON,
  spawnCLI
} from './title-generation-shared'

const log = createLogger({ component: 'CodexSessionTitle' })

export async function generateCodexSessionTitle(
  message: string,
  _worktreePath?: string
): Promise<string | null> {
  const truncatedMessage =
    message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) + '...' : message

  const prompt = TITLE_SYSTEM_PROMPT + '\n\nUser message:\n' + truncatedMessage

  const schemaFile = join(tmpdir(), `title-schema-${randomUUID()}.json`)
  const outputFile = join(tmpdir(), `title-output-${randomUUID()}.json`)

  try {
    await writeFile(schemaFile, TITLE_JSON_SCHEMA)
    await writeFile(outputFile, '')

    await spawnCLI(
      'codex',
      [
        'exec',
        '--ephemeral',
        '-s',
        'read-only',
        '--model',
        'gpt-5.4',
        '--config',
        'model_reasoning_effort="low"',
        '--output-schema',
        schemaFile,
        '--output-last-message',
        outputFile,
        '-'
      ],
      prompt,
      TITLE_TIMEOUT_MS
    )

    const content = await readFile(outputFile, 'utf-8')
    const rawTitle = extractTitleFromJSON(content)
    if (!rawTitle) {
      log.warn('generateCodexSessionTitle: no title extracted from output')
      return null
    }

    const title = sanitizeTitle(rawTitle)
    if (title) {
      log.info('generateCodexSessionTitle: generated', { title })
    }
    return title
  } catch (err) {
    log.warn('generateCodexSessionTitle: failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  } finally {
    try { await unlink(schemaFile) } catch { /* ignore */ }
    try { await unlink(outputFile) } catch { /* ignore */ }
  }
}
