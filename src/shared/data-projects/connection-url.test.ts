import { describe, expect, it } from 'vitest'

import {
  buildConnectionUrl,
  detectEngineFromUrl,
  parseConnectionUrl,
  redactConnectionUrl
} from './connection-url'
import type { DataConnectionConfig, DataEngine, DataParsedConnectionUrl } from './types'

const ok = (url: string, hint?: DataEngine): DataParsedConnectionUrl => {
  const r = parseConnectionUrl(url, hint)
  if (!r.ok) throw new Error(`expected ok for ${url}: ${r.error}`)
  return r.value
}
const err = (url: string, hint?: DataEngine): string => {
  const r = parseConnectionUrl(url, hint)
  if (r.ok) throw new Error(`expected an error for ${url}`)
  return r.error
}

describe('parseConnectionUrl: MySQL / MariaDB', () => {
  it('parses the live test URL with a percent-encoded password', () => {
    expect(ok('mysql://app:app%20pw!%40%23@127.0.0.1:13306/shop')).toEqual({
      engine: 'mysql',
      config: { host: '127.0.0.1', port: 13306, database: 'shop', user: 'app' },
      secrets: { password: 'app pw!@#' },
      suggestedName: 'shop @ 127.0.0.1',
      warnings: []
    })
  })

  const cases: Array<[string, DataEngine | undefined, Partial<DataParsedConnectionUrl>]> = [
    [
      'mysql://app:app pw!@#@127.0.0.1:13306/shop',
      undefined,
      { secrets: { password: 'app pw!@#' } }
    ],
    [
      'mysql://root@localhost/shop',
      undefined,
      { config: { host: 'localhost', port: 3306, database: 'shop', user: 'root' }, secrets: {} }
    ],
    [
      'mysql://localhost',
      undefined,
      { config: { host: 'localhost', port: 3306 }, suggestedName: 'localhost' }
    ],
    ['mysql:///shop', undefined, { config: { host: 'localhost', port: 3306, database: 'shop' } }],
    [
      'mariadb://root:rootpw@127.0.0.1:13307/shop',
      undefined,
      { engine: 'mariadb', secrets: { password: 'rootpw' } }
    ],
    ['mysql://u:p@h/db', 'mariadb', { engine: 'mariadb', warnings: [] }],
    ['mariadb://u:p@h/db', 'mysql', { engine: 'mysql' }],
    [
      'jdbc:mysql://db.example.com:3307/shop?user=me&password=pw&useSSL=true',
      undefined,
      {
        config: {
          host: 'db.example.com',
          port: 3307,
          database: 'shop',
          user: 'me',
          ssl: { mode: 'require' }
        },
        secrets: { password: 'pw' }
      }
    ],
    [
      'jdbc:mariadb://h/db?useSSL=false',
      undefined,
      {
        engine: 'mariadb',
        config: { host: 'h', port: 3306, database: 'db', ssl: { mode: 'disable' } }
      }
    ],
    [
      'mysql://h/db?ssl-mode=REQUIRED',
      undefined,
      { config: { host: 'h', port: 3306, database: 'db', ssl: { mode: 'require' } } }
    ],
    [
      'mysql://h/db?sslmode=VERIFY_IDENTITY&ssl-ca=/etc/ca.pem',
      undefined,
      {
        config: {
          host: 'h',
          port: 3306,
          database: 'db',
          ssl: { mode: 'verify-full', caPath: '/etc/ca.pem' }
        }
      }
    ],
    [
      'mysql://h/db?ssl-mode=VERIFY_CA&ssl-cert=/c.pem&ssl-key=/k.pem',
      undefined,
      {
        config: {
          host: 'h',
          port: 3306,
          database: 'db',
          ssl: { mode: 'verify-ca', certPath: '/c.pem', keyPath: '/k.pem' }
        }
      }
    ],
    [
      'mysql://h/db?ssl-ca=/ca.pem',
      undefined,
      {
        config: {
          host: 'h',
          port: 3306,
          database: 'db',
          ssl: { mode: 'verify-ca', caPath: '/ca.pem' }
        }
      }
    ],
    [
      'mysql://h/db?ssl=true',
      undefined,
      { config: { host: 'h', port: 3306, database: 'db', ssl: { mode: 'require' } } }
    ],
    [
      'mysql://h/db?ssl={"rejectUnauthorized":false}',
      undefined,
      { config: { host: 'h', port: 3306, database: 'db', ssl: { mode: 'require' } } }
    ],
    [
      'mysql://h/db?ssl=%7B%22rejectUnauthorized%22%3Atrue%7D',
      undefined,
      { config: { host: 'h', port: 3306, database: 'db', ssl: { mode: 'verify-full' } } }
    ],
    [
      'mysql://u:p@aws.connect.psdb.cloud/db?sslaccept=strict',
      undefined,
      {
        config: {
          host: 'aws.connect.psdb.cloud',
          port: 3306,
          database: 'db',
          user: 'u',
          ssl: { mode: 'verify-full' }
        }
      }
    ],
    [
      'mysql://h/db?charset=utf8mb4&connectTimeout=5000',
      undefined,
      {
        config: {
          host: 'h',
          port: 3306,
          database: 'db',
          options: { charset: 'utf8mb4', connectTimeout: '5000' }
        }
      }
    ],
    [
      'mysql://[::1]:3307/db',
      undefined,
      { config: { host: '::1', port: 3307, database: 'db' }, suggestedName: 'db @ ::1' }
    ],
    [
      'user:pw@tcp(127.0.0.1:3306)/shop?parseTime=true',
      undefined,
      {
        engine: 'mysql',
        config: {
          host: '127.0.0.1',
          port: 3306,
          database: 'shop',
          user: 'user',
          options: { parseTime: 'true' }
        },
        secrets: { password: 'pw' }
      }
    ],
    [
      'root@unix(/tmp/mysql.sock)/shop',
      undefined,
      {
        config: {
          host: 'localhost',
          port: 3306,
          database: 'shop',
          user: 'root',
          options: { socket: '/tmp/mysql.sock' }
        }
      }
    ],
    [
      'u:p@h:3306/db',
      'mysql',
      {
        engine: 'mysql',
        config: { host: 'h', port: 3306, database: 'db', user: 'u' },
        secrets: { password: 'p' }
      }
    ]
  ]
  it.each(cases)('%j (hint %s)', (url, hint, expected) => {
    expect(ok(url, hint)).toMatchObject(expected)
  })

  it('takes the first host of a multi-host URL with a warning', () => {
    const v = ok('jdbc:mysql://h1:3306,h2:3307/db')
    expect(v.config).toMatchObject({ host: 'h1', port: 3306 })
    expect(v.warnings).toEqual(['Multi-host URL: using the first host (h1)'])
  })

  it('refuses the X protocol', () => {
    expect(err('mysqlx://u@h:33060/db')).toMatch(/X Protocol/)
  })
})

describe('parseConnectionUrl: PostgreSQL', () => {
  const cases: Array<[string, DataEngine | undefined, Partial<DataParsedConnectionUrl>]> = [
    [
      'postgres://postgres:pgpw@127.0.0.1:15432/shop',
      undefined,
      {
        engine: 'postgres',
        config: { host: '127.0.0.1', port: 15432, database: 'shop', user: 'postgres' },
        secrets: { password: 'pgpw' },
        suggestedName: 'shop @ 127.0.0.1'
      }
    ],
    ['postgresql://localhost', undefined, { config: { host: 'localhost', port: 5432 } }],
    [
      'postgresql://u@[2001:db8::1]:6432/app',
      undefined,
      { config: { host: '2001:db8::1', port: 6432, database: 'app', user: 'u' } }
    ],
    [
      'postgres://u:p@h/db?sslmode=require',
      undefined,
      { config: { host: 'h', port: 5432, database: 'db', user: 'u', ssl: { mode: 'require' } } }
    ],
    [
      'postgres://h/db?sslmode=verify-full&sslrootcert=/ca.crt&sslcert=/c.crt&sslkey=/c.key',
      undefined,
      {
        config: {
          host: 'h',
          port: 5432,
          database: 'db',
          ssl: { mode: 'verify-full', caPath: '/ca.crt', certPath: '/c.crt', keyPath: '/c.key' }
        }
      }
    ],
    [
      'postgres://h/db?sslmode=allow',
      undefined,
      { config: { host: 'h', port: 5432, database: 'db', ssl: { mode: 'prefer' } } }
    ],
    [
      'postgres://h/db?sslmode=disable',
      undefined,
      { config: { host: 'h', port: 5432, database: 'db', ssl: { mode: 'disable' } } }
    ],
    [
      'postgres://h/db?ssl=true',
      undefined,
      { config: { host: 'h', port: 5432, database: 'db', ssl: { mode: 'require' } } }
    ],
    [
      'postgres://h/db?application_name=tc&options=-c%20search_path%3Danalytics',
      undefined,
      {
        config: {
          host: 'h',
          port: 5432,
          database: 'db',
          options: { application_name: 'tc', options: '-c search_path=analytics' }
        }
      }
    ],
    [
      'jdbc:postgresql://db.example.com/shop?user=me&password=s3cret&ssl=true',
      undefined,
      {
        config: {
          host: 'db.example.com',
          port: 5432,
          database: 'shop',
          user: 'me',
          ssl: { mode: 'require' }
        },
        secrets: { password: 's3cret' }
      }
    ],
    [
      'postgres:///shop?host=/var/run/postgresql',
      undefined,
      { config: { host: '/var/run/postgresql', port: 5432, database: 'shop' } }
    ],
    ['postgresql://u:p%2Fq%3Fr%23s@h/db', undefined, { secrets: { password: 'p/q?r#s' } }],
    ['postgresql://u:50%off@h/db', undefined, { secrets: { password: '50%off' } }],
    [
      'postgresql://%E2%9C%93user@h/db',
      undefined,
      { config: { host: 'h', port: 5432, database: 'db', user: '✓user' } }
    ],
    [
      'postgres://u@h/My%20DB',
      undefined,
      {
        config: { host: 'h', port: 5432, database: 'My DB', user: 'u' },
        suggestedName: 'My DB @ h'
      }
    ],
    [
      'DATABASE_URL="postgres://u:p@h/db"',
      undefined,
      { config: { host: 'h', port: 5432, database: 'db', user: 'u' } }
    ],
    [
      "export DATABASE_URL='postgresql://u@h/db'",
      undefined,
      { config: { host: 'h', port: 5432, database: 'db', user: 'u' } }
    ],
    [
      '  <postgres://u@h/db>  ',
      undefined,
      { config: { host: 'h', port: 5432, database: 'db', user: 'u' } }
    ],
    [
      "host=localhost port=15432 dbname=shop user=postgres password='p w' sslmode=require",
      undefined,
      {
        engine: 'postgres',
        config: {
          host: 'localhost',
          port: 15432,
          database: 'shop',
          user: 'postgres',
          ssl: { mode: 'require' }
        },
        secrets: { password: 'p w' }
      }
    ],
    [
      'u:p@h:5432/db',
      'postgres',
      { engine: 'postgres', config: { host: 'h', port: 5432, database: 'db', user: 'u' } }
    ],
    [
      'postgres://u@h/db?sslpassword=keypw',
      undefined,
      {
        secrets: {},
        warnings: [
          'Dropped the "sslpassword" parameter: secrets other than the password are not stored'
        ]
      }
    ]
  ]
  it.each(cases)('%j (hint %s)', (url, hint, expected) => {
    expect(ok(url, hint)).toMatchObject(expected)
  })

  it('warns about multi-host URLs and keeps the first host', () => {
    const v = ok('postgresql://h1:5432,h2:5433/db?target_session_attrs=read-write')
    expect(v.config).toMatchObject({
      host: 'h1',
      port: 5432,
      options: { target_session_attrs: 'read-write' }
    })
    expect(v.warnings).toContain('Multi-host URL: using the first host (h1)')
  })

  it('keeps the password out of config and options', () => {
    const v = ok('postgres://u:pw@h/db?password=other&pwd=x')
    expect(v.secrets).toEqual({ password: 'pw' })
    expect(JSON.stringify(v.config)).not.toMatch(/pw|other/)
  })

  it('reports an invalid port', () => {
    expect(err('postgres://u@h:70000/db')).toBe('Invalid port "70000" (expected 1–65535)')
    expect(err('postgres://u:pa/ss@h/db')).toMatch(/percent-encode/)
  })
})

describe('parseConnectionUrl: ClickHouse', () => {
  const cases: Array<[string, DataEngine | undefined, DataConnectionConfig, string[]]> = [
    [
      'clickhouse://default:chpw@127.0.0.1:9000/shop',
      undefined,
      {
        host: '127.0.0.1',
        port: 8123,
        clickhouseProtocol: 'http',
        database: 'shop',
        user: 'default'
      },
      ['Native protocol port 9000 mapped to the HTTP port 8123']
    ],
    [
      'clickhouse://h:9440/db?secure=true',
      undefined,
      { host: 'h', port: 8443, clickhouseProtocol: 'https', database: 'db' },
      ['Native TLS port 9440 mapped to the HTTPS port 8443']
    ],
    ['clickhouse://h', undefined, { host: 'h', port: 8123, clickhouseProtocol: 'http' }, []],
    [
      'clickhouse://h?secure=true',
      undefined,
      { host: 'h', port: 8443, clickhouseProtocol: 'https' },
      []
    ],
    [
      'clickhouse://h:8443/db',
      undefined,
      { host: 'h', port: 8443, clickhouseProtocol: 'https', database: 'db' },
      []
    ],
    ['ch://h:8123', undefined, { host: 'h', port: 8123, clickhouseProtocol: 'http' }, []],
    [
      'http://127.0.0.1:18123',
      undefined,
      { host: '127.0.0.1', port: 18123, clickhouseProtocol: 'http' },
      []
    ],
    [
      'https://abc.eu-west-1.aws.clickhouse.cloud:8443',
      undefined,
      { host: 'abc.eu-west-1.aws.clickhouse.cloud', port: 8443, clickhouseProtocol: 'https' },
      []
    ],
    ['https://h', undefined, { host: 'h', port: 8443, clickhouseProtocol: 'https' }, []],
    ['http://h:8443', undefined, { host: 'h', port: 8443, clickhouseProtocol: 'http' }, []],
    [
      'jdbc:clickhouse://h:8123/db?user=u&password=p&ssl=true',
      undefined,
      { host: 'h', port: 8123, clickhouseProtocol: 'https', database: 'db', user: 'u' },
      []
    ],
    [
      'jdbc:ch:https://h:8443/db',
      undefined,
      { host: 'h', port: 8443, clickhouseProtocol: 'https', database: 'db' },
      []
    ],
    [
      'jdbc:clickhouse://h/db?ssl=true&sslmode=none',
      undefined,
      {
        host: 'h',
        port: 8443,
        clickhouseProtocol: 'https',
        database: 'db',
        ssl: { mode: 'require' }
      },
      []
    ],
    [
      'http://h:8123/?database=logs&max_execution_time=60',
      undefined,
      {
        host: 'h',
        port: 8123,
        clickhouseProtocol: 'http',
        database: 'logs',
        options: { max_execution_time: '60' }
      },
      []
    ],
    [
      'tcp://h:9000',
      'clickhouse',
      { host: 'h', port: 8123, clickhouseProtocol: 'http' },
      ['Native protocol port 9000 mapped to the HTTP port 8123']
    ]
  ]
  it.each(cases)('%j', (url, hint, config, warnings) => {
    const v = ok(url, hint)
    expect(v.engine).toBe('clickhouse')
    expect(v.config).toEqual(config)
    expect(v.warnings).toEqual(warnings)
  })

  it('moves user/password params into fields and secrets', () => {
    const v = ok('http://h:8123/?user=u&password=p')
    expect(v.config.user).toBe('u')
    expect(v.secrets).toEqual({ password: 'p' })
  })

  it('reads tcp:// as the hinted engine', () => {
    expect(ok('tcp://h:3306/db', 'mysql').engine).toBe('mysql')
  })
})

describe('parseConnectionUrl: MongoDB', () => {
  it('parses a multi-host replica set URL', () => {
    expect(
      ok(
        'mongodb://root:mongopw@127.0.0.1:27018,127.0.0.1:27019/shop?authSource=admin&replicaSet=rs0&tls=true&appName=tc'
      )
    ).toEqual({
      engine: 'mongodb',
      config: {
        host: '127.0.0.1',
        port: 27018,
        database: 'shop',
        user: 'root',
        mongo: {
          srv: false,
          hosts: ['127.0.0.1:27018', '127.0.0.1:27019'],
          authSource: 'admin',
          replicaSet: 'rs0',
          tls: true
        },
        options: { appName: 'tc' }
      },
      secrets: { password: 'mongopw' },
      suggestedName: 'shop @ 127.0.0.1',
      warnings: []
    })
  })

  const cases: Array<[string, Partial<DataParsedConnectionUrl>]> = [
    [
      'mongodb://127.0.0.1:27018',
      {
        config: {
          host: '127.0.0.1',
          port: 27018,
          mongo: { srv: false, hosts: ['127.0.0.1:27018'] }
        },
        suggestedName: '127.0.0.1'
      }
    ],
    [
      'mongodb://localhost',
      {
        config: {
          host: 'localhost',
          port: 27017,
          mongo: { srv: false, hosts: ['localhost:27017'] }
        }
      }
    ],
    [
      'mongodb://h1,h2:27020/?directConnection=false',
      {
        config: {
          host: 'h1',
          port: 27017,
          mongo: { srv: false, hosts: ['h1:27017', 'h2:27020'], directConnection: false }
        }
      }
    ],
    [
      'mongodb+srv://u:p%40ss@cluster0.abc.mongodb.net/shop?retryWrites=true&w=majority',
      {
        config: {
          host: 'cluster0.abc.mongodb.net',
          database: 'shop',
          user: 'u',
          mongo: { srv: true, hosts: ['cluster0.abc.mongodb.net'], tls: true },
          options: { retryWrites: 'true', w: 'majority' }
        },
        secrets: { password: 'p@ss' }
      }
    ],
    [
      'mongodb+srv://c.mongodb.net/?tls=false',
      {
        config: {
          host: 'c.mongodb.net',
          mongo: { srv: true, hosts: ['c.mongodb.net'], tls: false }
        }
      }
    ],
    [
      'mongodb://[::1]:27017/db',
      {
        config: {
          host: '::1',
          port: 27017,
          database: 'db',
          mongo: { srv: false, hosts: ['[::1]:27017'] }
        }
      }
    ],
    [
      'mongodb://u@h/db?authMechanism=SCRAM-SHA-256&readPreference=secondaryPreferred',
      {
        config: {
          mongo: {
            srv: false,
            hosts: ['h:27017'],
            authMechanism: 'SCRAM-SHA-256',
            readPreference: 'secondaryPreferred'
          }
        }
      }
    ],
    [
      'mongodb://h/?ssl=true&tlsAllowInvalidCertificates=true',
      {
        config: {
          host: 'h',
          port: 27017,
          mongo: { srv: false, hosts: ['h:27017'], tls: true, tlsAllowInvalidCertificates: true }
        }
      }
    ],
    [
      'mongodb://h/?tls=true&tlsInsecure=true',
      {
        config: {
          host: 'h',
          port: 27017,
          mongo: { srv: false, hosts: ['h:27017'], tls: true, tlsAllowInvalidCertificates: true }
        }
      }
    ],
    [
      'mongodb://h/?tls=true&tlsCAFile=/ca.pem&tlsCertificateKeyFile=/client.pem',
      {
        config: {
          host: 'h',
          port: 27017,
          ssl: { mode: 'verify-full', caPath: '/ca.pem', certPath: '/client.pem' },
          mongo: { srv: false, hosts: ['h:27017'], tls: true }
        }
      }
    ],
    [
      'mongodb://h/?authMechanism=MONGODB-X509&tls=true',
      {
        secrets: {},
        config: {
          mongo: { srv: false, hosts: ['h:27017'], authMechanism: 'MONGODB-X509', tls: true }
        }
      }
    ]
  ]
  it.each(cases)('%j', (url, expected) => {
    expect(ok(url)).toMatchObject(expected)
  })

  it('drops secret parameters with a warning', () => {
    const v = ok(
      'mongodb://u:p@h/?tls=true&tlsCertificateKeyFilePassword=kp&authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:tok'
    )
    expect(JSON.stringify(v.config)).not.toMatch(/kp|tok/)
    expect(v.warnings).toEqual([
      'Dropped the "tlsCertificateKeyFilePassword" parameter: secrets other than the password are not stored',
      'Dropped authMechanismProperties: it contains a session token or secret'
    ])
  })

  const errors: Array<[string, RegExp]> = [
    ['mongodb+srv://u@c.mongodb.net:27017/db', /cannot have a port/],
    ['mongodb+srv://u@a.net,b.net/db', /exactly one host/],
    ['mongodb:///db', /no host/]
  ]
  it.each(errors)('%j → error', (url, message) => {
    expect(err(url)).toMatch(message)
  })
})

describe('parseConnectionUrl: SQLite', () => {
  const cases: Array<[string, DataEngine | undefined, DataConnectionConfig, string]> = [
    [
      '/Users/me/shop.sqlite',
      undefined,
      { filePath: '/Users/me/shop.sqlite', database: 'main' },
      'shop'
    ],
    ['~/data/app.db', undefined, { filePath: '~/data/app.db', database: 'main' }, 'app'],
    [
      'sqlite:///Users/me/My%20DB.db',
      undefined,
      { filePath: '/Users/me/My DB.db', database: 'main' },
      'My DB'
    ],
    ['sqlite:////tmp/x.db', undefined, { filePath: '/tmp/x.db', database: 'main' }, 'x'],
    ['sqlite3:///tmp/x.sqlite3', undefined, { filePath: '/tmp/x.sqlite3', database: 'main' }, 'x'],
    ['sqlite://localhost/tmp/x.db', undefined, { filePath: '/tmp/x.db', database: 'main' }, 'x'],
    ['sqlite://~/x.db', undefined, { filePath: '~/x.db', database: 'main' }, 'x'],
    [
      'file:/tmp/x.db?mode=ro',
      undefined,
      { filePath: '/tmp/x.db', database: 'main', readOnlyFile: true },
      'x'
    ],
    [
      'file:///tmp/x.db?mode=rw&cache=shared',
      undefined,
      {
        filePath: '/tmp/x.db',
        database: 'main',
        readOnlyFile: false,
        options: { cache: 'shared' }
      },
      'x'
    ],
    [
      'file:/tmp/x.db?immutable=1',
      undefined,
      { filePath: '/tmp/x.db', database: 'main', readOnlyFile: true },
      'x'
    ],
    ['jdbc:sqlite:/tmp/x.db', undefined, { filePath: '/tmp/x.db', database: 'main' }, 'x'],
    [
      'jdbc:sqlite:/tmp/x.db?open_mode=1',
      undefined,
      { filePath: '/tmp/x.db', database: 'main', readOnlyFile: true },
      'x'
    ],
    [
      '/tmp/no-extension',
      'sqlite',
      { filePath: '/tmp/no-extension', database: 'main' },
      'no-extension'
    ],
    [':memory:', undefined, { filePath: ':memory:', database: 'main' }, 'In-memory SQLite']
  ]
  it.each(cases)('%j', (url, hint, config, name) => {
    const v = ok(url, hint)
    expect(v.engine).toBe('sqlite')
    expect(v.config).toEqual(config)
    expect(v.suggestedName).toBe(name)
    expect(v.secrets).toEqual({})
  })

  it('warns about in-memory databases', () => {
    expect(ok(':memory:').warnings).toEqual([
      'An in-memory database starts empty and is lost when the connection closes'
    ])
  })

  it('drops a SQLCipher key parameter', () => {
    const v = ok('file:/tmp/x.db?key=secret')
    expect(v.config.options).toBeUndefined()
    expect(v.warnings[0]).toMatch(/Dropped the "key" parameter/)
  })

  const errors = ['sqlite://rel.db', 'data/app.db', 'file:x.db', 'sqlite:']
  it.each(errors)('%j → error', (url) => {
    expect(err(url)).toMatch(/absolute|no file path/)
  })
})

describe('parseConnectionUrl: hints, garbage and mismatches', () => {
  it('warns when the URL is for another engine than the hint', () => {
    const v = ok('postgres://u@h/db', 'mysql')
    expect(v.engine).toBe('postgres')
    expect(v.warnings[0]).toBe('This is a PostgreSQL connection string, not MySQL')
  })

  const garbage: Array<[string, RegExp]> = [
    ['', /Paste a connection URL/],
    ['   ', /Paste a connection URL/],
    ['hello world', /Not a recognisable connection URL/],
    ['foo://bar', /Unrecognised URL scheme "foo:\/\/"/],
    ['redis://localhost:6379', /Redis is not supported/],
    ['sqlserver://h;database=x', /SQL Server is not supported/],
    ['mysql://u@h:abc/db', /Invalid port "abc"/],
    ['mysql://u@[::1/db', /Invalid IPv6 host/]
  ]
  it.each(garbage)('%j → error', (url, message) => {
    expect(err(url)).toMatch(message)
  })
})

describe('detectEngineFromUrl', () => {
  const cases: Array<[string, DataEngine | null]> = [
    ['mysql://h', 'mysql'],
    ['jdbc:mysql://h', 'mysql'],
    ['mariadb://h', 'mariadb'],
    ['postgres://h', 'postgres'],
    ['postgresql://h', 'postgres'],
    ['jdbc:postgresql://h/db', 'postgres'],
    ['host=h dbname=d', 'postgres'],
    ['clickhouse://h', 'clickhouse'],
    ['https://x.clickhouse.cloud:8443', 'clickhouse'],
    ['jdbc:ch://h', 'clickhouse'],
    ['mongodb://h', 'mongodb'],
    ['mongodb+srv://c.net', 'mongodb'],
    ['/tmp/x.db', 'sqlite'],
    ['file:/tmp/x.db', 'sqlite'],
    ['jdbc:sqlite:/x.db', 'sqlite'],
    ['u:p@tcp(h:3306)/db', 'mysql'],
    ['redis://h', null],
    ['nonsense', null],
    ['', null]
  ]
  it.each(cases)('%j → %s', (url, expected) => {
    expect(detectEngineFromUrl(url)).toBe(expected)
  })
})

describe('buildConnectionUrl', () => {
  const cases: Array<[DataEngine, DataConnectionConfig, string | undefined, string]> = [
    [
      'mysql',
      { host: '127.0.0.1', port: 13306, user: 'app', database: 'shop' },
      undefined,
      'mysql://app@127.0.0.1:13306/shop'
    ],
    [
      'mysql',
      { host: '127.0.0.1', port: 13306, user: 'app', database: 'shop' },
      'app pw!@#',
      'mysql://app:app%20pw!%40%23@127.0.0.1:13306/shop'
    ],
    [
      'mariadb',
      { host: 'h', port: 3306, ssl: { mode: 'verify-full', caPath: '/ca.pem' } },
      undefined,
      'mariadb://h:3306/?ssl-mode=VERIFY_IDENTITY&ssl-ca=%2Fca.pem'
    ],
    [
      'postgres',
      { host: 'h', port: 5432, user: 'u', database: 'db', ssl: { mode: 'require' } },
      undefined,
      'postgresql://u@h:5432/db?sslmode=require'
    ],
    [
      'postgres',
      { host: '::1', port: 5432, database: 'db' },
      undefined,
      'postgresql://[::1]:5432/db'
    ],
    [
      'postgres',
      { host: 'h', user: 'u', options: { application_name: 'tc' } },
      undefined,
      'postgresql://u@h:5432/?application_name=tc'
    ],
    [
      'clickhouse',
      { host: 'h', port: 8443, clickhouseProtocol: 'https', user: 'default', database: 'logs' },
      'pw',
      'https://default:pw@h:8443/logs'
    ],
    ['clickhouse', { host: 'h' }, undefined, 'http://h:8123'],
    [
      'mongodb',
      {
        host: 'h1',
        port: 27017,
        user: 'root',
        database: 'shop',
        mongo: {
          srv: false,
          hosts: ['h1:27017', 'h2:27018'],
          authSource: 'admin',
          replicaSet: 'rs0',
          tls: true
        }
      },
      'mongopw',
      'mongodb://root:mongopw@h1:27017,h2:27018/shop?authSource=admin&replicaSet=rs0&tls=true'
    ],
    [
      'mongodb',
      {
        host: 'c.mongodb.net',
        user: 'u',
        mongo: { srv: true, hosts: ['c.mongodb.net'], tls: true }
      },
      undefined,
      'mongodb+srv://u@c.mongodb.net'
    ],
    ['mongodb', { host: 'localhost', port: 27018 }, undefined, 'mongodb://localhost:27018'],
    [
      'sqlite',
      { filePath: '/Users/me/My DB.db', readOnlyFile: true },
      undefined,
      'sqlite:///Users/me/My%20DB.db?mode=ro'
    ],
    ['sqlite', { filePath: '~/x.db' }, undefined, 'sqlite://~/x.db']
  ]
  it.each(cases)('%s %j', (engine, config, password, expected) => {
    expect(buildConnectionUrl(engine, config, password === undefined ? {} : { password })).toBe(
      expected
    )
  })

  const roundTrips = [
    'mysql://app:app%20pw!%40%23@127.0.0.1:13306/shop?ssl-mode=REQUIRED&charset=utf8mb4',
    'postgresql://postgres:pgpw@127.0.0.1:15432/shop?sslmode=verify-full&sslrootcert=%2Fca.crt',
    'https://default:chpw@h:8443/shop',
    'mongodb://root:mongopw@127.0.0.1:27018,127.0.0.1:27019/shop?authSource=admin&replicaSet=rs0',
    'mongodb+srv://u:p@cluster0.abc.mongodb.net/shop?retryWrites=true',
    'sqlite:///tmp/My%20DB.db?mode=ro'
  ]
  it.each(roundTrips)('parse → build (with password) → parse is stable for %j', (url) => {
    const first = ok(url)
    const rebuilt = buildConnectionUrl(first.engine, first.config, first.secrets)
    const second = ok(rebuilt)
    expect(second.engine).toBe(first.engine)
    expect(second.config).toEqual(first.config)
    expect(second.secrets).toEqual(first.secrets)
  })

  it('never includes the password unless asked to', () => {
    const v = ok('postgres://u:secret@h/db')
    expect(buildConnectionUrl(v.engine, v.config)).not.toContain('secret')
  })
})

describe('redactConnectionUrl', () => {
  const cases: Array<[string, string]> = [
    ['postgres://u:p@h:5432/db', 'postgres://u:***@h:5432/db'],
    [
      'failed: mysql://app:app%20pw!%40%23@127.0.0.1:13306/shop (timeout)',
      'failed: mysql://app:***@127.0.0.1:13306/shop (timeout)'
    ],
    ['mongodb+srv://u:p@ss@c.net/db', 'mongodb+srv://u:***@c.net/db'],
    ['jdbc:mysql://u:p@h/db', 'jdbc:mysql://u:***@h/db'],
    ['mongodb://u@h/db', 'mongodb://u@h/db'],
    ['https://h:8443/?user=u&password=p&x=1', 'https://h:8443/?user=u&password=***&x=1'],
    ["host=h password='p w' dbname=d", "host=h password='***' dbname=d"],
    ['host=h password=pw dbname=d', 'host=h password=*** dbname=d'],
    [
      'a: mysql://x:y@h and b: postgres://p:q@k/d',
      'a: mysql://x:***@h and b: postgres://p:***@k/d'
    ],
    ['nothing secret here', 'nothing secret here'],
    ['', '']
  ]
  it.each(cases)('%j', (input, expected) => {
    expect(redactConnectionUrl(input)).toBe(expected)
  })

  it('is linear on long scheme-like runs', () => {
    for (const run of ['a-', 'a.']) {
      const text = `${run.repeat(128 * 1024)} postgres://u:p@h/db`
      const t0 = performance.now()
      expect(redactConnectionUrl(text)).toContain('postgres://u:***@h/db')
      expect(performance.now() - t0).toBeLessThan(100)
    }
  })
})

describe('SQLite path normalisation', () => {
  it('resolves dot segments', () => {
    const a = parseConnectionUrl('/tmp/work/cdp/../dp/shop.sqlite')
    expect(a.ok && a.value.config.filePath).toBe('/tmp/work/dp/shop.sqlite')
    const b = parseConnectionUrl('sqlite:///a/./b/../c.db')
    expect(b.ok && b.value.config.filePath).toBe('/a/c.db')
    const c = parseConnectionUrl('~/x/../shop.db', 'sqlite')
    expect(c.ok && c.value.config.filePath).toBe('~/shop.db')
  })
})
