/**
 * The move service bound to the app: the database port, and (with a real database, so only
 * under the app runtime) the live bindings working on real folders, connection links, Claude
 * state and the port registry, all inside one temp directory.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     src/main/services/dev-folder/__tests__/live-deps.test.ts
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The home directory, Claude's config directory and the database are pointed at a temp
// directory before anything is imported: the port registry fixes its file from the home
// directory when it is loaded, and the database module opens the path it finds in the
// environment.
const sandboxed = await vi.hoisted(async () => {
  const { mkdirSync, mkdtempSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'hive-live-deps-')))
  const home = join(sandbox, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(sandbox, 'db'))
  const names = [
    'HOME',
    'USERPROFILE',
    'CLAUDE_CONFIG_DIR',
    'HIVE_SERVER_DB_PATH',
    'HIVE_SERVER_BASE_DIR'
  ]
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  process.env.HIVE_SERVER_DB_PATH = join(sandbox, 'db', 'state.sqlite')
  delete process.env.HIVE_SERVER_BASE_DIR
  const restore = (): void => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    }
  }
  return { sandbox, home, restore }
})

const doubles = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  /** What the desktop app answers when asked for its agent CLIs. */
  agentSnapshot: { supported: true, sessions: [] as unknown[] } as Record<string, unknown>,
  // Made here and not in the module factories below: a factory runs once for each import
  // that is still waiting for it, and every run has to hand out the same recorder.
  stopBoardWatch: vi.fn(),
  restartBoardWatch: vi.fn(),
  rebindBranchWatch: vi.fn(),
  rebindWorktreeGitWatch: vi.fn(),
  moveFolderEntry: vi.fn(),
  syncWorktrees: vi.fn(),
  /** Stands in for the data engine of the process: closing the connections of a data project. */
  invalidateDataEngine: vi.fn(async (_id: string): Promise<void> => undefined)
}))

vi.mock('../../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../logger')>()),
  createLogger: () => doubles.logger
}))

// The real service asks the desktop app over this process's channel to its parent. Under the
// test runner that parent is the runner, which must not be sent a desktop command.
vi.mock('../../../../server/rpc/domains/session-profiler-ops', async () => {
  const { Effect } = await import('effect')
  return {
    makeLiveSessionProfilerOpsRpcService: () => ({
      getSnapshot: () => Effect.sync(() => doubles.agentSnapshot)
    })
  }
})

// The real watchers, with their calls recorded.
vi.mock('../../markdown-kanban-watcher', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../markdown-kanban-watcher')>()
  doubles.stopBoardWatch.mockImplementation(original.deactivateMarkdownKanbanProjectWatch)
  doubles.restartBoardWatch.mockImplementation(original.restartMarkdownKanbanProjectWatch)
  return {
    ...original,
    deactivateMarkdownKanbanProjectWatch: doubles.stopBoardWatch,
    restartMarkdownKanbanProjectWatch: doubles.restartBoardWatch
  }
})
vi.mock('../../branch-watcher', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../branch-watcher')>()
  doubles.rebindBranchWatch.mockImplementation(original.rebindBranchWatch)
  return { ...original, rebindBranchWatch: doubles.rebindBranchWatch }
})
vi.mock('../../worktree-watcher', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../worktree-watcher')>()
  doubles.rebindWorktreeGitWatch.mockImplementation(original.rebindWorktreeGitWatch)
  return { ...original, rebindWorktreeGitWatch: doubles.rebindWorktreeGitWatch }
})
// The real writer of Claude's settings file and the real worktree sync, calls recorded too.
vi.mock('../../claude-trust', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../claude-trust')>()
  doubles.moveFolderEntry.mockImplementation(original.moveFolderEntryInClaudeConfig)
  return { ...original, moveFolderEntryInClaudeConfig: doubles.moveFolderEntry }
})
vi.mock('../../worktree-ops', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../worktree-ops')>()
  doubles.syncWorktrees.mockImplementation(original.syncWorktreesOp)
  return { ...original, syncWorktreesOp: doubles.syncWorktrees }
})
// The engine of the data projects is a double: the real one opens database connections.
vi.mock('../../data-projects/engine-service', () => ({
  invalidateDataEngineIfLoaded: doubles.invalidateDataEngine
}))

import { DEFAULT_DOCUMENT_RUN_CONFIG } from '../../../../shared/types/document-flow'
import {
  DEV_FOLDER_SETTING_KEY,
  serializeStoredDevFolder
} from '../../../../shared/types/dev-folder'
import type { DatabaseService } from '../../../db'
import type { Project, Worktree } from '../../../db/types'
import { createLiveMoveQueryDeps, createMoveProjectsDbPort } from '../live-query-deps'
import type { MovedProject, MoveProjectsDb, MoveProjectsDeps, RelocationMove } from '../types'

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
const isRoot = process.getuid?.() === 0

afterAll(() => {
  sandboxed.restore()
  rmSync(sandbox, { recursive: true, force: true })
})

describe('createMoveProjectsDbPort', () => {
  it('binds every method of the port to the database, arguments and answer unchanged', () => {
    const answers = {
      getProject: { id: 'p' },
      getAllProjects: [{ id: 'p' }],
      getProjectByPath: { id: 'q' },
      getWorktreesByProject: [{ id: 'w' }],
      namesRegisteredInside: ['other'],
      relocateProject: { project: { id: 'p' } },
      readPendingDevFolderMove: { projectId: 'p' },
      clearPendingDevFolderMove: undefined
    }
    const database = Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => [name, vi.fn(() => answer)])
    )
    const port = createMoveProjectsDbPort(database as unknown as DatabaseService)
    const relocation = { projectId: 'p' } as Parameters<MoveProjectsDb['relocateProject']>[0]

    expect(port.getProject('p')).toBe(answers.getProject)
    expect(port.getAllProjects()).toBe(answers.getAllProjects)
    expect(port.getProjectByPath('/dev/p')).toBe(answers.getProjectByPath)
    expect(port.getWorktreesByProject('p')).toBe(answers.getWorktreesByProject)
    expect(port.namesRegisteredInside(['/a', '/b'], 'p')).toBe(answers.namesRegisteredInside)
    expect(port.relocateProject(relocation)).toBe(answers.relocateProject)
    expect(port.readPendingMove()).toBe(answers.readPendingDevFolderMove)
    expect(port.clearPendingMove()).toBeUndefined()

    expect(database.getProject).toHaveBeenCalledWith('p')
    expect(database.getAllProjects).toHaveBeenCalledWith()
    expect(database.getProjectByPath).toHaveBeenCalledWith('/dev/p')
    expect(database.getWorktreesByProject).toHaveBeenCalledWith('p')
    expect(database.namesRegisteredInside).toHaveBeenCalledWith(['/a', '/b'], 'p')
    expect(database.relocateProject).toHaveBeenCalledWith(relocation)
    expect(database.readPendingDevFolderMove).toHaveBeenCalledWith()
    expect(database.clearPendingDevFolderMove).toHaveBeenCalledWith()
    for (const method of Object.values(database)) expect(method).toHaveBeenCalledTimes(1)
    expect(Object.keys(port).sort()).toEqual([
      'clearPendingMove',
      'getAllProjects',
      'getProject',
      'getProjectByPath',
      'getWorktreesByProject',
      'namesRegisteredInside',
      'readPendingMove',
      'relocateProject'
    ])
  })
})

describe('createLiveMoveQueryDeps', () => {
  it('reads the folders from the setting on every call, with the given home directory', () => {
    let row: string | null = null
    const database = { getSetting: vi.fn(() => row) } as unknown as DatabaseService
    const deps = createLiveMoveQueryDeps(database, { homeDir: '/somewhere/home' })

    expect(deps.folders()).toEqual({
      devFolder: '/somewhere/home/hive-projects',
      previousFolders: []
    })

    row = serializeStoredDevFolder({ path: '/vol/dev', previousPaths: ['/vol/before'] })
    expect(deps.folders()).toEqual({ devFolder: '/vol/dev', previousFolders: ['/vol/before'] })
  })

  it('never throws from folders: a setting that cannot be read is the default folder', () => {
    const database = {
      getSetting: () => {
        throw new Error('database is closed')
      }
    } as unknown as DatabaseService

    expect(createLiveMoveQueryDeps(database, { homeDir: '/somewhere/home' }).folders()).toEqual({
      devFolder: '/somewhere/home/hive-projects',
      previousFolders: []
    })
  })
})

describeIf('createLiveMoveProjectsDeps on a real database', () => {
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com'
  }
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })

  const claudeConfigPath = join(home, '.claude', '.claude.json')
  const claudeProjectsDir = join(home, '.claude', 'projects')
  const portRegistryPath = join(home, '.playwright-mcp-ports.json')
  const readJson = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

  let db: DatabaseService
  let deps: MoveProjectsDeps
  let app: {
    closeDatabase: () => void
    createConnectionOp: typeof import('../../connection-ops').createConnectionOp
    saveConnectionAsProjectOp: typeof import('../../connection-ops').saveConnectionAsProjectOp
    encodePath: (path: string) => string
    boards: { invalidate: (projectId: string) => void }
    setDbChangeEventPublisher: typeof import('../../db-change-events').setDbChangeEventPublisher
    flushDbChanged: () => void
    setDevFolderMoveEventPublisher: typeof import('../live-deps').setDevFolderMoveEventPublisher
    createLiveMoveProjectsDeps: typeof import('../live-deps').createLiveMoveProjectsDeps
  }
  const dbChanged = vi.fn(async (_channel: string, _payload: unknown): Promise<void> => undefined)
  const otherEvents = vi.fn((_channel: string, _payload: unknown): void => undefined)

  /** The `db:changed` events published since the last call, without their time and origin. */
  const takeDbChanged = (): Record<string, unknown>[] => {
    app.flushDbChanged()
    const events = dbChanged.mock.calls.map(([channel, payload]) => {
      expect(channel).toBe('db:changed')
      const { entity, op, id, projectId } = payload as Record<string, unknown>
      return { entity, op, id, projectId }
    })
    dbChanged.mockClear()
    return events
  }

  beforeAll(async () => {
    if (databaseLoadError) throw databaseLoadError
    const [dbModule, connectionOps, transcripts, kanban, events, live] = await Promise.all([
      import('../../../db'),
      import('../../connection-ops'),
      import('../../claude-transcript-reader'),
      import('../../kanban-backend'),
      import('../../db-change-events'),
      import('../live-deps')
    ])
    db = dbModule.getDatabase()
    app = {
      closeDatabase: dbModule.closeDatabase,
      createConnectionOp: connectionOps.createConnectionOp,
      saveConnectionAsProjectOp: connectionOps.saveConnectionAsProjectOp,
      encodePath: transcripts.encodePath,
      boards: kanban.getMarkdownKanbanBackend(),
      setDbChangeEventPublisher: events.setDbChangeEventPublisher,
      flushDbChanged: events.flushPendingDbChangedEvents,
      setDevFolderMoveEventPublisher: live.setDevFolderMoveEventPublisher,
      createLiveMoveProjectsDeps: live.createLiveMoveProjectsDeps
    }
    app.setDbChangeEventPublisher(dbChanged)
    app.setDevFolderMoveEventPublisher(otherEvents)
    deps = await app.createLiveMoveProjectsDeps({ db, homeDir: home, env: { ...process.env } })
  })

  afterAll(() => {
    app?.setDbChangeEventPublisher(null)
    app?.setDevFolderMoveEventPublisher(null)
    app?.closeDatabase()
  })

  beforeEach(() => {
    doubles.agentSnapshot = { supported: true, sessions: [] }
    for (const spy of [
      doubles.restartBoardWatch,
      doubles.stopBoardWatch,
      doubles.rebindBranchWatch,
      doubles.rebindWorktreeGitWatch,
      doubles.moveFolderEntry,
      doubles.syncWorktrees,
      otherEvents
    ]) {
      spy.mockClear()
    }
    doubles.invalidateDataEngine.mockReset()
    doubles.invalidateDataEngine.mockResolvedValue(undefined)
    // A fixture's `relocate` leaves the note of a move whose follow-up steps are owed, as the
    // service does. Each test starts with none: the service finishes an owed move before it
    // starts another, and would run the steps of an earlier test's fixture.
    db.clearPendingDevFolderMove()
    takeDbChanged()
  })

  interface Fixture {
    root: string
    project: Project
    neighbour: Project
    connectionProject: Project
    connectionFolder: string
    /** Name of the link to the project in both connection folders. */
    linkName: string
    worktrees: { main: Worktree; nested: Worktree; outside: Worktree }
    oldPath: string
    newPath: string
    /** Move the folder and the rows as the service does, and describe the result. */
    relocate: () => MovedProject
  }

  /**
   * A project in `<root>/old` with a worktree inside its checkout and one elsewhere, a
   * neighbour whose name starts the same, a connection over both and the connection project
   * saved from it, Claude history and settings for the old folder, and a port for it.
   */
  const makeFixture = async (name: string): Promise<Fixture> => {
    const root = join(sandbox, name)
    const oldPath = join(root, 'old', 'app')
    const newPath = join(root, 'new', 'app')
    const nestedOld = join(oldPath, '.claude', 'worktrees', 'nested')
    const outsidePath = join(root, 'wt', 'app-outside')
    for (const dir of [nestedOld, outsidePath, join(root, 'old', 'app-2'), join(root, 'new')]) {
      mkdirSync(dir, { recursive: true })
    }

    const project = db.createProject({ name: `${name}-app`, path: oldPath })
    const neighbour = db.createProject({ name: `${name}-app-2`, path: join(root, 'old', 'app-2') })
    const row = (owner: Project, label: string, path: string, isDefault = false): Worktree =>
      db.createWorktree({
        project_id: owner.id,
        name: label,
        branch_name: label,
        path,
        is_default: isDefault
      })
    const main = row(project, 'main', oldPath, true)
    const nested = row(project, 'nested', nestedOld)
    const outside = row(project, 'outside', outsidePath)
    const neighbourMain = row(neighbour, 'main', neighbour.path, true)

    const created = await app.createConnectionOp(db, [main.id, neighbourMain.id])
    expect(created.success).toBe(true)
    const connection = created.connection!
    const saved = await app.saveConnectionAsProjectOp(db, connection.id)
    expect(saved.success).toBe(true)
    const connectionProject = saved.project!
    // Both folders were made under the stubbed home directory.
    expect(connection.path.startsWith(home)).toBe(true)
    expect(connectionProject.path.startsWith(home)).toBe(true)
    const linkName = connection.members.find(
      (member) => member.project_id === project.id
    )!.symlink_name
    expect(readlinkSync(join(connection.path, linkName))).toBe(oldPath)
    expect(readlinkSync(join(connectionProject.path, linkName))).toBe(oldPath)

    mkdirSync(join(claudeProjectsDir, app.encodePath(oldPath)), { recursive: true })
    writeFileSync(
      join(claudeProjectsDir, app.encodePath(oldPath), 'session.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: oldPath })}\n`
    )
    const config = existsSync(claudeConfigPath) ? readJson(claudeConfigPath) : { oauth: 'kept' }
    const projects = (config.projects ?? {}) as Record<string, unknown>
    projects[oldPath] = { hasTrustDialogAccepted: true, allowedTools: [name] }
    writeFileSync(claudeConfigPath, JSON.stringify({ ...config, projects }, null, 2))
    const ports = existsSync(portRegistryPath) ? readJson(portRegistryPath) : {}
    const port = 3500 + Object.keys(ports).length
    writeFileSync(portRegistryPath, JSON.stringify({ ...ports, [oldPath]: port }))

    const relocate = (): MovedProject => {
      const relocations: RelocationMove[] = [{ from: [oldPath], to: newPath }]
      const result = db.relocateProject({
        projectId: project.id,
        expectedPath: oldPath,
        relocations,
        homeDir: home,
        pending: {
          projectId: project.id,
          fromPath: oldPath,
          fromRealPath: oldPath,
          toPath: newPath,
          relocations
        },
        place: () => renameSync(oldPath, newPath)
      })
      return {
        project: result.project,
        fromPath: oldPath,
        fromRealPath: oldPath,
        toPath: newPath,
        relocations,
        moves: [
          { from: oldPath, to: newPath },
          { from: nestedOld, to: join(newPath, '.claude', 'worktrees', 'nested') }
        ],
        worktrees: result.worktrees,
        allWorktrees: db.getWorktreesByProject(project.id),
        ticketsRewritten: result.ticketsRewritten,
        runsRewritten: result.runsRewritten,
        otherProjectIds: result.otherProjectIds,
        dataProjectIds: result.dataProjectIds
      }
    }

    return {
      root,
      project,
      neighbour,
      connectionProject,
      connectionFolder: connection.path,
      linkName,
      worktrees: { main, nested, outside },
      oldPath,
      newPath,
      relocate
    }
  }

  it('builds every dependency of the move service', () => {
    for (const name of [
      'folders',
      'busy',
      'beforeMove',
      'afterAbort',
      'onRelocated',
      'syncWorktrees',
      'afterMove',
      'publishChanged',
      'log'
    ] as const) {
      expect(typeof deps[name]).toBe('function')
    }
    for (const port of [deps.db, deps.fs, deps.git]) {
      for (const method of Object.values(port)) expect(typeof method).toBe('function')
    }
    expect(deps.homeDir).toBe(home)
    expect(homedir()).toBe(home)
    expect(db.getDbPath()).toBe(join(sandbox, 'db', 'state.sqlite'))
    expect(deps.db.getAllProjects()).toEqual(db.getAllProjects())
  })

  it('reads the dev folder from the database it was given, on every call', () => {
    const before = db.getSetting(DEV_FOLDER_SETTING_KEY)
    try {
      db.setSetting(
        DEV_FOLDER_SETTING_KEY,
        serializeStoredDevFolder({ path: null, previousPaths: [] })
      )
      expect(deps.folders()).toEqual({
        devFolder: join(home, 'hive-projects'),
        previousFolders: []
      })

      mkdirSync(join(sandbox, 'folders', 'dev'), { recursive: true })
      mkdirSync(join(sandbox, 'folders', 'before'), { recursive: true })
      db.setSetting(
        DEV_FOLDER_SETTING_KEY,
        serializeStoredDevFolder({
          path: join(sandbox, 'folders', 'dev'),
          previousPaths: [join(sandbox, 'folders', 'before')]
        })
      )
      expect(deps.folders()).toEqual({
        devFolder: join(sandbox, 'folders', 'dev'),
        previousFolders: [join(sandbox, 'folders', 'before')]
      })
    } finally {
      if (before === null) db.deleteSetting(DEV_FOLDER_SETTING_KEY)
      else db.setSetting(DEV_FOLDER_SETTING_KEY, before)
    }
  })

  it('sends what the service logs to the app log', () => {
    doubles.logger.info.mockClear()

    deps.log?.('dev folder: a note', { projectId: 'p' })

    expect(doubles.logger.info).toHaveBeenCalledWith('dev folder: a note', { projectId: 'p' })
  })

  it('repoints links, the port and the board in onRelocated, in one synchronous call', async () => {
    const fixture = await makeFixture('relocated')
    const invalidate = vi.spyOn(app.boards, 'invalidate')
    const moved = fixture.relocate()

    const warnings = deps.onRelocated(moved)

    // Checked right after the call returned, with nothing awaited in between.
    expect(warnings).toEqual([])
    expect(readlinkSync(join(fixture.connectionFolder, fixture.linkName))).toBe(fixture.newPath)
    expect(readlinkSync(join(fixture.connectionProject.path, fixture.linkName))).toBe(
      fixture.newPath
    )
    const ports = readJson(portRegistryPath)
    expect(typeof ports[fixture.newPath]).toBe('number')
    expect(ports[fixture.oldPath]).toBeUndefined()
    expect(invalidate.mock.calls.map(([id]) => id).sort()).toEqual(
      [fixture.project.id, fixture.connectionProject.id].sort()
    )
    invalidate.mockRestore()

    // A second run (a start after a quit runs the steps again) changes nothing.
    expect(deps.onRelocated(moved)).toEqual([])
    expect(readlinkSync(join(fixture.connectionFolder, fixture.linkName))).toBe(fixture.newPath)
    expect(readJson(portRegistryPath)[fixture.newPath]).toBe(ports[fixture.newPath])
  })

  it('files the open terminals of the folders that moved under their new place in onRelocated', async () => {
    const { ptyService } = await import('../../pty-service')
    const refile = vi.spyOn(ptyService, 'refileMovedFolders')
    const fixture = await makeFixture('terminals')
    const moved = fixture.relocate()

    expect(deps.onRelocated(moved)).toEqual([])

    // Every spelling of every folder that moved: a terminal is filed under the path it was
    // opened with, which may be either.
    expect(refile).toHaveBeenCalledTimes(1)
    expect(refile).toHaveBeenCalledWith(moved.moves)

    // A registry that fails costs the move nothing: the folder has moved all the same.
    refile.mockImplementationOnce(() => {
      throw new Error('registry gone')
    })
    expect(deps.onRelocated(moved)).toEqual([])
    refile.mockRestore()
  })

  it("carries Claude's state, the instruction files and the watches over in afterMove", async () => {
    const fixture = await makeFixture('after')
    const moved = fixture.relocate()
    expect(deps.onRelocated(moved)).toEqual([])
    const oldHistory = join(claudeProjectsDir, app.encodePath(fixture.oldPath))
    const newHistory = join(claudeProjectsDir, app.encodePath(fixture.newPath))
    // The neighbour's folder name starts the same; its history must stay where it is.
    const neighbourHistory = join(claudeProjectsDir, app.encodePath(fixture.neighbour.path))
    mkdirSync(neighbourHistory, { recursive: true })
    writeFileSync(join(neighbourHistory, 'theirs.jsonl'), '{}\n')

    const warnings = await deps.afterMove(moved)

    expect(warnings).toEqual([])
    expect(existsSync(join(newHistory, 'session.jsonl'))).toBe(true)
    expect(existsSync(oldHistory)).toBe(false)
    expect(existsSync(join(neighbourHistory, 'theirs.jsonl'))).toBe(true)

    const config = readJson(claudeConfigPath)
    const projects = config.projects as Record<string, unknown>
    expect(projects[fixture.newPath]).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ['after']
    })
    expect(projects[fixture.oldPath]).toBeUndefined()
    expect(config.oauth).toBe('kept')

    for (const folder of [fixture.connectionFolder, fixture.connectionProject.path]) {
      for (const file of ['AGENTS.md', 'CLAUDE.md']) {
        const text = readFileSync(join(folder, file), 'utf8')
        expect(text).toContain(`**Real path:** ${fixture.newPath}\n`)
        expect(text).not.toContain(`**Real path:** ${fixture.oldPath}\n`)
      }
    }

    // The boards of the project and of the connection project are watched again.
    expect(doubles.restartBoardWatch.mock.calls.map(([id]) => id).sort()).toEqual(
      [fixture.project.id, fixture.connectionProject.id].sort()
    )
    // Only the worktree that stayed where it was has its git watches looked at again.
    expect(doubles.rebindBranchWatch.mock.calls).toEqual([[fixture.worktrees.outside.path]])
    expect(doubles.rebindWorktreeGitWatch.mock.calls).toEqual([[fixture.worktrees.outside.path]])

    // Safe to run twice.
    expect(await deps.afterMove(moved)).toEqual([])
    expect(existsSync(join(newHistory, 'session.jsonl'))).toBe(true)
    expect(
      (readJson(claudeConfigPath).projects as Record<string, unknown>)[fixture.newPath]
    ).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['after'] })
  })

  it("drops Claude's entry of the old folder even while an old copy is still on disk", async () => {
    const fixture = await makeFixture('copied')
    const moved = fixture.relocate()
    expect(deps.onRelocated(moved)).toEqual([])
    // A move to another disk: the old copy is still there when the follow-up steps run.
    mkdirSync(fixture.oldPath, { recursive: true })

    expect(await deps.afterMove(moved)).toEqual([])

    const projects = readJson(claudeConfigPath).projects as Record<string, unknown>
    expect(projects[fixture.newPath]).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ['copied']
    })
    expect(projects[fixture.oldPath]).toBeUndefined()
    expect(doubles.moveFolderEntry.mock.calls).toEqual(
      moved.moves.map((move) => [claudeConfigPath, move.from, move.to, { removeOld: 'always' }])
    )
  })

  describe('data projects whose database file is inside the folder that moved', () => {
    const dataProject = (
      name: string,
      engine: 'sqlite' | 'postgres',
      config: Record<string, unknown>
    ): { id: string; name: string } =>
      db.createDataProject({
        name,
        engine,
        config,
        icon: null,
        iconColor: null,
        environment: 'development',
        color: null,
        safeMode: 'half-safe',
        defaultLimit: 1000,
        allowAiDataAccess: false,
        pinned: false,
        secretCiphertext: null,
        secretState: 'none'
      })

    it('closes the connection of a SQLite one first, and leaves a server connection alone', async () => {
      const fixture = await makeFixture('data')
      const sqlite = dataProject('data-shop', 'sqlite', {
        filePath: join(fixture.oldPath, 'data', 'shop.sqlite')
      })
      // Only the certificate of this one is in the folder: its session holds no path.
      const postgres = dataProject('data-pg', 'postgres', {
        host: '127.0.0.1',
        database: 'shop',
        ssl: { mode: 'verify-ca', caPath: join(fixture.oldPath, 'certs', 'ca.pem') }
      })
      const elsewhere = dataProject('data-elsewhere', 'sqlite', {
        filePath: join(fixture.root, 'elsewhere.sqlite')
      })
      const moved = fixture.relocate()
      expect([...moved.dataProjectIds].sort()).toEqual([sqlite.id, postgres.id].sort())
      expect(db.getDataProject(sqlite.id)?.config.filePath).toBe(
        join(fixture.newPath, 'data', 'shop.sqlite')
      )
      expect(deps.onRelocated(moved)).toEqual([])
      const oldHistory = join(claudeProjectsDir, app.encodePath(fixture.oldPath))
      const historyStillInOldPlace: boolean[] = []
      doubles.invalidateDataEngine.mockImplementation(async () => {
        historyStillInOldPlace.push(existsSync(oldHistory))
      })

      const warnings = await deps.afterMove({
        ...moved,
        dataProjectIds: [...moved.dataProjectIds, elsewhere.id, 'no-such-data-project']
      })

      expect(warnings).toEqual([])
      // Asked for by the ids the move reports: a SQLite project among them is closed whatever
      // its file path, one that is gone or connects to a server is not.
      expect(doubles.invalidateDataEngine.mock.calls.map(([id]) => id).sort()).toEqual(
        [sqlite.id, elsewhere.id].sort()
      )
      // Before any other step of afterMove had run.
      expect(historyStillInOldPlace).toEqual([true, true])
      expect(existsSync(oldHistory)).toBe(false)
    })

    it('says which data project may still be connected when closing fails, and goes on', async () => {
      const fixture = await makeFixture('data-fails')
      const sqlite = dataProject('data-orders', 'sqlite', {
        filePath: join(fixture.oldPath, 'orders.sqlite')
      })
      const moved = fixture.relocate()
      expect(moved.dataProjectIds).toEqual([sqlite.id])
      expect(deps.onRelocated(moved)).toEqual([])
      doubles.invalidateDataEngine.mockRejectedValue(new Error('the worker did not stop.'))

      const warnings = await deps.afterMove(moved)

      expect(warnings).toEqual([
        'The data project "data-orders" may still be connected to its database file in the old folder: the worker did not stop. Disconnect it, then connect again.'
      ])
      // The steps after it ran all the same.
      expect(
        existsSync(join(claudeProjectsDir, app.encodePath(fixture.newPath), 'session.jsonl'))
      ).toBe(true)
      expect(doubles.restartBoardWatch).toHaveBeenCalledWith(fixture.project.id)
    })

    it('does not ask the engine when no data project is in the folder', async () => {
      const fixture = await makeFixture('data-none')
      const moved = fixture.relocate()
      expect(moved.dataProjectIds).toEqual([])
      expect(deps.onRelocated(moved)).toEqual([])

      expect(await deps.afterMove(moved)).toEqual([])

      expect(doubles.invalidateDataEngine).not.toHaveBeenCalled()
    })
  })

  it('reads again and watches again the boards of other projects whose row the move rewrote', async () => {
    const fixture = await makeFixture('other-boards')
    const invalidate = vi.spyOn(app.boards, 'invalidate')
    // The neighbour stands for a project that keeps its board in a folder of this one. The
    // connection project is listed twice: once as a project above, once as a rewritten row.
    const moved: MovedProject = {
      ...fixture.relocate(),
      otherProjectIds: [fixture.neighbour.id, fixture.connectionProject.id, fixture.neighbour.id]
    }
    const everyBoard = [
      fixture.project.id,
      fixture.connectionProject.id,
      fixture.neighbour.id
    ].sort()

    try {
      expect(deps.onRelocated(moved)).toEqual([])
      expect(invalidate.mock.calls.map(([id]) => id).sort()).toEqual(everyBoard)
    } finally {
      invalidate.mockRestore()
    }

    expect(await deps.afterMove(moved)).toEqual([])
    expect(doubles.restartBoardWatch.mock.calls.map(([id]) => id).sort()).toEqual(everyBoard)

    // They are not known before the move: nothing of theirs is stopped then.
    doubles.stopBoardWatch.mockClear()
    await deps.beforeMove(fixture.project)
    expect(doubles.stopBoardWatch.mock.calls.map(([id]) => id).sort()).toEqual(
      [fixture.project.id, fixture.connectionProject.id].sort()
    )
    await deps.afterAbort(fixture.project)
  })

  it.skipIf(isRoot)(
    'keeps the board watch of a connection project stopped while its link is broken',
    async () => {
      const fixture = await makeFixture('broken')
      const moved = fixture.relocate()
      // The link in the connection project's folder cannot be replaced.
      chmodSync(fixture.connectionProject.path, 0o555)
      try {
        const relocatedWarnings = deps.onRelocated(moved)

        expect(relocatedWarnings).toHaveLength(1)
        expect(relocatedWarnings[0]).toContain(
          join(fixture.connectionProject.path, fixture.linkName)
        )
        expect(readlinkSync(join(fixture.connectionProject.path, fixture.linkName))).toBe(
          fixture.oldPath
        )
        // The connection itself was relinked.
        expect(readlinkSync(join(fixture.connectionFolder, fixture.linkName))).toBe(fixture.newPath)

        const warnings = await deps.afterMove(moved)

        expect(warnings).toContain(
          `The board of the connection project "${fixture.connectionProject.name}" is not watched for changes while its link to this project is broken. Fix the link, then open that board again.`
        )
        expect(doubles.restartBoardWatch.mock.calls.map(([id]) => id)).toEqual([fixture.project.id])
      } finally {
        chmodSync(fixture.connectionProject.path, 0o755)
      }

      // Once the link can be replaced again, the next run does it and watches the board again.
      doubles.restartBoardWatch.mockClear()
      expect(deps.onRelocated(moved)).toEqual([])
      await deps.afterMove(moved)
      expect(doubles.restartBoardWatch.mock.calls.map(([id]) => id).sort()).toEqual(
        [fixture.project.id, fixture.connectionProject.id].sort()
      )
    }
  )

  it('stops and restarts the board watches of the project and of the connection projects above it', async () => {
    const fixture = await makeFixture('boards')
    const ids = [fixture.project.id, fixture.connectionProject.id].sort()

    await expect(deps.beforeMove(fixture.project)).resolves.toBeUndefined()
    expect(doubles.stopBoardWatch.mock.calls.map(([id]) => id).sort()).toEqual(ids)
    expect(doubles.restartBoardWatch).not.toHaveBeenCalled()

    await expect(deps.afterAbort(fixture.project)).resolves.toBeUndefined()
    expect(doubles.restartBoardWatch.mock.calls.map(([id]) => id).sort()).toEqual(ids)
  })

  it('publishes one event per kind of row the move changed', async () => {
    const fixture = await makeFixture('events')
    const moved = fixture.relocate()
    takeDbChanged()

    deps.publishChanged(moved)

    const events = takeDbChanged()
    const { id } = fixture.project
    expect(events).toEqual(
      expect.arrayContaining([
        { entity: 'project', op: 'update', id, projectId: id },
        { entity: 'worktree', op: 'batch', id: null, projectId: id },
        { entity: 'connection', op: 'batch', id: null, projectId: null },
        { entity: 'ticket', op: 'batch', id: null, projectId: id },
        { entity: 'ticket', op: 'batch', id: null, projectId: fixture.connectionProject.id }
      ])
    )
    expect(events.filter((event) => event.entity === 'dataProject')).toEqual([])
    // No run was rewritten: nothing on the document-flow channel.
    expect(otherEvents).not.toHaveBeenCalled()
  })

  it('also announces other projects, data projects and document runs when the move touched them', async () => {
    const fixture = await makeFixture('more-events')
    const run = db.createDocumentRun({
      id: 'run-more-events',
      project_id: fixture.project.id,
      title: 'Checkout',
      source_path: join(fixture.oldPath, 'spec.md'),
      run_dir: join(sandbox, 'runs', 'run-more-events'),
      status: 'completed',
      config: DEFAULT_DOCUMENT_RUN_CONFIG
    })
    const moved: MovedProject = {
      ...fixture.relocate(),
      otherProjectIds: [fixture.neighbour.id],
      dataProjectIds: ['data-1'],
      runsRewritten: 1
    }
    takeDbChanged()

    deps.publishChanged(moved)

    expect(takeDbChanged()).toEqual(
      expect.arrayContaining([
        {
          entity: 'project',
          op: 'update',
          id: fixture.neighbour.id,
          projectId: fixture.neighbour.id
        },
        { entity: 'dataProject', op: 'update', id: 'data-1', projectId: null }
      ])
    )
    expect(otherEvents.mock.calls).toEqual([
      ['documentFlow:updated', { runId: run.id, projectId: fixture.project.id, reason: 'run' }]
    ])

    // Without a publisher the runs are not announced, and nothing throws.
    app.setDevFolderMoveEventPublisher(null)
    otherEvents.mockClear()
    try {
      expect(() => deps.publishChanged(moved)).not.toThrow()
      expect(otherEvents).not.toHaveBeenCalled()
    } finally {
      app.setDevFolderMoveEventPublisher(otherEvents)
    }
  })

  it('announces the tickets of every project that had one rewritten', async () => {
    const fixture = await makeFixture('ticket-events')
    const moved: MovedProject = {
      ...fixture.relocate(),
      // The project itself and the connection project are covered already; the neighbour and
      // a project that is nowhere near are not.
      ticketProjectIds: [
        fixture.project.id,
        fixture.neighbour.id,
        fixture.connectionProject.id,
        'project-elsewhere',
        fixture.neighbour.id
      ]
    }
    takeDbChanged()

    deps.publishChanged(moved)

    const tickets = takeDbChanged().filter((event) => event.entity === 'ticket')
    expect(tickets.map((event) => event.projectId).sort()).toEqual(
      [
        fixture.project.id,
        fixture.connectionProject.id,
        fixture.neighbour.id,
        'project-elsewhere'
      ].sort()
    )
    for (const event of tickets) expect(event).toMatchObject({ op: 'batch', id: null })
  })

  it('announces the document runs the move names, of whichever project', async () => {
    const fixture = await makeFixture('run-events')
    const run = (id: string, projectId: string): string =>
      db.createDocumentRun({
        id,
        project_id: projectId,
        title: id,
        source_path: join(fixture.oldPath, 'spec.md'),
        run_dir: join(sandbox, 'runs', id),
        status: 'completed',
        config: DEFAULT_DOCUMENT_RUN_CONFIG
      }).id
    const own = run('run-events-own', fixture.project.id)
    const untouched = run('run-events-untouched', fixture.project.id)
    // A run of another project made from a file in this one.
    const foreign = run('run-events-foreign', fixture.neighbour.id)
    const relocated = fixture.relocate()
    const published = (): unknown[] => {
      const calls = otherEvents.mock.calls.map(([channel, payload]) => {
        expect(channel).toBe('documentFlow:updated')
        return payload
      })
      otherEvents.mockClear()
      return calls
    }

    deps.publishChanged({ ...relocated, runIds: [foreign, own, foreign, 'run-that-is-gone'] })

    expect(published()).toEqual([
      { runId: foreign, projectId: fixture.neighbour.id, reason: 'run' },
      { runId: own, projectId: fixture.project.id, reason: 'run' }
    ])

    // A move that names no run announces none, whatever it counted.
    deps.publishChanged({ ...relocated, runIds: [], runsRewritten: 3 })
    expect(published()).toEqual([])

    // One that does not say which runs changed falls back on the runs of the project.
    deps.publishChanged({ ...relocated, runIds: undefined, runsRewritten: 1 })
    expect(published()).toEqual(
      expect.arrayContaining([
        { runId: own, projectId: fixture.project.id, reason: 'run' },
        { runId: untouched, projectId: fixture.project.id, reason: 'run' }
      ])
    )
  })

  it('tells the worktree sync that it is the move asking', async () => {
    const fixture = await makeFixture('sync-flag')
    const params = { projectId: fixture.project.id, projectPath: fixture.oldPath }
    doubles.syncWorktrees.mockResolvedValueOnce({ success: true })

    await expect(deps.syncWorktrees(params)).resolves.toEqual({ success: true })

    expect(doubles.syncWorktrees).toHaveBeenCalledTimes(1)
    const [database, passedParams, internal] = doubles.syncWorktrees.mock.calls[0]
    expect(database).toBe(db)
    expect(passedParams).toEqual(params)
    expect(internal).toEqual({ forDevFolderMove: true })
  })

  it('never throws from publishChanged, even for a project that is gone', () => {
    const gone = {
      project: { id: 'no-such-project' },
      moves: [],
      worktrees: [],
      allWorktrees: [],
      otherProjectIds: [],
      dataProjectIds: [],
      runsRewritten: 1
    } as unknown as MovedProject

    expect(() => deps.publishChanged(gone)).not.toThrow()
  })

  it('reads what is running from the database, the window report and the agent list', async () => {
    const fixture = await makeFixture('busy')
    const worktrees = db.getWorktreesByProject(fixture.project.id)
    const ask = async (source: MoveProjectsDeps = deps): Promise<string | null> =>
      (await source.busy())(fixture.project, worktrees, [fixture.oldPath])

    expect(await ask()).toBeNull()

    // A session the window reports as running, in a connection that includes the project.
    const session = db.createSession({
      worktree_id: null,
      project_id: fixture.neighbour.id,
      connection_id: db
        .getAllConnections()
        .find((connection) => connection.path === fixture.connectionFolder)!.id,
      name: 'Refactor'
    })
    const reporting = await app.createLiveMoveProjectsDeps({
      db,
      homeDir: home,
      env: { ...process.env },
      activity: { runningSessionIds: () => [session.id, 'unknown-session'] }
    })
    expect(await ask(reporting)).toBe(
      'The session "Refactor" is working or waiting for an answer in a connection that includes this project. Wait for it to finish or stop it, then check again.'
    )
    expect(await ask()).toBeNull()

    // An agent CLI the desktop app has open in the project's folder.
    doubles.agentSnapshot = {
      supported: true,
      sessions: [
        {
          cwd: join(fixture.oldPath, 'src'),
          worktreePath: null,
          name: 'Fix login',
          agent: 'claude',
          stopping: false
        }
      ]
    }
    expect(await ask()).toMatch(/^The Claude Code session "Fix login" has a terminal open/)
    doubles.agentSnapshot = { supported: true, sessions: [], error: 'sampling failed' }
    expect(await ask()).toBe(
      'Could not check for open agent sessions: sampling failed. Check again.'
    )
    doubles.agentSnapshot = { supported: true, sessions: [] }

    // A document run that is paused in the project.
    const run = db.createDocumentRun({
      id: 'run-busy',
      project_id: fixture.project.id,
      title: 'Checkout',
      source_path: '',
      run_dir: join(sandbox, 'runs', 'run-busy'),
      status: 'paused',
      config: DEFAULT_DOCUMENT_RUN_CONFIG
    })
    expect(await ask()).toBe(
      'The orchestrator "Checkout" is paused in this project. Finish it or cancel it, then check again.'
    )
    db.updateDocumentRun(run.id, { status: 'cancelled' })
    expect(await ask()).toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'asks this process for its running bash runs',
    async () => {
      const [{ Effect }, { makeEventBus }, { makeLiveBashRpcService }] = await Promise.all([
        import('effect'),
        import('../../../../server/events/event-bus'),
        import('../../../../server/rpc/domains/bash')
      ])
      const fixture = await makeFixture('bash')
      const worktrees = db.getWorktreesByProject(fixture.project.id)
      const ask = async (): Promise<string | null> =>
        (await deps.busy())(fixture.project, worktrees, [fixture.oldPath])
      // A session of the connection over the project and its neighbour. The window does not
      // report it as working, and its commands run in the connection's folder, which is in
      // neither project: only the session says that the project is reached.
      const session = db.createSession({
        worktree_id: null,
        project_id: fixture.neighbour.id,
        connection_id: db
          .getAllConnections()
          .find((connection) => connection.path === fixture.connectionFolder)!.id,
        name: 'Dev server'
      })
      // What the server's `bash.run` does for `!sleep 30` typed into that session.
      const bash = makeLiveBashRpcService(makeEventBus())

      expect(await ask()).toBeNull()
      await Effect.runPromise(bash.run(session.id, 'sleep 30', fixture.connectionFolder))
      try {
        expect(await ask()).toBe(
          'The session "Dev server" is running a command in a connection that includes this project. Wait for the command to finish or stop it in that session, then check again.'
        )
      } finally {
        await Effect.runPromise(bash.abort(session.id))
      }
      // Stopped as the session's Stop button does: the project is free at the next reading.
      await vi.waitFor(async () => expect(await ask()).toBeNull(), { timeout: 10_000 })
    },
    30_000
  )

  it('moves a real repository with its worktrees through the service', async () => {
    const { moveProjectToDevFolder, planDevFolderMove } = await import('../move-projects')
    const root = join(sandbox, 'whole')
    const oldFolder = join(root, 'old')
    const devFolder = join(root, 'dev')
    const oldPath = join(oldFolder, 'svc')
    const newPath = join(devFolder, 'svc')
    const nestedOld = join(oldPath, '.claude', 'worktrees', 'nested')
    const siblingOld = join(oldFolder, 'svc-feature')
    const outsidePath = join(root, 'wt', 'svc-outside')
    mkdirSync(oldPath, { recursive: true })
    mkdirSync(devFolder)
    mkdirSync(join(root, 'wt'))
    git(oldPath, 'init', '-q', '-b', 'main')
    writeFileSync(join(oldPath, 'README.md'), 'svc\n')
    writeFileSync(join(oldPath, '.gitignore'), '.claude/\n')
    git(oldPath, 'add', '.')
    git(oldPath, 'commit', '-q', '-m', 'first')
    git(oldPath, 'worktree', 'add', '-q', '-b', 'nested', nestedOld)
    git(oldPath, 'worktree', 'add', '-q', '-b', 'feature', siblingOld)
    git(oldPath, 'worktree', 'add', '-q', '-b', 'outside', outsidePath)

    const project = db.createProject({ name: 'svc', path: oldPath })
    const row = (label: string, path: string, isDefault = false): Worktree =>
      db.createWorktree({
        project_id: project.id,
        name: label,
        branch_name: label,
        path,
        is_default: isDefault
      })
    const main = row('main', oldPath, true)
    const nested = row('nested', nestedOld)
    const sibling = row('feature', siblingOld)
    const outside = row('outside', outsidePath)
    // A row left over from a worktree that was removed outside the app. Only a sync that runs
    // in full retires it, and during a move only the move's own sync does.
    const leftover = row('leftover', join(root, 'wt', 'svc-leftover'))
    mkdirSync(join(claudeProjectsDir, app.encodePath(oldPath)), { recursive: true })
    writeFileSync(join(claudeProjectsDir, app.encodePath(oldPath), 'session.jsonl'), '{}\n')

    const settingBefore = db.getSetting(DEV_FOLDER_SETTING_KEY)
    db.setSetting(
      DEV_FOLDER_SETTING_KEY,
      serializeStoredDevFolder({ path: devFolder, previousPaths: [oldFolder] })
    )
    try {
      const plan = await planDevFolderMove(deps)
      expect(plan.candidates).toEqual([
        expect.objectContaining({ projectId: project.id, toPath: newPath, skipReason: null })
      ])
      takeDbChanged()

      const result = await moveProjectToDevFolder(
        { projectId: project.id, expectedToPath: newPath },
        deps
      )

      expect(result).toMatchObject({ action: 'moved', toPath: newPath, detail: null })
      expect(result.warnings).toEqual([])

      // The folders, and git's own view of them from every worktree.
      expect(existsSync(oldPath)).toBe(false)
      expect(existsSync(siblingOld)).toBe(false)
      const nestedNew = join(newPath, '.claude', 'worktrees', 'nested')
      const siblingNew = join(devFolder, 'svc-feature')
      const listed = git(newPath, 'worktree', 'list', '--porcelain')
      for (const path of [newPath, nestedNew, siblingNew, outsidePath]) {
        expect(listed).toContain(`worktree ${path}\n`)
        expect(git(path, 'status', '--porcelain')).toBe('')
      }
      expect(listed).not.toContain('prunable')

      // The rows: every worktree still active, at its place now.
      expect(db.getProject(project.id)?.path).toBe(newPath)
      const rows = new Map(db.getWorktreesByProject(project.id).map((entry) => [entry.id, entry]))
      expect(rows.get(main.id)).toMatchObject({ path: newPath, status: 'active' })
      expect(rows.get(nested.id)).toMatchObject({ path: nestedNew, status: 'active' })
      expect(rows.get(sibling.id)).toMatchObject({ path: siblingNew, status: 'active' })
      expect(rows.get(outside.id)).toMatchObject({ path: outsidePath, status: 'active' })
      expect(rows.get(leftover.id)).toMatchObject({ status: 'archived' })
      expect(rows.size).toBe(5)
      expect(db.readPendingDevFolderMove()).toBeNull()

      // What sits outside the database and git.
      expect(existsSync(join(claudeProjectsDir, app.encodePath(newPath), 'session.jsonl'))).toBe(
        true
      )
      expect(existsSync(join(claudeProjectsDir, app.encodePath(oldPath)))).toBe(false)
      expect(doubles.rebindBranchWatch.mock.calls).toEqual([[outsidePath]])
      expect(doubles.rebindWorktreeGitWatch.mock.calls).toEqual([[outsidePath]])
      expect(doubles.stopBoardWatch).toHaveBeenCalledWith(project.id)
      expect(doubles.restartBoardWatch).toHaveBeenCalledWith(project.id)
      expect(takeDbChanged()).toEqual(
        expect.arrayContaining([
          { entity: 'project', op: 'update', id: project.id, projectId: project.id },
          { entity: 'worktree', op: 'batch', id: null, projectId: project.id }
        ])
      )

      // Nothing is left to move.
      expect((await planDevFolderMove(deps)).candidates).toEqual([])
    } finally {
      if (settingBefore === null) db.deleteSetting(DEV_FOLDER_SETTING_KEY)
      else db.setSetting(DEV_FOLDER_SETTING_KEY, settingBefore)
    }
  }, 60_000)
})
