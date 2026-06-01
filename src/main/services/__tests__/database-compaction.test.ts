import { mkdtempSync, rmSync } from 'fs'
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

  it('previews and removes archived-worktree sessions plus orphaned child rows only', () => {
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
    expect(preview.archivedWorktrees.rows.sessions).toBe(1)
    expect(preview.archivedWorktrees.rows.messages).toBe(1)
    expect(preview.archivedWorktrees.rows.activities).toBe(1)
    expect(preview.archivedWorktrees.bytes).toBeGreaterThan('archived message payload'.length)
    expect(preview.estimatedSavedBytes).toBeGreaterThan(0)

    const result = service.compactDatabase()
    expect(result.deletedCounts).toEqual({
      orphanedMessages: 1,
      orphanedActivities: 1,
      archivedSessions: 1
    })
    expect(service.getSession(activeSession.id)).not.toBeNull()
    expect(service.getSession(archivedSession.id)).toBeNull()
    expect(service.getWorktree(archivedWorktree.id)?.status).toBe('archived')
    expect(service.getSessionMessages(activeSession.id)).toHaveLength(1)
    expect(service.getSessionActivities(activeSession.id)).toHaveLength(1)

    const secondPreview = service.previewCompaction()
    expect(secondPreview.orphaned.rows).toEqual({ messages: 0, activities: 0 })
    expect(secondPreview.archivedWorktrees.rows.sessions).toBe(0)

    service.close()
  })
})
