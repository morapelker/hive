// The import dialog's pure model: auto-mapping, the checks that keep Import disabled, the start
// request, progress and result texts.
import { describe, expect, it } from 'vitest'
import type { DataColumnInfo } from '@shared/data-projects/types'
import {
  autoMapSql,
  autoMongoFields,
  buildStartRequest,
  cellDisplay,
  importedCountText,
  isRequiredColumn,
  mayHaveImported,
  mongoFieldIssues,
  progressFraction,
  progressText,
  reportText,
  resultTitle,
  sqlMappingIssues,
  targetDisplayName,
  type FinishedResponse
} from './import-model'

const col = (name: string, extra: Partial<DataColumnInfo> = {}): DataColumnInfo => ({
  name,
  type: 'text',
  nullable: true,
  isPrimaryKey: false,
  ordinal: 1,
  ...extra
})

const columns: DataColumnInfo[] = [
  col('id', { type: 'integer', nullable: false, isPrimaryKey: true, ordinal: 1 }),
  col('first_name', { ordinal: 2 }),
  col('Email', { ordinal: 3 }),
  col('created_at', { type: 'timestamp', nullable: false, defaultValue: 'now()', ordinal: 4 })
]

describe('autoMapSql', () => {
  it('maps by name (exact first, then loosely) and leaves the rest skipped', () => {
    expect(autoMapSql(['ID', 'First Name', 'email', 'unknown', 'id'], columns, true)).toEqual([
      null,
      'first_name',
      'Email',
      null,
      'id'
    ])
  })

  it('maps by position without a header', () => {
    expect(autoMapSql(['Column 1', 'Column 2'], [...columns].reverse(), false)).toEqual([
      'id',
      'first_name'
    ])
    expect(autoMapSql(['a', 'b', 'c', 'd', 'e'], columns, false)[4]).toBeNull()
  })
})

describe('mapping checks', () => {
  it('knows which columns need a value', () => {
    expect(isRequiredColumn(columns[0], 'postgres')).toBe(true)
    expect(isRequiredColumn(columns[0], 'sqlite')).toBe(false) // INTEGER PRIMARY KEY = rowid
    expect(isRequiredColumn(columns[3], 'postgres')).toBe(false) // has a default
    expect(isRequiredColumn(col('n', { nullable: false }), 'clickhouse')).toBe(false)
    expect(isRequiredColumn(col('n', { nullable: false, autoIncrement: true }), 'mysql')).toBe(
      false
    )
  })

  it('reports nothing mapped, duplicates and unmapped required columns', () => {
    expect(sqlMappingIssues([null, null], columns, 'postgres')).toEqual([
      { level: 'error', text: 'Map at least one file column to a table column.' }
    ])
    const issues = sqlMappingIssues(['first_name', 'first_name'], columns, 'postgres')
    expect(issues[0]).toEqual({
      level: 'error',
      text: '"first_name" is mapped from more than one file column.'
    })
    expect(issues[1].level).toBe('warning')
    expect(issues[1].text).toContain('required (NOT NULL, no default): id')
    expect(sqlMappingIssues(['id', 'first_name'], columns, 'postgres')).toEqual([])
  })

  it('checks Mongo field names', () => {
    const f = (name: string, include = true) => ({ include, name, type: 'string' as const })
    expect(mongoFieldIssues([f('a', false)])[0].text).toBe('Include at least one column.')
    expect(mongoFieldIssues([f('a'), f('a')])[0].text).toContain('written by two columns')
    expect(mongoFieldIssues([f('a'), f('a.b')])[0].text).toContain('cannot hold a value')
    expect(mongoFieldIssues([f('$set')])[0].text).toContain('cannot start with "$"')
    expect(mongoFieldIssues([f('')])[0].text).toBe('A field name is empty.')
    expect(mongoFieldIssues([f('a.b'), f('a.c'), f('d', false), f('d')])).toEqual([])
  })

  it('refuses field names that name a prototype (__proto__, constructor, prototype)', () => {
    const f = (name: string, include = true) => ({ include, name, type: 'string' as const })
    for (const name of ['__proto__.isAdmin', 'constructor.prototype.x', 'a.prototype', '__proto__'])
      expect(mongoFieldIssues([f(name), f('name')])).toEqual([
        {
          level: 'error',
          text: expect.stringMatching(/"(__proto__|constructor|prototype)" cannot be a field name/)
        }
      ])
    // Not included: no issue. Similar names are fine.
    expect(mongoFieldIssues([f('__proto__.x', false), f('name')])).toEqual([])
    expect(mongoFieldIssues([f('proto'), f('constructors'), f('a._prototype')])).toEqual([])
  })

  it('suggests Mongo fields with detected types (or strings)', () => {
    expect(autoMongoFields(['name', ' age '], ['string', 'number'], true, true)).toEqual([
      { include: true, name: 'name', type: 'string' },
      { include: true, name: 'age', type: 'number' }
    ])
    expect(autoMongoFields(['Column 1'], ['number'], false, false)).toEqual([
      { include: true, name: 'field1', type: 'string' }
    ])
  })
})

describe('buildStartRequest', () => {
  it('sends the mapped columns only', () => {
    const request = buildStartRequest('dp', 'imp', {
      filePath: '/tmp/a.csv',
      target: { kind: 'table', ref: { name: 't', database: 'shop' } },
      format: 'csv',
      encoding: 'utf-8',
      csv: { delimiter: ';', quote: '"', header: true },
      sqlTargets: ['id', null, 'name'],
      mongoFields: [],
      empty: 'null',
      onError: 'rollback'
    })
    expect(request).toEqual({
      dataProjectId: 'dp',
      importId: 'imp',
      filePath: '/tmp/a.csv',
      target: { kind: 'table', ref: { name: 't', database: 'shop' } },
      format: 'csv',
      encoding: 'utf-8',
      csv: { delimiter: ';', quote: '"', header: true },
      columns: [
        { source: 0, target: 'id' },
        { source: 2, target: 'name' }
      ],
      empty: 'null',
      onError: 'rollback'
    })
  })

  it('sends Mongo fields with types, and nothing for JSON formats', () => {
    const base = {
      filePath: '/tmp/a',
      target: { kind: 'collection' as const, database: 'shop', collection: 'c' },
      encoding: 'utf-8' as const,
      sqlTargets: [],
      mongoFields: [
        { include: true, name: ' a.b ', type: 'int32' as const },
        { include: false, name: 'x', type: 'string' as const }
      ],
      empty: 'omit' as const,
      onError: 'skip' as const
    }
    expect(
      buildStartRequest('dp', 'i', {
        ...base,
        format: 'csv',
        csv: { delimiter: ',', quote: '"', header: true }
      }).columns
    ).toEqual([{ source: 0, target: 'a.b', type: 'int32' }])
    const json = buildStartRequest('dp', 'i', { ...base, format: 'json', csv: null })
    expect(json.columns).toBeUndefined()
    expect(json.csv).toBeUndefined()
  })
})

describe('progress and results', () => {
  const event = {
    importId: 'i',
    phase: 'importing' as const,
    bytesRead: 50,
    totalBytes: 100,
    rowsRead: 30,
    rowsImported: 25,
    totalRows: 100,
    done: false
  }

  it('measures the import by rows and the scan by bytes', () => {
    expect(progressFraction(event)).toBe(0.25)
    expect(progressFraction({ ...event, phase: 'scanning', totalRows: null })).toBe(0.5)
    expect(progressFraction(null)).toBeNull()
    expect(progressText(event, 'sql')).toBe('Importing… 25 of 100 rows')
    expect(progressText({ ...event, phase: 'scanning' }, 'document')).toBe(
      'Checking the file… 30 documents read'
    )
  })

  const failed: FinishedResponse = {
    status: 'failed',
    message:
      'Row 7 (line 8): duplicate key. Nothing was imported (the transaction was rolled back).',
    rowsRead: 500,
    rowsImported: 0,
    rowsSkipped: 0,
    errorCount: 1,
    errors: [{ row: 7, line: 8, message: 'duplicate key' }],
    durationMs: 12,
    rolledBack: true
  }

  it('titles every outcome', () => {
    expect(resultTitle(failed, 'sql', 'shop.t')).toEqual({ tone: 'error', title: failed.message })
    expect(
      resultTitle(
        { ...failed, status: 'ok', rowsImported: 1, rowsSkipped: 0, errorCount: 0, errors: [] },
        'document',
        'shop.c'
      )
    ).toEqual({ tone: 'ok', title: 'Imported 1 document into shop.c' })
    expect(
      resultTitle({ ...failed, status: 'ok', rowsImported: 98, rowsSkipped: 2 }, 'sql', 't').title
    ).toBe('Imported 98 rows into t; 2 skipped')
    expect(
      resultTitle(
        { ...failed, status: 'cancelled', rolledBack: false, rowsImported: 40 },
        'sql',
        't'
      ).title
    ).toBe('Import cancelled: 40 rows were imported before the cancel')
    expect(
      resultTitle(
        { ...failed, status: 'cancelled', rolledBack: false, rowsImported: 1 },
        'document',
        'c'
      ).title
    ).toBe('Import cancelled: 1 document was imported before the cancel')
  })

  it('shows a range when an interrupted batch may be partly written', () => {
    const cancelled: FinishedResponse = {
      ...failed,
      status: 'cancelled',
      rolledBack: false,
      rowsImported: 20_000,
      rowsUncertain: 10_000
    }
    expect(importedCountText(cancelled)).toBe('20,000–30,000')
    expect(importedCountText({ rowsImported: 5 })).toBe('5')
    expect(resultTitle(cancelled, 'document', 'shop.c').title).toBe(
      'Import cancelled: 20,000–30,000 documents were imported before the cancel (the batch in flight was interrupted and may be partly written)'
    )
    expect(reportText(cancelled, 'document', 'a.ndjson', 'shop.c')).toContain(
      'imported 20,000–30,000,'
    )
    expect(mayHaveImported({ rowsImported: 0, rowsUncertain: 3 })).toBe(true)
    expect(mayHaveImported({ rowsImported: 0 })).toBe(false)
  })

  it('writes a copyable report', () => {
    const text = reportText({ ...failed, errorCount: 3 }, 'sql', 'a.csv', 'shop.t')
    expect(text).toContain('Import of a.csv into shop.t: failed')
    expect(text).toContain('Row 7 (line 8): duplicate key')
    expect(text).toContain('… and 2 more')
  })

  it('shows what an empty cell becomes', () => {
    const csv = { family: 'sql' as const, format: 'csv' as const }
    expect(cellDisplay(null, { ...csv, empty: 'null' })).toEqual({ text: 'NULL', kind: 'null' })
    expect(cellDisplay(null, { ...csv, empty: 'empty' })).toEqual({ text: '""', kind: 'empty' })
    expect(cellDisplay('', { ...csv, empty: 'null' })).toEqual({ text: '""', kind: 'empty' })
    expect(cellDisplay('a\nb', { ...csv, empty: 'null' }).text).toBe('a↵b')
    expect(cellDisplay(null, { family: 'document', format: 'json', empty: 'omit' }).kind).toBe(
      'omitted'
    )
  })

  it('names targets like the explorer', () => {
    expect(
      targetDisplayName(
        { kind: 'table', ref: { name: 't', schema: 'public', database: 'shop' } },
        'postgres'
      )
    ).toBe('public.t')
    expect(
      targetDisplayName({ kind: 'table', ref: { name: 't', database: 'shop' } }, 'mysql')
    ).toBe('shop.t')
    expect(
      targetDisplayName({ kind: 'table', ref: { name: 't', database: 'main' } }, 'sqlite')
    ).toBe('t')
    expect(
      targetDisplayName({ kind: 'collection', database: 'shop', collection: 'users' }, null)
    ).toBe('shop.users')
  })
})
