import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger'
import { decodeJwtPayload } from './jwt-utils'

const log = createLogger({ component: 'AccountService' })

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')

/**
 * Get the Claude account email from ~/.claude.json.
 * Reads oauthAccount.emailAddress from the file.
 */
export async function getClaudeAccountEmail(): Promise<string | null> {
  const claudePath = join(homedir(), '.claude.json')
  if (!existsSync(claudePath)) {
    return null
  }
  try {
    const raw = await readFile(claudePath, 'utf-8')
    const data = JSON.parse(raw)
    const email = data?.oauthAccount?.emailAddress
    if (typeof email !== 'string' || email.length === 0) {
      log.warn('Claude account email missing or invalid in config file')
      return null
    }
    return email
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Failed to read Claude account email', { error: message })
    return null
  }
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
