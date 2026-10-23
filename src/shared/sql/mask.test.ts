import { describe, expect, it } from 'vitest'

import type { SqlDialect } from '../data-projects/types'
import { maskUrlCredentials } from '../data-projects/url-credentials'
import { maskSqlSecrets } from './mask'

describe('maskSqlSecrets', () => {
  const cases: Array<[string, string]> = [
    ["CREATE USER 'u'@'%' IDENTIFIED BY 's3cret!'", "CREATE USER 'u'@'%' IDENTIFIED BY '***'"],
    [
      "ALTER USER u IDENTIFIED WITH caching_sha2_password BY 'p'",
      "ALTER USER u IDENTIFIED WITH caching_sha2_password BY '***'"
    ],
    [
      "ALTER USER u IDENTIFIED BY 'new' REPLACE 'old'",
      "ALTER USER u IDENTIFIED BY '***' REPLACE '***'"
    ],
    [
      "GRANT ALL ON *.* TO u IDENTIFIED BY PASSWORD '*ABC'",
      "GRANT ALL ON *.* TO u IDENTIFIED BY PASSWORD '***'"
    ],
    [
      "CREATE USER u IDENTIFIED VIA ed25519 USING PASSWORD('pw')",
      "CREATE USER u IDENTIFIED VIA ed25519 USING PASSWORD('***')"
    ],
    ["CREATE ROLE r LOGIN PASSWORD 'pw'", "CREATE ROLE r LOGIN PASSWORD '***'"],
    ["ALTER ROLE r WITH ENCRYPTED PASSWORD 'md5abc'", "ALTER ROLE r WITH ENCRYPTED PASSWORD '***'"],
    ["SET PASSWORD = 'pw'", "SET PASSWORD = '***'"],
    ["SET PASSWORD FOR 'u'@'localhost' = 'pw'", "SET PASSWORD FOR 'u'@'localhost' = '***'"],
    [
      "CHANGE REPLICATION SOURCE TO SOURCE_USER='r', SOURCE_PASSWORD='pw'",
      "CHANGE REPLICATION SOURCE TO SOURCE_USER='r', SOURCE_PASSWORD='***'"
    ],
    ["CHANGE MASTER TO MASTER_PASSWORD = 'pw'", "CHANGE MASTER TO MASTER_PASSWORD = '***'"],
    [
      "CREATE USER MAPPING FOR u SERVER s OPTIONS (user 'x', password 'pw')",
      "CREATE USER MAPPING FOR u SERVER s OPTIONS (user 'x', password '***')"
    ],
    [
      "CREATE USER u IDENTIFIED WITH sha256_password BY 'it''s'",
      "CREATE USER u IDENTIFIED WITH sha256_password BY '***'"
    ],
    ['CREATE USER u IDENTIFIED BY "dq"', 'CREATE USER u IDENTIFIED BY "***"'],
    [
      "SELECT dblink_connect('host=db password=topsecret dbname=x')",
      "SELECT dblink_connect('host=db password=*** dbname=x')"
    ],
    [
      "SELECT * FROM dblink('postgresql://app:pw@db/shop', 'select 1')",
      "SELECT * FROM dblink('postgresql://app:***@db/shop', 'select 1')"
    ],
    [
      "CREATE NAMED COLLECTION s3 AS access_key_id = 'AK', secret_access_key = 'SK'",
      "CREATE NAMED COLLECTION s3 AS access_key_id = 'AK', secret_access_key = '***'"
    ],
    [
      "SELECT * FROM users WHERE password = 'hunter2'",
      "SELECT * FROM users WHERE password = '***'"
    ],
    ['SELECT password_hash FROM users', 'SELECT password_hash FROM users'],
    ["SELECT * FROM users WHERE name = 'password'", "SELECT * FROM users WHERE name = 'password'"],
    ['SELECT 1', 'SELECT 1'],
    ['', '']
  ]
  it.each(cases)('%j', (input, expected) => {
    expect(maskSqlSecrets(input)).toBe(expected)
  })

  // Every spelling of a string literal: PG E'…', $$…$$, $tag$…$tag$, U&'…', N'…' and MySQL
  // charset introducers.
  const literalForms: Array<[string, string]> = [
    ["ALTER ROLE app PASSWORD E'S3cretPw1'", "ALTER ROLE app PASSWORD '***'"],
    ["ALTER ROLE app PASSWORD e'S3cret\\'Pw1'", "ALTER ROLE app PASSWORD '***'"],
    ['ALTER ROLE app PASSWORD $$S3cretPw2$$', "ALTER ROLE app PASSWORD '***'"],
    ['CREATE ROLE app LOGIN PASSWORD $p$S3cretPw3$p$', "CREATE ROLE app LOGIN PASSWORD '***'"],
    ["ALTER USER app WITH PASSWORD U&'S3cretPw4'", "ALTER USER app WITH PASSWORD '***'"],
    [
      "ALTER USER app WITH PASSWORD U&'d!0061t' UESCAPE '!'",
      "ALTER USER app WITH PASSWORD '***' UESCAPE '!'"
    ],
    ["CREATE ROLE app PASSWORD N'S3cretPw5'", "CREATE ROLE app PASSWORD '***'"],
    ["CREATE USER u IDENTIFIED BY _utf8mb4'S3cretPw6'", "CREATE USER u IDENTIFIED BY '***'"],
    [
      "ALTER USER u IDENTIFIED BY _latin1 'S3cretPw7' REPLACE $$old$$",
      "ALTER USER u IDENTIFIED BY '***' REPLACE '***'"
    ],
    ["SET PASSWORD FOR u = E'S3cretPw8'", "SET PASSWORD FOR u = '***'"],
    [
      'CREATE USER MAPPING FOR u SERVER s OPTIONS (password $$pw$$)',
      "CREATE USER MAPPING FOR u SERVER s OPTIONS (password '***')"
    ]
  ]
  it.each(literalForms)('masks literal form %j', (input, expected) => {
    expect(maskSqlSecrets(input)).toBe(expected)
  })

  // ClickHouse positional credentials of table functions and engines.
  const positional: Array<[string, string]> = [
    [
      "SELECT * FROM mysql('db:3306', 'shop', 'users', 'root', 'S3cretPw6')",
      "SELECT * FROM mysql('db:3306', 'shop', 'users', 'root', '***')"
    ],
    [
      "INSERT INTO FUNCTION MySQL('db:3306', 'shop', 'users', 'root', 'pw', 0, 'UPDATE x = 1') SELECT 1",
      "INSERT INTO FUNCTION MySQL('db:3306', 'shop', 'users', 'root', '***', 0, 'UPDATE x = 1') SELECT 1"
    ],
    [
      "SELECT * FROM postgresql('pg:5432', 'shop', 'users', 'app', 'pw', 'public')",
      "SELECT * FROM postgresql('pg:5432', 'shop', 'users', 'app', '***', 'public')"
    ],
    [
      "CREATE TABLE t (a Int32) ENGINE = PostgreSQL('pg:5432', 'shop', 'users', 'app', $h$pw$h$)",
      "CREATE TABLE t (a Int32) ENGINE = PostgreSQL('pg:5432', 'shop', 'users', 'app', '***')"
    ],
    [
      "CREATE DATABASE d ENGINE = MySQL('db:3306', 'shop', 'root', 'pw')",
      "CREATE DATABASE d ENGINE = MySQL('db:3306', 'shop', 'root', '***')"
    ],
    [
      "CREATE DATABASE IF NOT EXISTS d ENGINE = PostgreSQL('pg:5432', 'shop', 'app', 'pw', 'public', 1)",
      "CREATE DATABASE IF NOT EXISTS d ENGINE = PostgreSQL('pg:5432', 'shop', 'app', '***', 'public', 1)"
    ],
    [
      "CREATE DATABASE d ENGINE = MaterializedMySQL('db:3306', 'shop', 'root', 'pw')",
      "CREATE DATABASE d ENGINE = MaterializedMySQL('db:3306', 'shop', 'root', '***')"
    ],
    [
      "SELECT * FROM mongodb('m:27017', 'shop', 'users', 'root', 'pw', 'a String')",
      "SELECT * FROM mongodb('m:27017', 'shop', 'users', 'root', '***', 'a String')"
    ],
    [
      "SELECT * FROM redis('r:6379', 'k', 'k String, v String', 0, 'pw')",
      "SELECT * FROM redis('r:6379', 'k', 'k String, v String', 0, '***')"
    ],
    [
      "SELECT * FROM remote('h:9000', db, t, 'default', 'S3cretPw7')",
      "SELECT * FROM remote('h:9000', db, t, 'default', '***')"
    ],
    [
      "SELECT * FROM remote('h:9000', 'db', 'tbl', 'default', 'pw', rand())",
      "SELECT * FROM remote('h:9000', 'db', 'tbl', 'default', '***', rand())"
    ],
    [
      "SELECT * FROM remoteSecure('h:9440', shop.users, 'default', 'pw')",
      "SELECT * FROM remoteSecure('h:9440', shop.users, 'default', '***')"
    ],
    [
      "SELECT * FROM remote('h:9000', 'shop.users', 'default', 'pw')",
      "SELECT * FROM remote('h:9000', 'shop.users', 'default', '***')"
    ],
    [
      "SELECT * FROM remote('h:9000', numbers(10), 'default', 'pw')",
      "SELECT * FROM remote('h:9000', numbers(10), 'default', '***')"
    ],
    [
      "SELECT * FROM s3('https://b.s3.amazonaws.com/x.csv', 'AKIAEXAMPLE', 'S3cretKey', 'CSV')",
      "SELECT * FROM s3('https://b.s3.amazonaws.com/x.csv', 'AKIAEXAMPLE', '***', 'CSV')"
    ],
    [
      "SELECT * FROM s3('https://b/x', 'AKIA', 'secret', 'sessionTok', 'Parquet')",
      "SELECT * FROM s3('https://b/x', 'AKIA', '***', '***', 'Parquet')"
    ],
    [
      "SELECT * FROM s3Cluster('c', 'https://b/x', 'AKIA', 'secret', 'CSV', 'a String')",
      "SELECT * FROM s3Cluster('c', 'https://b/x', 'AKIA', '***', 'CSV', 'a String')"
    ],
    [
      "CREATE TABLE t (a String) ENGINE = S3('https://b/x', 'AKIA', 'secret', 'CSV')",
      "CREATE TABLE t (a String) ENGINE = S3('https://b/x', 'AKIA', '***', 'CSV')"
    ],
    [
      "SELECT * FROM azureBlobStorage('https://acct.blob.core.windows.net', 'c', 'p.csv', 'acct', 'KEY==', 'CSV')",
      "SELECT * FROM azureBlobStorage('https://acct.blob.core.windows.net', 'c', 'p.csv', 'acct', '***', 'CSV')"
    ],
    [
      "SELECT * FROM azureBlobStorage('DefaultEndpointsProtocol=https;AccountName=a;AccountKey=K+/y==;EndpointSuffix=core.windows.net', 'c', 'p.csv', 'CSV')",
      "SELECT * FROM azureBlobStorage('DefaultEndpointsProtocol=https;AccountName=a;AccountKey=***;EndpointSuffix=core.windows.net', 'c', 'p.csv', 'CSV')"
    ],
    [
      "CREATE TABLE t ENGINE = ExternalDistributed('MySQL', 'db:3306', 'shop', 'users', 'root', 'pw')",
      "CREATE TABLE t ENGINE = ExternalDistributed('MySQL', 'db:3306', 'shop', 'users', 'root', '***')"
    ],
    [
      "SELECT * FROM mysql('db:3306', 'shop', 'a', 'root', 'pw1'); SELECT * FROM mysql('db:3306', 'shop', 'b', 'root', 'pw2')",
      "SELECT * FROM mysql('db:3306', 'shop', 'a', 'root', '***'); SELECT * FROM mysql('db:3306', 'shop', 'b', 'root', '***')"
    ],
    [
      "SELECT * FROM odbc('DSN=pg;UID=app;PWD=S3cret;', 'shop', 'users')",
      "SELECT * FROM odbc('DSN=pg;UID=app;PWD=***;', 'shop', 'users')"
    ],
    [
      "SELECT * FROM url('https://b.s3.amazonaws.com/x?X-Amz-Credential=AK&X-Amz-Signature=abc123', CSV)",
      "SELECT * FROM url('https://b.s3.amazonaws.com/x?X-Amz-Credential=AK&X-Amz-Signature=***', CSV)"
    ],
    // Named collections: the secret is a named argument.
    [
      "SELECT * FROM mysql(mysql_creds, table = 'users', password = 'pw')",
      "SELECT * FROM mysql(mysql_creds, table = 'users', password = '***')"
    ],
    [
      "SELECT * FROM azureBlobStorage(az, blob_path = 'p', account_key = 'KEY')",
      "SELECT * FROM azureBlobStorage(az, blob_path = 'p', account_key = '***')"
    ]
  ]
  it.each(positional)('masks positional secret %j', (input, expected) => {
    expect(maskSqlSecrets(input)).toBe(expected)
  })

  it('leaves calls without credentials alone', () => {
    for (const text of [
      "SELECT * FROM s3('https://b/x.csv', 'CSV', 'a String')",
      "SELECT * FROM s3('https://b/x.csv', 'CSVWithNames', 'a String', 'gzip')",
      "SELECT * FROM s3('https://b/x.csv', NOSIGN, 'CSV', 'a String')",
      "SELECT * FROM s3('https://b/x.csv')",
      "SELECT * FROM azureBlobStorage('https://a', 'c', 'p.csv', 'CSV', 'auto', 'a String')",
      "SELECT * FROM remote('h:9000', system.one)",
      "SELECT * FROM remote('h:9000', db, t, 'default')",
      "SELECT * FROM remote('h:9000', db.t, 'default', cityHash64(id))",
      'INSERT INTO mysql (a, b, c, d, e) VALUES (1, 2, 3, 4, 5)',
      "SELECT mysql_version, password_hash 'alias' FROM t",
      'SELECT password_hash "alias" FROM t',
      "CREATE FUNCTION f(a text) RETURNS text AS $$ SELECT 'password' $$ LANGUAGE sql",
      'CREATE FUNCTION f(password text) RETURNS text AS $$\n  SELECT password $$ LANGUAGE sql;\n' +
        'CREATE FUNCTION g() RETURNS int AS $$\n  SELECT 1\n$$ LANGUAGE sql',
      'SELECT * FROM users WHERE password = $1'
    ]) {
      expect(maskSqlSecrets(text), text).toBe(text)
    }
  })

  it('is idempotent', () => {
    for (const [input] of [...cases, ...literalForms, ...positional]) {
      const once = maskSqlSecrets(input)
      expect(maskSqlSecrets(once), input).toBe(once)
    }
  })
})

describe('maskSqlSecrets: keywords count only where they are code', () => {
  // A string that ends in "password" is data: the old text rules took it for the PASSWORD
  // keyword, masked from its closing quote to the next opening quote, and garbled the SQL.
  const untouched: Array<[SqlDialect | undefined, string]> = [
    ['mysql', "INSERT INTO app_settings (name, value) VALUES ('smtp_password', 'Hunter2!')"],
    [undefined, "INSERT INTO app_settings (name, value) VALUES ('smtp_password', 'Hunter2!')"],
    ['mysql', "UPDATE users SET data = JSON_SET(data, '$.password', 'x') WHERE id = 1"],
    ['postgres', "SELECT * FROM settings WHERE name IN ('db_password','api_key')"],
    ['mysql', 'INSERT INTO cfg VALUES (\'{"smtp_password":"hunter2"}\')'],
    [undefined, 'INSERT INTO cfg VALUES (\'{"smtp_password":"hunter2"}\')'],
    [
      'mysql',
      "CREATE TABLE `t` (\n  `pw_hash` varchar(100) DEFAULT NULL COMMENT 'bcrypt hash of the password',\n  `email` varchar(200) NOT NULL\n)"
    ],
    ['postgres', "COMMENT ON COLUMN users.pw IS 'reset with the password'; SELECT 'x'"]
  ]
  it.each(untouched)('%s %j', (dialect, input) => {
    expect(maskSqlSecrets(input, dialect)).toBe(input)
  })

  it('masks a keyword that follows such a string', () => {
    expect(maskSqlSecrets("SELECT 'smtp_password', password 'S3cret' FROM t", 'postgres')).toBe(
      "SELECT 'smtp_password', password '***' FROM t"
    )
  })
})

describe('maskSqlSecrets: values after password', () => {
  const cases: Array<[SqlDialect | undefined, string, string]> = [
    // SQL values are never masked: NULL, columns, binds, user variables, expressions.
    ['postgres', 'UPDATE users SET password = NULL WHERE last_login IS NULL', ''],
    ['postgres', 'SELECT * FROM a JOIN b ON a.password = b.password', ''],
    ['sqlite', 'SELECT * FROM users WHERE password = :pw', ''],
    ['mysql', 'SELECT * FROM users WHERE password = @pw', ''],
    ['postgres', 'SELECT * FROM users WHERE password = $1', ''],
    ['mysql', 'SELECT * FROM users WHERE password = ?', ''],
    ['mysql', 'UPDATE t SET pwd = NULL, pwd = old_pwd', ''],
    ['mysql', 'SET NEW.password = SHA2(NEW.password, 256);', ''],
    [undefined, 'UPDATE users SET password = NULL, pwd = old_pwd WHERE password = :pw', ''],
    // The literal arguments of a call are masked, those of nested calls are not.
    [
      'postgres',
      "UPDATE users SET password = crypt('S3cretPw', gen_salt('bf')) WHERE id = 1",
      "UPDATE users SET password = crypt('***', gen_salt('bf')) WHERE id = 1"
    ],
    [
      'postgres',
      "UPDATE users SET password = md5('S3cretPw' || 'salt')",
      "UPDATE users SET password = md5('***' || '***')"
    ],
    [
      'mysql',
      "UPDATE users SET password = SHA2('S3cretPw', 256) WHERE id = 1",
      "UPDATE users SET password = SHA2('***', 256) WHERE id = 1"
    ],
    [
      'mysql',
      "SET PASSWORD FOR 'u'@'localhost' = PASSWORD('S3cretPw')",
      "SET PASSWORD FOR 'u'@'localhost' = PASSWORD('***')"
    ],
    // Concatenated literals and quoted column names.
    [
      'postgres',
      "ALTER ROLE app PASSWORD 'S3cret' || 'Pw'",
      "ALTER ROLE app PASSWORD '***' || '***'"
    ],
    ['mysql', "UPDATE users SET `password` = 'S3cretPw'", "UPDATE users SET `password` = '***'"]
  ]
  it.each(cases)('%s %j', (dialect, input, expected) => {
    expect(maskSqlSecrets(input, dialect)).toBe(expected || input)
  })
})

describe('maskSqlSecrets: connection strings', () => {
  const cases: Array<[SqlDialect | undefined, string, string]> = [
    // A quoted libpq value is masked whole, spaces and all.
    [
      'postgres',
      "SELECT dblink_connect('host=h user=u password=''S3cret Pw'' dbname=d')",
      "SELECT dblink_connect('host=h user=u password=''***'' dbname=d')"
    ],
    [
      'postgres',
      "SELECT dblink_connect(E'host=h user=u password=\\'S3cret Pw\\' dbname=d')",
      "SELECT dblink_connect(E'host=h user=u password=''***'' dbname=d')"
    ],
    [
      'postgres',
      'SELECT dblink_connect($$host=h password=S3cretPw dbname=d$$)',
      'SELECT dblink_connect($$host=h password=*** dbname=d$$)'
    ],
    [
      'clickhouse',
      "SELECT * FROM odbc('DSN=x;PWD={S3c;ret};UID=y', 't')",
      "SELECT * FROM odbc('DSN=x;PWD={***};UID=y', 't')"
    ],
    // Glued key=value outside a literal: a sample cell, prose, an error message.
    [
      'postgres',
      'host=db port=5432 password=Cell$ecret dbname=shop',
      'host=db port=5432 password=*** dbname=shop'
    ],
    [undefined, 'connect with host=db password=S3cret!x', 'connect with host=db password=***'],
    ['mysql', 'SELECT * FROM t WHERE password=NULL OR password=@pw', ''],
    // A bind concatenated into the conninfo is not a password.
    ['postgres', "SELECT dblink_connect('host=h password=' || :pw || ' dbname=x')", ''],
    // SQL inside a literal or a function body keeps its columns and parameters.
    ['postgres', "EXECUTE 'UPDATE users SET password = new_pw WHERE id = 1'", ''],
    [
      'postgres',
      'CREATE FUNCTION set_pw(p_id int, p_password text) RETURNS void AS $$\n  UPDATE users SET password = p_password, pwd = NULL WHERE id = p_id\n$$ LANGUAGE sql',
      ''
    ],
    [
      'postgres',
      "SELECT dblink_exec('host=h password = ''S3cret'' dbname=d', 'select 1')",
      "SELECT dblink_exec('host=h password = ''***'' dbname=d', 'select 1')"
    ]
  ]
  it.each(cases)('%s %j', (dialect, input, expected) => {
    expect(maskSqlSecrets(input, dialect)).toBe(expected || input)
  })
})

describe('maskSqlSecrets: SQL inside literals, bodies and comments', () => {
  const cases: Array<[SqlDialect | undefined, string, string]> = [
    [
      'postgres',
      "DO $$ BEGIN CREATE ROLE app LOGIN PASSWORD 'S3cretPw'; END $$;",
      "DO $$ BEGIN CREATE ROLE app LOGIN PASSWORD '***'; END $$;"
    ],
    [
      'postgres',
      "EXECUTE 'ALTER ROLE x PASSWORD ''S3cretPw''';",
      "EXECUTE 'ALTER ROLE x PASSWORD ''***''';"
    ],
    [
      'mysql',
      "PREPARE s FROM 'CREATE USER u IDENTIFIED BY \\'S3cretPw\\''",
      "PREPARE s FROM 'CREATE USER u IDENTIFIED BY ''***'''"
    ],
    [
      'mysql',
      "-- CREATE USER u IDENTIFIED BY 'S3cretPw'\nSELECT 1",
      "-- CREATE USER u IDENTIFIED BY '***'\nSELECT 1"
    ],
    [
      'mysql',
      "/*!80000 CREATE USER u IDENTIFIED BY 'S3cretPw' */",
      "/*!80000 CREATE USER u IDENTIFIED BY '***' */"
    ],
    [
      'mysql',
      "DELIMITER $$\nCREATE PROCEDURE p() BEGIN CREATE USER u IDENTIFIED BY 'S3cretPw'; END$$\nDELIMITER ;",
      "DELIMITER $$\nCREATE PROCEDURE p() BEGIN CREATE USER u IDENTIFIED BY '***'; END$$\nDELIMITER ;"
    ],
    [
      undefined,
      "DELIMITER $$\nCREATE PROCEDURE p() BEGIN CREATE USER u IDENTIFIED BY 'S3cretPw'; END$$\nDELIMITER ;",
      "DELIMITER $$\nCREATE PROCEDURE p() BEGIN CREATE USER u IDENTIFIED BY '***'; END$$\nDELIMITER ;"
    ],
    // PostgreSQL's error context quotes the statement as an identifier.
    [
      'postgres',
      'CONTEXT: SQL statement "ALTER ROLE app PASSWORD \'S3cretPw\'"',
      'CONTEXT: SQL statement "ALTER ROLE app PASSWORD \'***\'"'
    ],
    // A MySQL syntax error echoes the statement inside unescaped quotes.
    [
      'mysql',
      "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'CREAT USER 'u'@'%' IDENTIFIED BY 'TopSecret1'' at line 1",
      "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'CREAT USER 'u'@'%' IDENTIFIED BY '***'' at line 1"
    ]
  ]
  it.each(cases)('%s %j', (dialect, input, expected) => {
    const masked = maskSqlSecrets(input, dialect)
    expect(masked).toBe(expected)
    expect(maskSqlSecrets(masked, dialect)).toBe(masked)
  })

  it('reads strings with the dialect’s escapes', () => {
    // PostgreSQL: a backslash is an ordinary character, so the string ends after it.
    expect(maskSqlSecrets("SELECT 'C:\\', password 'S3cret'", 'postgres')).toBe(
      "SELECT 'C:\\', password '***'"
    )
    // MySQL: \' is an escaped quote inside the string.
    expect(maskSqlSecrets("SELECT 'it\\'s', password 'S3cret'", 'mysql')).toBe(
      "SELECT 'it\\'s', password '***'"
    )
    expect(maskSqlSecrets("SELECT 'it\\'s', password 'S3cret'")).toBe(
      "SELECT 'it\\'s', password '***'"
    )
  })

  it('reads apostrophes of prose around SQL as letters (assistant questions, history turns)', () => {
    for (const dialect of [undefined, 'postgres', 'mysql'] as const) {
      expect(
        maskSqlSecrets("what's wrong with ALTER USER app PASSWORD 'QPw1'? it's weird", dialect)
      ).toBe("what's wrong with ALTER USER app PASSWORD '***'? it's weird")
      expect(
        maskSqlSecrets(
          "I'm running CREATE USER u IDENTIFIED BY 'QPw2' and it doesn't work",
          dialect
        )
      ).toBe("I'm running CREATE USER u IDENTIFIED BY '***' and it doesn't work")
    }
    // Doubled and escaped quotes inside strings are still quotes.
    expect(maskSqlSecrets("SELECT 'it''s', password 'S3cret'", 'postgres')).toBe(
      "SELECT 'it''s', password '***'"
    )
  })

  it('masks a half-typed password', () => {
    expect(maskSqlSecrets("CREATE USER u IDENTIFIED BY 'S3cr", 'mysql')).toBe(
      "CREATE USER u IDENTIFIED BY '***'"
    )
  })
})

describe('maskSqlSecrets: memo', () => {
  it('returns the same result for a large text it masked before, per dialect', () => {
    const text = `${'SELECT 1;\n'.repeat(1_000)}SELECT 'C:\\', password 'S3cret'`
    const pg = maskSqlSecrets(text, 'postgres')
    expect(pg.endsWith("password '***'")).toBe(true)
    expect(maskSqlSecrets(text, 'postgres')).toBe(pg)
    // MySQL reads \' as an escaped quote: the same text masks differently.
    expect(maskSqlSecrets(text, 'mysql')).toBe(text)
    expect(maskSqlSecrets(text, 'postgres')).toBe(pg)
  })
})

describe('maskUrlCredentials', () => {
  it('masks the password up to the last @ of the authority', () => {
    expect(maskUrlCredentials("'mysql://app:p@ss@db:3306/shop', 'a@b'")).toBe(
      "'mysql://app:***@db:3306/shop', 'a@b'"
    )
    expect(maskUrlCredentials('see postgresql://u:pw@h/db and https://x.example/a@b')).toBe(
      'see postgresql://u:***@h/db and https://x.example/a@b'
    )
    expect(maskUrlCredentials('mongodb+srv://u@h/db')).toBe('mongodb+srv://u@h/db')
  })
})

describe('maskSqlSecrets: linear time', () => {
  const K = 128 * 1024
  const elapsed = (fn: () => void): number => {
    const t0 = performance.now()
    fn()
    return performance.now() - t0
  }

  // The old URL rule restarted at every word boundary of a long [a-z0-9+.-] run: 64 KB of 'a-'
  // took 3.4 s, and it ran on every history write and every draft persist.
  it('masks 256 KB of a-/a. runs with a URL in under 100 ms', () => {
    for (const run of ['a-', 'a.']) {
      const text = `SELECT 1 -- mysql://u:pw@h/db ${run.repeat(K)}`
      maskSqlSecrets(`${text} `) // warm up (another text: results of large texts are memoized)
      expect(elapsed(() => maskUrlCredentials(text))).toBeLessThan(100)
      expect(elapsed(() => maskSqlSecrets(text))).toBeLessThan(100)
      expect(maskSqlSecrets(text)).toContain('mysql://u:***@h/db')
    }
  })

  it('keeps the token pass linear on hostile input', () => {
    const inputs: Array<[string, SqlDialect | undefined]> = [
      [`CREATE USER u IDENTIFIED BY 'pw' ${'a-'.repeat(K)}`, undefined],
      [`CREATE USER u IDENTIFIED BY 'pw' ${'a.'.repeat(K)}`, 'mysql'],
      [`ALTER ROLE x PASSWORD 'pw' ${'a.'.repeat(K)}`, 'postgres'],
      [
        `SELECT ${Array.from({ length: 30_000 }, (_, i) => `c${i}`).join('+')} password 'x'`,
        undefined
      ],
      // Unclosed and nested secret calls: each argument list is collected once.
      [`SELECT * FROM ${'remote('.repeat(20_000)}`, 'clickhouse'],
      [
        `SELECT * FROM ${"mysql('h','d','t','u', ".repeat(8_000)}'pw'${')'.repeat(8_000)}`,
        undefined
      ],
      [
        Array.from(
          { length: 3_000 },
          () => "SELECT * FROM s3('https://b/x', 'AK', 'SK', 'CSV')"
        ).join(' UNION ALL '),
        'clickhouse'
      ],
      [`${'SET PASSWORD FOR '.repeat(20_000)}`, 'mysql'],
      ['password='.repeat(30_000), 'postgres'],
      [`${'password=a.b.c('.repeat(20_000)}`, undefined],
      [`password ${'{'.repeat(100_000)}`, undefined],
      [`EXECUTE '${"password ''x'' ".repeat(20_000)}'`, 'postgres']
    ]
    for (const [text, dialect] of inputs) {
      maskSqlSecrets(`${text} `, dialect) // warm up (another text: results are memoized)
      expect(
        elapsed(() => maskSqlSecrets(text, dialect)),
        text.slice(0, 40)
      ).toBeLessThan(500)
    }
  })
})
