import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'

// Type for DatabaseService
type DatabaseServiceType = typeof import('../../src/main/db/database').DatabaseService

// Try to load better-sqlite3, but it may fail if compiled for Electron
let DatabaseServiceClass: DatabaseServiceType | null = null
let loadError: Error | null = null

try {
  // Dynamic import to avoid module load errors crashing the test file
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dbModule = require('../../src/main/db/database')
  DatabaseServiceClass = dbModule.DatabaseService
} catch (e) {
  loadError = e as Error
}

export function canRunDatabaseTests(): boolean {
  return DatabaseServiceClass !== null
}

export function getDatabaseLoadError(): Error | null {
  return loadError
}

export function createTestDatabase(): {
  db: InstanceType<DatabaseServiceType>
  cleanup: () => void
} {
  if (!DatabaseServiceClass) {
    throw new Error(
      'Cannot create test database: better-sqlite3 is not available. ' +
        'This usually means it was compiled for Electron but tests are running in Node.js. ' +
        'Run tests in Electron environment or rebuild better-sqlite3 for Node.js.'
    )
  }

  const testDir = join(tmpdir(), 'hive-test-' + randomUUID())
  mkdirSync(testDir, { recursive: true })
  const dbPath = join(testDir, 'test.db')

  const db = new DatabaseServiceClass(dbPath)
  db.init()

  const cleanup = (): void => {
    db.close()
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  }

  return { db, cleanup }
}
