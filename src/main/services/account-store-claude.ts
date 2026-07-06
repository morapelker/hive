/**
 * Claude account store — TypeScript port of ccswitch's `src/store/claude.rs`.
 *
 * This is the source of truth for managed Claude account identities and
 * credentials. It interoperates on-disk/in-Keychain with the `ccswitch` CLI
 * tool, so the file/Keychain shapes here must match it byte-for-byte:
 *
 * - Managed index:    ~/.claude-switch-backup/sequence.json
 * - Per-account creds: macOS Keychain "Claude Code-Account-{num}-{email}"
 * - Live active creds: macOS Keychain "Claude Code-credentials"
 * - Live active oauth: ~/.claude/.claude.json (preferred) or ~/.claude.json
 */
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { keychainDelete, keychainRead, keychainWrite } from './keychain'
import { atomicWriteJson, readJsonFile } from './atomic-json'
import { createLogger } from './logger'

const log = createLogger({ component: 'AccountStoreClaude' })

export const LIVE_CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** The `claudeAiOauth` inner object, as stored in every Keychain credential blob. */
export interface ClaudeOauthBlob {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scopes?: string[]
  subscriptionType?: string
  [key: string]: unknown
}

/** The full Keychain credential blob shape: `{ "claudeAiOauth": {...} }` plus unknown fields. */
interface ClaudeCredentialBlob {
  claudeAiOauth?: ClaudeOauthBlob
  [key: string]: unknown
}

interface SequenceAccountEntry {
  email: string
  uuid: string
  added: string
}

interface SequenceFile {
  activeAccountNumber: number | null
  lastUpdated: string
  sequence: number[]
  accounts: Record<string, SequenceAccountEntry>
}

export interface ClaudeStoreAccount {
  num: string
  email: string
  uuid: string
  expiresAtMs: number | null
  hasRefresh: boolean
  plan: string | null
  active: boolean
}

function backupDir(): string {
  return join(homedir(), '.claude-switch-backup')
}

function sequencePath(): string {
  return join(backupDir(), 'sequence.json')
}

/** `~/.claude/.claude.json` when it exists, else `~/.claude.json`. */
function claudeJsonPath(): string {
  const nested = join(homedir(), '.claude', '.claude.json')
  if (existsSync(nested)) return nested
  return join(homedir(), '.claude.json')
}

function accountService(num: string, email: string): string {
  return `Claude Code-Account-${num}-${email}`
}

function emptySequence(): SequenceFile {
  return { activeAccountNumber: null, lastUpdated: new Date().toISOString(), sequence: [], accounts: {} }
}

/**
 * Read sequence.json. Missing file => empty index. A file that exists but
 * fails to parse throws (we never want to silently treat a corrupt index as
 * "no accounts" and then overwrite it with an empty one).
 */
async function readSequence(): Promise<SequenceFile> {
  const path = sequencePath()
  if (!existsSync(path)) return emptySequence()

  const raw = await readFile(path, 'utf-8')
  let data: Partial<SequenceFile>
  try {
    data = JSON.parse(raw) as Partial<SequenceFile>
  } catch (error) {
    throw new Error(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    )
  }

  return {
    activeAccountNumber: typeof data.activeAccountNumber === 'number' ? data.activeAccountNumber : null,
    lastUpdated: typeof data.lastUpdated === 'string' ? data.lastUpdated : new Date().toISOString(),
    sequence: Array.isArray(data.sequence) ? data.sequence : [],
    accounts:
      data.accounts && typeof data.accounts === 'object' && !Array.isArray(data.accounts)
        ? data.accounts
        : {}
  }
}

async function writeSequence(seq: SequenceFile): Promise<void> {
  await atomicWriteJson(sequencePath(), seq, { pretty: true })
}

function findNumByEmail(seq: SequenceFile, email: string): string | null {
  const target = email.toLowerCase()
  for (const [num, acct] of Object.entries(seq.accounts)) {
    if ((acct.email ?? '').toLowerCase() === target) return num
  }
  return null
}

function nextNumber(seq: SequenceFile): number {
  const nums = Object.keys(seq.accounts)
    .map((k) => Number.parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
  const max = nums.length > 0 ? Math.max(...nums) : 0
  return max + 1
}

/** Read+parse a Keychain credential blob, tolerating a missing or corrupt entry (=> null). */
async function readKeychainBlob(
  service: string
): Promise<{ raw: string; parsed: ClaudeOauthBlob } | null> {
  const raw = await keychainRead(service)
  if (raw === null) return null
  try {
    const full = JSON.parse(raw) as ClaudeCredentialBlob
    return { raw, parsed: full.claudeAiOauth ?? {} }
  } catch (error) {
    log.warn('Failed to parse Claude Keychain credential blob', {
      service,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

/** The currently-live Keychain credential blob ("Claude Code-credentials"). */
async function readLiveBlob(): Promise<{ raw: string; parsed: ClaudeOauthBlob } | null> {
  return readKeychainBlob(LIVE_CLAUDE_KEYCHAIN_SERVICE)
}

/** The per-account backup Keychain credential blob. */
export async function readClaudeAccountBlob(
  num: string,
  email: string
): Promise<{ raw: string; parsed: ClaudeOauthBlob } | null> {
  return readKeychainBlob(accountService(num, email))
}

/**
 * Effective credentials for an account: the live Keychain blob when this
 * account is currently active (its real, freshest tokens live there),
 * otherwise the per-account backup blob.
 */
export async function readClaudeEffectiveBlob(
  num: string,
  email: string
): Promise<{ raw: string; parsed: ClaudeOauthBlob } | null> {
  const liveEmail = await readClaudeLiveEmail()
  if (liveEmail !== null && liveEmail === email.toLowerCase()) {
    const live = await readLiveBlob()
    if (live) return live
  }
  return readClaudeAccountBlob(num, email)
}

/** `oauthAccount.emailAddress` from the identity file, lowercased. Tolerant of missing/corrupt files. */
export async function readClaudeLiveEmail(): Promise<string | null> {
  const identity = await readClaudeLiveIdentity()
  return identity.email !== null ? identity.email.toLowerCase() : null
}

/** `oauthAccount.{emailAddress,accountUuid}` from the identity file, as stored (no case change). */
export async function readClaudeLiveIdentity(): Promise<{ email: string | null; uuid: string | null }> {
  const data = await readJsonFile<Record<string, unknown>>(claudeJsonPath())
  const oauthAccount =
    data?.oauthAccount && typeof data.oauthAccount === 'object'
      ? (data.oauthAccount as Record<string, unknown>)
      : null
  const email =
    oauthAccount && typeof oauthAccount.emailAddress === 'string' ? oauthAccount.emailAddress : null
  const uuid =
    oauthAccount && typeof oauthAccount.accountUuid === 'string' ? oauthAccount.accountUuid : null
  return { email, uuid }
}

/** List all managed Claude accounts, in sequence.json's `sequence` order. */
export async function listClaudeAccounts(): Promise<ClaudeStoreAccount[]> {
  const seq = await readSequence()
  const liveEmail = await readClaudeLiveEmail()

  const out: ClaudeStoreAccount[] = []
  for (const numValue of seq.sequence) {
    const num = String(numValue)
    const entry = seq.accounts[num]
    if (!entry) continue

    const email = (entry.email ?? '').toLowerCase()
    const effective = await readClaudeEffectiveBlob(num, email)
    const parsed = effective?.parsed ?? null

    out.push({
      num,
      email,
      uuid: entry.uuid ?? '',
      expiresAtMs: typeof parsed?.expiresAt === 'number' ? parsed.expiresAt : null,
      hasRefresh: typeof parsed?.refreshToken === 'string' && parsed.refreshToken.length > 0,
      plan: typeof parsed?.subscriptionType === 'string' ? parsed.subscriptionType : null,
      active: liveEmail !== null && liveEmail === email
    })
  }
  return out
}

/**
 * Patch rotated tokens into an account's backup blob (preserving unknown
 * fields), and mirror the patched blob to the live Keychain entry when this
 * account is currently active.
 */
export async function updateClaudeTokens(
  num: string,
  email: string,
  rotated: { accessToken: string; refreshToken: string; expiresAt: number },
  scope?: string
): Promise<void> {
  const existingRaw = (await keychainRead(accountService(num, email))) ?? '{}'
  let full: ClaudeCredentialBlob
  try {
    full = JSON.parse(existingRaw) as ClaudeCredentialBlob
  } catch {
    full = {}
  }

  const oauth: ClaudeOauthBlob = { ...(full.claudeAiOauth ?? {}) }
  oauth.accessToken = rotated.accessToken
  oauth.refreshToken = rotated.refreshToken
  oauth.expiresAt = rotated.expiresAt
  if (scope !== undefined) {
    oauth.scopes = scope.split(' ')
  }
  full.claudeAiOauth = oauth

  const raw = JSON.stringify(full)
  await keychainWrite(accountService(num, email), raw)

  const liveEmail = await readClaudeLiveEmail()
  if (liveEmail !== null && liveEmail === email.toLowerCase()) {
    await keychainWrite(LIVE_CLAUDE_KEYCHAIN_SERVICE, raw)
  }
}

/** Port of ccswitch `switch_to`: makes `num`/`email` the live active Claude account. */
export async function switchClaudeAccount(num: string, email: string): Promise<void> {
  const seq = await readSequence()

  // 1) Preserve the outgoing account's freshest (live) credentials into its
  //    own backup slot before overwriting the live credential, so a
  //    just-refreshed token isn't lost.
  const currentLiveEmail = await readClaudeLiveEmail()
  if (currentLiveEmail !== null && currentLiveEmail !== email.toLowerCase()) {
    const outgoingNum = findNumByEmail(seq, currentLiveEmail)
    if (outgoingNum !== null) {
      const live = await readLiveBlob()
      if (live) {
        await keychainWrite(accountService(outgoingNum, currentLiveEmail), live.raw)
      }
    }
  }

  // 2) Write the target account's backup blob to the live Keychain entry.
  const target = await readClaudeAccountBlob(num, email)
  if (!target) {
    throw new Error(`No stored Claude credentials for account ${num} (${email})`)
  }
  await keychainWrite(LIVE_CLAUDE_KEYCHAIN_SERVICE, target.raw)

  // 3) Merge oauthAccount identity fields into the identity file, preserving
  //    everything else. Never clobber a file we couldn't parse.
  const path = claudeJsonPath()
  let identity: Record<string, unknown> = {}
  if (existsSync(path)) {
    const raw = await readFile(path, 'utf-8')
    try {
      identity = JSON.parse(raw) as Record<string, unknown>
    } catch (error) {
      throw new Error(
        `${path}: invalid JSON, refusing to overwrite (${error instanceof Error ? error.message : String(error)})`
      )
    }
  }

  const uuid = seq.accounts[num]?.uuid ?? ''
  const oauthAccount: Record<string, unknown> =
    identity.oauthAccount && typeof identity.oauthAccount === 'object'
      ? { ...(identity.oauthAccount as Record<string, unknown>) }
      : {}
  oauthAccount.emailAddress = email
  if (uuid !== '') {
    oauthAccount.accountUuid = uuid
  }
  identity.oauthAccount = oauthAccount
  await atomicWriteJson(path, identity, { pretty: true })

  // 4) Update the active account number.
  seq.activeAccountNumber = Number.parseInt(num, 10)
  seq.lastUpdated = new Date().toISOString()
  await writeSequence(seq)
}

/**
 * Register a new managed account (or re-register an existing one, reusing
 * its account number). Returns the account number.
 */
export async function addClaudeAccount(email: string, uuid: string, blobJson: string): Promise<string> {
  // Normalized so this account's Keychain entry is always reachable by the
  // same (lowercased) email that listing/effective-blob lookups use.
  const normalizedEmail = email.toLowerCase()
  const seq = await readSequence()
  const existingNum = findNumByEmail(seq, normalizedEmail)
  const num = existingNum ?? String(nextNumber(seq))

  await keychainWrite(accountService(num, normalizedEmail), blobJson)

  const prior = seq.accounts[num]
  seq.accounts[num] = {
    email: normalizedEmail,
    uuid: uuid !== '' ? uuid : (prior?.uuid ?? ''),
    added: prior?.added ?? new Date().toISOString()
  }
  if (existingNum === null) {
    seq.sequence.push(Number.parseInt(num, 10))
  }
  seq.lastUpdated = new Date().toISOString()
  await writeSequence(seq)

  return num
}

/**
 * Remove a managed account. Never touches the live Keychain entry or the
 * identity file — only this account's backup Keychain entry and its
 * sequence.json bookkeeping.
 */
export async function removeClaudeAccount(num: string, email: string): Promise<void> {
  await keychainDelete(accountService(num, email))

  const seq = await readSequence()
  delete seq.accounts[num]
  seq.sequence = seq.sequence.filter((n) => String(n) !== num)
  if (seq.activeAccountNumber !== null && String(seq.activeAccountNumber) === num) {
    seq.activeAccountNumber = null
  }
  seq.lastUpdated = new Date().toISOString()
  await writeSequence(seq)
}
