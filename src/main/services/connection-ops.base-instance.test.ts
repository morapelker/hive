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
import {
  BASE_INSTANCE_LOCKED_ERROR,
  addConnectionMemberOp,
  createConnectionOp,
  deleteBaseInstanceForProjectOp,
  deleteConnectionOp,
  ensureBaseInstanceForConnectionProjectOp,
  ensureConnectionProjectBaseInstancesOp,
  getRecentConnectionsOp,
  isLockedBaseInstance,
  removeConnectionMemberOp,
  saveConnectionAsProjectOp,
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
  const dir = mkdtempSync(join(tmpdir(), 'hive-base-instance-'))
  tempDirs.push(dir)
  const db = new DatabaseService(join(dir, 'state.sqlite'))
  db.init()
  return db
}

const stubHome = (): string => {
  const tempHome = mkdtempSync(join(tmpdir(), 'hive-base-instance-home-'))
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
  db.createProject({ name, path: `/tmp/hive-base-instance-fixtures/${name}` })

const seedWorktree = (
  db: DatabaseService,
  project: Project,
  name: string,
  isDefault = false
): Worktree =>
  db.createWorktree({
    project_id: project.id,
    name,
    branch_name: name,
    path: isDefault
      ? project.path
      : `/tmp/hive-base-instance-fixtures/${project.name}/${name}`,
    is_default: isDefault
  })

/** Two projects, each with a default ("main") worktree and a feature worktree, connected + saved. */
const seedSavedProject = async (
  db: DatabaseService
): Promise<{
  projectA: Project
  projectB: Project
  defaultA: Worktree
  defaultB: Worktree
  featureA: Worktree
  featureB: Worktree
  sourceConnectionId: string
  saved: Awaited<ReturnType<typeof saveConnectionAsProjectOp>>
}> => {
  const projectA = seedProject(db, 'proja')
  const projectB = seedProject(db, 'projb')
  const defaultA = seedWorktree(db, projectA, 'main', true)
  const defaultB = seedWorktree(db, projectB, 'master', true)
  const featureA = seedWorktree(db, projectA, 'feature')
  const featureB = seedWorktree(db, projectB, 'feature')
  const created = await createConnectionOp(db, [featureA.id, featureB.id])
  expect(created.success).toBe(true)
  const saved = await saveConnectionAsProjectOp(db, created.connection!.id)
  expect(saved.success).toBe(true)
  return {
    projectA,
    projectB,
    defaultA,
    defaultB,
    featureA,
    featureB,
    sourceConnectionId: created.connection!.id,
    saved
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const tempHome of tempHomes.splice(0)) {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

describeIf('connection project base instances', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  it('saveConnectionAsProjectOp creates a base instance over the member default worktrees', async () => {
    const home = stubHome()
    const db = makeDb()
    const { defaultA, defaultB, sourceConnectionId, saved } = await seedSavedProject(db)
    const projectId = saved.project!.id

    const base = saved.baseConnection
    expect(base).toBeDefined()
    expect(base!.is_base).toBe(1)
    expect(base!.saved_project_id).toBe(projectId)
    expect(base!.id).not.toBe(sourceConnectionId)
    expect(base!.members.map((m) => m.worktree_id).sort()).toEqual([defaultA.id, defaultB.id].sort())
    expect(base!.members.map((m) => m.worktree_branch).sort()).toEqual(['main', 'master'])

    // Lives in the regular connections dir with a symlink per member root
    expect(base!.path.startsWith(join(home, '.hive', 'connections'))).toBe(true)
    expect(symlinkExists(join(base!.path, 'proja'))).toBe(true)
    expect(symlinkExists(join(base!.path, 'projb'))).toBe(true)

    // Queryable as the project's base, listed among active connections, source is NOT base
    expect(db.getBaseConnectionForProject(projectId)?.id).toBe(base!.id)
    expect(db.getAllConnections().find((c) => c.id === base!.id)?.is_base).toBe(1)
    expect(db.getConnection(sourceConnectionId)?.is_base).toBe(0)

    db.close()
  })

  it('creating the base instance does not bump connection history', async () => {
    stubHome()
    const db = makeDb()
    await seedSavedProject(db)

    // The user-created source connection recorded the project set exactly once;
    // the structural base instance must not count as another "use".
    const recent = getRecentConnectionsOp(db)
    expect(recent.success).toBe(true)
    expect(recent.entries).toHaveLength(1)
    expect(recent.entries![0].use_count).toBe(1)

    db.close()
  })

  it('refuses to delete the base instance unless forced', async () => {
    stubHome()
    const db = makeDb()
    const { saved } = await seedSavedProject(db)
    const base = saved.baseConnection!

    const refused = await deleteConnectionOp(db, base.id)
    expect(refused.success).toBe(false)
    expect(refused.error).toBe(BASE_INSTANCE_LOCKED_ERROR)
    expect(db.getConnection(base.id)).not.toBeNull()
    expect(existsSync(base.path)).toBe(true)

    const forced = await deleteConnectionOp(db, base.id, { force: true })
    expect(forced.success).toBe(true)
    expect(db.getConnection(base.id)).toBeNull()
    expect(existsSync(base.path)).toBe(false)

    db.close()
  })

  it('locks the base instance member set (add / remove / updateMembers)', async () => {
    stubHome()
    const db = makeDb()
    const { defaultA, featureA, saved } = await seedSavedProject(db)
    const base = saved.baseConnection!

    const added = await addConnectionMemberOp(db, base.id, featureA.id)
    expect(added.success).toBe(false)
    expect(added.error).toBe(BASE_INSTANCE_LOCKED_ERROR)

    const removed = await removeConnectionMemberOp(db, base.id, defaultA.id)
    expect(removed.success).toBe(false)
    expect(removed.error).toBe(BASE_INSTANCE_LOCKED_ERROR)

    const updated = await updateConnectionMembersOp(db, base.id, [featureA.id])
    expect(updated.success).toBe(false)
    expect(updated.error).toBe(BASE_INSTANCE_LOCKED_ERROR)

    expect(db.getConnection(base.id)?.members).toHaveLength(2)

    db.close()
  })

  it('ensureConnectionProjectBaseInstancesOp heals a connection project that lost its base', async () => {
    stubHome()
    const db = makeDb()
    const { defaultA, defaultB, saved } = await seedSavedProject(db)
    const projectId = saved.project!.id
    const originalBaseId = saved.baseConnection!.id

    // Simulate a project saved before base instances existed
    await deleteConnectionOp(db, originalBaseId, { force: true })
    expect(db.getBaseConnectionForProject(projectId)).toBeNull()

    await ensureConnectionProjectBaseInstancesOp(db)
    const healed = db.getBaseConnectionForProject(projectId)
    expect(healed).not.toBeNull()
    expect(healed!.id).not.toBe(originalBaseId)
    expect(healed!.is_base).toBe(1)
    expect(healed!.members.map((m) => m.worktree_id).sort()).toEqual([defaultA.id, defaultB.id].sort())

    // Idempotent: a second pass keeps the same base and creates nothing new
    await ensureConnectionProjectBaseInstancesOp(db)
    expect(db.getBaseConnectionForProject(projectId)?.id).toBe(healed!.id)
    expect(db.getAllConnections().filter((c) => c.is_base && c.saved_project_id === projectId)).toHaveLength(1)

    db.close()
  })

  it('skips the base (save still succeeds) when fewer than 2 member default worktrees exist', async () => {
    stubHome()
    const db = makeDb()
    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    seedWorktree(db, projectA, 'main', true) // only A has a default worktree
    const featureA = seedWorktree(db, projectA, 'feature')
    const featureB = seedWorktree(db, projectB, 'feature')

    const created = await createConnectionOp(db, [featureA.id, featureB.id])
    const saved = await saveConnectionAsProjectOp(db, created.connection!.id)
    expect(saved.success).toBe(true)
    expect(saved.baseConnection).toBeUndefined()
    expect(db.getBaseConnectionForProject(saved.project!.id)).toBeNull()
    expect(await ensureBaseInstanceForConnectionProjectOp(db, saved.project!)).toBeNull()
    // Non-connection projects never get a base
    expect(await ensureBaseInstanceForConnectionProjectOp(db, projectA)).toBeNull()

    db.close()
  })

  it('deleteBaseInstanceForProjectOp removes the base (row + dir) and is a no-op without one', async () => {
    stubHome()
    const db = makeDb()
    const { sourceConnectionId, saved } = await seedSavedProject(db)
    const projectId = saved.project!.id
    const base = saved.baseConnection!

    expect((await deleteBaseInstanceForProjectOp(db, projectId)).success).toBe(true)
    expect(db.getBaseConnectionForProject(projectId)).toBeNull()
    expect(db.getConnection(base.id)).toBeNull()
    expect(existsSync(base.path)).toBe(false)
    // The user's own instance is untouched
    expect(db.getConnection(sourceConnectionId)?.saved_project_id).toBe(projectId)

    expect((await deleteBaseInstanceForProjectOp(db, projectId)).success).toBe(true)
    expect((await deleteBaseInstanceForProjectOp(db, 'missing-project')).success).toBe(true)

    db.close()
  })
})

describeIf('connection project base instance — edge cases', () => {
  it('promotes a source connection that already spans the member default worktrees (no duplicate)', async () => {
    stubHome()
    const db = makeDb()
    const projectA = seedProject(db, 'proja')
    const projectB = seedProject(db, 'projb')
    const defaultA = seedWorktree(db, projectA, 'main', true)
    const defaultB = seedWorktree(db, projectB, 'main', true)

    // The most common connection: "main" of each project
    const created = await createConnectionOp(db, [defaultA.id, defaultB.id])
    const sourceId = created.connection!.id
    const saved = await saveConnectionAsProjectOp(db, sourceId)
    expect(saved.success).toBe(true)
    const projectId = saved.project!.id

    // The source became the base — no byte-identical twin next to it
    expect(saved.baseConnection?.id).toBe(sourceId)
    expect(saved.connection?.is_base).toBe(1)
    const instances = db.getAllConnections().filter((c) => c.saved_project_id === projectId)
    expect(instances).toHaveLength(1)
    expect(instances[0].id).toBe(sourceId)
    expect(db.getBaseConnectionForProject(projectId)?.id).toBe(sourceId)

    // Idempotent: healing does not add another one
    await ensureConnectionProjectBaseInstancesOp(db)
    expect(db.getAllConnections().filter((c) => c.saved_project_id === projectId)).toHaveLength(1)

    db.close()
  })

  it('demotes a stale base (member project removed) so it becomes deletable again', async () => {
    stubHome()
    const db = makeDb()
    const { projectA, saved } = await seedSavedProject(db)
    const projectId = saved.project!.id
    const baseId = saved.baseConnection!.id

    // Removing a member project cascades its members out of the base instance
    db.deleteProject(projectA.id)
    expect(db.getConnection(baseId)!.members).toHaveLength(1)

    await ensureConnectionProjectBaseInstancesOp(db)

    const stale = db.getConnection(baseId)!
    expect(stale.is_base).toBe(0)
    expect(isLockedBaseInstance(stale)).toBe(false)
    // No base can be built from a single member project
    expect(db.getBaseConnectionForProject(projectId)).toBeNull()
    // ...and the degenerate row is no longer refused
    expect((await deleteConnectionOp(db, baseId)).success).toBe(true)

    db.close()
  })

  it('rebuilds the base when a member project gets a different default worktree', async () => {
    stubHome()
    const db = makeDb()
    const { projectA, defaultA, defaultB, saved } = await seedSavedProject(db)
    const projectId = saved.project!.id
    const originalBaseId = saved.baseConnection!.id

    // Simulate the default worktree moving (re-add / re-clone of the project)
    db.updateWorktree(defaultA.id, { status: 'archived' })
    const newDefaultA = seedWorktree(db, projectA, 'main-2', true)

    await ensureConnectionProjectBaseInstancesOp(db)

    const base = db.getBaseConnectionForProject(projectId)!
    expect(base.id).not.toBe(originalBaseId)
    expect(base.members.map((m) => m.worktree_id).sort()).toEqual(
      [newDefaultA.id, defaultB.id].sort()
    )
    // The stale one survives as an ordinary connection (it may host sessions)
    expect(db.getConnection(originalBaseId)?.is_base).toBe(0)

    db.close()
  })

  it('unlocks and heals an orphaned base whose project vanished (older-build delete)', async () => {
    stubHome()
    const db = makeDb()
    const { saved } = await seedSavedProject(db)
    const baseId = saved.baseConnection!.id

    // An older build deletes the project row directly: the FK nulls the link
    // but leaves is_base = 1 behind.
    db.deleteProject(saved.project!.id)
    const orphan = db.getConnection(baseId)!
    expect(orphan.is_base).toBe(1)
    expect(orphan.saved_project_id).toBeNull()
    // The lock predicate already treats it as unlocked...
    expect(isLockedBaseInstance(orphan)).toBe(false)
    expect((await addConnectionMemberOp(db, baseId, saved.baseConnection!.members[0].worktree_id)).error).not.toBe(
      BASE_INSTANCE_LOCKED_ERROR
    )

    // ...and the next listing clears the flag for good
    await ensureConnectionProjectBaseInstancesOp(db)
    expect(db.getConnection(baseId)?.is_base).toBe(0)
    expect((await deleteConnectionOp(db, baseId)).success).toBe(true)

    db.close()
  })

  it('deleteBaseInstanceForProjectOp demotes instead of leaving a locked row when deletion fails', async () => {
    stubHome()
    const db = makeDb()
    const { saved } = await seedSavedProject(db)
    const baseId = saved.baseConnection!.id

    const spy = vi.spyOn(db, 'deleteConnection').mockImplementation(() => {
      throw new Error('EBUSY')
    })
    const result = await deleteBaseInstanceForProjectOp(db, saved.project!.id)
    spy.mockRestore()

    expect(result.success).toBe(false)
    // Row survived, but is no longer a locked base → deletable once detached
    const survivor = db.getConnection(baseId)!
    expect(survivor.is_base).toBe(0)
    expect((await deleteConnectionOp(db, baseId)).success).toBe(true)

    db.close()
  })
})
