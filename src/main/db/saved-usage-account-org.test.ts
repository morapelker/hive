import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DatabaseService } from './database'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema'
import { normalizeOrgUuid } from './types'

// better-sqlite3 is built for Electron and does not load in every Node that runs these tests,
// so the service runs here on Node's own SQLite: the same SQL, behind the few calls of the
// better-sqlite3 handle the service makes.
type Transaction = ((...args: unknown[]) => unknown) & {
  immediate: (...args: unknown[]) => unknown
}

const open: DatabaseSync[] = []
const tempDirs: string[] = []

function openService(path = ':memory:'): { service: DatabaseService; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(path)
  open.push(sqlite)
  const handle = {
    exec: (sql: string) => sqlite.exec(sql),
    prepare: (sql: string) => sqlite.prepare(sql),
    pragma: (statement: string) => sqlite.prepare(`PRAGMA ${statement}`).all(),
    transaction: (fn: (...args: unknown[]) => unknown): Transaction => {
      const run = (...args: unknown[]): unknown => fn(...args)
      return Object.assign(run, { immediate: run })
    }
  }
  const service = Object.create(DatabaseService.prototype) as DatabaseService
  Object.defineProperty(service, 'getDb', { value: () => handle })
  return { service, sqlite }
}

/** The app's own migration pass, as `init()` runs it once the file is open. */
function migrate(service: DatabaseService): void {
  ;(service as unknown as { runMigrations(): void }).runMigrations()
}

/** A migrated store; with a path, one that is on disk and can be opened again. */
function openStore(path?: string): { service: DatabaseService; sqlite: DatabaseSync } {
  const store = openService(path)
  migrate(store.service)
  return store
}

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-saved-usage-account-org-'))
  tempDirs.push(dir)
  return join(dir, 'hive.db')
}

function accountColumns(sqlite: DatabaseSync): Array<{ name: string; notnull: number }> {
  return sqlite.prepare('PRAGMA table_info(saved_usage_accounts)').all() as Array<{
    name: string
    notnull: number
  }>
}

function accountRows(sqlite: DatabaseSync): Array<Record<string, unknown>> {
  return sqlite.prepare('SELECT * FROM saved_usage_accounts ORDER BY id').all() as Array<
    Record<string, unknown>
  >
}

function addAccount(
  service: DatabaseService,
  email: string,
  provider: 'anthropic' | 'openai' = 'anthropic'
): string {
  return service.upsertSavedUsageAccount({ provider, email, credentials_json: '' }).id
}

/** What the migration pass reported as failed: `[db] Migration v<n> (<name>) failed:`. */
function failedMigrations(log: { mock: { calls: unknown[][] } }): string[] {
  return log.mock.calls.map(([message]) => String(message))
}

// Not real organizations.
const ORG_A = '11111111-2222-4333-8444-555555555555'
const ORG_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const USAGE = JSON.stringify({ five_hour: { utilization: 12, resets_at: '2026-11-17T18:00:00Z' } })

describe('saved_usage_accounts.org_uuid', () => {
  // On a new database the early ALTER TABLE migrations find their columns in place and say so
  // on the console; the repair pass after them is what the app relies on.
  let migrationLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    migrationLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    migrationLog.mockRestore()
    for (const sqlite of open.splice(0)) {
      if (sqlite.isOpen) sqlite.close()
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  describe('schema', () => {
    it('is migration 64, and a note: the column is added by the idempotent repair', () => {
      const migration = MIGRATIONS.find((entry) => entry.version === 64)
      expect(migration?.name).toBe('add_saved_usage_account_org_uuid')
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(64)
      expect(MIGRATIONS.at(-1)?.version).toBe(CURRENT_SCHEMA_VERSION)
      // Nothing but SQL comments: a statement here would fail with "duplicate column" on a
      // database another build already repaired.
      const lines = (migration?.up ?? '').split('\n').map((line) => line.trim())
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.every((line) => line.startsWith('--'))).toBe(true)
    })

    it('exists on a new database as a nullable column, with no index of its own', () => {
      const { service, sqlite } = openStore()

      const column = accountColumns(sqlite).find((entry) => entry.name === 'org_uuid')
      expect(column).toMatchObject({ name: 'org_uuid', notnull: 0 })
      expect(service.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      expect(failedMigrations(migrationLog).filter((line) => line.includes('v64 '))).toEqual([])
      // Seats of one team share an organization: nothing may make the value unique.
      const indexes = sqlite.prepare('PRAGMA index_list(saved_usage_accounts)').all() as Array<{
        name: string
      }>
      expect(indexes.map((index) => index.name).sort()).toEqual([
        'idx_saved_usage_accounts_provider_created',
        'idx_saved_usage_accounts_provider_email',
        // The primary key's own index.
        'sqlite_autoindex_saved_usage_accounts_1'
      ])
    })

    it('is added to a database of the version before, and leaves its rows as they were', () => {
      const { service, sqlite } = openStore()
      const claude = addAccount(service, 'claude@example.com')
      addAccount(service, 'codex@example.com', 'openai')
      service.updateSavedUsageAccountUsage(claude, {
        last_usage_json: USAGE,
        status: 'stale',
        last_error: 'rate limited'
      })
      // Back to what version 63 left on disk.
      sqlite.exec('ALTER TABLE saved_usage_accounts DROP COLUMN org_uuid')
      sqlite.exec("UPDATE settings SET value = '63' WHERE key = 'schema_version'")
      expect(accountColumns(sqlite).map((column) => column.name)).not.toContain('org_uuid')
      const before = accountRows(sqlite)
      expect(before).toHaveLength(2)
      migrationLog.mockClear()

      migrate(service)

      expect(failedMigrations(migrationLog)).toEqual([])
      expect(service.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      // Every row is what it was, with the new value empty.
      expect(accountRows(sqlite)).toEqual(before.map((row) => ({ ...row, org_uuid: null })))
      expect(service.getSavedUsageAccountById(claude)).toMatchObject({
        last_usage_json: USAGE,
        status: 'stale',
        last_error: 'rate limited',
        org_uuid: null
      })

      // A second start of the app finds the column and leaves it.
      expect(() => migrate(service)).not.toThrow()
      expect(accountColumns(sqlite).filter((column) => column.name === 'org_uuid')).toHaveLength(1)
    })

    it('is repaired on a database already stamped with the current version', () => {
      const { service, sqlite } = openStore()
      const claude = addAccount(service, 'claude@example.com')
      sqlite.exec('ALTER TABLE saved_usage_accounts DROP COLUMN org_uuid')

      migrate(service)

      expect(accountColumns(sqlite).map((column) => column.name)).toContain('org_uuid')
      expect(service.getSavedUsageAccountOrgUuid(claude)).toBeNull()
    })
  })

  describe('an account with no organization yet', () => {
    it('reads as null, one by one, in the list and on the row', () => {
      const { service } = openStore()
      const id = addAccount(service, 'claude@example.com')

      expect(service.getSavedUsageAccountOrgUuid(id)).toBeNull()
      expect(service.getSavedUsageAccountOrganizations()).toEqual([
        { id, email: 'claude@example.com', org_uuid: null }
      ])
      expect(service.getSavedUsageAccountById(id)?.org_uuid).toBeNull()
      expect(
        service.getSavedUsageAccountByProviderEmail('anthropic', 'claude@example.com')?.org_uuid
      ).toBeNull()
      expect(service.getSavedUsageAccountsByProvider('anthropic')[0]?.org_uuid).toBeNull()
    })

    it('has no organization for an id that is no account', () => {
      const { service } = openStore()

      expect(service.getSavedUsageAccountOrgUuid('no-such-account')).toBeNull()
      expect(service.getSavedUsageAccountOrganizations()).toEqual([])
    })
  })

  describe('set and clear', () => {
    it('keeps the value over a restart of the store, and null after it is cleared', () => {
      const dbPath = makeDbPath()
      const first = openStore(dbPath)
      const id = addAccount(first.service, 'claude@example.com')
      expect(first.service.setSavedUsageAccountOrgUuid(id, ORG_A)?.org_uuid).toBe(ORG_A)
      first.sqlite.close()

      const second = openStore(dbPath)
      expect(second.service.getSavedUsageAccountOrgUuid(id)).toBe(ORG_A)
      expect(second.service.getSavedUsageAccountById(id)?.org_uuid).toBe(ORG_A)
      expect(second.service.getSavedUsageAccountOrganizations()).toEqual([
        { id, email: 'claude@example.com', org_uuid: ORG_A }
      ])
      expect(second.service.setSavedUsageAccountOrgUuid(id, null)?.org_uuid).toBeNull()
      second.sqlite.close()

      const third = openStore(dbPath)
      expect(third.service.getSavedUsageAccountOrgUuid(id)).toBeNull()
      expect(third.service.getSavedUsageAccountOrganizations()).toEqual([
        { id, email: 'claude@example.com', org_uuid: null }
      ])
    })

    it('replaces a stored organization with a new one', () => {
      const { service } = openStore()
      const id = addAccount(service, 'claude@example.com')

      service.setSavedUsageAccountOrgUuid(id, ORG_A)
      service.setSavedUsageAccountOrgUuid(id, ORG_B)

      expect(service.getSavedUsageAccountOrgUuid(id)).toBe(ORG_B)
    })

    it('stores the value trimmed and lower-cased, and an empty one as none', () => {
      const { service } = openStore()
      const id = addAccount(service, 'claude@example.com')

      service.setSavedUsageAccountOrgUuid(id, `  ${ORG_B.toUpperCase()}\n`)
      expect(service.getSavedUsageAccountOrgUuid(id)).toBe(ORG_B)
      expect(normalizeOrgUuid(`  ${ORG_B.toUpperCase()}\n`)).toBe(ORG_B)

      service.setSavedUsageAccountOrgUuid(id, '   ')
      expect(service.getSavedUsageAccountOrgUuid(id)).toBeNull()

      service.setSavedUsageAccountOrgUuid(id, ORG_A)
      service.setSavedUsageAccountOrgUuid(id, '')
      expect(service.getSavedUsageAccountOrgUuid(id)).toBeNull()

      expect(normalizeOrgUuid('')).toBeNull()
      expect(normalizeOrgUuid(null)).toBeNull()
      expect(normalizeOrgUuid(undefined)).toBeNull()
    })

    it('reports an id that is no account, and writes no row for it', () => {
      const { service, sqlite } = openStore()
      const id = addAccount(service, 'claude@example.com')

      expect(service.setSavedUsageAccountOrgUuid('no-such-account', ORG_A)).toBeNull()

      expect(accountRows(sqlite)).toHaveLength(1)
      expect(service.getSavedUsageAccountOrgUuid(id)).toBeNull()
    })

    it('touches one account only', () => {
      const { service } = openStore()
      const first = addAccount(service, 'first@example.com')
      const second = addAccount(service, 'second@example.com')
      service.setSavedUsageAccountOrgUuid(first, ORG_A)
      service.setSavedUsageAccountOrgUuid(second, ORG_B)

      service.setSavedUsageAccountOrgUuid(first, null)

      expect(service.getSavedUsageAccountOrgUuid(first)).toBeNull()
      expect(service.getSavedUsageAccountOrgUuid(second)).toBe(ORG_B)
    })

    it('does not alter the usage, status, last error or fetch time of the account', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'))
      const { service, sqlite } = openStore()
      const id = addAccount(service, 'claude@example.com')
      service.updateSavedUsageAccountUsage(id, {
        last_usage_json: USAGE,
        status: 'error',
        last_error: 'poll failed'
      })
      const [before] = accountRows(sqlite)
      expect(before).toMatchObject({
        last_usage_json: USAGE,
        last_fetched_at: '2026-11-17T10:00:00.000Z',
        status: 'error',
        last_error: 'poll failed'
      })

      vi.setSystemTime(new Date('2026-11-17T10:05:00.000Z'))
      service.setSavedUsageAccountOrgUuid(id, ORG_A)

      // Only the organization and the row's own modification time moved.
      expect(accountRows(sqlite)).toEqual([
        { ...before, org_uuid: ORG_A, updated_at: '2026-11-17T10:05:00.000Z' }
      ])

      vi.setSystemTime(new Date('2026-11-17T10:10:00.000Z'))
      service.setSavedUsageAccountOrgUuid(id, null)

      expect(accountRows(sqlite)).toEqual([
        { ...before, org_uuid: null, updated_at: '2026-11-17T10:10:00.000Z' }
      ])
    })

    it('writes nothing when the value is the one already stored', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'))
      const { service, sqlite } = openStore()
      const id = addAccount(service, 'claude@example.com')
      service.setSavedUsageAccountOrgUuid(id, ORG_A)
      const before = accountRows(sqlite)

      vi.setSystemTime(new Date('2026-11-17T10:05:00.000Z'))
      expect(service.setSavedUsageAccountOrgUuid(id, ORG_A.toUpperCase())?.org_uuid).toBe(ORG_A)
      expect(accountRows(sqlite)).toEqual(before)

      // The same for an account that has none and is cleared again.
      const other = addAccount(service, 'other@example.com')
      const cleared = accountRows(sqlite)
      vi.setSystemTime(new Date('2026-11-17T10:10:00.000Z'))
      expect(service.setSavedUsageAccountOrgUuid(other, null)?.org_uuid).toBeNull()
      expect(accountRows(sqlite)).toEqual(cleared)
    })
  })

  describe('other writes to the account', () => {
    it('keep its organization: a poll, a live reading, a new sign-in, cleared credentials', () => {
      const { service } = openStore()
      const id = addAccount(service, 'claude@example.com')
      service.setSavedUsageAccountOrgUuid(id, ORG_A)

      const polled = service.updateSavedUsageAccountUsage(id, {
        last_usage_json: USAGE,
        status: 'ok',
        last_error: null
      })
      expect(polled).toMatchObject({ last_usage_json: USAGE, org_uuid: ORG_A })

      const live = service.updateSavedUsageAccountLiveUsage(id, '{"live":true}')
      expect(live).toMatchObject({ last_usage_json: '{"live":true}', org_uuid: ORG_A })

      // The same account saved again, with and without a usage snapshot.
      const again = service.upsertSavedUsageAccount({
        provider: 'anthropic',
        email: 'Claude@Example.com',
        credentials_json: '{"k":1}'
      })
      expect(again).toMatchObject({ id, credentials_json: '{"k":1}', org_uuid: ORG_A })
      const withUsage = service.upsertSavedUsageAccount({
        provider: 'anthropic',
        email: 'claude@example.com',
        credentials_json: '',
        last_usage_json: null,
        status: 'error',
        last_error: 'expired'
      })
      expect(withUsage).toMatchObject({ id, last_usage_json: null, org_uuid: ORG_A })

      service.clearSavedUsageAccountCredentialsById(id)
      expect(service.getSavedUsageAccountOrgUuid(id)).toBe(ORG_A)
      service.clearSavedUsageAccountCredentials()
      expect(service.getSavedUsageAccountOrgUuid(id)).toBe(ORG_A)
    })

    it('a deleted account takes its organization with it', () => {
      const { service } = openStore()
      const id = addAccount(service, 'claude@example.com')
      service.setSavedUsageAccountOrgUuid(id, ORG_A)

      expect(service.deleteSavedUsageAccount(id)).toBe(true)

      expect(service.getSavedUsageAccountOrgUuid(id)).toBeNull()
      expect(service.getSavedUsageAccountOrganizations()).toEqual([])
      // Saved again, the account starts with none.
      const recreated = addAccount(service, 'claude@example.com')
      expect(service.getSavedUsageAccountOrgUuid(recreated)).toBeNull()
    })
  })

  describe('read for all accounts', () => {
    it('lists every Claude account oldest first, known or not, and no other provider', () => {
      vi.useFakeTimers()
      const { service } = openStore()
      vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'))
      const first = addAccount(service, 'first@example.com')
      vi.setSystemTime(new Date('2026-11-17T10:01:00.000Z'))
      const codex = addAccount(service, 'codex@example.com', 'openai')
      vi.setSystemTime(new Date('2026-11-17T10:02:00.000Z'))
      const second = addAccount(service, 'second@example.com')
      vi.setSystemTime(new Date('2026-11-17T10:03:00.000Z'))
      const third = addAccount(service, 'third@example.com')
      service.setSavedUsageAccountOrgUuid(third, ORG_B)
      service.setSavedUsageAccountOrgUuid(first, ORG_A)

      expect(service.getSavedUsageAccountOrganizations()).toEqual([
        { id: first, email: 'first@example.com', org_uuid: ORG_A },
        { id: second, email: 'second@example.com', org_uuid: null },
        { id: third, email: 'third@example.com', org_uuid: ORG_B }
      ])
      expect(service.getSavedUsageAccountOrganizations('anthropic')).toEqual(
        service.getSavedUsageAccountOrganizations()
      )
      expect(service.getSavedUsageAccountOrganizations('openai')).toEqual([
        { id: codex, email: 'codex@example.com', org_uuid: null }
      ])
    })

    it('lets two accounts carry the same organization', () => {
      const { service } = openStore()
      const first = addAccount(service, 'seat-one@example.com')
      const second = addAccount(service, 'seat-two@example.com')

      expect(service.setSavedUsageAccountOrgUuid(first, ORG_A)?.org_uuid).toBe(ORG_A)
      expect(service.setSavedUsageAccountOrgUuid(second, ORG_A)?.org_uuid).toBe(ORG_A)

      const sharing = service
        .getSavedUsageAccountOrganizations()
        .filter((account) => account.org_uuid === ORG_A)
      expect(sharing.map((account) => account.id).sort()).toEqual([first, second].sort())
    })
  })
})
