/**
 * updateConnectionProjectMembersOp — "edit connection project": replaces the member set so
 * FUTURE instances use it, reconciles the project dir's symlinks + AGENTS.md, rebuilds the
 * base instance, and leaves every existing instance's members alone.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'fs'
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
  saveConnectionAsProjectOp,
  updateConnectionProjectMembersOp
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
  const dir = mkdtempSync(join(tmpdir(), 'hive-update-project-members-'))
  tempDirs.push(dir)
  const db = new DatabaseService(join(dir, 'state.sqlite'))
  db.init()
  return db
}

const stubHome = (): string => {
  const tempHome = mkdtempSync(join(tmpdir(), 'hive-update-project-members-home-'))
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
  db.createProject({ name, path: `/tmp/hive-update-project-members-fixtures/${name}` })

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
      : `/tmp/hive-update-project-members-fixtures/${project.name}/${name}`,
    is_default: isDefault
  })

const memberIds = (project: Project | null | undefined): string[] =>
  JSON.parse(project?.member_project_ids ?? '[]')

/** proja + projb (each with a default worktree and a "feature" worktree) connected on the feature worktrees and saved. */
const seedSavedProject = async (
  db: DatabaseService
): Promise<{
  projectA: Project
  projectB: Project
  defaultA: Worktree
  defaultB: Worktree
  featureA: Worktree
  featureB: Worktree
  saved: Project
  sourceConnectionId: string
}> => {
  const projectA = seedProject(db, 'proja')
  const projectB = seedProject(db, 'projb')
  const defaultA = seedWorktree(db, projectA, 'main', true)
  const defaultB = seedWorktree(db, projectB, 'main', true)
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
    saved: saved.project!,
    sourceConnectionId: created.connection!.id
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const tempHome of tempHomes.splice(0)) rmSync(tempHome, { recursive: true, force: true })
})

describeIf('updateConnectionProjectMembersOp', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  it('swaps a member: relinks the project dir, regenerates AGENTS.md, rebuilds the base, keeps existing instances', async () => {
    stubHome()
    const db = makeDb()
    const { projectA, projectB, defaultA, featureA, featureB, saved, sourceConnectionId } =
      await seedSavedProject(db)
    const projectC = seedProject(db, 'projc')
    const defaultC = seedWorktree(db, projectC, 'develop', true)

    const baseBefore = db.getBaseConnectionForProject(saved.id)
    expect(baseBefore).not.toBeNull()

    const result = await updateConnectionProjectMembersOp(db, saved.id, [projectA.id, projectC.id])
    expect(result.success).toBe(true)
    expect(memberIds(result.project)).toEqual([projectA.id, projectC.id])
    expect(memberIds(db.getProject(saved.id))).toEqual([projectA.id, projectC.id])

    // Project dir: projb's link is gone, projc's is there, proja's untouched
    expect(symlinkExists(join(saved.path, 'proja'))).toBe(true)
    expect(symlinkExists(join(saved.path, 'projb'))).toBe(false)
    expect(existsSync(join(saved.path, 'projb'))).toBe(false)
    expect(symlinkExists(join(saved.path, 'projc'))).toBe(true)
    const agentsMd = readFileSync(join(saved.path, 'AGENTS.md'), 'utf8')
    expect(agentsMd).toContain('projc')
    expect(agentsMd).not.toContain('projb')

    // Base instance now spans proja/main + projc/develop; the old base is demoted, not deleted
    const baseAfter = db.getBaseConnectionForProject(saved.id)
    expect(baseAfter).not.toBeNull()
    expect(baseAfter!.id).not.toBe(baseBefore!.id)
    expect(baseAfter!.members.map((m) => m.worktree_id).sort()).toEqual(
      [defaultA.id, defaultC.id].sort()
    )
    const demoted = db.getConnection(baseBefore!.id)
    expect(demoted).not.toBeNull()
    expect(demoted!.is_base).toBe(0)
    expect(demoted!.saved_project_id).toBe(saved.id)

    // The already-created (source) instance keeps the worktrees it was made of
    const source = db.getConnection(sourceConnectionId)!
    expect(source.members.map((m) => m.worktree_id).sort()).toEqual(
      [featureA.id, featureB.id].sort()
    )
    expect(source.saved_project_id).toBe(saved.id)
    expect(db.getProject(projectB.id)).not.toBeNull()

    db.close()
  })

  it('adds a third member and keeps the existing order', async () => {
    stubHome()
    const db = makeDb()
    const { projectA, projectB, saved } = await seedSavedProject(db)
    const projectC = seedProject(db, 'projc')
    seedWorktree(db, projectC, 'main', true)

    const result = await updateConnectionProjectMembersOp(db, saved.id, [
      projectA.id,
      projectB.id,
      projectC.id
    ])
    expect(result.success).toBe(true)
    expect(memberIds(result.project)).toEqual([projectA.id, projectB.id, projectC.id])
    expect(symlinkExists(join(saved.path, 'proja'))).toBe(true)
    expect(symlinkExists(join(saved.path, 'projb'))).toBe(true)
    expect(symlinkExists(join(saved.path, 'projc'))).toBe(true)
    expect(db.getBaseConnectionForProject(saved.id)!.members).toHaveLength(3)

    db.close()
  })

  it('is a no-op for an unchanged member list', async () => {
    stubHome()
    const db = makeDb()
    const { projectA, projectB, saved } = await seedSavedProject(db)
    const baseBefore = db.getBaseConnectionForProject(saved.id)!

    const result = await updateConnectionProjectMembersOp(db, saved.id, [projectA.id, projectB.id])
    expect(result.success).toBe(true)
    expect(memberIds(result.project)).toEqual([projectA.id, projectB.id])
    expect(db.getBaseConnectionForProject(saved.id)!.id).toBe(baseBefore.id)
    expect(db.getAllConnections()).toHaveLength(2)

    db.close()
  })

  it('rejects fewer than 2 members, unknown members, connection-project members and git projects', async () => {
    stubHome()
    const db = makeDb()
    const { projectA, projectB, saved } = await seedSavedProject(db)

    const tooFew = await updateConnectionProjectMembersOp(db, saved.id, [projectA.id])
    expect(tooFew.success).toBe(false)
    expect(tooFew.error).toMatch(/at least 2/)

    const duplicates = await updateConnectionProjectMembersOp(db, saved.id, [
      projectA.id,
      projectA.id
    ])
    expect(duplicates.success).toBe(false)

    const unknown = await updateConnectionProjectMembersOp(db, saved.id, [projectA.id, 'nope'])
    expect(unknown.success).toBe(false)
    expect(unknown.error).toBe('Member project not found')

    const nested = await updateConnectionProjectMembersOp(db, saved.id, [projectA.id, saved.id])
    expect(nested.success).toBe(false)
    expect(nested.error).toMatch(/cannot be a member/)

    const notConnection = await updateConnectionProjectMembersOp(db, projectA.id, [
      projectA.id,
      projectB.id
    ])
    expect(notConnection.success).toBe(false)
    expect(notConnection.error).toBe('Not a connection project')

    const missing = await updateConnectionProjectMembersOp(db, 'nope', [projectA.id, projectB.id])
    expect(missing.success).toBe(false)

    // Nothing changed on the real project
    expect(memberIds(db.getProject(saved.id))).toEqual([projectA.id, projectB.id])
    expect(symlinkExists(join(saved.path, 'proja'))).toBe(true)
    expect(symlinkExists(join(saved.path, 'projb'))).toBe(true)

    db.close()
  })
})
