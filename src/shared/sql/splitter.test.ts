import { describe, expect, it } from 'vitest'

import type { SqlDialect } from '../data-projects/types'
import {
  splitSqlStatements,
  splitSqlStatementsWithTerminators,
  statementAtOffset
} from './splitter'

const texts = (text: string, dialect: SqlDialect): string[] =>
  splitSqlStatements(text, dialect).map((s) => s.text)

describe('splitSqlStatements', () => {
  const cases: Array<[string, SqlDialect, string, string[]]> = [
    ['basic', 'postgres', 'SELECT 1; SELECT 2;', ['SELECT 1', 'SELECT 2']],
    ['no trailing delimiter', 'postgres', 'SELECT 1;\nSELECT 2', ['SELECT 1', 'SELECT 2']],
    ['empty statements skipped', 'mysql', ';;  ;\nSELECT 1;;\n;', ['SELECT 1']],
    ['comment-only statements skipped', 'postgres', '-- a\n;/* b */;SELECT 1', ['SELECT 1']],
    ['leading/trailing comments trimmed', 'postgres', '-- head\nSELECT 1 -- tail\n;', ['SELECT 1']],
    ['inner comments kept', 'postgres', 'SELECT /* x; */ 1;', ['SELECT /* x; */ 1']],
    ['strings with ;', 'postgres', "SELECT 'a;b'; SELECT 2", ["SELECT 'a;b'", 'SELECT 2']],
    [
      'mysql backslash string',
      'mysql',
      "SELECT 'a\\';b'; SELECT 2",
      ["SELECT 'a\\';b'", 'SELECT 2']
    ],
    ['mysql # comment with ;', 'mysql', 'SELECT 1 # x; y\n; SELECT 2', ['SELECT 1', 'SELECT 2']],
    ['mysql -- needs a space', 'mysql', 'SELECT 1--1;SELECT 2', ['SELECT 1--1', 'SELECT 2']],
    [
      'pg dollar body',
      'postgres',
      'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT f()',
      [
        'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql',
        'SELECT f()'
      ]
    ],
    [
      'pg tagged dollar body',
      'postgres',
      'DO $do$ BEGIN PERFORM 1; END $do$; SELECT 1',
      ['DO $do$ BEGIN PERFORM 1; END $do$', 'SELECT 1']
    ],
    [
      'pg nested comment',
      'postgres',
      'SELECT /* a /* ; */ ; */ 1; SELECT 2',
      ['SELECT /* a /* ; */ ; */ 1', 'SELECT 2']
    ],
    ['pg E string', 'postgres', "SELECT E'a\\';b'; SELECT 2", ["SELECT E'a\\';b'", 'SELECT 2']],
    [
      'sqlite bracket identifier',
      'sqlite',
      'SELECT [a;b] FROM t; SELECT 2',
      ['SELECT [a;b] FROM t', 'SELECT 2']
    ],
    [
      'clickhouse heredoc',
      'clickhouse',
      "SELECT $h$x;y$h$; SELECT 'a\\';'",
      ['SELECT $h$x;y$h$', "SELECT 'a\\';'"]
    ],
    [
      'pg plain BEGIN is a transaction',
      'postgres',
      'BEGIN; UPDATE t SET a = 1; COMMIT;',
      ['BEGIN', 'UPDATE t SET a = 1', 'COMMIT']
    ],
    [
      'mysql BEGIN WORK',
      'mysql',
      'BEGIN WORK; SELECT 1; COMMIT',
      ['BEGIN WORK', 'SELECT 1', 'COMMIT']
    ],
    [
      'executable comment keeps its ;',
      'mysql',
      'SELECT 1 /*! ; DROP TABLE t */; SELECT 2',
      ['SELECT 1 /*! ; DROP TABLE t */', 'SELECT 2']
    ],
    [
      'mysqldump header',
      'mysql',
      '/*!40101 SET @OLD=@@X */;\n/*!40014 SET UNIQUE_CHECKS=0 */;',
      ['/*!40101 SET @OLD=@@X */', '/*!40014 SET UNIQUE_CHECKS=0 */']
    ]
  ]
  it.each(cases)('%s', (_name, dialect, text, expected) => {
    expect(texts(text, dialect)).toEqual(expected)
  })

  it('maps offsets exactly back to the source', () => {
    const text = '  -- c\n SELECT 1 ;\n\n/* x */ INSERT INTO t VALUES (1)  ;  '
    for (const s of splitSqlStatements(text, 'postgres')) {
      expect(text.slice(s.start, s.end)).toBe(s.text)
    }
    expect(splitSqlStatements(text, 'postgres')).toEqual([
      { text: 'SELECT 1', start: 8, end: 16 },
      { text: 'INSERT INTO t VALUES (1)', start: 28, end: 52 }
    ])
  })

  it('returns nothing for empty or comment-only text', () => {
    expect(splitSqlStatements('', 'mysql')).toEqual([])
    expect(splitSqlStatements('  \n -- x\n /* y */ ;', 'postgres')).toEqual([])
  })

  it('keeps an unterminated string in the last statement', () => {
    expect(texts("SELECT 1; SELECT 'abc; DROP", 'postgres')).toEqual([
      'SELECT 1',
      "SELECT 'abc; DROP"
    ])
  })

  it('reports where each terminator ends', () => {
    expect(splitSqlStatementsWithTerminators('SELECT 1 ;  SELECT 2', 'postgres')).toEqual([
      { text: 'SELECT 1', start: 0, end: 8, terminatorEnd: 10 },
      { text: 'SELECT 2', start: 12, end: 20, terminatorEnd: 20 }
    ])
  })
})

describe('splitSqlStatements: routine bodies and DELIMITER', () => {
  it('honours MySQL DELIMITER and never includes the directive', () => {
    const text = [
      'DELIMITER $$',
      'CREATE PROCEDURE p()',
      'BEGIN',
      '  SELECT 1;',
      '  SELECT 2;',
      'END$$',
      'DELIMITER ;',
      'CALL p();'
    ].join('\n')
    expect(texts(text, 'mysql')).toEqual([
      'CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND',
      'CALL p()'
    ])
  })

  it('handles the mysqldump trigger form with ;;', () => {
    const text =
      'DELIMITER ;;\n/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END */;;\nDELIMITER ;\nSELECT 1;'
    expect(texts(text, 'mysql')).toEqual([
      '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END */',
      'SELECT 1'
    ])
  })

  const cases: Array<[string, SqlDialect, string, string[]]> = [
    [
      'MySQL procedure without DELIMITER',
      'mysql',
      'CREATE PROCEDURE p() BEGIN IF x THEN SELECT 1; END IF; WHILE y DO SET y = 0; END WHILE; END; SELECT 3',
      [
        'CREATE PROCEDURE p() BEGIN IF x THEN SELECT 1; END IF; WHILE y DO SET y = 0; END WHILE; END',
        'SELECT 3'
      ]
    ],
    [
      'MySQL CASE statement and nested BEGIN',
      'mysql',
      'CREATE DEFINER=`a`@`%` PROCEDURE p() BEGIN CASE v WHEN 1 THEN BEGIN SELECT 1; END; END CASE; END; SELECT 2',
      [
        'CREATE DEFINER=`a`@`%` PROCEDURE p() BEGIN CASE v WHEN 1 THEN BEGIN SELECT 1; END; END CASE; END',
        'SELECT 2'
      ]
    ],
    [
      'MySQL labelled loop and REPEAT',
      'mysql',
      'CREATE FUNCTION f() RETURNS INT BEGIN l: LOOP LEAVE l; END LOOP l; REPEAT SET x = 1; UNTIL x END REPEAT; RETURN 1; END; SELECT f()',
      [
        'CREATE FUNCTION f() RETURNS INT BEGIN l: LOOP LEAVE l; END LOOP l; REPEAT SET x = 1; UNTIL x END REPEAT; RETURN 1; END',
        'SELECT f()'
      ]
    ],
    [
      'MySQL event',
      'mysql',
      'CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM t; END; SELECT 1',
      ['CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM t; END', 'SELECT 1']
    ],
    [
      'MySQL trigger without a body',
      'mysql',
      'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET NEW.a = 1; SELECT 1',
      ['CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET NEW.a = 1', 'SELECT 1']
    ],
    [
      'SQLite trigger with CASE, then a transaction',
      'sqlite',
      'CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON x BEGIN UPDATE y SET a = CASE WHEN 1 THEN 2 END; INSERT INTO z VALUES (1); END; BEGIN; SELECT 1; END;',
      [
        'CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON x BEGIN UPDATE y SET a = CASE WHEN 1 THEN 2 END; INSERT INTO z VALUES (1); END',
        'BEGIN',
        'SELECT 1',
        'END'
      ]
    ],
    [
      'SQLite temp trigger',
      'sqlite',
      'CREATE TEMP TRIGGER t DELETE ON x BEGIN SELECT 1; END; SELECT 2',
      ['CREATE TEMP TRIGGER t DELETE ON x BEGIN SELECT 1; END', 'SELECT 2']
    ],
    [
      'MariaDB anonymous block',
      'mariadb',
      'BEGIN NOT ATOMIC SELECT 1; SELECT 2; END; SELECT 3',
      ['BEGIN NOT ATOMIC SELECT 1; SELECT 2; END', 'SELECT 3']
    ],
    [
      'PG BEGIN ATOMIC function body',
      'postgres',
      'CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT 3',
      [
        'CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END',
        'SELECT 3'
      ]
    ],
    [
      'a table named like a routine keyword is not a routine',
      'mysql',
      'CREATE TABLE function (begin int); SELECT 1',
      ['CREATE TABLE function (begin int)', 'SELECT 1']
    ],
    [
      'ClickHouse has no block bodies',
      'clickhouse',
      'CREATE FUNCTION f AS (x) -> x + 1; SELECT f(1)',
      ['CREATE FUNCTION f AS (x) -> x + 1', 'SELECT f(1)']
    ]
  ]
  it.each(cases)('%s', (_name, dialect, text, expected) => {
    expect(texts(text, dialect)).toEqual(expected)
  })
})

describe('statementAtOffset', () => {
  //            0         1         2         3         4
  //            0123456789012345678901234567890123456789012345
  const doc = 'SELECT 1;  -- x\n\nSELECT 2;\n-- about 3\nSELECT 3\n\n'
  const cases: Array<[string, number, string | null]> = [
    ['start of the first statement', 0, 'SELECT 1'],
    ['inside a statement', 4, 'SELECT 1'],
    ['right after the ;', 9, 'SELECT 1'],
    ['trailing whitespace on the same line', 10, 'SELECT 1'],
    ['inside a trailing comment on the same line', 13, 'SELECT 1'],
    ['end of that line', 15, 'SELECT 1'],
    ['blank line between statements → previous', 16, 'SELECT 1'],
    ['start of the second statement', 17, 'SELECT 2'],
    ['after the second ;', 26, 'SELECT 2'],
    ['comment line directly above a statement → that statement', 30, 'SELECT 3'],
    ['end of the last statement', 46, 'SELECT 3'],
    ['blank lines after the last statement → last', 48, 'SELECT 3'],
    ['offset past the end is clamped', 999, 'SELECT 3'],
    ['negative offset is clamped', -5, 'SELECT 1']
  ]
  it.each(cases)('%s (%i)', (_name, offset, expected) => {
    expect(statementAtOffset(doc, offset, 'postgres')?.text ?? null).toBe(expected)
  })

  it('returns null for empty or comment-only text', () => {
    expect(statementAtOffset('', 0, 'mysql')).toBeNull()
    expect(statementAtOffset('-- nothing\n', 3, 'mysql')).toBeNull()
  })

  it('picks the first statement when the cursor is in leading comments', () => {
    expect(statementAtOffset('-- intro\n\nSELECT 1;', 2, 'sqlite')?.text).toBe('SELECT 1')
  })

  it('picks the next statement from its indentation', () => {
    const text = 'SELECT 1;\n    SELECT 2;'
    expect(statementAtOffset(text, 12, 'postgres')?.text).toBe('SELECT 2')
  })

  it('treats a comment block separated by a blank line as belonging to the previous statement', () => {
    const text = 'SELECT 1;\n-- note about 1\n\nSELECT 2;'
    expect(statementAtOffset(text, 13, 'postgres')?.text).toBe('SELECT 1')
  })

  it('works inside a multi-line routine body', () => {
    const text = 'SELECT 0;\nCREATE PROCEDURE p() BEGIN\n  SELECT 1;\n  SELECT 2;\nEND;\nSELECT 3;'
    const at = text.indexOf('SELECT 2')
    expect(statementAtOffset(text, at, 'mysql')?.text).toBe(
      'CREATE PROCEDURE p() BEGIN\n  SELECT 1;\n  SELECT 2;\nEND'
    )
  })

  it('returns spans that slice the source', () => {
    const text = 'select a from t;\n\n  update t set a = 1 where b = 2 ;'
    const span = statementAtOffset(text, text.length, 'mysql')
    expect(span).toEqual({ text: 'update t set a = 1 where b = 2', start: 20, end: 50 })
  })
})
