/**
 * Account share links — export a saved Claude/Codex account as a one-time
 * `hive://share-account` link, and import one on another machine.
 *
 * Security model: the account credential blob is encrypted here (AES-256-GCM)
 * with a random key that only ever travels inside the link itself. The
 * hive-enterprise server stores just the ciphertext behind an unguessable
 * one-time token and deletes it on claim — it can never read the credentials.
 *
 * The whole flow requires a connected Hive Enterprise account on BOTH sides:
 * creating a share needs the renderer's authenticated GraphQL client, and
 * claiming (below) requires this machine to be logged in to the SAME server
 * the link points at — the claim mutation itself is authenticated, and the
 * server-match check ensures our JWT is never sent to a foreign host named
 * by a crafted link.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { getDatabase } from '../db'
import {
  addClaudeAccount,
  listClaudeAccounts,
  readClaudeEffectiveBlob
} from './account-store-claude'
import {
  addCodexAccount,
  listCodexAccounts,
  readCodexEffectiveAuth,
  type CodexAuth
} from './account-store-codex'
import { createLogger } from './logger'
import { SHARE_ACCOUNT_LINK_HOST } from '../../shared/account-share-link'
import { APP_SETTINGS_DB_KEY } from '../../shared/types/settings'
import type { UsageProvider } from '@shared/types/usage'

const log = createLogger({ component: 'AccountShareService' })

interface SharePayloadV1 {
  v: 1
  provider: UsageProvider
  email: string
  /** anthropic: the raw Keychain credential blob JSON + identity uuid. */
  claude?: { uuid: string; blobJson: string }
  /** openai: the full auth.json snapshot. */
  codex?: { auth: CodexAuth }
}

// ── AES-256-GCM link crypto ──────────────────────────────────────────
// Ciphertext layout: base64( iv(12) || authTag(16) || data ). Key: base64url(32).

export function encryptSharePayload(plaintext: string): { key: string; ciphertext: string } {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const ciphertext = Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
  return { key: key.toString('base64url'), ciphertext }
}

export function decryptSharePayload(keyB64url: string, ciphertextB64: string): string {
  const key = Buffer.from(keyB64url, 'base64url')
  if (key.length !== 32) throw new Error('Share link has an invalid encryption key')
  const raw = Buffer.from(ciphertextB64, 'base64')
  if (raw.length < 12 + 16 + 1) throw new Error('Share payload is malformed')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf-8')
}

// ── Export (source machine) ──────────────────────────────────────────

export interface ExportedAccountShare {
  provider: UsageProvider
  email: string
  /** AES-256-GCM ciphertext of the share payload; safe to hand to the server. */
  encryptedPayload: string
  /** base64url key for the link. NEVER send this to the server. */
  key: string
}

/**
 * Read a saved account's effective credentials and seal them for sharing.
 * The caller uploads `encryptedPayload` to hive-enterprise and builds the
 * link from the returned token + `key`.
 */
export async function exportAccountShare(accountId: string): Promise<ExportedAccountShare> {
  const row = getDatabase().getSavedUsageAccountById(accountId)
  if (!row) throw new Error('Account not found')

  let payload: SharePayloadV1
  if (row.provider === 'anthropic') {
    const email = row.email.toLowerCase()
    const account = (await listClaudeAccounts()).find((a) => a.email === email)
    if (!account) throw new Error('Account is no longer in the Claude account store')
    const blob = await readClaudeEffectiveBlob(account.num, account.email)
    if (!blob) throw new Error('No stored credentials for this Claude account')
    payload = { v: 1, provider: 'anthropic', email, claude: { uuid: account.uuid, blobJson: blob.raw } }
  } else {
    const email = row.email.toLowerCase()
    const account = (await listCodexAccounts()).find((a) => a.email === email)
    if (!account) throw new Error('Account is no longer in the Codex account store')
    const auth = await readCodexEffectiveAuth(account.accountKey)
    if (!auth?.tokens?.id_token || !auth.tokens.access_token || !auth.tokens.refresh_token) {
      throw new Error('No complete credentials for this OpenAI account')
    }
    payload = { v: 1, provider: 'openai', email, codex: { auth } }
  }

  const { key, ciphertext } = encryptSharePayload(JSON.stringify(payload))
  return { provider: payload.provider, email: payload.email, encryptedPayload: ciphertext, key }
}

// ── Import (target machine) ──────────────────────────────────────────

export interface ImportedAccountShare {
  provider: UsageProvider
  email: string
}

export function isShareAccountLink(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'hive:' && parsed.host === SHARE_ACCOUNT_LINK_HOST
  } catch {
    return false
  }
}

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * This machine's Hive Enterprise connection, read from the persisted app
 * settings (the renderer's settings store writes them to the same DB).
 * Throws when the machine is not logged in — importing a shared account is
 * only available with a connected enterprise account.
 */
function readHiveEnterpriseConnection(): { serverUrl: string; authToken: string } {
  let settings: { hiveEnterpriseServerUrl?: unknown; hiveAuthToken?: unknown } = {}
  try {
    const raw = getDatabase().getSetting(APP_SETTINGS_DB_KEY)
    if (raw) settings = JSON.parse(raw) as typeof settings
  } catch (error) {
    log.warn('Failed to read app settings for share import', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
  const serverUrl =
    typeof settings.hiveEnterpriseServerUrl === 'string' ? settings.hiveEnterpriseServerUrl : ''
  const authToken = typeof settings.hiveAuthToken === 'string' ? settings.hiveAuthToken : ''
  if (!serverUrl || !authToken) {
    throw new Error(
      'This computer is not connected to Hive Enterprise. Sign in under Settings → Hive Enterprise, then try the share link again.'
    )
  }
  return { serverUrl, authToken }
}

const CLAIM_ACCOUNT_SHARE_MUTATION = /* GraphQL */ `
  mutation ClaimAccountShare($token: String!) {
    claimAccountShare(token: $token) {
      provider
      encryptedPayload
    }
  }
`

async function claimFromServer(
  serverUrl: string,
  token: string,
  authToken: string
): Promise<string> {
  const endpoint = `${serverUrl.replace(/\/+$/, '')}/api/graphql`
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ query: CLAIM_ACCOUNT_SHARE_MUTATION, variables: { token } })
    })
  } catch (error) {
    throw new Error(
      `Could not reach ${serverUrl}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!response.ok) {
    throw new Error(`Share server responded with HTTP ${response.status}`)
  }
  const body = (await response.json()) as {
    data?: { claimAccountShare?: { provider: string; encryptedPayload: string } | null }
    errors?: Array<{ message?: string }>
  }
  if (body.errors?.length) {
    throw new Error(body.errors[0]?.message ?? 'Share claim failed')
  }
  const claimed = body.data?.claimAccountShare
  if (!claimed) {
    throw new Error('This share link was already used or has expired')
  }
  return claimed.encryptedPayload
}

function parseSharePayload(json: string): SharePayloadV1 {
  let payload: SharePayloadV1
  try {
    payload = JSON.parse(json) as SharePayloadV1
  } catch {
    throw new Error('Decrypted share payload is not valid JSON')
  }
  if (payload.v !== 1 || !payload.email) {
    throw new Error('Unsupported share payload')
  }
  return payload
}

/**
 * Claim a share link end-to-end: fetch the one-time ciphertext from the
 * server in the link, decrypt it with the key from the link, and register
 * the account in the local Claude/Codex store. The server row is deleted by
 * the claim itself, so a second use of the same link fails.
 */
export async function importAccountShareFromLink(url: string): Promise<ImportedAccountShare> {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new Error('Not a valid share link')
  }
  if (parsed.protocol !== 'hive:' || parsed.host !== SHARE_ACCOUNT_LINK_HOST) {
    throw new Error('Not a Hive account share link')
  }
  const serverUrl = parsed.searchParams.get('server')
  const token = parsed.searchParams.get('token')
  const key = parsed.searchParams.get('key')
  if (!serverUrl || !token || !key) {
    throw new Error('Share link is missing required parameters')
  }

  // Only claim against the enterprise server this machine is logged in to.
  // Besides enforcing "share links need enterprise set up", this guarantees
  // the auth token below is never sent to a host a crafted link chose.
  const connection = readHiveEnterpriseConnection()
  if (normalizeServerUrl(serverUrl) !== normalizeServerUrl(connection.serverUrl)) {
    throw new Error(
      `This share link is for ${serverUrl}, but this computer is connected to ${connection.serverUrl}.`
    )
  }

  const encryptedPayload = await claimFromServer(connection.serverUrl, token, connection.authToken)
  const payload = parseSharePayload(decryptSharePayload(key, encryptedPayload))

  if (payload.provider === 'anthropic') {
    if (!payload.claude?.blobJson) throw new Error('Share payload is missing Claude credentials')
    await addClaudeAccount(payload.email, payload.claude.uuid ?? '', payload.claude.blobJson)
  } else if (payload.provider === 'openai') {
    const tokens = payload.codex?.auth?.tokens
    if (!tokens?.access_token || !tokens.refresh_token || typeof tokens.id_token !== 'string') {
      throw new Error('Share payload is missing OpenAI credentials')
    }
    await addCodexAccount(tokens.id_token, tokens.access_token, tokens.refresh_token)
  } else {
    throw new Error(`Unknown share provider: ${String(payload.provider)}`)
  }

  log.info('Imported shared account', { provider: payload.provider, email: payload.email })
  return { provider: payload.provider, email: payload.email }
}
