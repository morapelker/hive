/**
 * Codex (ChatGPT) account store — TypeScript port of ccswitch's
 * `src/store/codex.rs`. Source of truth for managed Codex account identities
 * and credentials. Interoperates on-disk with the `ccswitch` CLI tool and the
 * Codex CLI, so the file shapes here must match them exactly:
 *
 * - Managed index:   ${CODEX_HOME}/accounts/registry.json  (schema_version 3)
 * - Per-account snap: ${CODEX_HOME}/accounts/<base64(account_key)>.auth.json
 * - Live active:      ${CODEX_HOME}/auth.json
 */
import { unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteJson, readJsonFile } from './atomic-json'
import { jwtExpMs, parseCodexIdToken } from './jwt-utils'
import { createLogger } from './logger'
import type { CodexAuth } from './openai-usage-service'

export type { CodexAuth }

const log = createLogger({ component: 'AccountStoreCodex' })

export interface CodexStoreAccount {
  accountKey: string
  email: string
  plan: string | null
  expiresAtMs: number | null
  hasRefresh: boolean
  active: boolean
}

interface CodexRegistryAccountEntry {
  account_key: string
  chatgpt_account_id: string
  chatgpt_user_id: string
  email: string
  alias: string
  account_name: string | null
  plan: string | null
  auth_mode: string
  created_at: number
  last_used_at: number | null
}

interface CodexRegistry {
  schema_version: number
  active_account_key: string | null
  active_account_activated_at_ms?: number
  accounts: CodexRegistryAccountEntry[]
}

/** Same resolution as `openai-usage-service.ts`: env var first, else `~/.codex`. */
function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function accountsDir(): string {
  return join(codexHome(), 'accounts')
}

function registryPath(): string {
  return join(accountsDir(), 'registry.json')
}

function liveAuthPath(): string {
  return join(codexHome(), 'auth.json')
}

/** Standard base64 (`+`/`/` alphabet) of the account key, trailing `=` padding trimmed. */
export function snapshotName(accountKey: string): string {
  return Buffer.from(accountKey, 'utf-8').toString('base64').replace(/=+$/, '')
}

function snapshotPath(accountKey: string): string {
  return join(accountsDir(), `${snapshotName(accountKey)}.auth.json`)
}

function emptyRegistry(): CodexRegistry {
  return { schema_version: 3, active_account_key: null, accounts: [] }
}

/**
 * Read registry.json. Missing file => empty registry. A file that exists but
 * fails to parse throws (never silently treat a corrupt registry as empty
 * and then overwrite it).
 */
async function readRegistry(): Promise<CodexRegistry> {
  const path = registryPath()
  if (!existsSync(path)) return emptyRegistry()

  const data = await readJsonFile<Partial<CodexRegistry>>(path)
  if (data === null) {
    throw new Error(`${path}: invalid JSON`)
  }

  return {
    schema_version: typeof data.schema_version === 'number' ? data.schema_version : 3,
    active_account_key: typeof data.active_account_key === 'string' ? data.active_account_key : null,
    active_account_activated_at_ms:
      typeof data.active_account_activated_at_ms === 'number'
        ? data.active_account_activated_at_ms
        : undefined,
    accounts: Array.isArray(data.accounts) ? data.accounts : []
  }
}

async function writeRegistry(registry: CodexRegistry): Promise<void> {
  await atomicWriteJson(registryPath(), registry, { pretty: true })
}

/** Derive `<chatgpt_user_id>::<chatgpt_account_id>` from an auth blob's id_token, if possible. */
function deriveAccountKey(auth: CodexAuth | null): string | null {
  const idToken = auth?.tokens?.id_token
  if (typeof idToken !== 'string' || idToken.length === 0) return null
  const claims = parseCodexIdToken(idToken)
  if (!claims.userId || !claims.accountId) return null
  return `${claims.userId}::${claims.accountId}`
}

export async function readCodexSnapshot(accountKey: string): Promise<CodexAuth | null> {
  return readJsonFile<CodexAuth>(snapshotPath(accountKey))
}

export async function readCodexLive(): Promise<CodexAuth | null> {
  return readJsonFile<CodexAuth>(liveAuthPath())
}

/** List all managed Codex accounts. */
export async function listCodexAccounts(): Promise<CodexStoreAccount[]> {
  const registry = await readRegistry()
  const live = await readCodexLive()
  const derivedLiveKey = deriveAccountKey(live)
  const liveAccountKey = derivedLiveKey ?? registry.active_account_key

  const out: CodexStoreAccount[] = []
  for (const entry of registry.accounts) {
    const accountKey = entry.account_key
    if (!accountKey) continue

    const active = accountKey === liveAccountKey
    const snapshot = active && live ? live : await readCodexSnapshot(accountKey)
    const accessToken = snapshot?.tokens?.access_token
    const refreshToken = snapshot?.tokens?.refresh_token

    out.push({
      accountKey,
      email: (entry.email ?? '').toLowerCase(),
      plan: entry.plan ?? null,
      expiresAtMs: typeof accessToken === 'string' ? jwtExpMs(accessToken) : null,
      hasRefresh: typeof refreshToken === 'string' && refreshToken.length > 0,
      active
    })
  }
  return out
}

/**
 * Patch rotated tokens into a snapshot (access always; refresh/id only when
 * provided), and mirror the full patched snapshot to live auth.json when
 * this account is the registry's active account.
 */
export async function updateCodexTokens(
  accountKey: string,
  rotated: { accessToken: string; refreshToken?: string; idToken?: string }
): Promise<void> {
  const existing = await readCodexSnapshot(accountKey)
  if (!existing) {
    throw new Error(`No Codex snapshot for account ${accountKey}`)
  }

  const existingTokens = existing.tokens
  const tokens = {
    id_token: existingTokens?.id_token,
    access_token: existingTokens?.access_token ?? '',
    refresh_token: existingTokens?.refresh_token ?? '',
    account_id: existingTokens?.account_id ?? ''
  }
  tokens.access_token = rotated.accessToken
  if (rotated.refreshToken !== undefined) tokens.refresh_token = rotated.refreshToken
  if (rotated.idToken !== undefined) tokens.id_token = rotated.idToken

  const patched: CodexAuth = { ...existing, tokens, last_refresh: new Date().toISOString() }
  await atomicWriteJson(snapshotPath(accountKey), patched, { pretty: true })

  const registry = await readRegistry()
  if (registry.active_account_key === accountKey) {
    await atomicWriteJson(liveAuthPath(), patched, { pretty: true })
  }
}

/** Port of ccswitch `switch_to`: makes `accountKey` the live active Codex account. */
export async function switchCodexAccount(accountKey: string): Promise<void> {
  const registry = await readRegistry()
  const live = await readCodexLive()

  // 1) Preserve the outgoing account's live auth.json (which the Codex CLI
  //    may have refreshed in place) into its own snapshot before overwriting.
  const outgoingKey = deriveAccountKey(live)
  if (outgoingKey !== null && outgoingKey !== accountKey && live !== null) {
    await atomicWriteJson(snapshotPath(outgoingKey), live, { pretty: true })
  }

  // 2) Copy the target snapshot over live auth.json.
  const target = await readCodexSnapshot(accountKey)
  if (!target) {
    throw new Error(`No Codex snapshot for account ${accountKey}`)
  }
  await atomicWriteJson(liveAuthPath(), target, { pretty: true })

  // 3) Update the registry's active account.
  registry.active_account_key = accountKey
  registry.active_account_activated_at_ms = Date.now()
  await writeRegistry(registry)
}

/** Register a new (or re-registered) Codex account from an interactive login. */
export async function addCodexAccount(
  idToken: string,
  accessToken: string,
  refreshToken: string
): Promise<{ accountKey: string; email: string }> {
  const claims = parseCodexIdToken(idToken)
  if (!claims.userId || !claims.accountId) {
    throw new Error('Codex id_token is missing chatgpt_user_id or chatgpt_account_id')
  }
  const accountKey = `${claims.userId}::${claims.accountId}`
  const email = claims.email ?? ''

  const auth: CodexAuth = {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: claims.accountId
    },
    last_refresh: new Date().toISOString()
  }
  await atomicWriteJson(snapshotPath(accountKey), auth, { pretty: true })

  const registry = await readRegistry()
  const existingIndex = registry.accounts.findIndex((a) => a.account_key === accountKey)
  if (existingIndex >= 0) {
    const existing = registry.accounts[existingIndex]
    registry.accounts[existingIndex] = {
      ...existing,
      email,
      plan: claims.plan ?? existing.plan ?? null
    }
  } else {
    registry.accounts.push({
      account_key: accountKey,
      chatgpt_account_id: claims.accountId,
      chatgpt_user_id: claims.userId,
      email,
      alias: '',
      account_name: null,
      plan: claims.plan ?? null,
      auth_mode: 'chatgpt',
      created_at: Date.now(),
      last_used_at: null
    })
  }
  await writeRegistry(registry)

  return { accountKey, email }
}

/** Remove a managed account. Never touches auth.json. */
export async function removeCodexAccount(accountKey: string): Promise<void> {
  try {
    await unlink(snapshotPath(accountKey))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('Failed to delete Codex account snapshot', {
        accountKey,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  const registry = await readRegistry()
  registry.accounts = registry.accounts.filter((a) => a.account_key !== accountKey)
  if (registry.active_account_key === accountKey) {
    registry.active_account_key = null
  }
  await writeRegistry(registry)
}
