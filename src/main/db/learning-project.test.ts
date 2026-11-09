// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DatabaseService } from './database'
import { createProjectWithDefaultWorktree } from '../services/project-ops'

it('persists learning tickets and sessions across database reopening without a Git repository', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-learning-'))
  const databasePath = join(directory, 'state.sqlite')
  const db = new DatabaseService(databasePath)
  try {
    db.init()
    const project = createProjectWithDefaultWorktree(db, {
      name: 'Learning & planning',
      path: directory,
      kind: 'learning'
    })
    const workspace = db.getActiveWorktreesByProject(project.id)[0]
    const ticket = db.createKanbanTicket({
      project_id: project.id,
      title: 'Learn distributed systems'
    })
    const session = db.createSession({
      project_id: project.id,
      worktree_id: workspace.id,
      name: 'Learning',
      agent_sdk: 'claude-code-cli'
    })
    db.updateKanbanTicket(ticket.id, {
      current_session_id: session.id,
      worktree_id: workspace.id,
      column: 'in_progress'
    })
    db.close()
    db.init()
    expect(db.getProject(project.id)?.kind).toBe('learning')
    expect(db.getKanbanTicket(ticket.id)).toMatchObject({
      column: 'in_progress',
      current_session_id: session.id
    })
    expect(db.getSession(session.id)?.worktree_id).toBe(workspace.id)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
