// Copy/export text formats: TSV quoting, RFC 4180 CSV (delimiter, NULL text, BOM), JSON (duplicate
// column keys, nested JSON columns, binary; one object for the row detail's "Copy row"), SQL
// INSERT per dialect (quoting, batching, truncated binary never written) and Markdown; plus the
// cell helpers behind them.
import { describe, expect, it } from 'vitest'
import type { DataCell, DataColumnMeta } from '@shared/data-projects/types'
import {
  binaryPreview,
  cellDisplayText,
  cellToText,
  estimateColumnWidth,
  hexDump,
  parseEditedValue
} from './cell-format'
import {
  formatRows,
  rowToJson,
  toCsv,
  toJson,
  toMarkdown,
  toSqlInserts,
  toTsv,
  uniqueColumnKeys
} from './export-format'

const columns: DataColumnMeta[] = [
  { name: 'id', type: 'int4' },
  { name: 'name', type: 'text' },
  { name: 'attrs', type: 'jsonb' }
]
const rows: DataCell[][] = [
  [1, 'Ann', '{"a":1}'],
  [2, 'O\'Brien, "Bob"', null],
  [3, 'multi\nline', '[1,2]']
]

describe('TSV', () => {
  it('quotes fields with tabs, newlines and quotes; NULL is empty', () => {
    expect(toTsv(columns, rows)).toBe(
      '1\tAnn\t{""a"":1}'.replace('{""a"":1}', '"{""a"":1}"') +
        '\n2\t"O\'Brien, ""Bob"""\t\n3\t"multi\nline"\t[1,2]'
    )
    expect(toTsv(columns, [], { header: true })).toBe('id\tname\tattrs')
  })
})

describe('CSV', () => {
  it('writes RFC 4180 with a header and CRLF', () => {
    expect(toCsv(columns, rows)).toBe(
      'id,name,attrs\r\n1,Ann,"{""a"":1}"\r\n2,"O\'Brien, ""Bob""",\r\n3,"multi\nline","[1,2]"\r\n'
    )
  })

  it('supports another delimiter, NULL text, no header and a BOM', () => {
    const out = toCsv(columns, [[1, 'a;b', null]], {
      delimiter: ';',
      nullText: '\\N',
      header: false,
      bom: true
    })
    expect(out).toBe('﻿1;"a;b";\\N\r\n')
  })

  it('tells NULL ("") apart from the empty string ("\\"\\"") like the server export', () => {
    const ab: DataColumnMeta[] = [{ name: 'a' }, { name: 'b' }]
    const cells: DataCell[][] = [
      [null, ''],
      ['', null],
      ['x', ' y']
    ]
    expect(toCsv(ab, cells)).toBe('a,b\r\n,""\r\n"",\r\nx," y"\r\n')
    expect(formatRows('csv', ab, cells)).toBe('a,b\r\n,""\r\n"",\r\nx," y"\r\n')
    // A custom NULL text never collides with the empty string either.
    expect(toCsv(ab, [[null, '']], { header: false, nullText: 'NULL' })).toBe('NULL,""\r\n')
    // TSV (spreadsheet paste) keeps both as an empty cell.
    expect(toTsv(ab, cells)).toBe('\t\n\t\nx\t y')
  })
})

describe('JSON', () => {
  it('nests JSON columns, keeps numbers and nulls, dedupes keys', () => {
    const parsed = JSON.parse(toJson(columns, rows))
    expect(parsed[0]).toEqual({ id: 1, name: 'Ann', attrs: { a: 1 } })
    expect(parsed[1].attrs).toBeNull()
    expect(uniqueColumnKeys([{ name: 'id' }, { name: 'id' }, { name: 'x' }])).toEqual([
      'id',
      'id_2',
      'x'
    ])
  })

  it('writes one row as a pretty object (row detail "Copy row")', () => {
    expect(JSON.parse(rowToJson(columns, rows[0]))).toEqual({ id: 1, name: 'Ann', attrs: { a: 1 } })
    expect(rowToJson([{ name: 'id' }, { name: 'id' }], [1, null])).toBe(
      '{\n  "id": 1,\n  "id_2": null\n}'
    )
  })

  it('writes binary as 0x hex', () => {
    const out = JSON.parse(toJson([{ name: 'b' }], [[{ $t: 'bin', hex: 'cafe', len: 2 }]]))
    expect(out[0].b).toBe('0xcafe')
  })
})

describe('SQL INSERT', () => {
  it('quotes identifiers and literals per dialect', () => {
    expect(
      toSqlInserts(columns.slice(0, 2), [[1, "O'B"]], { dialect: 'mysql', table: 'users' })
    ).toBe("INSERT INTO `users` (`id`, `name`) VALUES (1, 'O''B');")
    expect(
      toSqlInserts(columns.slice(0, 2), [[1, null]], {
        dialect: 'postgres',
        table: { schema: 'public', name: 'users' }
      })
    ).toBe('INSERT INTO "public"."users" ("id", "name") VALUES (1, NULL);')
  })

  it('batches rows and falls back to the source table', () => {
    const cols: DataColumnMeta[] = [{ name: 'id', table: 'orders' }]
    expect(toSqlInserts(cols, [[1], [2], [3]], { dialect: 'sqlite', batchSize: 2 })).toBe(
      'INSERT INTO "orders" ("id") VALUES\n  (1),\n  (2);\nINSERT INTO "orders" ("id") VALUES\n  (3);'
    )
  })

  it('never writes a truncated binary preview', () => {
    const out = toSqlInserts([{ name: 'b' }], [[{ $t: 'bin', hex: 'ab', len: 300 }]], {
      dialect: 'postgres',
      table: 't'
    })
    expect(out).toContain('NULL /* binary value truncated in the result */')
    const full = toSqlInserts([{ name: 'b' }], [[{ $t: 'bin', hex: 'ab', len: 1 }]], {
      dialect: 'postgres',
      table: 't'
    })
    expect(full).toContain("decode('AB', 'hex')")
  })
})

describe('Markdown', () => {
  it('escapes pipes and shows NULL', () => {
    expect(toMarkdown([{ name: 'a|b' }], [[null], ['x|y']])).toBe(
      '| a\\|b |\n| --- |\n| NULL |\n| x\\|y |'
    )
  })
})

describe('cell helpers', () => {
  it('renders binary, NULL, booleans and long text', () => {
    expect(binaryPreview({ $t: 'bin', hex: '0a1b', len: 2 })).toBe('0x0a1b (2 bytes)')
    expect(binaryPreview({ $t: 'bin', hex: '00'.repeat(64), len: 4096 })).toMatch(
      /^0x(00){12}… \(4,096 bytes\)$/
    )
    expect(cellDisplayText(null)).toBe('NULL')
    expect(cellDisplayText(true)).toBe('true')
    expect(cellDisplayText('a\nb')).toBe('a↵b')
    expect(cellDisplayText('x'.repeat(400)).length).toBe(301)
    expect(cellToText({ $t: 'bin', hex: 'ab', len: 9 })).toBe('0xab…')
    expect(cellToText(null)).toBe('')
  })

  it('dumps hex with an ASCII gutter', () => {
    expect(hexDump('48690a')).toBe('00000000  48 69 0a' + ' '.repeat(39) + '  Hi.')
  })

  it('sizes columns from header and sample', () => {
    const narrow = estimateColumnWidth('id', 'int4', [1, 2, 3])
    const wide = estimateColumnWidth('description', 'text', ['x'.repeat(200)])
    expect(narrow).toBeGreaterThanOrEqual(56)
    expect(wide).toBe(380)
  })

  it('parses edited values keeping numbers and booleans typed', () => {
    expect(parseEditedValue('42', false, 7)).toBe(42)
    expect(parseEditedValue('042', false, 7)).toBe('042')
    expect(parseEditedValue('', false, 'x')).toBe('')
    expect(parseEditedValue('anything', true, 'x')).toBeNull()
    expect(parseEditedValue('false', false, true)).toBe(false)
  })
})
