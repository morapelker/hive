import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseService } from './database'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, VOICE_HISTORY_TABLES_SQL } from './schema'

const tempDirs: string[] = []

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

const makeDb = (): DatabaseService => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-voice-history-'))
  tempDirs.push(dir)
  const db = new DatabaseService(join(dir, 'state.sqlite'))
  db.init()
  return db
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('voice history schema', () => {
  it('ships as the v48 migration', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(48)
    const migration = MIGRATIONS.find((m) => m.version === 48)
    expect(migration?.name).toBe('add_voice_history')
    expect(migration?.up).toBe(VOICE_HISTORY_TABLES_SQL)
  })
})

describeIf('voice history table', () => {
  it('creates the table and stores entries newest first', () => {
    const db = makeDb()
    try {
      expect(db.tableExists('voice_history')).toBe(true)
      const first = db.addVoiceHistory({ text: 'first', duration_ms: 1200, speech_model: 'v2' })
      db.addVoiceHistory({ text: 'second', raw_text: 'sekond', cleaned: true })
      const third = db.addVoiceHistory({ text: 'third' })

      const all = db.listVoiceHistory({ limit: 20 })
      expect(all.map((row) => row.text)).toEqual(['third', 'second', 'first'])
      expect(all[1].raw_text).toBe('sekond')
      expect(all[1].cleaned).toBe(true)
      expect(all[2]).toMatchObject({
        id: first.id,
        duration_ms: 1200,
        speech_model: 'v2',
        cleaned: false
      })
      expect(db.countVoiceHistory()).toBe(3)

      expect(db.listVoiceHistory({ limit: 1, offset: 1 }).map((r) => r.text)).toEqual(['second'])
      expect(db.listVoiceHistory({ limit: 20, query: 'SEC' }).map((r) => r.text)).toEqual([
        'second'
      ])
      expect(db.countVoiceHistory('ir')).toBe(2)
      // LIKE wildcards in the query are literal.
      expect(db.countVoiceHistory('%')).toBe(0)

      expect(db.deleteVoiceHistory(third.id)).toBe(true)
      expect(db.deleteVoiceHistory(third.id)).toBe(false)
      expect(db.countVoiceHistory()).toBe(2)
      expect(db.clearVoiceHistory()).toBe(2)
      expect(db.listVoiceHistory({ limit: 20 })).toEqual([])
    } finally {
      db.close()
    }
  })
})
