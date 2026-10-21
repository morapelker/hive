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

const MISSING = '00000000-0000-4000-8000-000000000000'

function openDb(): { db: DatabaseService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hive-session-profiler-db-'))
  tempDirs.push(dir)
  const db = new DatabaseService(join(dir, 'state.sqlite'))
  db.init()
  return { db, dir }
}

describeIf('session profiler DB rows', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  it('returns one row per id with worktree, project and the preferred ticket', () => {
    const { db, dir } = openDb()
    const project = db.createProject({ name: 'repo', path: join(dir, 'repo') })
    const worktree = db.createWorktree({
      project_id: project.id,
      name: 'feature',
      branch_name: 'feature',
      path: join(dir, 'repo-feature')
    })
    const session = db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'Build it',
      agent_sdk: 'claude-code-cli'
    })
    const archivedTicket = db.createKanbanTicket({
      project_id: project.id,
      title: 'Old ticket',
      column: 'done',
      current_session_id: session.id
    })
    db.getRawDb()
      .prepare('UPDATE kanban_tickets SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z', archivedTicket.id)
    const liveTicket = db.createKanbanTicket({
      project_id: project.id,
      title: 'Live ticket',
      column: 'review',
      current_session_id: session.id
    })
    db.getRawDb()
      .prepare('UPDATE kanban_tickets SET updated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', liveTicket.id)
    db.archiveWorktree(worktree.id)

    const rows = db.getSessionProfilerRows([session.id, MISSING, session.id])

    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === session.id)).toEqual({
      id: session.id,
      sessionExists: true,
      name: 'Build it',
      status: 'active',
      agentSdk: 'claude-code-cli',
      worktreeName: 'feature',
      worktreePath: join(dir, 'repo-feature'),
      worktreeArchived: true,
      projectName: 'repo',
      // The non-archived ticket wins even though the archived one was updated later.
      ticket: {
        id: liveTicket.id,
        title: 'Live ticket',
        column: 'review',
        archived: false,
        projectId: project.id
      },
      documentRunBusy: false
    })
    expect(rows.find((row) => row.id === MISSING)).toEqual({
      id: MISSING,
      sessionExists: false,
      name: null,
      status: null,
      agentSdk: null,
      worktreeName: null,
      worktreePath: null,
      worktreeArchived: false,
      projectName: null,
      ticket: null,
      documentRunBusy: false
    })
    expect(db.getSessionProfilerRows([])).toEqual([])
    db.close()
  })

  it('prefers a live ticket over a more recently updated Done one sharing the session', () => {
    const { db, dir } = openDb()
    const project = db.createProject({ name: 'repo', path: join(dir, 'repo') })
    const session = db.createSession({ worktree_id: null, project_id: project.id })
    const live = db.createKanbanTicket({
      project_id: project.id,
      title: 'Still working',
      column: 'in_progress',
      current_session_id: session.id
    })
    const done = db.createKanbanTicket({
      project_id: project.id,
      title: 'Moved to Done',
      column: 'done',
      current_session_id: session.id
    })
    const setUpdated = db
      .getRawDb()
      .prepare('UPDATE kanban_tickets SET updated_at = ? WHERE id = ?')
    setUpdated.run('2026-01-01T00:00:00.000Z', live.id)
    setUpdated.run('2026-10-21T00:00:00.000Z', done.id)

    expect(db.getSessionProfilerRows([session.id])[0]?.ticket).toMatchObject({
      id: live.id,
      column: 'in_progress'
    })

    // Once no live ticket rides it, the Done one is what the row shows.
    db.getRawDb()
      .prepare('UPDATE kanban_tickets SET "column" = ? WHERE id = ?')
      .run('merged', live.id)
    setUpdated.run('2026-01-01T00:00:00.000Z', live.id)
    expect(db.getSessionProfilerRows([session.id])[0]?.ticket).toMatchObject({
      id: done.id,
      column: 'done'
    })
    db.close()
  })

  it('uses the connection for connection sessions and flags document runs that still need the session', () => {
    const { db, dir } = openDb()
    const project = db.createProject({ name: 'repo', path: join(dir, 'repo') })
    const connection = db.createConnection({ name: 'multi', path: join(dir, 'connections/multi') })
    const itemSession = db.createSession({
      worktree_id: null,
      project_id: project.id,
      connection_id: connection.id,
      agent_sdk: 'codex-cli'
    })
    const updatingSession = db.createSession({ worktree_id: null, project_id: project.id })
    const doneSession = db.createSession({ worktree_id: null, project_id: project.id })
    const finishedRunSession = db.createSession({ worktree_id: null, project_id: project.id })

    const raw = db.getRawDb()
    const now = '2026-10-21T00:00:00.000Z'
    const insertRun = raw.prepare(
      `INSERT INTO document_runs (id, project_id, title, source_path, run_dir, status, created_at, updated_at)
       VALUES (?, ?, 'Doc', '/doc.md', '/run', ?, ?, ?)`
    )
    insertRun.run('run-live', project.id, 'running', now, now)
    insertRun.run('run-done', project.id, 'completed', now, now)
    const insertItem = raw.prepare(
      `INSERT INTO document_run_items (id, run_id, item_key, title, status, session_id, document_update_status, created_at, updated_at)
       VALUES (?, ?, ?, 'Item', ?, ?, ?, ?, ?)`
    )
    insertItem.run('i1', 'run-live', 'a', 'running', itemSession.id, null, now, now)
    insertItem.run('i2', 'run-live', 'b', 'merged', updatingSession.id, 'updating', now, now)
    insertItem.run('i3', 'run-live', 'c', 'merged', doneSession.id, 'done', now, now)
    insertItem.run('i4', 'run-done', 'd', 'running', finishedRunSession.id, null, now, now)

    const rows = new Map(
      db
        .getSessionProfilerRows([
          itemSession.id,
          updatingSession.id,
          doneSession.id,
          finishedRunSession.id
        ])
        .map((row) => [row.id, row])
    )

    expect(rows.get(itemSession.id)).toMatchObject({
      worktreeName: 'multi',
      worktreePath: join(dir, 'connections/multi'),
      agentSdk: 'codex-cli',
      documentRunBusy: true
    })
    expect(rows.get(updatingSession.id)?.documentRunBusy).toBe(true)
    expect(rows.get(doneSession.id)?.documentRunBusy).toBe(false)
    expect(rows.get(finishedRunSession.id)?.documentRunBusy).toBe(false)
    db.close()
  })
})
