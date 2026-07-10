import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, getDatabase } from '../../db'
import type { Project } from '../../db'
import { getKanbanBackendForProject } from '../kanban-backend'

/**
 * kanban.ticket.duplicate creates a fresh, unstarted sibling ticket. Per the
 * duplication policy: title/description/attachments/mark/note are copied;
 * external links, PR links, session/worktree linkage, goal/launch state,
 * token totals, and archived state are NOT copied; column/sort_order/model
 * fields can be overridden and column defaults to the source's column.
 */
describe('KanbanBackend.duplicate', () => {
  const tempDirs: string[] = []
  let project: Project

  beforeEach(() => {
    const dbDir = mkdtempSync(join(tmpdir(), 'hive-duplicate-backend-db-'))
    tempDirs.push(dbDir)
    process.env.HIVE_SERVER_DB_PATH = join(dbDir, 'hive.db')
    closeDatabase()
    const db = getDatabase()
    project = db.createProject({ name: 'Duplicate Project', path: '/tmp/hive-duplicate-project' })
  })

  afterEach(() => {
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('SQLite (internal) backend', () => {
    it('copies title/description/attachments/mark/note, excludes everything else, and defaults column to the source column', async () => {
      const db = getDatabase()
      const worktree = db.createWorktree({
        project_id: project.id,
        name: 'main',
        branch_name: 'main',
        path: project.path
      })
      const session = db.createSession({
        worktree_id: worktree.id,
        project_id: project.id,
        name: 'Session'
      })

      const backend = getKanbanBackendForProject(project.id)
      const source = await backend.create(project.id, {
        project_id: project.id,
        title: 'Ship it',
        description: 'Full description',
        attachments: [{ id: 'att-1' }],
        mark: 'epic',
        note: 'my scratch note',
        column: 'review',
        external_provider: 'jira',
        external_id: 'JIRA-1',
        external_url: 'https://jira.example.com/JIRA-1',
        github_pr_number: 42,
        github_pr_url: 'https://github.com/example/pull/42',
        mode: 'plan',
        plan_ready: true
      })
      await getDatabase().updateKanbanTicket(source.id, {
        worktree_id: worktree.id,
        current_session_id: session.id,
        pending_launch_config: '{"foo":true}',
        goal_mode: true,
        goal_success_criteria: 'All green',
        auto_approve_plan: true
      })
      getDatabase().addTicketTokens(source.id, 500)
      const sourceBeforeDuplicate = await backend.get(project.id, source.id)

      const duplicate = await backend.duplicate(project.id, source.id)

      expect(duplicate.id).not.toBe(source.id)
      expect(duplicate.title).toBe('Ship it')
      expect(duplicate.description).toBe('Full description')
      expect(duplicate.attachments).toEqual([{ id: 'att-1' }])
      expect(duplicate.mark).toBe('epic')
      expect(duplicate.note).toBe('my scratch note')
      expect(duplicate.column).toBe('review')

      expect(duplicate.external_provider).toBeNull()
      expect(duplicate.external_id).toBeNull()
      expect(duplicate.external_url).toBeNull()
      expect(duplicate.github_pr_number).toBeNull()
      expect(duplicate.github_pr_url).toBeNull()
      expect(duplicate.current_session_id).toBeNull()
      expect(duplicate.worktree_id).toBeNull()
      expect(duplicate.mode).toBeNull()
      expect(duplicate.plan_ready).toBe(false)
      expect(duplicate.pending_launch_config).toBeNull()
      expect(duplicate.goal_mode).toBe(false)
      expect(duplicate.goal_success_criteria).toBeNull()
      expect(duplicate.total_tokens).toBe(0)
      expect(duplicate.auto_approve_plan).toBe(false)
      expect(duplicate.archived_at).toBeNull()
      expect(duplicate.model_provider_id).toBeNull()
      expect(duplicate.model_id).toBeNull()
      expect(duplicate.model_variant).toBeNull()
      expect(duplicate.variant_group_id).toBeNull()

      const sourceAfterDuplicate = await backend.get(project.id, source.id)
      expect(sourceAfterDuplicate).toEqual(sourceBeforeDuplicate)
    })

    it('applies overrides for column, sort_order, and the model/group fields', async () => {
      const backend = getKanbanBackendForProject(project.id)
      const source = await backend.create(project.id, {
        project_id: project.id,
        title: 'Multi-model ticket',
        column: 'todo'
      })

      const duplicate = await backend.duplicate(project.id, source.id, {
        column: 'in_progress',
        sort_order: 7,
        model_provider_id: 'anthropic',
        model_id: 'claude-opus-4-6',
        model_variant: 'thinking',
        variant_group_id: 'group-xyz'
      })

      expect(duplicate.column).toBe('in_progress')
      expect(duplicate.sort_order).toBe(7)
      expect(duplicate.model_provider_id).toBe('anthropic')
      expect(duplicate.model_id).toBe('claude-opus-4-6')
      expect(duplicate.model_variant).toBe('thinking')
      expect(duplicate.variant_group_id).toBe('group-xyz')
    })

    it('rejects duplicating a ticket that does not exist', async () => {
      const backend = getKanbanBackendForProject(project.id)
      await expect(backend.duplicate(project.id, 'missing-ticket')).rejects.toThrow()
    })
  })

  describe('Markdown backend', () => {
    let mdProject: Project

    beforeEach(() => {
      const projectDir = mkdtempSync(join(tmpdir(), 'hive-duplicate-md-project-'))
      tempDirs.push(projectDir)
      const db = getDatabase()
      mdProject = db.createProject({ name: 'Markdown Duplicate Project', path: projectDir })
      db.updateProjectKanbanStorageMode(mdProject.id, 'markdown')
    })

    it('copies title/description/attachments/mark/note into a distinct new .md file, leaving the source untouched', async () => {
      const backend = getKanbanBackendForProject(mdProject.id)
      const source = await backend.create(mdProject.id, {
        project_id: mdProject.id,
        title: 'Ship it',
        description: 'Body text',
        attachments: [{ id: 'att-1' }],
        mark: 'rare',
        note: 'scratch',
        column: 'review'
      })

      const folder = join(mdProject.path, 'docs', 'kanban')
      const filesBefore = readdirSync(folder).filter((name) => name.endsWith('.md'))
      expect(filesBefore).toHaveLength(1)
      const sourcePath = join(folder, filesBefore[0])
      const sourceContentBefore = readFileSync(sourcePath, 'utf-8')

      const duplicate = await backend.duplicate(mdProject.id, source.id)

      expect(duplicate.id).not.toBe(source.id)
      expect(duplicate.title).toBe('Ship it')
      expect(duplicate.description).toBe('Body text')
      expect(duplicate.attachments).toEqual([{ id: 'att-1' }])
      expect(duplicate.mark).toBe('rare')
      expect(duplicate.note).toBe('scratch')
      expect(duplicate.column).toBe('review')
      expect(duplicate.model_provider_id).toBeNull()
      expect(duplicate.model_id).toBeNull()
      expect(duplicate.model_variant).toBeNull()
      expect(duplicate.variant_group_id).toBeNull()

      const filesAfter = readdirSync(folder).filter((name) => name.endsWith('.md'))
      expect(filesAfter).toHaveLength(2)
      expect(readFileSync(sourcePath, 'utf-8')).toBe(sourceContentBefore)

      const fetchedDuplicate = await backend.get(mdProject.id, duplicate.id)
      expect(fetchedDuplicate?.note).toBe('scratch')
      expect(fetchedDuplicate?.attachments).toEqual([{ id: 'att-1' }])
    })

    it('applies overrides for column, sort_order, and the model/group fields', async () => {
      const backend = getKanbanBackendForProject(mdProject.id)
      const source = await backend.create(mdProject.id, {
        project_id: mdProject.id,
        title: 'Multi-model ticket',
        column: 'todo'
      })

      const duplicate = await backend.duplicate(mdProject.id, source.id, {
        column: 'in_progress',
        model_provider_id: 'openai',
        model_id: 'gpt-5.6',
        model_variant: 'high',
        variant_group_id: 'group-md'
      })

      expect(duplicate.column).toBe('in_progress')
      expect(duplicate.model_provider_id).toBe('openai')
      expect(duplicate.model_id).toBe('gpt-5.6')
      expect(duplicate.model_variant).toBe('high')
      expect(duplicate.variant_group_id).toBe('group-md')
    })

    it('rejects duplicating a ticket that does not exist', async () => {
      const backend = getKanbanBackendForProject(mdProject.id)
      await expect(backend.duplicate(mdProject.id, 'missing-ticket')).rejects.toThrow()
    })
  })
})
