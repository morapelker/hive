// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  addCodexAccount,
  listCodexAccounts,
  readCodexLive,
  readCodexSnapshot,
  removeCodexAccount,
  snapshotName,
  switchCodexAccount,
  updateCodexTokens
} from '../../src/main/services/account-store-codex'

function base64url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url')
}

function buildIdToken(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

function idTokenFor(
  userId: string,
  accountId: string,
  email = 'user@example.com',
  plan = 'plus'
): string {
  return buildIdToken({
    email,
    'https://api.openai.com/auth': {
      chatgpt_user_id: userId,
      chatgpt_account_id: accountId,
      chatgpt_plan_type: plan
    }
  })
}

function accessTokenWithExp(expSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ exp: expSeconds }))
  return `${header}.${body}.fake-signature`
}

describe('account-store-codex', () => {
  let codexHome: string
  const originalCodexHome = process.env.CODEX_HOME

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'hive-account-store-codex-'))
    process.env.CODEX_HOME = codexHome
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
    await rm(codexHome, { recursive: true, force: true })
  })

  describe('snapshotName', () => {
    it('base64-encodes with the standard (+/) alphabet and trims trailing = padding', () => {
      // Standard base64 of "u::a?>>" is "dTo6YT8+Pg==" (contains a literal
      // '+'); the URL-safe alphabet would instead produce a '-' there, so
      // this fixture actually distinguishes the two encodings.
      expect(snapshotName('u::a?>>')).toBe('dTo6YT8+Pg')
    })

    it('produces a file name that account-store writes actually land on', async () => {
      const idToken = idTokenFor('u', 'a?>>')
      await addCodexAccount(idToken, 'access-1', 'refresh-1')

      const stats = await stat(join(codexHome, 'accounts', 'dTo6YT8+Pg.auth.json'))
      expect(stats.isFile()).toBe(true)
    })
  })

  describe('addCodexAccount', () => {
    it('derives account_key as userId::accountId from the id_token and writes snapshot + registry', async () => {
      const idToken = idTokenFor('user-123', 'acct-456', 'person@example.com', 'pro')
      const result = await addCodexAccount(idToken, 'access-token', 'refresh-token')

      expect(result).toEqual({ accountKey: 'user-123::acct-456', email: 'person@example.com' })

      const registry = JSON.parse(await readFile(join(codexHome, 'accounts', 'registry.json'), 'utf-8'))
      expect(registry.schema_version).toBe(3)
      expect(registry.accounts).toHaveLength(1)
      expect(registry.accounts[0]).toMatchObject({
        account_key: 'user-123::acct-456',
        chatgpt_user_id: 'user-123',
        chatgpt_account_id: 'acct-456',
        email: 'person@example.com',
        plan: 'pro',
        auth_mode: 'chatgpt'
      })

      const snapshot = await readCodexSnapshot('user-123::acct-456')
      expect(snapshot?.tokens).toMatchObject({
        id_token: idToken,
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        account_id: 'acct-456'
      })
    })

    it('throws when the id_token is missing chatgpt_user_id/chatgpt_account_id', async () => {
      const idToken = buildIdToken({ email: 'x@y.z' })
      await expect(addCodexAccount(idToken, 'a', 'r')).rejects.toThrow(
        /chatgpt_user_id|chatgpt_account_id/
      )
    })

    it('preserves created_at and updates email/plan on re-add', async () => {
      await addCodexAccount(idTokenFor('user-1', 'acct-1', 'old@example.com', 'plus'), 'a1', 'r1')
      const before = JSON.parse(await readFile(join(codexHome, 'accounts', 'registry.json'), 'utf-8'))
      const createdAt = before.accounts[0].created_at

      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'))
      await addCodexAccount(idTokenFor('user-1', 'acct-1', 'new@example.com', 'pro'), 'a2', 'r2')

      const after = JSON.parse(await readFile(join(codexHome, 'accounts', 'registry.json'), 'utf-8'))
      expect(after.accounts).toHaveLength(1)
      expect(after.accounts[0].created_at).toBe(createdAt)
      expect(after.accounts[0].email).toBe('new@example.com')
      expect(after.accounts[0].plan).toBe('pro')
    })
  })

  describe('switchCodexAccount', () => {
    it('preserves the outgoing live auth.json into its own snapshot, copies the target snapshot to live, and updates the registry', async () => {
      const idTokenA = idTokenFor('user-a', 'acct-a', 'a@example.com')
      const idTokenB = idTokenFor('user-b', 'acct-b', 'b@example.com')
      await addCodexAccount(idTokenA, 'a-access', 'a-refresh')
      await addCodexAccount(idTokenB, 'b-access', 'b-refresh')

      // Account A is live, with fresher tokens than its own snapshot (as if
      // the Codex CLI had refreshed auth.json in place).
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          OPENAI_API_KEY: null,
          auth_mode: 'chatgpt',
          tokens: {
            id_token: idTokenA,
            access_token: 'a-access-fresher',
            refresh_token: 'a-refresh-fresher',
            account_id: 'acct-a'
          },
          last_refresh: '2026-01-01T00:00:00.000Z'
        })
      )

      await switchCodexAccount('user-b::acct-b')

      const outgoingSnapshot = await readCodexSnapshot('user-a::acct-a')
      expect(outgoingSnapshot?.tokens?.access_token).toBe('a-access-fresher')

      const live = await readCodexLive()
      expect(live?.tokens?.access_token).toBe('b-access')

      const registry = JSON.parse(await readFile(join(codexHome, 'accounts', 'registry.json'), 'utf-8'))
      expect(registry.active_account_key).toBe('user-b::acct-b')
      expect(registry.active_account_activated_at_ms).toBe(Date.now())
    })

    it('throws when the target account has no snapshot', async () => {
      await expect(switchCodexAccount('nobody::here')).rejects.toThrow(/No Codex snapshot/)
    })
  })

  describe('updateCodexTokens', () => {
    it('patches access always, refresh/id only when provided, and mirrors to live only when active', async () => {
      const idToken = idTokenFor('user-1', 'acct-1')
      await addCodexAccount(idToken, 'old-access', 'old-refresh')

      // Not active yet: active_account_key is still null.
      await updateCodexTokens('user-1::acct-1', { accessToken: 'new-access' })
      let snapshot = await readCodexSnapshot('user-1::acct-1')
      expect(snapshot?.tokens?.access_token).toBe('new-access')
      expect(snapshot?.tokens?.refresh_token).toBe('old-refresh')
      await expect(readCodexLive()).resolves.toBeNull()

      await switchCodexAccount('user-1::acct-1')
      await updateCodexTokens('user-1::acct-1', {
        accessToken: 'newer-access',
        refreshToken: 'newer-refresh',
        idToken: 'newer-id-token'
      })

      snapshot = await readCodexSnapshot('user-1::acct-1')
      expect(snapshot?.tokens).toMatchObject({
        access_token: 'newer-access',
        refresh_token: 'newer-refresh',
        id_token: 'newer-id-token'
      })

      const live = await readCodexLive()
      expect(live?.tokens).toMatchObject({
        access_token: 'newer-access',
        refresh_token: 'newer-refresh',
        id_token: 'newer-id-token'
      })
    })

    it('throws when there is no snapshot for the account', async () => {
      await expect(updateCodexTokens('nobody::here', { accessToken: 'x' })).rejects.toThrow(
        /No Codex snapshot/
      )
    })
  })

  describe('file permissions', () => {
    it('writes registry.json, snapshot files, and auth.json with mode 0600', async () => {
      const idToken = idTokenFor('user-1', 'acct-1')
      await addCodexAccount(idToken, 'access', 'refresh')
      await switchCodexAccount('user-1::acct-1')

      const registryStats = await stat(join(codexHome, 'accounts', 'registry.json'))
      expect(registryStats.mode & 0o777).toBe(0o600)

      const snapshotStats = await stat(
        join(codexHome, 'accounts', `${snapshotName('user-1::acct-1')}.auth.json`)
      )
      expect(snapshotStats.mode & 0o777).toBe(0o600)

      const liveStats = await stat(join(codexHome, 'auth.json'))
      expect(liveStats.mode & 0o777).toBe(0o600)
    })
  })

  describe('removeCodexAccount', () => {
    it('deletes the snapshot and registry entry, nulls active_account_key if pointed here, and never touches auth.json', async () => {
      const idToken = idTokenFor('user-1', 'acct-1')
      await addCodexAccount(idToken, 'access', 'refresh')
      await switchCodexAccount('user-1::acct-1')

      const liveBefore = await readFile(join(codexHome, 'auth.json'), 'utf-8')

      await removeCodexAccount('user-1::acct-1')

      await expect(
        stat(join(codexHome, 'accounts', `${snapshotName('user-1::acct-1')}.auth.json`))
      ).rejects.toThrow()

      const registry = JSON.parse(await readFile(join(codexHome, 'accounts', 'registry.json'), 'utf-8'))
      expect(registry.accounts).toHaveLength(0)
      expect(registry.active_account_key).toBeNull()

      const liveAfter = await readFile(join(codexHome, 'auth.json'), 'utf-8')
      expect(liveAfter).toBe(liveBefore)
    })

    it('ignores a missing snapshot file', async () => {
      await expect(removeCodexAccount('nobody::here')).resolves.toBeUndefined()
    })
  })

  describe('listCodexAccounts', () => {
    it('marks the active account by deriving its key from live id_token claims, using live tokens for it', async () => {
      const idTokenA = idTokenFor('user-a', 'acct-a', 'a@example.com', 'plus')
      const idTokenB = idTokenFor('user-b', 'acct-b', 'b@example.com', 'pro')
      const nowSec = Math.floor(Date.now() / 1000)
      await addCodexAccount(idTokenA, accessTokenWithExp(nowSec + 1000), 'a-refresh')
      await addCodexAccount(idTokenB, accessTokenWithExp(nowSec + 2000), 'b-refresh')

      const freshAccessB = accessTokenWithExp(nowSec + 9999)
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            id_token: idTokenB,
            access_token: freshAccessB,
            refresh_token: 'b-refresh-live',
            account_id: 'acct-b'
          },
          last_refresh: new Date().toISOString()
        })
      )

      const accounts = await listCodexAccounts()
      expect(accounts).toHaveLength(2)

      const a = accounts.find((acc) => acc.accountKey === 'user-a::acct-a')!
      expect(a.active).toBe(false)
      expect(a.email).toBe('a@example.com')
      expect(a.expiresAtMs).toBe((nowSec + 1000) * 1000)

      const b = accounts.find((acc) => acc.accountKey === 'user-b::acct-b')!
      expect(b.active).toBe(true)
      expect(b.hasRefresh).toBe(true)
      expect(b.expiresAtMs).toBe((nowSec + 9999) * 1000)
    })

    it('falls back to registry.active_account_key when the live id_token cannot be parsed', async () => {
      const idToken = idTokenFor('user-a', 'acct-a')
      await addCodexAccount(idToken, 'a-access', 'a-refresh')
      await switchCodexAccount('user-a::acct-a')

      const live = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf-8'))
      live.tokens.id_token = 'not-a-jwt'
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify(live))

      const accounts = await listCodexAccounts()
      expect(accounts.find((a) => a.accountKey === 'user-a::acct-a')?.active).toBe(true)
    })
  })
})
