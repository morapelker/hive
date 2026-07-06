import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger'
import { decodeJwtPayload } from './jwt-utils'
import { readClaudeLiveIdentity } from './account-store-claude'

const log = createLogger({ component: 'AccountService' })

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')

/**
 * Get the currently-live Claude account email.
 *
 * Delegates to the account store's `readClaudeLiveIdentity()` so this uses the
 * SAME identity seam as everything else: it prefers the nested
 * `~/.claude/.claude.json` (ccswitch's primary, which `switchClaudeAccount`
 * writes) over the top-level `~/.claude.json`. Lowercased so the renderer's
 * Active-badge comparison against the lowercased DTO emails works even for
 * mixed-case accounts. Reading only the verbatim top-level file (as this used
 * to) left the badge stuck on the pre-switch account.
 */
export async function getClaudeAccountEmail(): Promise<string | null> {
  const { email } = await readClaudeLiveIdentity()
  if (typeof email !== 'string' || email.length === 0) {
    return null
  }
  return email.toLowerCase()
}

/**
 * Get the OpenAI account email from ${CODEX_HOME}/auth.json.
 * Decodes the id_token JWT payload and reads the email claim.
 */
export async function getOpenAIAccountEmail(): Promise<string | null> {
  const authPath = join(CODEX_HOME, 'auth.json')
  if (!existsSync(authPath)) {
    return null
  }
  try {
    const raw = await readFile(authPath, 'utf-8')
    const data = JSON.parse(raw)
    const idToken = data?.tokens?.id_token
    if (typeof idToken !== 'string' || idToken.length === 0) {
      log.warn('OpenAI id_token missing or invalid in auth file')
      return null
    }
    const payload = decodeJwtPayload(idToken)
    if (!payload) {
      log.warn('Failed to decode OpenAI id_token JWT payload')
      return null
    }
    const email = payload.email
    if (typeof email !== 'string' || email.length === 0) {
      log.warn('OpenAI account email missing or invalid in JWT payload')
      return null
    }
    return email
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Failed to read OpenAI account email', { error: message })
    return null
  }
}
