import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { DatabaseService } from '../../db/database'

describe('DatabaseService compaction', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const createService = (): DatabaseService => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-compaction-'))
    tempDirs.push(dir)
    const service = new DatabaseService(join(dir, 'hive.db'))
    service.init()
    return service
  }

  it('previews orphaned child rows and preserves archived-worktree session history', async () => {
    const service = createService()
    const db = service.getRawDb()
    const project = service.createProject({ name: 'Project', path: '/tmp/project' })
    const activeWorktree = service.createWorktree({
      project_id: project.id,
      name: 'Active',
      branch_name: 'active',
      path: '/tmp/project-active'
    })
    const archivedWorktree = service.createWorktree({
      project_id: project.id,
      name: 'Archived',
      branch_name: 'archived',
      path: '/tmp/project-archived'
    })
    service.archiveWorktree(archivedWorktree.id)

    const activeSession = service.createSession({
      project_id: project.id,
      worktree_id: activeWorktree.id
    })
    const archivedSession = service.createSession({
      project_id: project.id,
      worktree_id: archivedWorktree.id
    })

    service.createSessionMessage({
      session_id: activeSession.id,
      role: 'user',
      content: 'active message'
    })
    service.createSessionMessage({
      session_id: archivedSession.id,
      role: 'assistant',
      content: 'archived message payload',
      opencode_message_json: 'archived message json',
      opencode_parts_json: 'archived parts json',
      opencode_timeline_json: 'archived timeline json'
    })
    service.upsertSessionActivity({
      id: 'active-activity',
      session_id: activeSession.id,
      kind: 'session.info',
      tone: 'info',
      summary: 'active summary',
      payload_json: '{"active":true}'
    })
    service.upsertSessionActivity({
      id: 'archived-activity',
      session_id: archivedSession.id,
      kind: 'session.info',
      tone: 'info',
      summary: 'archived summary',
      payload_json: '{"archived":true}'
    })

    db.pragma('foreign_keys = OFF')
    db.prepare(
      `INSERT INTO session_messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('orphan-message', 'missing-session', 'user', 'orphan content', new Date().toISOString())
    db.prepare(
      `INSERT INTO session_activities (id, session_id, kind, tone, summary, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'orphan-activity',
      'missing-session',
      'session.info',
      'info',
      'orphan summary',
      '{"orphan":true}',
      new Date().toISOString()
    )
    db.pragma('foreign_keys = ON')

    const preview = service.previewCompaction()
    expect(preview.orphaned.rows).toEqual({ messages: 1, activities: 1 })
    expect(preview.estimatedSavedBytes).toBeGreaterThan(0)

    const result = await service.compactDatabase()
    expect(result.deletedCounts).toEqual({
      orphanedMessages: 1,
      orphanedActivities: 1
    })
    expect(service.getSession(activeSession.id)).not.toBeNull()
    expect(service.getSession(archivedSession.id)).not.toBeNull()
    expect(service.getWorktree(archivedWorktree.id)?.status).toBe('archived')
    expect(service.getSessionMessages(activeSession.id)).toHaveLength(1)
    expect(service.getSessionMessages(archivedSession.id)).toHaveLength(1)
    expect(service.getSessionActivities(activeSession.id)).toHaveLength(1)
    expect(service.getSessionActivities(archivedSession.id)).toHaveLength(1)

    const secondPreview = service.previewCompaction()
    expect(secondPreview.orphaned.rows).toEqual({ messages: 0, activities: 0 })

    service.close()
  })

  it('includes WAL bytes in the compaction estimate', () => {
    const service = createService()
    const db = service.getRawDb()

    db.pragma('wal_checkpoint(TRUNCATE)')
    for (let i = 0; i < 50; i += 1) {
      service.setSetting(`wal-test-${i}`, 'x'.repeat(200))
    }

    const walBytes = statSync(`${service.getDbPath()}-wal`).size
    expect(walBytes).toBeGreaterThan(0)

    const preview = service.previewCompaction()
    expect(preview.reclaimableWalBytes).toBe(walBytes)
    expect(preview.estimatedSavedBytes).toBeGreaterThanOrEqual(walBytes)

    service.close()
  })

  it('estimates text payload sizes as UTF-8 bytes', () => {
    const service = createService()
    const db = service.getRawDb()
    const content = 'emoji 😀 and cjk 漢字'

    db.pragma('foreign_keys = OFF')
    db.prepare(
      `INSERT INTO session_messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('multibyte-orphan-message', 'missing-session', 'user', content, new Date().toISOString())
    db.pragma('foreign_keys = ON')

    const preview = service.previewCompaction()
    expect(preview.orphaned.rows.messages).toBe(1)
    expect(preview.orphaned.bytes).toBe(Buffer.byteLength(content, 'utf8'))

    service.close()
  })
})
