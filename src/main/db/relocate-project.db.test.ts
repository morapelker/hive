// The database side of "Move projects" (Settings › General › Dev folder):
// DatabaseService.relocateProject, the pending-move row, namesRegisteredInside and
// listDocumentRunsInStatuses, on a real database in a temp directory. Every project path here
// is only a string in that database: nothing is read or written at those paths.
// Needs better-sqlite3 for the Electron ABI: run with
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run <file>
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DbChangedEvent } from '../../shared/db-change-events'
import { DEFAULT_DOCUMENT_RUN_CONFIG } from '../../shared/types/document-flow'
import type { DocumentRunStatus } from '../../shared/types/document-flow'
import {
  flushPendingDbChangedEvents,
  setDbChangeEventPublisher
} from '../services/db-change-events'
import {
  DEV_FOLDER_PENDING_MOVE_KEY,
  type PendingDevFolderMove,
  type RelocateProjectInput,
  type RelocationMove
} from '../services/dev-folder/types'
import { DatabaseService } from './database'
import type { Project } from './types'

const tempDirs: string[] = []
const openDbs: DatabaseService[] = []
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

const publisher = vi.fn<(channel: string, payload: unknown) => Promise<void>>(async () => {})

/** Flushes the coalescing queue and returns every event published since the last drain. */
const drain = (): DbChangedEvent[] => {
  flushPendingDbChangedEvents()
  const events = publisher.mock.calls.map(([, payload]) => payload as DbChangedEvent)
  publisher.mockClear()
  return events
}

const openDb = (): DatabaseService => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-relocate-project-'))
  tempDirs.push(dir)
  const db = new DatabaseService(join(dir, 'state.sqlite'))
  db.init()
  openDbs.push(db)
  drain()
  return db
}

beforeEach(() => {
  publisher.mockClear()
  setDbChangeEventPublisher(publisher)
})

afterEach(() => {
  flushPendingDbChangedEvents()
  setDbChangeEventPublisher(null)
  for (const db of openDbs.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

const HOME = '/home/tester'
/** The folder the projects are in, as the app stored it, and as git prints it (its real path). */
const OLD = `${HOME}/hive-projects`
const OLD_REAL = `/private${OLD}`
const NEW = `${HOME}/dev`
/** A timestamp no test run can produce: still there afterwards means the row was not stamped. */
const STAMP = '2020-01-02T03:04:05.000Z'

type Row = Record<string, unknown>

const one = (db: DatabaseService, sql: string, ...params: unknown[]): Row =>
  db
    .getRawDb()
    .prepare(sql)
    .get(...params) as Row

const all = (db: DatabaseService, sql: string, ...params: unknown[]): Row[] =>
  db
    .getRawDb()
    .prepare(sql)
    .all(...params) as Row[]

const run = (db: DatabaseService, sql: string, ...params: unknown[]): void => {
  db.getRawDb()
    .prepare(sql)
    .run(...params)
}

const TABLES = [
  'projects',
  'worktrees',
  'settings',
  'document_runs',
  'document_run_items',
  'kanban_tickets',
  'markdown_kanban_card_state',
  'sessions',
  'data_projects'
] as const

/** Every row of every table a move can write to. */
const snapshot = (db: DatabaseService): Record<string, Row[]> =>
  Object.fromEntries(
    TABLES.map((table) => [table, all(db, `SELECT * FROM ${table} ORDER BY rowid`)])
  )

const addProject = (
  db: DatabaseService,
  name: string,
  path: string,
  columns: Record<string, string | number | null> = {}
): Project => {
  const project = db.createProject({ name, path })
  for (const [column, value] of Object.entries(columns)) {
    run(db, `UPDATE projects SET ${column} = ? WHERE id = ?`, value, project.id)
  }
  return db.getProject(project.id)!
}

const addWorktree = (
  db: DatabaseService,
  project: Project,
  name: string,
  path: string,
  options: { isDefault?: boolean; archived?: boolean } = {}
): string => {
  const worktree = db.createWorktree({
    project_id: project.id,
    name,
    branch_name: name,
    path,
    is_default: options.isDefault ?? false
  })
  if (options.archived) {
    run(db, `UPDATE worktrees SET status = 'archived' WHERE id = ?`, worktree.id)
  }
  return worktree.id
}

const projectRow = (db: DatabaseService, id: string): Row =>
  one(db, 'SELECT * FROM projects WHERE id = ?', id)

const worktreePath = (db: DatabaseService, id: string): unknown =>
  one(db, 'SELECT path FROM worktrees WHERE id = ?', id).path

const addTicket = (
  db: DatabaseService,
  projectId: string,
  columns: Record<string, string | null> = {}
): string => {
  const ticket = db.createKanbanTicket({ project_id: projectId, title: 'A ticket' })
  for (const [column, value] of Object.entries({ ...columns, updated_at: STAMP })) {
    run(db, `UPDATE kanban_tickets SET ${column} = ? WHERE id = ?`, value, ticket.id)
  }
  return ticket.id
}

const ticketRow = (db: DatabaseService, id: string): Row =>
  one(db, 'SELECT * FROM kanban_tickets WHERE id = ?', id)

let runCounter = 0

const addRun = (
  db: DatabaseService,
  projectId: string,
  columns: { source_path: string; members?: unknown; status?: DocumentRunStatus }
): string => {
  runCounter += 1
  const id = `run-${runCounter}`
  db.createDocumentRun({
    id,
    project_id: projectId,
    title: `Run ${runCounter}`,
    source_path: columns.source_path,
    run_dir: `${HOME}/.hive/document-runs/${id}`,
    status: columns.status ?? 'completed',
    config: DEFAULT_DOCUMENT_RUN_CONFIG
  })
  run(
    db,
    'UPDATE document_runs SET members = ?, updated_at = ? WHERE id = ?',
    columns.members === undefined ? null : JSON.stringify(columns.members),
    STAMP,
    id
  )
  return id
}

const runRow = (db: DatabaseService, id: string): Row =>
  one(db, 'SELECT * FROM document_runs WHERE id = ?', id)

const addRunItem = (
  db: DatabaseService,
  runId: string,
  item: { title: string; summary: string; description: string; open_questions: string }
): string => {
  const id = `${runId}-item-${all(db, 'SELECT id FROM document_run_items').length + 1}`
  run(
    db,
    `INSERT INTO document_run_items
       (id, run_id, item_key, title, summary, description, open_questions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    runId,
    id,
    item.title,
    item.summary,
    item.description,
    item.open_questions,
    STAMP,
    STAMP
  )
  return id
}

const itemRow = (db: DatabaseService, id: string): Row =>
  one(db, 'SELECT * FROM document_run_items WHERE id = ?', id)

const addCard = (
  db: DatabaseService,
  projectId: string,
  cardId: string,
  columns: {
    last_seen_path: string | null
    attachments?: string
    pending_launch_config?: string | null
  }
): void => {
  run(
    db,
    `INSERT INTO markdown_kanban_card_state
       (project_id, card_id, last_seen_path, attachments, pending_launch_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    cardId,
    columns.last_seen_path,
    columns.attachments ?? '[]',
    columns.pending_launch_config ?? null,
    STAMP,
    STAMP
  )
}

const cardRow = (db: DatabaseService, projectId: string, cardId: string): Row =>
  one(
    db,
    'SELECT * FROM markdown_kanban_card_state WHERE project_id = ? AND card_id = ?',
    projectId,
    cardId
  )

const shellSnapshot = (script: string, state: string): string =>
  JSON.stringify({
    commandId: 'cmd-1',
    name: 'Deploy',
    script,
    detached: false,
    state,
    runId: 'run_1',
    exitCode: state === 'succeeded' ? 0 : null,
    signal: null,
    reason: null,
    error: null,
    startedAt: STAMP,
    finishedAt: state === 'running' ? null : STAMP
  })

const addShellSession = (
  db: DatabaseService,
  project: Project,
  worktreeId: string,
  shellCommand: string
): string => {
  const session = db.createSession({
    worktree_id: worktreeId,
    project_id: project.id,
    session_type: 'shell-command',
    shell_command: shellCommand
  })
  run(db, 'UPDATE sessions SET updated_at = ? WHERE id = ?', STAMP, session.id)
  return session.id
}

const sessionRow = (db: DatabaseService, id: string): Row =>
  one(db, 'SELECT * FROM sessions WHERE id = ?', id)

const addDataProject = (db: DatabaseService, id: string, config: string): void => {
  run(
    db,
    `INSERT INTO data_projects (id, name, engine, config, created_at, last_accessed_at)
     VALUES (?, ?, 'sqlite', ?, ?, ?)`,
    id,
    id,
    config,
    STAMP,
    STAMP
  )
}

const dataConfig = (db: DatabaseService, id: string): unknown =>
  one(db, 'SELECT config FROM data_projects WHERE id = ?', id).config

const moveInput = (
  project: Project,
  relocations: RelocationMove[],
  overrides: Partial<RelocateProjectInput> = {}
): RelocateProjectInput => {
  const pending: PendingDevFolderMove = {
    projectId: project.id,
    fromPath: project.path,
    fromRealPath: relocations[0]?.from[1] ?? null,
    toPath: relocations[0]?.to ?? '',
    relocations
  }
  return {
    projectId: project.id,
    expectedPath: project.path,
    relocations,
    homeDir: HOME,
    pending,
    place: () => {},
    ...overrides
  }
}

/** The usual move: `<OLD>/app` (also known by its real path) to `<NEW>/app`. */
const appMove = (
  project: Project,
  overrides: Partial<RelocateProjectInput> = {}
): RelocateProjectInput =>
  moveInput(project, [{ from: [`${OLD}/app`, `${OLD_REAL}/app`], to: `${NEW}/app` }], overrides)

const pendingLaunch = (prompt: string): string =>
  JSON.stringify({
    worktree: { type: 'new', sourceBranch: 'main' },
    prompt,
    mode: 'build',
    model: null,
    sdk: 'claude-code',
    codexFastMode: false,
    goalMode: false,
    goalSuccessCriteria: null
  })

interface World {
  project: Project
  connection: Project
  mainWorktreeId: string
}

/**
 * A project at `<OLD>/app` with a row in every table a move writes to, each naming the
 * folder: what the guard and rollback tests compare before and after.
 */
const seedWorld = (db: DatabaseService): World => {
  const project = addProject(db, 'app', `${OLD}/app`, {
    trust_check_done: 1,
    detected_icon: `${OLD}/app/icon.png`,
    setup_script: `cp ${OLD}/app/.env.example .env`,
    custom_commands: JSON.stringify([{ id: 'c1', name: 'Docs', prompt: `Read ${OLD}/app/docs` }]),
    shell_commands: JSON.stringify([{ id: 's1', name: 'Deploy', commands: `cd ${OLD}/app` }]),
    kanban_markdown_config: JSON.stringify({
      layout: 'single-folder',
      singleFolder: `${OLD}/app/docs/kanban`
    })
  })
  const mainWorktreeId = addWorktree(db, project, 'main', `${OLD}/app`, { isDefault: true })
  addWorktree(db, project, 'nested', `${OLD_REAL}/app/.claude/worktrees/w1`)
  const connection = db.createConnectionProject({
    name: 'app + api',
    path: `${HOME}/.hive/connection-projects/c1`,
    member_project_ids: [project.id]
  })
  db.setSetting(`slash_commands:${OLD}/app`, '["/review"]')
  addTicket(db, project.id, {
    description: `See ${OLD}/app/docs/plan.md`,
    attachments: JSON.stringify([{ type: 'file', url: `${OLD}/app/a.png`, label: 'a.png' }]),
    external_url: `${OLD}/app/docs/spec.md`,
    pending_launch_config: pendingLaunch(`Work in ${OLD}/app`)
  })
  const runId = addRun(db, project.id, { source_path: `${OLD}/app/docs/spec.md` })
  addRunItem(db, runId, {
    title: 'Item',
    summary: `From ${OLD}/app/docs/spec.md`,
    description: `- Original document: ${OLD}/app/docs/spec.md`,
    open_questions: JSON.stringify([`Is ${OLD}/app/api the right place?`])
  })
  addCard(db, project.id, 'card-1', {
    last_seen_path: `${OLD}/app/docs/kanban/card-1.md`,
    attachments: JSON.stringify([{ type: 'file', url: `${OLD}/app/b.png`, label: 'b.png' }])
  })
  addShellSession(db, project, mainWorktreeId, shellSnapshot(`cd ${OLD}/app && make`, 'succeeded'))
  addDataProject(db, 'data-1', JSON.stringify({ filePath: `${OLD}/app/dev.sqlite` }))
  drain()
  return { project, connection, mainWorktreeId }
}

describeIf('DatabaseService.relocateProject', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
    return
  }

  describe('the project and its worktrees', () => {
    it('repoints the project and its default worktree, and asks for trust again', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`, {
        trust_check_done: 1,
        detected_icon: `${OLD}/app/public/icon.png`
      })
      const main = addWorktree(db, project, 'main', `${OLD}/app`, { isDefault: true })
      const before = projectRow(db, project.id)

      // Nothing is written before the folders are in place.
      const seenAtPlace: unknown[] = []
      const place = vi.fn(() => {
        seenAtPlace.push(projectRow(db, project.id).path, worktreePath(db, main))
      })
      const result = db.relocateProject(
        moveInput(project, [{ from: [`${OLD}/app`], to: `${NEW}/app` }], { place })
      )

      expect(place).toHaveBeenCalledTimes(1)
      expect(seenAtPlace).toEqual([`${OLD}/app`, `${OLD}/app`])
      expect(result.project).toEqual(db.getProject(project.id))
      expect(result.project.path).toBe(`${NEW}/app`)
      expect(result.project.trust_check_done).toBe(false)
      expect(result.project.detected_icon).toBe(`${NEW}/app/public/icon.png`)
      expect(result.worktrees).toEqual([{ id: main, from: `${OLD}/app`, to: `${NEW}/app` }])
      expect(worktreePath(db, main)).toBe(`${NEW}/app`)
      expect(result).toMatchObject({
        ticketsRewritten: 0,
        runsRewritten: 0,
        scriptsRewritten: false,
        otherProjectIds: [],
        dataProjectIds: []
      })
      expect(db.getProjectByPath(`${OLD}/app`)).toBeNull()
      // Only the path, the trust flag and the icon changed.
      expect(projectRow(db, project.id)).toEqual({
        ...before,
        path: `${NEW}/app`,
        trust_check_done: 0,
        detected_icon: `${NEW}/app/public/icon.png`
      })
    })

    it.each([
      ['the "no icon" marker', 'none'],
      ['no icon yet', null],
      ['an icon somewhere else', `${HOME}/Pictures/icon.png`]
    ])('leaves %s alone', (_label, icon) => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`, { detected_icon: icon })
      db.relocateProject(appMove(project))
      expect(projectRow(db, project.id).detected_icon).toBe(icon)
    })

    it('moves a nested worktree stored by its real path while the project is stored lexically', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const main = addWorktree(db, project, 'main', `${OLD}/app`, { isDefault: true })
      const nested = addWorktree(db, project, 'w1', `${OLD_REAL}/app/.claude/worktrees/w1`)
      const archived = addWorktree(db, project, 'gone', `${OLD}/app/.worktrees/gone`, {
        archived: true
      })
      const elsewhere = addWorktree(db, project, 'feature', `${HOME}/.hive-worktrees/app/feature`)

      const result = db.relocateProject(appMove(project))

      expect(result.project.path).toBe(`${NEW}/app`)
      expect([...result.worktrees].sort((a, b) => a.from.localeCompare(b.from))).toEqual(
        [
          { id: main, from: `${OLD}/app`, to: `${NEW}/app` },
          {
            id: nested,
            from: `${OLD_REAL}/app/.claude/worktrees/w1`,
            to: `${NEW}/app/.claude/worktrees/w1`
          },
          { id: archived, from: `${OLD}/app/.worktrees/gone`, to: `${NEW}/app/.worktrees/gone` }
        ].sort((a, b) => a.from.localeCompare(b.from))
      )
      expect(worktreePath(db, nested)).toBe(`${NEW}/app/.claude/worktrees/w1`)
      expect(worktreePath(db, archived)).toBe(`${NEW}/app/.worktrees/gone`)
      expect(worktreePath(db, elsewhere)).toBe(`${HOME}/.hive-worktrees/app/feature`)
    })

    it('misses the nested worktree when only the stored spelling is given', () => {
      // The reason every spelling is passed: this is what one spelling leaves behind.
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const nested = addWorktree(db, project, 'w1', `${OLD_REAL}/app/.claude/worktrees/w1`)
      const result = db.relocateProject(
        moveInput(project, [{ from: [`${OLD}/app`], to: `${NEW}/app` }])
      )
      expect(result.worktrees).toEqual([])
      expect(worktreePath(db, nested)).toBe(`${OLD_REAL}/app/.claude/worktrees/w1`)
    })

    it('honours the path the row holds even when the relocation does not list it', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const main = addWorktree(db, project, 'main', `${OLD}/app`, { isDefault: true })
      const result = db.relocateProject(
        moveInput(project, [{ from: [`${OLD_REAL}/app`], to: `${NEW}/app` }])
      )
      expect(result.project.path).toBe(`${NEW}/app`)
      expect(result.worktrees).toEqual([{ id: main, from: `${OLD}/app`, to: `${NEW}/app` }])
    })

    it('moves a worktree next to the checkout with it, and only the checkout becomes the project path', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`, {
        run_script: `cd ${OLD}/app-feature && make; cd ${OLD}/app && make`
      })
      const main = addWorktree(db, project, 'main', `${OLD}/app`, { isDefault: true })
      const sibling = addWorktree(db, project, 'feature', `${OLD_REAL}/app-feature`)
      const stays = addWorktree(db, project, 'other', `${OLD_REAL}/app-other`)
      db.setSetting(`slash_commands:${OLD_REAL}/app-feature`, '["/ship"]')
      const ticket = addTicket(db, project.id, {
        description: `Notes are in ${OLD_REAL}/app-feature/notes.md, not in ${OLD}/app-other`,
        attachments: JSON.stringify([
          { type: 'file', url: `${OLD_REAL}/app-feature/shot.png`, label: 'shot.png' },
          { type: 'file', url: `${OLD_REAL}/app-other/shot.png`, label: 'shot.png' }
        ])
      })

      const result = db.relocateProject(
        moveInput(project, [
          { from: [`${OLD}/app`, `${OLD_REAL}/app`], to: `${NEW}/app` },
          { from: [`${OLD}/app-feature`, `${OLD_REAL}/app-feature`], to: `${NEW}/app-feature` }
        ])
      )

      expect(result.project.path).toBe(`${NEW}/app`)
      expect([...result.worktrees].sort((a, b) => a.from.localeCompare(b.from))).toEqual(
        [
          { id: main, from: `${OLD}/app`, to: `${NEW}/app` },
          { id: sibling, from: `${OLD_REAL}/app-feature`, to: `${NEW}/app-feature` }
        ].sort((a, b) => a.from.localeCompare(b.from))
      )
      expect(worktreePath(db, stays)).toBe(`${OLD_REAL}/app-other`)
      expect(projectRow(db, project.id).run_script).toBe(
        `cd ${NEW}/app-feature && make; cd ${NEW}/app && make`
      )
      expect(result.scriptsRewritten).toBe(true)
      expect(db.getSetting(`slash_commands:${NEW}/app-feature`)).toBe('["/ship"]')
      expect(db.getSetting(`slash_commands:${OLD_REAL}/app-feature`)).toBeNull()
      const row = ticketRow(db, ticket)
      expect(row.description).toBe(
        `Notes are in ${NEW}/app-feature/notes.md, not in ${OLD}/app-other`
      )
      expect(JSON.parse(row.attachments as string)).toEqual([
        { type: 'file', url: `${NEW}/app-feature/shot.png`, label: 'shot.png' },
        { type: 'file', url: `${OLD_REAL}/app-other/shot.png`, label: 'shot.png' }
      ])
    })

    it('never touches a folder whose name merely starts with the moved one', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`, {
        run_script: [
          `ls ${OLD}/app2/x ${OLD}/app.old/y ${OLD}/application/z ${OLD}/app-2/w`,
          `ls "${OLD}/app 2/a" ${OLD}/app\\ 2/b ~/hive-projects/app\\ 2/c`,
          `ls "${OLD_REAL}/app 2/d" "${OLD}/app (copy)/e"`,
          `ls ${OLD}/app/own`
        ].join('\n')
      })
      addWorktree(db, project, 'main', `${OLD}/app`, { isDefault: true })
      const ticket = addTicket(db, project.id, {
        description: `Compare "${OLD}/app 2/README.md" with ${OLD}/app/README.md`,
        attachments: JSON.stringify([
          { type: 'file', url: `${OLD}/app 2/shot.png`, label: 'a' },
          { type: 'file', url: `${OLD}/app2/shot.png`, label: 'b' },
          { type: 'file', url: `${OLD}/app.old/shot.png`, label: 'c' },
          { type: 'file', url: `${OLD}/app/shot.png`, label: 'd' }
        ]),
        external_url: `${OLD}/app 2/docs/spec.md`
      })

      const siblingNames = [
        'app2',
        'app 2',
        'app.old',
        'application',
        'app_2',
        'appé',
        'app (copy)'
      ]
      const siblings = siblingNames.map((name) => {
        const sibling = addProject(db, name, `${OLD}/${name}`, {
          detected_icon: `${OLD}/${name}/icon.png`,
          setup_script: `cd "${OLD}/${name}" && pnpm install`,
          custom_commands: JSON.stringify([
            { id: 'c', name: 'n', prompt: `Read ${OLD}/${name}/x` }
          ]),
          kanban_markdown_config: JSON.stringify({
            layout: 'single-folder',
            singleFolder: `${OLD}/${name}/board`
          })
        })
        addWorktree(db, sibling, 'main', `${OLD}/${name}`, { isDefault: true })
        addTicket(db, sibling.id, {
          description: `In ${OLD}/${name}/src`,
          attachments: JSON.stringify([{ type: 'file', url: `${OLD}/${name}/a.png`, label: 'a' }])
        })
        addDataProject(db, `data-${name}`, JSON.stringify({ filePath: `${OLD}/${name}/db.sqlite` }))
        db.setSetting(`slash_commands:${OLD}/${name}`, '["/x"]')
        return sibling
      })
      // One neighbour does name the moved folder next to its own.
      const mixed = addProject(db, 'app 3', `${OLD}/app 3`, {
        setup_script: `cd "${OLD}/app 3" && cp ${OLD}/app/.env .env`
      })
      const others = (): Row[] =>
        TABLES.flatMap((table) => all(db, `SELECT * FROM ${table} ORDER BY rowid`)).filter(
          (row) =>
            row.id !== project.id &&
            row.project_id !== project.id &&
            row.id !== mixed.id &&
            row.key !== DEV_FOLDER_PENDING_MOVE_KEY
        )
      const before = others()

      const result = db.relocateProject(appMove(project))

      expect(others()).toEqual(before)
      for (const sibling of siblings) expect(db.getProject(sibling.id)?.path).toBe(sibling.path)
      expect(result.otherProjectIds).toEqual([mixed.id])
      expect(projectRow(db, mixed.id).setup_script).toBe(
        `cd "${OLD}/app 3" && cp ${NEW}/app/.env .env`
      )
      expect(result.dataProjectIds).toEqual([])
      expect(projectRow(db, project.id).run_script).toBe(
        [
          `ls ${OLD}/app2/x ${OLD}/app.old/y ${OLD}/application/z ${OLD}/app-2/w`,
          `ls "${OLD}/app 2/a" ${OLD}/app\\ 2/b ~/hive-projects/app\\ 2/c`,
          `ls "${OLD_REAL}/app 2/d" "${OLD}/app (copy)/e"`,
          `ls ${NEW}/app/own`
        ].join('\n')
      )
      const row = ticketRow(db, ticket)
      expect(row.description).toBe(`Compare "${OLD}/app 2/README.md" with ${NEW}/app/README.md`)
      expect(JSON.parse(row.attachments as string)).toEqual([
        { type: 'file', url: `${OLD}/app 2/shot.png`, label: 'a' },
        { type: 'file', url: `${OLD}/app2/shot.png`, label: 'b' },
        { type: 'file', url: `${OLD}/app.old/shot.png`, label: 'c' },
        { type: 'file', url: `${NEW}/app/shot.png`, label: 'd' }
      ])
      expect(row.external_url).toBe(`${OLD}/app 2/docs/spec.md`)
    })

    it('knows a neighbour under every spelling of the folder it sits next to', () => {
      const db = openDb()
      // Registered through a link: the real folder is somewhere else entirely.
      const real = '/Volumes/Disk/code'
      const project = addProject(db, 'app', '/work/app', {
        run_script: `ls "${real}/app 2/a" "/work/app 2/b" ${real}/app/own /work/app/own`
      })
      addWorktree(db, project, 'main', '/work/app', { isDefault: true })
      // The neighbour is registered under one spelling; the script names it under the other.
      addProject(db, 'app 2', '/work/app 2')

      db.relocateProject(
        moveInput(project, [{ from: ['/work/app', `${real}/app`], to: `${NEW}/app` }])
      )

      expect(projectRow(db, project.id).run_script).toBe(
        `ls "${real}/app 2/a" "/work/app 2/b" ${NEW}/app/own ${NEW}/app/own`
      )
    })

    it('treats a backslash as part of a name in a POSIX path and as a separator in a Windows one', () => {
      const db = openDb()
      const posix = addProject(db, 'posix', '/srv/dev/app')
      const posixOdd = addWorktree(db, posix, 'odd', '/srv/dev/app\\backup')
      db.relocateProject(moveInput(posix, [{ from: ['/srv/dev/app'], to: '/srv/new/app' }]))
      expect(worktreePath(db, posixOdd)).toBe('/srv/dev/app\\backup')

      const windows = addProject(db, 'windows', 'C:\\dev\\app')
      const backslash = addWorktree(db, windows, 'a', 'C:\\dev\\app\\.claude\\worktrees\\a')
      const slash = addWorktree(db, windows, 'b', 'C:\\dev\\app/.claude/worktrees/b')
      const neighbour = addWorktree(db, windows, 'c', 'C:\\dev\\app2')
      db.relocateProject(moveInput(windows, [{ from: ['C:\\dev\\app'], to: 'D:\\code\\app' }]))
      expect(worktreePath(db, backslash)).toBe('D:\\code\\app\\.claude\\worktrees\\a')
      expect(worktreePath(db, slash)).toBe('D:\\code\\app/.claude/worktrees/b')
      expect(worktreePath(db, neighbour)).toBe('C:\\dev\\app2')
    })
  })

  describe('guards', () => {
    const cases: [string, RegExp, (db: DatabaseService, world: World) => RelocateProjectInput][] = [
      [
        'the project is gone',
        /no longer exists/,
        (_db, world) => ({ ...appMove(world.project), projectId: 'missing' })
      ],
      [
        'the project is a connection project',
        /connection project/,
        (_db, world) =>
          moveInput(world.connection, [{ from: [world.connection.path], to: `${NEW}/connection` }])
      ],
      [
        'the project is not where the caller read it',
        /no longer at/,
        (_db, world) => ({ ...appMove(world.project), expectedPath: `${OLD}/renamed` })
      ],
      [
        'the new path already belongs to another project',
        /already belongs to the project taken/,
        (db, world) => {
          addProject(db, 'taken', `${NEW}/app`)
          return appMove(world.project)
        }
      ],
      [
        'another project is registered inside the folder',
        /The project inner is registered at/,
        (db, world) => {
          addProject(db, 'inner', `${OLD}/app/packages/inner`)
          return appMove(world.project)
        }
      ],
      [
        'a worktree of another project is inside the folder, under its real path',
        /The project elsewhere is registered at/,
        (db, world) => {
          const elsewhere = addProject(db, 'elsewhere', `${HOME}/code/elsewhere`)
          addWorktree(db, elsewhere, 'odd', `${OLD_REAL}/app/.claude/worktrees/odd`)
          return appMove(world.project)
        }
      ],
      [
        'another project is the same folder under its real path',
        /The project twin is registered at/,
        (db, world) => {
          addProject(db, 'twin', `${OLD_REAL}/app`)
          return appMove(world.project)
        }
      ],
      [
        'another project is a worktree that would move along',
        /The project feature is registered at/,
        (db, world) => {
          addProject(db, 'feature', `${OLD}/app-feature`)
          return moveInput(world.project, [
            { from: [`${OLD}/app`], to: `${NEW}/app` },
            { from: [`${OLD}/app-feature`], to: `${NEW}/app-feature` }
          ])
        }
      ],
      ['no folder is given', /no folder to move/, (_db, world) => moveInput(world.project, [])],
      [
        'the project is already there',
        /already at/,
        (_db, world) => moveInput(world.project, [{ from: [`${OLD}/app`], to: `${OLD}/app/` }])
      ]
    ]

    it.each(cases)('throws and changes nothing when %s', (_label, message, makeInput) => {
      const db = openDb()
      const world = seedWorld(db)
      const place = vi.fn()
      const input = { ...makeInput(db, world), place }
      drain()
      const before = snapshot(db)

      expect(() => db.relocateProject(input)).toThrow(message)

      expect(place).not.toHaveBeenCalled()
      expect(snapshot(db)).toEqual(before)
      expect(db.readPendingDevFolderMove()).toBeNull()
      expect(drain()).toEqual([])
    })

    it('is not stopped by an archived worktree of another project, or by one next to the folder', () => {
      const db = openDb()
      const world = seedWorld(db)
      const elsewhere = addProject(db, 'elsewhere', `${HOME}/code/elsewhere`)
      const archived = addWorktree(db, elsewhere, 'old', `${OLD}/app/.claude/worktrees/old`, {
        archived: true
      })
      addWorktree(db, elsewhere, 'near', `${OLD}/app-near`)

      expect(db.relocateProject(appMove(world.project)).project.path).toBe(`${NEW}/app`)
      // Not this project's row: it keeps the path it had.
      expect(worktreePath(db, archived)).toBe(`${OLD}/app/.claude/worktrees/old`)
    })
  })

  describe('rollback', () => {
    it('rolls everything back and rethrows the same error when place() throws', () => {
      const db = openDb()
      const world = seedWorld(db)
      const before = snapshot(db)
      const failure = new Error('rename failed: EXDEV')

      let caught: unknown
      try {
        db.relocateProject(
          appMove(world.project, {
            place: () => {
              throw failure
            }
          })
        )
      } catch (error) {
        caught = error
      }

      expect(caught).toBe(failure)
      expect(snapshot(db)).toEqual(before)
      expect(db.readPendingDevFolderMove()).toBeNull()
      expect(drain()).toEqual([])
    })

    it('rolls back when the project update hits the UNIQUE path constraint after place()', () => {
      const db = openDb()
      const world = seedWorld(db)
      const before = snapshot(db)
      // Inside the transaction, so after the guard looked: the first UPDATE now collides.
      const place = vi.fn(() => {
        run(
          db,
          `INSERT INTO projects (id, name, path, created_at, last_accessed_at)
           VALUES ('squatter', 'squatter', ?, ?, ?)`,
          `${NEW}/app`,
          STAMP,
          STAMP
        )
      })

      expect(() => db.relocateProject(appMove(world.project, { place }))).toThrow(
        /UNIQUE constraint failed: projects\.path/
      )

      expect(place).toHaveBeenCalledTimes(1)
      expect(snapshot(db)).toEqual(before)
      expect(db.getProject('squatter')).toBeNull()
      expect(db.readPendingDevFolderMove()).toBeNull()
    })

    it('rolls back the rows already written when a later statement fails', () => {
      const db = openDb()
      const world = seedWorld(db)
      // The data projects are written last but one: by then every other table has been.
      db.getRawDb().exec(
        `CREATE TRIGGER refuse_data_projects BEFORE UPDATE ON data_projects
         BEGIN SELECT RAISE(ABORT, 'data projects are read-only'); END`
      )
      const before = snapshot(db)
      const place = vi.fn()

      expect(() => db.relocateProject(appMove(world.project, { place }))).toThrow(
        'data projects are read-only'
      )

      expect(place).toHaveBeenCalledTimes(1)
      expect(snapshot(db)).toEqual(before)
      expect(db.readPendingDevFolderMove()).toBeNull()
      expect(drain()).toEqual([])

      // The same move without the obstacle writes to every one of those tables.
      db.getRawDb().exec('DROP TRIGGER refuse_data_projects')
      db.relocateProject(appMove(world.project))
      const after = snapshot(db)
      for (const table of TABLES) expect(after[table], table).not.toEqual(before[table])
    })
  })

  describe('scripts and commands', () => {
    const scripts = {
      setup_script: [
        'cp ~/hive-projects/app/.env.example .env',
        'cd "$HOME/hive-projects/app" && pnpm install'
      ].join('\n'),
      run_script:
        'cd ${HOME}/hive-projects/app && pnpm dev --dir=/home/tester/hive-projects/app/web',
      archive_script: `rm -rf ${OLD}/app/tmp; echo ~/hive-projects/app2 $HOME/hive-projects/app.old`,
      worktree_create_script: 'echo "no folder named here"'
    }

    it('rewrites the absolute, ~/, $HOME/ and ${HOME}/ spellings, keeping the spelling under home', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`, scripts)

      const result = db.relocateProject(appMove(project))

      expect(result.scriptsRewritten).toBe(true)
      const row = projectRow(db, project.id)
      expect(row.setup_script).toBe(
        ['cp ~/dev/app/.env.example .env', 'cd "$HOME/dev/app" && pnpm install'].join('\n')
      )
      expect(row.run_script).toBe('cd ${HOME}/dev/app && pnpm dev --dir=/home/tester/dev/app/web')
      expect(row.archive_script).toBe(
        `rm -rf ${NEW}/app/tmp; echo ~/hive-projects/app2 $HOME/hive-projects/app.old`
      )
      expect(row.worktree_create_script).toBe('echo "no folder named here"')
    })

    it('writes the absolute path where the new folder is not under home', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`, scripts)

      db.relocateProject(
        moveInput(project, [{ from: [`${OLD}/app`], to: '/Volumes/work/dev/app' }])
      )

      const row = projectRow(db, project.id)
      expect(row.setup_script).toBe(
        [
          'cp /Volumes/work/dev/app/.env.example .env',
          'cd "/Volumes/work/dev/app" && pnpm install'
        ].join('\n')
      )
      expect(row.run_script).toBe(
        'cd /Volumes/work/dev/app && pnpm dev --dir=/Volumes/work/dev/app/web'
      )
    })

    it('leaves the ~/ spelling alone when the folder is not under the home directory given', () => {
      const db = openDb()
      const project = addProject(db, 'app', '/srv/dev/app', {
        setup_script: 'cp ~/dev/app/.env .env; cp /srv/dev/app/.env .env'
      })
      const result = db.relocateProject(
        moveInput(project, [{ from: ['/srv/dev/app'], to: '/srv/new/app' }])
      )
      expect(projectRow(db, project.id).setup_script).toBe(
        'cp ~/dev/app/.env .env; cp /srv/new/app/.env .env'
      )
      expect(result.scriptsRewritten).toBe(true)
    })

    it('reports no script rewritten when none names the folder', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`, {
        setup_script: 'pnpm install',
        custom_commands: JSON.stringify([{ id: 'c1', name: 'Docs', prompt: 'Summarise the docs' }])
      })
      const before = projectRow(db, project.id)
      const result = db.relocateProject(appMove(project))
      expect(result.scriptsRewritten).toBe(false)
      expect(projectRow(db, project.id)).toEqual({ ...before, path: `${NEW}/app` })
    })

    it('rewrites the named fields of the JSON columns and nothing else in them', () => {
      const db = openDb()
      const longer = `${HOME}/a-longer-development-folder/app`
      // Valid as stored, and over the 64 KB limit once every line holds the longer path.
      const nearLimit = `echo ${OLD}/app\n`.repeat(1524)
      const project = addProject(db, 'app', `${OLD}/app`, {
        custom_commands: JSON.stringify([
          {
            id: 'c1',
            name: `Review ${OLD}/app`,
            prompt: `Review ${OLD}/app/src and ~/hive-projects/app/docs`
          },
          { id: 'c2', name: 'Plain', prompt: 'No folder here' },
          'not a command'
        ]),
        shell_commands: JSON.stringify([
          {
            id: 's1',
            name: `Deploy ${OLD}/app`,
            commands: `cd ${OLD}/app\n./deploy.sh`,
            keepRunningOnQuit: true
          },
          { id: 's2', name: 'Near the limit', commands: nearLimit }
        ]),
        kanban_markdown_config: JSON.stringify({
          layout: 'status-folders',
          singleFolder: 'docs/kanban',
          statusFolders: {
            todo: `${OLD}/app/board/todo`,
            in_progress: 'board/doing',
            review: `${OLD}/app2/board/review`,
            merged: `${OLD_REAL}/app/board/merged`,
            done: `${OLD}/app/board/done`
          }
        })
      })

      const result = db.relocateProject(
        moveInput(project, [{ from: [`${OLD}/app`, `${OLD_REAL}/app`], to: longer }])
      )

      expect(result.scriptsRewritten).toBe(true)
      const row = projectRow(db, project.id)
      expect(JSON.parse(row.custom_commands as string)).toEqual([
        {
          id: 'c1',
          name: `Review ${OLD}/app`,
          prompt: `Review ${longer}/src and ~/a-longer-development-folder/app/docs`
        },
        { id: 'c2', name: 'Plain', prompt: 'No folder here' },
        'not a command'
      ])
      expect(JSON.parse(row.shell_commands as string)).toEqual([
        {
          id: 's1',
          name: `Deploy ${OLD}/app`,
          commands: `cd ${longer}\n./deploy.sh`,
          keepRunningOnQuit: true
        },
        { id: 's2', name: 'Near the limit', commands: nearLimit }
      ])
      expect(JSON.parse(row.kanban_markdown_config as string)).toEqual({
        layout: 'status-folders',
        singleFolder: 'docs/kanban',
        statusFolders: {
          todo: `${longer}/board/todo`,
          in_progress: 'board/doing',
          review: `${OLD}/app2/board/review`,
          merged: `${longer}/board/merged`,
          done: `${longer}/board/done`
        }
      })
      // The app's own readers still accept every entry.
      expect(result.project.custom_commands).toHaveLength(3)
      expect(result.project.shell_commands?.map((command) => command.id)).toEqual(['s1', 's2'])
    })

    it('leaves a JSON column that does not parse, or would not validate, exactly as it is', () => {
      const db = openDb()
      const broken = {
        custom_commands: `[{"id":"c1","name":"Docs","prompt":"Read ${OLD}/app/docs"`,
        shell_commands: `cd ${OLD}/app && make`,
        kanban_markdown_config: `{"layout":"single-folder","singleFolder":"${OLD}/app/board"`
      }
      const project = addProject(db, 'app', `${OLD}/app`, broken)
      const unknownLayout = JSON.stringify({ layout: 'grid', singleFolder: `${OLD}/app/board` })
      const other = addProject(db, 'other', `${OLD}/other`, {
        kanban_markdown_config: unknownLayout
      })

      const result = db.relocateProject(appMove(project))

      expect(projectRow(db, project.id)).toMatchObject({ path: `${NEW}/app`, ...broken })
      expect(projectRow(db, other.id).kanban_markdown_config).toBe(unknownLayout)
      expect(result.scriptsRewritten).toBe(false)
      expect(result.otherProjectIds).toEqual([])
    })

    it('keeps JSON valid when the new path holds a quote and a backslash', () => {
      const db = openDb()
      const odd = `${HOME}/my "dev" \\ folder/app`
      const project = addProject(db, 'app', `${OLD}/app`, {
        custom_commands: JSON.stringify([
          { id: 'c1', name: 'Docs', prompt: `Read ${OLD}/app/docs` }
        ]),
        kanban_markdown_config: JSON.stringify({
          layout: 'single-folder',
          singleFolder: `${OLD}/app/board`
        })
      })
      db.relocateProject(moveInput(project, [{ from: [`${OLD}/app`], to: odd }]))
      const row = projectRow(db, project.id)
      expect(JSON.parse(row.custom_commands as string)).toEqual([
        { id: 'c1', name: 'Docs', prompt: `Read ${odd}/docs` }
      ])
      expect(JSON.parse(row.kanban_markdown_config as string)).toEqual({
        layout: 'single-folder',
        singleFolder: `${odd}/board`
      })
    })

    it('rewrites scripts, commands and board folders of other projects that name the folder', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const sibling = addProject(db, 'api', `${OLD}/api`, {
        setup_script: `cp ${OLD}/app/.env.shared .env`,
        shell_commands: JSON.stringify([
          { id: 's1', name: 'Link', commands: `ln -s ~/hive-projects/app/dist ./web` }
        ])
      })
      const connection = db.createConnectionProject({
        name: 'app + api',
        path: `${HOME}/.hive/connection-projects/c1`,
        member_project_ids: [project.id, sibling.id]
      })
      run(
        db,
        'UPDATE projects SET kanban_markdown_config = ? WHERE id = ?',
        JSON.stringify({ layout: 'single-folder', singleFolder: `${OLD_REAL}/app/docs/kanban` }),
        connection.id
      )
      const untouched = addProject(db, 'docs', `${OLD}/docs`, {
        setup_script: `cp ${OLD}/app2/.env .env`,
        description: `Lives next to ${OLD}/app`
      })
      const before = projectRow(db, untouched.id)

      const result = db.relocateProject(appMove(project))

      expect([...result.otherProjectIds].sort()).toEqual([sibling.id, connection.id].sort())
      expect(result.scriptsRewritten).toBe(true)
      const siblingRow = projectRow(db, sibling.id)
      expect(siblingRow.path).toBe(`${OLD}/api`)
      expect(siblingRow.setup_script).toBe(`cp ${NEW}/app/.env.shared .env`)
      expect(JSON.parse(siblingRow.shell_commands as string)).toEqual([
        { id: 's1', name: 'Link', commands: 'ln -s ~/dev/app/dist ./web' }
      ])
      expect(JSON.parse(projectRow(db, connection.id).kanban_markdown_config as string)).toEqual({
        layout: 'single-folder',
        singleFolder: `${NEW}/app/docs/kanban`
      })
      // A project description is prose: it is not rewritten, and the row stays as it was.
      expect(projectRow(db, untouched.id)).toEqual(before)
    })

    it('does not count a board folder of another project as a rewritten script', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const other = addProject(db, 'notes', `${OLD}/notes`, {
        kanban_markdown_config: JSON.stringify({
          layout: 'single-folder',
          singleFolder: `${OLD}/app/board`
        })
      })
      const result = db.relocateProject(appMove(project))
      expect(result.otherProjectIds).toEqual([other.id])
      expect(result.scriptsRewritten).toBe(false)
    })

    it('finds the folder in another project when its name needs escaping inside JSON', () => {
      const db = openDb()
      const quoted = `${OLD}/my "app"`
      const project = addProject(db, 'quoted', quoted)
      const other = addProject(db, 'other', `${OLD}/other`, {
        custom_commands: JSON.stringify([{ id: 'c1', name: 'Docs', prompt: `Read ${quoted}/docs` }])
      })
      const result = db.relocateProject(
        moveInput(project, [{ from: [quoted], to: `${NEW}/my-app` }])
      )
      expect(result.otherProjectIds).toEqual([other.id])
      expect(JSON.parse(projectRow(db, other.id).custom_commands as string)).toEqual([
        { id: 'c1', name: 'Docs', prompt: `Read ${NEW}/my-app/docs` }
      ])
    })

    it('rewrites the script snapshot of a finished shell-command session, not of one still running', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const main = addWorktree(db, project, 'main', `${OLD}/app`, { isDefault: true })
      const finished = addShellSession(
        db,
        project,
        main,
        shellSnapshot(`cd ${OLD}/app && ./deploy.sh`, 'failed')
      )
      const runningSnapshot = shellSnapshot(`cd ${OLD}/app && ./watch.sh`, 'running')
      const running = addShellSession(db, project, main, runningSnapshot)
      const garbled = addShellSession(db, project, main, `{"script":"cd ${OLD}/app`)
      const plain = db.createSession({ worktree_id: main, project_id: project.id })

      const result = db.relocateProject(appMove(project))

      expect(result.scriptsRewritten).toBe(true)
      expect(JSON.parse(sessionRow(db, finished).shell_command as string)).toEqual(
        JSON.parse(shellSnapshot(`cd ${NEW}/app && ./deploy.sh`, 'failed'))
      )
      expect(sessionRow(db, finished).updated_at).toBe(STAMP)
      expect(sessionRow(db, running).shell_command).toBe(runningSnapshot)
      expect(sessionRow(db, garbled).shell_command).toBe(`{"script":"cd ${OLD}/app`)
      expect(sessionRow(db, plain.id).shell_command).toBeNull()
    })

    it('rewrites the finished script snapshots of another project that name the folder', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      addProject(db, 'app 2', `${OLD}/app 2`)
      const web = addProject(db, 'web', `${HOME}/code/web`, {
        shell_commands: JSON.stringify([
          { id: 'cmd-1', name: 'Deploy', commands: `cp ${OLD}/app/.env .env` }
        ])
      })
      const main = addWorktree(db, web, 'main', `${HOME}/code/web`, { isDefault: true })
      const finished = addShellSession(
        db,
        web,
        main,
        shellSnapshot(`cp ${OLD}/app/.env .env`, 'succeeded')
      )
      const runningSnapshot = shellSnapshot(`tail -f ${OLD}/app/log.txt`, 'running')
      const running = addShellSession(db, web, main, runningSnapshot)
      const pendingSnapshot = shellSnapshot(`cat ${OLD}/app/log.txt`, 'pending')
      const pending = addShellSession(db, web, main, pendingSnapshot)
      const neighbourSnapshot = shellSnapshot(`cd "${OLD}/app 2" && make`, 'succeeded')
      const neighbour = addShellSession(db, web, main, neighbourSnapshot)
      const elsewhereSnapshot = shellSnapshot(`cd ${HOME}/code/web && make`, 'failed')
      const elsewhere = addShellSession(db, web, main, elsewhereSnapshot)

      const result = db.relocateProject(appMove(project))

      // The command as it is defined and the snapshot "Run again" runs say the same.
      expect(JSON.parse(projectRow(db, web.id).shell_commands as string)).toEqual([
        { id: 'cmd-1', name: 'Deploy', commands: `cp ${NEW}/app/.env .env` }
      ])
      expect(JSON.parse(sessionRow(db, finished).shell_command as string)).toEqual(
        JSON.parse(shellSnapshot(`cp ${NEW}/app/.env .env`, 'succeeded'))
      )
      expect(sessionRow(db, finished).updated_at).toBe(STAMP)
      expect(sessionRow(db, running).shell_command).toBe(runningSnapshot)
      expect(sessionRow(db, pending).shell_command).toBe(pendingSnapshot)
      expect(sessionRow(db, neighbour).shell_command).toBe(neighbourSnapshot)
      expect(sessionRow(db, elsewhere).shell_command).toBe(elsewhereSnapshot)
      expect(result.scriptsRewritten).toBe(true)
    })

    it('counts a finished snapshot of another project as a rewritten script', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const web = addProject(db, 'web', `${HOME}/code/web`)
      const main = addWorktree(db, web, 'main', `${HOME}/code/web`, { isDefault: true })
      const finished = addShellSession(
        db,
        web,
        main,
        shellSnapshot(`cd ~/hive-projects/app && make`, 'cancelled')
      )
      const result = db.relocateProject(appMove(project))
      expect(result.scriptsRewritten).toBe(true)
      expect(result.otherProjectIds).toEqual([])
      expect(JSON.parse(sessionRow(db, finished).shell_command as string).script).toBe(
        'cd ~/dev/app && make'
      )
    })

    it('follows the backslash-escaped spelling of a folder whose path has a space', () => {
      const db = openDb()
      const spaced = `${HOME}/My Projects/app`
      const project = addProject(db, 'app', spaced, {
        setup_script: [
          'cd /home/tester/My\\ Projects/app && ls',
          'cd ~/My\\ Projects/app/src',
          'cd $HOME/My\\ Projects/app',
          'cd "/home/tester/My Projects/app"',
          'cat ~/My\\ Projects/app2/README.md'
        ].join('\n')
      })
      // Found through the escaped spelling alone, which a JSON column stores with two backslashes.
      const other = addProject(db, 'other', `${HOME}/code/other`, {
        shell_commands: JSON.stringify([
          { id: 's1', name: 'Link', commands: 'ln -s ~/My\\ Projects/app/dist ./web' }
        ])
      })

      const result = db.relocateProject(moveInput(project, [{ from: [spaced], to: `${NEW}/app` }]))

      expect(result.scriptsRewritten).toBe(true)
      expect(projectRow(db, project.id).setup_script).toBe(
        [
          'cd /home/tester/dev/app && ls',
          'cd ~/dev/app/src',
          'cd $HOME/dev/app',
          'cd "/home/tester/dev/app"',
          'cat ~/My\\ Projects/app2/README.md'
        ].join('\n')
      )
      expect(result.otherProjectIds).toEqual([other.id])
      expect(JSON.parse(projectRow(db, other.id).shell_commands as string)).toEqual([
        { id: 's1', name: 'Link', commands: 'ln -s ~/dev/app/dist ./web' }
      ])
    })

    it('writes the new folder escaped where the old one was escaped, and plain where it was quoted', () => {
      const db = openDb()
      const spaced = `${HOME}/My Projects/app`
      const project = addProject(db, 'app', spaced, {
        run_script:
          'cd /home/tester/My\\ Projects/app; cd "/home/tester/My Projects/app"; cd ~/My\\ Projects/app'
      })
      db.relocateProject(moveInput(project, [{ from: [spaced], to: `${HOME}/New Dev (2)/app` }]))
      expect(projectRow(db, project.id).run_script).toBe(
        'cd /home/tester/New\\ Dev\\ \\(2\\)/app; cd "/home/tester/New Dev (2)/app"; cd ~/New\\ Dev\\ \\(2\\)/app'
      )
    })
  })

  describe('board folders given relative to the project', () => {
    const boardConfig = (db: DatabaseService, id: string): unknown =>
      JSON.parse(projectRow(db, id).kanban_markdown_config as string)

    it('stores where the cards still are when the folder is outside the project that moved', () => {
      const db = openDb()
      // The cards are in a shared folder next to the project: it does not move with it.
      const project = addProject(db, 'proj', `${OLD}/proj`, {
        kanban_markdown_config: JSON.stringify({
          layout: 'single-folder',
          singleFolder: '../boards/proj'
        })
      })
      addCard(db, project.id, 'card-1', { last_seen_path: `${OLD}/boards/proj/card-1.md` })
      const card = cardRow(db, project.id, 'card-1')

      const result = db.relocateProject(
        moveInput(project, [{ from: [`${OLD}/proj`, `${OLD_REAL}/proj`], to: `${NEW}/proj` }])
      )

      expect(boardConfig(db, project.id)).toEqual({
        layout: 'single-folder',
        singleFolder: `${OLD}/boards/proj`
      })
      expect(cardRow(db, project.id, 'card-1')).toEqual(card)
      expect(result.scriptsRewritten).toBe(false)
      expect(result.ticketsRewritten).toBe(0)
    })

    it('stores where the cards are now when the folder of another project is inside what moved', () => {
      const db = openDb()
      const project = addProject(db, 'proj', `${OLD}/proj`)
      // Nothing in this row spells the path of `proj`: only the relative folder leads there.
      const board = addProject(db, 'board', `${OLD}/board`, {
        kanban_markdown_config: JSON.stringify({
          layout: 'single-folder',
          singleFolder: '../proj/docs/kanban'
        })
      })
      addCard(db, board.id, 'card-1', { last_seen_path: `${OLD}/proj/docs/kanban/card-1.md` })
      const staysConfig = JSON.stringify({
        layout: 'status-folders',
        singleFolder: 'docs/kanban',
        statusFolders: {
          todo: 'docs/kanban/todo',
          in_progress: '../shared/doing',
          review: '../proj2/review',
          done: `${HOME}/boards/done`
        }
      })
      const stays = addProject(db, 'stays', `${OLD}/stays`, {
        kanban_markdown_config: staysConfig
      })
      const before = projectRow(db, stays.id)

      const result = db.relocateProject(
        moveInput(project, [{ from: [`${OLD}/proj`, `${OLD_REAL}/proj`], to: `${NEW}/proj` }])
      )

      expect(boardConfig(db, board.id)).toEqual({
        layout: 'single-folder',
        singleFolder: `${NEW}/proj/docs/kanban`
      })
      expect(cardRow(db, board.id, 'card-1').last_seen_path).toBe(
        `${NEW}/proj/docs/kanban/card-1.md`
      )
      expect(result.otherProjectIds).toEqual([board.id])
      expect(result.ticketProjectIds).toEqual([board.id])
      expect(result.scriptsRewritten).toBe(false)
      expect(projectRow(db, stays.id)).toEqual(before)
    })

    it('stores where the cards are now when the project that moved sat inside the board project', () => {
      const db = openDb()
      // The folder that holds the checkouts is a project too, and keeps its board in one of them.
      const outer = addProject(db, 'everything', OLD, {
        kanban_markdown_config: JSON.stringify({
          layout: 'status-folders',
          singleFolder: 'app/docs/kanban',
          statusFolders: {
            todo: 'app/docs/kanban/todo',
            in_progress: './app/docs/kanban/doing',
            review: 'notes/review',
            done: 'app2/done'
          }
        })
      })
      const project = addProject(db, 'app', `${OLD}/app`)
      addCard(db, outer.id, 'card-1', { last_seen_path: `${OLD}/app/docs/kanban/todo/card-1.md` })

      const result = db.relocateProject(appMove(project))

      expect(boardConfig(db, outer.id)).toEqual({
        layout: 'status-folders',
        singleFolder: `${NEW}/app/docs/kanban`,
        statusFolders: {
          todo: `${NEW}/app/docs/kanban/todo`,
          in_progress: `${NEW}/app/docs/kanban/doing`,
          // Folders of the outer project that are not in the checkout that moved stay as typed.
          review: 'notes/review',
          done: 'app2/done'
        }
      })
      expect(cardRow(db, outer.id, 'card-1').last_seen_path).toBe(
        `${NEW}/app/docs/kanban/todo/card-1.md`
      )
      expect(result.otherProjectIds).toEqual([outer.id])
    })

    it('keeps every folder that still leads to its cards as it was typed', () => {
      const db = openDb()
      const config = {
        layout: 'status-folders',
        singleFolder: './docs/kanban/',
        statusFolders: {
          todo: 'board/todo',
          // Out of the project and back into it, and into a worktree that moves with it.
          in_progress: '../app/board/doing',
          review: '../app-feature/board/review',
          // Two levels up is the home directory from the old folder and from the new one.
          merged: '../../shared/boards/merged',
          done: 'board/../board/done'
        }
      }
      const project = addProject(db, 'app', `${OLD}/app`, {
        kanban_markdown_config: JSON.stringify(config)
      })
      const before = projectRow(db, project.id)

      db.relocateProject(
        moveInput(project, [
          { from: [`${OLD}/app`, `${OLD_REAL}/app`], to: `${NEW}/app` },
          { from: [`${OLD}/app-feature`, `${OLD_REAL}/app-feature`], to: `${NEW}/app-feature` }
        ])
      )

      expect(projectRow(db, project.id)).toEqual({ ...before, path: `${NEW}/app` })
    })

    it('rewrites each status folder by where it leads', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`, {
        kanban_markdown_config: JSON.stringify({
          layout: 'status-folders',
          singleFolder: '../boards/app',
          statusFolders: {
            todo: '../boards/app/todo',
            in_progress: 'board/doing',
            review: `${OLD}/app/board/review`,
            merged: '',
            done: '../../elsewhere/done/'
          }
        })
      })

      db.relocateProject(
        moveInput(project, [{ from: [`${OLD}/app`], to: '/Volumes/work/dev/app' }])
      )

      expect(boardConfig(db, project.id)).toEqual({
        layout: 'status-folders',
        singleFolder: `${OLD}/boards/app`,
        statusFolders: {
          todo: `${OLD}/boards/app/todo`,
          in_progress: 'board/doing',
          review: '/Volumes/work/dev/app/board/review',
          merged: '',
          done: `${HOME}/elsewhere/done/`
        }
      })
    })

    it('keeps a folder inside the project however the project path is spelled', () => {
      const db = openDb()
      // Joining normalises: the folder would no longer be recognised as one that moved.
      const project = addProject(db, 'app', '/work//app', {
        kanban_markdown_config: JSON.stringify({
          layout: 'single-folder',
          singleFolder: 'docs/kanban'
        })
      })
      const other = addProject(db, 'other', '/work//other', {
        kanban_markdown_config: JSON.stringify({ layout: 'single-folder', singleFolder: 'board' })
      })
      const before = projectRow(db, other.id)

      const result = db.relocateProject(
        moveInput(project, [{ from: ['/work//app'], to: `${NEW}/app` }])
      )

      expect(boardConfig(db, project.id)).toEqual({
        layout: 'single-folder',
        singleFolder: 'docs/kanban'
      })
      expect(projectRow(db, other.id)).toEqual(before)
      expect(result.otherProjectIds).toEqual([])
    })

    it.each([
      ['a backslash', 'D:\\code\\app'],
      ['a slash', 'D:/code/app']
    ])(
      'leaves a relative folder of a drive-letter project as typed (new path spelled with %s)',
      (_label, to) => {
        const db = openDb()
        const config = JSON.stringify({ layout: 'single-folder', singleFolder: '../boards/app' })
        const project = addProject(db, 'windows', 'C:\\dev\\app', {
          kanban_markdown_config: config
        })
        db.relocateProject(moveInput(project, [{ from: ['C:\\dev\\app'], to }]))
        expect(projectRow(db, project.id).kanban_markdown_config).toBe(config)
      }
    )

    it('leaves a config that would not validate afterwards exactly as it is', () => {
      const db = openDb()
      const project = addProject(db, 'proj', `${OLD}/proj`)
      const unknownLayout = JSON.stringify({ layout: 'grid', singleFolder: '../proj/board' })
      const other = addProject(db, 'other', `${OLD}/other`, {
        kanban_markdown_config: unknownLayout
      })
      const result = db.relocateProject(
        moveInput(project, [{ from: [`${OLD}/proj`], to: `${NEW}/proj` }])
      )
      expect(projectRow(db, other.id).kanban_markdown_config).toBe(unknownLayout)
      expect(result.otherProjectIds).toEqual([])
    })
  })

  describe('tickets', () => {
    it('rewrites description, attachments, link and queued prompt without touching updated_at', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const connection = db.createConnectionProject({
        name: 'app + api',
        path: `${HOME}/.hive/connection-projects/c1`,
        member_project_ids: [project.id]
      })
      const unrelated = addProject(db, 'docs', `${OLD}/docs`)

      const attachments = [
        { type: 'file', url: `${OLD}/app/docs/spec.pdf`, label: 'spec.pdf' },
        { type: 'file', url: `file://${OLD_REAL}/app/docs/a%20b.png`, label: 'a b.png' },
        { type: 'url', url: `https://example.com${OLD}/app`, label: 'link' },
        { type: 'file', url: `${OLD}/app2/shot.png`, label: 'neighbour' },
        'not an attachment'
      ]
      const full = addTicket(db, project.id, {
        description: `Plan: ${OLD}/app/docs/plan.md (see also ~/hive-projects/app/notes).`,
        attachments: JSON.stringify(attachments),
        external_url: `${OLD_REAL}/app/docs/spec.md`,
        pending_launch_config: pendingLaunch(`Read ${OLD}/app/docs/plan.md first`)
      })
      const plain = addTicket(db, project.id, {
        description: 'Nothing about folders',
        external_url: 'https://github.com/acme/app/issues/1'
      })
      const garbled = addTicket(db, project.id, {
        description: `In ${OLD}/app`,
        attachments: `[{"url":"${OLD}/app/x.png"`,
        pending_launch_config: `{"prompt":"${OLD}/app"`
      })
      const onConnection = addTicket(db, connection.id, { description: `Fix ${OLD}/app/api` })
      const onAnotherProject = addTicket(db, unrelated.id, {
        description: `Copied from ${OLD}/app/README.md`,
        note: `See ${OLD}/app`
      })
      const before = {
        plain: ticketRow(db, plain),
        onAnotherProject: ticketRow(db, onAnotherProject)
      }

      const result = db.relocateProject(appMove(project))

      expect(result.ticketsRewritten).toBe(4)
      expect([...(result.ticketProjectIds ?? [])].sort()).toEqual(
        [project.id, connection.id, unrelated.id].sort()
      )
      const row = ticketRow(db, full)
      expect(row.description).toBe(`Plan: ${NEW}/app/docs/plan.md (see also ~/dev/app/notes).`)
      expect(JSON.parse(row.attachments as string)).toEqual([
        { type: 'file', url: `${NEW}/app/docs/spec.pdf`, label: 'spec.pdf' },
        { type: 'file', url: `file://${NEW}/app/docs/a%20b.png`, label: 'a b.png' },
        { type: 'url', url: `https://example.com${OLD}/app`, label: 'link' },
        { type: 'file', url: `${OLD}/app2/shot.png`, label: 'neighbour' },
        'not an attachment'
      ])
      expect(row.external_url).toBe(`${NEW}/app/docs/spec.md`)
      expect(JSON.parse(row.pending_launch_config as string)).toEqual(
        JSON.parse(pendingLaunch(`Read ${NEW}/app/docs/plan.md first`))
      )
      expect(row.updated_at).toBe(STAMP)

      expect(ticketRow(db, garbled)).toMatchObject({
        description: `In ${NEW}/app`,
        attachments: `[{"url":"${OLD}/app/x.png"`,
        pending_launch_config: `{"prompt":"${OLD}/app"`,
        updated_at: STAMP
      })
      expect(ticketRow(db, onConnection)).toMatchObject({
        description: `Fix ${NEW}/app/api`,
        updated_at: STAMP
      })
      expect(ticketRow(db, plain)).toEqual(before.plain)
      // A ticket of a project that has nothing to do with the move follows too; its note is prose.
      expect(ticketRow(db, onAnotherProject)).toEqual({
        ...before.onAnotherProject,
        description: `Copied from ${NEW}/app/README.md`
      })
    })

    it('rewrites the tickets of another project that name the folder, and none that name a neighbour', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      addProject(db, 'app 2', `${OLD}/app 2`)
      const web = addProject(db, 'web', `${HOME}/code/web`)
      const own = addTicket(db, project.id, { description: `Start in ${OLD}/app/src` })
      // What a document run of `web` leaves on its board when the document sits in `app`.
      const runTicket = addTicket(db, web.id, {
        description: `Document run of ${OLD}/app/docs/checkout.md`,
        external_url: `${OLD}/app/docs/checkout.md`
      })
      const itemTicket = addTicket(db, web.id, {
        description: `Do it\n- Original document: ${OLD}/app/docs/checkout.md`,
        attachments: JSON.stringify([
          { type: 'file', url: `${OLD_REAL}/app/docs/shot.png`, label: 'shot.png' }
        ]),
        pending_launch_config: pendingLaunch(`Read ~/hive-projects/app/docs/checkout.md`)
      })
      const attachmentOnly = addTicket(db, web.id, {
        attachments: JSON.stringify([{ type: 'file', url: `${OLD}/app/a.png`, label: 'a.png' }])
      })
      const promptOnly = addTicket(db, web.id, {
        pending_launch_config: pendingLaunch(`Compare with ${OLD}/app/src`)
      })
      const neighbour = addTicket(db, web.id, {
        description: `See "${OLD}/app 2/notes.md" and ${OLD}/app\\ 2/README.md`,
        attachments: JSON.stringify([{ type: 'file', url: `${OLD}/app 2/a.png`, label: 'a.png' }]),
        external_url: `${OLD}/app 2/docs/spec.md`,
        pending_launch_config: pendingLaunch(`Work in "${OLD}/app 2"`)
      })
      const elsewhere = addTicket(db, web.id, {
        description: `See ${HOME}/code/web/README.md and ${OLD}/app2/README.md`,
        note: `The old copy was in ${OLD}/app`
      })
      const before = {
        neighbour: ticketRow(db, neighbour),
        elsewhere: ticketRow(db, elsewhere)
      }

      const result = db.relocateProject(appMove(project))

      expect(result.ticketsRewritten).toBe(5)
      expect([...(result.ticketProjectIds ?? [])].sort()).toEqual([project.id, web.id].sort())
      expect(result.otherProjectIds).toEqual([])
      expect(ticketRow(db, own).description).toBe(`Start in ${NEW}/app/src`)
      expect(ticketRow(db, runTicket)).toMatchObject({
        description: `Document run of ${NEW}/app/docs/checkout.md`,
        external_url: `${NEW}/app/docs/checkout.md`,
        updated_at: STAMP
      })
      const item = ticketRow(db, itemTicket)
      expect(item.description).toBe(`Do it\n- Original document: ${NEW}/app/docs/checkout.md`)
      expect(JSON.parse(item.attachments as string)).toEqual([
        { type: 'file', url: `${NEW}/app/docs/shot.png`, label: 'shot.png' }
      ])
      expect(JSON.parse(item.pending_launch_config as string)).toEqual(
        JSON.parse(pendingLaunch('Read ~/dev/app/docs/checkout.md'))
      )
      expect(item.updated_at).toBe(STAMP)
      expect(JSON.parse(ticketRow(db, attachmentOnly).attachments as string)).toEqual([
        { type: 'file', url: `${NEW}/app/a.png`, label: 'a.png' }
      ])
      expect(JSON.parse(ticketRow(db, promptOnly).pending_launch_config as string)).toEqual(
        JSON.parse(pendingLaunch(`Compare with ${NEW}/app/src`))
      )
      expect(ticketRow(db, neighbour)).toEqual(before.neighbour)
      expect(ticketRow(db, elsewhere)).toEqual(before.elsewhere)
    })

    it('finds the folder in a ticket of another project when its name needs escaping inside JSON', () => {
      const db = openDb()
      const quoted = `${OLD}/my "app"`
      const project = addProject(db, 'quoted', quoted)
      const other = addProject(db, 'other', `${OLD}/other`)
      const ticket = addTicket(db, other.id, {
        attachments: JSON.stringify([{ type: 'file', url: `${quoted}/a.png`, label: 'a.png' }])
      })
      const result = db.relocateProject(
        moveInput(project, [{ from: [quoted], to: `${NEW}/my-app` }])
      )
      expect(result.ticketsRewritten).toBe(1)
      expect(result.ticketProjectIds).toEqual([other.id])
      expect(JSON.parse(ticketRow(db, ticket).attachments as string)).toEqual([
        { type: 'file', url: `${NEW}/my-app/a.png`, label: 'a.png' }
      ])
    })

    it('names no project when no ticket was rewritten', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      addTicket(db, project.id, { description: 'Nothing about folders' })
      const result = db.relocateProject(appMove(project))
      expect(result).toMatchObject({ ticketsRewritten: 0, ticketProjectIds: [], runIds: [] })
    })

    it('leaves the note of a ticket alone: it is prose', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const ticket = addTicket(db, project.id, {
        note: `Remember ${OLD}/app/TODO`,
        goal_success_criteria: `${OLD}/app/dist exists`
      })
      const result = db.relocateProject(appMove(project))
      expect(result.ticketsRewritten).toBe(0)
      expect(ticketRow(db, ticket)).toMatchObject({
        note: `Remember ${OLD}/app/TODO`,
        goal_success_criteria: `${OLD}/app/dist exists`
      })
    })
  })

  describe('document runs', () => {
    it('rewrites runs chosen by project, by member and by source document, with their items', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const api = addProject(db, 'api', `${OLD}/api`)
      const connection = db.createConnectionProject({
        name: 'app + api',
        path: `${HOME}/.hive/connection-projects/c1`,
        member_project_ids: [api.id, project.id]
      })
      const unrelated = addProject(db, 'docs', `${OLD}/docs`)
      const member = (target: Project, worktreePath: string): Record<string, string> => ({
        project_id: target.id,
        project_name: target.name,
        project_path: target.path,
        symlink_name: target.name,
        base_branch: 'main',
        base_sha: 'abc123',
        integration_branch: 'run/int',
        integration_worktree_id: `wt-${target.name}`,
        integration_worktree_path: worktreePath
      })

      const own = addRun(db, project.id, { source_path: `${OLD}/app/docs/spec.md` })
      const ownItem = addRunItem(db, own, {
        title: `Port ${OLD}/app/legacy`,
        summary: `From ${OLD_REAL}/app/docs/spec.md`,
        description: `- Original document: ${OLD}/app/docs/spec.md\n- Full text: ${HOME}/.hive/document-runs/x/document.md`,
        open_questions: JSON.stringify([`Is ${OLD}/app/api still used?`, 'Who reviews?'])
      })
      const plainItem = addRunItem(db, own, {
        title: 'Nothing to change',
        summary: '',
        description: 'No folder here',
        open_questions: '[]'
      })

      const members = [
        member(api, `${HOME}/.hive-worktrees/api/run-int`),
        member(project, `${OLD_REAL}/app/.claude/worktrees/run-int`)
      ]
      const onConnection = addRun(db, connection.id, {
        source_path: `${HOME}/Documents/spec.md`,
        members
      })
      const connectionItem = addRunItem(db, onConnection, {
        title: 'Shared change',
        summary: '',
        description: `Touch ${OLD}/app/src and ${OLD}/api/src`,
        open_questions: 'not json'
      })

      const bySource = addRun(db, unrelated.id, { source_path: `${OLD}/app/docs/other.md` })
      const bySourceItem = addRunItem(db, bySource, {
        title: 'From a document in the moved folder',
        summary: '',
        description: `- Original document: ${OLD}/app/docs/other.md`,
        open_questions: '[]'
      })

      const byMember = addRun(db, unrelated.id, {
        source_path: `${HOME}/Documents/other.md`,
        members: [member(project, `${HOME}/.hive-worktrees/app/int`)]
      })

      const outOfScope = addRun(db, unrelated.id, { source_path: `${OLD}/app2/docs/spec.md` })
      const outOfScopeItem = addRunItem(db, outOfScope, {
        title: 'Unrelated',
        summary: '',
        description: `Mentions ${OLD}/app/src in passing`,
        open_questions: '[]'
      })
      const before = {
        plainItem: itemRow(db, plainItem),
        outOfScope: runRow(db, outOfScope),
        outOfScopeItem: itemRow(db, outOfScopeItem)
      }

      const result = db.relocateProject(appMove(project))

      expect(result.runsRewritten).toBe(4)
      expect([...(result.runIds ?? [])].sort()).toEqual(
        [own, onConnection, bySource, byMember].sort()
      )
      expect(runRow(db, own)).toMatchObject({
        source_path: `${NEW}/app/docs/spec.md`,
        members: null,
        updated_at: STAMP
      })
      expect(itemRow(db, ownItem)).toMatchObject({
        title: `Port ${NEW}/app/legacy`,
        summary: `From ${NEW}/app/docs/spec.md`,
        description: `- Original document: ${NEW}/app/docs/spec.md\n- Full text: ${HOME}/.hive/document-runs/x/document.md`,
        open_questions: JSON.stringify([`Is ${NEW}/app/api still used?`, 'Who reviews?']),
        updated_at: STAMP
      })
      expect(itemRow(db, plainItem)).toEqual(before.plainItem)

      const connectionRun = runRow(db, onConnection)
      expect(connectionRun.source_path).toBe(`${HOME}/Documents/spec.md`)
      expect(connectionRun.updated_at).toBe(STAMP)
      expect(JSON.parse(connectionRun.members as string)).toEqual([
        members[0],
        {
          ...members[1],
          project_path: `${NEW}/app`,
          integration_worktree_path: `${NEW}/app/.claude/worktrees/run-int`
        }
      ])
      expect(itemRow(db, connectionItem)).toMatchObject({
        description: `Touch ${NEW}/app/src and ${OLD}/api/src`,
        open_questions: 'not json',
        updated_at: STAMP
      })

      expect(runRow(db, bySource)).toMatchObject({
        source_path: `${NEW}/app/docs/other.md`,
        updated_at: STAMP
      })
      expect(itemRow(db, bySourceItem).description).toBe(
        `- Original document: ${NEW}/app/docs/other.md`
      )
      expect(JSON.parse(runRow(db, byMember).members as string)).toEqual([
        { ...member(project, `${HOME}/.hive-worktrees/app/int`), project_path: `${NEW}/app` }
      ])
      expect(runRow(db, outOfScope)).toEqual(before.outOfScope)
      expect(itemRow(db, outOfScopeItem)).toEqual(before.outOfScopeItem)

      // The app's own reader sees the same thing.
      expect(db.getDocumentRun(onConnection)?.members?.[1].project_path).toBe(`${NEW}/app`)
    })

    it('counts a run whose items changed even when its own row did not', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const runId = addRun(db, project.id, { source_path: `${HOME}/Documents/spec.md` })
      addRunItem(db, runId, {
        title: 'Item',
        summary: '',
        description: `Edit ${OLD}/app/src/index.ts`,
        open_questions: '[]'
      })
      const untouched = addRun(db, project.id, { source_path: `${HOME}/Documents/b.md` })
      const before = runRow(db, untouched)

      const result = db.relocateProject(appMove(project))

      expect(result.runsRewritten).toBe(1)
      expect(result.runIds).toEqual([runId])
      expect(runRow(db, runId)).toMatchObject({
        source_path: `${HOME}/Documents/spec.md`,
        updated_at: STAMP
      })
      expect(runRow(db, untouched)).toEqual(before)
    })

    it('repoints the worktree a run works in and its copy of the document when they sit in the folder', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const inside = addRun(db, project.id, { source_path: `${HOME}/Documents/spec.md` })
      run(
        db,
        'UPDATE document_runs SET integration_worktree_path = ?, document_path = ? WHERE id = ?',
        `${OLD_REAL}/app/.claude/worktrees/run-int`,
        `${OLD}/app/docs/run/document.md`,
        inside
      )
      const outside = addRun(db, project.id, { source_path: `${HOME}/Documents/other.md` })
      run(
        db,
        'UPDATE document_runs SET integration_worktree_path = ?, document_path = ? WHERE id = ?',
        `${HOME}/.hive-worktrees/app/run-int`,
        `${HOME}/.hive/document-runs/${outside}/document.md`,
        outside
      )
      const before = runRow(db, outside)

      const result = db.relocateProject(appMove(project))

      expect(result.runIds).toEqual([inside])
      expect(runRow(db, inside)).toMatchObject({
        source_path: `${HOME}/Documents/spec.md`,
        integration_worktree_path: `${NEW}/app/.claude/worktrees/run-int`,
        document_path: `${NEW}/app/docs/run/document.md`,
        updated_at: STAMP
      })
      expect(runRow(db, outside)).toEqual(before)
      expect(db.getDocumentRun(inside)?.integration_worktree_path).toBe(
        `${NEW}/app/.claude/worktrees/run-int`
      )
    })
  })

  describe('markdown card state', () => {
    it('rewrites where a card was last seen, its attachments and its queued prompt', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const unrelated = addProject(db, 'notes', `${OLD}/notes`)
      addCard(db, project.id, 'card-a', {
        last_seen_path: `${OLD_REAL}/app/docs/kanban/card-a.md`,
        attachments: JSON.stringify([{ type: 'file', url: `${OLD}/app/a.png`, label: 'a.png' }]),
        pending_launch_config: pendingLaunch(`Start in ${OLD}/app`)
      })
      addCard(db, project.id, 'card-b', { last_seen_path: null })
      addCard(db, project.id, 'card-c', {
        last_seen_path: `${HOME}/boards/app/card-c.md`,
        attachments: 'not json'
      })
      // A board of another project whose cards are files in the moved folder.
      addCard(db, unrelated.id, 'card-d', { last_seen_path: `${OLD}/app/board/card-d.md` })
      addCard(db, unrelated.id, 'card-e', { last_seen_path: `${OLD}/app2/board/card-e.md` })
      const before = {
        b: cardRow(db, project.id, 'card-b'),
        c: cardRow(db, project.id, 'card-c'),
        e: cardRow(db, unrelated.id, 'card-e')
      }

      const result = db.relocateProject(appMove(project))

      expect(result.ticketsRewritten).toBe(2)
      // A card of a markdown board is that board's ticket.
      expect([...(result.ticketProjectIds ?? [])].sort()).toEqual([project.id, unrelated.id].sort())
      const a = cardRow(db, project.id, 'card-a')
      expect(a.last_seen_path).toBe(`${NEW}/app/docs/kanban/card-a.md`)
      expect(JSON.parse(a.attachments as string)).toEqual([
        { type: 'file', url: `${NEW}/app/a.png`, label: 'a.png' }
      ])
      expect(JSON.parse(a.pending_launch_config as string)).toEqual(
        JSON.parse(pendingLaunch(`Start in ${NEW}/app`))
      )
      expect(a.updated_at).toBe(STAMP)
      expect(cardRow(db, unrelated.id, 'card-d')).toMatchObject({
        last_seen_path: `${NEW}/app/board/card-d.md`,
        updated_at: STAMP
      })
      expect(cardRow(db, project.id, 'card-b')).toEqual(before.b)
      expect(cardRow(db, project.id, 'card-c')).toEqual(before.c)
      expect(cardRow(db, unrelated.id, 'card-e')).toEqual(before.e)
    })
  })

  describe('settings', () => {
    it('re-keys the slash commands kept per working directory', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      addWorktree(db, project, 'main', `${OLD}/app`, { isDefault: true })
      addWorktree(db, project, 'w1', `${OLD_REAL}/app/.claude/worktrees/w1`)
      // Both spellings of the checkout have a row, and a stale one sits at the new key.
      db.setSetting(`slash_commands:${OLD_REAL}/app`, '["/from-real-path"]')
      db.setSetting(`slash_commands:${OLD}/app`, '["/from-stored-path"]')
      db.setSetting(`slash_commands:${NEW}/app`, '["/stale"]')
      db.setSetting(`slash_commands:${OLD_REAL}/app/.claude/worktrees/w1`, '["/nested"]')
      db.setSetting(`slash_commands:${OLD}/app2`, '["/neighbour"]')
      db.setSetting(`slash_commands:${HOME}/.hive-worktrees/app/feature`, '["/elsewhere"]')
      db.setSetting('app_settings', `{"note":"${OLD}/app"}`)
      drain()

      db.relocateProject(appMove(project))

      const settings = Object.fromEntries(
        all(db, 'SELECT key, value FROM settings WHERE instr(key, ?) = 1', 'slash_commands:').map(
          (row) => [row.key, row.value]
        )
      )
      expect(settings).toEqual({
        [`slash_commands:${NEW}/app`]: '["/from-stored-path"]',
        [`slash_commands:${NEW}/app/.claude/worktrees/w1`]: '["/nested"]',
        [`slash_commands:${OLD}/app2`]: '["/neighbour"]',
        [`slash_commands:${HOME}/.hive-worktrees/app/feature`]: '["/elsewhere"]'
      })
      expect(db.getSetting('app_settings')).toBe(`{"note":"${OLD}/app"}`)
    })
  })

  describe('data projects', () => {
    it('repoints the files a connection reads from the moved folder', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      addDataProject(
        db,
        'absolute',
        JSON.stringify({ filePath: `${OLD}/app/data/dev.sqlite`, readOnlyFile: true })
      )
      addDataProject(
        db,
        'from-home',
        JSON.stringify({ filePath: '~/hive-projects/app/dev.sqlite' })
      )
      addDataProject(
        db,
        'certificates',
        JSON.stringify({
          host: 'db.internal',
          options: { note: `${OLD}/app` },
          ssl: {
            mode: 'verify-full',
            caPath: `${OLD_REAL}/app/certs/ca.pem`,
            certPath: `${OLD}/app/certs/client.pem`,
            keyPath: `${HOME}/.ssl/client.key`
          },
          ssh: {
            enabled: true,
            host: 'bastion',
            port: 22,
            username: 'me',
            authMethod: 'privateKey',
            privateKeyPath: `${OLD}/app/.ssh/id_ed25519`
          }
        })
      )
      const neighbour = JSON.stringify({ filePath: `${OLD}/app2/dev.sqlite` })
      addDataProject(db, 'neighbour', neighbour)
      const elsewhere = JSON.stringify({
        filePath: '~/data/dev.sqlite',
        ssh: { privateKeyPath: '~/.ssh/id_rsa' }
      })
      addDataProject(db, 'elsewhere', elsewhere)
      addDataProject(db, 'garbled', `{"filePath":"${OLD}/app/dev.sqlite"`)

      const result = db.relocateProject(appMove(project))

      expect([...result.dataProjectIds].sort()).toEqual(['absolute', 'certificates', 'from-home'])
      expect(JSON.parse(dataConfig(db, 'absolute') as string)).toEqual({
        filePath: `${NEW}/app/data/dev.sqlite`,
        readOnlyFile: true
      })
      expect(JSON.parse(dataConfig(db, 'from-home') as string)).toEqual({
        filePath: '~/dev/app/dev.sqlite'
      })
      expect(JSON.parse(dataConfig(db, 'certificates') as string)).toEqual({
        host: 'db.internal',
        options: { note: `${OLD}/app` },
        ssl: {
          mode: 'verify-full',
          caPath: `${NEW}/app/certs/ca.pem`,
          certPath: `${NEW}/app/certs/client.pem`,
          keyPath: `${HOME}/.ssl/client.key`
        },
        ssh: {
          enabled: true,
          host: 'bastion',
          port: 22,
          username: 'me',
          authMethod: 'privateKey',
          privateKeyPath: `${NEW}/app/.ssh/id_ed25519`
        }
      })
      expect(dataConfig(db, 'neighbour')).toBe(neighbour)
      expect(dataConfig(db, 'elsewhere')).toBe(elsewhere)
      expect(dataConfig(db, 'garbled')).toBe(`{"filePath":"${OLD}/app/dev.sqlite"`)
      expect(db.getDataProject('absolute')?.config.filePath).toBe(`${NEW}/app/data/dev.sqlite`)
    })

    it('writes the absolute path for a ~/ file whose folder left the home directory', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      addDataProject(
        db,
        'from-home',
        JSON.stringify({ filePath: '~/hive-projects/app/dev.sqlite' })
      )
      db.relocateProject(moveInput(project, [{ from: [`${OLD}/app`], to: '/Volumes/work/app' }]))
      expect(JSON.parse(dataConfig(db, 'from-home') as string)).toEqual({
        filePath: '/Volumes/work/app/dev.sqlite'
      })
    })
  })

  describe('the pending-move row and events', () => {
    it('writes the pending move with the relocation, reads it back, and clears it', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const input = moveInput(project, [
        { from: [`${OLD}/app`, `${OLD_REAL}/app`], to: `${NEW}/app` },
        { from: [`${OLD}/app-feature`], to: `${NEW}/app-feature` }
      ])
      expect(db.readPendingDevFolderMove()).toBeNull()

      db.relocateProject(input)

      expect(db.readPendingDevFolderMove()).toEqual(input.pending)
      expect(JSON.parse(db.getSetting(DEV_FOLDER_PENDING_MOVE_KEY) as string)).toEqual(
        input.pending
      )

      db.clearPendingDevFolderMove()
      expect(db.readPendingDevFolderMove()).toBeNull()
      expect(db.getSetting(DEV_FOLDER_PENDING_MOVE_KEY)).toBeNull()
      // Clearing twice is fine: the follow-up steps may run again after a restart.
      db.clearPendingDevFolderMove()
      expect(db.readPendingDevFolderMove()).toBeNull()
    })

    it('replaces the pending row of an earlier move', () => {
      const db = openDb()
      const first = addProject(db, 'app', `${OLD}/app`)
      const second = addProject(db, 'api', `${OLD}/api`)
      db.relocateProject(appMove(first))
      const input = moveInput(second, [{ from: [`${OLD}/api`], to: `${NEW}/api` }])
      db.relocateProject(input)
      expect(db.readPendingDevFolderMove()).toEqual(input.pending)
    })

    it.each([
      ['not JSON', 'nonsense'],
      ['not an object', '["a"]'],
      ['no project', JSON.stringify({ fromPath: '/a', toPath: '/b', relocations: [] })],
      [
        'a relocation without spellings',
        JSON.stringify({
          projectId: 'p',
          fromPath: '/a',
          fromRealPath: null,
          toPath: '/b',
          relocations: [{ from: [], to: '/b' }]
        })
      ],
      [
        'a relocation that is not one',
        JSON.stringify({ projectId: 'p', fromPath: '/a', toPath: '/b', relocations: ['x'] })
      ]
    ])('reads a pending row that is %s as nothing pending', (_label, value) => {
      const db = openDb()
      db.setSetting(DEV_FOLDER_PENDING_MOVE_KEY, value)
      expect(db.readPendingDevFolderMove()).toBeNull()
    })

    it('reads a pending row written without a real path', () => {
      const db = openDb()
      db.setSetting(
        DEV_FOLDER_PENDING_MOVE_KEY,
        JSON.stringify({
          projectId: 'p',
          fromPath: '/a/app',
          toPath: '/b/app',
          relocations: [{ from: ['/a/app'], to: '/b/app' }],
          somethingNewer: true
        })
      )
      expect(db.readPendingDevFolderMove()).toEqual({
        projectId: 'p',
        fromPath: '/a/app',
        fromRealPath: null,
        toPath: '/b/app',
        relocations: [{ from: ['/a/app'], to: '/b/app' }]
      })
    })

    it('reads the old folders a move to another volume copied, and writes them with the move', () => {
      const db = openDb()
      const project = addProject(db, 'app', `${OLD}/app`)
      const input = appMove(project)
      const pending: PendingDevFolderMove = {
        ...input.pending,
        copiedFrom: [`${OLD}/app`, `${OLD}/app-feature`]
      }

      db.relocateProject({ ...input, pending })

      expect(db.readPendingDevFolderMove()).toEqual(pending)
      expect(db.readPendingDevFolderMove()?.copiedFrom).toEqual([
        `${OLD}/app`,
        `${OLD}/app-feature`
      ])
    })

    it.each([
      ['not a list', '/a/app'],
      ['a list that holds something else than paths', ['/a/app', 7]],
      ['an object', { 0: '/a/app' }],
      ['null', null]
    ])('drops copied folders that are %s and still reads the rest', (_label, copiedFrom) => {
      const db = openDb()
      const stored = {
        projectId: 'p',
        fromPath: '/a/app',
        fromRealPath: null,
        toPath: '/b/app',
        relocations: [{ from: ['/a/app'], to: '/b/app' }]
      }
      db.setSetting(DEV_FOLDER_PENDING_MOVE_KEY, JSON.stringify({ ...stored, copiedFrom }))
      const pending = db.readPendingDevFolderMove()
      expect(pending).toEqual(stored)
      expect(pending).not.toHaveProperty('copiedFrom')
    })

    it('publishes no db:changed event: not for the move, not for clearing the pending row', () => {
      const db = openDb()
      const world = seedWorld(db)
      expect(drain()).toEqual([])

      const result = db.relocateProject(appMove(world.project))
      // The move did write: to the project, a worktree, a ticket, a run, a setting, a data project.
      expect(result.worktrees.length).toBeGreaterThan(0)
      expect(result.ticketsRewritten).toBeGreaterThan(0)
      expect(result.runsRewritten).toBeGreaterThan(0)
      expect(result.dataProjectIds).toEqual(['data-1'])
      expect(drain()).toEqual([])

      db.readPendingDevFolderMove()
      db.clearPendingDevFolderMove()
      db.namesRegisteredInside([`${NEW}/app`], world.project.id)
      db.listDocumentRunsInStatuses(['completed'])
      expect(drain()).toEqual([])

      // The publisher is live: an ordinary write is still announced.
      db.createProject({ name: 'announced', path: `${NEW}/announced` })
      expect(drain().length).toBeGreaterThan(0)
    })

    it('leaves every updated_at and the project timestamps as they were', () => {
      const db = openDb()
      const world = seedWorld(db)
      const stamps = (): Row[] =>
        [
          'SELECT id, created_at, last_accessed_at FROM projects ORDER BY id',
          'SELECT id, created_at, last_accessed_at FROM worktrees ORDER BY id',
          'SELECT id, updated_at FROM kanban_tickets ORDER BY id',
          'SELECT id, updated_at FROM document_runs ORDER BY id',
          'SELECT id, updated_at FROM document_run_items ORDER BY id',
          'SELECT card_id, updated_at FROM markdown_kanban_card_state ORDER BY card_id',
          'SELECT id, updated_at FROM sessions ORDER BY id',
          'SELECT id, last_accessed_at FROM data_projects ORDER BY id'
        ].flatMap((sql) => all(db, sql))
      const before = stamps()
      db.relocateProject(appMove(world.project))
      expect(stamps()).toEqual(before)
    })
  })
})

describeIf('DatabaseService.namesRegisteredInside', () => {
  if (databaseLoadError) return

  it('names other projects registered strictly inside the folder, in any of its spellings', () => {
    const db = openDb()
    const project = addProject(db, 'app', `${OLD}/app`)
    addWorktree(db, project, 'main', `${OLD}/app`, { isDefault: true })
    addWorktree(db, project, 'own', `${OLD}/app/.claude/worktrees/own`)
    const spellings = [`${OLD}/app`, `${OLD_REAL}/app`]
    expect(db.namesRegisteredInside(spellings, project.id)).toEqual([])

    addProject(db, 'inner', `${OLD}/app/packages/inner`)
    addProject(db, 'inner by real path', `${OLD_REAL}/app/tools`)
    const elsewhere = addProject(db, 'elsewhere', `${HOME}/code/elsewhere`)
    addWorktree(db, elsewhere, 'odd', `${OLD_REAL}/app/.claude/worktrees/odd`)
    addWorktree(db, elsewhere, 'odd too', `${OLD}/app/.claude/worktrees/odd-too`)
    const archivedOwner = addProject(db, 'archived owner', `${HOME}/code/archived`)
    addWorktree(db, archivedOwner, 'gone', `${OLD}/app/.claude/worktrees/gone`, { archived: true })
    // Next to the folder, or the folder itself under another spelling: not inside it.
    addProject(db, 'app2', `${OLD}/app2`)
    addProject(db, 'app 2', `${OLD}/app 2`)
    addProject(db, 'my_app', `${OLD}/appX`)
    addProject(db, 'twin', `${OLD_REAL}/app`)

    expect(db.namesRegisteredInside(spellings, project.id).sort()).toEqual(
      ['elsewhere', 'inner', 'inner by real path'].sort()
    )
    // One spelling only finds what is stored in that spelling.
    expect(db.namesRegisteredInside([`${OLD}/app`], project.id).sort()).toEqual(
      ['elsewhere', 'inner'].sort()
    )
    expect(db.namesRegisteredInside([`${OLD}/app/`], project.id).sort()).toEqual(
      ['elsewhere', 'inner'].sort()
    )
    // The project itself is only left out for its own id.
    expect(db.namesRegisteredInside([OLD], 'nobody')).toContain('app')
    expect(db.namesRegisteredInside([], project.id)).toEqual([])
    expect(db.namesRegisteredInside([`${OLD}/nothing-here`], project.id)).toEqual([])
  })

  it('compares names literally: _ and % are not wildcards', () => {
    const db = openDb()
    const project = addProject(db, 'my_app', `${OLD}/my_app`)
    addProject(db, 'lookalike', `${OLD}/myXapp/inner`)
    addProject(db, 'percent', `${OLD}/100%/inner`)
    expect(db.namesRegisteredInside([`${OLD}/my_app`], project.id)).toEqual([])
    expect(db.namesRegisteredInside([`${OLD}/100%`], project.id)).toEqual(['percent'])
    expect(db.namesRegisteredInside([`${OLD}/1%`], project.id)).toEqual([])
  })
})

describeIf('DatabaseService.listDocumentRunsInStatuses', () => {
  if (databaseLoadError) return

  it('returns every run in the given statuses, of every project, mapped like any other read', () => {
    const db = openDb()
    const app = addProject(db, 'app', `${OLD}/app`)
    const api = addProject(db, 'api', `${OLD}/api`)
    const running = addRun(db, app.id, { source_path: '/docs/a.md', status: 'running' })
    const paused = addRun(db, api.id, {
      source_path: '/docs/b.md',
      status: 'paused',
      members: [{ project_id: app.id, project_path: app.path }]
    })
    const extracting = addRun(db, api.id, { source_path: '/docs/c.md', status: 'extracting' })
    addRun(db, app.id, { source_path: '/docs/d.md', status: 'completed' })
    addRun(db, app.id, { source_path: '/docs/e.md', status: 'cancelled' })

    const busy = db.listDocumentRunsInStatuses(['extracting', 'running', 'paused'])
    expect(busy.map((entry) => entry.id).sort()).toEqual([running, paused, extracting].sort())
    const pausedRun = busy.find((entry) => entry.id === paused)
    expect(pausedRun).toEqual(db.getDocumentRun(paused))
    expect(pausedRun?.members?.[0].project_id).toBe(app.id)

    expect(db.listDocumentRunsInStatuses(['running']).map((entry) => entry.id)).toEqual([running])
    expect(db.listDocumentRunsInStatuses(['preview'])).toEqual([])
    expect(db.listDocumentRunsInStatuses([])).toEqual([])
  })

  it('has no page size', () => {
    const db = openDb()
    const app = addProject(db, 'app', `${OLD}/app`)
    for (let index = 0; index < 230; index += 1) {
      addRun(db, app.id, { source_path: `/docs/${index}.md`, status: 'running' })
    }
    expect(db.listDocumentRunsInStatuses(['running'])).toHaveLength(230)
    expect(db.listDocumentRuns(undefined, 1000)).toHaveLength(200)
  })
})
