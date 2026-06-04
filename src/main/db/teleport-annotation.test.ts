import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DatabaseService } from './database'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('worktree teleport annotation', () => {
  it('persists teleported_to JSON on worktrees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-teleport-db-'))
    tempDirs.push(dir)
    const db = new DatabaseService(join(dir, 'state.sqlite'))
    db.init()

    const project = db.createProject({ name: 'repo', path: join(dir, 'repo') })
    const worktree = db.createWorktree({
      project_id: project.id,
      name: 'feature',
      branch_name: 'feature',
      path: join(dir, 'repo-feature')
    })

    const annotation = JSON.stringify({
      url: 'http://localhost:3773',
      channelUrl: 'https://discord.com/channels/guild/channel',
      remoteWorktreeId: 'remote-worktree-1',
      teleportedAt: '2026-06-04T00:00:00.000Z'
    })

    const updated = db.updateWorktree(worktree.id, { teleported_to: annotation })

    expect(updated?.teleported_to).toBe(annotation)
    expect(db.getWorktree(worktree.id)?.teleported_to).toBe(annotation)
    db.close()
  })
})
