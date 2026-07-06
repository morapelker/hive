// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  homeDir: '/tmp/hive-account-store-claude-test',
  keychainStore: new Map<string, string>(),
  keychainRead: vi.fn(async (service: string) => mocks.keychainStore.get(service) ?? null),
  keychainWrite: vi.fn(async (service: string, secret: string) => {
    mocks.keychainStore.set(service, secret)
  }),
  keychainDelete: vi.fn(async (service: string) => {
    mocks.keychainStore.delete(service)
  })
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => mocks.homeDir }
})

vi.mock('../../src/main/services/keychain', () => ({
  keychainRead: mocks.keychainRead,
  keychainWrite: mocks.keychainWrite,
  keychainDelete: mocks.keychainDelete
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  LIVE_CLAUDE_KEYCHAIN_SERVICE,
  addClaudeAccount,
  listClaudeAccounts,
  persistRotatedLiveClaudeTokens,
  readClaudeAccountBlob,
  readClaudeEffectiveBlob,
  readClaudeLiveEmail,
  removeClaudeAccount,
  switchClaudeAccount,
  updateClaudeTokens
} from '../../src/main/services/account-store-claude'

const sequencePath = () => join(mocks.homeDir, '.claude-switch-backup', 'sequence.json')
const identityPath = () => join(mocks.homeDir, '.claude.json')
const nestedIdentityPath = () => join(mocks.homeDir, '.claude', '.claude.json')
const credentialsFilePath = () => join(mocks.homeDir, '.claude', '.credentials.json')

function claudeBlob(
  overrides: Partial<{
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes: string[]
    subscriptionType: string
  }> = {}
): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 1_700_000_000_000,
      scopes: ['org:create_api_key'],
      subscriptionType: 'max',
      ...overrides
    }
  })
}

async function readSequenceFile(): Promise<any> {
  return JSON.parse(await readFile(sequencePath(), 'utf-8'))
}

describe('account-store-claude', () => {
  beforeEach(async () => {
    mocks.homeDir = await mkdtemp(join(tmpdir(), 'hive-account-store-claude-'))
    mocks.keychainStore.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(mocks.homeDir, { recursive: true, force: true })
  })

  describe('addClaudeAccount', () => {
    it('allocates sequential numbers, reuses the number for a repeated email, and preserves added/uuid unless a new uuid is given', async () => {
      const num1 = await addClaudeAccount('a@b.c', 'uuid-1', claudeBlob())
      expect(num1).toBe('1')

      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'))
      const num2 = await addClaudeAccount('d@e.f', 'uuid-2', claudeBlob())
      expect(num2).toBe('2')

      vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'))
      const num1Again = await addClaudeAccount('a@b.c', '', claudeBlob({ accessToken: 'access-2' }))
      expect(num1Again).toBe('1')

      const sequence = await readSequenceFile()
      expect(sequence.sequence).toEqual([1, 2])
      expect(sequence.accounts['1']).toMatchObject({
        email: 'a@b.c',
        uuid: 'uuid-1',
        added: '2026-01-01T00:00:00.000Z'
      })
      expect(sequence.accounts['2']).toMatchObject({ email: 'd@e.f', uuid: 'uuid-2' })

      const storedBlob = mocks.keychainStore.get('Claude Code-Account-1-a@b.c')
      expect(JSON.parse(storedBlob!).claudeAiOauth.accessToken).toBe('access-2')
    })

    it('adopts a new uuid on re-add when one is given', async () => {
      await addClaudeAccount('a@b.c', 'uuid-1', claudeBlob())
      await addClaudeAccount('a@b.c', 'uuid-1-updated', claudeBlob())

      const sequence = await readSequenceFile()
      expect(sequence.accounts['1'].uuid).toBe('uuid-1-updated')
    })
  })

  describe('switchClaudeAccount', () => {
    it('preserves the outgoing live blob into its own backup, writes the target live, merges oauthAccount preserving unrelated fields, and updates activeAccountNumber', async () => {
      await addClaudeAccount('a@b.c', 'uuid-a', claudeBlob({ accessToken: 'a-token' }))
      await addClaudeAccount('d@e.f', 'uuid-d', claudeBlob({ accessToken: 'd-token' }))

      // Account "a@b.c" is currently live, with a FRESHER live blob than its
      // own backup (as if it had just been refreshed in place).
      await writeFile(
        identityPath(),
        JSON.stringify({
          oauthAccount: { emailAddress: 'a@b.c', accountUuid: 'uuid-a' },
          someOtherSetting: 'keep-me'
        })
      )
      mocks.keychainStore.set(LIVE_CLAUDE_KEYCHAIN_SERVICE, claudeBlob({ accessToken: 'a-token-fresher' }))

      await switchClaudeAccount('2', 'd@e.f')

      const outgoingBackup = JSON.parse(mocks.keychainStore.get('Claude Code-Account-1-a@b.c')!)
      expect(outgoingBackup.claudeAiOauth.accessToken).toBe('a-token-fresher')

      const live = JSON.parse(mocks.keychainStore.get(LIVE_CLAUDE_KEYCHAIN_SERVICE)!)
      expect(live.claudeAiOauth.accessToken).toBe('d-token')

      const identity = JSON.parse(await readFile(identityPath(), 'utf-8'))
      expect(identity).toMatchObject({
        oauthAccount: { emailAddress: 'd@e.f', accountUuid: 'uuid-d' },
        someOtherSetting: 'keep-me'
      })

      const sequence = await readSequenceFile()
      expect(sequence.activeAccountNumber).toBe(2)
    })

    it('throws when the target account has no stored credentials', async () => {
      await mkdir(join(mocks.homeDir, '.claude-switch-backup'), { recursive: true })
      await writeFile(
        sequencePath(),
        JSON.stringify({
          activeAccountNumber: null,
          lastUpdated: new Date().toISOString(),
          sequence: [1],
          accounts: { '1': { email: 'ghost@example.com', uuid: 'uuid-ghost', added: new Date().toISOString() } }
        })
      )

      await expect(switchClaudeAccount('1', 'ghost@example.com')).rejects.toThrow(
        /No stored Claude credentials/
      )
    })

    it('throws when the identity file exists but is not valid JSON, without clobbering it', async () => {
      await addClaudeAccount('a@b.c', 'uuid-a', claudeBlob())
      await writeFile(identityPath(), '{ not valid json')

      await expect(switchClaudeAccount('1', 'a@b.c')).rejects.toThrow(/invalid JSON/)

      const raw = await readFile(identityPath(), 'utf-8')
      expect(raw).toBe('{ not valid json')
    })

    it('prefers ~/.claude/.claude.json over ~/.claude.json when both exist', async () => {
      await writeFile(
        identityPath(),
        JSON.stringify({ oauthAccount: { emailAddress: 'top-level@example.com' } })
      )
      await mkdir(join(mocks.homeDir, '.claude'), { recursive: true })
      await writeFile(
        nestedIdentityPath(),
        JSON.stringify({ oauthAccount: { emailAddress: 'nested@example.com' } })
      )

      await expect(readClaudeLiveEmail()).resolves.toBe('nested@example.com')

      await addClaudeAccount('nested@example.com', 'uuid-nested', claudeBlob())
      await switchClaudeAccount('1', 'nested@example.com')

      const nested = JSON.parse(await readFile(nestedIdentityPath(), 'utf-8'))
      expect(nested.oauthAccount.emailAddress).toBe('nested@example.com')
      const topLevel = JSON.parse(await readFile(identityPath(), 'utf-8'))
      expect(topLevel.oauthAccount.emailAddress).toBe('top-level@example.com')
    })
  })

  describe('updateClaudeTokens', () => {
    it('patches known token fields while preserving unknown fields, and mirrors to live only when active', async () => {
      await addClaudeAccount(
        'a@b.c',
        'uuid-a',
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'old-access',
            refreshToken: 'old-refresh',
            expiresAt: 1000,
            scopes: ['x'],
            subscriptionType: 'max'
          },
          someUnrelatedTopLevelField: 'keep-me'
        })
      )

      // Not active yet (no identity file) => no live write.
      await updateClaudeTokens(
        '1',
        'a@b.c',
        { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 2000 },
        'scope-a scope-b'
      )

      const backup = JSON.parse(mocks.keychainStore.get('Claude Code-Account-1-a@b.c')!)
      expect(backup).toMatchObject({
        claudeAiOauth: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresAt: 2000,
          scopes: ['scope-a', 'scope-b'],
          subscriptionType: 'max'
        },
        someUnrelatedTopLevelField: 'keep-me'
      })
      expect(mocks.keychainStore.has(LIVE_CLAUDE_KEYCHAIN_SERVICE)).toBe(false)

      // Now make it the live account and update again, omitting `scope`.
      await writeFile(identityPath(), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }))
      await updateClaudeTokens('1', 'a@b.c', {
        accessToken: 'newer-access',
        refreshToken: 'newer-refresh',
        expiresAt: 3000
      })

      const live = JSON.parse(mocks.keychainStore.get(LIVE_CLAUDE_KEYCHAIN_SERVICE)!)
      expect(live.claudeAiOauth.accessToken).toBe('newer-access')
      expect(live.claudeAiOauth.scopes).toEqual(['scope-a', 'scope-b'])
      expect(live.someUnrelatedTopLevelField).toBe('keep-me')
    })
  })

  describe('removeClaudeAccount', () => {
    it('nulls activeAccountNumber when removing the active account and never touches the live Keychain service', async () => {
      await addClaudeAccount('a@b.c', 'uuid-a', claudeBlob())
      await switchClaudeAccount('1', 'a@b.c')

      mocks.keychainWrite.mockClear()
      mocks.keychainDelete.mockClear()

      await removeClaudeAccount('1', 'a@b.c')

      const sequence = await readSequenceFile()
      expect(sequence.activeAccountNumber).toBeNull()
      expect(sequence.accounts['1']).toBeUndefined()
      expect(sequence.sequence).toEqual([])

      expect(mocks.keychainDelete).toHaveBeenCalledWith('Claude Code-Account-1-a@b.c')
      expect(mocks.keychainWrite).not.toHaveBeenCalledWith(LIVE_CLAUDE_KEYCHAIN_SERVICE, expect.anything())
      expect(mocks.keychainDelete).not.toHaveBeenCalledWith(LIVE_CLAUDE_KEYCHAIN_SERVICE)

      // The identity file is untouched by removal.
      const identity = JSON.parse(await readFile(identityPath(), 'utf-8'))
      expect(identity.oauthAccount.emailAddress).toBe('a@b.c')
    })
  })

  describe('listClaudeAccounts', () => {
    it('lists accounts in sequence order, marks the active one case-insensitively, and tolerates a missing keychain entry', async () => {
      await addClaudeAccount('a@b.c', 'uuid-a', claudeBlob({ subscriptionType: 'max' }))
      await addClaudeAccount('nokeys@example.com', 'uuid-none', claudeBlob())
      mocks.keychainStore.delete('Claude Code-Account-2-nokeys@example.com')

      await writeFile(identityPath(), JSON.stringify({ oauthAccount: { emailAddress: 'A@B.C' } }))

      const accounts = await listClaudeAccounts()
      expect(accounts.map((a) => a.num)).toEqual(['1', '2'])
      expect(accounts[0]).toMatchObject({ email: 'a@b.c', active: true, plan: 'max', hasRefresh: true })
      expect(accounts[1]).toMatchObject({
        email: 'nokeys@example.com',
        active: false,
        expiresAtMs: null,
        hasRefresh: false,
        plan: null
      })
    })
  })

  describe('readClaudeAccountBlob / readClaudeEffectiveBlob', () => {
    it('returns null for a missing account', async () => {
      await expect(readClaudeAccountBlob('99', 'nobody@example.com')).resolves.toBeNull()
    })

    it('returns the live blob when active, else falls back to the backup blob', async () => {
      await addClaudeAccount('a@b.c', 'uuid-a', claudeBlob({ accessToken: 'backup-token' }))

      const inactive = await readClaudeEffectiveBlob('1', 'a@b.c')
      expect(inactive?.parsed.accessToken).toBe('backup-token')

      await writeFile(identityPath(), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }))
      mocks.keychainStore.set(LIVE_CLAUDE_KEYCHAIN_SERVICE, claudeBlob({ accessToken: 'live-token' }))

      const active = await readClaudeEffectiveBlob('1', 'a@b.c')
      expect(active?.parsed.accessToken).toBe('live-token')
    })
  })

  describe('persistRotatedLiveClaudeTokens', () => {
    const rotated = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 9_999_999 }

    it('returns no-live when there are no live credentials anywhere', async () => {
      await expect(persistRotatedLiveClaudeTokens(rotated, 'old-refresh')).resolves.toBe('no-live')
      expect(mocks.keychainWrite).not.toHaveBeenCalled()
    })

    it('writes to the Keychain when the live credentials came from there (keychain-sourced)', async () => {
      mocks.keychainStore.set(LIVE_CLAUDE_KEYCHAIN_SERVICE, claudeBlob({ refreshToken: 'old-refresh' }))

      const outcome = await persistRotatedLiveClaudeTokens(rotated, 'old-refresh', 'scope-a scope-b')

      expect(outcome).toBe('persisted')
      const live = JSON.parse(mocks.keychainStore.get(LIVE_CLAUDE_KEYCHAIN_SERVICE)!)
      expect(live.claudeAiOauth).toMatchObject({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 9_999_999,
        scopes: ['scope-a', 'scope-b'],
        // Unrelated fields on the blob are preserved.
        subscriptionType: 'max'
      })
      // Never fell back to the credentials file.
      await expect(readFile(credentialsFilePath(), 'utf-8')).rejects.toThrow()
    })

    it('writes to the credentials file (mode 0600) when the live credentials came from there (no Keychain entry)', async () => {
      await mkdir(join(mocks.homeDir, '.claude'), { recursive: true })
      await writeFile(credentialsFilePath(), claudeBlob({ refreshToken: 'old-refresh' }))

      const outcome = await persistRotatedLiveClaudeTokens(rotated, 'old-refresh')

      expect(outcome).toBe('persisted')
      expect(mocks.keychainWrite).not.toHaveBeenCalledWith(LIVE_CLAUDE_KEYCHAIN_SERVICE, expect.anything())

      const { stat } = await import('fs/promises')
      const stats = await stat(credentialsFilePath())
      expect(stats.mode & 0o777).toBe(0o600)

      const patched = JSON.parse(await readFile(credentialsFilePath(), 'utf-8'))
      expect(patched.claudeAiOauth).toMatchObject({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 9_999_999
      })
    })

    it('returns skipped-race without writing when the live refresh token no longer matches (another process rotated first)', async () => {
      mocks.keychainStore.set(
        LIVE_CLAUDE_KEYCHAIN_SERVICE,
        claudeBlob({ refreshToken: 'someone-else-already-rotated-this' })
      )

      const outcome = await persistRotatedLiveClaudeTokens(rotated, 'old-refresh')

      expect(outcome).toBe('skipped-race')
      expect(mocks.keychainWrite).not.toHaveBeenCalled()
      const live = JSON.parse(mocks.keychainStore.get(LIVE_CLAUDE_KEYCHAIN_SERVICE)!)
      expect(live.claudeAiOauth.refreshToken).toBe('someone-else-already-rotated-this')
    })

    it('mirrors the patched blob to the managed account backup entry matching the live email', async () => {
      await addClaudeAccount('a@b.c', 'uuid-a', claudeBlob({ accessToken: 'stale-backup-token' }))
      await writeFile(identityPath(), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }))
      mocks.keychainStore.set(LIVE_CLAUDE_KEYCHAIN_SERVICE, claudeBlob({ refreshToken: 'old-refresh' }))

      const outcome = await persistRotatedLiveClaudeTokens(rotated, 'old-refresh')

      expect(outcome).toBe('persisted')
      const backup = JSON.parse(mocks.keychainStore.get('Claude Code-Account-1-a@b.c')!)
      expect(backup.claudeAiOauth.accessToken).toBe('new-access')
      expect(backup.claudeAiOauth.refreshToken).toBe('new-refresh')
    })

    it('does not mirror to any account backup when the live email has no managed account', async () => {
      await addClaudeAccount('other@example.com', 'uuid-o', claudeBlob())
      await writeFile(identityPath(), JSON.stringify({ oauthAccount: { emailAddress: 'unmanaged@example.com' } }))
      mocks.keychainStore.set(LIVE_CLAUDE_KEYCHAIN_SERVICE, claudeBlob({ refreshToken: 'old-refresh' }))

      const outcome = await persistRotatedLiveClaudeTokens(rotated, 'old-refresh')

      expect(outcome).toBe('persisted')
      const untouchedBackup = JSON.parse(mocks.keychainStore.get('Claude Code-Account-1-other@example.com')!)
      expect(untouchedBackup.claudeAiOauth.accessToken).toBe('access-1')
    })
  })
})
