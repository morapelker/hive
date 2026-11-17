import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scanHooks = vi.hoisted(() => ({
  /** Runs each time a board scan is about to list a card folder: after it read the project row. */
  beforeReaddir: null as ((folder: string) => void) | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readdir = ((...args: Parameters<typeof actual.readdir>) => {
    scanHooks.beforeReaddir?.(String(args[0]))
    return actual.readdir(...args)
  }) as typeof actual.readdir
  return { ...actual, default: { ...actual, readdir }, readdir }
})

import { closeDatabase, getDatabase } from '../../db'
import type { KanbanBackend } from '../kanban-backend'
import { getKanbanBackendForProject, getMarkdownKanbanBackend } from '../kanban-backend'

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

interface RuntimeRow {
  card_id: string
  note: string | null
  last_seen_path: string | null
  last_known_column: string | null
  column_changed_at: string | null
  orphaned_at: string | null
  updated_at: string
}

/**
 * A board scan reads the project row, then reads the card folders. When the project is moved
 * to another folder in between (one tick: rename + row update), the scan must not conclude
 * that every card is gone: that stamps the cards' runtime rows as orphaned, and the next such
 * scan deletes them (session links, notes, labels).
 */
describeIf('MarkdownKanbanBackend while its project moves', () => {
  let root: string
  let projectId: string
  let oldPath: string
  let backend: KanbanBackend

  const rawDb = (): ReturnType<ReturnType<typeof getDatabase>['getRawDb']> =>
    getDatabase().getRawDb()

  const runtimeRows = (): RuntimeRow[] =>
    rawDb()
      .prepare(
        `SELECT card_id, note, last_seen_path, last_known_column, column_changed_at, orphaned_at,
                updated_at
         FROM markdown_kanban_card_state WHERE project_id = ? ORDER BY card_id`
      )
      .all(projectId) as RuntimeRow[]

  /** What moving a project does in one tick: the folder, the row, the paths stored for its cards. */
  const relocate = (from: string, to: string): void => {
    mkdirSync(join(to, '..'), { recursive: true })
    renameSync(from, to)
    rawDb().prepare('UPDATE projects SET path = ? WHERE id = ?').run(to, projectId)
    for (const row of runtimeRows()) {
      if (!row.last_seen_path?.startsWith(from + sep)) continue
      rawDb()
        .prepare(
          'UPDATE markdown_kanban_card_state SET last_seen_path = ? WHERE project_id = ? AND card_id = ?'
        )
        .run(to + row.last_seen_path.slice(from.length), projectId, row.card_id)
    }
    getMarkdownKanbanBackend().invalidate(projectId)
  }

  const movedRows = (rows: RuntimeRow[], from: string, to: string): RuntimeRow[] =>
    rows.map((row) => ({
      ...row,
      last_seen_path: row.last_seen_path ? to + row.last_seen_path.slice(from.length) : null
    }))

  const seedCards = async (): Promise<string[]> => {
    const first = await backend.create(projectId, {
      project_id: projectId,
      title: 'First card',
      note: 'first note'
    })
    const second = await backend.create(projectId, {
      project_id: projectId,
      title: 'Second card',
      note: 'second note'
    })
    await backend.list(projectId, false)
    return [first.id, second.id].sort()
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-markdown-moved-project-')))
    oldPath = join(root, 'old', 'proj')
    mkdirSync(oldPath, { recursive: true })

    process.env.HIVE_SERVER_DB_PATH = join(root, 'db', 'hive.db')
    mkdirSync(join(root, 'db'))
    closeDatabase()
    const db = getDatabase()
    const project = db.createProject({ name: 'Markdown Project', path: oldPath })
    db.updateProjectKanbanStorageMode(project.id, 'markdown')
    projectId = project.id
    backend = getKanbanBackendForProject(projectId)
  })

  afterEach(() => {
    scanHooks.beforeReaddir = null
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    rmSync(root, { recursive: true, force: true })
  })

  it('reads the cards from the new folder when the project moves during a scan', async () => {
    const ids = await seedCards()
    const before = runtimeRows()
    expect(before.map((row) => row.card_id)).toEqual(ids)
    expect(before.every((row) => row.last_seen_path?.startsWith(oldPath + sep))).toBe(true)

    const newPath = join(root, 'new', 'proj')
    let folderReads = 0
    scanHooks.beforeReaddir = () => {
      folderReads++
      if (folderReads === 1) relocate(oldPath, newPath)
    }

    const listed = await backend.list(projectId, false)

    expect(folderReads).toBe(2)
    expect(listed.map((ticket) => ticket.id).sort()).toEqual(ids)
    expect(listed.map((ticket) => ticket.note).sort()).toEqual(['first note', 'second note'])
    expect(runtimeRows()).toEqual(movedRows(before, oldPath, newPath))
    // The outdated scan did not put anything back where the project used to be.
    expect(existsSync(oldPath)).toBe(false)
  })

  it('keeps every runtime row when two scans overlap the move', async () => {
    const ids = await seedCards()
    const before = runtimeRows()

    const newPath = join(root, 'new', 'proj')
    let folderReads = 0
    scanHooks.beforeReaddir = () => {
      folderReads++
      if (folderReads === 1) relocate(oldPath, newPath)
    }

    // Both scans read the project row at its old path before either lists a folder: without
    // the check, the first stamps every row as orphaned and the second deletes them.
    const [first, second] = await Promise.all([
      backend.list(projectId, false),
      backend.list(projectId, false)
    ])

    expect(first.map((ticket) => ticket.id).sort()).toEqual(ids)
    expect(second.map((ticket) => ticket.id).sort()).toEqual(ids)
    expect(runtimeRows()).toEqual(movedRows(before, oldPath, newPath))
  })

  it('scans again when the board folders change during a scan', async () => {
    const ids = await seedCards()
    const before = runtimeRows()

    const oldFolder = join(oldPath, 'docs', 'kanban')
    const newFolder = join(oldPath, 'board')
    let folderReads = 0
    scanHooks.beforeReaddir = () => {
      folderReads++
      if (folderReads !== 1) return
      renameSync(oldFolder, newFolder)
      getDatabase().updateProjectKanbanMarkdownConfig(
        projectId,
        JSON.stringify({ layout: 'single-folder', singleFolder: 'board' })
      )
    }

    const listed = await backend.list(projectId, false)

    expect(folderReads).toBe(2)
    expect(listed.map((ticket) => ticket.id).sort()).toEqual(ids)
    expect(runtimeRows()).toEqual(movedRows(before, oldFolder, newFolder))
  })

  it('refuses, changing nothing, when the project moves again during the second scan', async () => {
    const ids = await seedCards()
    const before = runtimeRows()

    const midPath = join(root, 'mid', 'proj')
    const newPath = join(root, 'new', 'proj')
    let folderReads = 0
    scanHooks.beforeReaddir = () => {
      folderReads++
      if (folderReads === 1) relocate(oldPath, midPath)
      if (folderReads === 2) relocate(midPath, newPath)
    }

    await expect(backend.list(projectId, false)).rejects.toThrow(
      /changed while its board was being read/
    )

    // Two scans, each of a folder the project had already left: no row stamped, none deleted.
    expect(folderReads).toBe(2)
    expect(runtimeRows()).toEqual(movedRows(before, oldPath, newPath))
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(midPath)).toBe(false)

    // Neither outdated scan was kept as the board: the next read scans the folder in effect.
    scanHooks.beforeReaddir = null
    expect((await backend.get(projectId, ids[0]))?.id).toBe(ids[0])
    const listed = await backend.list(projectId, false)
    expect(listed.map((ticket) => ticket.id).sort()).toEqual(ids)
    expect(runtimeRows()).toEqual(movedRows(before, oldPath, newPath))
  })

  it('reports a project that was removed during a scan as not found', async () => {
    await seedCards()
    scanHooks.beforeReaddir = () => {
      scanHooks.beforeReaddir = null
      getDatabase().deleteProject(projectId)
    }

    await expect(backend.list(projectId, false)).rejects.toThrow(`Project not found: ${projectId}`)
  })

  it('still orphans, then forgets, a card whose file was deleted while nothing moved', async () => {
    const ids = await seedCards()
    const [gone, kept] = runtimeRows()
    rmSync(gone.last_seen_path!)

    let folderReads = 0
    scanHooks.beforeReaddir = () => {
      folderReads++
    }

    expect((await backend.list(projectId, false)).map((ticket) => ticket.id)).toEqual([
      kept.card_id
    ])
    const stamped = runtimeRows()
    expect(stamped.map((row) => row.card_id)).toEqual(ids)
    expect(stamped.find((row) => row.card_id === gone.card_id)?.orphaned_at).not.toBeNull()
    expect(stamped.find((row) => row.card_id === kept.card_id)?.orphaned_at).toBeNull()

    await backend.list(projectId, false)
    expect(runtimeRows().map((row) => row.card_id)).toEqual([kept.card_id])
    // One folder read per scan: an unchanged project is never scanned twice.
    expect(folderReads).toBe(2)
  })
})
