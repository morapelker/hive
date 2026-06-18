import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import YAML from 'yaml'

interface MockProject {
  id: string
  name: string
  path: string
  kanban_storage_mode: 'internal' | 'markdown'
  kanban_markdown_config: string | null
}

const { mockDatabase, mockState } = vi.hoisted(() => {
  const mockState: { project: MockProject | null } = {
    project: null
  }
  const rawStatement = {
    get: vi.fn(() => undefined),
    all: vi.fn(() => []),
    run: vi.fn()
  }
  const mockDatabase = {
    getProject: vi.fn((projectId: string) =>
      mockState.project?.id === projectId ? mockState.project : null
    ),
    getKanbanTicketsByProject: vi.fn(() => []),
    updateProjectKanbanStorageMode: vi.fn((projectId: string, mode: 'internal' | 'markdown') => {
      if (mockState.project?.id !== projectId) return
      mockState.project = { ...mockState.project, kanban_storage_mode: mode }
    }),
    updateProjectKanbanMarkdownConfig: vi.fn((projectId: string, config: string | null) => {
      if (mockState.project?.id !== projectId) return
      mockState.project = { ...mockState.project, kanban_markdown_config: config }
    }),
    getRawDb: vi.fn(() => ({
      prepare: vi.fn(() => rawStatement)
    }))
  }
  return { mockDatabase, mockState }
})

vi.mock('../../src/main/db', () => ({
  getDatabase: () => mockDatabase
}))

function frontmatterOf(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  return (YAML.parse(match[1]) ?? {}) as Record<string, unknown>
}

describe('markdown kanban adoption repair', () => {
  let tempRoot: string | null = null

  beforeEach(async () => {
    vi.clearAllMocks()
    tempRoot = await mkdtemp(join(tmpdir(), 'hive-kanban-adoption-'))
    mockState.project = {
      id: 'proj-adopt',
      name: 'Adoption Project',
      path: tempRoot,
      kanban_storage_mode: 'internal',
      kanban_markdown_config: JSON.stringify({
        layout: 'single-folder',
        singleFolder: 'cards'
      })
    }
    await mkdir(join(tempRoot, 'cards'), { recursive: true })
  })

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = null
  })

  test('switching a clean project to markdown repairs missing app-owned frontmatter', async () => {
    const { setKanbanStorageMode } = await import('../../src/main/services/kanban-backend')
    const cardsPath = join(tempRoot!, 'cards')
    await writeFile(
      join(cardsPath, 'existing.md'),
      [
        '---',
        'id: existing',
        'title: Existing',
        'column: todo',
        'sort_order: 5',
        'mode: build',
        'archived_at: null',
        'created_at: "2026-05-01T00:00:00.000Z"',
        '---',
        'Existing body'
      ].join('\n'),
      'utf-8'
    )
    await writeFile(join(cardsPath, 'first-card.md'), '# First card\n\nBody\n', 'utf-8')
    await writeFile(
      join(cardsPath, 'done-card.md'),
      ['---', 'id: done-card', 'title: Done Card', 'column: done', '---', 'Done body'].join('\n'),
      'utf-8'
    )

    const result = await setKanbanStorageMode('proj-adopt', 'markdown')

    expect(result).toEqual({ success: true })
    expect(mockDatabase.updateProjectKanbanStorageMode).toHaveBeenCalledWith(
      'proj-adopt',
      'markdown'
    )

    const first = frontmatterOf(await readFile(join(cardsPath, 'first-card.md'), 'utf-8'))
    expect(first.id).toMatch(/^first-card-[a-z0-9]+$/)
    expect(first.title).toBe('First card')
    expect(first.column).toBe('todo')
    expect(first.sort_order).toBe(6)
    expect(first.mode).toBe('build')
    expect(first.archived_at).toBeNull()
    expect(typeof first.created_at).toBe('string')

    const done = frontmatterOf(await readFile(join(cardsPath, 'done-card.md'), 'utf-8'))
    expect(done.id).toBe('done-card')
    expect(done.title).toBe('Done Card')
    expect(done.column).toBe('done')
    expect(done.sort_order).toBe(0)
    expect(done.mode).toBe('build')
    expect(done.archived_at).toBeNull()
    expect(typeof done.created_at).toBe('string')
  })

  test('adoption repair leaves malformed and duplicate-id markdown files unchanged', async () => {
    const { setKanbanStorageMode } = await import('../../src/main/services/kanban-backend')
    const cardsPath = join(tempRoot!, 'cards')
    const malformed = ['---', 'title: [', '---', 'Broken'].join('\n')
    const duplicateA = ['---', 'id: duplicate', 'title: A', '---', 'A'].join('\n')
    const duplicateB = ['---', 'id: duplicate', 'title: B', '---', 'B'].join('\n')
    await writeFile(join(cardsPath, 'malformed.md'), malformed, 'utf-8')
    await writeFile(join(cardsPath, 'duplicate-a.md'), duplicateA, 'utf-8')
    await writeFile(join(cardsPath, 'duplicate-b.md'), duplicateB, 'utf-8')

    const result = await setKanbanStorageMode('proj-adopt', 'markdown')

    expect(result).toEqual({ success: true })
    expect(await readFile(join(cardsPath, 'malformed.md'), 'utf-8')).toBe(malformed)
    expect(await readFile(join(cardsPath, 'duplicate-a.md'), 'utf-8')).toBe(duplicateA)
    expect(await readFile(join(cardsPath, 'duplicate-b.md'), 'utf-8')).toBe(duplicateB)
  })
})
