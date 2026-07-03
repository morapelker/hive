import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DatabaseService } from './database'

const tempDirs: string[] = []
let databaseLoadError: Error | null = null

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch (error) {
    databaseLoadError = error as Error
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

const makeDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-connection-history-'))
  tempDirs.push(dir)
  return join(dir, 'state.sqlite')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describeIf('connection_history', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  it('creates the connection_history table with the expected index', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    expect(db.tableExists('connection_history')).toBe(true)
    const indexNames = db.getIndexes().map((i) => i.name)
    expect(indexNames).toContain('idx_connection_history_last_used')

    db.close()
  })

  it('dedupes order-insensitively and bumps use_count + last_used_at on repeat upsert', async () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    const first = db.upsertConnectionHistory(['project-b', 'project-a'])
    expect(first).not.toBeNull()
    expect(first?.project_ids).toBe(JSON.stringify(['project-a', 'project-b']))
    expect(first?.project_set_key).toBe('project-a|project-b')
    expect(first?.use_count).toBe(1)

    await sleep(10)

    const second = db.upsertConnectionHistory(['project-a', 'project-b'])
    expect(second).not.toBeNull()
    expect(second?.id).toBe(first?.id)
    expect(second?.use_count).toBe(2)
    expect(second && first && second.last_used_at >= first.last_used_at).toBe(true)

    const rows = db
      .getRawDb()
      .prepare('SELECT COUNT(*) as count FROM connection_history')
      .get() as {
      count: number
    }
    expect(rows.count).toBe(1)

    db.close()
  })

  it('returns null and writes no row for fewer than 2 distinct project ids', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    expect(db.upsertConnectionHistory(['project-a', 'project-a'])).toBeNull()
    expect(db.upsertConnectionHistory(['project-a'])).toBeNull()
    expect(db.upsertConnectionHistory([])).toBeNull()

    const rows = db
      .getRawDb()
      .prepare('SELECT COUNT(*) as count FROM connection_history')
      .get() as {
      count: number
    }
    expect(rows.count).toBe(0)

    db.close()
  })

  it('getRecentConnectionHistory orders by recency and respects the limit', async () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    const older = db.upsertConnectionHistory(['project-a', 'project-b'])
    await sleep(10)
    const newer = db.upsertConnectionHistory(['project-c', 'project-d'])
    expect(older).not.toBeNull()
    expect(newer).not.toBeNull()

    let recent = db.getRecentConnectionHistory()
    expect(recent.map((r) => r.id)).toEqual([newer?.id, older?.id])

    await sleep(10)
    // Bump the older entry so it becomes the most recent.
    db.upsertConnectionHistory(['project-b', 'project-a'])

    recent = db.getRecentConnectionHistory()
    expect(recent.map((r) => r.id)).toEqual([older?.id, newer?.id])

    const limited = db.getRecentConnectionHistory(1)
    expect(limited.length).toBe(1)
    expect(limited[0].id).toBe(older?.id)

    db.close()
  })
})
