// Data projects (v66): the `data_projects` / `data_query_history` / `data_saved_queries`
// tables, their repair after a skewed or damaged schema, the DataProjectsRepository methods on
// DatabaseService (mapping, the sidebar order shared with `projects`, the 1000-row history cap,
// saved-query ownership) and the db:changed events they emit. Needs better-sqlite3 for the
// Electron ABI: run with
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run <file>
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DbChangedEvent } from '../../shared/db-change-events'
import type { DataProjectRecordCreate } from '../services/data-projects/contracts'
import {
  flushPendingDbChangedEvents,
  setDbChangeEventPublisher
} from '../services/db-change-events'
import { DATA_QUERY_HISTORY_LIMIT, DatabaseService } from './database'
import {
  CURRENT_SCHEMA_VERSION,
  DATA_PROJECT_TABLES_DROP_SQL,
  DATA_PROJECT_TABLES_SQL,
  MIGRATIONS
} from './schema'

const tempDirs: string[] = []
let databaseLoadError: Error | null = null

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch (error) {
    databaseLoadError = error as Error
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

const publisher = vi.fn<(channel: string, payload: unknown) => Promise<void>>(async () => {})

const drain = (): DbChangedEvent[] => {
  flushPendingDbChangedEvents()
  const events = publisher.mock.calls.map(([, payload]) => payload as DbChangedEvent)
  publisher.mockClear()
  return events
}

const makePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-data-projects-'))
  tempDirs.push(dir)
  return join(dir, 'state.sqlite')
}

const openDb = (path = makePath()): DatabaseService => {
  const db = new DatabaseService(path)
  db.init()
  drain()
  return db
}

const fixture = (overrides: Partial<DataProjectRecordCreate> = {}): DataProjectRecordCreate => ({
  name: 'shop @ localhost',
  engine: 'postgres',
  config: { host: '127.0.0.1', port: 15432, database: 'shop', user: 'postgres' },
  icon: null,
  iconColor: null,
  environment: 'local',
  color: null,
  safeMode: 'off',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretCiphertext: null,
  secretState: 'none',
  ...overrides
})

const sortOrders = (db: DatabaseService): Record<string, number> => {
  const raw = db.getRawDb()
  const rows = [
    ...(raw.prepare('SELECT id, sort_order FROM projects').all() as Array<{
      id: string
      sort_order: number
    }>),
    ...(raw.prepare('SELECT id, sort_order FROM data_projects').all() as Array<{
      id: string
      sort_order: number
    }>)
  ]
  return Object.fromEntries(rows.map((row) => [row.id, row.sort_order]))
}

beforeEach(() => {
  publisher.mockClear()
  setDbChangeEventPublisher(publisher)
})

afterEach(() => {
  flushPendingDbChangedEvents()
  setDbChangeEventPublisher(null)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('data projects schema', () => {
  it('ships as the v66 migration and is the current version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(66)
    const migration = MIGRATIONS.find((m) => m.version === 66)
    expect(migration?.name).toBe('add_data_projects')
    expect(migration?.up).toBe(DATA_PROJECT_TABLES_SQL)
    expect(migration?.down).toBe(DATA_PROJECT_TABLES_DROP_SQL)
    expect(MIGRATIONS.at(-1)?.version).toBe(CURRENT_SCHEMA_VERSION)
  })
})

describeIf('data projects database', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
    return
  }

  describe('tables and repair', () => {
    it('creates the three tables and their indexes on a fresh database', () => {
      const db = openDb()
      try {
        expect(db.getSchemaVersion()).toBe(66)
        for (const table of ['data_projects', 'data_query_history', 'data_saved_queries']) {
          expect(db.tableExists(table)).toBe(true)
        }
        const indexes = db.getIndexes().map((index) => index.name)
        expect(indexes).toEqual(
          expect.arrayContaining([
            'idx_data_projects_sort',
            'idx_data_query_history_project',
            'idx_data_saved_queries_project'
          ])
        )
      } finally {
        db.close()
      }
    })

    it('repairs dropped tables when schema_version already says 66 (worktree skew)', () => {
      const path = makePath()
      const first = openDb(path)
      first.getRawDb().exec(DATA_PROJECT_TABLES_DROP_SQL)
      expect(first.tableExists('data_projects')).toBe(false)
      expect(first.getSchemaVersion()).toBe(66)
      first.close()

      const reopened = openDb(path)
      try {
        expect(reopened.getSchemaVersion()).toBe(66)
        expect(reopened.tableExists('data_projects')).toBe(true)
        expect(reopened.tableExists('data_query_history')).toBe(true)
        expect(reopened.tableExists('data_saved_queries')).toBe(true)
        // And they work: the cascade FK is there too.
        const created = reopened.createDataProject(fixture())
        reopened.addDataQueryHistory({
          dataProjectId: created.id,
          database: null,
          text: 'select 1',
          status: 'ok',
          durationMs: 1,
          rowCount: 1,
          error: null,
          executedAt: new Date().toISOString()
        })
        expect(reopened.deleteDataProject(created.id)).toBe(true)
        expect(reopened.listDataQueryHistory(created.id)).toEqual([])
      } finally {
        reopened.close()
      }
    })

    it('migrates a v65 database up to 66', () => {
      const path = makePath()
      const first = openDb(path)
      first.getRawDb().exec(DATA_PROJECT_TABLES_DROP_SQL)
      first.setSetting('schema_version', '65')
      first.close()

      const upgraded = openDb(path)
      try {
        expect(upgraded.getSchemaVersion()).toBe(66)
        expect(upgraded.tableExists('data_projects')).toBe(true)
      } finally {
        upgraded.close()
      }
    })

    it('keeps existing rows when the repair runs again', () => {
      const path = makePath()
      const first = openDb(path)
      const created = first.createDataProject(fixture())
      first.close()
      const reopened = openDb(path)
      try {
        expect(reopened.getDataProject(created.id)?.name).toBe('shop @ localhost')
      } finally {
        reopened.close()
      }
    })
  })

  describe('rows', () => {
    it('creates, maps every field and reads back', () => {
      const db = openDb()
      try {
        const created = db.createDataProject(
          fixture({
            id: 'dp-1',
            engine: 'mongodb',
            config: { mongo: { srv: true, hosts: ['cluster0.example.net'] }, database: 'shop' },
            icon: { kind: 'emoji', emoji: '🛒' },
            iconColor: '#ff0000',
            environment: 'production',
            color: '#123456',
            safeMode: 'read-only',
            defaultLimit: 250,
            allowAiDataAccess: true,
            pinned: true,
            secretCiphertext: 'v1:abc',
            secretState: 'stored'
          })
        )
        expect(created).toMatchObject({
          id: 'dp-1',
          engine: 'mongodb',
          config: { mongo: { srv: true, hosts: ['cluster0.example.net'] }, database: 'shop' },
          icon: { kind: 'emoji', emoji: '🛒' },
          iconColor: '#ff0000',
          environment: 'production',
          color: '#123456',
          safeMode: 'read-only',
          defaultLimit: 250,
          allowAiDataAccess: true,
          pinned: true,
          secretCiphertext: 'v1:abc',
          secretState: 'stored',
          sortOrder: 0
        })
        expect(created.createdAt).toBe(created.lastAccessedAt)
        expect(db.getDataProject('dp-1')).toEqual(created)
        expect(db.getDataProject('missing')).toBeNull()
        // No git project moved, so no project reorder.
        expect(drain()).toEqual([
          expect.objectContaining({ entity: 'dataProject', op: 'create', id: 'dp-1' })
        ])
      } finally {
        db.close()
      }
    })

    it('generates an id when none is given and never stores plaintext secrets', () => {
      const db = openDb()
      try {
        const created = db.createDataProject(fixture())
        expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
        const row = db
          .getRawDb()
          .prepare('SELECT * FROM data_projects WHERE id = ?')
          .get(created.id)
        expect(Object.keys(row as object)).not.toContain('password')
      } finally {
        db.close()
      }
    })

    it('degrades unknown values from a newer build to conservative ones', () => {
      const db = openDb()
      try {
        const created = db.createDataProject(fixture({ id: 'dp-odd' }))
        db.getRawDb()
          .prepare(
            `UPDATE data_projects SET safe_mode = 'yolo', environment = 'moon', config = 'not json',
               icon = '{"kind":"hologram"}', secret_state = 'weird', secret_ciphertext = 'v1:x'
             WHERE id = ?`
          )
          .run(created.id)
        db.getRawDb()
          .prepare(
            `INSERT INTO data_projects (id, name, engine, created_at, last_accessed_at)
             VALUES ('dp-future', 'future', 'redis', 'x', 'x')`
          )
          .run()
        const record = db.getDataProject('dp-odd')
        expect(record).toMatchObject({
          safeMode: 'safe',
          environment: 'development',
          config: {},
          icon: null,
          secretState: 'stored'
        })
        expect(db.getDataProject('dp-future')).toBeNull()
        expect(db.getDataProjects().map((p) => p.id)).toEqual(['dp-odd'])
      } finally {
        db.close()
      }
    })

    it('updates only the patched fields and emits update', () => {
      const db = openDb()
      try {
        const created = db.createDataProject(
          fixture({ id: 'dp-u', icon: { kind: 'lucide', name: 'database' } })
        )
        drain()
        const updated = db.updateDataProject('dp-u', {
          name: 'renamed',
          icon: null,
          pinned: true,
          defaultLimit: 0,
          config: { host: 'db.example.com', port: 5432 },
          secretCiphertext: 'v1:new',
          secretState: 'stored'
        })
        expect(updated).toMatchObject({
          name: 'renamed',
          icon: null,
          pinned: true,
          defaultLimit: 0,
          config: { host: 'db.example.com', port: 5432 },
          secretCiphertext: 'v1:new',
          secretState: 'stored',
          safeMode: created.safeMode,
          environment: created.environment
        })
        expect(drain()).toEqual([
          expect.objectContaining({ entity: 'dataProject', op: 'update', id: 'dp-u' })
        ])
        expect(db.updateDataProject('dp-u', {})).toEqual(updated)
        expect(drain()).toEqual([])
        expect(db.updateDataProject('missing', { name: 'x' })).toBeNull()
      } finally {
        db.close()
      }
    })

    it('touches last_accessed_at, only emitting for an existing row', async () => {
      const db = openDb()
      try {
        const created = db.createDataProject(fixture({ id: 'dp-t' }))
        drain()
        await new Promise((resolve) => setTimeout(resolve, 5))
        db.touchDataProject('dp-t')
        expect(db.getDataProject('dp-t')!.lastAccessedAt > created.lastAccessedAt).toBe(true)
        expect(drain()).toEqual([
          expect.objectContaining({ entity: 'dataProject', op: 'update', id: 'dp-t' })
        ])
        db.touchDataProject('missing')
        expect(drain()).toEqual([])
      } finally {
        db.close()
      }
    })

    it('deletes the row with its history and saved queries (cascade)', () => {
      const db = openDb()
      try {
        db.createDataProject(fixture({ id: 'dp-d' }))
        db.addDataQueryHistory({
          dataProjectId: 'dp-d',
          database: 'shop',
          text: 'select 1',
          status: 'ok',
          durationMs: 3,
          rowCount: 1,
          error: null,
          executedAt: new Date().toISOString()
        })
        db.saveDataSavedQuery('dp-d', { name: 'one', text: 'select 1' })
        drain()
        expect(db.deleteDataProject('dp-d')).toBe(true)
        expect(drain()).toEqual([
          expect.objectContaining({ entity: 'dataProject', op: 'delete', id: 'dp-d' })
        ])
        const raw = db.getRawDb()
        expect(raw.prepare('SELECT COUNT(*) AS n FROM data_query_history').get()).toEqual({ n: 0 })
        expect(raw.prepare('SELECT COUNT(*) AS n FROM data_saved_queries').get()).toEqual({ n: 0 })
        expect(db.deleteDataProject('dp-d')).toBe(false)
        expect(drain()).toEqual([])
      } finally {
        db.close()
      }
    })
  })

  describe('shared sidebar order', () => {
    it('puts a new data project on top and shifts git projects and data projects', () => {
      const db = openDb()
      try {
        const project = db.createProject({ name: 'repo', path: '/tmp/repo-a' })
        drain()
        const first = db.createDataProject(fixture({ id: 'dp-a' }))
        expect(drain()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ entity: 'dataProject', op: 'create', id: 'dp-a' }),
            expect.objectContaining({ entity: 'project', op: 'reorder', id: null })
          ])
        )
        const second = db.createDataProject(fixture({ id: 'dp-b' }))
        expect(sortOrders(db)).toEqual({ [project.id]: 2, [first.id]: 1, [second.id]: 0 })
        expect(db.getDataProjects().map((p) => p.id)).toEqual(['dp-b', 'dp-a'])
      } finally {
        db.close()
      }
    })

    it('createProject and createConnectionProject also shift data projects', () => {
      const db = openDb()
      try {
        db.createDataProject(fixture({ id: 'dp-a' }))
        drain()
        const project = db.createProject({ name: 'repo', path: '/tmp/repo-b' })
        expect(drain()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ entity: 'project', op: 'create', id: project.id }),
            expect.objectContaining({ entity: 'dataProject', op: 'reorder', id: null })
          ])
        )
        const connection = db.createConnectionProject({
          name: 'conn',
          path: '/tmp/conn-b',
          member_project_ids: [project.id]
        })
        expect(sortOrders(db)).toEqual({ [connection.id]: 0, [project.id]: 1, 'dp-a': 2 })
      } finally {
        db.close()
      }
    })

    it('writes the merged order across both tables and emits both reorders', () => {
      const db = openDb()
      try {
        const a = db.createProject({ name: 'a', path: '/tmp/repo-c' })
        const b = db.createProject({ name: 'b', path: '/tmp/repo-d' })
        db.createDataProject(fixture({ id: 'dp-x' }))
        db.createDataProject(fixture({ id: 'dp-y' }))
        drain()
        db.reorderSidebar([
          { kind: 'data', id: 'dp-x' },
          { kind: 'project', id: b.id },
          { kind: 'data', id: 'dp-y' },
          { kind: 'project', id: a.id }
        ])
        expect(sortOrders(db)).toEqual({ 'dp-x': 0, [b.id]: 1, 'dp-y': 2, [a.id]: 3 })
        const events = drain()
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ entity: 'project', op: 'reorder' }),
            expect.objectContaining({ entity: 'dataProject', op: 'reorder' })
          ])
        )
        expect(events).toHaveLength(2)
      } finally {
        db.close()
      }
    })
  })

  describe('query history', () => {
    const entry = (text: string, executedAt: string, dataProjectId = 'dp-h') => ({
      dataProjectId,
      database: 'shop',
      text,
      status: 'ok' as const,
      durationMs: 12.6,
      rowCount: 3,
      error: null,
      executedAt
    })

    it('stores, lists newest first, searches case-insensitively and never emits', () => {
      const db = openDb()
      try {
        db.createDataProject(fixture({ id: 'dp-h' }))
        drain()
        const first = db.addDataQueryHistory(
          entry('SELECT * FROM users', '2026-10-01T10:00:00.000Z')
        )
        db.addDataQueryHistory(entry('select 100% from orders', '2026-10-01T11:00:00.000Z'))
        db.addDataQueryHistory({
          ...entry('DELETE FROM users', '2026-10-01T12:00:00.000Z'),
          status: 'blocked',
          durationMs: null,
          rowCount: null,
          error: 'read-only mode'
        })
        expect(first).toMatchObject({ durationMs: 13, rowCount: 3, database: 'shop' })
        expect(first.id).toBeTruthy()

        const all = db.listDataQueryHistory('dp-h')
        expect(all.map((h) => h.text)).toEqual([
          'DELETE FROM users',
          'select 100% from orders',
          'SELECT * FROM users'
        ])
        expect(all[0]).toMatchObject({
          status: 'blocked',
          error: 'read-only mode',
          durationMs: null
        })
        expect(db.listDataQueryHistory('dp-h', { search: 'users' })).toHaveLength(2)
        expect(db.listDataQueryHistory('dp-h', { search: 'USERS' })).toHaveLength(2)
        // LIKE wildcards in the search are literal.
        expect(db.listDataQueryHistory('dp-h', { search: '100%' }).map((h) => h.text)).toEqual([
          'select 100% from orders'
        ])
        expect(db.listDataQueryHistory('dp-h', { search: '_' })).toEqual([])
        expect(db.listDataQueryHistory('dp-h', { limit: 1 })).toHaveLength(1)
        expect(drain()).toEqual([])

        db.clearDataQueryHistory('dp-h')
        expect(db.listDataQueryHistory('dp-h')).toEqual([])
        expect(drain()).toEqual([])
      } finally {
        db.close()
      }
    })

    it('keeps only the newest 1000 entries per project', () => {
      const db = openDb()
      try {
        db.createDataProject(fixture({ id: 'dp-h' }))
        db.createDataProject(fixture({ id: 'dp-other' }))
        db.addDataQueryHistory(entry('other project', '2020-01-01T00:00:00.000Z', 'dp-other'))
        const base = Date.parse('2026-01-01T00:00:00.000Z')
        for (let i = 0; i < DATA_QUERY_HISTORY_LIMIT + 5; i++) {
          db.addDataQueryHistory(entry(`q${i}`, new Date(base + i * 1000).toISOString()))
        }
        const kept = db.listDataQueryHistory('dp-h', { limit: 5000 })
        expect(kept).toHaveLength(DATA_QUERY_HISTORY_LIMIT)
        expect(kept[0].text).toBe(`q${DATA_QUERY_HISTORY_LIMIT + 4}`)
        expect(kept.at(-1)?.text).toBe('q5')
        expect(db.listDataQueryHistory('dp-other')).toHaveLength(1)
      } finally {
        db.close()
      }
    })

    it('caps a huge statement instead of storing megabytes', () => {
      const db = openDb()
      try {
        db.createDataProject(fixture({ id: 'dp-h' }))
        const stored = db.addDataQueryHistory(entry('x'.repeat(300_000), new Date().toISOString()))
        expect(stored.text.length).toBeLessThan(110_000)
        expect(stored.text).toContain('[truncated: 200000 more characters]')
      } finally {
        db.close()
      }
    })
  })

  describe('saved queries', () => {
    it('inserts, updates in place, keeps ids per project and deletes', () => {
      const db = openDb()
      try {
        db.createDataProject(fixture({ id: 'dp-s' }))
        db.createDataProject(fixture({ id: 'dp-t' }))
        drain()
        const created = db.saveDataSavedQuery('dp-s', {
          name: 'Revenue',
          text: 'select sum(total) from orders',
          database: 'shop'
        })
        expect(created).toMatchObject({ dataProjectId: 'dp-s', name: 'Revenue', database: 'shop' })
        expect(drain()).toEqual([
          expect.objectContaining({ entity: 'dataProject', op: 'update', id: 'dp-s' })
        ])

        const updated = db.saveDataSavedQuery('dp-s', {
          id: created.id,
          name: 'Revenue (all)',
          text: 'select 1',
          database: null
        })
        expect(updated).toMatchObject({ id: created.id, name: 'Revenue (all)', database: null })
        expect(updated.createdAt).toBe(created.createdAt)

        // Another project's id is never overwritten: a new row is created instead.
        const foreign = db.saveDataSavedQuery('dp-t', { id: created.id, name: 'mine', text: 'x' })
        expect(foreign.id).not.toBe(created.id)
        expect(db.listDataSavedQueries('dp-s').map((q) => q.name)).toEqual(['Revenue (all)'])

        db.saveDataSavedQuery('dp-s', { name: 'alpha', text: 'select 2' })
        expect(db.listDataSavedQueries('dp-s').map((q) => q.name)).toEqual([
          'alpha',
          'Revenue (all)'
        ])

        drain()
        db.deleteDataSavedQuery('dp-t', created.id)
        expect(db.listDataSavedQueries('dp-s')).toHaveLength(2)
        expect(drain()).toEqual([])
        db.deleteDataSavedQuery('dp-s', created.id)
        expect(db.listDataSavedQueries('dp-s').map((q) => q.name)).toEqual(['alpha'])
        expect(drain()).toEqual([
          expect.objectContaining({ entity: 'dataProject', op: 'update', id: 'dp-s' })
        ])
      } finally {
        db.close()
      }
    })
  })
})
