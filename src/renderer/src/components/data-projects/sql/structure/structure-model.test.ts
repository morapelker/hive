// The structure editor's model: per-dialect locks and read-only reasons, staging helpers, the
// exact DDL for every engine (statement order, quoting, MySQL's single ALTER that keeps the rest
// of a column's definition), validation, and the rebase after a run stopped part way.
import { describe, expect, it } from 'vitest'
import type {
  DataColumnInfo,
  DataIndexInfo,
  DataTableDetails,
  SqlDialect
} from '@shared/data-projects/types'
import { parseCreateTable } from './ddl-parse'
import {
  addNewColumn,
  baseKey,
  buildStructureModel,
  emptyStructure,
  newKey,
  parseServerVersion,
  pendingStructureCount,
  planStructureChanges,
  planText,
  pruneStaged,
  rebaseAfterApply,
  removeNewColumn,
  setColumnField,
  setColumnUsing,
  structureReadOnlyReason,
  toggleDropColumn,
  toggleDropIndex,
  updateNewColumn,
  upsertIndex,
  type StagedStructure,
  type StructureModel
} from './structure-model'

const col = (name: string, type: string, extra: Partial<DataColumnInfo> = {}): DataColumnInfo => ({
  name,
  type,
  nullable: true,
  defaultValue: null,
  isPrimaryKey: false,
  ordinal: 0,
  ...extra
})

const details = (
  dialect: SqlDialect,
  columns: DataColumnInfo[],
  indexes: DataIndexInfo[] = [],
  extra: Partial<DataTableDetails> = {}
): DataTableDetails => ({
  ref:
    dialect === 'postgres'
      ? { database: 'shop', schema: 'public', name: 'users', kind: 'table' }
      : { database: dialect === 'sqlite' ? 'main' : 'shop', name: 'users', kind: 'table' },
  kind: 'table',
  columns: columns.map((c, i) => ({ ...c, ordinal: i + 1 })),
  indexes,
  foreignKeys: [],
  triggers: [],
  primaryKey: columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
  ...extra
})

function model(
  dialect: SqlDialect,
  d: DataTableDetails,
  options: { ddl?: string; version?: string; backslashEscapes?: boolean } = {}
): StructureModel {
  return buildStructureModel({
    dialect,
    details: d,
    ref: d.ref,
    safeMode: 'off',
    server: parseServerVersion(options.version, dialect),
    parsed: options.ddl ? parseCreateTable(options.ddl, dialect) : null,
    ddlState: options.ddl ? 'ready' : 'failed',
    ...(options.backslashEscapes !== undefined
      ? { backslashEscapes: options.backslashEscapes }
      : {})
  })
}

const column = (m: StructureModel, name: string) => m.columns.find((c) => c.info.name === name)!
const sql = (m: StructureModel, staged: StagedStructure): string[] =>
  planStructureChanges(m, staged).statements.map((s) => s.sql)

// ---------------------------------------------------------------------------------------------

const pgDetails = details(
  'postgres',
  [
    col('id', 'integer', {
      isPrimaryKey: true,
      nullable: false,
      defaultValue: "nextval('users_id_seq'::regclass)",
      autoIncrement: true
    }),
    col('name', 'text', { nullable: false }),
    col('email', 'text', { nullable: false }),
    col('code', 'integer', { extra: 'GENERATED ALWAYS AS IDENTITY', nullable: false }),
    col('note', 'text', { comment: 'old' })
  ],
  [
    { name: 'users_pkey', columns: ['id'], unique: true, primary: true, type: 'btree' },
    { name: 'users_email_key', columns: ['email'], unique: true, primary: false, type: 'btree' },
    { name: 'idx_users_name', columns: ['name'], unique: false, primary: false, type: 'btree' }
  ]
)
const pgDdl = `CREATE TABLE public.users (
  id integer DEFAULT nextval('users_id_seq'::regclass) NOT NULL,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_key UNIQUE (email)
);`

describe('PostgreSQL', () => {
  const m = model('postgres', pgDetails, { ddl: pgDdl, version: 'PostgreSQL 17.11' })

  it('locks: PK and identity nullability, identity default', () => {
    expect(column(m, 'id').locks.nullable).toMatch(/Primary key/)
    expect(column(m, 'code').locks.nullable).toMatch(/Identity/)
    expect(column(m, 'code').locks.default).toMatch(/Identity/)
    expect(column(m, 'name').locks).toEqual({})
    expect(m.indexes.find((i) => i.info.name === 'users_email_key')!.constraint).toBe(true)
    expect(m.indexes.find((i) => i.info.name === 'users_pkey')!.dropLock).toMatch(/Primary key/)
  })

  it('one statement per action in order: drop index, drop column, column edits, add, create index', () => {
    let s = emptyStructure()
    s = toggleDropIndex(s, 'idx_users_name')
    s = toggleDropIndex(s, 'users_email_key')
    s = toggleDropColumn(s, 'note')
    const name = column(m, 'name')
    s = setColumnField(s, name, 'name', 'full name')
    s = setColumnField(s, name, 'type', 'varchar(200)')
    // USING runs after the rename: it names the column by its new name.
    s = setColumnUsing(s, 'name', '"full name"::varchar(200)')
    s = setColumnField(s, name, 'nullable', true)
    s = setColumnField(s, name, 'defaultExpr', "'anon'")
    s = setColumnField(s, name, 'comment', "it's")
    const added = addNewColumn(s, m)
    s = updateNewColumn(added.staged, added.id, {
      name: 'age',
      type: 'integer',
      nullable: false,
      defaultExpr: '0',
      comment: 'years'
    })
    s = upsertIndex(s, {
      id: 'i1',
      name: 'users_age_idx',
      columns: [{ key: newKey(added.id) }, { key: baseKey('name') }],
      unique: true,
      method: 'btree'
    })
    expect(sql(m, s)).toEqual([
      'ALTER TABLE "public"."users" DROP CONSTRAINT "users_email_key"',
      'DROP INDEX "public"."idx_users_name"',
      'ALTER TABLE "public"."users" DROP COLUMN "note"',
      'ALTER TABLE "public"."users" RENAME COLUMN "name" TO "full name"',
      'ALTER TABLE "public"."users" ALTER COLUMN "full name" TYPE varchar(200) USING "full name"::varchar(200)',
      'ALTER TABLE "public"."users" ALTER COLUMN "full name" DROP NOT NULL',
      'ALTER TABLE "public"."users" ALTER COLUMN "full name" SET DEFAULT \'anon\'',
      'COMMENT ON COLUMN "public"."users"."full name" IS \'it\'\'s\'',
      'ALTER TABLE "public"."users" ADD COLUMN "age" integer DEFAULT 0 NOT NULL',
      'COMMENT ON COLUMN "public"."users"."age" IS \'years\'',
      'CREATE UNIQUE INDEX "users_age_idx" ON "public"."users" ("age", "full name")'
    ])
    expect(pendingStructureCount(s, m)).toBe(6)
    expect(planStructureChanges(m, s).issues).toEqual([])
  })

  it('removing a default / comment and SET NOT NULL; GIN index method', () => {
    let s = emptyStructure()
    s = setColumnField(s, column(m, 'note'), 'comment', '')
    s = setColumnField(s, column(m, 'note'), 'nullable', false)
    s = upsertIndex(s, {
      id: 'g',
      name: 'idx_note',
      columns: [{ key: baseKey('note') }],
      unique: false,
      method: 'gin'
    })
    expect(sql(m, s)).toEqual([
      'ALTER TABLE "public"."users" ALTER COLUMN "note" SET NOT NULL',
      'COMMENT ON COLUMN "public"."users"."note" IS NULL',
      'CREATE INDEX "idx_note" ON "public"."users" USING gin ("note")'
    ])
    s = setColumnField(emptyStructure(), column(m, 'id'), 'defaultExpr', '')
    expect(sql(m, s)).toEqual(['ALTER TABLE "public"."users" ALTER COLUMN "id" DROP DEFAULT'])
  })

  it('setting a field back to the described value unstages it', () => {
    let s = setColumnField(emptyStructure(), column(m, 'name'), 'type', 'varchar(10)')
    s = setColumnUsing(s, 'name', 'x')
    s = setColumnField(s, column(m, 'name'), 'type', 'text')
    expect(s.changes).toEqual({})
    expect(pendingStructureCount(s, m)).toBe(0)
  })

  it('a partition takes its columns from the parent', () => {
    const part = model(
      'postgres',
      details('postgres', [col('a', 'int')], [], {
        properties: [{ label: 'Partition of', value: 'parent FOR VALUES IN (1)' }]
      })
    )
    expect(part.caps.columns).toMatch(/partition/)
    const s = toggleDropColumn(emptyStructure(), 'a')
    expect(planStructureChanges(part, s).issues[0].message).toMatch(/partition/)
  })
})

// ---------------------------------------------------------------------------------------------

const myDdl = `CREATE TABLE \`users\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`name\` varchar(100) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL DEFAULT 'x' COMMENT 'who',
  \`ts\` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  \`email\` varchar(200) DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`email\` (\`email\`)
) ENGINE=InnoDB;`
const myDetails = details(
  'mysql',
  [
    col('id', 'int', { isPrimaryKey: true, nullable: false, autoIncrement: true }),
    col('name', 'varchar(100)', { nullable: false, defaultValue: 'x', comment: 'who' }),
    col('ts', 'timestamp', { defaultValue: 'CURRENT_TIMESTAMP' }),
    col('email', 'varchar(200)')
  ],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true, primary: true },
    { name: 'email', columns: ['email'], unique: true, primary: false }
  ]
)

describe('MySQL / MariaDB', () => {
  const m = model('mysql', myDetails, { ddl: myDdl, version: '8.4.13' })

  it('reads the base draft from SHOW CREATE TABLE', () => {
    expect(column(m, 'name').draft).toEqual({
      name: 'name',
      type: 'varchar(100)',
      nullable: false,
      defaultExpr: "'x'",
      comment: 'who'
    })
    expect(column(m, 'email').draft.defaultExpr).toBe('NULL')
    expect(column(m, 'id').locks.default).toMatch(/AUTO_INCREMENT/)
  })

  it('one ALTER TABLE with every action; MODIFY / CHANGE keep the rest of the definition', () => {
    let s = emptyStructure()
    s = toggleDropIndex(s, 'email')
    s = setColumnField(s, column(m, 'ts'), 'nullable', false)
    s = setColumnField(s, column(m, 'name'), 'name', 'full_name')
    s = setColumnField(s, column(m, 'name'), 'type', 'varchar(150)')
    s = setColumnField(s, column(m, 'email'), 'name', 'mail')
    const added = addNewColumn(s, m)
    s = updateNewColumn(
      added.staged,
      added.id,
      { name: 'age', type: 'int', nullable: false, defaultExpr: '0', comment: "it's" },
      { kind: 'after', column: baseKey('name') }
    )
    s = upsertIndex(s, {
      id: 'i',
      name: 'idx_mail',
      columns: [{ key: baseKey('email'), length: 10 }],
      unique: true
    })
    const plan = planStructureChanges(m, s)
    expect(plan.issues).toEqual([])
    expect(plan.statements).toHaveLength(1)
    expect(planText(plan)).toBe(
      [
        'ALTER TABLE `shop`.`users`',
        '  DROP INDEX `email`,',
        "  CHANGE COLUMN `name` `full_name` varchar(150) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL DEFAULT 'x' COMMENT 'who',",
        '  MODIFY COLUMN `ts` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,',
        '  RENAME COLUMN `email` TO `mail`,',
        "  ADD COLUMN `age` int NOT NULL DEFAULT 0 COMMENT 'it''s' AFTER `full_name`,",
        '  ADD UNIQUE INDEX `idx_mail` (`mail`(10));'
      ].join('\n')
    )
    expect(plan.statements[0].ops.map((o) => o.kind)).toEqual([
      'drop-index',
      'column',
      'column',
      'column',
      'add-column',
      'add-index'
    ])
  })

  it('renames with CHANGE COLUMN before MySQL 8 / MariaDB 10.5.2', () => {
    const old = model('mariadb', myDetails, { ddl: myDdl, version: '10.4.30-MariaDB' })
    const s = setColumnField(emptyStructure(), column(old, 'email'), 'name', 'mail')
    expect(sql(old, s)).toEqual([
      'ALTER TABLE `shop`.`users`\n  CHANGE COLUMN `email` `mail` varchar(200) DEFAULT NULL'
    ])
    const recent = model('mariadb', myDetails, { ddl: myDdl, version: '11.4.13-MariaDB-ubu2404' })
    expect(
      sql(recent, setColumnField(emptyStructure(), column(recent, 'email'), 'name', 'mail'))
    ).toEqual(['ALTER TABLE `shop`.`users`\n  RENAME COLUMN `email` TO `mail`'])
  })

  it('without the DDL, only RENAME COLUMN (when the server has it) is possible', () => {
    const blind = model('mysql', myDetails, { version: '8.4.13' })
    const name = column(blind, 'name')
    expect(name.locks.type).toMatch(/could not be read/)
    expect(name.locks.rename).toBeUndefined()
    const s = setColumnField(emptyStructure(), name, 'type', 'text')
    expect(planStructureChanges(blind, s).issues[0].message).toMatch(/could not be read/)
    const unknown = model('mysql', myDetails)
    expect(column(unknown, 'name').locks.rename).toMatch(/could not be read/)
  })

  it('FIRST position and PRIMARY that cannot be dropped', () => {
    const added = addNewColumn(emptyStructure(), m)
    const s = updateNewColumn(added.staged, added.id, {}, { kind: 'first' })
    expect(sql(m, s)[0]).toBe(
      'ALTER TABLE `shop`.`users`\n  ADD COLUMN `new_column` varchar(255) NULL FIRST'
    )
    const primary = planStructureChanges(m, toggleDropIndex(emptyStructure(), 'PRIMARY'))
    expect(primary.statements).toEqual([])
    expect(primary.issues[0].message).toMatch(/Primary key/)
  })
})

// ---------------------------------------------------------------------------------------------

describe('SQLite', () => {
  const d = details(
    'sqlite',
    [
      col('id', 'INTEGER', { isPrimaryKey: true, nullable: false }),
      col('email', 'TEXT'),
      col('name', 'TEXT'),
      col('tag', 'TEXT')
    ],
    [
      {
        name: 'sqlite_autoindex_users_1',
        columns: ['email'],
        unique: true,
        primary: false,
        type: 'unique constraint'
      },
      { name: 'idx_tag', columns: ['tag DESC'], unique: false, primary: false, type: 'index' }
    ]
  )
  const m = model('sqlite', d, { version: 'SQLite 3.51.0' })

  it('only ADD / RENAME / DROP COLUMN and CREATE / DROP INDEX', () => {
    expect(column(m, 'name').locks.type).toMatch(/SQLite cannot change/)
    expect(column(m, 'id').locks.drop).toMatch(/primary key/)
    expect(column(m, 'email').locks.drop).toMatch(/UNIQUE/)
    expect(m.indexes[0].dropLock).toMatch(/UNIQUE constraint/)
    expect(m.caps.comments).toBe(false)
    let s = setColumnField(emptyStructure(), column(m, 'name'), 'name', 'full_name')
    s = toggleDropIndex(s, 'idx_tag')
    s = toggleDropColumn(s, 'tag')
    const added = addNewColumn(s, m)
    s = updateNewColumn(added.staged, added.id, {
      name: 'n',
      type: 'INTEGER',
      nullable: false,
      defaultExpr: '0'
    })
    s = upsertIndex(s, {
      id: 'x',
      name: 'idx_n',
      columns: [{ key: newKey(added.id) }],
      unique: true
    })
    expect(sql(m, s)).toEqual([
      'DROP INDEX "main"."idx_tag"',
      'ALTER TABLE "main"."users" DROP COLUMN "tag"',
      'ALTER TABLE "main"."users" RENAME COLUMN "name" TO "full_name"',
      'ALTER TABLE "main"."users" ADD COLUMN "n" INTEGER DEFAULT 0 NOT NULL',
      'CREATE UNIQUE INDEX "main"."idx_n" ON "users" ("n")'
    ])
  })

  it('refuses an indexed column drop and a NOT NULL column without a default', () => {
    const issues = planStructureChanges(m, toggleDropColumn(emptyStructure(), 'tag')).issues
    expect(issues[0].message).toMatch(/index "idx_tag" uses it/)
    const added = addNewColumn(emptyStructure(), m)
    const s = updateNewColumn(added.staged, added.id, { nullable: false })
    expect(planStructureChanges(m, s).issues[0].message).toMatch(/non-NULL default/)
  })

  it('old SQLite versions lock rename and drop; virtual tables are read-only', () => {
    const old = model('sqlite', d, { version: 'SQLite 3.24.0' })
    expect(column(old, 'name').locks.rename).toMatch(/3\.25/)
    expect(column(old, 'name').locks.drop).toMatch(/3\.35/)
    expect(structureReadOnlyReason('sqlite', { ...d, engine: 'virtual: fts5' }, 'off')).toMatch(
      /virtual tables cannot be altered/
    )
  })
})

// ---------------------------------------------------------------------------------------------

describe('ClickHouse', () => {
  const d = details(
    'clickhouse',
    [
      col('id', 'UInt64', { isPrimaryKey: true, nullable: false, extra: 'sorting key' }),
      col('ts', 'DateTime', { nullable: false, extra: 'partition key', defaultValue: 'now()' }),
      col('name', 'LowCardinality(String)', { nullable: false, comment: 'nm' }),
      col('m', 'UInt32', { nullable: false, extra: 'MATERIALIZED', defaultValue: 'id * 2' }),
      col('n', 'Nullable(Int32)', { defaultValue: '5' })
    ],
    [
      {
        name: 'PRIMARY KEY',
        columns: ['id'],
        unique: false,
        primary: true,
        type: 'sparse primary index'
      },
      { name: 'idx_name', columns: ['name'], unique: false, primary: false, type: 'bloom_filter' }
    ],
    { engine: 'MergeTree' }
  )
  const m = model('clickhouse', d, { version: 'ClickHouse 24.8.14.39' })

  it('locks key columns and MATERIALIZED defaults', () => {
    expect(column(m, 'id').locks.rename).toMatch(/sorting key/)
    expect(column(m, 'ts').locks.type).toMatch(/partition key/)
    expect(column(m, 'm').locks.default).toMatch(/MATERIALIZED/)
    expect(column(m, 'n').draft.nullable).toBe(true)
    expect(m.caps.uniqueIndexes).toBe(false)
    expect(structureReadOnlyReason('clickhouse', { ...d, engine: 'Memory' }, 'off')).toMatch(
      /MergeTree/
    )
  })

  it('separate ALTERs: rename, MODIFY type / default, COMMENT COLUMN, ADD AFTER, skipping index', () => {
    let s = emptyStructure()
    s = toggleDropIndex(s, 'idx_name')
    s = setColumnField(s, column(m, 'n'), 'name', 'n2')
    s = setColumnField(s, column(m, 'n'), 'type', 'Nullable(Int64)')
    s = setColumnField(s, column(m, 'n'), 'defaultExpr', '')
    s = setColumnField(s, column(m, 'name'), 'comment', 'the name')
    const added = addNewColumn(s, m)
    s = updateNewColumn(
      added.staged,
      added.id,
      { name: 'x', type: 'String', defaultExpr: "'q'", comment: 'c' },
      { kind: 'after', column: baseKey('id') }
    )
    s = upsertIndex(s, {
      id: 'k',
      name: 'idx_x',
      columns: [{ key: newKey(added.id) }],
      unique: false,
      skipType: 'set(100)',
      granularity: 2
    })
    expect(sql(m, s)).toEqual([
      'ALTER TABLE `shop`.`users` DROP INDEX `idx_name`',
      "ALTER TABLE `shop`.`users` COMMENT COLUMN `name` 'the name'",
      'ALTER TABLE `shop`.`users` RENAME COLUMN `n` TO `n2`',
      'ALTER TABLE `shop`.`users` MODIFY COLUMN `n2` Nullable(Int64)',
      'ALTER TABLE `shop`.`users` MODIFY COLUMN `n2` REMOVE DEFAULT',
      "ALTER TABLE `shop`.`users` ADD COLUMN `x` String DEFAULT 'q' COMMENT 'c' AFTER `id`",
      'ALTER TABLE `shop`.`users` ADD INDEX `idx_x` `x` TYPE set(100) GRANULARITY 2'
    ])
  })

  it('a skipping index on several columns uses a tuple; an expression wins', () => {
    const base: Parameters<typeof upsertIndex>[1] = {
      id: 'k',
      name: 'ix',
      columns: [{ key: baseKey('name') }, { key: baseKey('n') }],
      unique: false
    }
    expect(sql(m, upsertIndex(emptyStructure(), base))).toEqual([
      'ALTER TABLE `shop`.`users` ADD INDEX `ix` (`name`, `n`) TYPE minmax GRANULARITY 1'
    ])
    expect(
      sql(
        m,
        upsertIndex(emptyStructure(), {
          ...base,
          expression: 'lower(name)',
          skipType: 'bloom_filter'
        })
      )
    ).toEqual([
      'ALTER TABLE `shop`.`users` ADD INDEX `ix` lower(name) TYPE bloom_filter GRANULARITY 1'
    ])
  })
})

// ---------------------------------------------------------------------------------------------

describe('validation', () => {
  const m = model('postgres', pgDetails, { ddl: pgDdl })

  it('empty / duplicate names, bad types and defaults', () => {
    let s = setColumnField(emptyStructure(), column(m, 'name'), 'name', 'email')
    s = setColumnField(s, column(m, 'note'), 'type', 'text; DROP TABLE users')
    s = setColumnField(s, column(m, 'note'), 'defaultExpr', "'unterminated")
    const added = addNewColumn(s, m)
    s = updateNewColumn(added.staged, added.id, { name: ' ' })
    const issues = planStructureChanges(m, s).issues.map((i) => [i.level, i.field, i.message])
    expect(issues).toEqual(
      expect.arrayContaining([
        ['error', 'name', 'Two columns are named "email"'],
        ['error', 'type', 'Type must not contain ";"'],
        ['error', 'defaultExpr', expect.stringMatching(/^Default /)],
        ['error', 'name', 'Column name is empty']
      ])
    )
  })

  it('warns about an unquoted text default but not about keywords or calls', () => {
    const warn = (expr: string) =>
      planStructureChanges(
        m,
        setColumnField(emptyStructure(), column(m, 'note'), 'defaultExpr', expr)
      )
        .issues.filter((i) => i.level === 'warning')
        .map((i) => i.message)
    expect(warn('hello')[0]).toMatch(/quote it \('hello'\)/)
    expect(warn('CURRENT_TIMESTAMP')).toEqual([])
    expect(warn('now()')).toEqual([])
    expect(warn("'hello'")).toEqual([])
    expect(warn('NULL')).toEqual([])
  })

  it('index problems: no name, taken name, no columns, dropped column', () => {
    let s = toggleDropColumn(emptyStructure(), 'note')
    s = upsertIndex(s, { id: 'a', name: '', columns: [], unique: false })
    s = upsertIndex(s, {
      id: 'b',
      name: 'idx_users_name',
      columns: [{ key: baseKey('note') }],
      unique: false
    })
    const messages = planStructureChanges(m, s).issues.map((i) => i.message)
    expect(messages).toEqual(
      expect.arrayContaining([
        'Index name is empty',
        'Pick at least one column',
        'Index name "idx_users_name" is taken',
        'Index "idx_users_name" uses a dropped column'
      ])
    )
  })

  it('removing a new column drops index references and AFTER positions to it', () => {
    const my = model('mysql', myDetails, { ddl: myDdl, version: '8.4.13' })
    const a = addNewColumn(emptyStructure(), my)
    const b = addNewColumn(a.staged, my)
    let s = updateNewColumn(b.staged, b.id, {}, { kind: 'after', column: newKey(a.id) })
    s = upsertIndex(s, { id: 'i', name: 'ix', columns: [{ key: newKey(a.id) }], unique: false })
    s = removeNewColumn(s, a.id)
    expect(s.adds[0].position).toEqual({ kind: 'end' })
    expect(s.addIndexes[0].columns).toEqual([])
    expect(s.adds[0].draft.name).toBe('new_column_2')
  })
})

// ---------------------------------------------------------------------------------------------

describe('read-only reasons', () => {
  it('safe mode, views and other kinds', () => {
    expect(structureReadOnlyReason('postgres', pgDetails, 'read-only')).toMatch(/Read-only mode/)
    expect(structureReadOnlyReason('postgres', { ...pgDetails, kind: 'view' }, 'off')).toMatch(
      /view’s columns/
    )
    expect(structureReadOnlyReason('postgres', pgDetails, 'safe')).toBeNull()
  })
})

describe('rebaseAfterApply / pruneStaged', () => {
  const m = model('postgres', pgDetails, { ddl: pgDdl })

  it('keeps the edits of statements that did not run, under the new name after a rename', () => {
    let s = toggleDropIndex(emptyStructure(), 'idx_users_name')
    s = setColumnField(s, column(m, 'name'), 'name', 'full_name')
    s = setColumnField(s, column(m, 'name'), 'type', 'varchar(10)')
    s = setColumnField(s, column(m, 'name'), 'nullable', true)
    const added = addNewColumn(s, m)
    s = updateNewColumn(added.staged, added.id, { name: 'age', comment: 'years' })
    s = upsertIndex(s, {
      id: 'ix',
      name: 'ix',
      columns: [{ key: baseKey('name') }, { key: newKey(added.id) }],
      unique: false
    })
    const plan = planStructureChanges(m, s)
    // Statements: drop index, rename, type, nullable, add, comment, create index.
    expect(plan.statements).toHaveLength(7)
    // The type change failed: drop index + rename ran.
    const after = rebaseAfterApply(
      s,
      plan.statements.slice(0, 2).flatMap((x) => x.ops)
    )
    expect(after.dropIndexes).toEqual([])
    expect(after.changes).toEqual({ full_name: { type: 'varchar(10)', nullable: true } })
    expect(after.addIndexes[0].columns[0].key).toBe(baseKey('full_name'))
    // Everything up to the comment of the new column ran.
    const later = rebaseAfterApply(
      s,
      plan.statements.slice(0, 5).flatMap((x) => x.ops)
    )
    expect(later.adds).toEqual([])
    expect(later.changes).toEqual({ age: { comment: 'years' } })
    expect(later.addIndexes[0].columns.map((c) => c.key)).toEqual([
      baseKey('full_name'),
      baseKey('age')
    ])
    // All of it ran.
    expect(
      rebaseAfterApply(
        s,
        plan.statements.flatMap((x) => x.ops)
      )
    ).toEqual(emptyStructure())
  })

  it('drops staged edits of columns and indexes that are gone', () => {
    let s = toggleDropColumn(emptyStructure(), 'gone')
    s = toggleDropIndex(s, 'gone_idx')
    s = { ...s, changes: { vanished: { type: 'int' }, name: { type: 'int' } } }
    const { staged, removed } = pruneStaged(s, m)
    expect(removed).toBe(3)
    expect(staged.changes).toEqual({ name: { type: 'int' } })
  })
})

// ---------------------------------------------------------------------------------------------
// Engine rules found against the live servers
// ---------------------------------------------------------------------------------------------

describe('MySQL / MariaDB with NO_BACKSLASH_ESCAPES', () => {
  // As SHOW CREATE TABLE prints it in ANY session: C:\tmp is written 'C:\\tmp'.
  const ddl = `CREATE TABLE \`users\` (
  \`p\` varchar(20) DEFAULT 'C:\\\\tmp' COMMENT 'a\\\\b''c',
  \`q\` int DEFAULT NULL
) ENGINE=InnoDB;`
  const d = details('mysql', [col('p', 'varchar(20)', { comment: "a\\b'c" }), col('q', 'int')])

  it('restates kept literals and quotes new ones in the session mode', () => {
    const nbe = model('mysql', d, { ddl, version: '8.4.13', backslashEscapes: false })
    expect(nbe.backslashEscapes).toBe(false)
    expect(column(nbe, 'p').draft.defaultExpr).toBe("'C:\\tmp'")
    let s = setColumnField(emptyStructure(), column(nbe, 'p'), 'type', 'varchar(30)')
    s = setColumnField(s, column(nbe, 'q'), 'comment', 'path C:\\new')
    const plan = planStructureChanges(nbe, s)
    expect(plan.issues).toEqual([])
    expect(planText(plan)).toBe(
      [
        'ALTER TABLE `shop`.`users`',
        "  MODIFY COLUMN `p` varchar(30) DEFAULT 'C:\\tmp' COMMENT 'a\\b''c',",
        "  MODIFY COLUMN `q` int DEFAULT NULL COMMENT 'path C:\\new';"
      ].join('\n')
    )
  })

  it('keeps the escaped form for a session that reads backslash escapes', () => {
    const esc = model('mysql', d, { ddl, version: '8.4.13' })
    expect(esc.backslashEscapes).toBe(true)
    expect(column(esc, 'p').draft.defaultExpr).toBe("'C:\\\\tmp'")
    let s = setColumnField(emptyStructure(), column(esc, 'p'), 'type', 'varchar(30)')
    s = setColumnField(s, column(esc, 'q'), 'comment', 'path C:\\new')
    expect(planText(planStructureChanges(esc, s))).toBe(
      [
        'ALTER TABLE `shop`.`users`',
        "  MODIFY COLUMN `p` varchar(30) DEFAULT 'C:\\\\tmp' COMMENT 'a\\\\b''c',",
        "  MODIFY COLUMN `q` int DEFAULT NULL COMMENT 'path C:\\\\new';"
      ].join('\n')
    )
  })

  it('reads a typed default with the session mode', () => {
    const typed = (backslashEscapes: boolean) => {
      const m = model('mysql', d, { ddl, version: '8.4.13', backslashEscapes })
      return planStructureChanges(
        m,
        setColumnField(emptyStructure(), column(m, 'q'), 'defaultExpr', "'C:\\'")
      ).issues.map((i) => i.level)
    }
    // 'C:\' is a whole string without escapes and an unterminated one with them.
    expect(typed(false)).toEqual([])
    expect(typed(true)).toEqual(['error'])
  })

  it('locks a column whose literal cannot be written without escapes', () => {
    const nul = model('mysql', details('mysql', [col('z', 'varchar(5)')]), {
      ddl: "CREATE TABLE `users` (\n  `z` varchar(5) DEFAULT 'a\\0b'\n);",
      version: '8.4.13',
      backslashEscapes: false
    })
    expect(column(nul, 'z').locks.type).toMatch(/NUL or Ctrl-Z/)
  })
})

describe('MariaDB CHANGE COLUMN with an inline CHECK', () => {
  const ddl = `CREATE TABLE \`users\` (
  \`id\` int(11) NOT NULL,
  \`j\` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(\`j\`)),
  \`ck\` int(11) NOT NULL CHECK (\`ck\` > 0 and \`ck\` < length('ck')),
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;`
  const d = details('mariadb', [
    col('id', 'int(11)', { isPrimaryKey: true, nullable: false }),
    col('j', 'longtext'),
    col('ck', 'int(11)', { nullable: false })
  ])

  it('restates the CHECK with the new name', () => {
    const m = model('mariadb', d, { ddl, version: '11.4.13-MariaDB' })
    let s = setColumnField(emptyStructure(), column(m, 'j'), 'name', 'j2')
    s = setColumnField(s, column(m, 'j'), 'comment', 'doc')
    s = setColumnField(s, column(m, 'ck'), 'name', 'ck3')
    s = setColumnField(s, column(m, 'ck'), 'nullable', true)
    expect(planText(planStructureChanges(m, s))).toBe(
      [
        'ALTER TABLE `shop`.`users`',
        "  CHANGE COLUMN `j` `j2` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'doc' CHECK (json_valid(`j2`)),",
        "  CHANGE COLUMN `ck` `ck3` int(11) NULL CHECK (`ck3` > 0 and `ck3` < length('ck'));"
      ].join('\n')
    )
  })

  it('also when an old server renames with CHANGE COLUMN alone', () => {
    const old = model('mariadb', d, { ddl, version: '10.4.30-MariaDB' })
    expect(sql(old, setColumnField(emptyStructure(), column(old, 'j'), 'name', 'doc'))).toEqual([
      'ALTER TABLE `shop`.`users`\n  CHANGE COLUMN `j` `doc` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`doc`))'
    ])
  })
})

describe('PostgreSQL USING after a rename', () => {
  const m = model('postgres', pgDetails, { ddl: pgDdl })
  const staged = (using: string): StagedStructure => {
    let s = setColumnField(emptyStructure(), column(m, 'note'), 'name', 'memo')
    s = setColumnField(s, column(m, 'note'), 'type', 'varchar(20)')
    return setColumnUsing(s, 'note', using)
  }

  it('refuses a USING that names the column by its old name', () => {
    for (const using of ['"note"::varchar(20)', 'NOTE::varchar(20)', 'upper(note)']) {
      expect(planStructureChanges(m, staged(using)).issues).toEqual([
        expect.objectContaining({
          level: 'error',
          field: 'using',
          message: 'USING runs after the rename: refer to the column as "memo", not "note"'
        })
      ])
    }
    expect(planStructureChanges(m, staged('"memo"::varchar(20)')).issues).toEqual([])
    // A function that happens to share the name is not the column.
    expect(planStructureChanges(m, staged('note("memo")')).issues).toEqual([])
  })

  it('accepts the old name when another column takes it', () => {
    let s = staged('"note"::varchar(20)')
    s = setColumnField(s, column(m, 'name'), 'name', 'note')
    expect(planStructureChanges(m, s).issues.filter((i) => i.field === 'using')).toEqual([])
  })
})

describe('ClickHouse type changes', () => {
  const d = details(
    'clickhouse',
    [col('id', 'UInt64', { isPrimaryKey: true, nullable: false }), col('n', 'Nullable(String)')],
    [],
    { engine: 'MergeTree' }
  )
  const m = model('clickhouse', d, { version: 'ClickHouse 24.8.14.39' })

  it('warn before Apply that the conversion runs as a mutation and is not rolled back', () => {
    const s = setColumnField(emptyStructure(), column(m, 'n'), 'type', 'String')
    const plan = planStructureChanges(m, s)
    expect(plan.issues).toEqual([
      expect.objectContaining({ level: 'warning', confirm: true, field: 'type' })
    ])
    expect(plan.issues[0].message).toMatch(/Removing Nullable from "n"/)
    expect(plan.issues[0].message).toMatch(/\(any NULL\)/)
    expect(plan.issues[0].message).toMatch(/not roll it back/)
    expect(plan.statements[0].ops[0]).toEqual({
      kind: 'column',
      name: 'n',
      fields: ['type'],
      retype: {
        column: 'n',
        from: 'Nullable(String)',
        to: 'String',
        revert: 'ALTER TABLE `shop`.`users` MODIFY COLUMN `n` Nullable(String)'
      }
    })
  })

  it('the revert names the column as renamed earlier in the run', () => {
    let s = setColumnField(emptyStructure(), column(m, 'n'), 'name', 'n2')
    s = setColumnField(s, column(m, 'n'), 'type', 'Nullable(Int64)')
    const plan = planStructureChanges(m, s)
    const op = plan.statements[1].ops[0]
    expect(op.kind === 'column' && op.retype).toEqual({
      column: 'n2',
      from: 'Nullable(String)',
      to: 'Nullable(Int64)',
      revert: 'ALTER TABLE `shop`.`users` MODIFY COLUMN `n2` Nullable(String)'
    })
    expect(plan.issues[0].message).toMatch(/Changing the type of "n2"/)
  })
})

describe('SQLite ADD COLUMN with a non-constant default', () => {
  const sqliteModel = (rowEstimate: number | null) =>
    model(
      'sqlite',
      details('sqlite', [col('id', 'INTEGER', { isPrimaryKey: true, nullable: false })], [], {
        rowEstimate
      }),
      { version: 'SQLite 3.51.0' }
    )
  const issues = (m: StructureModel, defaultExpr: string) => {
    const added = addNewColumn(emptyStructure(), m)
    return planStructureChanges(m, updateNewColumn(added.staged, added.id, { defaultExpr })).issues
  }

  it('warns (Apply reviews first) unless the table is known to be empty', () => {
    expect(issues(sqliteModel(3), 'CURRENT_TIMESTAMP')).toEqual([
      expect.objectContaining({
        level: 'warning',
        confirm: true,
        field: 'defaultExpr',
        message: expect.stringMatching(/to a table that has rows \(this one has 3\)/)
      })
    ])
    expect(issues(sqliteModel(null), "(datetime('now'))")).toEqual([
      expect.objectContaining({ level: 'warning', confirm: true })
    ])
    expect(issues(sqliteModel(0), 'CURRENT_TIMESTAMP')).toEqual([])
    // Constants are fine, parenthesised or not.
    expect(issues(sqliteModel(3), '(1)')).toEqual([])
    expect(issues(sqliteModel(3), "'x'")).toEqual([])
  })
})
