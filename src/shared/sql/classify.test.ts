import { describe, expect, it } from 'vitest'

import type { DataStatementClass, SqlDialect } from '../data-projects/types'
import { analyzeSqlStatement, classifySqlStatement } from './classify'

// The safety gate's verdict per statement. Every row here is a promise to the user: a 'read'
// may run without asking in half-safe mode, so false reads are bugs; extra confirmations are
// merely annoying. When in doubt the classifier must say 'unknown'.
const cls = (sql: string, dialect: SqlDialect): DataStatementClass =>
  classifySqlStatement(sql, dialect).classification

describe('classifySqlStatement: reads', () => {
  const cases: Array<[SqlDialect, string]> = [
    ['postgres', 'SELECT * FROM t'],
    ['postgres', 'select a, b from public.t where x = 1 order by a limit 10'],
    ['postgres', '(SELECT 1)'],
    ['postgres', '((SELECT 1) UNION (SELECT 2))'],
    ['postgres', 'VALUES (1, 2), (3, 4)'],
    ['postgres', 'TABLE orders'],
    ['postgres', 'WITH x AS (SELECT 1) SELECT * FROM x'],
    [
      'postgres',
      'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT * FROM r'
    ],
    [
      'postgres',
      'WITH x AS MATERIALIZED (SELECT 1), y AS NOT MATERIALIZED (SELECT 2) SELECT * FROM x, y'
    ],
    ['postgres', 'SHOW search_path'],
    ['postgres', 'EXPLAIN SELECT * FROM t'],
    ['postgres', 'EXPLAIN (FORMAT JSON) SELECT * FROM t'],
    ['postgres', 'EXPLAIN (ANALYZE false, BUFFERS) DELETE FROM t'],
    ['postgres', 'EXPLAIN (ANALYZE off) UPDATE t SET a = 1'],
    ['postgres', 'EXPLAIN DELETE FROM t'],
    ['postgres', 'EXPLAIN ANALYZE SELECT * FROM t'],
    ['postgres', "SELECT data->>'a', data ? 'k', tags @> ARRAY['x'] FROM t"],
    ['postgres', 'SELECT $1::int + $2'],
    ['postgres', "SELECT * FROM t WHERE note = 'DELETE FROM t; DROP TABLE x'"],
    ['postgres', 'SELECT 1 AS delete, 2 AS update'],
    ['postgres', 'SELECT t.update, t.insert FROM t'],
    ['postgres', "SELECT replace(name, 'a', 'b') FROM t"],
    ['postgres', 'SELECT * FROM t /* DROP TABLE t */'],
    ['postgres', 'SELECT format_type(atttypid, atttypmod) FROM pg_attribute'],
    ['postgres', 'DECLARE c CURSOR FOR SELECT * FROM t'],
    ['postgres', 'FETCH 10 FROM c'],
    ['postgres', 'COPY t TO STDOUT'],
    ['postgres', 'COPY (SELECT * FROM t) TO STDOUT WITH CSV'],
    ['mysql', 'SELECT * FROM `t` WHERE a = ? LIMIT 5'],
    ['mysql', "SELECT REPLACE(a, 'x', 'y'), INSERT(a, 1, 1, 'z'), TRUNCATE(1.55, 1) FROM t"],
    ['mysql', 'SHOW CREATE TABLE t'],
    ['mysql', 'SHOW GRANTS FOR CURRENT_USER'],
    ['mysql', 'SHOW FULL PROCESSLIST'],
    ['mysql', 'DESCRIBE t'],
    ['mysql', 'DESC t'],
    ['mysql', 'DESCRIBE SELECT * FROM t'],
    ['mysql', 'EXPLAIN FORMAT=JSON SELECT * FROM t'],
    ['mysql', 'EXPLAIN UPDATE t SET a = 1'],
    ['mysql', 'EXPLAIN ANALYZE SELECT * FROM t'],
    ['mysql', 'WITH x AS (SELECT 1) SELECT * FROM x'],
    ['mysql', 'TABLE t'],
    ['mysql', "SELECT * FROM users WHERE name = 'O\\'Brien'"],
    ['mysql', '/*!40101 SELECT 1 */'],
    ['mysql', 'SELECT 1;'],
    ['mysql', "HELP 'SELECT'"],
    ['mysql', 'CHECKSUM TABLE t'],
    ['mariadb', 'ANALYZE SELECT * FROM t'],
    ['mariadb', "SELECT * FROM t FOR SYSTEM_TIME AS OF TIMESTAMP'2024-01-01'"],
    ['sqlite', 'SELECT * FROM [order] WHERE a = :a'],
    ['sqlite', 'PRAGMA table_info(users)'],
    ['sqlite', 'PRAGMA main.index_list("users")'],
    ['sqlite', 'PRAGMA foreign_key_list(orders)'],
    ['sqlite', 'PRAGMA integrity_check'],
    ['sqlite', 'EXPLAIN QUERY PLAN SELECT * FROM t'],
    ['sqlite', 'EXPLAIN DELETE FROM t'],
    ['sqlite', "SELECT * FROM pragma_table_info('t')"],
    [
      'clickhouse',
      'SELECT count() FROM t FINAL PREWHERE a > 1 SETTINGS max_threads = 2 FORMAT JSON'
    ],
    ['clickhouse', 'WITH 1 AS x SELECT x'],
    ['clickhouse', 'SELECT * FROM system.mutations'],
    ['clickhouse', 'SELECT {id:UInt32}'],
    ['clickhouse', 'EXISTS TABLE t'],
    ['clickhouse', 'SHOW TABLES'],
    ['clickhouse', 'DESCRIBE TABLE t'],
    ['clickhouse', 'EXPLAIN PIPELINE SELECT 1'],
    ['clickhouse', 'CHECK TABLE t'],
    ['clickhouse', 'SELECT a FROM t LIMIT 1 BY a']
  ]
  it.each(cases)('%s %j → read', (dialect, sql) => {
    expect(cls(sql, dialect)).toBe('read')
  })
})

describe('classifySqlStatement: never a read', () => {
  const cases: Array<[SqlDialect, string, DataStatementClass]> = [
    // a quoted or U&-escaped EXPLAIN option still means ANALYZE, which runs the statement
    ['postgres', 'EXPLAIN ("analyze") SELECT pg_terminate_backend(42)', 'admin'],
    ['postgres', 'EXPLAIN (U&"analyz\\0065") DELETE FROM t WHERE id = 1', 'write'],
    ['postgres', 'EXPLAIN SELECT pg_advisory_lock(1)', 'write'],
    // data-modifying CTEs and hidden writes
    ['postgres', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'write'],
    ['postgres', 'WITH d AS (UPDATE t SET a = 1 RETURNING *) SELECT count(*) FROM d', 'write'],
    [
      'postgres',
      'SELECT * FROM (WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i) s',
      'write'
    ],
    ['postgres', 'WITH x AS (SELECT 1) DELETE FROM t', 'write'],
    ['postgres', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'write'],
    ['mysql', 'WITH x AS (SELECT 1) UPDATE t, x SET t.a = x.a', 'write'],
    ['postgres', 'COPY (DELETE FROM t RETURNING *) TO STDOUT', 'write'],
    // SELECT INTO / INTO OUTFILE
    ['postgres', 'SELECT * INTO newt FROM t', 'write'],
    ['postgres', 'WITH x AS (SELECT 1) SELECT * INTO TEMP y FROM x', 'write'],
    ['mysql', "SELECT * FROM t INTO OUTFILE '/tmp/x'", 'write'],
    ['mysql', 'SELECT a INTO @v FROM t', 'write'],
    ['mysql', "SELECT * FROM (SELECT 1 INTO DUMPFILE '/tmp/y') x", 'write'],
    ['clickhouse', "SELECT * FROM t INTO OUTFILE 'x.csv'", 'write'],
    // locks
    ['postgres', 'SELECT * FROM t FOR UPDATE', 'lock'],
    ['postgres', 'SELECT * FROM t FOR NO KEY UPDATE SKIP LOCKED', 'lock'],
    ['postgres', 'SELECT * FROM t FOR SHARE', 'lock'],
    ['postgres', 'SELECT * FROM t FOR KEY SHARE', 'lock'],
    ['postgres', 'SELECT * FROM (SELECT * FROM t FOR UPDATE) s', 'lock'],
    ['mysql', 'SELECT * FROM t LOCK IN SHARE MODE', 'lock'],
    ['mysql', 'LOCK TABLES t WRITE', 'lock'],
    ['mysql', 'UNLOCK TABLES', 'lock'],
    ['postgres', 'LOCK TABLE t IN ACCESS EXCLUSIVE MODE', 'lock'],
    ['sqlite', 'BEGIN IMMEDIATE', 'lock'],
    ['sqlite', 'BEGIN EXCLUSIVE TRANSACTION', 'lock'],
    // executable comments
    ['mysql', 'SELECT 1 /*! , (DROP TABLE t) */', 'ddl'],
    ['mysql', "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */", 'write'],
    ['mariadb', 'SELECT 1 /*M! , (DELETE FROM t) */', 'write'],
    ['mysql', 'SELECT 1 /*! ; DROP TABLE t */', 'unknown'],
    // EXPLAIN ANALYZE executes
    ['postgres', 'EXPLAIN ANALYZE DELETE FROM t', 'write'],
    ['postgres', 'EXPLAIN ANALYSE UPDATE t SET a = 1', 'write'],
    ['postgres', 'EXPLAIN (ANALYZE) INSERT INTO t VALUES (1)', 'write'],
    ['postgres', 'EXPLAIN (ANALYZE true, BUFFERS) DELETE FROM t', 'write'],
    ['postgres', 'EXPLAIN (ANALYZE 1) DELETE FROM t', 'write'],
    ['postgres', 'EXPLAIN VERBOSE ANALYZE DELETE FROM t', 'write'],
    ['postgres', 'EXPLAIN ANALYZE CREATE TABLE x AS SELECT 1', 'ddl'],
    ['mysql', 'EXPLAIN ANALYZE DELETE FROM t', 'write'],
    ['mysql', 'DESCRIBE ANALYZE UPDATE t SET a = 1', 'write'],
    ['mariadb', 'ANALYZE DELETE FROM t', 'write'],
    ['mariadb', 'ANALYZE FORMAT=JSON UPDATE t SET a = 1', 'write'],
    // side-effect functions
    ['postgres', 'SELECT pg_terminate_backend(123)', 'admin'],
    ['postgres', 'SELECT pg_catalog.pg_cancel_backend(pid) FROM pg_stat_activity', 'admin'],
    ['postgres', 'SELECT pg_sleep(10)', 'write'],
    ['postgres', 'SELECT pg_advisory_lock(1)', 'write'],
    ['postgres', "SELECT nextval('s')", 'write'],
    ['postgres', "SELECT set_config('search_path', 'x', false)", 'write'],
    ['postgres', "SELECT dblink_exec('dbname=x', 'DELETE FROM t')", 'write'],
    ['postgres', "SELECT pg_read_file('/etc/passwd')", 'admin'],
    ['postgres', "SELECT * FROM query_to_xml('DELETE FROM t', true, true, '')", 'write'],
    ['postgres', 'SELECT lo_unlink(123)', 'write'],
    ['postgres', "SELECT * FROM pg_logical_slot_get_changes('s', NULL, NULL)", 'admin'],
    ['mysql', 'SELECT SLEEP(5)', 'write'],
    ['mysql', 'SELECT BENCHMARK(1000000, MD5(1))', 'write'],
    ['mysql', "SELECT GET_LOCK('x', 10)", 'write'],
    ['mysql', "SELECT LOAD_FILE('/etc/passwd')", 'admin'],
    ['clickhouse', "SELECT * FROM url('http://x/y.csv', CSV)", 'admin'],
    ['clickhouse', "SELECT * FROM executable('script.sh', TSV, 'x String')", 'admin'],
    ['clickhouse', "SELECT * FROM s3('https://b/k', 'CSV')", 'admin'],
    ['clickhouse', "SELECT * FROM remote('h:9000', db.t)", 'admin'],
    ['clickhouse', 'SELECT sleep(3)', 'write'],
    ['sqlite', "SELECT load_extension('x')", 'admin'],
    // ordinary writes / ddl / admin
    ['postgres', 'INSERT INTO t VALUES (1)', 'write'],
    ['postgres', 'UPDATE t SET a = 1 WHERE id = 2', 'write'],
    ['postgres', 'DELETE FROM t WHERE id = 2', 'write'],
    [
      'postgres',
      'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a',
      'write'
    ],
    ['mysql', 'REPLACE INTO t VALUES (1)', 'write'],
    ['sqlite', 'INSERT OR REPLACE INTO t VALUES (1)', 'write'],
    ['mysql', "LOAD DATA INFILE '/x' INTO TABLE t", 'write'],
    ['postgres', "COPY t FROM '/tmp/x.csv'", 'write'],
    ['postgres', "COPY t TO '/tmp/x.csv'", 'write'],
    ['postgres', "COPY t FROM PROGRAM 'curl x'", 'admin'],
    ['postgres', 'CALL p()', 'write'],
    ['postgres', 'DO $$ BEGIN PERFORM 1; END $$', 'write'],
    ['mysql', 'DO SLEEP(1)', 'write'],
    ['postgres', 'EXECUTE stmt(1)', 'write'],
    ['postgres', 'REFRESH MATERIALIZED VIEW mv', 'write'],
    ['postgres', "NOTIFY ch, 'x'", 'write'],
    ['postgres', 'CREATE TABLE t (a int)', 'ddl'],
    ['postgres', 'ALTER TABLE t ADD COLUMN b int', 'ddl'],
    ['postgres', 'DROP TABLE t', 'ddl'],
    ['postgres', 'TRUNCATE t', 'ddl'],
    ['postgres', "COMMENT ON TABLE t IS 'x'", 'ddl'],
    ['mysql', 'RENAME TABLE a TO b', 'ddl'],
    ['sqlite', "ATTACH DATABASE '/tmp/x.db' AS x", 'ddl'],
    ['sqlite', 'DETACH x', 'ddl'],
    ['clickhouse', 'ALTER TABLE t DELETE WHERE a = 1', 'write'],
    ['clickhouse', 'ALTER TABLE t UPDATE a = 1, b = 2 WHERE c = 3', 'write'],
    ['clickhouse', 'ALTER TABLE t ADD COLUMN c String, DELETE WHERE a = 1', 'ddl'],
    ['clickhouse', 'OPTIMIZE TABLE t FINAL', 'admin'],
    ['clickhouse', 'SYSTEM FLUSH LOGS', 'admin'],
    ['clickhouse', "KILL QUERY WHERE query_id = 'x'", 'admin'],
    ['clickhouse', 'UNDROP TABLE t', 'ddl'],
    ['mysql', 'GRANT SELECT ON db.* TO u', 'admin'],
    ['mysql', 'REVOKE ALL ON *.* FROM u', 'admin'],
    ['mysql', "CREATE USER u IDENTIFIED BY 'x'", 'admin'],
    ['mysql', "ALTER USER u IDENTIFIED BY 'x'", 'admin'],
    ['mysql', 'DROP USER u', 'admin'],
    ['mysql', 'KILL 12', 'admin'],
    ['mysql', 'FLUSH PRIVILEGES', 'admin'],
    ['mysql', 'PURGE BINARY LOGS BEFORE NOW()', 'admin'],
    ['mysql', 'RESET MASTER', 'admin'],
    ['mysql', 'OPTIMIZE TABLE t', 'admin'],
    ['mysql', 'ANALYZE TABLE t', 'admin'],
    ['mysql', 'CHECK TABLE t', 'admin'],
    ['mysql', 'SHUTDOWN', 'admin'],
    ['postgres', 'VACUUM ANALYZE t', 'admin'],
    ['postgres', 'ANALYZE t', 'admin'],
    ['postgres', 'REINDEX TABLE t', 'admin'],
    ['postgres', 'CHECKPOINT', 'admin'],
    ['postgres', "ALTER SYSTEM SET work_mem = '1GB'", 'admin'],
    ['postgres', "COMMIT PREPARED 'x'", 'admin'],
    ['sqlite', 'VACUUM', 'admin'],
    ['sqlite', "VACUUM INTO '/tmp/copy.db'", 'admin'],
    ['sqlite', 'PRAGMA journal_mode=WAL', 'write'],
    ['sqlite', 'PRAGMA journal_mode', 'write'],
    ['sqlite', 'PRAGMA user_version = 7', 'write'],
    ['sqlite', 'PRAGMA optimize', 'write'],
    ['mariadb', 'BEGIN NOT ATOMIC SELECT 1; END', 'write'],
    ['sqlite', 'CREATE TRIGGER t AFTER INSERT ON x BEGIN DELETE FROM y; END;', 'ddl'],
    ['mysql', 'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'ddl'],
    ['postgres', 'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END', 'ddl'],
    ['mysql', 'SELECT 1; DROP TABLE t', 'unknown'],
    // unknown
    ['postgres', 'FROBNICATE t', 'unknown'],
    ['postgres', "SELECT 'unterminated", 'unknown'],
    ['postgres', 'SELECT (1', 'unknown'],
    ['postgres', 'SELECT 1)', 'unknown'],
    ['postgres', 'SELECT 1; SELECT 2', 'unknown'],
    ['postgres', "'just a string'", 'unknown'],
    ['postgres', 'WITH x AS (SELECT 1)', 'unknown'],
    ['postgres', 'SELECT $x$ unterminated', 'unknown'],
    ['sqlite', 'SET x = 1', 'unknown'],
    ['postgres', 'PRAGMA table_info(t)', 'unknown'],
    ['mysql', "SELECT 'x\\' INTO OUTFILE '/tmp/x' -- '", 'unknown'],
    ['postgres', '', 'unknown'],
    ['postgres', '  -- only a comment', 'unknown']
  ]
  it.each(cases)('%s %j → %s', (dialect, sql, expected) => {
    expect(cls(sql, dialect)).toBe(expected)
  })
})

describe('classifySqlStatement: SET with expressions (MySQL / MariaDB)', () => {
  // A stored function can write; reporting the SET as a read sends it into the read-only
  // sandbox, where a hidden write is rejected and escalated to a confirmation.
  const cases: Array<[SqlDialect, string, DataStatementClass]> = [
    ['mysql', 'SET @id = next_order_id()', 'read'],
    ['mariadb', 'SET @n := (SELECT count(*) FROM orders)', 'read'],
    ['mysql', "SET time_zone = IF(f() > 0, '+00:00', 'SYSTEM')", 'read'],
    ['mysql', 'SET @a = 1, @b = `fn`(2)', 'read'],
    ['mysql', 'SET @x = SLEEP(5)', 'write'],
    ['postgres', 'SET search_path TO analytics, public', 'session'],
    // Values that run something without a function call: a sequence advanced, a view (whose
    // SELECT may call a writing function) read, a function called without parentheses.
    ['mariadb', 'SET @id = NEXT VALUE FOR order_seq', 'read'],
    ['mariadb', 'SET @id = PREVIOUS VALUE FOR order_seq', 'read'],
    ['mariadb', 'SET STATEMENT max_statement_time = 1 FOR SET @x = NEXT VALUE FOR s', 'read'],
    ['mariadb', 'SET @id = order_seq.nextval', 'read'],
    ['mariadb', 'SET @id = next_id', 'read'],
    ['mysql', 'SET @x = (TABLE v)', 'read'],
    ['mysql', 'SET @x = ((TABLE v))', 'read'],
    ['mysql', 'SET @x = (TABLE a UNION TABLE b)', 'read'],
    ['mysql', 'SET time_zone = (TABLE tz)', 'read'],
    ['mysql', 'SET @x = (VALUES ROW(1))', 'read'],
    ['mysql', "SET time_zone = '+00:00', @x = (TABLE v)", 'read'],
    // SET NAMES / CHARACTER SET may lead a list in MySQL: the rest is still checked.
    ['mysql', 'SET NAMES utf8mb4, @x = next_order_id()', 'read'],
    ['mariadb', 'SET CHARACTER SET utf8mb4, @x = NEXT VALUE FOR s', 'read'],
    ['mysql', 'SET NAMES utf8mb4, @@session.time_zone = SYSTEM', 'session'],
    ['mysql', 'SET NAMES utf8mb4, foreign_key_checks = 0', 'admin'],
    // Literals, variables and arithmetic stay session settings.
    ['mysql', 'SET @x = -1, @y := @x + 2 * 3', 'session'],
    ['mysql', "SET @x = NULL, @y = TRUE, @z = X'ff'", 'session'],
    ['mysql', 'SET lc_time_names = en_US, time_zone = SYSTEM', 'session'],
    ['mysql', 'SET SESSION max_execution_time = DEFAULT', 'session'],
    ['mysql', "SET NAMES 'utf8mb4' COLLATE 'utf8mb4_bin'", 'session'],
    ['mariadb', 'SET CHARACTER SET utf8mb4', 'session']
  ]
  it.each(cases)('%s %j → %s', (dialect, sql, expected) => {
    expect(cls(sql, dialect)).toBe(expected)
  })
})

describe('classifySqlStatement: transactions and session statements', () => {
  const cases: Array<[SqlDialect, string, DataStatementClass]> = [
    ['postgres', 'BEGIN', 'tx'],
    ['postgres', 'BEGIN ISOLATION LEVEL SERIALIZABLE', 'tx'],
    ['mysql', 'START TRANSACTION READ ONLY', 'tx'],
    ['mysql', 'START TRANSACTION WITH CONSISTENT SNAPSHOT', 'tx'],
    ['postgres', 'COMMIT', 'tx'],
    ['postgres', 'ROLLBACK TO SAVEPOINT s1', 'tx'],
    ['postgres', 'SAVEPOINT s1', 'tx'],
    ['postgres', 'RELEASE SAVEPOINT s1', 'tx'],
    ['postgres', 'END', 'tx'],
    ['postgres', 'ABORT', 'tx'],
    ['sqlite', 'BEGIN DEFERRED', 'tx'],
    ['sqlite', 'END TRANSACTION', 'tx'],
    ['postgres', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'tx'],
    ['mysql', 'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED', 'tx'],
    ['mysql', 'SET autocommit = 0', 'tx'],
    ['postgres', 'SET CONSTRAINTS ALL DEFERRED', 'tx'],
    ['mysql', 'START REPLICA', 'admin'],
    ['mysql', 'USE shop', 'session'],
    ['clickhouse', 'USE shop', 'session'],
    ['postgres', 'SET search_path TO analytics, public', 'session'],
    ['postgres', 'SET LOCAL statement_timeout = 5000', 'session'],
    ['postgres', "SET TIME ZONE 'UTC'", 'session'],
    ['postgres', "SET SESSION TIME ZONE 'UTC'", 'session'],
    ['postgres', "SET application_name = 'x'", 'session'],
    ['postgres', "SET NAMES 'UTF8'", 'session'],
    ['postgres', "SET SCHEMA 'analytics'", 'session'],
    ['postgres', 'RESET search_path', 'session'],
    ['postgres', 'RESET ALL', 'session'],
    ['postgres', 'RESET ROLE', 'admin'],
    ['postgres', 'DISCARD ALL', 'write'],
    ['postgres', 'DISCARD TEMP', 'write'],
    ['postgres', 'DISCARD PLANS', 'session'],
    ['mysql', 'SET @x = 1', 'session'],
    ['mysql', "SET NAMES utf8mb4, time_zone = '+00:00'", 'session'],
    ['postgres', 'PREPARE p AS DELETE FROM t', 'session'],
    ['postgres', 'DEALLOCATE p', 'session'],
    ['postgres', 'LISTEN ch', 'session'],
    ['postgres', 'CLOSE c', 'session'],
    ['mysql', 'SET NAMES utf8mb4 COLLATE utf8mb4_bin', 'session'],
    ['mysql', 'SET CHARACTER SET utf8mb4', 'session'],
    ['mysql', "SET time_zone = '+00:00'", 'session'],
    ['mysql', 'SET @x = 1, @y := 2', 'session'],
    ['mysql', 'SET @@session.max_execution_time = 1000', 'session'],
    ['mysql', 'SET SESSION sql_select_limit = 10', 'session'],
    ['mysql', 'DROP PREPARE s', 'session'],
    ['clickhouse', 'SET max_threads = 4, max_memory_usage = 10000000000', 'session'],
    ['mysql', 'SET GLOBAL max_connections = 1000', 'admin'],
    ['mysql', 'SET @@global.read_only = 1', 'admin'],
    ['mysql', 'SET PERSIST innodb_buffer_pool_size = 1', 'admin'],
    ['mysql', 'SET foreign_key_checks = 0', 'admin'],
    ['mysql', 'SET sql_safe_updates = 0', 'admin'],
    ['mysql', "SET sql_mode = 'NO_BACKSLASH_ESCAPES'", 'admin'],
    ['mysql', 'SET sql_log_bin = 0', 'admin'],
    ['postgres', 'SET session_replication_role = replica', 'admin'],
    ['postgres', 'SET default_transaction_read_only = off', 'admin'],
    ['postgres', 'SET ROLE admin', 'admin'],
    ['postgres', 'SET SESSION AUTHORIZATION postgres', 'admin'],
    ['mysql', "SET PASSWORD = 'x'", 'admin'],
    ['clickhouse', 'SET readonly = 0', 'admin'],
    ['postgres', 'SET my.custom_setting = 1', 'unknown'],
    ['mysql', 'SET @x = (SELECT a FROM t FOR UPDATE)', 'lock'],
    ['mysql', 'SET @x = SLEEP(5)', 'write'],
    ['mariadb', 'SET STATEMENT max_statement_time = 1 FOR SELECT * FROM t', 'read'],
    ['mariadb', 'SET STATEMENT max_statement_time = 1 FOR DELETE FROM t', 'write'],
    ['mariadb', 'SET STATEMENT foreign_key_checks = 0 FOR SELECT 1', 'admin']
  ]
  it.each(cases)('%s %j → %s', (dialect, sql, expected) => {
    expect(cls(sql, dialect)).toBe(expected)
  })
})

describe('classifySqlStatement: dangerous warnings', () => {
  const cases: Array<[SqlDialect, string, string[]]> = [
    ['mysql', 'DELETE FROM orders', ['DELETE without WHERE removes every row of orders']],
    [
      'postgres',
      'DELETE FROM ONLY public.orders RETURNING *',
      ['DELETE without WHERE removes every row of public.orders']
    ],
    [
      'postgres',
      'UPDATE orders SET status = 1',
      ['UPDATE without WHERE changes every row of orders']
    ],
    [
      'mysql',
      'UPDATE orders SET a = 1 WHERE 1=1',
      ['UPDATE with an always-true WHERE changes every row of orders']
    ],
    [
      'mysql',
      'DELETE FROM orders WHERE true',
      ['DELETE with an always-true WHERE removes every row of orders']
    ],
    ['postgres', "DELETE FROM orders WHERE 'a' = 'a' OR id = 1", []],
    [
      'postgres',
      "DELETE FROM orders WHERE 'a' = 'a' AND (1 <> 2)",
      ['DELETE with an always-true WHERE removes every row of orders']
    ],
    ['mysql', 'DELETE FROM orders WHERE 1 = 0', []],
    [
      'mysql',
      'DELETE FROM orders WHERE NOT FALSE',
      ['DELETE with an always-true WHERE removes every row of orders']
    ],
    [
      'mysql',
      'DELETE FROM orders WHERE NULL IS NULL',
      ['DELETE with an always-true WHERE removes every row of orders']
    ],
    ['mysql', 'DELETE FROM orders WHERE 1 IN (1)', []],
    ['mysql', 'DELETE FROM orders WHERE id = 5', []],
    ['mysql', 'DELETE FROM orders LIMIT 10', ['DELETE without WHERE removes every row of orders']],
    [
      'mysql',
      'UPDATE orders SET a = (SELECT 1 FROM x WHERE y = 1)',
      ['UPDATE without WHERE changes every row of orders']
    ],
    [
      'mysql',
      'DELETE o FROM orders o JOIN users u ON u.id = o.user_id',
      ['DELETE … JOIN without WHERE removes every joined row of o']
    ],
    [
      'mysql',
      'UPDATE a JOIN b ON a.id = b.id SET a.x = b.x',
      ['UPDATE … JOIN without WHERE changes every joined row of a']
    ],
    [
      'postgres',
      'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d WHERE x = 1',
      ['DELETE without WHERE removes every row of t']
    ],
    ['postgres', 'INSERT INTO t SELECT * FROM u ON CONFLICT (id) DO UPDATE SET a = 1', []],
    ['mysql', 'INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 1', []],
    ['postgres', 'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', []],
    ['postgres', 'EXPLAIN DELETE FROM t', []],
    ['postgres', 'EXPLAIN ANALYZE DELETE FROM t', ['DELETE without WHERE removes every row of t']],
    ['sqlite', 'CREATE TRIGGER tr AFTER DELETE ON a BEGIN DELETE FROM b; END', []],
    ['mysql', 'DROP TABLE orders', ['DROP TABLE orders']],
    ['mysql', 'DROP TABLE IF EXISTS `shop`.`orders`, users', ['DROP TABLE shop.orders, users']],
    ['postgres', 'DROP MATERIALIZED VIEW IF EXISTS mv CASCADE', ['DROP MATERIALIZED VIEW mv']],
    ['postgres', 'DROP INDEX CONCURRENTLY idx', ['DROP INDEX idx']],
    ['postgres', 'DROP SCHEMA analytics CASCADE', ['DROP SCHEMA analytics']],
    ['mysql', 'DROP DATABASE shop', ['DROP DATABASE shop']],
    ['clickhouse', 'DROP TABLE IF EXISTS db.t ON CLUSTER c SYNC', ['DROP TABLE db.t']],
    ['mysql', 'DROP USER u', ['DROP USER u']],
    [
      'postgres',
      'TRUNCATE orders, users RESTART IDENTITY',
      ['TRUNCATE removes every row of orders, users']
    ],
    ['mysql', 'TRUNCATE TABLE orders', ['TRUNCATE removes every row of orders']],
    ['postgres', 'ALTER TABLE orders DROP COLUMN note', ['ALTER TABLE orders drops COLUMN note']],
    [
      'postgres',
      'ALTER TABLE orders DROP CONSTRAINT fk_x',
      ['ALTER TABLE orders drops CONSTRAINT fk_x']
    ],
    ['mysql', 'ALTER TABLE orders ADD COLUMN x int, DROP note', ['ALTER TABLE orders drops note']],
    ['mysql', 'ALTER TABLE orders DROP PRIMARY KEY', ['ALTER TABLE orders drops PRIMARY KEY']],
    ['postgres', 'ALTER TABLE orders ALTER COLUMN note DROP NOT NULL', []],
    ['postgres', 'ALTER TABLE orders ALTER COLUMN note DROP DEFAULT', []],
    ['postgres', 'ALTER TABLE orders RENAME TO orders_old', ['ALTER TABLE orders renames it']],
    ['postgres', 'ALTER TABLE orders RENAME COLUMN a TO b', ['ALTER TABLE orders renames COLUMN']],
    // MySQL / MariaDB CHANGE renames when the two names differ (the structure editor emits it).
    [
      'mysql',
      'ALTER TABLE `shop`.`t` CHANGE COLUMN `a` `b` int NOT NULL',
      ['ALTER TABLE shop.t renames column a to b']
    ],
    ['mysql', 'ALTER TABLE t CHANGE a b int', ['ALTER TABLE t renames column a to b']],
    [
      'mariadb',
      'ALTER TABLE t ADD COLUMN x int, CHANGE COLUMN IF EXISTS `j` `j2` longtext CHECK (json_valid(`j2`))',
      ['ALTER TABLE t renames column j to j2']
    ],
    ['mysql', 'ALTER TABLE t CHANGE COLUMN `a` `A` int', []],
    ['mysql', 'ALTER TABLE t CHANGE `a` `a` bigint NOT NULL', []],
    ['mysql', 'ALTER TABLE t MODIFY COLUMN a bigint', []],
    [
      'mysql',
      'RENAME TABLE a TO b, c TO d',
      ['RENAME TABLE a, c breaks everything that uses the old name']
    ],
    ['clickhouse', 'ALTER TABLE t DROP PARTITION 202401', ['ALTER TABLE t drops PARTITION 202401']],
    [
      'clickhouse',
      'ALTER TABLE t DELETE WHERE x = 1',
      ['ClickHouse mutation ALTER TABLE t DELETE rewrites data asynchronously and cannot be undone']
    ],
    [
      'clickhouse',
      'ALTER TABLE db.t ON CLUSTER c UPDATE a = 1 WHERE b = 2',
      [
        'ClickHouse mutation ALTER TABLE db.t UPDATE rewrites data asynchronously and cannot be undone'
      ]
    ],
    [
      'clickhouse',
      'OPTIMIZE TABLE t FINAL DEDUPLICATE',
      ['OPTIMIZE … DEDUPLICATE removes duplicate rows of t']
    ],
    ['clickhouse', 'TRUNCATE TABLE IF EXISTS t', ['TRUNCATE removes every row of t']],
    ['mysql', 'KILL 12', ['KILL terminates a server connection']],
    ['mysql', 'KILL QUERY 12', ['KILL QUERY stops a running query']],
    [
      'clickhouse',
      "KILL MUTATION WHERE mutation_id = 'x'",
      ['KILL MUTATION stops a running mutation']
    ],
    ['clickhouse', 'SYSTEM STOP MERGES t', ['SYSTEM STOP MERGES t is a server-level command']],
    ['mysql', 'GRANT ALL PRIVILEGES ON *.* TO u', ['GRANT ALL PRIVILEGES']],
    ['postgres', 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM u', ['REVOKE ALL PRIVILEGES']],
    ['mysql', 'GRANT SELECT ON db.* TO u', []],
    [
      'postgres',
      "COPY t TO PROGRAM 'gzip > /tmp/x.gz'",
      ['COPY … PROGRAM runs a shell command on the database server']
    ],
    [
      'mysql',
      'SET GLOBAL max_connections = 10',
      ['SET GLOBAL max_connections changes a server-wide setting']
    ],
    ['mysql', "SET @@global.sql_mode = ''", ['SET GLOBAL sql_mode changes a server-wide setting']],
    ['mysql', 'FLUSH PRIVILEGES', ['FLUSH PRIVILEGES has a server-wide effect']],
    ['mysql', 'RESET MASTER', ['RESET MASTER has a server-wide effect']],
    ['mysql', "PURGE BINARY LOGS TO 'b.01'", ['PURGE BINARY LOGS has a server-wide effect']],
    ['mysql', "ALTER USER u IDENTIFIED BY 'x'", ['ALTER USER changes credentials or privileges']],
    [
      'postgres',
      "ALTER SYSTEM SET work_mem = '1GB'",
      ['ALTER SYSTEM changes the server configuration']
    ],
    [
      'postgres',
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity',
      ['calls pg_terminate_backend()']
    ],
    ['postgres', 'SELECT pg_reload_conf()', ['calls pg_reload_conf()']],
    ['postgres', 'SELECT pg_sleep(1)', []],
    ['clickhouse', "SELECT * FROM executable('x.sh', TSV, 'a String')", ['calls executable()']],
    ['sqlite', "SELECT load_extension('evil')", ['calls load_extension()']],
    ['postgres', 'SELECT * FROM t', []],
    ['postgres', 'INSERT INTO t VALUES (1)', []]
  ]
  it.each(cases)('%s %j', (dialect, sql, expected) => {
    expect(classifySqlStatement(sql, dialect).dangerous).toEqual(expected)
  })
})

describe('classifySqlStatement: destructive target (typed confirmation on production)', () => {
  const cases: Array<[SqlDialect, string, string | null]> = [
    ['mysql', 'DROP TABLE orders', 'orders'],
    ['mysql', 'DROP DATABASE shop', 'shop'],
    ['postgres', 'TRUNCATE public.orders', 'public.orders'],
    ['postgres', 'DELETE FROM "Orders"', 'Orders'],
    ['mysql', 'UPDATE `orders` SET a = 1', 'orders'],
    ['mysql', 'UPDATE orders SET a = 1 WHERE 1 = 1', 'orders'],
    ['mysql', 'DELETE FROM orders WHERE id = 1', null],
    ['clickhouse', 'ALTER TABLE t DELETE WHERE x = 1', null],
    ['postgres', 'SELECT 1', null]
  ]
  it.each(cases)('%s %j → %s', (dialect, sql, expected) => {
    expect(classifySqlStatement(sql, dialect).destructiveTarget).toBe(expected)
  })
})

describe('classifySqlStatement: target tables', () => {
  const cases: Array<[SqlDialect, string, string[]]> = [
    ['postgres', 'INSERT INTO public.orders (a) VALUES (1)', ['public.orders']],
    ['mysql', 'INSERT IGNORE INTO `shop`.`orders` VALUES (1)', ['shop.orders']],
    ['mysql', 'INSERT orders VALUES (1)', ['orders']],
    ['sqlite', 'INSERT OR REPLACE INTO t VALUES (1)', ['t']],
    ['mysql', 'REPLACE INTO t VALUES (1)', ['t']],
    ['postgres', 'UPDATE ONLY t SET a = 1 WHERE b = 2', ['t']],
    ['sqlite', 'UPDATE OR IGNORE t SET a = 1 WHERE b = 2', ['t']],
    ['mysql', 'DELETE LOW_PRIORITY QUICK FROM t WHERE a = 1', ['t']],
    ['mysql', 'DELETE t1, t2 FROM t1 JOIN t2 ON t1.id = t2.id WHERE t1.a = 1', ['t1', 't2']],
    ['postgres', 'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1', ['t']],
    [
      'postgres',
      'WITH m AS (DELETE FROM a WHERE x = 1 RETURNING *) INSERT INTO b SELECT * FROM m',
      ['a', 'b']
    ],
    ['postgres', 'TRUNCATE a, b', ['a', 'b']],
    ['postgres', 'DROP VIEW IF EXISTS v1, v2', ['v1', 'v2']],
    ['postgres', 'ALTER TABLE IF EXISTS ONLY t ADD COLUMN a int', ['t']],
    ['postgres', 'CREATE TABLE IF NOT EXISTS t (a int)', ['t']],
    ['mysql', 'RENAME TABLE a TO b', ['a']],
    ['postgres', "COPY orders FROM '/x.csv'", ['orders']],
    ['mysql', "LOAD DATA LOCAL INFILE '/x' INTO TABLE orders", ['orders']],
    ['clickhouse', 'INSERT INTO TABLE db.t FORMAT JSONEachRow', ['db.t']],
    ['clickhouse', "INSERT INTO FUNCTION file('x.csv') SELECT 1", []],
    ['postgres', 'SELECT * FROM t', []]
  ]
  it.each(cases)('%s %j', (dialect, sql, expected) => {
    expect(classifySqlStatement(sql, dialect).targetTables).toEqual(expected)
  })
})

describe('classifySqlStatement: returnsRows and hasLimitClause', () => {
  it('counts only a LIMIT that bounds the whole result', () => {
    const lim = (sql: string, d: SqlDialect): boolean => classifySqlStatement(sql, d).hasLimitClause
    expect(lim('SELECT seq FROM seq_1_to_5000 LIMIT ROWS EXAMINED 100000', 'mariadb')).toBe(false)
    expect(lim('SELECT seq FROM t LIMIT 10 ROWS EXAMINED 1000', 'mariadb')).toBe(true)
    expect(lim('(SELECT a FROM t LIMIT 3) UNION ALL (SELECT a FROM u)', 'mysql')).toBe(false)
    expect(lim('(SELECT a FROM t) UNION ALL (SELECT a FROM u LIMIT 3)', 'mysql')).toBe(false)
    expect(lim('(SELECT a FROM t) UNION ALL (SELECT a FROM u) LIMIT 3', 'mysql')).toBe(true)
    expect(lim('(SELECT a FROM t LIMIT 3)', 'postgres')).toBe(true)
  })

  const cases: Array<[SqlDialect, string, boolean, boolean]> = [
    ['postgres', 'SELECT * FROM t', true, false],
    ['postgres', 'SELECT * FROM t LIMIT 5', true, true],
    ['postgres', 'SELECT * FROM t OFFSET 5', true, false],
    ['postgres', 'SELECT * FROM t FETCH FIRST 5 ROWS ONLY', true, true],
    ['postgres', 'SELECT * FROM (SELECT * FROM t LIMIT 5) s', true, false],
    ['postgres', '(SELECT * FROM t LIMIT 5)', true, true],
    ['postgres', 'WITH x AS (SELECT * FROM t LIMIT 1) SELECT * FROM x', true, false],
    ['postgres', 'VALUES (1)', true, false],
    ['postgres', 'TABLE t', true, false],
    ['postgres', 'SHOW ALL', true, false],
    ['postgres', 'EXPLAIN SELECT 1', true, false],
    ['postgres', 'INSERT INTO t VALUES (1)', false, false],
    ['postgres', 'INSERT INTO t VALUES (1) RETURNING id', true, false],
    ['postgres', 'WITH x AS (SELECT 1) UPDATE t SET a = 1 RETURNING *', true, false],
    ['postgres', 'SELECT * INTO t2 FROM t', false, false],
    ['postgres', 'CREATE TABLE t (a int)', false, false],
    ['postgres', 'SET search_path TO x', false, false],
    ['sqlite', 'PRAGMA table_info(t)', true, false],
    ['sqlite', 'PRAGMA journal_mode', true, false],
    ['sqlite', 'PRAGMA foreign_keys = ON', false, false],
    ['mysql', 'SHOW TABLES', true, false],
    ['mysql', 'DESCRIBE t', true, false],
    ['mysql', 'OPTIMIZE TABLE t', true, false],
    ['mysql', 'SELECT * FROM t LIMIT 10, 20', true, true],
    ['mysql', 'DELETE FROM t WHERE a = 1 LIMIT 5', false, true],
    ['clickhouse', 'SELECT * FROM t LIMIT 1 BY a', true, false],
    ['clickhouse', 'SELECT * FROM t LIMIT 1 BY a LIMIT 10', true, true],
    ['clickhouse', 'SELECT * FROM t LIMIT 10 SETTINGS max_threads = 1', true, true],
    ['clickhouse', 'SELECT TOP 10 * FROM t', true, true],
    ['clickhouse', 'EXISTS t', true, false]
  ]
  it.each(cases)('%s %j → rows %s, limit %s', (dialect, sql, rows, limit) => {
    const c = classifySqlStatement(sql, dialect)
    expect(c.returnsRows).toBe(rows)
    expect(c.hasLimitClause).toBe(limit)
  })
})

describe('classifySqlStatement: details', () => {
  it('reports the leading keyword as written', () => {
    expect(
      classifySqlStatement('with x as (select 1) select * from x', 'postgres').leadingKeyword
    ).toBe('WITH')
    expect(classifySqlStatement('(select 1)', 'postgres').leadingKeyword).toBe('SELECT')
    expect(classifySqlStatement('/*!40101 SET NAMES utf8 */', 'mysql').leadingKeyword).toBe('SET')
    expect(classifySqlStatement("'x'", 'postgres').leadingKeyword).toBeNull()
  })

  it('gives plain reads no reasons and everything else at least one', () => {
    expect(classifySqlStatement('SELECT 1', 'postgres').reasons).toEqual([])
    expect(classifySqlStatement('INSERT INTO t VALUES (1)', 'postgres').reasons).toEqual([
      'modifies data (INSERT)'
    ])
    expect(classifySqlStatement('FROB', 'postgres').reasons).toEqual([
      'unrecognised statement FROB'
    ])
    expect(classifySqlStatement('SELECT pg_sleep(1)', 'postgres').reasons[0]).toBe(
      'calls pg_sleep(), which has side effects'
    )
    expect(classifySqlStatement("SELECT 'x", 'postgres').reasons[0]).toBe(
      'could not parse the statement: unterminated string literal'
    )
    expect(classifySqlStatement('SELECT 1; SELECT 2', 'postgres').reasons[0]).toBe(
      'contains more than one statement'
    )
  })

  it('trusts an explicit backslash mode instead of lexing both ways', () => {
    const sql = "SELECT 'x\\' INTO OUTFILE '/tmp/x' -- '"
    expect(classifySqlStatement(sql, 'mysql', { backslashEscapes: true }).classification).toBe(
      'read'
    )
    expect(classifySqlStatement(sql, 'mysql', { backslashEscapes: false }).classification).toBe(
      'write'
    )
  })

  it('exposes top-level words and the code end for the auto-limit rewrite', () => {
    const a = analyzeSqlStatement('SELECT a FROM t ORDER BY a -- c\n;', 'postgres')
    expect(a.mainKeyword).toBe('SELECT')
    expect(a.topLevelWords).toEqual(['SELECT', 'A', 'FROM', 'T', 'ORDER', 'BY', 'A'])
    expect(a.codeEnd).toBe(26)
    expect(a.multipleStatements).toBe(false)
    expect(a.lexError).toBeNull()
  })
})
