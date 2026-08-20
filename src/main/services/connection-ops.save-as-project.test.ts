import { existsSync, lstatSync, mkdtempSync, rmSync } from 'fs'
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
import { createConnectionOp, saveConnectionAsProjectOp } from './connection-ops'

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
  const dir = mkdtempSync(join(tmpdir(), 'hive-save-as-project-'))
  tempDirs.push(dir)
  const db = new DatabaseService(join(dir, 'state.sqlite'))
  db.init()
  return db
}

const stubHome = (): string => {
  const tempHome = mkdtempSync(join(tmpdir(), 'hive-save-as-project-home-'))
  tempHomes.push(tempHome)
  vi.stubEnv('HOME', tempHome)
  return tempHome
}

const symlinkExists = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

const seedProject = (db: DatabaseService, name: string): Project =>
  db.createProject({ name, path: `/tmp/hive-save-as-project-fixtures/${name}` })

const seedWorktree = (db: DatabaseService, project: Project, name: string): Worktree =>
  db.createWorktree({
    project_id: project.id,
    name,
    branch_name: name,
    path: `/tmp/hive-save-as-project-fixtures/${project.name}/${name}`
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

describeIf('saveConnectionAsProjectOp', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  it('creates a kind=connection project, links the connection and symlinks member roots', async () => {
    const home = stubHome()
    const db = makeDb()

    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    const worktreeA = seedWorktree(db, projectA, 'main')
    const worktreeB = seedWorktree(db, projectB, 'main')

    const created = await createConnectionOp(db, [worktreeA.id, worktreeB.id])
    expect(created.success).toBe(true)
    const connectionId = created.connection!.id

    const result = await saveConnectionAsProjectOp(db, connectionId)
    expect(result.success).toBe(true)
    const project = result.project!
    expect(project.kind).toBe('connection')
    expect(project.detected_icon).toBe('none')
    expect(project.name).toBe('proja + projb')
    expect(JSON.parse(project.member_project_ids ?? '[]')).toEqual([projectA.id, projectB.id])
    // Path is a dedicated dir under ~/.hive/connection-projects with a symlink per member root
    expect(project.path.startsWith(join(home, '.hive', 'connection-projects'))).toBe(true)
    expect(existsSync(project.path)).toBe(true)
    expect(symlinkExists(join(project.path, 'proja'))).toBe(true)
    expect(symlinkExists(join(project.path, 'projb'))).toBe(true)

    // Source connection linked back as the first instance
    expect(result.connection?.saved_project_id).toBe(project.id)
    expect(db.getConnection(connectionId)?.saved_project_id).toBe(project.id)

    // Round-trips through getAllProjects (mapProjectRow spread)
    const fetched = db.getAllProjects().find((p) => p.id === project.id)
    expect(fetched?.kind).toBe('connection')

    db.close()
  })

  it('uses the custom name when the connection was renamed', async () => {
    stubHome()
    const db = makeDb()

    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    const worktreeA = seedWorktree(db, projectA, 'main')
    const worktreeB = seedWorktree(db, projectB, 'main')

    const created = await createConnectionOp(db, [worktreeA.id, worktreeB.id])
    db.updateConnection(created.connection!.id, { custom_name: 'My Stack' })

    const result = await saveConnectionAsProjectOp(db, created.connection!.id)
    expect(result.success).toBe(true)
    expect(result.project?.name).toBe('My Stack')

    db.close()
  })

  it('rejects single-project connections and already-saved connections', async () => {
    stubHome()
    const db = makeDb()

    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    const worktreeA1 = seedWorktree(db, projectA, 'main')
    const worktreeA2 = seedWorktree(db, projectA, 'feature')
    const worktreeB = seedWorktree(db, projectB, 'main')

    const single = await createConnectionOp(db, [worktreeA1.id, worktreeA2.id])
    const singleResult = await saveConnectionAsProjectOp(db, single.connection!.id)
    expect(singleResult.success).toBe(false)
    expect(singleResult.error).toMatch(/at least 2 projects/)

    const multi = await createConnectionOp(db, [worktreeA1.id, worktreeB.id])
    const first = await saveConnectionAsProjectOp(db, multi.connection!.id)
    expect(first.success).toBe(true)
    const second = await saveConnectionAsProjectOp(db, multi.connection!.id)
    expect(second.success).toBe(false)
    expect(second.error).toMatch(/already saved/)

    expect((await saveConnectionAsProjectOp(db, 'missing')).success).toBe(false)

    db.close()
  })

  it('deleting the saved project nulls connections.saved_project_id (instance survives)', async () => {
    stubHome()
    const db = makeDb()

    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    const worktreeA = seedWorktree(db, projectA, 'main')
    const worktreeB = seedWorktree(db, projectB, 'main')

    const created = await createConnectionOp(db, [worktreeA.id, worktreeB.id])
    const saved = await saveConnectionAsProjectOp(db, created.connection!.id)
    expect(saved.success).toBe(true)

    db.deleteProject(saved.project!.id)
    const connection = db.getConnection(created.connection!.id)
    expect(connection).not.toBeNull()
    expect(connection?.saved_project_id).toBeNull()

    db.close()
  })

  it('createConnectionOp with savedProjectId links the new connection as an instance', async () => {
    stubHome()
    const db = makeDb()

    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    const worktreeA = seedWorktree(db, projectA, 'main')
    const worktreeB = seedWorktree(db, projectB, 'main')

    const source = await createConnectionOp(db, [worktreeA.id, worktreeB.id])
    const saved = await saveConnectionAsProjectOp(db, source.connection!.id)

    const worktreeA2 = seedWorktree(db, projectA, 'tick')
    const worktreeB2 = seedWorktree(db, projectB, 'tick')
    const instance = await createConnectionOp(db, [worktreeA2.id, worktreeB2.id], saved.project!.id)
    expect(instance.success).toBe(true)
    expect(instance.connection?.saved_project_id).toBe(saved.project!.id)

    db.close()
  })
})
