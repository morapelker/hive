// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  addCodexAccount,
  clearAccountStoreCacheForTests,
  listCodexAccounts,
  persistRotatedLiveCodexTokens,
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
    // The listCodexAccounts() memo is module-level state that outlives a
    // single test (fake system time resets to the same instant every test,
    // so its TTL alone wouldn't force a re-read across tests).
    clearAccountStoreCacheForTests()
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

  describe('listCodexAccounts caching', () => {
    it('memoizes the result within the TTL, a mutation through this module invalidates it immediately, and it also expires after the TTL', async () => {
      const idToken = idTokenFor('user-a', 'acct-a')
      await addCodexAccount(idToken, 'a-access', 'a-refresh')
      const snapshotFile = join(codexHome, 'accounts', `${snapshotName('user-a::acct-a')}.auth.json`)

      const first = await listCodexAccounts()
      expect(first[0].hasRefresh).toBe(true)

      // Bypass this module's own mutators to change the underlying snapshot
      // directly — within the TTL window, the memoized list must not see it.
      const raw = JSON.parse(await readFile(snapshotFile, 'utf-8'))
      raw.tokens.refresh_token = ''
      await writeFile(snapshotFile, JSON.stringify(raw))
      const second = await listCodexAccounts()
      expect(second[0].hasRefresh).toBe(true)

      // A mutation through the module's own API busts the cache immediately.
      await updateCodexTokens('user-a::acct-a', { accessToken: 'new-access', refreshToken: '' })
      const third = await listCodexAccounts()
      expect(third[0].hasRefresh).toBe(false)

      // Bypass again, then let the TTL lapse without any mutator call.
      const raw2 = JSON.parse(await readFile(snapshotFile, 'utf-8'))
      raw2.tokens.refresh_token = 'restored-refresh'
      await writeFile(snapshotFile, JSON.stringify(raw2))
      vi.setSystemTime(new Date(Date.now() + 15_001))
      const fourth = await listCodexAccounts()
      expect(fourth[0].hasRefresh).toBe(true)
    })

    it('does not memoize a rejected call', async () => {
      await mkdir(join(codexHome, 'accounts'), { recursive: true })
      await writeFile(join(codexHome, 'accounts', 'registry.json'), '{ not valid json')

      await expect(listCodexAccounts()).rejects.toThrow(/invalid JSON/)

      await writeFile(
        join(codexHome, 'accounts', 'registry.json'),
        JSON.stringify({ schema_version: 3, active_account_key: null, accounts: [] })
      )
      await expect(listCodexAccounts()).resolves.toEqual([])
    })
  })

  describe('unknown-field preservation (byte-level interop with ccswitch)', () => {
    it('round-trips top-level (api/auto_switch) and entry-level (last_usage/etc) unknown fields across switch + add + remove', async () => {
      const accountKeyA = 'user-a::acct-a'
      const accountKeyB = 'user-b::acct-b'

      const api = { account: true, usage: true }
      const autoSwitch = { enabled: false, threshold_5h_percent: 10, threshold_weekly_percent: 5 }
      const lastUsageA = {
        credits: { balance: '0', has_credits: false, unlimited: false },
        plan_type: 'pro',
        primary: { resets_at: 1780232342, used_percent: 28, window_minutes: 300 },
        secondary: { resets_at: 1780796401, used_percent: 18, window_minutes: 10080 }
      }

      await mkdir(join(codexHome, 'accounts'), { recursive: true })
      await writeFile(
        join(codexHome, 'accounts', 'registry.json'),
        JSON.stringify({
          schema_version: 3,
          active_account_key: null,
          accounts: [
            {
              account_key: accountKeyA,
              chatgpt_account_id: 'acct-a',
              chatgpt_user_id: 'user-a',
              email: 'old-a@example.com',
              alias: '',
              account_name: null,
              plan: 'pro',
              auth_mode: 'chatgpt',
              created_at: 1700000000,
              last_used_at: 1700000000,
              last_usage: lastUsageA,
              last_usage_at: 1700000500,
              last_local_rollout: null
            },
            {
              account_key: accountKeyB,
              chatgpt_account_id: 'acct-b',
              chatgpt_user_id: 'user-b',
              email: 'old-b@example.com',
              alias: '',
              account_name: null,
              plan: 'plus',
              auth_mode: 'chatgpt',
              created_at: 1700000100,
              last_used_at: null,
              last_usage: null,
              last_usage_at: null,
              last_local_rollout: null
            }
          ],
          api,
          auto_switch: autoSwitch
        })
      )

      // Seed snapshots so switch/remove have real files to operate on.
      await writeFile(
        join(codexHome, 'accounts', `${snapshotName(accountKeyA)}.auth.json`),
        JSON.stringify({
          OPENAI_API_KEY: null,
          auth_mode: 'chatgpt',
          tokens: {
            id_token: idTokenFor('user-a', 'acct-a', 'old-a@example.com', 'pro'),
            access_token: 'a-access',
            refresh_token: 'a-refresh',
            account_id: 'acct-a'
          },
          last_refresh: '2026-01-01T00:00:00.000Z'
        })
      )
      await writeFile(
        join(codexHome, 'accounts', `${snapshotName(accountKeyB)}.auth.json`),
        JSON.stringify({
          OPENAI_API_KEY: null,
          auth_mode: 'chatgpt',
          tokens: {
            id_token: idTokenFor('user-b', 'acct-b', 'old-b@example.com', 'plus'),
            access_token: 'b-access',
            refresh_token: 'b-refresh',
            account_id: 'acct-b'
          },
          last_refresh: '2026-01-01T00:00:00.000Z'
        })
      )

      await switchCodexAccount(accountKeyB)
      await addCodexAccount(idTokenFor('user-a', 'acct-a', 'new-a@example.com', 'proplus'), 'a2', 'r2')
      await removeCodexAccount(accountKeyB)

      const registry = JSON.parse(await readFile(join(codexHome, 'accounts', 'registry.json'), 'utf-8'))

      expect(registry.api).toEqual(api)
      expect(registry.auto_switch).toEqual(autoSwitch)

      expect(registry.accounts).toHaveLength(1)
      const entryA = registry.accounts[0]
      expect(entryA.account_key).toBe(accountKeyA)
      expect(entryA.email).toBe('new-a@example.com')
      expect(entryA.plan).toBe('proplus')
      expect(entryA.created_at).toBe(1700000000)
      expect(entryA.last_used_at).toBe(1700000000)
      expect(entryA.last_usage).toEqual(lastUsageA)
      expect(entryA.last_usage_at).toBe(1700000500)

      // B was active (via switch) and then removed, so active_account_key nulls out.
      expect(registry.active_account_key).toBeNull()
    })
  })

  describe('created_at is second-scale, and new-entry shape matches ccswitch defaults', () => {
    it('writes created_at in seconds, not milliseconds', async () => {
      await addCodexAccount(idTokenFor('user-1', 'acct-1'), 'a', 'r')
      const registry = JSON.parse(await readFile(join(codexHome, 'accounts', 'registry.json'), 'utf-8'))
      expect(registry.accounts[0].created_at).toBeLessThan(1e11)
      expect(registry.accounts[0].created_at).toBe(Math.floor(Date.now() / 1000))
    })

    it('defaults plan to "" (not null) and null-fills last_used_at/last_usage/last_usage_at/last_local_rollout on a brand-new entry when the id_token has no plan claim', async () => {
      const idTokenNoPlan = buildIdToken({
        email: 'no-plan@example.com',
        'https://api.openai.com/auth': {
          chatgpt_user_id: 'user-np',
          chatgpt_account_id: 'acct-np'
        }
      })
      await addCodexAccount(idTokenNoPlan, 'a', 'r')

      const registry = JSON.parse(await readFile(join(codexHome, 'accounts', 'registry.json'), 'utf-8'))
      const entry = registry.accounts[0]
      expect(entry.plan).toBe('')
      expect(entry.last_used_at).toBeNull()
      expect(entry.last_usage).toBeNull()
      expect(entry.last_usage_at).toBeNull()
      expect(entry.last_local_rollout).toBeNull()
    })

    it('maps an empty-string plan to null in the listCodexAccounts DTO while the file keeps ""', async () => {
      const idTokenNoPlan = buildIdToken({
        email: 'no-plan@example.com',
        'https://api.openai.com/auth': {
          chatgpt_user_id: 'user-np',
          chatgpt_account_id: 'acct-np'
        }
      })
      await addCodexAccount(idTokenNoPlan, 'a', 'r')

      const accounts = await listCodexAccounts()
      expect(accounts[0].plan).toBeNull()

      const registry = JSON.parse(await readFile(join(codexHome, 'accounts', 'registry.json'), 'utf-8'))
      expect(registry.accounts[0].plan).toBe('')
    })
  })

  describe('persistRotatedLiveCodexTokens', () => {
    const rotated = { accessToken: 'new-access', refreshToken: 'new-refresh', idToken: 'new-id' }

    it('returns no-live when auth.json does not exist', async () => {
      await expect(persistRotatedLiveCodexTokens(rotated, 'old-refresh')).resolves.toBe('no-live')
    })

    it('returns skipped-race without writing when the live refresh token no longer matches', async () => {
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            id_token: idTokenFor('user-x', 'acct-x'),
            access_token: 'live-access',
            refresh_token: 'someone-else-already-rotated-this',
            account_id: 'acct-x'
          },
          last_refresh: '2026-01-01T00:00:00.000Z'
        })
      )

      const outcome = await persistRotatedLiveCodexTokens(rotated, 'old-refresh')

      expect(outcome).toBe('skipped-race')
      const live = await readCodexLive()
      expect(live?.tokens?.access_token).toBe('live-access')
      expect(live?.last_refresh).toBe('2026-01-01T00:00:00.000Z')
    })

    it('patches tokens and last_refresh (mode 0600) when the refresh token matches, without requiring a managed account', async () => {
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          OPENAI_API_KEY: null,
          auth_mode: 'chatgpt',
          tokens: {
            id_token: idTokenFor('user-unmanaged', 'acct-unmanaged'),
            access_token: 'live-access',
            refresh_token: 'old-refresh',
            account_id: 'acct-unmanaged'
          },
          last_refresh: '2026-01-01T00:00:00.000Z'
        })
      )

      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
      const outcome = await persistRotatedLiveCodexTokens(rotated, 'old-refresh')

      expect(outcome).toBe('persisted')
      const live = await readCodexLive()
      expect(live?.tokens).toMatchObject({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        account_id: 'acct-unmanaged'
      })
      expect(live?.last_refresh).toBe('2026-03-01T00:00:00.000Z')

      const { stat } = await import('fs/promises')
      const stats = await stat(join(codexHome, 'auth.json'))
      expect(stats.mode & 0o777).toBe(0o600)

      // Not a managed account: no snapshot file should have been created for it.
      await expect(readCodexSnapshot('user-unmanaged::acct-unmanaged')).resolves.toBeNull()
    })

    it('mirrors the patched auth to the snapshot when the live account_key is managed', async () => {
      const idToken = idTokenFor('user-1', 'acct-1')
      await addCodexAccount(idToken, 'old-access', 'old-refresh')
      await switchCodexAccount('user-1::acct-1')

      const outcome = await persistRotatedLiveCodexTokens(rotated, 'old-refresh')

      expect(outcome).toBe('persisted')
      const snapshot = await readCodexSnapshot('user-1::acct-1')
      expect(snapshot?.tokens).toMatchObject({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id'
      })
    })

    it('only rotates the fields provided, leaving refresh/id token untouched when omitted', async () => {
      const idToken = idTokenFor('user-2', 'acct-2')
      await addCodexAccount(idToken, 'old-access', 'old-refresh')
      await switchCodexAccount('user-2::acct-2')

      const outcome = await persistRotatedLiveCodexTokens({ accessToken: 'access-only' }, 'old-refresh')

      expect(outcome).toBe('persisted')
      const live = await readCodexLive()
      expect(live?.tokens).toMatchObject({
        access_token: 'access-only',
        refresh_token: 'old-refresh',
        id_token: idToken
      })
    })
  })
})
