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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function setupProject(): {
  db: DatabaseService
  projectId: string
  defaultWorktreeId: string
  featureWorktreeId: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'hive-last-message-db-'))
  tempDirs.push(dir)
  const db = new DatabaseService(join(dir, 'state.sqlite'))
  db.init()

  const project = db.createProject({ name: 'repo', path: join(dir, 'repo') })
  const defaultWorktree = db.createWorktree({
    project_id: project.id,
    name: 'main',
    branch_name: 'main',
    path: join(dir, 'repo'),
    is_default: true
  })
  const featureWorktree = db.createWorktree({
    project_id: project.id,
    name: 'feature',
    branch_name: 'feature',
    path: join(dir, 'repo-feature')
  })

  return {
    db,
    projectId: project.id,
    defaultWorktreeId: defaultWorktree.id,
    featureWorktreeId: featureWorktree.id
  }
}

describeIf('worktree last_message_at fan-out to default worktree', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  it('bumping a worktree also bumps the project default worktree', () => {
    const { db, defaultWorktreeId, featureWorktreeId } = setupProject()

    const now = Date.now()
    db.updateWorktree(featureWorktreeId, { last_message_at: now })

    expect(db.getWorktree(featureWorktreeId)?.last_message_at).toBe(now)
    expect(db.getWorktree(defaultWorktreeId)?.last_message_at).toBe(now)
  })

  it('keeps the project recency after the worktree is archived', () => {
    const { db, defaultWorktreeId, featureWorktreeId } = setupProject()

    const now = Date.now()
    db.updateWorktree(featureWorktreeId, { last_message_at: now })
    db.archiveWorktree(featureWorktreeId)
    db.deleteWorktree(featureWorktreeId)

    expect(db.getWorktree(defaultWorktreeId)?.last_message_at).toBe(now)
  })

  it('does not regress the default worktree when an older timestamp is persisted', () => {
    const { db, defaultWorktreeId, featureWorktreeId } = setupProject()

    const newer = Date.now()
    const older = newer - 60_000
    db.updateWorktree(defaultWorktreeId, { last_message_at: newer })
    db.updateWorktree(featureWorktreeId, { last_message_at: older })

    expect(db.getWorktree(defaultWorktreeId)?.last_message_at).toBe(newer)
    expect(db.getWorktree(featureWorktreeId)?.last_message_at).toBe(older)
  })

  it('updating the default worktree itself does not loop or affect others', () => {
    const { db, defaultWorktreeId, featureWorktreeId } = setupProject()

    const now = Date.now()
    db.updateWorktree(defaultWorktreeId, { last_message_at: now })

    expect(db.getWorktree(defaultWorktreeId)?.last_message_at).toBe(now)
    expect(db.getWorktree(featureWorktreeId)?.last_message_at).toBeNull()
  })

  it('clearing last_message_at (null) does not touch the default worktree', () => {
    const { db, defaultWorktreeId, featureWorktreeId } = setupProject()

    const now = Date.now()
    db.updateWorktree(featureWorktreeId, { last_message_at: now })
    db.updateWorktree(featureWorktreeId, { last_message_at: null })

    expect(db.getWorktree(featureWorktreeId)?.last_message_at).toBeNull()
    expect(db.getWorktree(defaultWorktreeId)?.last_message_at).toBe(now)
  })

  it('does not bump default worktrees of other projects', () => {
    const { db, featureWorktreeId } = setupProject()
    const otherDir = mkdtempSync(join(tmpdir(), 'hive-last-message-db-other-'))
    tempDirs.push(otherDir)
    const otherProject = db.createProject({ name: 'other', path: join(otherDir, 'other') })
    const otherDefault = db.createWorktree({
      project_id: otherProject.id,
      name: 'main',
      branch_name: 'main',
      path: join(otherDir, 'other'),
      is_default: true
    })

    db.updateWorktree(featureWorktreeId, { last_message_at: Date.now() })

    expect(db.getWorktree(otherDefault.id)?.last_message_at).toBeNull()
  })
})
