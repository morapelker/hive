import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadClaudeSDK } from './claude-sdk-loader'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeSessionTitle' })

const TITLE_PROMPT = `You are a title generator. Given a user's coding message, output a short title (2-5 words max).
Rules:
- Be specific and concrete (e.g. "Fix auth token refresh", "Add dark mode toggle")
- No quotes, no punctuation at the end, no prefixes like "Title:"
- Use sentence case (capitalize first word only, plus proper nouns)
- Output ONLY the title text, nothing else

Message:
`

const TITLE_TIMEOUT_MS = 15_000
const MAX_MESSAGE_LENGTH = 2000
const MAX_TITLE_LENGTH = 50

const titlesDir = join(homedir(), '.hive', 'titles')

/**
 * Use the Claude Agent SDK with Haiku model to generate a short session title.
 * Returns the generated title, or null if generation fails for any reason.
 *
 * @param message - The user's first message to derive a title from
 * @param claudeBinaryPath - Optional path to the Claude CLI binary (for ASAR compatibility)
 */
export async function generateSessionTitle(
  message: string,
  claudeBinaryPath?: string | null
): Promise<string | null> {
  const truncatedMessage =
    message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) + '...' : message

  const fullPrompt = TITLE_PROMPT + truncatedMessage

  try {
    mkdirSync(titlesDir, { recursive: true })

    const sdk = await loadClaudeSDK()

    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), TITLE_TIMEOUT_MS)

    try {
      const query = sdk.query({
        prompt: fullPrompt,
        options: {
          cwd: titlesDir,
          model: 'haiku',
          maxTurns: 1,
          abortController,
          ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {})
        }
      })

      let resultText = ''
      for await (const msg of query) {
        if (msg.type === 'result') {
          resultText = (msg as any).result ?? ''
          break
        }
      }

      clearTimeout(timeout)

      const title = resultText.trim()
      if (!title) {
        log.warn('generateSessionTitle: empty title from SDK')
        return null
      }

      if (title.length > MAX_TITLE_LENGTH) {
        log.warn('generateSessionTitle: title too long', {
          titleLength: title.length,
          titlePreview: title.slice(0, 50)
        })
        return null
      }

      log.info('generateSessionTitle: generated', { title })
      return title
    } catch (err: unknown) {
      clearTimeout(timeout)
      throw err
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('generateSessionTitle: SDK query failed', {
      error: message
    })
    return null
  }
}
