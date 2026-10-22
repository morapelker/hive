import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DbChangedEvent } from '../../shared/db-change-events'
import { isDbChangedEvent } from '../../shared/db-change-events'
import type { TicketLabel } from '../../shared/lib/ticket-labels'
import { SAVED_TICKET_LABELS_MAX } from '../../shared/lib/ticket-labels'
import {
  flushPendingDbChangedEvents,
  setDbChangeEventPublisher
} from '../services/db-change-events'
import { DatabaseService } from './database'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, TICKET_LABELS_TABLES_SQL } from './schema'

const tempDirs: string[] = []

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

const publisher = vi.fn<(channel: string, payload: unknown) => Promise<void>>(async () => {})

/** Flushes the coalescing queue and returns every event published since the last drain. */
const drain = (): DbChangedEvent[] => {
  flushPendingDbChangedEvents()
  const events = publisher.mock.calls.map(([, payload]) => payload as DbChangedEvent)
  publisher.mockClear()
  return events
}

/** The events without the volatile fields, for exact comparisons. */
type EventShape = Pick<DbChangedEvent, 'entity' | 'op' | 'id' | 'projectId'>
const shapes = (events: DbChangedEvent[]): EventShape[] =>
  events.map(({ entity, op, id, projectId }) => ({ entity, op, id, projectId }))

const makeDb = (): DatabaseService => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-ticket-labels-'))
  tempDirs.push(dir)
  const db = new DatabaseService(join(dir, 'state.sqlite'))
  db.init()
  drain()
  return db
}

const OLD = '2020-01-01T00:00:00.000Z'

const saved = (label: { id: string; name: string; color: string }): TicketLabel => ({
  id: label.id,
  kind: 'saved',
  name: label.name,
  color: label.color
})

const once = (id: string, name: string, color = 'gray'): TicketLabel => ({
  id,
  kind: 'once',
  name,
  color
})

/** A markdown card's runtime row, written the way the markdown backend stores it. */
const insertCardState = (
  db: DatabaseService,
  projectId: string,
  cardId: string,
  labels: unknown,
  options: { orphaned?: boolean } = {}
): void => {
  db.getRawDb()
    .prepare(
      `INSERT INTO markdown_kanban_card_state (project_id, card_id, labels, orphaned_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      projectId,
      cardId,
      typeof labels === 'string' ? labels : JSON.stringify(labels),
      options.orphaned ? OLD : null,
      OLD,
      OLD
    )
}

const cardState = (
  db: DatabaseService,
  projectId: string,
  cardId: string
): { labels: TicketLabel[]; updated_at: string } => {
  const row = db
    .getRawDb()
    .prepare(
      'SELECT labels, updated_at FROM markdown_kanban_card_state WHERE project_id = ? AND card_id = ?'
    )
    .get(projectId, cardId) as { labels: string; updated_at: string }
  return { labels: JSON.parse(row.labels), updated_at: row.updated_at }
}

const ageTicket = (db: DatabaseService, ticketId: string): void => {
  db.getRawDb().prepare('UPDATE kanban_tickets SET updated_at = ? WHERE id = ?').run(OLD, ticketId)
}

beforeEach(() => {
  publisher.mockClear()
  setDbChangeEventPublisher(publisher)
})

afterEach(() => {
  flushPendingDbChangedEvents()
  setDbChangeEventPublisher(null)
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ticket labels schema', () => {
  it('ships as the v66 migration', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(66)
    const migration = MIGRATIONS.find((m) => m.version === 66)
    expect(migration?.name).toBe('add_ticket_labels')
    expect(migration?.up).toBe(TICKET_LABELS_TABLES_SQL)
    // New columns never come from ALTER TABLE in a migration (safeAddColumn repairs them).
    expect(migration?.up).not.toMatch(/ALTER TABLE/i)
  })

  it('knows the ticketLabel db:changed entity', () => {
    expect(
      isDbChangedEvent({
        entity: 'ticketLabel',
        op: 'create',
        id: 'x',
        projectId: null,
        originClientId: null,
        at: OLD
      })
    ).toBe(true)
  })
})

describeIf('ticket labels persistence', () => {
  it('creates the catalog table, its unique name index and both labels columns', () => {
    const db = makeDb()
    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.tableExists('ticket_labels')).toBe(true)
    const indexes = db
      .getRawDb()
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ticket_labels'"
      )
      .all() as { name: string; sql: string }[]
    const nameIndex = indexes.find((index) => index.name === 'idx_ticket_labels_name_key')
    expect(nameIndex?.sql).toMatch(/UNIQUE/i)

    for (const table of ['kanban_tickets', 'markdown_kanban_card_state']) {
      const columns = db.getRawDb().pragma(`table_info(${table})`) as {
        name: string
        type: string
        notnull: number
        dflt_value: string | null
      }[]
      const labels = columns.find((column) => column.name === 'labels')
      expect(labels, `${table}.labels`).toMatchObject({
        type: 'TEXT',
        notnull: 1,
        dflt_value: "'[]'"
      })
    }
  })

  it('repairs a database whose catalog table went missing (an older build ran the migration)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-ticket-labels-repair-'))
    tempDirs.push(dir)
    const path = join(dir, 'state.sqlite')
    const first = new DatabaseService(path)
    first.init()
    first.getRawDb().exec('DROP TABLE ticket_labels')
    first.close()

    const second = new DatabaseService(path)
    second.init()
    expect(second.tableExists('ticket_labels')).toBe(true)
    second.close()
  })

  it('stores ticket labels on create, batch create and update, sanitised, [] by default', () => {
    const db = makeDb()
    const project = db.createProject({ name: 'repo', path: '/tmp/labels-repo' })

    const plain = db.createKanbanTicket({ project_id: project.id, title: 'No labels' })
    expect(plain.labels).toEqual([])
    expect(db.getKanbanTicket(plain.id)?.labels).toEqual([])

    const joy = saved({ id: 'label-joy', name: 'Waiting for Joy', color: 'yellow' })
    const ticket = db.createKanbanTicket({
      project_id: project.id,
      title: 'Labelled',
      labels: [
        joy,
        once('once-1', '  waiting   until 21/10 '),
        // Garbage is dropped, duplicates of an id keep the first.
        { id: '', kind: 'saved', name: 'x', color: 'red' } as TicketLabel,
        { ...joy, name: 'dupe' }
      ]
    })
    const expected = [joy, once('once-1', 'waiting until 21/10')]
    expect(ticket.labels).toEqual(expected)
    expect(db.getKanbanTicket(ticket.id)?.labels).toEqual(expected)

    // An update without labels leaves them alone; with labels it replaces the whole list.
    expect(db.updateKanbanTicket(ticket.id, { title: 'Renamed' })?.labels).toEqual(expected)
    expect(db.updateKanbanTicket(ticket.id, { labels: [joy] })?.labels).toEqual([joy])
    expect(db.updateKanbanTicket(ticket.id, { labels: [] })?.labels).toEqual([])

    const batch = db.createKanbanTicketBatch({
      drafts: [
        { draft_key: 'a', project_id: project.id, title: 'Batch A', labels: [joy] },
        { draft_key: 'b', project_id: project.id, title: 'Batch B' }
      ]
    })
    expect(batch.tickets.map((t) => t.labels)).toEqual([[joy], []])
    expect(db.getKanbanTicket(batch.tickets[0].id)?.labels).toEqual([joy])

    // A malformed value (written by hand, or by a future build) reads as no labels.
    db.getRawDb()
      .prepare('UPDATE kanban_tickets SET labels = ? WHERE id = ?')
      .run('{nope', plain.id)
    expect(db.getKanbanTicket(plain.id)?.labels).toEqual([])
  })

  it('creates saved labels in order and rejects empty names and case-insensitive clashes', () => {
    const db = makeDb()
    const joy = db.createSavedTicketLabel({ name: '  Joy ', color: 'yellow' })
    expect(joy).toMatchObject({ name: 'Joy', color: 'yellow', sort_order: 0 })
    expect(joy.created_at).toBe(joy.updated_at)
    expect(shapes(drain())).toEqual([
      { entity: 'ticketLabel', op: 'create', id: joy.id, projectId: null }
    ])

    const review = db.createSavedTicketLabel({ name: 'Needs   review', color: 'blue' })
    expect(review).toMatchObject({ name: 'Needs review', sort_order: 1 })
    drain()

    // A rejected create writes nothing and emits nothing.
    expect(() => db.createSavedTicketLabel({ name: ' JOY ', color: 'red' })).toThrow(
      'A label named "Joy" already exists'
    )
    expect(() => db.createSavedTicketLabel({ name: 'joy', color: 'red' })).toThrow(/already exists/)
    expect(() => db.createSavedTicketLabel({ name: '   ', color: 'red' })).toThrow(
      'Label name is required'
    )
    expect(drain()).toEqual([])

    // Names are cut to 32 characters; a colour outside the palette is stored as gray.
    const long = db.createSavedTicketLabel({
      name: 'x'.repeat(40),
      color: 'chartreuse' as never
    })
    expect(long.name).toHaveLength(32)
    expect(long.color).toBe('gray')

    expect(db.getSavedTicketLabels().map((label) => label.name)).toEqual([
      'Joy',
      'Needs review',
      'x'.repeat(32)
    ])
    expect(db.getSavedTicketLabel(review.id)).toEqual(review)
    expect(db.getSavedTicketLabel('missing')).toBeNull()
  })

  it('refuses to grow the catalog past its limit', () => {
    const db = makeDb()
    for (let i = 0; i < SAVED_TICKET_LABELS_MAX; i++) {
      db.createSavedTicketLabel({ name: `Label ${i}`, color: 'gray' })
    }
    expect(() => db.createSavedTicketLabel({ name: 'One more', color: 'gray' })).toThrow(
      'Too many labels'
    )
    expect(db.getSavedTicketLabels()).toHaveLength(SAVED_TICKET_LABELS_MAX)
  })

  it('renames and recolours a label on every ticket of both tables without touching updated_at', () => {
    const db = makeDb()
    const internal = db.createProject({ name: 'internal', path: '/tmp/labels-internal' })
    const markdown = db.createProject({ name: 'markdown', path: '/tmp/labels-markdown' })
    const untouched = db.createProject({ name: 'untouched', path: '/tmp/labels-untouched' })
    const joy = db.createSavedTicketLabel({ name: 'Joy', color: 'yellow' })
    const other = db.createSavedTicketLabel({ name: 'Other', color: 'red' })
    const oneOff = once('once-1', 'Joy') // Same name as the saved one: a one-off is never rewritten.

    const carrying = db.createKanbanTicket({
      project_id: internal.id,
      title: 'Carries Joy',
      labels: [saved(joy), oneOff]
    })
    const archived = db.createKanbanTicket({
      project_id: internal.id,
      title: 'Archived, carries Joy',
      labels: [saved(joy)]
    })
    db.archiveKanbanTicket(archived.id)
    const bystander = db.createKanbanTicket({
      project_id: untouched.id,
      title: 'Carries Other only',
      labels: [saved(other)]
    })
    for (const id of [carrying.id, archived.id, bystander.id]) ageTicket(db, id)
    insertCardState(db, markdown.id, 'card-1', [oneOff, saved(joy)])
    drain()

    const result = db.updateSavedTicketLabel(joy.id, { name: 'Joy Smith', color: 'blue' })
    expect(result.label).toMatchObject({ id: joy.id, name: 'Joy Smith', color: 'blue' })
    expect(result.label?.created_at).toBe(joy.created_at)
    expect(result.affectedProjectIds).toEqual([internal.id, markdown.id].sort())
    expect(db.getSavedTicketLabel(joy.id)).toEqual(result.label)

    const renamed = { id: joy.id, kind: 'saved', name: 'Joy Smith', color: 'blue' }
    const fetched = db.getKanbanTicket(carrying.id)
    expect(fetched?.labels).toEqual([renamed, oneOff])
    expect(fetched?.updated_at).toBe(OLD)
    expect(db.getKanbanTicket(archived.id)?.labels).toEqual([renamed])
    expect(db.getKanbanTicket(archived.id)?.updated_at).toBe(OLD)
    expect(db.getKanbanTicket(bystander.id)?.labels).toEqual([saved(other)])
    expect(cardState(db, markdown.id, 'card-1')).toEqual({
      labels: [oneOff, renamed],
      updated_at: OLD
    })

    const events = shapes(drain())
    expect(events).toHaveLength(3)
    expect(events).toEqual(
      expect.arrayContaining([
        { entity: 'ticketLabel', op: 'update', id: joy.id, projectId: null },
        { entity: 'ticket', op: 'batch', id: null, projectId: internal.id },
        { entity: 'ticket', op: 'batch', id: null, projectId: markdown.id }
      ])
    )

    // A case-only rename keeps its own name key; another label's name is a clash.
    expect(db.updateSavedTicketLabel(joy.id, { name: 'JOY SMITH' }).label?.name).toBe('JOY SMITH')
    expect(() => db.updateSavedTicketLabel(joy.id, { name: ' other ' })).toThrow(
      'A label named "Other" already exists'
    )
    expect(() => db.updateSavedTicketLabel(joy.id, { name: ' ' })).toThrow('Label name is required')
    expect(db.getKanbanTicket(carrying.id)?.labels?.[0]).toMatchObject({ name: 'JOY SMITH' })
    drain()

    // Nothing to change: no write, no event. Unknown id: label null.
    expect(db.updateSavedTicketLabel(joy.id, { name: 'JOY SMITH', color: 'blue' })).toEqual({
      label: db.getSavedTicketLabel(joy.id),
      affectedProjectIds: []
    })
    expect(db.updateSavedTicketLabel('missing', { name: 'Ghost' })).toEqual({
      label: null,
      affectedProjectIds: []
    })
    expect(drain()).toEqual([])
  })

  it('reorders the catalog and re-sorts the snapshots on every ticket', () => {
    const db = makeDb()
    const project = db.createProject({ name: 'repo', path: '/tmp/labels-reorder' })
    const markdown = db.createProject({ name: 'markdown', path: '/tmp/labels-reorder-md' })
    const a = db.createSavedTicketLabel({ name: 'A', color: 'red' })
    const b = db.createSavedTicketLabel({ name: 'B', color: 'green' })
    const c = db.createSavedTicketLabel({ name: 'C', color: 'blue' })
    const oneOff = once('once-1', 'Later')

    const ticket = db.createKanbanTicket({
      project_id: project.id,
      title: 'A and B',
      labels: [saved(a), saved(b), oneOff]
    })
    const single = db.createKanbanTicket({
      project_id: project.id,
      title: 'Only C',
      labels: [saved(c)]
    })
    ageTicket(db, ticket.id)
    insertCardState(db, markdown.id, 'card-1', [saved(a), oneOff, saved(c)])
    drain()

    // Unknown ids are ignored; A, missing from the list, keeps its place after the listed ones.
    const result = db.reorderSavedTicketLabels(['c', c.id, 'missing', b.id, c.id])
    expect(result.label).toBeNull()
    expect(result.affectedProjectIds).toEqual([project.id, markdown.id].sort())
    expect(db.getSavedTicketLabels().map((label) => [label.name, label.sort_order])).toEqual([
      ['C', 0],
      ['B', 1],
      ['A', 2]
    ])
    expect(db.getKanbanTicket(ticket.id)?.labels).toEqual([saved(b), saved(a), oneOff])
    expect(db.getKanbanTicket(ticket.id)?.updated_at).toBe(OLD)
    expect(db.getKanbanTicket(single.id)?.labels).toEqual([saved(c)])
    expect(cardState(db, markdown.id, 'card-1')).toEqual({
      labels: [saved(c), saved(a), oneOff],
      updated_at: OLD
    })
    expect(shapes(drain())).toEqual(
      expect.arrayContaining([
        { entity: 'ticketLabel', op: 'reorder', id: null, projectId: null },
        { entity: 'ticket', op: 'batch', id: null, projectId: project.id },
        { entity: 'ticket', op: 'batch', id: null, projectId: markdown.id }
      ])
    )

    // The same order again changes nothing.
    expect(db.reorderSavedTicketLabels([c.id, b.id, a.id])).toEqual({
      label: null,
      affectedProjectIds: []
    })
    expect(drain()).toEqual([])
  })

  it('deletes a label from the catalog and from every ticket of both tables', () => {
    const db = makeDb()
    const internal = db.createProject({ name: 'internal', path: '/tmp/labels-delete' })
    const markdown = db.createProject({ name: 'markdown', path: '/tmp/labels-delete-md' })
    const joy = db.createSavedTicketLabel({ name: 'Joy', color: 'yellow' })
    const keep = db.createSavedTicketLabel({ name: 'Keep', color: 'green' })
    const oneOff = once(joy.id.slice(0, 8), 'Lookalike')

    const ticket = db.createKanbanTicket({
      project_id: internal.id,
      title: 'Carries Joy',
      labels: [saved(joy), saved(keep), oneOff]
    })
    ageTicket(db, ticket.id)
    insertCardState(db, markdown.id, 'card-1', [saved(joy)])
    insertCardState(db, markdown.id, 'card-2', [saved(keep)])
    drain()

    const result = db.deleteSavedTicketLabel(joy.id)
    expect(result.label).toEqual(joy)
    expect(result.affectedProjectIds).toEqual([internal.id, markdown.id].sort())
    expect(db.getSavedTicketLabel(joy.id)).toBeNull()
    expect(db.getSavedTicketLabels().map((label) => label.id)).toEqual([keep.id])
    expect(db.getKanbanTicket(ticket.id)?.labels).toEqual([saved(keep), oneOff])
    expect(db.getKanbanTicket(ticket.id)?.updated_at).toBe(OLD)
    expect(cardState(db, markdown.id, 'card-1')).toEqual({ labels: [], updated_at: OLD })
    expect(cardState(db, markdown.id, 'card-2').labels).toEqual([saved(keep)])
    expect(shapes(drain())).toEqual(
      expect.arrayContaining([
        { entity: 'ticketLabel', op: 'delete', id: joy.id, projectId: null },
        { entity: 'ticket', op: 'batch', id: null, projectId: internal.id },
        { entity: 'ticket', op: 'batch', id: null, projectId: markdown.id }
      ])
    )

    expect(db.deleteSavedTicketLabel(joy.id)).toEqual({ label: null, affectedProjectIds: [] })
    expect(drain()).toEqual([])

    // A snapshot that outlived its catalog row is still swept, with only the ticket event.
    const orphan = saved({ id: 'orphan-id', name: 'Gone', color: 'red' })
    const stale = db.createKanbanTicket({
      project_id: internal.id,
      title: 'Stale',
      labels: [orphan, saved(keep)]
    })
    drain()
    expect(db.deleteSavedTicketLabel('orphan-id')).toEqual({
      label: null,
      affectedProjectIds: [internal.id]
    })
    expect(db.getKanbanTicket(stale.id)?.labels).toEqual([saved(keep)])
    expect(shapes(drain())).toEqual([
      { entity: 'ticket', op: 'batch', id: null, projectId: internal.id }
    ])
  })

  it('counts the tickets carrying each saved label across both tables', () => {
    const db = makeDb()
    const internal = db.createProject({ name: 'internal', path: '/tmp/labels-usage' })
    const markdown = db.createProject({ name: 'markdown', path: '/tmp/labels-usage-md' })
    const joy = db.createSavedTicketLabel({ name: 'Joy', color: 'yellow' })
    const keep = db.createSavedTicketLabel({ name: 'Keep', color: 'green' })
    db.createSavedTicketLabel({ name: 'Unused', color: 'gray' })

    db.createKanbanTicket({ project_id: internal.id, title: '1', labels: [saved(joy)] })
    const archived = db.createKanbanTicket({
      project_id: internal.id,
      title: '2',
      labels: [saved(joy), saved(keep), once('once-1', 'Not counted')]
    })
    db.archiveKanbanTicket(archived.id)
    db.createKanbanTicket({ project_id: internal.id, title: '3', labels: [once(joy.id, 'Joy')] })
    const broken = db.createKanbanTicket({ project_id: internal.id, title: '4' })
    db.getRawDb()
      .prepare('UPDATE kanban_tickets SET labels = ? WHERE id = ?')
      .run('{"saved": [', broken.id)
    insertCardState(db, markdown.id, 'card-1', [saved(joy)])
    // The runtime row of a card whose file vanished is not a ticket any more.
    insertCardState(db, markdown.id, 'card-gone', [saved(keep)], { orphaned: true })
    insertCardState(db, markdown.id, 'card-odd', '{"kind":"saved","id":"x"}')
    insertCardState(db, markdown.id, 'card-mixed', '["saved", 3, {"kind":"saved"}]')

    expect(db.getSavedTicketLabelUsage()).toEqual({ [joy.id]: 3, [keep.id]: 1 })
  })

  it('resolves a label by name or creates it', () => {
    const db = makeDb()
    const joy = db.createSavedTicketLabel({ name: 'Joy', color: 'yellow' })
    drain()

    expect(db.resolveOrCreateSavedTicketLabel(' JOY ', 'red')).toEqual(joy)
    expect(drain()).toEqual([])

    const created = db.resolveOrCreateSavedTicketLabel('Waiting  for review', 'purple')
    expect(created).toMatchObject({ name: 'Waiting for review', color: 'purple', sort_order: 1 })
    expect(shapes(drain())).toEqual([
      { entity: 'ticketLabel', op: 'create', id: created.id, projectId: null }
    ])
    expect(db.resolveOrCreateSavedTicketLabel('waiting for review', 'gray')).toEqual(created)

    // A colour this build does not know (from another Mac's newer build) becomes gray.
    expect(db.resolveOrCreateSavedTicketLabel('Fresh', 'chartreuse').color).toBe('gray')
    expect(() => db.resolveOrCreateSavedTicketLabel('  ', 'red')).toThrow('Label name is required')
  })
})
