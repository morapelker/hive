import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const mockState: {
    project: MockProject | null
    runtimeRows: Array<{
      project_id?: string
      card_id: string
      worktree_id?: string | null
      last_seen_path?: string | null
      orphaned_at: string | null
    }>
    orphanMarkCount: number
    orphanDeleteCount: number
  } = {
    project: null,
    runtimeRows: [],
    orphanMarkCount: 0,
    orphanDeleteCount: 0
  }

  const mockDatabase = {
    getProject: vi.fn((projectId: string) =>
      mockState.project?.id === projectId ? mockState.project : null
    ),
    updateProjectKanbanMarkdownConfig: vi.fn((projectId: string, config: string | null) => {
      if (mockState.project?.id === projectId) {
        mockState.project = { ...mockState.project, kanban_markdown_config: config }
      }
    }),
    updateProjectKanbanStorageMode: vi.fn((projectId: string, mode: 'internal' | 'markdown') => {
      if (mockState.project?.id === projectId) {
        mockState.project = { ...mockState.project, kanban_storage_mode: mode }
      }
    }),
    getRawDb: vi.fn(() => ({
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() => undefined),
        all: vi.fn((...values: unknown[]) => {
          if (
            sql.startsWith(
              'SELECT project_id, card_id FROM markdown_kanban_card_state WHERE worktree_id = ?'
            )
          ) {
            const worktreeId = values[0]
            return mockState.runtimeRows
              .filter((row) => row.worktree_id === worktreeId)
              .map((row) => ({
                project_id: row.project_id ?? mockState.project?.id ?? 'proj-cache',
                card_id: row.card_id
              }))
          }
          return mockState.runtimeRows
        }),
        run: vi.fn((...values: unknown[]) => {
          if (sql.startsWith('INSERT OR IGNORE INTO markdown_kanban_card_state')) {
            const cardId = String(values[1])
            if (!mockState.runtimeRows.some((row) => row.card_id === cardId)) {
              mockState.runtimeRows.push({ card_id: cardId, orphaned_at: null })
            }
          }
          if (sql.startsWith('UPDATE markdown_kanban_card_state SET orphaned_at')) {
            mockState.orphanMarkCount++
            const cardId = values[3]
            const row = mockState.runtimeRows.find((candidate) => candidate.card_id === cardId)
            if (row) row.orphaned_at = String(values[0])
          }
          if (sql.startsWith('UPDATE markdown_kanban_card_state SET last_seen_path')) {
            const filePath = String(values[0])
            const cardId = String(values[2])
            const row = mockState.runtimeRows.find((candidate) => candidate.card_id === cardId)
            if (row) {
              row.last_seen_path = filePath
              row.orphaned_at = null
            }
          }
          if (sql.startsWith('DELETE FROM markdown_kanban_card_state')) {
            mockState.orphanDeleteCount++
            const cardId = values[1]
            mockState.runtimeRows = mockState.runtimeRows.filter((row) => row.card_id !== cardId)
          }
        })
      }))
    }))
  }

  return { mockDatabase, mockState }
})

vi.mock('../../src/main/db', () => ({
  getDatabase: () => mockDatabase
}))

async function markdownFiles(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((file) => file.endsWith('.md')).sort()
}

function frontmatterOf(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  return (YAML.parse(match[1]) ?? {}) as Record<string, unknown>
}

function dependencyBlockersOf(frontmatter: Record<string, unknown>): string[] {
  const dependencies = frontmatter.dependencies
  if (!Array.isArray(dependencies)) return []
  return dependencies
    .map((dependency) =>
      dependency && typeof dependency === 'object'
        ? (dependency as Record<string, unknown>).blocker_id
        : null
    )
    .filter((blocker): blocker is string => typeof blocker === 'string')
}

describe('markdown diagnostics cache', () => {
  let tempRoot: string | null = null

  beforeEach(async () => {
    vi.clearAllMocks()
    tempRoot = await mkdtemp(join(tmpdir(), 'hive-kanban-diagnostics-'))
    await mkdir(join(tempRoot, 'cards'), { recursive: true })
    mockState.project = {
      id: 'proj-cache',
      name: 'Diagnostics Cache Project',
      path: tempRoot,
      kanban_storage_mode: 'markdown',
      kanban_markdown_config: JSON.stringify({
        layout: 'single-folder',
        singleFolder: 'cards'
      })
    }
    mockState.runtimeRows = [{ card_id: 'missing-card', orphaned_at: null }]
    mockState.orphanMarkCount = 0
    mockState.orphanDeleteCount = 0
  })

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = null
  })

  test('diagnostics are a no-op for internal projects and do not repair markdown files', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardPath = join(tempRoot!, 'cards', 'internal-doc.md')
    const original = '# Internal project doc\n\nThis is not an active markdown Kanban card.\n'
    mockState.project = {
      ...mockState.project!,
      kanban_storage_mode: 'internal'
    }
    await writeFile(cardPath, original, 'utf-8')
    backend.invalidate('proj-cache')

    await expect(backend.getDiagnostics('proj-cache')).resolves.toEqual([])

    expect(await readFile(cardPath, 'utf-8')).toBe(original)
    expect(mockDatabase.getRawDb).not.toHaveBeenCalled()
  })

  test('missing markdown config is persisted as the default config', async () => {
    const { getDefaultMarkdownConfig, getKanbanStorageConfig } =
      await import('../../src/main/services/kanban-backend')
    mockState.project = {
      ...mockState.project!,
      kanban_markdown_config: null
    }

    const config = getKanbanStorageConfig('proj-cache')

    expect(config).toEqual({
      mode: 'markdown',
      markdown: getDefaultMarkdownConfig()
    })
    expect(mockDatabase.updateProjectKanbanMarkdownConfig).toHaveBeenCalledWith(
      'proj-cache',
      JSON.stringify(getDefaultMarkdownConfig())
    )
    expect(mockState.project?.kanban_markdown_config).toBe(
      JSON.stringify(getDefaultMarkdownConfig())
    )
  })

  test('malformed markdown config JSON is persisted as the default config', async () => {
    const { getDefaultMarkdownConfig, getKanbanStorageConfig } =
      await import('../../src/main/services/kanban-backend')
    mockState.project = {
      ...mockState.project!,
      kanban_markdown_config: '{not valid json'
    }

    const config = getKanbanStorageConfig('proj-cache')

    expect(config).toEqual({
      mode: 'markdown',
      markdown: getDefaultMarkdownConfig()
    })
    expect(mockDatabase.updateProjectKanbanMarkdownConfig).toHaveBeenCalledWith(
      'proj-cache',
      JSON.stringify(getDefaultMarkdownConfig())
    )
  })

  test('invalid markdown config shape is persisted as the default config', async () => {
    const { getDefaultMarkdownConfig, getKanbanStorageConfig } =
      await import('../../src/main/services/kanban-backend')
    mockState.project = {
      ...mockState.project!,
      kanban_markdown_config: JSON.stringify({ layout: 'single-folder', singleFolder: '' })
    }

    const config = getKanbanStorageConfig('proj-cache')

    expect(config).toEqual({
      mode: 'markdown',
      markdown: getDefaultMarkdownConfig()
    })
    expect(mockDatabase.updateProjectKanbanMarkdownConfig).toHaveBeenCalledWith(
      'proj-cache',
      JSON.stringify(getDefaultMarkdownConfig())
    )
  })

  test('create rejects an explicit id that already exists before writing a new file', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardsPath = join(tempRoot!, 'cards')
    const existingPath = join(cardsPath, 'existing.md')
    const existing = ['---', 'id: existing', 'title: Existing', '---', 'Existing body'].join('\n')
    mockState.runtimeRows = []
    await writeFile(existingPath, existing, 'utf-8')
    backend.invalidate('proj-cache')

    await expect(
      backend.create('proj-cache', {
        id: 'existing',
        project_id: 'proj-cache',
        title: 'Duplicate',
        description: 'Should not be written'
      })
    ).rejects.toThrow(/already exists/i)

    expect(await readFile(existingPath, 'utf-8')).toBe(existing)
    expect(await markdownFiles(cardsPath)).toEqual(['existing.md'])
  })

  test('create rejects an externally added id after an empty index was cached', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardsPath = join(tempRoot!, 'cards')
    backend.invalidate('proj-cache')

    await backend.list('proj-cache', true)
    await writeFile(
      join(cardsPath, 'external.md'),
      ['---', 'id: external-card', 'title: External Card', '---', 'External body'].join('\n'),
      'utf-8'
    )

    await expect(
      backend.create('proj-cache', {
        id: 'external-card',
        project_id: 'proj-cache',
        title: 'Created From Stale Cache'
      })
    ).rejects.toThrow(/already exists/i)

    expect(await markdownFiles(cardsPath)).toEqual(['external.md'])
  })

  test('mutations reject duplicates introduced after the index was cached', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardsPath = join(tempRoot!, 'cards')
    const originalPath = join(cardsPath, 'original.md')
    const duplicatePath = join(cardsPath, 'duplicate.md')
    const original = ['---', 'id: stale-card', 'title: Original Card', '---', 'Original body'].join(
      '\n'
    )
    const duplicate = [
      '---',
      'id: stale-card',
      'title: Duplicate Card',
      '---',
      'Duplicate body'
    ].join('\n')
    await writeFile(originalPath, original, 'utf-8')
    backend.invalidate('proj-cache')

    await backend.list('proj-cache', true)
    await writeFile(duplicatePath, duplicate, 'utf-8')

    await expect(
      backend.update('proj-cache', 'stale-card', { title: 'Updated From Stale Cache' })
    ).rejects.toThrow(/duplicate/i)

    expect(await readFile(originalPath, 'utf-8')).toBe(original)
    expect(await readFile(duplicatePath, 'utf-8')).toBe(duplicate)
  })

  test('create rejects an explicit id that is currently duplicate-blocked', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardsPath = join(tempRoot!, 'cards')
    await writeFile(
      join(cardsPath, 'duplicate-a.md'),
      ['---', 'id: duplicate', 'title: Duplicate A', '---', 'A'].join('\n'),
      'utf-8'
    )
    await writeFile(
      join(cardsPath, 'duplicate-b.md'),
      ['---', 'id: duplicate', 'title: Duplicate B', '---', 'B'].join('\n'),
      'utf-8'
    )
    mockState.runtimeRows = []
    backend.invalidate('proj-cache')

    await expect(
      backend.create('proj-cache', {
        id: 'duplicate',
        project_id: 'proj-cache',
        title: 'Another Duplicate'
      })
    ).rejects.toThrow(/already exists/i)

    expect(await markdownFiles(cardsPath)).toEqual(['duplicate-a.md', 'duplicate-b.md'])
    expect(mockState.runtimeRows).toEqual([])
  })

  test('create rejects blank public fields before writing markdown files', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardsPath = join(tempRoot!, 'cards')
    mockState.runtimeRows = []

    await expect(
      backend.create('proj-cache', {
        id: '   ',
        project_id: 'proj-cache',
        title: 'Blank ID'
      })
    ).rejects.toThrow(/id.*non-empty/i)

    await expect(
      backend.create('proj-cache', {
        project_id: 'proj-cache',
        title: '   '
      })
    ).rejects.toThrow(/title.*non-empty/i)

    expect(await markdownFiles(cardsPath)).toEqual([])
    expect(mockState.runtimeRows).toEqual([])
  })

  test('create still writes a normal markdown card', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    mockState.runtimeRows = []

    const ticket = await backend.create('proj-cache', {
      id: 'new-card',
      project_id: 'proj-cache',
      title: 'New Card',
      description: 'New body'
    })

    expect(ticket.id).toBe('new-card')
    expect(await markdownFiles(join(tempRoot!, 'cards'))).toEqual(['new-card-card.md'])
    expect(mockState.runtimeRows.some((row) => row.card_id === 'new-card')).toBe(true)
  })

  test('loading preserves an explicit null markdown ticket mode', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardsPath = join(tempRoot!, 'cards')
    await writeFile(
      join(cardsPath, 'stopped.md'),
      ['---', 'id: stopped-card', 'title: Stopped Card', 'mode: null', '---', 'Stopped body'].join(
        '\n'
      ),
      'utf-8'
    )
    backend.invalidate('proj-cache')

    const tickets = await backend.list('proj-cache', true)

    expect(tickets).toHaveLength(1)
    expect(tickets[0].mode).toBeNull()
  })

  test('create preserves an explicit null markdown ticket mode', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    mockState.runtimeRows = []

    const ticket = await backend.create('proj-cache', {
      id: 'null-mode-card',
      project_id: 'proj-cache',
      title: 'Null Mode Card',
      mode: null
    })
    const cardPath = join(tempRoot!, 'cards', 'null-mode-card-card.md')
    const frontmatter = frontmatterOf(await readFile(cardPath, 'utf-8'))

    expect(ticket.mode).toBeNull()
    expect(frontmatter.mode).toBeNull()
  })

  test('loading an id-less markdown card reports diagnostics without rewriting it', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardPath = join(tempRoot!, 'cards', 'no-id.md')
    const original = ['---', 'title: No ID Card', '---', 'Body'].join('\n')
    mockState.runtimeRows = []
    await writeFile(cardPath, original, 'utf-8')
    backend.invalidate('proj-cache')

    const tickets = await backend.list('proj-cache', true)
    const diagnostics = await backend.getDiagnostics('proj-cache')

    expect(tickets).toEqual([])
    expect(await readFile(cardPath, 'utf-8')).toBe(original)
    expect(diagnostics).toContainEqual({
      projectId: 'proj-cache',
      ticketId: null,
      filePath: cardPath,
      kind: 'invalid_frontmatter',
      message: expect.stringContaining('missing required frontmatter field "id"'),
      blocking: true
    })
  })

  test.each([
    [
      'duplicate draft keys',
      [
        { draft_key: 'draft', project_id: 'proj-cache', title: 'One' },
        { draft_key: 'draft', project_id: 'proj-cache', title: 'Two' }
      ],
      /duplicate draft_key/i
    ],
    [
      'unknown dependency',
      [{ draft_key: 'draft', project_id: 'proj-cache', title: 'One', depends_on: ['missing'] }],
      /unknown draft/i
    ],
    [
      'self dependency',
      [{ draft_key: 'draft', project_id: 'proj-cache', title: 'One', depends_on: ['draft'] }],
      /cannot depend on itself/i
    ],
    [
      'dependency cycle',
      [
        { draft_key: 'one', project_id: 'proj-cache', title: 'One', depends_on: ['two'] },
        { draft_key: 'two', project_id: 'proj-cache', title: 'Two', depends_on: ['one'] }
      ],
      /cycle/i
    ],
    [
      'empty title',
      [{ draft_key: 'draft', project_id: 'proj-cache', title: '   ' }],
      /must include a title/i
    ],
    [
      'empty dependency key',
      [{ draft_key: 'draft', project_id: 'proj-cache', title: 'Draft', depends_on: ['   '] }],
      /dependency draft key.*non-empty/i
    ],
    [
      'mixed projects',
      [
        { draft_key: 'one', project_id: 'proj-cache', title: 'One' },
        { draft_key: 'two', project_id: 'other-project', title: 'Two' }
      ],
      /same project/i
    ],
    [
      'route project mismatch',
      [{ draft_key: 'draft', project_id: 'other-project', title: 'One' }],
      /project_id does not match/i
    ]
  ])(
    'createBatch rejects %s before writing markdown files',
    async (_name, drafts, errorPattern) => {
      const backend = (
        await import('../../src/main/services/kanban-backend')
      ).getMarkdownKanbanBackend()
      mockState.runtimeRows = []
      backend.invalidate('proj-cache')

      await expect(backend.createBatch('proj-cache', { drafts })).rejects.toThrow(errorPattern)

      expect(await markdownFiles(join(tempRoot!, 'cards'))).toEqual([])
      expect(mockState.runtimeRows).toEqual([])
    }
  )

  test('update rejects blank title before rewriting markdown files', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardPath = join(tempRoot!, 'cards', 'card.md')
    const original = ['---', 'id: card', 'title: Card', '---', 'Body'].join('\n')
    await writeFile(cardPath, original, 'utf-8')
    backend.invalidate('proj-cache')

    await expect(backend.update('proj-cache', 'card', { title: '   ' })).rejects.toThrow(
      /title.*non-empty/i
    )

    expect(await readFile(cardPath, 'utf-8')).toBe(original)
  })

  test.each([
    ['blank id', [{ id: '   ', title: 'Blank ID' }], undefined, /id.*non-empty/i],
    ['blank title', [{ id: 'ticket', title: '   ' }], undefined, /title.*non-empty/i],
    [
      'blank dependent id',
      [{ id: 'ticket', title: 'Ticket' }],
      [{ dependentId: '   ', blockerId: 'ticket' }],
      /dependentId.*non-empty/i
    ],
    [
      'blank blocker id',
      [{ id: 'ticket', title: 'Ticket' }],
      [{ dependentId: 'ticket', blockerId: '   ' }],
      /blockerId.*non-empty/i
    ]
  ] as Array<
    [
      string,
      Array<{ id: string; title: string }>,
      Array<{ dependentId: string; blockerId: string }> | undefined,
      RegExp
    ]
  >)(
    'importTickets rejects %s before writing markdown files',
    async (_name, tickets, dependencies, errorPattern) => {
      const backend = (
        await import('../../src/main/services/kanban-backend')
      ).getMarkdownKanbanBackend()
      mockState.runtimeRows = []
      backend.invalidate('proj-cache')

      await expect(backend.importTickets('proj-cache', tickets, dependencies)).rejects.toThrow(
        errorPattern
      )

      expect(await markdownFiles(join(tempRoot!, 'cards'))).toEqual([])
      expect(mockState.runtimeRows).toEqual([])
    }
  )

  test('createBatch rolls back created files and runtime rows when dependency creation fails', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    mockState.runtimeRows = []
    const addDependency = vi
      .spyOn(backend, 'addDependency')
      .mockResolvedValueOnce({ success: false, error: 'Dependency write failed' })

    try {
      await expect(
        backend.createBatch('proj-cache', {
          drafts: [
            { draft_key: 'one', project_id: 'proj-cache', title: 'One' },
            { draft_key: 'two', project_id: 'proj-cache', title: 'Two', depends_on: ['one'] }
          ]
        })
      ).rejects.toThrow(/dependency write failed/i)
    } finally {
      addDependency.mockRestore()
    }

    expect(await markdownFiles(join(tempRoot!, 'cards'))).toEqual([])
    expect(mockState.runtimeRows).toEqual([])
  })

  test('addDependency returns a failure when a markdown card is missing', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    await writeFile(
      join(tempRoot!, 'cards', 'existing.md'),
      ['---', 'id: existing', 'title: Existing', '---', 'Body'].join('\n'),
      'utf-8'
    )
    backend.invalidate('proj-cache')

    await expect(backend.addDependency('proj-cache', 'missing', 'existing')).resolves.toEqual({
      success: false,
      error: 'Ticket does not exist'
    })
  })

  test('saving markdown config does not create missing folders', async () => {
    const { updateKanbanMarkdownConfig } = await import('../../src/main/services/kanban-backend')
    const missingFolder = join(tempRoot!, 'missing-cards')

    await expect(
      updateKanbanMarkdownConfig('proj-cache', {
        layout: 'single-folder',
        singleFolder: 'missing-cards'
      })
    ).rejects.toThrow()

    await expect(access(missingFolder)).rejects.toThrow()
    expect(mockDatabase.updateProjectKanbanMarkdownConfig).not.toHaveBeenCalled()
  })

  test('saving markdown config rejects an existing file used as a folder', async () => {
    const { updateKanbanMarkdownConfig } = await import('../../src/main/services/kanban-backend')
    const filePath = join(tempRoot!, 'not-a-folder')
    await writeFile(filePath, 'not a directory', 'utf-8')

    await expect(
      updateKanbanMarkdownConfig('proj-cache', {
        layout: 'single-folder',
        singleFolder: 'not-a-folder'
      })
    ).rejects.toThrow(/not a directory/i)

    expect(mockDatabase.updateProjectKanbanMarkdownConfig).not.toHaveBeenCalled()
  })

  test('explicit folder creation creates folders for an unsaved markdown config', async () => {
    const { createConfiguredMarkdownFolders } =
      await import('../../src/main/services/kanban-backend')
    const todo = join(tempRoot!, 'new-board', 'todo')
    const inProgress = join(tempRoot!, 'new-board', 'in-progress')
    const review = join(tempRoot!, 'new-board', 'review')
    const done = join(tempRoot!, 'new-board', 'done')

    await createConfiguredMarkdownFolders('proj-cache', {
      layout: 'status-folders',
      statusFolders: {
        todo: 'new-board/todo',
        in_progress: 'new-board/in-progress',
        review: 'new-board/review',
        done: 'new-board/done'
      }
    })

    await expect(access(todo)).resolves.toBeUndefined()
    await expect(access(inProgress)).resolves.toBeUndefined()
    await expect(access(review)).resolves.toBeUndefined()
    await expect(access(done)).resolves.toBeUndefined()
    expect(mockDatabase.updateProjectKanbanMarkdownConfig).not.toHaveBeenCalled()
  })

  test('saving a single-folder to status-folders layout change relocates existing cards', async () => {
    const { updateKanbanMarkdownConfig } = await import('../../src/main/services/kanban-backend')
    const todoFolder = join(tempRoot!, 'cards', 'todo')
    const inProgressFolder = join(tempRoot!, 'cards', 'in-progress')
    const reviewFolder = join(tempRoot!, 'cards', 'review')
    const doneFolder = join(tempRoot!, 'cards', 'done')
    await mkdir(todoFolder, { recursive: true })
    await mkdir(inProgressFolder, { recursive: true })
    await mkdir(reviewFolder, { recursive: true })
    await mkdir(doneFolder, { recursive: true })
    const todoCard = [
      '---',
      'id: todo-card',
      'title: Todo',
      'column: todo',
      '---',
      'Todo body'
    ].join('\n')
    const reviewCard = [
      '---',
      'id: review-card',
      'title: Review',
      'column: review',
      '---',
      'Review body'
    ].join('\n')
    const doneCard = [
      '---',
      'id: done-card',
      'title: Done',
      'column: done',
      '---',
      'Done body'
    ].join('\n')
    await writeFile(join(tempRoot!, 'cards', 'todo-card.md'), todoCard, 'utf-8')
    await writeFile(join(tempRoot!, 'cards', 'review-card.md'), reviewCard, 'utf-8')
    await writeFile(join(tempRoot!, 'cards', 'done-card.md'), doneCard, 'utf-8')

    await updateKanbanMarkdownConfig('proj-cache', {
      layout: 'status-folders',
      singleFolder: 'cards',
      statusFolders: {
        todo: 'cards/todo',
        in_progress: 'cards/in-progress',
        review: 'cards/review',
        done: 'cards/done'
      }
    })

    await expect(access(join(tempRoot!, 'cards', 'todo-card.md'))).rejects.toThrow()
    await expect(access(join(tempRoot!, 'cards', 'review-card.md'))).rejects.toThrow()
    await expect(access(join(tempRoot!, 'cards', 'done-card.md'))).rejects.toThrow()
    expect(await readFile(join(todoFolder, 'todo-card.md'), 'utf-8')).toBe(todoCard)
    expect(await readFile(join(reviewFolder, 'review-card.md'), 'utf-8')).toBe(reviewCard)
    expect(await readFile(join(doneFolder, 'done-card.md'), 'utf-8')).toBe(doneCard)
    expect(mockState.project?.kanban_markdown_config).toBe(
      JSON.stringify({
        layout: 'status-folders',
        singleFolder: 'cards',
        statusFolders: {
          todo: 'cards/todo',
          in_progress: 'cards/in-progress',
          review: 'cards/review',
          done: 'cards/done'
        }
      })
    )
  })

  test('saving a status-folders to single-folder layout change flattens existing cards', async () => {
    const { updateKanbanMarkdownConfig } = await import('../../src/main/services/kanban-backend')
    mockState.project = {
      ...mockState.project!,
      kanban_markdown_config: JSON.stringify({
        layout: 'status-folders',
        singleFolder: 'cards',
        statusFolders: {
          todo: 'cards/todo',
          in_progress: 'cards/in-progress',
          review: 'cards/review',
          done: 'cards/done'
        }
      })
    }
    await mkdir(join(tempRoot!, 'cards', 'todo'), { recursive: true })
    await mkdir(join(tempRoot!, 'cards', 'in-progress'), { recursive: true })
    await mkdir(join(tempRoot!, 'cards', 'review'), { recursive: true })
    await mkdir(join(tempRoot!, 'cards', 'done'), { recursive: true })
    await mkdir(join(tempRoot!, 'flat-cards'), { recursive: true })
    const todoCard = [
      '---',
      'id: todo-card',
      'title: Todo',
      'column: todo',
      '---',
      'Todo body'
    ].join('\n')
    const reviewCard = [
      '---',
      'id: review-card',
      'title: Review',
      'column: review',
      '---',
      'Review body'
    ].join('\n')
    const doneCard = [
      '---',
      'id: done-card',
      'title: Done',
      'column: done',
      '---',
      'Done body'
    ].join('\n')
    await writeFile(join(tempRoot!, 'cards', 'todo', 'todo-card.md'), todoCard, 'utf-8')
    await writeFile(join(tempRoot!, 'cards', 'review', 'review-card.md'), reviewCard, 'utf-8')
    await writeFile(join(tempRoot!, 'cards', 'done', 'done-card.md'), doneCard, 'utf-8')

    await updateKanbanMarkdownConfig('proj-cache', {
      layout: 'single-folder',
      singleFolder: 'flat-cards',
      statusFolders: {
        todo: 'cards/todo',
        in_progress: 'cards/in-progress',
        review: 'cards/review',
        done: 'cards/done'
      }
    })

    await expect(access(join(tempRoot!, 'cards', 'todo', 'todo-card.md'))).rejects.toThrow()
    await expect(access(join(tempRoot!, 'cards', 'review', 'review-card.md'))).rejects.toThrow()
    await expect(access(join(tempRoot!, 'cards', 'done', 'done-card.md'))).rejects.toThrow()
    expect(await readFile(join(tempRoot!, 'flat-cards', 'todo-card.md'), 'utf-8')).toBe(todoCard)
    expect(await readFile(join(tempRoot!, 'flat-cards', 'review-card.md'), 'utf-8')).toBe(
      reviewCard
    )
    expect(await readFile(join(tempRoot!, 'flat-cards', 'done-card.md'), 'utf-8')).toBe(doneCard)
  })

  test('layout migration rolls back already moved cards when a later move fails', async () => {
    const { updateKanbanMarkdownConfig } = await import('../../src/main/services/kanban-backend')
    mockState.project = {
      ...mockState.project!,
      kanban_markdown_config: JSON.stringify({
        layout: 'status-folders',
        singleFolder: 'cards',
        statusFolders: {
          todo: 'cards/todo',
          in_progress: 'cards/in-progress',
          review: 'cards/review',
          done: 'cards/done'
        }
      })
    }
    const todoFolder = join(tempRoot!, 'cards', 'todo')
    const reviewFolder = join(tempRoot!, 'cards', 'review')
    const flatFolder = join(tempRoot!, 'flat-cards')
    await mkdir(todoFolder, { recursive: true })
    await mkdir(reviewFolder, { recursive: true })
    await mkdir(flatFolder, { recursive: true })
    const todoCard = [
      '---',
      'id: todo-card',
      'title: Todo',
      'column: todo',
      '---',
      'Todo body'
    ].join('\n')
    const reviewCard = [
      '---',
      'id: review-card',
      'title: Review',
      'column: review',
      '---',
      'Review body'
    ].join('\n')
    const todoSource = join(todoFolder, 'todo-card.md')
    const reviewSource = join(reviewFolder, 'review-card.md')
    const todoTarget = join(flatFolder, 'todo-card.md')
    const reviewTarget = join(flatFolder, 'review-card.md')
    await writeFile(todoSource, todoCard, 'utf-8')
    await writeFile(reviewSource, reviewCard, 'utf-8')
    await chmod(reviewFolder, 0o555)

    try {
      await expect(
        updateKanbanMarkdownConfig('proj-cache', {
          layout: 'single-folder',
          singleFolder: 'flat-cards',
          statusFolders: {
            todo: 'cards/todo',
            in_progress: 'cards/in-progress',
            review: 'cards/review',
            done: 'cards/done'
          }
        })
      ).rejects.toThrow()
    } finally {
      await chmod(reviewFolder, 0o755)
    }

    expect(await readFile(todoSource, 'utf-8')).toBe(todoCard)
    expect(await readFile(reviewSource, 'utf-8')).toBe(reviewCard)
    await expect(access(todoTarget)).rejects.toThrow()
    await expect(access(reviewTarget)).rejects.toThrow()
    expect(mockDatabase.updateProjectKanbanMarkdownConfig).not.toHaveBeenCalled()
  })

  test('layout migration rejects target filename collisions before saving config or moving files', async () => {
    const { updateKanbanMarkdownConfig } = await import('../../src/main/services/kanban-backend')
    const todoFolder = join(tempRoot!, 'cards', 'todo')
    const inProgressFolder = join(tempRoot!, 'cards', 'in-progress')
    const reviewFolder = join(tempRoot!, 'cards', 'review')
    const doneFolder = join(tempRoot!, 'cards', 'done')
    await mkdir(todoFolder, { recursive: true })
    await mkdir(inProgressFolder, { recursive: true })
    await mkdir(reviewFolder, { recursive: true })
    await mkdir(doneFolder, { recursive: true })
    const sourceCard = [
      '---',
      'id: source-card',
      'title: Source',
      'column: todo',
      '---',
      'Source body'
    ].join('\n')
    const existingTarget = [
      '---',
      'id: existing-card',
      'title: Existing',
      'column: todo',
      '---',
      'Existing body'
    ].join('\n')
    await writeFile(join(tempRoot!, 'cards', 'card.md'), sourceCard, 'utf-8')
    await writeFile(join(todoFolder, 'card.md'), existingTarget, 'utf-8')

    await expect(
      updateKanbanMarkdownConfig('proj-cache', {
        layout: 'status-folders',
        singleFolder: 'cards',
        statusFolders: {
          todo: 'cards/todo',
          in_progress: 'cards/in-progress',
          review: 'cards/review',
          done: 'cards/done'
        }
      })
    ).rejects.toThrow(/already exists/i)

    expect(await readFile(join(tempRoot!, 'cards', 'card.md'), 'utf-8')).toBe(sourceCard)
    expect(await readFile(join(todoFolder, 'card.md'), 'utf-8')).toBe(existingTarget)
    expect(mockDatabase.updateProjectKanbanMarkdownConfig).not.toHaveBeenCalled()
  })

  test('status-folder move destination failure leaves source frontmatter unchanged', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    mockState.project = {
      ...mockState.project!,
      kanban_markdown_config: JSON.stringify({
        layout: 'status-folders',
        statusFolders: {
          todo: 'cards/todo',
          in_progress: 'cards/in-progress',
          review: 'cards/review',
          done: 'cards/done'
        }
      })
    }
    await mkdir(join(tempRoot!, 'cards', 'todo'), { recursive: true })
    await writeFile(join(tempRoot!, 'cards', 'in-progress'), 'not a directory', 'utf-8')
    await mkdir(join(tempRoot!, 'cards', 'review'), { recursive: true })
    await mkdir(join(tempRoot!, 'cards', 'done'), { recursive: true })
    const sourcePath = join(tempRoot!, 'cards', 'todo', 'card.md')
    const original = [
      '---',
      'id: card',
      'title: Card',
      'column: todo',
      'sort_order: 0',
      '---',
      'Body'
    ].join('\n')
    await writeFile(sourcePath, original, 'utf-8')
    backend.invalidate('proj-cache')

    await expect(backend.move('proj-cache', 'card', 'in_progress', 5)).rejects.toThrow()

    expect(await readFile(sourcePath, 'utf-8')).toBe(original)
  })

  test('status-folder move source removal failure removes destination rollback file', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    mockState.project = {
      ...mockState.project!,
      kanban_markdown_config: JSON.stringify({
        layout: 'status-folders',
        statusFolders: {
          todo: 'cards/todo',
          in_progress: 'cards/in-progress',
          review: 'cards/review',
          done: 'cards/done'
        }
      })
    }
    const todoPath = join(tempRoot!, 'cards', 'todo')
    const inProgressPath = join(tempRoot!, 'cards', 'in-progress')
    await mkdir(todoPath, { recursive: true })
    await mkdir(inProgressPath, { recursive: true })
    await mkdir(join(tempRoot!, 'cards', 'review'), { recursive: true })
    await mkdir(join(tempRoot!, 'cards', 'done'), { recursive: true })
    const sourcePath = join(todoPath, 'card.md')
    await writeFile(
      sourcePath,
      ['---', 'id: card', 'title: Card', 'column: todo', 'sort_order: 0', '---', 'Body'].join('\n'),
      'utf-8'
    )
    await chmod(todoPath, 0o555)
    backend.invalidate('proj-cache')

    try {
      await expect(backend.move('proj-cache', 'card', 'in_progress', 5)).rejects.toThrow()
      await expect(access(join(inProgressPath, 'card.md'))).rejects.toThrow()
    } finally {
      await chmod(todoPath, 0o755).catch(() => {})
    }
  })

  test('importing a changed column relocates an existing status-folder card', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    mockState.project = {
      ...mockState.project!,
      kanban_markdown_config: JSON.stringify({
        layout: 'status-folders',
        statusFolders: {
          todo: 'cards/todo',
          in_progress: 'cards/in-progress',
          review: 'cards/review',
          done: 'cards/done'
        }
      })
    }
    const todoPath = join(tempRoot!, 'cards', 'todo')
    const donePath = join(tempRoot!, 'cards', 'done')
    await mkdir(todoPath, { recursive: true })
    await mkdir(join(tempRoot!, 'cards', 'in-progress'), { recursive: true })
    await mkdir(join(tempRoot!, 'cards', 'review'), { recursive: true })
    await mkdir(donePath, { recursive: true })
    const sourcePath = join(todoPath, 'card.md')
    const targetPath = join(donePath, 'card.md')
    await writeFile(
      sourcePath,
      ['---', 'id: card', 'title: Card', 'column: todo', 'sort_order: 0', '---', 'Body'].join('\n'),
      'utf-8'
    )
    backend.invalidate('proj-cache')

    await expect(
      backend.importTickets('proj-cache', [
        { id: 'card', title: 'Imported Card', description: 'Imported body', column: 'done' }
      ])
    ).resolves.toEqual({ created: 0, updated: 1, dependencyCount: 0, ignoredDependencyCount: 0 })

    await expect(access(sourcePath)).rejects.toThrow()
    await expect(stat(targetPath)).resolves.toBeTruthy()
    const moved = await readFile(targetPath, 'utf-8')
    expect(moved).toContain('column: done')
    expect(moved).toContain('Imported body')
  })

  test('markdown import only replaces dependencies within the selected import set', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardsPath = join(tempRoot!, 'cards')
    await writeFile(
      join(cardsPath, 'a.md'),
      [
        '---',
        'id: a',
        'title: A',
        'created_at: "2026-06-01T00:00:00.000Z"',
        'dependencies:',
        '  - blocker_id: b',
        '    created_at: "2026-06-01T00:00:00.000Z"',
        '---',
        'A body'
      ].join('\n'),
      'utf-8'
    )
    await writeFile(
      join(cardsPath, 'b.md'),
      [
        '---',
        'id: b',
        'title: B',
        'created_at: "2026-06-01T00:00:00.000Z"',
        'dependencies:',
        '  - blocker_id: a',
        '    created_at: "2026-06-01T00:00:00.000Z"',
        '  - blocker_id: c',
        '    created_at: "2026-06-01T00:00:00.000Z"',
        '---',
        'B body'
      ].join('\n'),
      'utf-8'
    )
    await writeFile(
      join(cardsPath, 'c.md'),
      ['---', 'id: c', 'title: C', 'created_at: "2026-06-01T00:00:00.000Z"', '---', 'C body'].join(
        '\n'
      ),
      'utf-8'
    )
    backend.invalidate('proj-cache')

    await expect(
      backend.importTickets(
        'proj-cache',
        [
          { id: 'b', title: 'Imported B', description: 'Imported B body', column: 'todo' },
          { id: 'c', title: 'Imported C', description: 'Imported C body', column: 'todo' }
        ],
        [{ dependentId: 'c', blockerId: 'b' }]
      )
    ).resolves.toEqual({ created: 0, updated: 2, dependencyCount: 1, ignoredDependencyCount: 0 })

    const a = frontmatterOf(await readFile(join(cardsPath, 'a.md'), 'utf-8'))
    const b = frontmatterOf(await readFile(join(cardsPath, 'b.md'), 'utf-8'))
    const c = frontmatterOf(await readFile(join(cardsPath, 'c.md'), 'utf-8'))
    expect(dependencyBlockersOf(a)).toEqual(['b'])
    expect(dependencyBlockersOf(b)).toEqual(['a'])
    expect(dependencyBlockersOf(c)).toEqual(['b'])
  })

  test('archiveAllDone archives done cards and removes dependency edges involving them in one pass', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardsPath = join(tempRoot!, 'cards')
    await writeFile(
      join(cardsPath, 'todo.md'),
      [
        '---',
        'id: todo',
        'title: Todo',
        'column: todo',
        'created_at: "2026-06-01T00:00:00.000Z"',
        'dependencies:',
        '  - blocker_id: done-a',
        '    created_at: "2026-06-01T00:00:00.000Z"',
        '  - blocker_id: other',
        '    created_at: "2026-06-01T00:00:00.000Z"',
        'depends_on:',
        '  - done-a',
        '  - other',
        '---',
        'Todo body'
      ].join('\n'),
      'utf-8'
    )
    await writeFile(
      join(cardsPath, 'done-a.md'),
      [
        '---',
        'id: done-a',
        'title: Done A',
        'column: done',
        'created_at: "2026-06-01T00:00:00.000Z"',
        'dependencies:',
        '  - blocker_id: todo',
        '    created_at: "2026-06-01T00:00:00.000Z"',
        'depends_on:',
        '  - todo',
        '---',
        'Done A body'
      ].join('\n'),
      'utf-8'
    )
    await writeFile(
      join(cardsPath, 'done-b.md'),
      [
        '---',
        'id: done-b',
        'title: Done B',
        'column: done',
        'created_at: "2026-06-01T00:00:00.000Z"',
        '---',
        'Done B body'
      ].join('\n'),
      'utf-8'
    )
    await writeFile(
      join(cardsPath, 'other.md'),
      [
        '---',
        'id: other',
        'title: Other',
        'column: todo',
        'created_at: "2026-06-01T00:00:00.000Z"',
        '---',
        'Other body'
      ].join('\n'),
      'utf-8'
    )
    backend.invalidate('proj-cache')

    await expect(backend.archiveAllDone('proj-cache')).resolves.toBe(2)

    const todo = frontmatterOf(await readFile(join(cardsPath, 'todo.md'), 'utf-8'))
    const doneA = frontmatterOf(await readFile(join(cardsPath, 'done-a.md'), 'utf-8'))
    const doneB = frontmatterOf(await readFile(join(cardsPath, 'done-b.md'), 'utf-8'))
    expect(dependencyBlockersOf(todo)).toEqual(['other'])
    expect(dependencyBlockersOf(doneA)).toEqual([])
    expect(todo).not.toHaveProperty('depends_on')
    expect(doneA).not.toHaveProperty('depends_on')
    expect(typeof doneA.archived_at).toBe('string')
    expect(typeof doneB.archived_at).toBe('string')
  })

  test('delete removes markdown dependency references before unlinking the card', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardsPath = join(tempRoot!, 'cards')
    const dependentPath = join(cardsPath, 'a.md')
    const blockerPath = join(cardsPath, 'b.md')
    await writeFile(
      dependentPath,
      [
        '---',
        'id: a',
        'title: A',
        'created_at: "2026-06-01T00:00:00.000Z"',
        'dependencies:',
        '  - blocker_id: b',
        '    created_at: "2026-06-01T00:00:00.000Z"',
        'depends_on:',
        '  - b',
        '---',
        'A body'
      ].join('\n'),
      'utf-8'
    )
    await writeFile(
      blockerPath,
      ['---', 'id: b', 'title: B', 'created_at: "2026-06-01T00:00:00.000Z"', '---', 'B body'].join(
        '\n'
      ),
      'utf-8'
    )
    mockState.runtimeRows = [{ card_id: 'b', orphaned_at: null }]
    backend.invalidate('proj-cache')

    await expect(backend.delete('proj-cache', 'b')).resolves.toBe(true)

    await expect(access(blockerPath)).rejects.toThrow()
    const dependent = frontmatterOf(await readFile(dependentPath, 'utf-8'))
    expect(dependencyBlockersOf(dependent)).toEqual([])
    expect(dependent).not.toHaveProperty('depends_on')
    expect(mockState.runtimeRows.some((row) => row.card_id === 'b')).toBe(false)
  })

  test('import aborts before creating files when selected markdown id is duplicated', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const duplicateAPath = join(tempRoot!, 'cards', 'duplicate-a.md')
    const duplicateBPath = join(tempRoot!, 'cards', 'duplicate-b.md')
    const duplicateA = ['---', 'id: duplicate', 'title: Duplicate A', '---', 'A'].join('\n')
    const duplicateB = ['---', 'id: duplicate', 'title: Duplicate B', '---', 'B'].join('\n')
    await writeFile(duplicateAPath, duplicateA, 'utf-8')
    await writeFile(duplicateBPath, duplicateB, 'utf-8')
    backend.invalidate('proj-cache')

    await expect(
      backend.importTickets('proj-cache', [
        {
          id: 'duplicate',
          title: 'Imported Duplicate',
          description: 'Should not be written',
          column: 'todo'
        }
      ])
    ).rejects.toThrow(/duplicated/i)

    expect(await readFile(duplicateAPath, 'utf-8')).toBe(duplicateA)
    expect(await readFile(duplicateBPath, 'utf-8')).toBe(duplicateB)
    const files = await readdir(join(tempRoot!, 'cards'))
    expect(files.filter((file) => file.endsWith('.md')).sort()).toEqual([
      'duplicate-a.md',
      'duplicate-b.md'
    ])
  })

  test('PR sync skips orphaned markdown runtime rows and updates remaining cards', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardPath = join(tempRoot!, 'cards', 'linked-card.md')
    await writeFile(
      cardPath,
      ['---', 'id: linked-card', 'title: Linked Card', '---', 'Body'].join('\n'),
      'utf-8'
    )
    mockState.runtimeRows = [
      {
        project_id: 'proj-cache',
        card_id: 'missing-card',
        worktree_id: 'wt-1',
        orphaned_at: null
      },
      {
        project_id: 'proj-cache',
        card_id: 'linked-card',
        worktree_id: 'wt-1',
        orphaned_at: null
      }
    ]
    backend.invalidate('proj-cache')

    await expect(
      backend.syncPR('wt-1', 42, 'https://github.com/acme/hive/pull/42')
    ).resolves.toBeUndefined()

    const frontmatter = frontmatterOf(await readFile(cardPath, 'utf-8'))
    expect(frontmatter.github_pr_number).toBe(42)
    expect(frontmatter.github_pr_url).toBe('https://github.com/acme/hive/pull/42')
  })

  test('PR clear skips orphaned markdown runtime rows and updates remaining cards', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const cardPath = join(tempRoot!, 'cards', 'linked-card.md')
    await writeFile(
      cardPath,
      [
        '---',
        'id: linked-card',
        'title: Linked Card',
        'github_pr_number: 42',
        'github_pr_url: https://github.com/acme/hive/pull/42',
        '---',
        'Body'
      ].join('\n'),
      'utf-8'
    )
    mockState.runtimeRows = [
      {
        project_id: 'proj-cache',
        card_id: 'missing-card',
        worktree_id: 'wt-1',
        orphaned_at: null
      },
      {
        project_id: 'proj-cache',
        card_id: 'linked-card',
        worktree_id: 'wt-1',
        orphaned_at: null
      }
    ]
    backend.invalidate('proj-cache')

    await expect(backend.clearPR('wt-1')).resolves.toBeUndefined()

    const frontmatter = frontmatterOf(await readFile(cardPath, 'utf-8'))
    expect(frontmatter.github_pr_number).toBeNull()
    expect(frontmatter.github_pr_url).toBeNull()
  })

  test('diagnostics reads do not consume the orphan runtime-state grace scan', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    backend.invalidate('proj-cache')

    await backend.list('proj-cache', true)
    expect(mockState.orphanMarkCount).toBe(1)
    expect(mockState.orphanDeleteCount).toBe(0)
    expect(mockState.runtimeRows).toHaveLength(1)

    await backend.getDiagnostics('proj-cache')
    expect(mockState.orphanMarkCount).toBe(1)
    expect(mockState.orphanDeleteCount).toBe(0)
    expect(mockState.runtimeRows).toHaveLength(1)

    await backend.list('proj-cache', true)
    expect(mockState.orphanDeleteCount).toBe(1)
    expect(mockState.runtimeRows).toHaveLength(0)
  })

  test('duplicate-id runtime rows are preserved while missing rows still expire', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    await writeFile(
      join(tempRoot!, 'cards', 'duplicate-a.md'),
      ['---', 'id: duplicate', 'title: Duplicate A', '---', 'A'].join('\n'),
      'utf-8'
    )
    await writeFile(
      join(tempRoot!, 'cards', 'duplicate-b.md'),
      ['---', 'id: duplicate', 'title: Duplicate B', '---', 'B'].join('\n'),
      'utf-8'
    )
    mockState.runtimeRows = [
      { card_id: 'duplicate', orphaned_at: null },
      { card_id: 'missing-card', orphaned_at: null }
    ]
    backend.invalidate('proj-cache')

    await backend.list('proj-cache', true)
    expect(mockState.runtimeRows).toEqual([
      { card_id: 'duplicate', orphaned_at: null },
      expect.objectContaining({ card_id: 'missing-card', orphaned_at: expect.any(String) })
    ])
    expect(mockState.orphanMarkCount).toBe(1)
    expect(mockState.orphanDeleteCount).toBe(0)

    await backend.list('proj-cache', true)
    expect(mockState.runtimeRows).toEqual([{ card_id: 'duplicate', orphaned_at: null }])
    expect(mockState.orphanDeleteCount).toBe(1)
  })

  test('invalid known-id runtime rows are preserved while missing rows still expire', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    await writeFile(
      join(tempRoot!, 'cards', 'invalid-known-id.md'),
      [
        '---',
        'id: invalid-card',
        'title: Invalid Card',
        'column: invalid-column',
        '---',
        'Body'
      ].join('\n'),
      'utf-8'
    )
    mockState.runtimeRows = [
      { card_id: 'invalid-card', orphaned_at: null },
      { card_id: 'missing-card', orphaned_at: null }
    ]
    backend.invalidate('proj-cache')

    await backend.list('proj-cache', true)
    expect(mockState.runtimeRows).toEqual([
      { card_id: 'invalid-card', orphaned_at: null },
      expect.objectContaining({ card_id: 'missing-card', orphaned_at: expect.any(String) })
    ])
    expect(mockState.orphanMarkCount).toBe(1)
    expect(mockState.orphanDeleteCount).toBe(0)

    await backend.list('proj-cache', true)
    expect(mockState.runtimeRows).toEqual([{ card_id: 'invalid-card', orphaned_at: null }])
    expect(mockState.orphanDeleteCount).toBe(1)
  })

  test('parse-error runtime rows are preserved by last seen path', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const brokenPath = join(tempRoot!, 'cards', 'broken.md')
    await writeFile(
      brokenPath,
      ['---', 'id: broken-card', 'title: [unterminated', '---', 'Body'].join('\n'),
      'utf-8'
    )
    mockState.runtimeRows = [
      { card_id: 'broken-card', last_seen_path: brokenPath, orphaned_at: null },
      { card_id: 'missing-card', orphaned_at: null }
    ]
    backend.invalidate('proj-cache')

    await backend.list('proj-cache', true)
    expect(mockState.runtimeRows).toEqual([
      { card_id: 'broken-card', last_seen_path: brokenPath, orphaned_at: null },
      expect.objectContaining({ card_id: 'missing-card', orphaned_at: expect.any(String) })
    ])
    expect(mockState.orphanMarkCount).toBe(1)
    expect(mockState.orphanDeleteCount).toBe(0)

    await backend.list('proj-cache', true)
    expect(mockState.runtimeRows).toEqual([
      { card_id: 'broken-card', last_seen_path: brokenPath, orphaned_at: null }
    ])
    expect(mockState.orphanDeleteCount).toBe(1)
  })

  test('id-less runtime rows are preserved by last seen path', async () => {
    const backend = (
      await import('../../src/main/services/kanban-backend')
    ).getMarkdownKanbanBackend()
    const idlessPath = join(tempRoot!, 'cards', 'temporarily-idless.md')
    await writeFile(
      idlessPath,
      ['---', 'title: Temporarily ID-less', 'column: todo', '---', 'Body'].join('\n'),
      'utf-8'
    )
    mockState.runtimeRows = [
      { card_id: 'known-card', last_seen_path: idlessPath, orphaned_at: null },
      { card_id: 'missing-card', orphaned_at: null }
    ]
    backend.invalidate('proj-cache')

    await backend.list('proj-cache', true)
    expect(mockState.runtimeRows).toEqual([
      { card_id: 'known-card', last_seen_path: idlessPath, orphaned_at: null },
      expect.objectContaining({ card_id: 'missing-card', orphaned_at: expect.any(String) })
    ])
    expect(mockState.orphanMarkCount).toBe(1)
    expect(mockState.orphanDeleteCount).toBe(0)

    await backend.list('proj-cache', true)
    expect(mockState.runtimeRows).toEqual([
      { card_id: 'known-card', last_seen_path: idlessPath, orphaned_at: null }
    ])
    expect(mockState.orphanDeleteCount).toBe(1)
  })
})
