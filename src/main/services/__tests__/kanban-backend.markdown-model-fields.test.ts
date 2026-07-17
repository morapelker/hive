import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'

import { closeDatabase, getDatabase } from '../../db'
import type { Project } from '../../db'
import { getKanbanBackendForProject } from '../kanban-backend'

/**
 * Markdown-mode tickets keep runtime state (note, model badge fields) in the
 * markdown_kanban_card_state table, never in the .md file's YAML frontmatter.
 * These tests exercise MarkdownKanbanBackend directly against a real temp
 * sqlite db + temp project folder, mirroring how `note` already round-trips.
 */
describe('MarkdownKanbanBackend model field runtime mirroring', () => {
  const tempDirs: string[] = []
  let project: Project

  beforeEach(() => {
    const dbDir = mkdtempSync(join(tmpdir(), 'hive-markdown-backend-db-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'hive-markdown-backend-project-'))
    tempDirs.push(dbDir, projectDir)

    process.env.HIVE_SERVER_DB_PATH = join(dbDir, 'hive.db')
    closeDatabase()
    const db = getDatabase()
    project = db.createProject({ name: 'Markdown Project', path: projectDir })
    db.updateProjectKanbanStorageMode(project.id, 'markdown')
  })

  afterEach(() => {
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const readCardFrontmatter = (): Record<string, unknown> => {
    const folder = join(project.path, 'docs', 'kanban')
    const files = readdirSync(folder).filter((name) => name.endsWith('.md'))
    expect(files).toHaveLength(1)
    const raw = readFileSync(join(folder, files[0]), 'utf-8')
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
    expect(match).not.toBeNull()
    return YAML.parse(match![1]) as Record<string, unknown>
  }

  it('round-trips note + the 4 model fields through create, get, and list', async () => {
    const backend = getKanbanBackendForProject(project.id)
    const created = await backend.create(project.id, {
      project_id: project.id,
      title: 'Ship multi-model launch',
      note: 'scratch note',
      model_provider_id: 'anthropic',
      model_id: 'claude-opus-4-6',
      model_variant: 'thinking',
      variant_group_id: 'group-1'
    })

    expect(created.note).toBe('scratch note')
    expect(created.model_provider_id).toBe('anthropic')
    expect(created.model_id).toBe('claude-opus-4-6')
    expect(created.model_variant).toBe('thinking')
    expect(created.variant_group_id).toBe('group-1')

    const fetched = await backend.get(project.id, created.id)
    expect(fetched?.note).toBe('scratch note')
    expect(fetched?.model_provider_id).toBe('anthropic')
    expect(fetched?.model_id).toBe('claude-opus-4-6')
    expect(fetched?.model_variant).toBe('thinking')
    expect(fetched?.variant_group_id).toBe('group-1')

    const listed = await backend.list(project.id, false)
    const listedTicket = listed.find((ticket) => ticket.id === created.id)
    expect(listedTicket?.note).toBe('scratch note')
    expect(listedTicket?.model_provider_id).toBe('anthropic')
    expect(listedTicket?.model_id).toBe('claude-opus-4-6')
    expect(listedTicket?.model_variant).toBe('thinking')
    expect(listedTicket?.variant_group_id).toBe('group-1')
  })

  it('defaults note and the 4 model fields to null when omitted from create', async () => {
    const backend = getKanbanBackendForProject(project.id)
    const created = await backend.create(project.id, {
      project_id: project.id,
      title: 'Plain ticket'
    })

    expect(created.note).toBeNull()
    expect(created.model_provider_id).toBeNull()
    expect(created.model_id).toBeNull()
    expect(created.model_variant).toBeNull()
    expect(created.variant_group_id).toBeNull()
  })

  it('update sets then clears each of the 4 model fields, never touching frontmatter', async () => {
    const backend = getKanbanBackendForProject(project.id)
    const created = await backend.create(project.id, {
      project_id: project.id,
      title: 'Badge me later'
    })

    const updated = await backend.update(project.id, created.id, {
      model_provider_id: 'openai',
      model_id: 'gpt-5.6',
      model_variant: 'high',
      variant_group_id: 'group-2'
    })
    expect(updated?.model_provider_id).toBe('openai')
    expect(updated?.model_id).toBe('gpt-5.6')
    expect(updated?.model_variant).toBe('high')
    expect(updated?.variant_group_id).toBe('group-2')

    const frontmatterAfterSet = readCardFrontmatter()
    expect(frontmatterAfterSet).not.toHaveProperty('model_provider_id')
    expect(frontmatterAfterSet).not.toHaveProperty('model_id')
    expect(frontmatterAfterSet).not.toHaveProperty('model_variant')
    expect(frontmatterAfterSet).not.toHaveProperty('variant_group_id')
    expect(frontmatterAfterSet).not.toHaveProperty('note')

    const cleared = await backend.update(project.id, created.id, {
      model_provider_id: null,
      model_id: null,
      model_variant: null,
      variant_group_id: null
    })
    expect(cleared?.model_provider_id).toBeNull()
    expect(cleared?.model_id).toBeNull()
    expect(cleared?.model_variant).toBeNull()
    expect(cleared?.variant_group_id).toBeNull()

    const frontmatterAfterClear = readCardFrontmatter()
    expect(frontmatterAfterClear).not.toHaveProperty('model_provider_id')
    expect(frontmatterAfterClear).not.toHaveProperty('model_id')
    expect(frontmatterAfterClear).not.toHaveProperty('model_variant')
    expect(frontmatterAfterClear).not.toHaveProperty('variant_group_id')
    expect(frontmatterAfterClear).not.toHaveProperty('note')
  })
})
