import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, getDatabase } from '../../db'
import type { Project } from '../../db'
import { getKanbanBackendForProject } from '../kanban-backend'

/**
 * kanban.ticket.createBatch accepts `note` and the 4 model badge fields on
 * each draft (kanbanTicketBatchCreateItemSchema inherits them from the
 * create schema), but both storage backends used to drop them while building
 * the created tickets — a batch draft carrying model metadata silently came
 * back with those fields null. These tests pin the fix: both backends must
 * forward note + the 4 model fields from a batch draft into the created ticket.
 */
describe('KanbanBackend.createBatch note + model field forwarding', () => {
  const tempDirs: string[] = []
  let project: Project

  beforeEach(() => {
    const dbDir = mkdtempSync(join(tmpdir(), 'hive-batch-backend-db-'))
    tempDirs.push(dbDir)
    process.env.HIVE_SERVER_DB_PATH = join(dbDir, 'hive.db')
    closeDatabase()
    const db = getDatabase()
    project = db.createProject({ name: 'Batch Project', path: '/tmp/hive-batch-project' })
  })

  afterEach(() => {
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('SQLite (internal) backend', () => {
    it('round-trips note + the 4 model fields from a batch draft into the created ticket', async () => {
      const backend = getKanbanBackendForProject(project.id)

      const result = await backend.createBatch(project.id, {
        drafts: [
          {
            draft_key: 'draft-1',
            project_id: project.id,
            title: 'Batch-created with model fields',
            note: 'batch scratch note',
            model_provider_id: 'anthropic',
            model_id: 'claude-opus-4-6',
            model_variant: 'thinking',
            variant_group_id: 'batch-group-1'
          }
        ]
      })

      expect(result.tickets).toHaveLength(1)
      const created = result.tickets[0]
      expect(created.note).toBe('batch scratch note')
      expect(created.model_provider_id).toBe('anthropic')
      expect(created.model_id).toBe('claude-opus-4-6')
      expect(created.model_variant).toBe('thinking')
      expect(created.variant_group_id).toBe('batch-group-1')

      const fetched = await backend.get(project.id, created.id)
      expect(fetched?.note).toBe('batch scratch note')
      expect(fetched?.model_provider_id).toBe('anthropic')
      expect(fetched?.model_id).toBe('claude-opus-4-6')
      expect(fetched?.model_variant).toBe('thinking')
      expect(fetched?.variant_group_id).toBe('batch-group-1')
    })

    it('defaults note and the 4 model fields to null when a batch draft omits them', async () => {
      const backend = getKanbanBackendForProject(project.id)

      const result = await backend.createBatch(project.id, {
        drafts: [{ draft_key: 'draft-1', project_id: project.id, title: 'Plain batch ticket' }]
      })

      const created = result.tickets[0]
      expect(created.note).toBeNull()
      expect(created.model_provider_id).toBeNull()
      expect(created.model_id).toBeNull()
      expect(created.model_variant).toBeNull()
      expect(created.variant_group_id).toBeNull()
    })
  })

  describe('Markdown backend', () => {
    let mdProject: Project

    beforeEach(() => {
      const projectDir = mkdtempSync(join(tmpdir(), 'hive-batch-md-project-'))
      tempDirs.push(projectDir)
      const db = getDatabase()
      mdProject = db.createProject({ name: 'Markdown Batch Project', path: projectDir })
      db.updateProjectKanbanStorageMode(mdProject.id, 'markdown')
    })

    it('round-trips note + the 4 model fields from a batch draft into the created ticket', async () => {
      const backend = getKanbanBackendForProject(mdProject.id)

      const result = await backend.createBatch(mdProject.id, {
        drafts: [
          {
            draft_key: 'draft-1',
            project_id: mdProject.id,
            title: 'Batch-created with model fields',
            note: 'batch scratch note',
            model_provider_id: 'openai',
            model_id: 'gpt-5.6',
            model_variant: 'high',
            variant_group_id: 'batch-group-md'
          }
        ]
      })

      expect(result.tickets).toHaveLength(1)
      const created = result.tickets[0]
      expect(created.note).toBe('batch scratch note')
      expect(created.model_provider_id).toBe('openai')
      expect(created.model_id).toBe('gpt-5.6')
      expect(created.model_variant).toBe('high')
      expect(created.variant_group_id).toBe('batch-group-md')

      const fetched = await backend.get(mdProject.id, created.id)
      expect(fetched?.note).toBe('batch scratch note')
      expect(fetched?.model_provider_id).toBe('openai')
      expect(fetched?.model_id).toBe('gpt-5.6')
      expect(fetched?.model_variant).toBe('high')
      expect(fetched?.variant_group_id).toBe('batch-group-md')
    })

    it('defaults note and the 4 model fields to null when a batch draft omits them', async () => {
      const backend = getKanbanBackendForProject(mdProject.id)

      const result = await backend.createBatch(mdProject.id, {
        drafts: [{ draft_key: 'draft-1', project_id: mdProject.id, title: 'Plain batch ticket' }]
      })

      const created = result.tickets[0]
      expect(created.note).toBeNull()
      expect(created.model_provider_id).toBeNull()
      expect(created.model_id).toBeNull()
      expect(created.model_variant).toBeNull()
      expect(created.variant_group_id).toBeNull()
    })
  })
})
