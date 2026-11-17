/**
 * A markdown board after "Move projects" (Settings › General › Dev folder) has moved a project,
 * when the board's card folder is given relative to its project and the move takes the two
 * apart: the cards stay behind while the project leaves, or the cards leave while the project
 * that reads them stays. A board that looks for its cards in a folder that is not there lists
 * none, stamps what the app keeps about every card as orphaned, and deletes it on the scan
 * after that: notes, session links, labels, attachments.
 *
 * Real here: the database (a file in a temp directory), `DatabaseService.relocateProject`, the
 * folders and the board backend. The move's own follow-ups (stopping and restarting the board
 * watch) are not part of this: the board is invalidated by hand, as any later reload does.
 *
 * The home directory and the database path are pointed into the temp directory before anything
 * is imported. Needs better-sqlite3 for the app's runtime:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     src/main/services/__tests__/kanban-backend.markdown-moved-project.db.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sandboxed = await vi.hoisted(async () => {
  const { mkdirSync, mkdtempSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'hive-board-moved-project-')))
  const home = join(sandbox, 'home')
  mkdirSync(home)
  const names = ['HOME', 'USERPROFILE', 'HIVE_SERVER_DB_PATH', 'HIVE_SERVER_BASE_DIR']
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.HIVE_SERVER_DB_PATH = join(sandbox, 'unused.sqlite')
  delete process.env.HIVE_SERVER_BASE_DIR
  const restore = (): void => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    }
  }
  return { sandbox, home, restore }
})

import { closeDatabase, getDatabase } from '../../db'
import type { Project } from '../../db'
import type { RelocateProjectResult } from '../dev-folder/types'
import { getKanbanBackendForProject, getMarkdownKanbanBackend } from '../kanban-backend'

const { sandbox, home } = sandboxed

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

afterAll(() => {
  sandboxed.restore()
  rmSync(sandbox, { recursive: true, force: true })
})

// One test always runs, so the temp directory made above is removed under plain Node too: a
// file whose tests are all skipped runs none of its hooks.
if (!canRunDatabaseTests()) {
  it('skips when better-sqlite3 is not available for this Node runtime', () => {
    expect(databaseLoadError).not.toBeNull()
  })
}

interface CardRow {
  card_id: string
  note: string | null
  last_seen_path: string | null
  orphaned_at: string | null
}

describeIf('a markdown board with a relative card folder, after a project moved', () => {
  /** The folder the projects are in before the move, and the dev folder they move to. */
  let oldFolder: string
  let newFolder: string

  const markdownProject = (name: string, cardFolder: string | null): Project => {
    const db = getDatabase()
    const path = join(oldFolder, name)
    mkdirSync(path, { recursive: true })
    const project = db.createProject({ name, path })
    db.updateProjectKanbanStorageMode(project.id, 'markdown')
    if (cardFolder !== null) {
      db.updateProjectKanbanMarkdownConfig(
        project.id,
        JSON.stringify({ layout: 'single-folder', singleFolder: cardFolder })
      )
    }
    return getDatabase().getProject(project.id)!
  }

  /** Two cards made through the board, each with something only the database keeps. */
  const seedCards = async (projectId: string): Promise<string[]> => {
    const backend = getKanbanBackendForProject(projectId)
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

  const cardRows = (projectId: string): CardRow[] =>
    getDatabase()
      .getRawDb()
      .prepare(
        `SELECT card_id, note, last_seen_path, orphaned_at FROM markdown_kanban_card_state
          WHERE project_id = ? ORDER BY card_id`
      )
      .all(projectId) as CardRow[]

  const cardFiles = (folder: string): string[] =>
    existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.md')) : []

  /** What "Move projects" does to one project: the folder and the database, in one step. */
  const move = (project: Project): RelocateProjectResult => {
    const to = join(newFolder, project.name)
    const relocations = [{ from: [project.path], to }]
    return getDatabase().relocateProject({
      projectId: project.id,
      expectedPath: project.path,
      relocations,
      homeDir: home,
      pending: {
        projectId: project.id,
        fromPath: project.path,
        fromRealPath: project.path,
        toPath: to,
        relocations
      },
      place: () => {
        mkdirSync(dirname(to), { recursive: true })
        renameSync(project.path, to)
      }
    })
  }

  /** A scan of the board as a reload makes it: nothing remembered from before the move. */
  const scan = async (projectId: string): Promise<string[]> => {
    getMarkdownKanbanBackend().invalidate(projectId)
    const listed = await getKanbanBackendForProject(projectId).list(projectId, false)
    return listed.map((ticket) => ticket.id).sort()
  }

  beforeEach(() => {
    const root = mkdtempSync(join(sandbox, 'case-'))
    oldFolder = join(root, 'old')
    newFolder = join(root, 'new')
    mkdirSync(oldFolder)
    mkdirSync(join(root, 'db'))
    process.env.HIVE_SERVER_DB_PATH = join(root, 'db', 'state.sqlite')
    closeDatabase()
    getDatabase()
  })

  afterEach(() => {
    closeDatabase()
  })

  it('still lists the cards kept in a folder next to the project, which stayed where it was', async () => {
    const project = markdownProject('proj', '../boards/proj')
    const ids = await seedCards(project.id)
    const boardFolder = join(oldFolder, 'boards', 'proj')
    const before = cardRows(project.id)
    expect(before.map((row) => row.card_id)).toEqual(ids)
    expect(before.every((row) => row.last_seen_path?.startsWith(boardFolder + sep))).toBe(true)
    expect(cardFiles(boardFolder)).toHaveLength(2)

    move(project)

    // The card files did not move: only the project did.
    expect(existsSync(join(newFolder, 'proj'))).toBe(true)
    expect(cardFiles(boardFolder)).toHaveLength(2)
    expect(existsSync(join(newFolder, 'boards'))).toBe(false)

    expect(await scan(project.id)).toEqual(ids)
    expect(cardRows(project.id)).toEqual(before)
    // The scan after the one that would have stamped the rows is the one that deletes them.
    expect(await scan(project.id)).toEqual(ids)
    expect(cardRows(project.id)).toEqual(before)
    expect(cardRows(project.id).map((row) => row.note)).toEqual(['first note', 'second note'])
  })

  it('still lists the cards another project reads from inside the project that moved', async () => {
    const project = markdownProject('proj', null)
    const board = markdownProject('board', '../proj/docs/kanban')
    const ids = await seedCards(board.id)
    const oldBoardFolder = join(oldFolder, 'proj', 'docs', 'kanban')
    const newBoardFolder = join(newFolder, 'proj', 'docs', 'kanban')
    const before = cardRows(board.id)
    expect(before.map((row) => row.card_id)).toEqual(ids)
    expect(before.every((row) => row.last_seen_path?.startsWith(oldBoardFolder + sep))).toBe(true)

    const result = move(project)

    expect(result.otherProjectIds).toEqual([board.id])
    expect(cardFiles(newBoardFolder)).toHaveLength(2)
    const moved = before.map((row) => ({
      ...row,
      last_seen_path: newBoardFolder + row.last_seen_path!.slice(oldBoardFolder.length)
    }))

    expect(await scan(board.id)).toEqual(ids)
    expect(cardRows(board.id)).toEqual(moved)
    expect(await scan(board.id)).toEqual(ids)
    expect(cardRows(board.id)).toEqual(moved)
    // Nothing was put back where the project used to be.
    expect(existsSync(join(oldFolder, 'proj'))).toBe(false)
  })

  it('still lists the cards of a board inside the project, whose folder is kept as typed', async () => {
    const project = markdownProject('proj', 'docs/board')
    const ids = await seedCards(project.id)
    const oldBoardFolder = join(oldFolder, 'proj', 'docs', 'board')
    const newBoardFolder = join(newFolder, 'proj', 'docs', 'board')
    const before = cardRows(project.id)

    move(project)

    expect(getDatabase().getProject(project.id)?.kanban_markdown_config).toBe(
      JSON.stringify({ layout: 'single-folder', singleFolder: 'docs/board' })
    )
    const moved = before.map((row) => ({
      ...row,
      last_seen_path: newBoardFolder + row.last_seen_path!.slice(oldBoardFolder.length)
    }))
    expect(await scan(project.id)).toEqual(ids)
    expect(cardRows(project.id)).toEqual(moved)
    expect(await scan(project.id)).toEqual(ids)
    expect(cardRows(project.id)).toEqual(moved)
  })
})
