import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, getDatabase } from '../../db'
import type { Project } from '../../db'
import { getKanbanBackendForProject, moveKanbanTicketToProject } from '../kanban-backend'

/**
 * Cross-backend project moves (internal ↔ markdown) go through a
 * recreate-in-target + follow-up-update path in moveKanbanTicketToProject,
 * unlike internal→internal moves which just re-point project_id and keep
 * every column. The model badge/group fields must survive that recreate the
 * same way `note` does — internal→internal moves already keep them, so a
 * cross-backend move silently dropping them would be inconsistent.
 */
describe('moveKanbanTicketToProject cross-backend model field preservation', () => {
  const tempDirs: string[] = []
  let internalProject: Project
  let markdownProject: Project

  beforeEach(() => {
    const dbDir = mkdtempSync(join(tmpdir(), 'hive-move-backend-db-'))
    const markdownDir = mkdtempSync(join(tmpdir(), 'hive-move-md-project-'))
    tempDirs.push(dbDir, markdownDir)

    process.env.HIVE_SERVER_DB_PATH = join(dbDir, 'hive.db')
    closeDatabase()
    const db = getDatabase()
    internalProject = db.createProject({
      name: 'Internal Project',
      path: '/tmp/hive-move-internal-project'
    })
    markdownProject = db.createProject({ name: 'Markdown Project', path: markdownDir })
    db.updateProjectKanbanStorageMode(markdownProject.id, 'markdown')
  })

  afterEach(() => {
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('internal → markdown keeps note + the 4 model fields', async () => {
    const internalBackend = getKanbanBackendForProject(internalProject.id)
    const source = await internalBackend.create(internalProject.id, {
      project_id: internalProject.id,
      title: 'Cross-backend move',
      note: 'kept note',
      model_provider_id: 'anthropic',
      model_id: 'claude-opus-4-6',
      model_variant: 'thinking',
      variant_group_id: 'group-move-1'
    })

    const moved = await moveKanbanTicketToProject(
      internalProject.id,
      source.id,
      markdownProject.id
    )

    expect(moved).not.toBeNull()
    expect(moved?.project_id).toBe(markdownProject.id)
    expect(moved?.note).toBe('kept note')
    expect(moved?.model_provider_id).toBe('anthropic')
    expect(moved?.model_id).toBe('claude-opus-4-6')
    expect(moved?.model_variant).toBe('thinking')
    expect(moved?.variant_group_id).toBe('group-move-1')

    // Round-trips through the target backend's own read path too.
    const markdownBackend = getKanbanBackendForProject(markdownProject.id)
    const fetched = await markdownBackend.get(markdownProject.id, source.id)
    expect(fetched?.note).toBe('kept note')
    expect(fetched?.model_provider_id).toBe('anthropic')
    expect(fetched?.model_id).toBe('claude-opus-4-6')
    expect(fetched?.model_variant).toBe('thinking')
    expect(fetched?.variant_group_id).toBe('group-move-1')

    // Source is gone.
    expect(await internalBackend.get(internalProject.id, source.id)).toBeNull()
  })

  it('markdown → internal keeps note + the 4 model fields', async () => {
    const markdownBackend = getKanbanBackendForProject(markdownProject.id)
    const source = await markdownBackend.create(markdownProject.id, {
      project_id: markdownProject.id,
      title: 'Cross-backend move back',
      note: 'kept md note',
      model_provider_id: 'openai',
      model_id: 'gpt-5.6',
      model_variant: 'high',
      variant_group_id: 'group-move-2'
    })

    const moved = await moveKanbanTicketToProject(
      markdownProject.id,
      source.id,
      internalProject.id
    )

    expect(moved).not.toBeNull()
    expect(moved?.project_id).toBe(internalProject.id)
    expect(moved?.note).toBe('kept md note')
    expect(moved?.model_provider_id).toBe('openai')
    expect(moved?.model_id).toBe('gpt-5.6')
    expect(moved?.model_variant).toBe('high')
    expect(moved?.variant_group_id).toBe('group-move-2')

    const internalBackend = getKanbanBackendForProject(internalProject.id)
    const fetched = await internalBackend.get(internalProject.id, source.id)
    expect(fetched?.model_provider_id).toBe('openai')
    expect(fetched?.model_id).toBe('gpt-5.6')
    expect(fetched?.model_variant).toBe('high')
    expect(fetched?.variant_group_id).toBe('group-move-2')

    expect(await markdownBackend.get(markdownProject.id, source.id)).toBeNull()
  })

  it('cross-backend moves default the 4 model fields to null when the source never launched', async () => {
    const internalBackend = getKanbanBackendForProject(internalProject.id)
    const source = await internalBackend.create(internalProject.id, {
      project_id: internalProject.id,
      title: 'Never launched'
    })

    const moved = await moveKanbanTicketToProject(
      internalProject.id,
      source.id,
      markdownProject.id
    )

    expect(moved?.model_provider_id).toBeNull()
    expect(moved?.model_id).toBeNull()
    expect(moved?.model_variant).toBeNull()
    expect(moved?.variant_group_id).toBeNull()
  })
})
