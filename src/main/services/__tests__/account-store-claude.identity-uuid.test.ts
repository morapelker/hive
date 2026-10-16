// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  stats: new Map<string, { mtimeMs: number; size: number; ino: number }>()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: { ...actual, existsSync: (path: string) => fsMocks.files.has(String(path)) },
    existsSync: (path: string) => fsMocks.files.has(String(path))
  }
})

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: async (path: string) => {
      const content = fsMocks.files.get(String(path))
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return content
    },
    stat: async (path: string) => {
      const stats = fsMocks.stats.get(String(path))
      if (stats === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return stats
    }
  }
})

vi.mock('../keychain', () => ({
  keychainRead: vi.fn(),
  keychainWrite: vi.fn(),
  keychainDelete: vi.fn(),
  keychainListAccounts: vi.fn(async () => [])
}))

vi.mock('../atomic-json', () => ({
  readJsonFile: vi.fn(),
  atomicWriteJson: vi.fn()
}))

// The real lock would mkdir next to the real ~/.claude.json; run the body directly.
vi.mock('../claude-config-lock', () => ({
  withClaudeConfigLock: (_path: string, fn: () => Promise<unknown>) => fn()
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { homedir } from 'os'
import { join } from 'path'
import {
  clearAccountStoreCacheForTests,
  isClaudeAccountManaged,
  listClaudeAccountTokenFingerprints,
  readClaudeLiveIdentityCached,
  readClaudeLiveTokenFingerprint,
  rememberClaudeAccountUuid,
  repairStaleClaudeLiveIdentityUuid,
  switchClaudeAccount
} from '../account-store-claude'
import { keychainRead, keychainWrite } from '../keychain'
import { atomicWriteJson, readJsonFile } from '../atomic-json'
import { fingerprintSecret } from '../credential-fingerprint'

const STORE_DIR = '/tmp/hive-claude-store-test'
const SEQUENCE_PATH = join(STORE_DIR, 'sequence.json')
const IDENTITY_PATH = join(homedir(), '.claude', '.claude.json')
const UUID_A = '718fd88e-2076-4451-bc5f-066158379585'
const UUID_B = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'

const blob = (oauth: Record<string, unknown>): string => JSON.stringify({ claudeAiOauth: oauth })

function seedSequence(accounts: Record<string, { email: string; uuid: string }>): void {
  fsMocks.files.set(
    SEQUENCE_PATH,
    JSON.stringify({
      activeAccountNumber: 1,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      sequence: Object.keys(accounts).map(Number),
      accounts: Object.fromEntries(
        Object.entries(accounts).map(([num, a]) => [num, { ...a, added: '2026-01-01' }])
      )
    })
  )
}

function seedIdentity(oauthAccount: Record<string, unknown>): void {
  const identity = { numStartups: 3, oauthAccount }
  fsMocks.files.set(IDENTITY_PATH, JSON.stringify(identity))
  vi.mocked(readJsonFile).mockImplementation(async (path: string) =>
    path === IDENTITY_PATH ? JSON.parse(JSON.stringify(identity)) : null
  )
}

function writtenSequence(): { accounts: Record<string, { email: string; uuid: string }> } {
  const call = vi
    .mocked(atomicWriteJson)
    .mock.calls.filter(([path]) => path === SEQUENCE_PATH)
    .at(-1)
  expect(call).toBeDefined()
  return call![1] as { accounts: Record<string, { email: string; uuid: string }> }
}

function writtenIdentity(): Record<string, unknown> | undefined {
  const call = vi
    .mocked(atomicWriteJson)
    .mock.calls.filter(([path]) => path === IDENTITY_PATH)
    .at(-1)
  return call ? (call[1] as Record<string, unknown>) : undefined
}

beforeEach(() => {
  process.env.HIVE_CLAUDE_STORE_DIR = STORE_DIR
  fsMocks.files.clear()
  fsMocks.stats.clear()
  vi.mocked(keychainRead).mockReset()
  vi.mocked(keychainWrite).mockReset()
  vi.mocked(atomicWriteJson).mockReset()
  vi.mocked(readJsonFile).mockReset()
  clearAccountStoreCacheForTests()
})

describe('switchClaudeAccount identity file handling', () => {
  beforeEach(() => {
    vi.mocked(keychainRead).mockImplementation(async (service: string) => {
      if (service === 'Claude Code-credentials') return blob({ accessToken: 'live-a' })
      if (service === 'Claude Code-Account-2-b@example.com') return blob({ accessToken: 'b' })
      if (service === 'Claude Code-Account-1-a@example.com') return blob({ accessToken: 'a' })
      return null
    })
  })

  it('writes the target uuid when the index knows it', async () => {
    seedSequence({
      '1': { email: 'a@example.com', uuid: UUID_A },
      '2': { email: 'b@example.com', uuid: UUID_B }
    })
    seedIdentity({ emailAddress: 'a@example.com', accountUuid: UUID_A, organizationUuid: 'org-a' })

    await switchClaudeAccount('2', 'b@example.com')

    expect(writtenIdentity()).toMatchObject({
      numStartups: 3,
      oauthAccount: {
        emailAddress: 'b@example.com',
        accountUuid: UUID_B,
        organizationUuid: 'org-a'
      }
    })
  })

  it('drops the outgoing account identity when the target uuid is unknown', async () => {
    seedSequence({
      '1': { email: 'a@example.com', uuid: UUID_A },
      '2': { email: 'b@example.com', uuid: '' }
    })
    seedIdentity({
      emailAddress: 'a@example.com',
      accountUuid: UUID_A,
      organizationUuid: 'org-a',
      profileFetchedAt: 123,
      displayName: 'A'
    })

    await switchClaudeAccount('2', 'b@example.com')

    const oauthAccount = writtenIdentity()?.oauthAccount as Record<string, unknown>
    expect(oauthAccount.emailAddress).toBe('b@example.com')
    expect(oauthAccount).not.toHaveProperty('accountUuid')
    expect(oauthAccount).not.toHaveProperty('organizationUuid')
    expect(oauthAccount).not.toHaveProperty('profileFetchedAt')
    // Unrelated fields survive.
    expect(oauthAccount.displayName).toBe('A')
  })

  it('learns a legacy account uuid from the identity file when re-selecting the live account', async () => {
    seedSequence({ '1': { email: 'a@example.com', uuid: '' } })
    seedIdentity({ emailAddress: 'a@example.com', accountUuid: UUID_A })

    await switchClaudeAccount('1', 'a@example.com')

    expect(writtenSequence().accounts['1'].uuid).toBe(UUID_A)
    expect((writtenIdentity()?.oauthAccount as Record<string, unknown>).accountUuid).toBe(UUID_A)
  })
})

describe('rememberClaudeAccountUuid', () => {
  it('fills an empty uuid, never overwrites one, ignores unmanaged emails', async () => {
    seedSequence({
      '1': { email: 'a@example.com', uuid: '' },
      '2': { email: 'b@example.com', uuid: UUID_B }
    })

    expect(await rememberClaudeAccountUuid('A@example.com', UUID_A)).toBe(true)
    expect(writtenSequence().accounts['1'].uuid).toBe(UUID_A)

    vi.mocked(atomicWriteJson).mockClear()
    expect(await rememberClaudeAccountUuid('b@example.com', UUID_A)).toBe(false)
    expect(await rememberClaudeAccountUuid('nobody@example.com', UUID_A)).toBe(false)
    expect(await rememberClaudeAccountUuid('a@example.com', '')).toBe(false)
    expect(atomicWriteJson).not.toHaveBeenCalled()
  })
})

describe('repairStaleClaudeLiveIdentityUuid', () => {
  it('drops a uuid that belongs to a different managed account than the live email', async () => {
    seedSequence({
      '1': { email: 'a@example.com', uuid: UUID_A },
      '2': { email: 'b@example.com', uuid: '' }
    })
    seedIdentity({ emailAddress: 'b@example.com', accountUuid: UUID_A, profileFetchedAt: 1 })

    expect(await repairStaleClaudeLiveIdentityUuid()).toBe(true)
    const oauthAccount = writtenIdentity()?.oauthAccount as Record<string, unknown>
    expect(oauthAccount.emailAddress).toBe('b@example.com')
    expect(oauthAccount).not.toHaveProperty('accountUuid')
    expect(oauthAccount).not.toHaveProperty('profileFetchedAt')
  })

  it('leaves a consistent or unknown identity alone', async () => {
    seedSequence({
      '1': { email: 'a@example.com', uuid: UUID_A },
      '2': { email: 'b@example.com', uuid: '' }
    })

    seedIdentity({ emailAddress: 'a@example.com', accountUuid: UUID_A })
    expect(await repairStaleClaudeLiveIdentityUuid()).toBe(false)

    // A uuid nobody else owns might simply be B's real one (not yet recorded).
    seedIdentity({ emailAddress: 'b@example.com', accountUuid: UUID_B })
    expect(await repairStaleClaudeLiveIdentityUuid()).toBe(false)

    seedIdentity({ emailAddress: 'b@example.com' })
    expect(await repairStaleClaudeLiveIdentityUuid()).toBe(false)

    vi.mocked(readJsonFile).mockResolvedValue(null)
    expect(await repairStaleClaudeLiveIdentityUuid()).toBe(false)
    expect(atomicWriteJson).not.toHaveBeenCalled()
  })
})

describe('access-token fingerprints', () => {
  let tokens: Record<string, string | null>

  beforeEach(() => {
    tokens = {
      'Claude Code-credentials': 'live-token-b',
      'Claude Code-Account-1-a@example.com': 'token-a',
      'Claude Code-Account-2-b@example.com': 'stale-backup-token-b',
      'Claude Code-Account-3-c@example.com': null
    }
    vi.mocked(keychainRead).mockImplementation(async (service: string) => {
      const token = tokens[service]
      return token ? blob({ accessToken: token }) : null
    })
    seedSequence({
      '1': { email: 'a@example.com', uuid: UUID_A },
      '2': { email: 'b@example.com', uuid: UUID_B },
      '3': { email: 'c@example.com', uuid: '' }
    })
    // B is the signed-in account.
    seedIdentity({ emailAddress: 'b@example.com', accountUuid: UUID_B })
  })

  it('fingerprints each account by the token it would send right now', async () => {
    const fingerprints = await listClaudeAccountTokenFingerprints()
    expect(fingerprints).toEqual([
      { email: 'a@example.com', uuid: UUID_A, tokenFingerprint: fingerprintSecret('token-a') },
      // The live account's effective credentials are the live entry, not its backup slot.
      { email: 'b@example.com', uuid: UUID_B, tokenFingerprint: fingerprintSecret('live-token-b') },
      { email: 'c@example.com', uuid: '', tokenFingerprint: null }
    ])
    // Never the token itself.
    expect(JSON.stringify(fingerprints)).not.toContain('token-a')
    expect(await readClaudeLiveTokenFingerprint()).toBe(fingerprintSecret('live-token-b'))
  })

  it('serves the memo unless it predates the moment the caller needs', async () => {
    const sweeps = (): number =>
      vi
        .mocked(keychainRead)
        .mock.calls.filter(([service]) => service === 'Claude Code-Account-1-a@example.com').length
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const lookupStartedAt = Date.now()
      await listClaudeAccountTokenFingerprints()
      expect(sweeps()).toBe(1)

      // The memo was built by this very lookup: asking for "not older than
      // when I started" must not sweep the Keychain a second time.
      await listClaudeAccountTokenFingerprints({ notOlderThan: lookupStartedAt })
      expect(sweeps()).toBe(1)

      // A token is rotated; a later lookup that needs a view newer than the
      // memo gets a real rescan, a plain one still gets the memo.
      tokens['Claude Code-Account-1-a@example.com'] = 'token-a-rotated'
      vi.setSystemTime(1_002_000)
      const memoised = await listClaudeAccountTokenFingerprints()
      expect(memoised[0].tokenFingerprint).toBe(fingerprintSecret('token-a'))
      const rescanned = await listClaudeAccountTokenFingerprints({ notOlderThan: Date.now() })
      expect(rescanned[0].tokenFingerprint).toBe(fingerprintSecret('token-a-rotated'))
      expect(sweeps()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('readClaudeLiveIdentityCached', () => {
  const parses = (): number =>
    vi.mocked(readJsonFile).mock.calls.filter(([path]) => path === IDENTITY_PATH).length

  it('re-parses the identity file only when its stat changes', async () => {
    seedIdentity({ emailAddress: 'a@example.com', accountUuid: UUID_A })
    fsMocks.stats.set(IDENTITY_PATH, { mtimeMs: 1_000, size: 800_000, ino: 7 })

    expect(await readClaudeLiveIdentityCached()).toEqual({ email: 'a@example.com', uuid: UUID_A })
    expect(await readClaudeLiveIdentityCached()).toEqual({ email: 'a@example.com', uuid: UUID_A })
    expect(parses()).toBe(1)

    // An account switch (possibly by another process) replaces the file.
    seedIdentity({ emailAddress: 'b@example.com', accountUuid: UUID_B })
    fsMocks.stats.set(IDENTITY_PATH, { mtimeMs: 2_000, size: 800_010, ino: 8 })
    expect(await readClaudeLiveIdentityCached()).toEqual({ email: 'b@example.com', uuid: UUID_B })
    expect(parses()).toBe(2)

    // Each stat key alone must invalidate: a different inode with the same
    // mtime and size (atomic replace)...
    seedIdentity({ emailAddress: 'a@example.com', accountUuid: UUID_A })
    fsMocks.stats.set(IDENTITY_PATH, { mtimeMs: 2_000, size: 800_010, ino: 9 })
    expect((await readClaudeLiveIdentityCached()).email).toBe('a@example.com')
    expect(parses()).toBe(3)
    // ...a newer mtime on the same inode and size (an in-place rewrite)...
    seedIdentity({ emailAddress: 'b@example.com', accountUuid: UUID_B })
    fsMocks.stats.set(IDENTITY_PATH, { mtimeMs: 3_000, size: 800_010, ino: 9 })
    expect((await readClaudeLiveIdentityCached()).email).toBe('b@example.com')
    expect(parses()).toBe(4)
    // ...and a different size with the same mtime and inode (coarse clocks).
    seedIdentity({ emailAddress: 'a@example.com', accountUuid: UUID_A })
    fsMocks.stats.set(IDENTITY_PATH, { mtimeMs: 3_000, size: 800_011, ino: 9 })
    expect((await readClaudeLiveIdentityCached()).email).toBe('a@example.com')
    expect(parses()).toBe(5)
  })

  it('hands out copies, so a caller cannot corrupt the cached identity', async () => {
    seedIdentity({ emailAddress: 'a@example.com', accountUuid: UUID_A })
    fsMocks.stats.set(IDENTITY_PATH, { mtimeMs: 1_000, size: 10, ino: 1 })
    const first = await readClaudeLiveIdentityCached()
    first.email = 'tampered@example.com'
    const hit = await readClaudeLiveIdentityCached()
    expect(hit.email).toBe('a@example.com')
    // The cache-hit result is a copy too.
    hit.email = 'tampered-again@example.com'
    expect((await readClaudeLiveIdentityCached()).email).toBe('a@example.com')
    expect(parses()).toBe(1)
  })

  it('reads through, uncached, when the file cannot be stat-ed', async () => {
    seedIdentity({ emailAddress: 'a@example.com', accountUuid: UUID_A })
    expect((await readClaudeLiveIdentityCached()).email).toBe('a@example.com')
    seedIdentity({ emailAddress: 'b@example.com', accountUuid: UUID_B })
    expect((await readClaudeLiveIdentityCached()).email).toBe('b@example.com')
    expect(parses()).toBe(2)
  })

  it('is dropped whenever this process changes the account store', async () => {
    seedSequence({ '1': { email: 'a@example.com', uuid: '' } })
    seedIdentity({ emailAddress: 'a@example.com', accountUuid: UUID_A })
    fsMocks.stats.set(IDENTITY_PATH, { mtimeMs: 1_000, size: 10, ino: 1 })
    await readClaudeLiveIdentityCached()
    await rememberClaudeAccountUuid('a@example.com', UUID_A)
    await readClaudeLiveIdentityCached()
    expect(parses()).toBe(2)
  })
})

describe('isClaudeAccountManaged', () => {
  it('answers from the index alone, without touching the Keychain', async () => {
    seedSequence({ '1': { email: 'a@example.com', uuid: UUID_A } })
    expect(await isClaudeAccountManaged('A@Example.com')).toBe(true)
    expect(await isClaudeAccountManaged('nobody@example.com')).toBe(false)
    expect(keychainRead).not.toHaveBeenCalled()
  })
})
