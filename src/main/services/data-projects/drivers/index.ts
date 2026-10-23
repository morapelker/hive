// Driver factory: one DataDriver implementation per engine family. The driver modules are
// light; each loads its npm client (mysql2, pg, @clickhouse/client, better-sqlite3 worker,
// mongodb) lazily on first connect, so importing this file costs nothing.

import type { DataDriver, DriverConnectInput } from '../contracts'
import { createMongoDriver } from '../mongo'
import { createClickHouseDriver } from './clickhouse'
import { createMysqlDriver } from './mysql'
import { createPostgresDriver } from './postgres'
import { createSqliteDriver } from './sqlite'

export function createDriver(input: DriverConnectInput): DataDriver {
  const engine = input.project.engine
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return createMysqlDriver(input)
    case 'postgres':
      return createPostgresDriver(input)
    case 'clickhouse':
      return createClickHouseDriver(input)
    case 'sqlite':
      return createSqliteDriver(input)
    case 'mongodb':
      return createMongoDriver(input)
    default: {
      const unknown: never = engine
      throw new Error(`Unsupported database engine: ${String(unknown)}`)
    }
  }
}
