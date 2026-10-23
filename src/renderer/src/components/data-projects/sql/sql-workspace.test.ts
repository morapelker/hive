// Pure helpers of the SQL workspace: generated statements of the schema tree (SELECT / TRUNCATE /
// DROP per dialect, qualification only when needed) and the staged-edits model (cell edits that
// revert, deletes that drop edits and toggle back, inserts, edit ordering, display rows).
import { describe, expect, it } from 'vitest'
import type { DataCell } from '@shared/data-projects/types'
import {
  generateDrop,
  generateSelect,
  generateTruncate,
  isTableLike,
  objectSqlName,
  plainObjectName,
  refForObject
} from './schema-actions'
import {
  addStagedInsert,
  displayRows,
  emptyStagedEdits,
  pendingCount,
  stageCellEdit,
  stageInsertValue,
  toggleStagedDeletes,
  toRowEdits
} from './staged-edits'

describe('schema actions', () => {
  it('qualifies only outside the current database / schema', () => {
    expect(objectSqlName({ schema: 'public', name: 'users' }, 'postgres')).toBe('"users"')
    expect(objectSqlName({ schema: 'analytics', name: 'daily' }, 'postgres')).toBe(
      '"analytics"."daily"'
    )
    expect(objectSqlName({ database: 'shop', name: 'users' }, 'mysql', { database: 'shop' })).toBe(
      '`users`'
    )
    expect(
      objectSqlName({ database: 'logs', name: 'events' }, 'clickhouse', { database: 'default' })
    ).toBe('`logs`.`events`')
    expect(objectSqlName({ database: 'main', name: 't' }, 'sqlite')).toBe('"t"')
    expect(plainObjectName({ schema: 'public', name: 'users' }, 'postgres')).toBe('public.users')
  })

  it('generates SELECT, TRUNCATE and DROP for review', () => {
    expect(generateSelect({ schema: 'public', name: 'users' }, 'postgres')).toBe(
      'SELECT *\nFROM "users"\nLIMIT 100;'
    )
    expect(
      generateSelect({ name: 'users' }, 'mysql', { columns: ['id', 'email'], limit: 10 })
    ).toBe('SELECT\n  `id`,\n  `email`\nFROM `users`\nLIMIT 10;')
    expect(generateTruncate({ name: 't' }, 'sqlite')).toMatch(/DELETE FROM "t";$/)
    expect(generateTruncate({ name: 't' }, 'postgres')).toMatch(
      /^-- Review.*\nTRUNCATE TABLE "t";$/
    )
    expect(
      generateDrop({ kind: 'materialized_view' }, { schema: 'public', name: 'mv' }, 'postgres')
    ).toMatch(/DROP MATERIALIZED VIEW "mv";$/)
    expect(
      generateDrop(
        { kind: 'function', detail: 'integer' },
        { schema: 'public', name: 'f' },
        'postgres'
      )
    ).toMatch(/DROP FUNCTION "f"\(integer\);$/)
    expect(
      generateDrop(
        { kind: 'trigger', detail: 'orders' },
        { schema: 'public', name: 'trg' },
        'postgres'
      )
    ).toMatch(/DROP TRIGGER "trg" ON "orders";$/)
    expect(generateDrop({ kind: 'dictionary' }, { name: 'd' }, 'clickhouse')).toMatch(
      /DROP DICTIONARY `d`;$/
    )
  })

  it('builds refs and knows table-like kinds', () => {
    expect(
      refForObject(
        { name: 'users', kind: 'table' },
        { dialect: 'postgres', database: 'shop', schema: 'public' }
      )
    ).toEqual({
      database: 'shop',
      schema: 'public',
      name: 'users',
      kind: 'table'
    })
    expect(
      refForObject({ name: 'users', kind: 'table' }, { dialect: 'mysql', database: 'shop' })
    ).toEqual({
      database: 'shop',
      name: 'users',
      kind: 'table'
    })
    expect(isTableLike('view')).toBe(true)
    expect(isTableLike('function')).toBe(false)
  })
})

describe('staged edits', () => {
  const columns = ['id', 'name', 'email']
  const pk = ['id']
  const rows: DataCell[][] = [
    [1, 'Ann', 'a@x'],
    [2, 'Bob', null]
  ]

  it('stages and reverts cell edits', () => {
    let s = stageCellEdit(emptyStagedEdits(), rows[0], 'name', 'Anna', columns, pk)
    expect(pendingCount(s)).toBe(1)
    expect(toRowEdits(s)).toEqual([{ kind: 'update', key: { id: 1 }, changes: { name: 'Anna' } }])
    s = stageCellEdit(s, rows[0], 'name', 'Ann', columns, pk)
    expect(pendingCount(s)).toBe(0)
  })

  it('marks rows deleted (dropping their edits) and toggles them back', () => {
    let s = stageCellEdit(emptyStagedEdits(), rows[1], 'email', 'b@x', columns, pk)
    s = toggleStagedDeletes(s, [rows[1]], columns, pk)
    expect(toRowEdits(s)).toEqual([{ kind: 'delete', key: { id: 2 } }])
    // edits on a deleted row are ignored
    expect(stageCellEdit(s, rows[1], 'name', 'X', columns, pk)).toBe(s)
    s = toggleStagedDeletes(s, [rows[1]], columns, pk)
    expect(pendingCount(s)).toBe(0)
  })

  it('adds inserts, orders edits deletes → updates → inserts and builds display rows', () => {
    let s = stageCellEdit(emptyStagedEdits(), rows[0], 'name', 'Anna', columns, pk)
    const added = addStagedInsert(s)
    s = stageInsertValue(added.staged, added.id, 'name', 'Cid')
    s = toggleStagedDeletes(s, [rows[1]], columns, pk)
    expect(toRowEdits(s).map((e) => e.kind)).toEqual(['delete', 'update', 'insert'])
    expect(toRowEdits(s)[2]).toEqual({ kind: 'insert', values: { name: 'Cid' } })
    const view = displayRows(rows, columns, pk, s)
    expect(view.rows).toEqual([
      [1, 'Anna', 'a@x'],
      [2, 'Bob', null],
      [null, 'Cid', null]
    ])
    expect(view.info.map((i) => i.kind)).toEqual(['existing', 'existing', 'inserted'])
    s = stageInsertValue(s, added.id, 'name', undefined)
    expect(toRowEdits(s)[2]).toEqual({ kind: 'insert', values: {} })
  })

  it('ignores rows whose primary key is not in the result', () => {
    const s = stageCellEdit(emptyStagedEdits(), ['Ann'], 'name', 'X', ['name'], ['id'])
    expect(pendingCount(s)).toBe(0)
  })
})
