// CREATE TABLE reading for each engine's DDL format (shapes taken from the real servers: MySQL
// 8.4 / MariaDB 11.4 SHOW CREATE TABLE, the PostgreSQL catalog rebuild, sqlite_schema.sql and
// ClickHouse SHOW CREATE TABLE): column definitions, CHECK / UNIQUE constraints and constraint
// names.
import { describe, expect, it } from 'vitest'
import { clickhouseColumnType, parseCreateTable } from './ddl-parse'

describe('parseCreateTable', () => {
  it('MySQL: column definitions and named CHECKs (NOT ENFORCED stripped)', () => {
    const ddl = `CREATE TABLE \`tmp_par_struct\` (
  \`id\` int unsigned NOT NULL AUTO_INCREMENT,
  \`name\` varchar(50) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL DEFAULT 'it''s, ok' COMMENT 'the ''name''',
  \`inv\` int DEFAULT NULL /*!80023 INVISIBLE */,
  \`price\` decimal(10,2) DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_name\` (\`name\`),
  KEY \`idx_e\` (\`e\`,\`d\`),
  CONSTRAINT \`chk_price\` CHECK ((\`price\` >= 0)),
  CONSTRAINT \`chk_off\` CHECK ((\`price\` < 100)) /*!80016 NOT ENFORCED */
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`
    const parsed = parseCreateTable(ddl, 'mysql')!
    expect([...parsed.columns.keys()]).toEqual(['id', 'name', 'inv', 'price'])
    expect(parsed.columns.get('name')).toBe(
      "varchar(50) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL DEFAULT 'it''s, ok' COMMENT 'the ''name'''"
    )
    expect(parsed.columns.get('inv')).toBe('int DEFAULT NULL /*!80023 INVISIBLE */')
    expect(parsed.checks).toEqual([
      { name: 'chk_price', expression: '`price` >= 0' },
      { name: 'chk_off', expression: '`price` < 100' }
    ])
    expect(parsed.uniques).toEqual([])
  })

  it('MariaDB: column-level CHECK of a JSON column', () => {
    const ddl = `CREATE TABLE \`products\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`attributes\` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(\`attributes\`)),
  PRIMARY KEY (\`id\`),
  CONSTRAINT \`CONSTRAINT_1\` CHECK (\`id\` > -100)
) ENGINE=InnoDB;`
    const parsed = parseCreateTable(ddl, 'mariadb')!
    expect(parsed.checks).toEqual([
      { name: null, column: 'attributes', expression: 'json_valid(`attributes`)' },
      { name: 'CONSTRAINT_1', expression: '`id` > -100' }
    ])
  })

  it('PostgreSQL: UNIQUE / CHECK / EXCLUDE constraints and the names that need DROP CONSTRAINT', () => {
    const ddl = `CREATE TABLE public.users (
  id integer DEFAULT nextval('users_id_seq'::regclass) NOT NULL,
  email text NOT NULL,
  price numeric(10,2) CHECK (price > (0)::numeric),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT "Odd ""name""" UNIQUE NULLS NOT DISTINCT (a, b),
  CONSTRAINT users_price_check CHECK (price > 0::numeric),
  CONSTRAINT no_overlap EXCLUDE USING gist (c WITH &&),
  CONSTRAINT users_ref_fkey FOREIGN KEY (ref) REFERENCES users(id)
);

CREATE INDEX idx_users_email ON public.users USING btree (email);
`
    const parsed = parseCreateTable(ddl, 'postgres')!
    expect(parsed.uniques).toEqual([
      { name: 'users_email_key', columns: 'email' },
      { name: 'Odd "name"', columns: 'a, b' }
    ])
    expect(parsed.checks).toEqual([
      { name: null, column: 'price', expression: 'price > (0)::numeric' },
      { name: 'users_price_check', expression: 'price > 0::numeric' }
    ])
    expect([...parsed.constraintNames].sort()).toEqual(
      ['Odd "name"', 'no_overlap', 'users_email_key', 'users_pkey'].sort()
    )
  })

  it('SQLite: inline and table CHECKs, named column constraints', () => {
    const ddl = `CREATE TABLE tmp_par_s (id INTEGER PRIMARY KEY, "a2" TEXT NOT NULL DEFAULT 'x', b INT CONSTRAINT b_pos CHECK (b > 0), c TEXT UNIQUE, CONSTRAINT ck CHECK (length("a2") < 10));
CREATE INDEX ix ON tmp_par_s (c);`
    const parsed = parseCreateTable(ddl, 'sqlite')!
    expect([...parsed.columns.keys()]).toEqual(['id', 'a2', 'b', 'c'])
    expect(parsed.checks).toEqual([
      { name: 'b_pos', column: 'b', expression: 'b > 0' },
      { name: 'ck', expression: 'length("a2") < 10' }
    ])
  })

  it('ClickHouse: CHECK without parentheses, skipping indexes ignored', () => {
    const ddl = `CREATE TABLE shop.tmp_par_struct
(
    \`id\` UInt64,
    \`name\` LowCardinality(Nullable(String)) DEFAULT 'x' COMMENT 'nm',
    INDEX idx_name name TYPE bloom_filter GRANULARITY 4,
    CONSTRAINT c_id CHECK id > 0
)
ENGINE = MergeTree
ORDER BY id`
    const parsed = parseCreateTable(ddl, 'clickhouse')!
    expect([...parsed.columns.keys()]).toEqual(['id', 'name'])
    expect(parsed.checks).toEqual([{ name: 'c_id', expression: 'id > 0' }])
  })

  it('returns null without a CREATE TABLE', () => {
    expect(parseCreateTable('CREATE VIEW v AS SELECT 1;', 'postgres')).toBeNull()
    expect(parseCreateTable('', 'mysql')).toBeNull()
  })
})

describe('clickhouseColumnType', () => {
  it('reads the type off a SHOW CREATE TABLE column definition', () => {
    expect(clickhouseColumnType('String')).toBe('String')
    expect(clickhouseColumnType("Nullable(String) DEFAULT 'x' COMMENT 'c'")).toBe(
      'Nullable(String)'
    )
    expect(clickhouseColumnType('Map(String, Nullable(Int64)) CODEC(ZSTD(1))')).toBe(
      'Map(String, Nullable(Int64))'
    )
    expect(clickhouseColumnType('DateTime64(3) MATERIALIZED now64() TTL ts + 1')).toBe(
      'DateTime64(3)'
    )
    const parsed = parseCreateTable(
      "CREATE TABLE shop.t\n(\n    `id` UInt64,\n    `n` LowCardinality(String) COMMENT 'nm'\n)\nENGINE = MergeTree\nORDER BY id",
      'clickhouse'
    )!
    expect(clickhouseColumnType(parsed.columns.get('n')!)).toBe('LowCardinality(String)')
  })
})
