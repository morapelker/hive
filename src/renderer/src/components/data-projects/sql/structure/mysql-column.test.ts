// MySQL / MariaDB column definitions from real SHOW CREATE TABLE output (MySQL 8.4, MariaDB
// 11.4): clause splitting, and CHANGE / MODIFY definitions that keep every clause not edited.
import { describe, expect, it } from 'vitest'
import {
  buildMysqlColumnDefinition,
  isMysqlGenerated,
  mysqlDefaultExpression,
  mysqlTypeOf,
  parseMysqlColumnDefinition,
  renameColumnReferences,
  restateMysqlLiterals
} from './mysql-column'

const parse = (text: string, dialect: 'mysql' | 'mariadb' = 'mysql') => {
  const def = parseMysqlColumnDefinition(text, dialect)
  if (!def) throw new Error(`could not parse ${text}`)
  return def
}
const kinds = (text: string, dialect: 'mysql' | 'mariadb' = 'mysql') =>
  parse(text, dialect).clauses.map((c) => [c.kind, c.text])

describe('parseMysqlColumnDefinition', () => {
  it('splits type, charset, collation, nullability, default and comment', () => {
    expect(
      kinds(
        "varchar(50) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL DEFAULT 'it''s' COMMENT 'the ''name'''"
      )
    ).toEqual([
      ['type', 'varchar(50)'],
      ['charset', 'CHARACTER SET latin1'],
      ['collate', 'COLLATE latin1_bin'],
      ['nullability', 'NOT NULL'],
      ['default', "DEFAULT 'it''s'"],
      ['comment', "COMMENT 'the ''name'''"]
    ])
  })

  it('reads ON UPDATE, calls, signs, introducers, expressions and executable comments', () => {
    expect(
      kinds('timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)')
    ).toEqual([
      ['type', 'timestamp(3)'],
      ['nullability', 'NULL'],
      ['default', 'DEFAULT CURRENT_TIMESTAMP(3)'],
      ['onUpdate', 'ON UPDATE CURRENT_TIMESTAMP(3)']
    ])
    expect(kinds('double(8,2) DEFAULT -1.50', 'mariadb')).toEqual([
      ['type', 'double(8,2)'],
      ['default', 'DEFAULT -1.50']
    ])
    expect(kinds('char(36) DEFAULT (uuid())')[1]).toEqual(['default', 'DEFAULT (uuid())'])
    expect(kinds('char(36) DEFAULT uuid()', 'mariadb')[1]).toEqual(['default', 'DEFAULT uuid()'])
    expect(kinds("char(3) DEFAULT _utf8mb4'abc'")[1]).toEqual(['default', "DEFAULT _utf8mb4'abc'"])
    expect(kinds("bit(1) DEFAULT b'1'")[1]).toEqual(['default', "DEFAULT b'1'"])
    expect(kinds('int DEFAULT NULL /*!80023 INVISIBLE */')).toEqual([
      ['type', 'int'],
      ['default', 'DEFAULT NULL'],
      ['other', '/*!80023 INVISIBLE */']
    ])
    expect(kinds('int(11) INVISIBLE DEFAULT NULL', 'mariadb')).toEqual([
      ['type', 'int(11)'],
      ['other', 'INVISIBLE'],
      ['default', 'DEFAULT NULL']
    ])
  })

  it('keeps generated columns, inline CHECKs, unsigned and enum types', () => {
    const generated = parse('int GENERATED ALWAYS AS ((`price` * 2)) STORED')
    expect(isMysqlGenerated(generated)).toBe(true)
    expect(generated.clauses[1]).toEqual({
      kind: 'generated',
      text: 'GENERATED ALWAYS AS ((`price` * 2)) STORED'
    })
    expect(
      kinds(
        'longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`attributes`))',
        'mariadb'
      )
    ).toEqual([
      ['type', 'longtext'],
      ['charset', 'CHARACTER SET utf8mb4'],
      ['collate', 'COLLATE utf8mb4_bin'],
      ['default', 'DEFAULT NULL'],
      ['other', 'CHECK (json_valid(`attributes`))']
    ])
    expect(mysqlTypeOf(parse('int unsigned NOT NULL AUTO_INCREMENT'))).toBe('int unsigned')
    expect(mysqlTypeOf(parse("enum('a','b,c') DEFAULT 'a'"))).toBe("enum('a','b,c')")
    expect(mysqlDefaultExpression(parse("enum('a','b,c') DEFAULT 'a'"))).toBe("'a'")
    expect(mysqlDefaultExpression(parse('int NOT NULL'))).toBe('')
  })

  it('refuses text that is not one column definition', () => {
    expect(parseMysqlColumnDefinition("varchar(10) DEFAULT 'x", 'mysql')).toBeNull()
    expect(parseMysqlColumnDefinition('int, `b` int', 'mysql')).toBeNull()
    expect(parseMysqlColumnDefinition('NOT NULL', 'mysql')).toBeNull()
    expect(parseMysqlColumnDefinition('int DEFAULT', 'mysql')).toBeNull()
  })
})

describe('buildMysqlColumnDefinition', () => {
  const ts = parse(
    "timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'when'"
  )
  const opts = { mariadb: false }

  it('changes only the edited clauses', () => {
    expect(buildMysqlColumnDefinition(ts, { type: 'datetime(3)' }, opts)).toBe(
      "datetime(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'when'"
    )
    expect(buildMysqlColumnDefinition(ts, { nullable: false }, opts)).toBe(
      "timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'when'"
    )
    expect(buildMysqlColumnDefinition(ts, { defaultExpr: '' }, opts)).toBe(
      "timestamp(3) NULL ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'when'"
    )
    expect(buildMysqlColumnDefinition(ts, { commentLiteral: '' }, opts)).toBe(
      'timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'
    )
  })

  it('inserts missing clauses in MySQL order and keeps unknown ones in place', () => {
    const inv = parse('int DEFAULT NULL /*!80023 INVISIBLE */')
    expect(buildMysqlColumnDefinition(inv, { nullable: true, commentLiteral: "'n'" }, opts)).toBe(
      "int NULL DEFAULT NULL COMMENT 'n' /*!80023 INVISIBLE */"
    )
    const bare = parse('int')
    expect(buildMysqlColumnDefinition(bare, { defaultExpr: '0', nullable: false }, opts)).toBe(
      'int NOT NULL DEFAULT 0'
    )
  })

  it('drops DEFAULT NULL when the column becomes NOT NULL, unless a default is given', () => {
    const def = parse("varchar(20) DEFAULT NULL COMMENT 'x'")
    expect(buildMysqlColumnDefinition(def, { nullable: false }, opts)).toBe(
      "varchar(20) NOT NULL COMMENT 'x'"
    )
    expect(buildMysqlColumnDefinition(def, { nullable: false, defaultExpr: "''" }, opts)).toBe(
      "varchar(20) NOT NULL DEFAULT '' COMMENT 'x'"
    )
  })

  it('drops CHARACTER SET / COLLATE for a non-text type (MariaDB JSON keeps them)', () => {
    const def = parse('varchar(50) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL')
    expect(buildMysqlColumnDefinition(def, { type: 'int' }, opts)).toBe('int NOT NULL')
    expect(buildMysqlColumnDefinition(def, { type: 'text' }, opts)).toBe(
      'text CHARACTER SET latin1 COLLATE latin1_bin NOT NULL'
    )
    const json = parse('longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL', 'mariadb')
    expect(buildMysqlColumnDefinition(json, { type: 'json' }, { mariadb: true })).toBe(
      'json CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL'
    )
  })
})

describe('restateMysqlLiterals (NO_BACKSLASH_ESCAPES)', () => {
  it('rewrites backslash-escaped literals into the plain form', () => {
    // SHOW CREATE TABLE prints C:\tmp as 'C:\\tmp' and a\b'c as 'a\\b''c' in every session.
    expect(
      restateMysqlLiterals("varchar(20) DEFAULT 'C:\\\\tmp' COMMENT 'a\\\\b''c'", 'mysql')
    ).toBe("varchar(20) DEFAULT 'C:\\tmp' COMMENT 'a\\b''c'")
    expect(restateMysqlLiterals("text DEFAULT 'it\\'s' COMMENT 'two\\nlines'", 'mariadb')).toBe(
      "text DEFAULT 'it''s' COMMENT 'two\nlines'"
    )
    // LIKE wildcards keep their backslash; an introducer stays.
    expect(restateMysqlLiterals("char(4) DEFAULT _utf8mb4'5\\%'", 'mysql')).toBe(
      "char(4) DEFAULT _utf8mb4'5\\%'"
    )
  })

  it('leaves literals without a backslash, bit and hex literals alone', () => {
    const text = "bit(1) DEFAULT b'1' COMMENT 'it''s'"
    expect(restateMysqlLiterals(text, 'mysql')).toBe(text)
    expect(restateMysqlLiterals("varbinary(2) DEFAULT X'5C5C'", 'mysql')).toBe(
      "varbinary(2) DEFAULT X'5C5C'"
    )
  })

  it('refuses a NUL or Ctrl-Z, which the plain form cannot write', () => {
    expect(restateMysqlLiterals("varchar(5) DEFAULT 'a\\0b'", 'mysql')).toBeNull()
    expect(restateMysqlLiterals("varchar(5) DEFAULT 'a\\Zb'", 'mysql')).toBeNull()
  })

  it('the restated text parses in that mode', () => {
    const text = restateMysqlLiterals("varchar(20) DEFAULT 'C:\\\\' COMMENT 'x'", 'mysql')!
    expect(text).toBe("varchar(20) DEFAULT 'C:\\' COMMENT 'x'")
    const def = parseMysqlColumnDefinition(text, 'mysql', { backslashEscapes: false })!
    expect(mysqlDefaultExpression(def)).toBe("'C:\\'")
    expect(parseMysqlColumnDefinition(text, 'mysql')).toBeNull()
  })
})

describe('renameColumnReferences / CHANGE COLUMN of a MariaDB inline CHECK', () => {
  it('renames quoted and bare references, not functions, strings or other columns', () => {
    expect(
      renameColumnReferences(
        "CHECK (json_valid(`j`) and J <> 'j' and `jj` > 0 and j(1))",
        'j',
        'j2',
        'mariadb'
      )
    ).toBe("CHECK (json_valid(`j2`) and `j2` <> 'j' and `jj` > 0 and j(1))")
  })

  it('buildMysqlColumnDefinition restates the CHECK under the new name', () => {
    const def = parse(
      'longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`j`))',
      'mariadb'
    )
    expect(
      buildMysqlColumnDefinition(
        def,
        { commentLiteral: "'doc'", rename: { from: 'j', to: 'j2' } },
        { mariadb: true }
      )
    ).toBe(
      "longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'doc' CHECK (json_valid(`j2`))"
    )
  })
})
