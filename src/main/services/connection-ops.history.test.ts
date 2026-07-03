import { lstatSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { DatabaseService } from '../db/database'
import type { Project, Worktree } from '../db/types'
import {
  createConnectionOp,
  getRecentConnectionsOp,
  recordConnectionHistory,
  updateConnectionMembersOp
} from './connection-ops'

const tempDirs: string[] = []
const tempHomes: string[] = []
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

const makeDb = (): DatabaseService => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-connection-ops-history-'))
  tempDirs.push(dir)
  const db = new DatabaseService(join(dir, 'state.sqlite'))
  db.init()
  return db
}

const stubHome = (): void => {
  const tempHome = mkdtempSync(join(tmpdir(), 'hive-connection-ops-home-'))
  tempHomes.push(tempHome)
  vi.stubEnv('HOME', tempHome)
}

// The symlink target paths under /tmp/hive-history-fixtures don't actually
// exist on disk, so `existsSync` (which follows the link) always reports
// false. Use `lstatSync` on the link itself to check symlink presence.
const symlinkExists = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

const seedProject = (db: DatabaseService, name: string): Project =>
  db.createProject({ name, path: `/tmp/hive-history-fixtures/${name}` })

const seedWorktree = (db: DatabaseService, project: Project, name: string): Worktree =>
  db.createWorktree({
    project_id: project.id,
    name,
    branch_name: name,
    path: `/tmp/hive-history-fixtures/${project.name}/${name}`
  })

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const tempHome of tempHomes.splice(0)) {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

describeIf('connection-ops history recording', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  it('createConnectionOp records exactly one history row with the distinct project set', async () => {
    stubHome()
    const db = makeDb()

    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    const worktreeA = seedWorktree(db, projectA, 'main')
    const worktreeB = seedWorktree(db, projectB, 'main')

    const result = await createConnectionOp(db, [worktreeA.id, worktreeB.id])
    expect(result.success).toBe(true)

    const rows = db.getRecentConnectionHistory()
    expect(rows.length).toBe(1)
    expect(JSON.parse(rows[0].project_ids).sort()).toEqual([projectA.id, projectB.id].sort())
    expect(rows[0].use_count).toBe(1)

    db.close()
  })

  it('records nothing when connection members span only one project', async () => {
    stubHome()
    const db = makeDb()

    const projectA = seedProject(db, 'proja')
    const worktreeA1 = seedWorktree(db, projectA, 'main')
    const worktreeA2 = seedWorktree(db, projectA, 'feature')

    const result = await createConnectionOp(db, [worktreeA1.id, worktreeA2.id])
    expect(result.success).toBe(true)

    const rows = db.getRecentConnectionHistory()
    expect(rows.length).toBe(0)

    db.close()
  })

  it('updateConnectionMembersOp applies the diff (add/remove members + symlinks) and records exactly one additional history row with the final set', async () => {
    stubHome()
    const db = makeDb()

    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    const projectC = seedProject(db, 'projc')
    const worktreeA = seedWorktree(db, projectA, 'main')
    const worktreeB = seedWorktree(db, projectB, 'main')
    const worktreeC = seedWorktree(db, projectC, 'main')

    const created = await createConnectionOp(db, [worktreeA.id, worktreeB.id])
    expect(created.success).toBe(true)
    const connection = created.connection!
    const symlinkB = join(
      connection.path,
      connection.members.find((m) => m.worktree_id === worktreeB.id)!.symlink_name
    )
    expect(symlinkExists(symlinkB)).toBe(true)
    expect(db.getRecentConnectionHistory().length).toBe(1)

    // Duplicate worktreeC.id to also exercise dedupe of the requested worktreeIds.
    const updated = await updateConnectionMembersOp(db, connection.id, [
      worktreeA.id,
      worktreeC.id,
      worktreeC.id
    ])
    expect(updated.success).toBe(true)
    expect(updated.connectionDeleted).toBeUndefined()
    const finalMemberIds = updated.connection!.members.map((m) => m.worktree_id).sort()
    expect(finalMemberIds).toEqual([worktreeA.id, worktreeC.id].sort())

    // Removed member's symlink is gone; added member's symlink now exists.
    expect(symlinkExists(symlinkB)).toBe(false)
    const symlinkC = join(
      connection.path,
      updated.connection!.members.find((m) => m.worktree_id === worktreeC.id)!.symlink_name
    )
    expect(symlinkExists(symlinkC)).toBe(true)

    const rowsAfterUpdate = db.getRecentConnectionHistory()
    expect(rowsAfterUpdate.length).toBe(2)
    expect(JSON.parse(rowsAfterUpdate[0].project_ids).sort()).toEqual(
      [projectA.id, projectC.id].sort()
    )

    db.close()
  })

  it('updateConnectionMembersOp returns an error when the connection does not exist', async () => {
    stubHome()
    const db = makeDb()

    const result = await updateConnectionMembersOp(db, 'missing-connection', ['worktree-1'])
    expect(result).toEqual({ success: false, error: 'Connection not found' })

    db.close()
  })

  it('propagates a sub-op failure mid-update and records no additional history', async () => {
    stubHome()
    const db = makeDb()

    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    const worktreeA = seedWorktree(db, projectA, 'main')
    const worktreeB = seedWorktree(db, projectB, 'main')

    const created = await createConnectionOp(db, [worktreeA.id, worktreeB.id])
    const connection = created.connection!
    expect(db.getRecentConnectionHistory().length).toBe(1)

    // Adds run before removes; a nonexistent worktree in `toAdd` should abort
    // the whole update before the (valid) removal of worktreeB is applied.
    const result = await updateConnectionMembersOp(db, connection.id, [
      worktreeA.id,
      'nonexistent-worktree'
    ])

    expect(result).toEqual({ success: false, error: 'Worktree not found' })
    // No history recorded for the aborted update.
    expect(db.getRecentConnectionHistory().length).toBe(1)
    // The connection is untouched -- worktreeB was never removed.
    const unchanged = db.getConnection(connection.id)
    expect(unchanged?.members.map((m) => m.worktree_id).sort()).toEqual(
      [worktreeA.id, worktreeB.id].sort()
    )

    db.close()
  })

  it('records history exactly once on a no-op (empty diff) update, bumping the existing row', async () => {
    stubHome()
    const db = makeDb()

    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    const worktreeA = seedWorktree(db, projectA, 'main')
    const worktreeB = seedWorktree(db, projectB, 'main')

    const created = await createConnectionOp(db, [worktreeA.id, worktreeB.id])
    const connection = created.connection!
    const firstRow = db.getRecentConnectionHistory()[0]
    expect(firstRow.use_count).toBe(1)

    const result = await updateConnectionMembersOp(db, connection.id, [worktreeA.id, worktreeB.id])
    expect(result.success).toBe(true)

    const rows = db.getRecentConnectionHistory()
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(firstRow.id)
    expect(rows[0].use_count).toBe(2)

    db.close()
  })

  it('getRecentConnectionsOp drops entries referencing a deleted project and caps results at 15', async () => {
    stubHome()
    const db = makeDb()

    const seeded: { a: Project; b: Project }[] = []
    for (let i = 0; i < 17; i++) {
      const a = seedProject(db, `proja-${i}`)
      const b = seedProject(db, `projb-${i}`)
      const wA = seedWorktree(db, a, 'main')
      const wB = seedWorktree(db, b, 'main')
      await createConnectionOp(db, [wA.id, wB.id])
      seeded.push({ a, b })
    }

    expect(db.getRecentConnectionHistory(50).length).toBe(17)

    // Delete a project referenced by one of the history rows.
    const deletedIndex = 5
    db.deleteProject(seeded[deletedIndex].a.id)

    const result = getRecentConnectionsOp(db)
    expect(result.success).toBe(true)
    expect(result.entries).toBeDefined()
    expect(result.entries!.length).toBe(15)

    const referencesDeletedProject = result.entries!.some((entry) =>
      entry.projects.some(
        (p) => p.id === seeded[deletedIndex].a.id || p.id === seeded[deletedIndex].b.id
      )
    )
    expect(referencesDeletedProject).toBe(false)

    for (const entry of result.entries!) {
      expect(entry.projects.length).toBeGreaterThanOrEqual(2)
      for (const project of entry.projects) {
        expect(project).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            name: expect.any(String),
            path: expect.any(String)
          })
        )
      }
    }

    db.close()
  })

  it('recordConnectionHistory swallows DB errors without throwing', () => {
    const brokenDb = {
      upsertConnectionHistory: () => {
        throw new Error('db closed')
      }
    } as unknown as DatabaseService

    expect(() => recordConnectionHistory(brokenDb, ['project-a', 'project-b'])).not.toThrow()
  })
})
