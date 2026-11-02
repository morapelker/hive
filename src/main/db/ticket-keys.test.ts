// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_DOCUMENT_RUN_CONFIG, type DocumentRunItemDraft } from '@shared/types/document-flow'
import { TICKET_KEY_PREFIX_SETTING } from '@shared/ticket-key'

import { setDbChangeEventPublisher } from '../services/db-change-events'
import { DatabaseService } from './database'
import { CURRENT_SCHEMA_VERSION } from './schema'
import type { KanbanTicket } from './types'

// Ticket keys (TD-12) against a real SQLite file: the v57 columns, the machine-wide number
// sequence, the one-time prefix, the backfill of a database from before the keys (including
// the regrouping of a document run's tickets) and the parent link read through the join.

const tempDirs: string[] = []
const openDbs: DatabaseService[] = []
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

const makeDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-ticket-keys-'))
  tempDirs.push(dir)
  return join(dir, 'state.sqlite')
}

const openDb = (path = makeDbPath()): DatabaseService => {
  const db = new DatabaseService(path)
  db.init()
  openDbs.push(db)
  return db
}

/** `new Date()` inside DatabaseService returns this instant until the next call. */
const at = (iso: string): string => {
  vi.setSystemTime(new Date(iso))
  return iso
}

const columnNames = (db: DatabaseService, table: string): string[] =>
  (db.getRawDb().pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name)

const tableNames = (db: DatabaseService): string[] =>
  (
    db
      .getRawDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name)

const makeProject = (db: DatabaseService, name = 'repo'): string =>
  db.createProject({ name, path: `/tmp/ticket-keys-${name}-${randomUUID()}` }).id

const makeTicket = (
  db: DatabaseService,
  projectId: string,
  title: string,
  over: Partial<Parameters<DatabaseService['createKanbanTicket']>[0]> = {}
): KanbanTicket => db.createKanbanTicket({ project_id: projectId, title, ...over })

const draft = (key: string, over: Partial<DocumentRunItemDraft> = {}): DocumentRunItemDraft => ({
  key,
  title: `Task ${key}`,
  summary: '',
  description: '',
  kind: 'change',
  depends_on: [],
  has_migration: false,
  size: null,
  conflict_risk: null,
  doc_status: 'unknown',
  selected: true,
  figures: [],
  open_questions: [],
  verification_suggested: [],
  verification: [],
  verification_reason: '',
  ...over
})

const makeRun = (db: DatabaseService, projectId: string, ticketId: string | null): string => {
  const run = db.createDocumentRun({
    id: randomUUID(),
    project_id: projectId,
    title: 'Checkout spec',
    source_path: '/docs/checkout.html',
    run_dir: '/runs/checkout',
    status: 'running',
    config: DEFAULT_DOCUMENT_RUN_CONFIG
  })
  if (ticketId) db.updateDocumentRun(run.id, { ticket_id: ticketId })
  return run.id
}

/** `id -> ticket_number` for every row in the file, archived ones included. */
const numbersById = (db: DatabaseService): Record<string, number | null> =>
  Object.fromEntries(
    (
      db.getRawDb().prepare('SELECT id, ticket_number FROM kanban_tickets').all() as {
        id: string
        ticket_number: number | null
      }[]
    ).map((row) => [row.id, row.ticket_number])
  )

/** Every ticket column of every row, for "nothing changed" comparisons. */
const allRows = (db: DatabaseService): unknown[] =>
  db.getRawDb().prepare('SELECT * FROM kanban_tickets ORDER BY id').all()

/**
 * Turns a current-schema file back into one written by the build before the keys existed:
 * no key columns, no counter, schema_version 56. Everything else (projects, runs, items and
 * the tickets themselves) stays, so the file is exactly what the v57 repair finds on upgrade.
 */
const stripTicketKeys = (dbPath: string): void => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const raw = new Database(dbPath)
  raw.exec(`
    DROP INDEX IF EXISTS idx_kanban_tickets_number;
    DROP INDEX IF EXISTS idx_kanban_tickets_parent;
    ALTER TABLE kanban_tickets DROP COLUMN ticket_prefix;
    ALTER TABLE kanban_tickets DROP COLUMN ticket_number;
    ALTER TABLE kanban_tickets DROP COLUMN parent_ticket_id;
    DROP TABLE IF EXISTS ticket_counters;
    DELETE FROM settings WHERE key = '${TICKET_KEY_PREFIX_SETTING}';
    UPDATE settings SET value = '56' WHERE key = 'schema_version';
  `)
  const columns = (raw.pragma('table_info(kanban_tickets)') as { name: string }[]).map(
    (column) => column.name
  )
  raw.close()
  expect(columns).not.toEqual(
    expect.arrayContaining(['ticket_prefix', 'ticket_number', 'parent_ticket_id'])
  )
}

beforeEach(() => {
  // Events are published through setImmediate; a no-op publisher keeps them off the
  // Electron-only desktop channel without pulling that module in under Node.
  setDbChangeEventPublisher(async () => undefined)
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-03-01T10:00:00.000Z')
})

afterEach(() => {
  vi.useRealTimers()
  setDbChangeEventPublisher(null)
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

if (!canRunDatabaseTests()) {
  it('skips when better-sqlite3 is not available for this Node runtime', () => {
    expect(databaseLoadError).not.toBeNull()
  })
}

describeIf('ticket keys', () => {
  describe('schema', () => {
    it('creates the key columns, the counter table and the indexes on a fresh database', () => {
      const db = openDb()
      expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(57)
      expect(columnNames(db, 'kanban_tickets')).toEqual(
        expect.arrayContaining(['ticket_prefix', 'ticket_number', 'parent_ticket_id'])
      )
      expect(tableNames(db)).toContain('ticket_counters')
      expect(columnNames(db, 'ticket_counters')).toEqual(['scope', 'last'])

      const indexes = db.getRawDb().pragma('index_list(kanban_tickets)') as {
        name: string
        unique: number
      }[]
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'idx_kanban_tickets_number', unique: 1 }),
          expect.objectContaining({ name: 'idx_kanban_tickets_parent', unique: 0 })
        ])
      )
    })

    it('starts with no prefix and an empty counter', () => {
      const db = openDb()
      expect(db.getTicketKeyPrefix()).toBeNull()
      expect(db.getRawDb().prepare('SELECT COUNT(*) AS n FROM ticket_counters').get()).toEqual({
        n: 0
      })
    })
  })

  describe('createKanbanTicket', () => {
    it('allocates one machine-wide sequence across projects', () => {
      const db = openDb()
      const alpha = makeProject(db, 'alpha')
      const beta = makeProject(db, 'beta')

      const a1 = makeTicket(db, alpha, 'A1')
      const b1 = makeTicket(db, beta, 'B1')
      const a2 = makeTicket(db, alpha, 'A2')

      expect([a1, b1, a2].map((ticket) => ticket.ticket_number)).toEqual([1, 2, 3])
      expect([a1, b1, a2].map((ticket) => ticket.ticket_prefix)).toEqual([null, null, null])
      expect([a1, b1, a2].map((ticket) => ticket.parent_ticket_id)).toEqual([null, null, null])
      expect([a1, b1, a2].map((ticket) => ticket.parent_ticket_key)).toEqual([null, null, null])

      // The returned object and the two read paths agree.
      expect(db.getKanbanTicket(b1.id)).toEqual(b1)
      expect(db.getKanbanTicketsByProject(alpha).map((ticket) => ticket.ticket_number)).toEqual([
        1, 3
      ])
    })

    it('stamps the stored prefix at insert and ensureTicketKeyPrefix stamps the rows before it', () => {
      const db = openDb()
      const project = makeProject(db)
      const before = makeTicket(db, project, 'Before sign-in')
      expect(before.ticket_prefix).toBeNull()

      expect(db.ensureTicketKeyPrefix('TD')).toBe('TD')
      expect(db.getTicketKeyPrefix()).toBe('TD')

      const after = makeTicket(db, project, 'After sign-in')
      expect(after).toMatchObject({ ticket_prefix: 'TD', ticket_number: 2 })

      const byProject = db.getKanbanTicketsByProject(project)
      expect(byProject.map((ticket) => [ticket.ticket_prefix, ticket.ticket_number])).toEqual([
        ['TD', 1],
        ['TD', 2]
      ])
      expect(db.getKanbanTicket(before.id)).toEqual(byProject[0])
      expect(db.getKanbanTicket(after.id)).toEqual(after)
    })

    it('does not leave a gap behind a rolled-back insert', () => {
      const db = openDb()
      const project = makeProject(db)
      const first = makeTicket(db, project, 'First')
      // Same primary key: the insert fails after the number was allocated in the same transaction.
      expect(() => makeTicket(db, project, 'Duplicate', { id: first.id })).toThrow()
      expect(makeTicket(db, project, 'Second').ticket_number).toBe(2)
    })

    it('numbers a batch in order and continues the sequence afterwards', () => {
      const db = openDb()
      const project = makeProject(db)
      makeTicket(db, project, 'Solo')
      const batch = db.createKanbanTicketBatch({
        drafts: ['B1', 'B2', 'B3'].map((title) => ({
          draft_key: title,
          project_id: project,
          title
        }))
      })
      expect(batch.tickets.map((ticket) => ticket.ticket_number)).toEqual([2, 3, 4])
      expect(makeTicket(db, project, 'Next').ticket_number).toBe(5)
    })
  })

  describe('ensureTicketKeyPrefix', () => {
    it('keeps the first prefix and still stamps rows that have none', () => {
      const db = openDb()
      const project = makeProject(db)
      const early = makeTicket(db, project, 'Early')

      expect(db.ensureTicketKeyPrefix('TD')).toBe('TD')
      const stamped = makeTicket(db, project, 'Stamped')
      expect(stamped.ticket_prefix).toBe('TD')

      // A row written by a peer that knew no prefix yet (older build / server child before sign-in).
      const peer = makeTicket(db, project, 'Peer')
      db.getRawDb()
        .prepare('UPDATE kanban_tickets SET ticket_prefix = NULL WHERE id = ?')
        .run(peer.id)

      expect(db.ensureTicketKeyPrefix('GL')).toBe('TD')
      expect(db.getTicketKeyPrefix()).toBe('TD')
      expect(db.getSetting(TICKET_KEY_PREFIX_SETTING)).toBe('TD')

      const prefixes = Object.fromEntries(
        db.getKanbanTicketsByProject(project).map((ticket) => [ticket.id, ticket.ticket_prefix])
      )
      expect(prefixes).toEqual({ [early.id]: 'TD', [stamped.id]: 'TD', [peer.id]: 'TD' })
    })

    it('is idempotent and touches no row when every row is stamped', () => {
      const db = openDb()
      const project = makeProject(db)
      makeTicket(db, project, 'One')
      db.ensureTicketKeyPrefix('TD')
      const before = allRows(db)
      expect(db.ensureTicketKeyPrefix('TD')).toBe('TD')
      expect(db.ensureTicketKeyPrefix('XY')).toBe('TD')
      expect(allRows(db)).toEqual(before)
    })
  })

  describe('backfill of a database from before the keys', () => {
    interface Seed {
      path: string
      alpha: string
      beta: string
      /** Creation order; `archived` is archived, `parent` owns the run with `child1`, `child2`, `fix`. */
      ids: {
        early: string
        child1: string
        child2: string
        fix: string
        between: string
        parent: string
        late: string
        archived: string
      }
    }

    /**
     * Two projects, one document run whose parent ticket was created after its children (how a
     * launch worked before v57) and an unrelated ticket created between the children and the
     * parent — then the key columns are stripped so the next init has to number everything.
     */
    const seedOlderDatabase = (): Seed => {
      const path = makeDbPath()
      const db = new DatabaseService(path)
      db.init()
      const alpha = makeProject(db, 'alpha')
      const beta = makeProject(db, 'beta')

      at('2026-03-01T10:00:00.000Z')
      const early = makeTicket(db, beta, 'Early, other project')
      at('2026-03-01T10:01:00.000Z')
      const child1 = makeTicket(db, alpha, 'Task A1')
      at('2026-03-01T10:02:00.000Z')
      const child2 = makeTicket(db, alpha, 'Task A2')
      at('2026-03-01T10:03:00.000Z')
      const fix = makeTicket(db, alpha, 'Fix A1')
      at('2026-03-01T10:04:00.000Z')
      const between = makeTicket(db, alpha, 'Unrelated, created mid-run')
      at('2026-03-01T10:05:00.000Z')
      const parent = makeTicket(db, alpha, 'Implement document')
      at('2026-03-01T10:06:00.000Z')
      const late = makeTicket(db, beta, 'Late, other project')
      at('2026-03-01T10:07:00.000Z')
      const archived = makeTicket(db, alpha, 'Archived')
      db.archiveKanbanTicket(archived.id)

      const runId = makeRun(db, alpha, parent.id)
      const [itemA1, itemA2] = db.replaceDocumentRunItems(runId, [draft('A1'), draft('A2')])
      db.updateDocumentRunItem(itemA1.id, { ticket_id: child1.id, fix_ticket_id: fix.id })
      db.updateDocumentRunItem(itemA2.id, { ticket_id: child2.id })
      db.close()

      stripTicketKeys(path)
      return {
        path,
        alpha,
        beta,
        ids: {
          early: early.id,
          child1: child1.id,
          child2: child2.id,
          fix: fix.id,
          between: between.id,
          parent: parent.id,
          late: late.id,
          archived: archived.id
        }
      }
    }

    it('numbers every ticket in creation order with a run grouped at its earliest ticket, parent first', () => {
      const seed = seedOlderDatabase()
      const db = openDb(seed.path)

      expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      expect(columnNames(db, 'kanban_tickets')).toEqual(
        expect.arrayContaining(['ticket_prefix', 'ticket_number', 'parent_ticket_id'])
      )

      const { ids } = seed
      expect(numbersById(db)).toEqual({
        [ids.early]: 1,
        // The run sits where child1 was created; the parent leads although it was created last.
        [ids.parent]: 2,
        [ids.child1]: 3,
        [ids.child2]: 4,
        [ids.fix]: 5,
        [ids.between]: 6,
        [ids.late]: 7,
        [ids.archived]: 8
      })
      expect(db.getRawDb().prepare('SELECT last FROM ticket_counters').all()).toEqual([{ last: 8 }])
      // No prefix was ever stored on this machine: numbered, but keyless until the first sign-in.
      expect(
        db
          .getKanbanTicketsByProject(seed.alpha, true)
          .every((ticket) => ticket.ticket_prefix === null)
      ).toBe(true)
    })

    it('links the run children to the parent and resolves the parent key once a prefix exists', () => {
      const seed = seedOlderDatabase()
      const db = openDb(seed.path)
      const { ids } = seed

      for (const id of [ids.child1, ids.child2, ids.fix]) {
        expect(db.getKanbanTicket(id)).toMatchObject({
          parent_ticket_id: ids.parent,
          parent_ticket_key: null
        })
      }
      for (const id of [ids.early, ids.between, ids.parent, ids.late, ids.archived]) {
        expect(db.getKanbanTicket(id)?.parent_ticket_id).toBeNull()
      }

      expect(db.ensureTicketKeyPrefix('TD')).toBe('TD')
      expect(db.getKanbanTicket(ids.parent)).toMatchObject({
        ticket_prefix: 'TD',
        ticket_number: 2,
        parent_ticket_key: null
      })
      for (const id of [ids.child1, ids.child2, ids.fix]) {
        expect(db.getKanbanTicket(id)?.parent_ticket_key).toBe('TD-2')
      }
      expect(
        db
          .getKanbanTicketsByProject(seed.alpha, true)
          .filter((ticket) => ticket.parent_ticket_id === ids.parent)
          .map((ticket) => ticket.id)
          .sort()
      ).toEqual([ids.child1, ids.child2, ids.fix].sort())
    })

    it('continues the sequence after the backfilled maximum', () => {
      const seed = seedOlderDatabase()
      const db = openDb(seed.path)
      expect(makeTicket(db, seed.beta, 'Next').ticket_number).toBe(9)
      expect(makeTicket(db, seed.alpha, 'And next').ticket_number).toBe(10)
    })

    it('never reissues the number of a deleted ticket, even when the counter is ahead of the rows', () => {
      const db = openDb()
      const alpha = makeProject(db, 'alpha')
      const kept = makeTicket(db, alpha, 'Kept')
      const gone1 = makeTicket(db, alpha, 'Gone 1')
      const gone2 = makeTicket(db, alpha, 'Gone 2')
      expect([kept, gone1, gone2].map((ticket) => ticket.ticket_number)).toEqual([1, 2, 3])
      db.deleteKanbanTicket(gone1.id)
      db.deleteKanbanTicket(gone2.id)
      // A row an older build wrote to the shared database: no number yet.
      db.getRawDb()
        .prepare(
          `INSERT INTO kanban_tickets (id, project_id, title, attachments, "column", sort_order, created_at, updated_at)
           VALUES ('legacy', ?, 'Legacy', '[]', 'todo', 0, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`
        )
        .run(alpha)

      expect(db.backfillTicketKeys()).toBe(1)
      // Not 2 (the highest surviving number plus one): TD-2 and TD-3 were already shown.
      expect(db.getKanbanTicket('legacy')?.ticket_number).toBe(4)
      expect(makeTicket(db, alpha, 'Next').ticket_number).toBe(5)
    })

    it('is idempotent: a second backfill and a second init change nothing', () => {
      const seed = seedOlderDatabase()
      const db = openDb(seed.path)
      const after = allRows(db)
      const counter = db.getRawDb().prepare('SELECT * FROM ticket_counters').all()

      expect(db.backfillTicketKeys()).toBe(0)
      expect(allRows(db)).toEqual(after)
      db.close()

      const again = openDb(seed.path)
      expect(allRows(again)).toEqual(after)
      expect(again.getRawDb().prepare('SELECT * FROM ticket_counters').all()).toEqual(counter)
      expect(again.backfillTicketKeys()).toBe(0)
    })

    it('keeps already-numbered rows and numbers only the new ones after them', () => {
      // A peer on an older build inserts a row (no number) into an already-upgraded file.
      const db = openDb()
      const project = makeProject(db)
      const numbered = makeTicket(db, project, 'Numbered')
      db.ensureTicketKeyPrefix('TD')
      const peerId = randomUUID()
      db.getRawDb()
        .prepare(
          `INSERT INTO kanban_tickets (id, project_id, title, created_at, updated_at)
           VALUES (?, ?, 'From an older peer', ?, ?)`
        )
        .run(peerId, project, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')

      expect(db.backfillTicketKeys()).toBe(1)
      expect(db.getKanbanTicket(numbered.id)).toMatchObject({ ticket_number: 1 })
      // Older created_at does not move it in front of a row that already has its number.
      expect(db.getKanbanTicket(peerId)).toMatchObject({ ticket_prefix: 'TD', ticket_number: 2 })
      expect(makeTicket(db, project, 'Next').ticket_number).toBe(3)
    })

    it('links children of a run that gained its parent ticket after the upgrade', () => {
      const db = openDb()
      const project = makeProject(db)
      const child = makeTicket(db, project, 'Task')
      const parent = makeTicket(db, project, 'Run ticket')
      const runId = makeRun(db, project, null)
      const [item] = db.replaceDocumentRunItems(runId, [draft('A1')])
      db.updateDocumentRunItem(item.id, { ticket_id: child.id })
      expect(db.backfillTicketKeys()).toBe(0)
      expect(db.getKanbanTicket(child.id)?.parent_ticket_id).toBeNull()

      // The run's ticket appears later (as a pre-v57 run migrated by a newer build would).
      db.updateDocumentRun(runId, { ticket_id: parent.id })
      expect(db.backfillTicketKeys()).toBe(0)
      expect(db.getKanbanTicket(child.id)?.parent_ticket_id).toBe(parent.id)
      expect(db.getKanbanTicket(parent.id)?.parent_ticket_id).toBeNull()
    })
  })

  describe('two connections on one file', () => {
    it('never hand out the same number', () => {
      const path = makeDbPath()
      const first = openDb(path)
      const second = openDb(path)
      const project = makeProject(first, 'shared')

      const numbers: number[] = []
      for (let i = 0; i < 10; i += 1) {
        numbers.push(makeTicket(first, project, `first ${i}`).ticket_number!)
        numbers.push(makeTicket(second, project, `second ${i}`).ticket_number!)
      }
      expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
      expect(new Set(numbers).size).toBe(20)

      // The unique index is the last line of defence should two writers ever collide.
      const indexes = second.getRawDb().pragma('index_list(kanban_tickets)') as {
        name: string
        unique: number
      }[]
      expect(indexes.find((index) => index.name === 'idx_kanban_tickets_number')?.unique).toBe(1)
      expect(() =>
        second
          .getRawDb()
          .prepare('UPDATE kanban_tickets SET ticket_number = 1 WHERE ticket_number = 2')
          .run()
      ).toThrow(/UNIQUE/)
    })

    it('a prefix stored through one connection is stamped by the other', () => {
      const path = makeDbPath()
      const first = openDb(path)
      const second = openDb(path)
      const project = makeProject(first, 'shared')
      first.ensureTicketKeyPrefix('TD')
      expect(makeTicket(second, project, 'From the second').ticket_prefix).toBe('TD')
    })
  })

  describe('parent link', () => {
    it('returns the parent key on create when the parent has one', () => {
      const db = openDb()
      const project = makeProject(db)
      db.ensureTicketKeyPrefix('TD')
      const parent = makeTicket(db, project, 'Implement document')
      const child = makeTicket(db, project, 'Task', { parent_ticket_id: parent.id })

      expect(child).toMatchObject({
        ticket_number: 2,
        parent_ticket_id: parent.id,
        parent_ticket_key: 'TD-1'
      })
      expect(db.getKanbanTicket(child.id)).toEqual(child)
      expect(db.getKanbanTicketsByProject(project).find((t) => t.id === child.id)).toEqual(child)
    })

    it('returns a null parent key when the parent has no prefix yet, then resolves it', () => {
      const db = openDb()
      const project = makeProject(db)
      const parent = makeTicket(db, project, 'Implement document')
      const child = makeTicket(db, project, 'Task', { parent_ticket_id: parent.id })
      expect(child).toMatchObject({ parent_ticket_id: parent.id, parent_ticket_key: null })

      db.ensureTicketKeyPrefix('TD')
      expect(db.getKanbanTicket(child.id)?.parent_ticket_key).toBe('TD-1')
    })

    it('persists parent_ticket_id through updateKanbanTicket and the join follows', () => {
      const db = openDb()
      const project = makeProject(db)
      db.ensureTicketKeyPrefix('TD')
      const parent = makeTicket(db, project, 'Implement document')
      const orphan = makeTicket(db, project, 'Fix')
      expect(orphan.parent_ticket_id).toBeNull()

      const linked = db.updateKanbanTicket(orphan.id, { parent_ticket_id: parent.id })
      expect(linked).toMatchObject({ parent_ticket_id: parent.id, parent_ticket_key: 'TD-1' })
      expect(db.getKanbanTicket(orphan.id)).toEqual(linked)

      // An unrelated update leaves the link alone; null clears it.
      expect(db.updateKanbanTicket(orphan.id, { title: 'Fix (renamed)' })).toMatchObject({
        parent_ticket_id: parent.id,
        parent_ticket_key: 'TD-1'
      })
      expect(db.updateKanbanTicket(orphan.id, { parent_ticket_id: null })).toMatchObject({
        parent_ticket_id: null,
        parent_ticket_key: null
      })
    })

    it('tolerates a parent that no longer exists', () => {
      const db = openDb()
      const project = makeProject(db)
      db.ensureTicketKeyPrefix('TD')
      const parent = makeTicket(db, project, 'Implement document')
      const child = makeTicket(db, project, 'Task', { parent_ticket_id: parent.id })
      db.deleteKanbanTicket(parent.id)
      expect(db.getKanbanTicket(child.id)).toMatchObject({
        parent_ticket_id: parent.id,
        parent_ticket_key: null
      })
    })
  })

  describe('moveKanbanTicketToProject', () => {
    it('keeps the key when the ticket changes project', () => {
      const db = openDb()
      const source = makeProject(db, 'source')
      const target = makeProject(db, 'target')
      db.ensureTicketKeyPrefix('TD')
      makeTicket(db, source, 'First')
      const moved = makeTicket(db, source, 'Moving')

      const result = db.moveKanbanTicketToProject(moved.id, target)
      expect(result).toMatchObject({
        project_id: target,
        ticket_prefix: 'TD',
        ticket_number: 2
      })
      expect(db.getKanbanTicketsByProject(target).map((t) => t.ticket_number)).toEqual([2])
      expect(db.getKanbanTicketsByProject(source).map((t) => t.ticket_number)).toEqual([1])
      expect(makeTicket(db, target, 'Next').ticket_number).toBe(3)
    })
  })
})
