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
import { readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { keychainDelete, keychainListAccounts, keychainRead, keychainWrite } from './keychain'
import { atomicWriteJson, readJsonFile } from './atomic-json'
import { createLogger } from './logger'
import { fingerprintSecret } from './credential-fingerprint'

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

/**
 * Which managed account currently owns which access token, as a SHA-256
 * fingerprint (never the token). This is how an observed API request is
 * attributed to the account it is actually billed to.
 */
export interface ClaudeAccountTokenFingerprint {
  email: string
  uuid: string
  tokenFingerprint: string | null
}

/**
 * Short TTL memo for `listClaudeAccounts()`. Every list call re-reads
 * sequence.json plus every account's effective Keychain blob (a `security`
 * execFile each, ~10-30ms) — callers like the saved-usage orchestrator's
 * per-account mass refresh call it N+1 times in a row, so a short memo cuts
 * that down to one real read. Invalidated synchronously by every mutating
 * function in this module, and never populated from a rejected read.
 */
const LIST_CACHE_TTL_MS = 15_000
let listCache: {
  value: ClaudeStoreAccount[]
  /** Parallel to `value`: each account's current access-token fingerprint. */
  tokenFingerprints: ClaudeAccountTokenFingerprint[]
  /** Epoch ms at which the scan that produced this memo STARTED. */
  scannedAt: number
  expiresAt: number
} | null = null

/**
 * Short TTL memo for the live Keychain entry's `acct` attribute (see
 * `resolveLiveKeychainAccount`). Caches only the RESOLUTION — which item to
 * read/write — never the secret itself, so token reads always hit the
 * Keychain fresh. `{ value: null }` (resolved-to-nothing) is a valid cached
 * state; the whole slot being null means "not resolved yet".
 */
let liveAccountCache: { value: string | null; expiresAt: number } | null = null

function invalidateListCache(): void {
  listCache = null
  liveAccountCache = null
  liveIdentityCache = null
}

/** Test-only escape hatch: forces the next `listClaudeAccounts()` call to
 * re-read, for tests that mutate the underlying fs/Keychain fixtures
 * directly instead of going through this module's own mutators. */
export function clearAccountStoreCacheForTests(): void {
  invalidateListCache()
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
  service: string,
  account?: string
): Promise<{ raw: string; parsed: ClaudeOauthBlob } | null> {
  const raw = await keychainRead(service, account)
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

function hasAccessToken(blob: { parsed: ClaudeOauthBlob } | null): boolean {
  return typeof blob?.parsed.accessToken === 'string' && blob.parsed.accessToken.length > 0
}

/**
 * The `acct` attribute of the Keychain item that actually holds the live
 * Claude credentials, or null to fall back to first-match reads/default-acct
 * writes.
 *
 * The live slot can hold DUPLICATE items (same service, different account
 * attribute) — seen in the field when the `claude` CLI's item and an
 * `add-generic-password -a $USER` write disagree on the account attribute.
 * `find-generic-password -s` then always returns the first item, which may be
 * a long-stale copy: Hive keeps refreshing with a rotated-away refresh token
 * (invalid_grant) and flags a perfectly healthy active account as expired.
 * When duplicates exist, pick the item whose blob parses with an access token
 * and the latest expiresAt — the copy the CLI keeps fresh. Writes reuse the
 * same attribute so `-U` updates that item in place instead of forking yet
 * another duplicate.
 */
async function resolveLiveKeychainAccount(): Promise<string | null> {
  if (liveAccountCache !== null && liveAccountCache.expiresAt > Date.now()) {
    return liveAccountCache.value
  }

  let account: string | null = null
  try {
    const accounts = (await keychainListAccounts(LIVE_CLAUDE_KEYCHAIN_SERVICE)).filter(
      (acct): acct is string => acct !== null
    )
    const unique = [...new Set(accounts)]

    if (unique.length === 1) {
      account = unique[0]
    } else if (unique.length > 1) {
      let best: { account: string; expiresAt: number } | null = null
      for (const acct of unique) {
        const blob = await readKeychainBlob(LIVE_CLAUDE_KEYCHAIN_SERVICE, acct)
        if (!hasAccessToken(blob)) continue
        const expiresAt = typeof blob?.parsed.expiresAt === 'number' ? blob.parsed.expiresAt : 0
        if (best === null || expiresAt > best.expiresAt) {
          best = { account: acct, expiresAt }
        }
      }
      account = best?.account ?? null
      log.warn('Multiple live Claude Keychain entries found; targeting the freshest', {
        entryCount: unique.length,
        resolved: account !== null
      })
    }
  } catch (error) {
    log.warn('Failed to enumerate live Claude Keychain entries; using first-match reads', {
      error: error instanceof Error ? error.message : String(error)
    })
  }

  liveAccountCache = { value: account, expiresAt: Date.now() + LIST_CACHE_TTL_MS }
  return account
}

/** The currently-live Keychain credential blob ("Claude Code-credentials"). */
async function readLiveBlob(): Promise<{ raw: string; parsed: ClaudeOauthBlob } | null> {
  const account = await resolveLiveKeychainAccount()
  return readKeychainBlob(LIVE_CLAUDE_KEYCHAIN_SERVICE, account ?? undefined)
}

/** The raw live Keychain credential blob, read via duplicate-aware resolution
 * (see `resolveLiveKeychainAccount`). Keychain-only — no file fallback. */
export async function readClaudeLiveKeychainRaw(): Promise<string | null> {
  const account = await resolveLiveKeychainAccount()
  return keychainRead(LIVE_CLAUDE_KEYCHAIN_SERVICE, account ?? undefined)
}

/** Write the live Keychain credential blob onto the item the `claude` CLI
 * actually uses (see `resolveLiveKeychainAccount`). */
async function writeLiveBlob(raw: string): Promise<void> {
  const account = await resolveLiveKeychainAccount()
  await keychainWrite(LIVE_CLAUDE_KEYCHAIN_SERVICE, raw, account ?? undefined)
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
 *
 * A live blob that parses but carries no access token (an empty or foreign
 * shape — e.g. a stale duplicate Keychain item) is treated as absent rather
 * than returned: short-circuiting on it would skip the backup blob and
 * misreport a recoverable account as "Invalid Claude credentials".
 */
export async function readClaudeEffectiveBlob(
  num: string,
  email: string
): Promise<{ raw: string; parsed: ClaudeOauthBlob } | null> {
  const liveEmail = await readClaudeLiveEmail()
  if (liveEmail !== null && liveEmail === email.toLowerCase()) {
    const live = await readLiveBlob()
    if (live && hasAccessToken(live)) return live
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

/**
 * The parsed identity, remembered against the identity file's stat. The file
 * is large (it also holds the CLI's project history) and is consulted on every
 * live usage update, so re-parsing it when it has not changed is pure waste.
 * Keyed on path + mtime + size + inode: a switch (here or in another process)
 * replaces the file atomically, which changes all of them.
 */
let liveIdentityCache: {
  path: string
  mtimeMs: number
  size: number
  ino: number
  identity: { email: string | null; uuid: string | null }
} | null = null

/**
 * `readClaudeLiveIdentity()` without the re-parse when the identity file is
 * unchanged since the last call (one `stat` instead of reading and parsing
 * the whole file). Falls back to a plain read whenever the file cannot be
 * stat'ed, so a missing or unreadable file behaves exactly like the uncached
 * reader.
 */
export async function readClaudeLiveIdentityCached(): Promise<{
  email: string | null
  uuid: string | null
}> {
  const path = claudeJsonPath()
  let stats: { mtimeMs: number; size: number; ino: number }
  try {
    stats = await stat(path)
  } catch {
    liveIdentityCache = null
    return readClaudeLiveIdentity()
  }
  const cached = liveIdentityCache
  if (
    cached !== null &&
    cached.path === path &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size &&
    cached.ino === stats.ino
  ) {
    return { ...cached.identity }
  }
  const identity = await readClaudeLiveIdentity()
  liveIdentityCache = {
    path,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    ino: stats.ino,
    identity: { ...identity }
  }
  return identity
}

/** Whether `email` is in the managed index (sequence.json only — no Keychain traffic). */
export async function isClaudeAccountManaged(email: string): Promise<boolean> {
  return findNumByEmail(await readSequence(), email) !== null
}

/** List all managed Claude accounts, in sequence.json's `sequence` order. */
export async function listClaudeAccounts(): Promise<ClaudeStoreAccount[]> {
  if (listCache !== null && listCache.expiresAt > Date.now()) {
    return listCache.value
  }

  const scannedAt = Date.now()
  const seq = await readSequence()
  const liveEmail = await readClaudeLiveEmail()

  const out: ClaudeStoreAccount[] = []
  const tokenFingerprints: ClaudeAccountTokenFingerprint[] = []
  for (const numValue of seq.sequence) {
    const num = String(numValue)
    const entry = seq.accounts[num]
    if (!entry) continue

    const email = (entry.email ?? '').toLowerCase()
    const effective = await readClaudeEffectiveBlob(num, email)
    const parsed = effective?.parsed ?? null
    tokenFingerprints.push({
      email,
      uuid: entry.uuid ?? '',
      tokenFingerprint:
        typeof parsed?.accessToken === 'string' && parsed.accessToken.length > 0
          ? fingerprintSecret(parsed.accessToken)
          : null
    })

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
  listCache = {
    value: out,
    tokenFingerprints,
    scannedAt,
    expiresAt: Date.now() + LIST_CACHE_TTL_MS
  }
  return out
}

/**
 * The access-token fingerprint of every managed account (same Keychain reads
 * and memo as `listClaudeAccounts`). `notOlderThan` (epoch ms) rejects a memo
 * whose scan started before that moment — for a token nobody recognises, which
 * usually means it was rotated since the memo was built. A memo built at or
 * after it is reused, so a caller that just triggered the scan itself never
 * pays for the same sweep twice.
 */
export async function listClaudeAccountTokenFingerprints(
  options: { notOlderThan?: number } = {}
): Promise<ClaudeAccountTokenFingerprint[]> {
  if (
    options.notOlderThan !== undefined &&
    listCache !== null &&
    listCache.scannedAt < options.notOlderThan
  ) {
    invalidateListCache()
  }
  await listClaudeAccounts()
  return listCache?.tokenFingerprints ?? []
}

/** Fingerprint of the access token in the LIVE credentials (what a new `claude` would send). */
export async function readClaudeLiveTokenFingerprint(): Promise<string | null> {
  const live = await readLiveBlob()
  const token = live?.parsed.accessToken
  return typeof token === 'string' && token.length > 0 ? fingerprintSecret(token) : null
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
  invalidateListCache()
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
    await writeLiveBlob(raw)
  }
}

interface LiveCredentialsSource {
  kind: 'keychain' | 'file'
  raw: string
  filePath?: string
}

/** Re-read the live credentials from wherever usage-service.ts's `readFromFile`
 * would find them: Keychain first, falling back to the legacy credentials
 * file. Returns null when neither source has anything. */
async function readLiveCredentialsSource(): Promise<LiveCredentialsSource | null> {
  const keychainRaw = await readClaudeLiveKeychainRaw()
  if (keychainRaw !== null) return { kind: 'keychain', raw: keychainRaw }

  const filePath = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(filePath)) return null
  try {
    const raw = await readFile(filePath, 'utf-8')
    return { kind: 'file', raw, filePath }
  } catch {
    return null
  }
}

/**
 * The raw (unparsed) live Claude credential blob JSON — Keychain first,
 * falling back to the legacy `~/.claude/.credentials.json` file, matching
 * `usage-service.ts`'s `readFromFile` fallback. Used to seed a brand-new
 * managed account entry from whatever the `claude` CLI currently has live
 * (see `captureLiveAccountFromFetch` in saved-usage-orchestrator.ts).
 */
export async function readClaudeLiveRawBlob(): Promise<string | null> {
  const source = await readLiveCredentialsSource()
  return source?.raw ?? null
}

/**
 * Persist rotated tokens for the LIVE Claude credentials (the ones the
 * `claude` CLI itself reads/writes) after a Hive-initiated refresh.
 *
 * Guards against a race with the `claude` CLI rotating the very same
 * refresh token concurrently: re-reads the live blob and only writes when
 * its current refresh token still matches the one Hive used to obtain
 * `rotated` — otherwise some other process already moved the live
 * credentials forward, and writing here would clobber that newer rotation.
 */
export async function persistRotatedLiveClaudeTokens(
  rotated: { accessToken: string; refreshToken: string; expiresAt: number },
  usedRefreshToken: string,
  scope?: string
): Promise<'persisted' | 'skipped-race' | 'no-live'> {
  const source = await readLiveCredentialsSource()
  if (!source) return 'no-live'

  let full: ClaudeCredentialBlob
  try {
    full = JSON.parse(source.raw) as ClaudeCredentialBlob
  } catch (error) {
    log.warn('Live Claude credentials blob is not valid JSON; refusing to patch', {
      source: source.kind,
      error: error instanceof Error ? error.message : String(error)
    })
    return 'no-live'
  }

  if ((full.claudeAiOauth?.refreshToken ?? undefined) !== usedRefreshToken) {
    return 'skipped-race'
  }

  invalidateListCache()

  const oauth: ClaudeOauthBlob = { ...(full.claudeAiOauth ?? {}) }
  oauth.accessToken = rotated.accessToken
  oauth.refreshToken = rotated.refreshToken
  oauth.expiresAt = rotated.expiresAt
  if (scope !== undefined) {
    oauth.scopes = scope.split(' ')
  }
  full.claudeAiOauth = oauth
  const patchedRaw = JSON.stringify(full)

  if (source.kind === 'keychain') {
    await writeLiveBlob(patchedRaw)
  } else {
    await atomicWriteJson(source.filePath!, full, { mode: 0o600 })
  }

  // Mirror to the managed account's backup slot, if the live email
  // corresponds to one (same "keep the backup fresh" pattern as
  // updateClaudeTokens/switchClaudeAccount).
  const liveEmail = await readClaudeLiveEmail()
  if (liveEmail !== null) {
    const seq = await readSequence()
    const num = findNumByEmail(seq, liveEmail)
    if (num !== null) {
      await keychainWrite(accountService(num, liveEmail), patchedRaw)
    }
  }

  return 'persisted'
}

/** Port of ccswitch `switch_to`: makes `num`/`email` the live active Claude account. */
export async function switchClaudeAccount(num: string, email: string): Promise<void> {
  invalidateListCache()
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
  await writeLiveBlob(target.raw)

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

  let uuid = seq.accounts[num]?.uuid ?? ''
  const oauthAccount: Record<string, unknown> =
    identity.oauthAccount && typeof identity.oauthAccount === 'object'
      ? { ...(identity.oauthAccount as Record<string, unknown>) }
      : {}
  const switchingToLive = currentLiveEmail !== null && currentLiveEmail === email.toLowerCase()
  oauthAccount.emailAddress = email
  if (uuid !== '') {
    oauthAccount.accountUuid = uuid
  } else if (
    switchingToLive &&
    typeof oauthAccount.accountUuid === 'string' &&
    oauthAccount.accountUuid
  ) {
    // The index never learned this account's uuid but the CLI did (it fetched
    // its profile): remember it, so attribution by uuid works from now on.
    uuid = oauthAccount.accountUuid
    const entry = seq.accounts[num]
    if (entry) seq.accounts[num] = { ...entry, uuid }
  } else {
    // The index doesn't know this account's uuid (a legacy entry). Never leave
    // the OUTGOING account's identity behind: the CLI stamps every request's
    // metadata with `accountUuid`, so a stale value credits this account's
    // usage to the previous one. Dropping the profile stamp too makes the CLI
    // re-fetch its profile (and write the real uuid) on its next launch.
    delete oauthAccount.accountUuid
    delete oauthAccount.organizationUuid
    delete oauthAccount.profileFetchedAt
  }
  identity.oauthAccount = oauthAccount
  await atomicWriteJson(path, identity, { pretty: true })

  // 4) Update the active account number.
  seq.activeAccountNumber = Number.parseInt(num, 10)
  seq.lastUpdated = new Date().toISOString()
  await writeSequence(seq)
}

/**
 * Persist the uuid of a managed account that was registered without one
 * (legacy migration, share import). sequence.json only — no Keychain traffic.
 * Returns true when the index changed; false when the email is unmanaged or
 * the entry already has a uuid (an existing uuid is never overwritten).
 */
export async function rememberClaudeAccountUuid(email: string, uuid: string): Promise<boolean> {
  if (!uuid) return false
  const seq = await readSequence()
  const num = findNumByEmail(seq, email)
  if (num === null) return false
  const entry = seq.accounts[num]
  if (!entry || (entry.uuid ?? '') !== '') return false
  invalidateListCache()
  seq.accounts[num] = { ...entry, uuid }
  seq.lastUpdated = new Date().toISOString()
  await writeSequence(seq)
  return true
}

/**
 * Heal an identity file left behind by an older `switchClaudeAccount`: a
 * switch to an account the index knew no uuid for used to keep the OUTGOING
 * account's `accountUuid`, so the CLI stamped the new account's requests with
 * a foreign uuid. When the identity file's uuid provably belongs to a
 * different managed account than its email, drop it (and the profile stamp,
 * so the CLI re-fetches the right one). Returns true when the file changed.
 */
export async function repairStaleClaudeLiveIdentityUuid(): Promise<boolean> {
  const path = claudeJsonPath()
  const identity = await readJsonFile<Record<string, unknown>>(path)
  const oauthAccount =
    identity?.oauthAccount && typeof identity.oauthAccount === 'object'
      ? (identity.oauthAccount as Record<string, unknown>)
      : null
  if (!identity || !oauthAccount) return false
  const liveEmail =
    typeof oauthAccount.emailAddress === 'string' ? oauthAccount.emailAddress.toLowerCase() : ''
  const liveUuid =
    typeof oauthAccount.accountUuid === 'string' ? oauthAccount.accountUuid.toLowerCase() : ''
  if (!liveEmail || !liveUuid) return false

  const seq = await readSequence()
  const entries = Object.values(seq.accounts)
  const ownedByLiveEmail = entries.some(
    (entry) =>
      (entry.email ?? '').toLowerCase() === liveEmail &&
      (entry.uuid ?? '').toLowerCase() === liveUuid
  )
  if (ownedByLiveEmail) return false
  const ownedByOther = entries.some(
    (entry) =>
      (entry.uuid ?? '').toLowerCase() === liveUuid &&
      (entry.email ?? '').toLowerCase() !== liveEmail
  )
  if (!ownedByOther) return false

  const repaired = { ...oauthAccount }
  delete repaired.accountUuid
  delete repaired.organizationUuid
  delete repaired.profileFetchedAt
  await atomicWriteJson(path, { ...identity, oauthAccount: repaired }, { pretty: true })
  invalidateListCache()
  log.info('Dropped a stale account uuid from the Claude identity file', { email: liveEmail })
  return true
}

/**
 * Register a new managed account (or re-register an existing one, reusing
 * its account number). Returns the account number.
 */
export async function addClaudeAccount(email: string, uuid: string, blobJson: string): Promise<string> {
  invalidateListCache()
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
  invalidateListCache()
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
