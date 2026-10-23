import { describe, expect, it } from 'vitest'

import type { SqlDialect } from '../data-projects/types'
import { lexSql } from './lexer'

// Compact view of the code tokens: `type:text`, whitespace dropped.
const code = (text: string, dialect: SqlDialect, backslashEscapes?: boolean): string[] =>
  lexSql(text, dialect, backslashEscapes === undefined ? {} : { backslashEscapes })
    .tokens.filter((t) => t.type !== 'whitespace')
    .map((t) => `${t.type}:${t.text}`)

describe('lexSql: comments per dialect', () => {
  const cases: Array<[SqlDialect, string, string[]]> = [
    [
      'mysql',
      'SELECT 1--1',
      ['keyword:SELECT', 'number:1', 'operator:-', 'operator:-', 'number:1']
    ],
    [
      'mysql',
      'SELECT 1--c',
      ['keyword:SELECT', 'number:1', 'operator:-', 'operator:-', 'identifier:c']
    ],
    ['mysql', 'SELECT 1 -- c', ['keyword:SELECT', 'number:1', 'comment:-- c']],
    ['mysql', 'SELECT 1 --\tc', ['keyword:SELECT', 'number:1', 'comment:--\tc']],
    ['mysql', 'SELECT 1 --', ['keyword:SELECT', 'number:1', 'comment:--']],
    ['postgres', 'SELECT 1--c', ['keyword:SELECT', 'number:1', 'comment:--c']],
    ['sqlite', 'SELECT 1--c', ['keyword:SELECT', 'number:1', 'comment:--c']],
    ['clickhouse', 'SELECT 1--c', ['keyword:SELECT', 'number:1', 'comment:--c']],
    [
      'mysql',
      'SELECT 1 # c\nSELECT 2',
      ['keyword:SELECT', 'number:1', 'comment:# c', 'keyword:SELECT', 'number:2']
    ],
    ['mariadb', 'SELECT 1 #c', ['keyword:SELECT', 'number:1', 'comment:#c']],
    ['postgres', 'SELECT a # b', ['keyword:SELECT', 'identifier:a', 'operator:#', 'identifier:b']],
    ['clickhouse', 'SELECT 1 # c', ['keyword:SELECT', 'number:1', 'comment:# c']],
    [
      'clickhouse',
      '#!/usr/bin/clickhouse\nSELECT 1',
      ['comment:#!/usr/bin/clickhouse', 'keyword:SELECT', 'number:1']
    ],
    [
      'postgres',
      'SELECT /* a /* b */ c */ 1',
      ['keyword:SELECT', 'comment:/* a /* b */ c */', 'number:1']
    ],
    ['mysql', 'SELECT /* a /* b */ 1', ['keyword:SELECT', 'comment:/* a /* b */', 'number:1']],
    ['sqlite', 'SELECT /* x */ 1', ['keyword:SELECT', 'comment:/* x */', 'number:1']],
    ['mysql', 'SELECT /*+ BKA(t) */ 1', ['keyword:SELECT', 'comment:/*+ BKA(t) */', 'number:1']]
  ]
  it.each(cases)('%s %j', (dialect, text, expected) => {
    expect(code(text, dialect)).toEqual(expected)
  })
})

describe('lexSql: MySQL/MariaDB executable comments are code', () => {
  it('exposes the contents of /*! … */ between executable_comment wrappers', () => {
    expect(code('SELECT 1 /*! , (DROP TABLE t) */', 'mysql')).toEqual([
      'keyword:SELECT',
      'number:1',
      'executable_comment:/*!',
      'punctuation:,',
      'punctuation:(',
      'keyword:DROP',
      'keyword:TABLE',
      'identifier:t',
      'punctuation:)',
      'executable_comment:*/'
    ])
  })
  it('keeps the version number in the opener', () => {
    expect(code('/*!50700 SET x=1 */', 'mysql').slice(0, 2)).toEqual([
      'executable_comment:/*!50700',
      'keyword:SET'
    ])
  })
  it('recognises MariaDB /*M! … */', () => {
    expect(code('/*M!100100 DROP TABLE t */', 'mariadb')).toEqual([
      'executable_comment:/*M!100100',
      'keyword:DROP',
      'keyword:TABLE',
      'identifier:t',
      'executable_comment:*/'
    ])
  })
  it('is a plain comment in PostgreSQL', () => {
    expect(code('SELECT /*! DROP */ 1', 'postgres')).toEqual([
      'keyword:SELECT',
      'comment:/*! DROP */',
      'number:1'
    ])
  })
  it('reports an unterminated executable comment', () => {
    const r = lexSql('SELECT 1 /*! DROP TABLE t', 'mysql')
    expect(r.error).toEqual({ message: 'Unterminated executable comment', offset: 9 })
  })
})

describe('lexSql: strings and escapes', () => {
  const cases: Array<[SqlDialect, string, string[], boolean?]> = [
    ['mysql', "'a\\'b'", ["string:'a\\'b'"]],
    // NO_BACKSLASH_ESCAPES: the string ends at the escaped quote; `b'` opens a bit literal.
    ['mysql', "'a\\'b'", ["string:'a\\'", "string:b'"], false],
    ['mysql', "'it''s'", ["string:'it''s'"]],
    ['mysql', '"double" x', ['string:"double"', 'identifier:x']],
    ['mysql', "X'ff' B'01' N'n'", ["string:X'ff'", "string:B'01'", "string:N'n'"]],
    ['postgres', "'a\\' x", ["string:'a\\'", 'identifier:x']],
    ['postgres', "E'a\\'b'", ["string:E'a\\'b'"]],
    ['postgres', "e'x'", ["string:e'x'"]],
    ['postgres', "U&'d\\0061t'", ["string:U&'d\\0061t'"]],
    ['postgres', 'U&"d\\0061t"', ['quoted_identifier:U&"d\\0061t"']],
    ['postgres', "B'0101' X'1F'", ["string:B'0101'", "string:X'1F'"]],
    ['postgres', '$$a;b$$', ['string:$$a;b$$']],
    ['postgres', '$body$ x $$ y $body$', ['string:$body$ x $$ y $body$']],
    [
      'postgres',
      'SELECT $1, $23',
      ['keyword:SELECT', 'parameter:$1', 'punctuation:,', 'parameter:$23']
    ],
    ['postgres', 'a$b$ c', ['identifier:a$b$', 'identifier:c']],
    ['sqlite', "'a\\' x", ["string:'a\\'", 'identifier:x']],
    ['sqlite', "X'00ff'", ["string:X'00ff'"]],
    ['clickhouse', "'a\\'b'", ["string:'a\\'b'"]],
    ['clickhouse', '$heredoc$x;y$heredoc$', ['string:$heredoc$x;y$heredoc$']],
    ['mysql', "_utf8mb4'x'", ['identifier:_utf8mb4', "string:'x'"]]
  ]
  it.each(cases)('%s %j', (dialect, text, expected, backslash) => {
    expect(code(text, dialect, backslash)).toEqual(expected)
  })
  it('standard_conforming_strings=off makes PG read backslashes', () => {
    expect(code("'a\\'b'", 'postgres', true)).toEqual(["string:'a\\'b'"])
  })
})

describe('lexSql: identifiers', () => {
  const cases: Array<[SqlDialect, string, string[]]> = [
    ['mysql', '`a``b`.c', ['quoted_identifier:`a``b`', 'punctuation:.', 'identifier:c']],
    ['postgres', '"Weird ""Name"""', ['quoted_identifier:"Weird ""Name"""']],
    [
      'sqlite',
      '[a;b] "c" `d`',
      ['quoted_identifier:[a;b]', 'quoted_identifier:"c"', 'quoted_identifier:`d`']
    ],
    ['postgres', 'a[1]', ['identifier:a', 'punctuation:[', 'number:1', 'punctuation:]']],
    ['clickhouse', '`a\\`b` "c"', ['quoted_identifier:`a\\`b`', 'quoted_identifier:"c"']],
    [
      'mysql',
      '1abc 1e5 0x1F 0b101 .5 1.5e-3',
      ['identifier:1abc', 'number:1e5', 'number:0x1F', 'number:0b101', 'number:.5', 'number:1.5e-3']
    ],
    ['postgres', '1_000_000', ['number:1_000_000']],
    ['postgres', 'naïve', ['identifier:naïve']],
    ['mysql', '$abc', ['identifier:$abc']]
  ]
  it.each(cases)('%s %j', (dialect, text, expected) => {
    expect(code(text, dialect)).toEqual(expected)
  })
  it('upper-cases bare words', () => {
    const t = lexSql('select Foo', 'postgres').tokens
    expect(t.map((x) => x.upper)).toEqual(['SELECT', undefined, 'FOO'])
    expect(t[0]?.type).toBe('keyword')
    expect(t[2]?.type).toBe('identifier')
  })
})

describe('lexSql: parameters and variables', () => {
  const cases: Array<[SqlDialect, string, string[]]> = [
    [
      'mysql',
      '? @x @@global.sql_mode @`q`',
      ['parameter:?', 'variable:@x', 'variable:@@global.sql_mode', 'variable:@`q`']
    ],
    ['mariadb', "@'v'", ["variable:@'v'"]],
    [
      'postgres',
      "a ? 'k' AND b @> c",
      [
        'identifier:a',
        'operator:?',
        "string:'k'",
        'keyword:AND',
        'identifier:b',
        'operator:@>',
        'identifier:c'
      ]
    ],
    ['postgres', 'x::int', ['identifier:x', 'operator:::', 'keyword:int']],
    ['postgres', 'a=-1', ['identifier:a', 'operator:=', 'operator:-', 'number:1']],
    ['postgres', "j #>> '{a}'", ['identifier:j', 'operator:#>>', "string:'{a}'"]],
    [
      'sqlite',
      '? ?12 :name @n $v',
      ['parameter:?', 'parameter:?12', 'parameter::name', 'parameter:@n', 'parameter:$v']
    ],
    [
      'clickhouse',
      '{id:UInt32} {s: Nullable(String)}',
      ['parameter:{id:UInt32}', 'parameter:{s: Nullable(String)}']
    ],
    [
      'clickhouse',
      'cond ? a : b',
      ['identifier:cond', 'operator:?', 'identifier:a', 'operator::', 'identifier:b']
    ],
    [
      'clickhouse',
      'x -> x + 1',
      ['identifier:x', 'operator:->', 'identifier:x', 'operator:+', 'number:1']
    ],
    [
      'mysql',
      'a <=> b := c',
      ['identifier:a', 'operator:<=>', 'identifier:b', 'operator::=', 'identifier:c']
    ]
  ]
  it.each(cases)('%s %j', (dialect, text, expected) => {
    expect(code(text, dialect)).toEqual(expected)
  })
})

describe('lexSql: MySQL DELIMITER', () => {
  it('turns the directive into one delimiter token and splits END$$', () => {
    expect(code('DELIMITER $$\nSELECT 1; END$$\nDELIMITER ;\nSELECT 2;', 'mysql')).toEqual([
      'delimiter:DELIMITER $$',
      'keyword:SELECT',
      'number:1',
      'punctuation:;',
      'keyword:END',
      'delimiter:$$',
      'delimiter:DELIMITER ;',
      'keyword:SELECT',
      'number:2',
      'delimiter:;'
    ])
  })
  it('marks the directive with upper DELIMITER', () => {
    const t = lexSql('delimiter //\nSELECT 1//', 'mariadb').tokens
    expect(t[0]).toMatchObject({ type: 'delimiter', upper: 'DELIMITER', text: 'delimiter //' })
    expect(t.at(-1)).toMatchObject({ type: 'delimiter', text: '//' })
    expect(t.at(-1)?.upper).toBeUndefined()
  })
  it('only recognises DELIMITER at the start of a statement', () => {
    expect(code('SELECT delimiter FROM t', 'mysql')).toEqual([
      'keyword:SELECT',
      'keyword:delimiter',
      'keyword:FROM',
      'identifier:t'
    ])
  })
  it('is not a directive in PostgreSQL', () => {
    expect(code('DELIMITER $$', 'postgres')[0]).toBe('keyword:DELIMITER')
  })
  it('keeps a CRLF line ending out of the directive', () => {
    const t = lexSql('DELIMITER ;;\r\nSELECT 1;;', 'mysql').tokens
    expect(t[0]?.text).toBe('DELIMITER ;;')
    expect(t.at(-1)?.text).toBe(';;')
  })
})

describe('lexSql: errors and invariants', () => {
  const errors: Array<[SqlDialect, string, string, number]> = [
    ['postgres', "SELECT 'abc", 'Unterminated string literal', 7],
    ['postgres', 'SELECT "abc', 'Unterminated quoted identifier', 7],
    ['postgres', 'SELECT /* a /* b */', 'Unterminated comment', 7],
    ['postgres', 'SELECT $x$ abc', 'Unterminated dollar-quoted string', 7],
    ['mysql', 'SELECT `abc', 'Unterminated quoted identifier', 7],
    ['sqlite', 'SELECT [abc', 'Unterminated quoted identifier', 7],
    ['mysql', "SELECT 'a\\'", 'Unterminated string literal', 7]
  ]
  it.each(errors)('%s %j → %s at %i', (dialect, text, message, offset) => {
    const r = lexSql(text, dialect)
    expect(r.error).toEqual({ message, offset })
    expect(r.tokens.at(-1)?.end).toBe(text.length)
  })

  const corpus = [
    'SELECT a, \'x;y\' AS "q" FROM t WHERE b = $1 -- c\n/* d */;',
    'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;',
    "INSERT INTO `t` VALUES (1, 'a\\'b', X'ff', @v, ?);",
    'SELECT {p:String}, `x` FROM t # hash\n',
    "SELECT * FROM [t] WHERE a = :a AND b = @b AND c = $c AND d = ?1 AND e = 'é';",
    'SELECT 1 /*! , 2 */ /* unterminated',
    '\u{1F600} weird ⌘ input \\ ` ~'
  ]
  it.each(corpus)('tokens cover %j contiguously in every dialect', (text) => {
    for (const dialect of ['mysql', 'mariadb', 'postgres', 'sqlite', 'clickhouse'] as const) {
      const { tokens } = lexSql(text, dialect)
      let at = 0
      for (const t of tokens) {
        expect(t.start).toBe(at)
        expect(t.text).toBe(text.slice(t.start, t.end))
        at = t.end
      }
      expect(at).toBe(text.length)
    }
  })

  it('lexes an empty string to nothing', () => {
    expect(lexSql('', 'postgres')).toEqual({ tokens: [] })
  })
})

describe('lexSql: linear on pathological runs', () => {
  it('lexes long + / - runs and unmatched braces in linear time', () => {
    const cases: Array<[string, SqlDialect]> = [
      ['SELECT 1 ' + '+-'.repeat(100_000), 'postgres'],
      ['{'.repeat(200_000), 'clickhouse']
    ]
    for (const [text, dialect] of cases) {
      const started = performance.now()
      lexSql(text, dialect)
      expect(performance.now() - started).toBeLessThan(1_000)
    }
  })

  it('keeps PostgreSQL operator splitting for + / - runs', () => {
    const ops = lexSql('SELECT a <-+-1, b =-1, c @-1', 'postgres')
      .tokens.filter((t) => t.type === 'operator')
      .map((t) => t.text)
    expect(ops).toEqual(['<', '-', '+', '-', '=', '-', '@-'])
  })
})
