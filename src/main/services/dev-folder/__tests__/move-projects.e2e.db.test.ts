/**
 * "Move projects" from end to end: the move service on its live bindings, a real database, real
 * folders and real git, all inside one temp directory. Every part of the feature has tests of
 * its own against doubles of its neighbours; this file is where the parts meet.
 *
 * Real here: the database (a file in its own folder), the filesystem and git ports, the
 * settings functions, the connection, board, port and Claude follow-ups, the worktree sync and
 * the RPC handlers. One thing is replaced: the list of agent CLIs, which the real service asks
 * the desktop app for over this process's channel to its parent. Under the test runner that
 * parent is the runner, so the list is answered here (empty).
 *
 * The home directory, Claude's config directory and the database path are pointed into the
 * temp directory before anything is imported. Needs better-sqlite3 for the app's runtime:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     src/main/services/dev-folder/__tests__/move-projects.e2e.db.test.ts
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const sandboxed = await vi.hoisted(async () => {
  const { mkdirSync, mkdtempSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'hive-move-e2e-')))
  const home = join(sandbox, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  // The folder that holds the database is one of the app's own: a dev folder may not be in it.
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

vi.mock('../../../../server/rpc/domains/session-profiler-ops', async (importOriginal) => {
  const { Effect } = await import('effect')
  return {
    ...(await importOriginal<
      typeof import('../../../../server/rpc/domains/session-profiler-ops')
    >()),
    makeLiveSessionProfilerOpsRpcService: () => ({
      getSnapshot: () => Effect.sync(() => ({ supported: true, sessions: [] }))
    })
  }
})

import {
  DEV_FOLDER_RPC,
  DEV_FOLDER_SETTING_KEY,
  serializeStoredDevFolder,
  type DevFolderMovePlan,
  type DevFolderMoveResult,
  type DevFolderState,
  type SetDevFolderResult
} from '../../../../shared/types/dev-folder'
import type { RpcContext, RpcHandler } from '../../../../server/rpc/router'
import type { DatabaseService } from '../../../db'
import type { Project, Worktree } from '../../../db/types'
import { DEV_FOLDER_PENDING_MOVE_KEY, type MoveProjectsDeps } from '../types'

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

describeIf('moving projects to the dev folder, end to end', () => {
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
  const defaultDevFolder = join(home, 'hive-projects')
  const readJson = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

  let db: DatabaseService
  let deps: MoveProjectsDeps
  let app: {
    closeDatabase: () => void
    service: typeof import('../move-projects')
    settings: typeof import('../dev-folder-settings')
    live: typeof import('../live-deps')
    query: typeof import('../live-query-deps')
    fsPorts: typeof import('../fs-ports')
    gitPorts: typeof import('../git-ports')
    exclusive: typeof import('../exclusive')
    events: typeof import('../../db-change-events')
    settingsOps: typeof import('../../../../server/rpc/domains/settings-ops')
    connectionOps: typeof import('../../connection-ops')
    encodePath: (path: string) => string
    rpcContext: RpcContext
  }

  /** What the window reports as running: the ids in this list, read on every busy reading. */
  const runningSessions: string[] = []
  const activity = { runningSessionIds: (): readonly string[] => runningSessions }
  const dbChanged = vi.fn(async (_channel: string, _payload: unknown): Promise<void> => undefined)

  /** The move service bound to the app, as a process that has just started builds it. */
  const liveDeps = (): Promise<MoveProjectsDeps> =>
    app.live.createLiveMoveProjectsDeps({ db, homeDir: home, env: { ...process.env }, activity })

  /** The `db:changed` events published since the last call, without their time and origin. */
  const takeDbChanged = (): Record<string, unknown>[] => {
    app.events.flushPendingDbChangedEvents()
    const events = dbChanged.mock.calls.map(([, payload]) => {
      const { entity, op, id, projectId } = payload as Record<string, unknown>
      return { entity, op, id, projectId }
    })
    dbChanged.mockClear()
    return events
  }

  beforeAll(async () => {
    if (databaseLoadError) throw databaseLoadError
    const [
      dbModule,
      service,
      settings,
      live,
      query,
      fsPorts,
      gitPorts,
      exclusive,
      events,
      transcripts,
      ops,
      bus,
      connectionOps
    ] = await Promise.all([
      import('../../../db'),
      import('../move-projects'),
      import('../dev-folder-settings'),
      import('../live-deps'),
      import('../live-query-deps'),
      import('../fs-ports'),
      import('../git-ports'),
      import('../exclusive'),
      import('../../db-change-events'),
      import('../../claude-transcript-reader'),
      import('../../../../server/rpc/domains/settings-ops'),
      import('../../../../server/events/event-bus'),
      import('../../connection-ops')
    ])
    db = dbModule.getDatabase()
    app = {
      closeDatabase: dbModule.closeDatabase,
      service,
      settings,
      live,
      query,
      fsPorts,
      gitPorts,
      exclusive,
      events,
      settingsOps: ops,
      connectionOps,
      encodePath: transcripts.encodePath,
      rpcContext: { eventBus: bus.makeEventBus() }
    }
    app.events.setDbChangeEventPublisher(dbChanged)
    deps = await liveDeps()
  }, 120_000)

  afterAll(() => {
    app?.events.setDbChangeEventPublisher(null)
    app?.closeDatabase()
  })

  beforeEach(() => {
    runningSessions.length = 0
    takeDbChanged()
  })

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────

  /** The dev folder and the folders used before, written as the setting holds them. */
  const useFolders = (devFolder: string | null, previousFolders: string[]): void => {
    db.setSetting(
      DEV_FOLDER_SETTING_KEY,
      serializeStoredDevFolder({ path: devFolder, previousPaths: previousFolders })
    )
  }

  interface Folders {
    /** The folder used before, as the setting and the project rows spell it. */
    oldFolder: string
    /** Its real path: what git and the disk call it. */
    oldReal: string
    devFolder: string
  }

  /**
   * A folder used before and a dev folder for one scenario. With `throughSymlink`, the folder
   * used before is reached through a link, as a cloned project is stored when a folder above
   * it is one: the rows hold the spelled path, git and Claude the real one.
   */
  const makeFolders = (scenario: string, options: { throughSymlink?: boolean } = {}): Folders => {
    const root = join(sandbox, scenario)
    const devFolder = join(root, 'dev')
    mkdirSync(devFolder, { recursive: true })
    if (!options.throughSymlink) {
      const oldFolder = join(root, 'before')
      mkdirSync(oldFolder)
      return { oldFolder, oldReal: oldFolder, devFolder }
    }
    const oldReal = join(root, 'disk', 'before')
    const oldFolder = join(root, 'before')
    mkdirSync(oldReal, { recursive: true })
    symlinkSync(oldReal, oldFolder)
    return { oldFolder, oldReal, devFolder }
  }

  interface Repo {
    name: string
    project: Project
    /** `projects.path` before the move, and the real path of that folder. */
    fromPath: string
    fromReal: string
    /** Where the dev folder takes it. */
    toPath: string
    main: Worktree
    /** A linked worktree inside the checkout; its row holds git's spelling (the real path). */
    nested: { row: Worktree; from: string; to: string } | null
    /** A linked worktree next to the checkout; its row holds the spelled path. */
    sibling: { row: Worktree; from: string; fromReal: string; to: string } | null
    /** A linked worktree under ~/.hive-worktrees, which stays where it is. */
    outside: { row: Worktree; path: string } | null
  }

  /** A git repository registered as a project, with a commit and (asked for) three worktrees. */
  const makeRepo = (
    name: string,
    folders: Folders,
    options: { worktrees?: boolean; scripts?: boolean } = {}
  ): Repo => {
    const fromPath = join(folders.oldFolder, name)
    const fromReal = join(folders.oldReal, name)
    const toPath = join(folders.devFolder, name)
    mkdirSync(join(fromReal, 'docs'), { recursive: true })
    git(fromReal, 'init', '-q', '-b', 'main')
    writeFileSync(join(fromReal, 'README.md'), `${name}\n`)
    writeFileSync(join(fromReal, '.gitignore'), '.claude/\n')
    writeFileSync(join(fromReal, 'docs', 'spec.md'), '# spec\n')
    git(fromReal, 'add', '.')
    git(fromReal, 'commit', '-q', '-m', 'first')

    const project = db.createProject({
      name,
      path: fromPath,
      ...(options.scripts
        ? {
            setup_script: `cd ${fromPath} && ./bin/setup`,
            run_script: `${fromReal}/bin/dev --port 3000`
          }
        : {})
    })
    const row = (label: string, path: string, isDefault = false): Worktree =>
      db.createWorktree({
        project_id: project.id,
        name: label,
        branch_name: label,
        path,
        is_default: isDefault
      })
    const main = row('main', fromPath, true)
    const repo: Repo = {
      name,
      project,
      fromPath,
      fromReal,
      toPath,
      main,
      nested: null,
      sibling: null,
      outside: null
    }
    if (!options.worktrees) return repo

    const nestedFrom = join(fromReal, '.claude', 'worktrees', 'x')
    const siblingName = `${name}-teleport`
    const siblingReal = join(folders.oldReal, siblingName)
    const outsidePath = join(home, '.hive-worktrees', name, 'outside')
    mkdirSync(join(home, '.hive-worktrees', name), { recursive: true })
    git(fromReal, 'worktree', 'add', '-q', '-b', 'nested', nestedFrom)
    git(fromReal, 'worktree', 'add', '-q', '-b', 'teleport', siblingReal)
    git(fromReal, 'worktree', 'add', '-q', '-b', 'outside', outsidePath)
    return {
      ...repo,
      nested: {
        row: row('nested', nestedFrom),
        from: nestedFrom,
        to: join(toPath, '.claude', 'worktrees', 'x')
      },
      sibling: {
        row: row('teleport', join(folders.oldFolder, siblingName)),
        from: join(folders.oldFolder, siblingName),
        fromReal: siblingReal,
        to: join(folders.devFolder, siblingName)
      },
      outside: { row: row('outside', outsidePath), path: outsidePath }
    }
  }

  /** Every place the repository has a working tree once it has moved. */
  const placesAfter = (repo: Repo): string[] => [
    repo.toPath,
    ...(repo.nested ? [repo.nested.to] : []),
    ...(repo.sibling ? [repo.sibling.to] : []),
    ...(repo.outside ? [repo.outside.path] : [])
  ]

  /** Every place it has one while it has not. */
  const placesBefore = (repo: Repo): string[] => [
    repo.fromReal,
    ...(repo.nested ? [repo.nested.from] : []),
    ...(repo.sibling ? [repo.sibling.fromReal] : []),
    ...(repo.outside ? [repo.outside.path] : [])
  ]

  /** git lists every working tree at its place, none of them lost, and works in each. */
  const expectGitWorks = (checkout: string, places: readonly string[]): void => {
    const listed = git(checkout, 'worktree', 'list', '--porcelain')
    expect(listed).not.toContain('prunable')
    for (const place of places) {
      expect(listed).toContain(`worktree ${place}\n`)
      expect(git(place, 'status', '--porcelain')).toBe('')
      expect(git(place, 'log', '-1', '--format=%s').trim()).toBe('first')
    }
  }

  const worktreePaths = (projectId: string): Record<string, string> =>
    Object.fromEntries(
      db.getWorktreesByProject(projectId).map((row) => [row.name, `${row.status}:${row.path}`])
    )

  /** What a move that did not happen must leave exactly as it was. */
  const snapshot = (repo: Repo, folders: Folders): unknown => ({
    project: db.getProject(repo.project.id),
    worktrees: db.getWorktreesByProject(repo.project.id),
    pending: db.getSetting(DEV_FOLDER_PENDING_MOVE_KEY),
    inOldFolder: readdirSync(folders.oldReal).sort(),
    inDevFolder: readdirSync(folders.devFolder).sort(),
    checkout: readdirSync(repo.fromReal).sort(),
    head: git(repo.fromReal, 'rev-parse', 'HEAD'),
    status: git(repo.fromReal, 'status', '--porcelain')
  })

  const move = (
    repo: Repo,
    using: MoveProjectsDeps = deps,
    expectedToPath: string = repo.toPath
  ): Promise<DevFolderMoveResult> =>
    app.service.moveProjectToDevFolder({ projectId: repo.project.id, expectedToPath }, using)

  const byFrom = (paths: readonly { from: string; to: string }[]): { from: string; to: string }[] =>
    [...paths].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))

  // ── a ───────────────────────────────────────────────────────────────────────────────────

  it('a. moves a project with worktrees inside, next to and outside its checkout', async () => {
    const folders = makeFolders('a', { throughSymlink: true })
    const repo = makeRepo('a-app', folders, { worktrees: true, scripts: true })
    const { nested, sibling, outside } = repo
    if (!nested || !sibling || !outside) throw new Error('the fixture has no worktrees')
    const ticket = db.createKanbanTicket({
      project_id: repo.project.id,
      title: 'Read the spec',
      description: `The spec is at ${repo.fromPath}/docs/spec.md (see also ${repo.fromReal}/README.md).`,
      attachments: [{ type: 'file', url: join(repo.fromPath, 'docs', 'spec.md'), label: 'spec.md' }]
    })
    // Claude names a history folder and a settings entry after the real path of the folder.
    const history = join(claudeProjectsDir, app.encodePath(repo.fromReal))
    mkdirSync(history, { recursive: true })
    writeFileSync(
      join(history, 'session.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: repo.fromReal })}\n`
    )
    const trust = { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'] }
    writeFileSync(
      claudeConfigPath,
      JSON.stringify({ oauthAccount: 'kept', projects: { [repo.fromReal]: trust } }, null, 2)
    )
    writeFileSync(portRegistryPath, JSON.stringify({ [repo.fromPath]: 3555 }))
    // A connection over this project and one that stays where it is: a folder under the home
    // directory with a link to each, and instruction files that name where the links lead.
    const libPath = join(sandbox, 'a', 'elsewhere', 'a-lib')
    mkdirSync(libPath, { recursive: true })
    const lib = db.createProject({ name: 'a-lib', path: libPath })
    const libMain = db.createWorktree({
      project_id: lib.id,
      name: 'main',
      branch_name: 'main',
      path: libPath,
      is_default: true
    })
    const created = await app.connectionOps.createConnectionOp(db, [repo.main.id, libMain.id])
    const connection = created.connection
    if (!connection) throw new Error(`no connection: ${created.error}`)
    expect(connection.path.startsWith(home)).toBe(true)
    const linkName = connection.members.find(
      (member) => member.project_id === repo.project.id
    )?.symlink_name
    if (!linkName) throw new Error('the connection has no link to the project')
    expect(readlinkSync(join(connection.path, linkName))).toBe(repo.fromPath)
    useFolders(folders.devFolder, [folders.oldFolder])

    const plan = await app.service.planDevFolderMove(deps)
    expect(plan).toEqual({
      devFolder: folders.devFolder,
      sources: [folders.oldFolder],
      candidates: [
        {
          projectId: repo.project.id,
          projectName: 'a-app',
          source: folders.oldFolder,
          fromPath: repo.fromPath,
          toPath: repo.toPath,
          skipReason: null,
          detail: null
        }
      ]
    })
    takeDbChanged()

    const result = await move(repo, deps, plan.candidates[0].toPath)

    expect(result).toMatchObject({
      projectId: repo.project.id,
      projectName: 'a-app',
      action: 'moved',
      fromPath: repo.fromPath,
      toPath: repo.toPath,
      skipReason: null,
      detail: null
    })
    expect(result.warnings).toEqual([])
    // What the window re-keys with: the spellings the rows held, never git's.
    expect(byFrom(result.movedPaths)).toEqual(
      byFrom([
        { from: repo.fromPath, to: repo.toPath },
        { from: nested.from, to: nested.to },
        { from: sibling.from, to: sibling.to }
      ])
    )

    // The disk: the checkout and the worktree next to it are in the dev folder, the worktree
    // inside the checkout went with it, the one under ~/.hive-worktrees stayed.
    expect(readdirSync(folders.oldReal)).toEqual([])
    expect(readdirSync(folders.devFolder).sort()).toEqual(['a-app', 'a-app-teleport'])
    expect(readFileSync(join(repo.toPath, 'docs', 'spec.md'), 'utf8')).toBe('# spec\n')
    expect(existsSync(join(nested.to, 'README.md'))).toBe(true)
    expect(existsSync(join(outside.path, 'README.md'))).toBe(true)

    // git, from every working tree; a commit from the one that did not move reaches the
    // repository in its new place.
    expectGitWorks(repo.toPath, placesAfter(repo))
    expect(git(nested.to, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('nested')
    expect(git(sibling.to, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('teleport')
    git(outside.path, 'commit', '-q', '--allow-empty', '-m', 'after the move')
    expect(git(repo.toPath, 'log', '-1', '--format=%s', 'outside').trim()).toBe('after the move')

    // The database.
    expect(db.getProject(repo.project.id)).toMatchObject({
      path: repo.toPath,
      setup_script: `cd ${repo.toPath} && ./bin/setup`,
      run_script: `${repo.toPath}/bin/dev --port 3000`
    })
    expect(worktreePaths(repo.project.id)).toEqual({
      main: `active:${repo.toPath}`,
      nested: `active:${nested.to}`,
      teleport: `active:${sibling.to}`,
      outside: `active:${outside.path}`
    })
    const ticketNow = db.getKanbanTicket(ticket.id)
    expect(ticketNow?.description).toBe(
      `The spec is at ${repo.toPath}/docs/spec.md (see also ${repo.toPath}/README.md).`
    )
    expect(ticketNow?.attachments).toEqual([
      { type: 'file', url: join(repo.toPath, 'docs', 'spec.md'), label: 'spec.md' }
    ])
    expect(db.getSetting(DEV_FOLDER_PENDING_MOVE_KEY)).toBeNull()
    expect(db.readPendingDevFolderMove()).toBeNull()

    // What is keyed by the folder outside the database.
    expect(existsSync(join(claudeProjectsDir, app.encodePath(repo.toPath), 'session.jsonl'))).toBe(
      true
    )
    expect(existsSync(history)).toBe(false)
    const config = readJson(claudeConfigPath)
    expect(config.oauthAccount).toBe('kept')
    expect(config.projects).toEqual({ [repo.toPath]: trust })
    expect(readJson(portRegistryPath)).toEqual({ [repo.toPath]: 3555 })
    // The connection: its link was repointed, and only then were its instruction files
    // written again, so they name the folder the link now leads to.
    expect(readlinkSync(join(connection.path, linkName))).toBe(repo.toPath)
    expect(readFileSync(join(connection.path, linkName, 'README.md'), 'utf8')).toBe('a-app\n')
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const text = readFileSync(join(connection.path, file), 'utf8')
      expect(text).toContain(`**Real path:** ${repo.toPath}\n`)
      expect(text).toContain(`**Real path:** ${libPath}\n`)
      expect(text).not.toContain(folders.oldFolder)
      expect(text).not.toContain(folders.oldReal)
    }

    // Other windows are told, once everything above was done.
    expect(takeDbChanged()).toEqual(
      expect.arrayContaining([
        { entity: 'project', op: 'update', id: repo.project.id, projectId: repo.project.id },
        { entity: 'worktree', op: 'batch', id: null, projectId: repo.project.id },
        { entity: 'ticket', op: 'batch', id: null, projectId: repo.project.id }
      ])
    )

    // Nothing is left to move.
    expect(app.service.countLeftBehind(deps)).toEqual({ count: 0, folders: [] })
    expect((await app.service.planDevFolderMove(deps)).candidates).toEqual([])
  }, 120_000)

  // ── b ───────────────────────────────────────────────────────────────────────────────────

  it('b. leaves a project whose name is taken in the dev folder', async () => {
    const folders = makeFolders('b')
    const repo = makeRepo('b-app', folders)
    mkdirSync(repo.toPath)
    writeFileSync(join(repo.toPath, 'theirs.txt'), 'not ours\n')
    useFolders(folders.devFolder, [folders.oldFolder])
    const before = snapshot(repo, folders)
    const detail =
      'The dev folder already has a folder named b-app. Rename or move one of the two, then check again.'

    const plan = await app.service.planDevFolderMove(deps)
    expect(plan.candidates).toEqual([
      expect.objectContaining({ projectId: repo.project.id, skipReason: 'exists', detail })
    ])
    expect(app.service.countLeftBehind(deps)).toEqual({ count: 0, folders: [] })

    const result = await move(repo)

    expect(result).toEqual({
      projectId: repo.project.id,
      projectName: 'b-app',
      action: 'skipped',
      fromPath: repo.fromPath,
      toPath: repo.toPath,
      skipReason: 'exists',
      detail,
      warnings: [],
      movedPaths: []
    })
    expect(snapshot(repo, folders)).toEqual(before)
    expect(readdirSync(repo.toPath)).toEqual(['theirs.txt'])
    expectGitWorks(repo.fromReal, placesBefore(repo))
  }, 60_000)

  // ── c ───────────────────────────────────────────────────────────────────────────────────

  it('c. leaves a project while a session is working in it, or git is in the middle of a merge', async () => {
    const folders = makeFolders('c')
    const repo = makeRepo('c-app', folders, { worktrees: true })
    useFolders(folders.devFolder, [folders.oldFolder])
    const before = snapshot(repo, folders)
    const expectBusy = async (detail: string): Promise<void> => {
      const plan = await app.service.planDevFolderMove(deps)
      expect(plan.candidates).toEqual([
        expect.objectContaining({ projectId: repo.project.id, skipReason: 'busy', detail })
      ])
      const result = await move(repo)
      expect(result).toMatchObject({
        action: 'skipped',
        skipReason: 'busy',
        detail,
        toPath: repo.toPath,
        warnings: [],
        movedPaths: []
      })
    }

    // A session the window reports as working.
    const session = db.createSession({
      worktree_id: repo.main.id,
      project_id: repo.project.id,
      name: 'Refactor login'
    })
    runningSessions.push(session.id)
    await expectBusy(
      'The session "Refactor login" is working or waiting for an answer in this project. Wait for it to finish or stop it, then check again.'
    )
    runningSessions.length = 0
    expect(snapshot(repo, folders)).toEqual(before)

    // A merge that was started and not finished.
    const mergeHead = join(repo.fromReal, '.git', 'MERGE_HEAD')
    writeFileSync(mergeHead, git(repo.fromReal, 'rev-parse', 'HEAD'))
    await expectBusy(
      'A merge is in progress in this project. Finish it or wait for it to end, then check again.'
    )
    rmSync(mergeHead)
    expect(snapshot(repo, folders)).toEqual(before)
    expectGitWorks(repo.fromReal, placesBefore(repo))

    // With both gone, the same project moves.
    const result = await move(repo)
    expect(result).toMatchObject({ action: 'moved', warnings: [] })
    expectGitWorks(repo.toPath, placesAfter(repo))
  }, 120_000)

  // ── d ───────────────────────────────────────────────────────────────────────────────────

  it('d. refuses a destination other than the one the plan showed', async () => {
    const folders = makeFolders('d')
    const repo = makeRepo('d-app', folders)
    useFolders(folders.devFolder, [folders.oldFolder])
    const before = snapshot(repo, folders)

    const result = await move(repo, deps, join(sandbox, 'd', 'another-dev', 'd-app'))

    expect(result).toEqual({
      projectId: repo.project.id,
      projectName: 'd-app',
      action: 'skipped',
      fromPath: repo.fromPath,
      toPath: repo.toPath,
      skipReason: 'not-in-source',
      detail: 'The dev folder changed since this list was made. Check again.',
      warnings: [],
      movedPaths: []
    })
    expect(snapshot(repo, folders)).toEqual(before)
    expect(existsSync(join(sandbox, 'd', 'another-dev'))).toBe(false)
  }, 60_000)

  // ── e ───────────────────────────────────────────────────────────────────────────────────

  describe('e. to another volume', () => {
    /** The live bindings, with every folder taken for one on another volume: it is copied. */
    const onAnotherVolume = (): MoveProjectsDeps => ({
      ...deps,
      fs: app.fsPorts.createMoveProjectsFs({ isSameVolume: () => false })
    })

    it('copies the project, puts the copy in place and removes the old one', async () => {
      const folders = makeFolders('e1')
      const repo = makeRepo('e1-app', folders, { worktrees: true })
      useFolders(folders.devFolder, [folders.oldFolder])

      const result = await move(repo, onAnotherVolume())

      expect(result).toMatchObject({ action: 'moved', toPath: repo.toPath })
      expect(result.warnings).toEqual([])
      // The old copies are gone, and so is the hidden folder the new ones were built in.
      expect(readdirSync(folders.oldReal)).toEqual([])
      expect(readdirSync(folders.devFolder).sort()).toEqual(['e1-app', 'e1-app-teleport'])
      expectGitWorks(repo.toPath, placesAfter(repo))
      expect(db.getProject(repo.project.id)?.path).toBe(repo.toPath)
      expect(worktreePaths(repo.project.id)).toEqual({
        main: `active:${repo.toPath}`,
        nested: `active:${repo.nested?.to}`,
        teleport: `active:${repo.sibling?.to}`,
        outside: `active:${repo.outside?.path}`
      })
      expect(db.readPendingDevFolderMove()).toBeNull()
    }, 120_000)

    it('keeps the old copy when it was written to after the new one was put in place', async () => {
      const folders = makeFolders('e2')
      const repo = makeRepo('e2-app', folders)
      useFolders(folders.devFolder, [folders.oldFolder])
      const copying = onAnotherVolume()
      // Something still writes to the old folder between the new one going into place and the
      // old one being removed: the follow-up steps run in that time.
      const writtenLate: MoveProjectsDeps = {
        ...copying,
        afterMove: async (moved) => {
          writeFileSync(join(repo.fromReal, 'written-late.txt'), 'work done in the old folder\n')
          return copying.afterMove(moved)
        }
      }

      const result = await move(repo, writtenLate)

      expect(result).toMatchObject({ action: 'moved', toPath: repo.toPath })
      // The filesystem says in which folder of the old copy something differs.
      expect(result.warnings).toEqual([
        `The old copy is still at ${repo.fromPath}: it changed while the project was being moved (what changed is in the folder itself), compare it with the new one before deleting it.`
      ])
      expect(readFileSync(join(repo.fromReal, 'written-late.txt'), 'utf8')).toBe(
        'work done in the old folder\n'
      )
      expect(existsSync(join(repo.fromReal, 'README.md'))).toBe(true)
      expect(existsSync(join(repo.toPath, 'written-late.txt'))).toBe(false)
      expect(readdirSync(folders.devFolder)).toEqual(['e2-app'])
      expectGitWorks(repo.toPath, placesAfter(repo))
      expect(db.getProject(repo.project.id)?.path).toBe(repo.toPath)
      expect(db.readPendingDevFolderMove()).toBeNull()
    }, 120_000)
  })

  // ── f ───────────────────────────────────────────────────────────────────────────────────

  it('f. puts the folders back when the database refuses once they are in place', async () => {
    const folders = makeFolders('f')
    const repo = makeRepo('f-app', folders, { worktrees: true })
    useFolders(folders.devFolder, [folders.oldFolder])
    const before = snapshot(repo, folders)
    // The first write of the move's transaction is the project row, and it runs after the
    // folders were renamed. This makes that write fail the way a constraint does.
    const raw = db.getRawDb()
    raw.exec(
      `CREATE TEMP TRIGGER e2e_refuse_move BEFORE UPDATE OF path ON projects
         WHEN OLD.id = '${repo.project.id}'
       BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: projects.path'); END`
    )
    let result: DevFolderMoveResult
    try {
      result = await move(repo)
    } finally {
      raw.exec('DROP TRIGGER e2e_refuse_move')
    }

    expect(result).toEqual({
      projectId: repo.project.id,
      projectName: 'f-app',
      action: 'failed',
      fromPath: repo.fromPath,
      toPath: repo.toPath,
      skipReason: null,
      detail:
        'This project was not moved: UNIQUE constraint failed: projects.path. It is still in its old folder.',
      warnings: [],
      movedPaths: []
    })
    expect(snapshot(repo, folders)).toEqual(before)
    expect(readdirSync(folders.devFolder)).toEqual([])
    expectGitWorks(repo.fromReal, placesBefore(repo))

    // Nothing of the failed attempt is in the way of the next one.
    expect(await move(repo)).toMatchObject({ action: 'moved', warnings: [] })
    expectGitWorks(repo.toPath, placesAfter(repo))
  }, 120_000)

  // ── g ───────────────────────────────────────────────────────────────────────────────────

  describe('g. a move that a quit interrupted', () => {
    /**
     * Runs a move up to its first step after the commit and leaves it there for good, as a
     * process that quits does: the folders and the rows are in their new place, and nothing
     * that follows has run. The promise of that move never settles and is dropped.
     */
    const moveUntilQuit = async (
      repo: Repo,
      overrides: Partial<MoveProjectsDeps> = {}
    ): Promise<void> => {
      const stopped = { ...(await liveDeps()), ...overrides }
      let reached: () => void = () => undefined
      const atRepair = new Promise<void>((resolve) => {
        reached = resolve
      })
      void move(repo, {
        ...stopped,
        git: {
          ...stopped.git,
          repairWorktrees: () => {
            reached()
            return new Promise<void>(() => undefined)
          }
        }
      })
      await atRepair
    }

    const expectInterrupted = (repo: Repo): void => {
      expect(db.getProject(repo.project.id)?.path).toBe(repo.toPath)
      expect(db.readPendingDevFolderMove()).toMatchObject({
        projectId: repo.project.id,
        fromPath: repo.fromPath,
        toPath: repo.toPath
      })
      // Its worktrees still name the repository's old place.
      expect(() => git(repo.nested?.to ?? '', 'status', '--porcelain')).toThrow()
      expect(() => git(repo.outside?.path ?? '', 'status', '--porcelain')).toThrow()
    }

    const expectFinished = (repo: Repo, history: string): void => {
      expectGitWorks(repo.toPath, placesAfter(repo))
      expect(worktreePaths(repo.project.id)).toEqual({
        main: `active:${repo.toPath}`,
        nested: `active:${repo.nested?.to}`,
        teleport: `active:${repo.sibling?.to}`,
        outside: `active:${repo.outside?.path}`
      })
      expect(db.getSetting(DEV_FOLDER_PENDING_MOVE_KEY)).toBeNull()
      expect(existsSync(history)).toBe(false)
      expect(
        existsSync(join(claudeProjectsDir, app.encodePath(repo.toPath), 'session.jsonl'))
      ).toBe(true)
    }

    const seedHistory = (repo: Repo): string => {
      const history = join(claudeProjectsDir, app.encodePath(repo.fromReal))
      mkdirSync(history, { recursive: true })
      writeFileSync(join(history, 'session.jsonl'), '{}\n')
      return history
    }

    it('is finished by resumePendingDevFolderMove', async () => {
      const folders = makeFolders('g1', { throughSymlink: true })
      const repo = makeRepo('g1-app', folders, { worktrees: true })
      const history = seedHistory(repo)
      useFolders(folders.devFolder, [folders.oldFolder])

      await moveUntilQuit(repo)
      expectInterrupted(repo)

      // The next start, with bindings of its own.
      const restarted = await liveDeps()
      const logged: { message: string; detail?: Record<string, unknown> }[] = []
      await app.service.resumePendingDevFolderMove({
        ...restarted,
        log: (message, detail) => {
          logged.push({ message, detail })
        }
      })

      expectFinished(repo, history)
      expect(logged).toContainEqual({
        message: 'dev folder: finished the steps of an interrupted move',
        detail: { projectId: repo.project.id, toPath: repo.toPath, warnings: [] }
      })

      // With nothing owed, a second start reads the note and does nothing else.
      await app.service.resumePendingDevFolderMove(restarted)
      expectFinished(repo, history)
    }, 120_000)

    it('is finished by the step the server runs when it starts', async () => {
      const folders = makeFolders('g2')
      const repo = makeRepo('g2-app', folders, { worktrees: true })
      const history = seedHistory(repo)
      useFolders(folders.devFolder, [folders.oldFolder])

      await moveUntilQuit(repo)
      expectInterrupted(repo)

      await app.settingsOps.finishInterruptedDevFolderMove({ activity })

      expectFinished(repo, history)
    }, 120_000)

    // Not an interrupted move: a repair that fails is caught where it is asked for, the rest
    // of the steps run, and nothing is owed afterwards. What is left to do is said in words.
    it('is not what a failed repair leaves: that is a warning with the command to run', async () => {
      const folders = makeFolders('g3')
      const repo = makeRepo('g3-app', folders, { worktrees: true })
      const history = seedHistory(repo)
      useFolders(folders.devFolder, [folders.oldFolder])
      const places = [repo.nested?.to, repo.sibling?.to, repo.outside?.path]
      const refusing: MoveProjectsDeps = {
        ...deps,
        git: {
          ...deps.git,
          repairWorktrees: () => Promise.reject('fatal: unable to repair')
        }
      }

      const result = await move(repo, refusing)

      expect(result).toMatchObject({ action: 'moved', toPath: repo.toPath })
      expect(result.warnings).toHaveLength(1)
      const [warning] = result.warnings
      const lead =
        "Git could not re-link these worktrees to the project's new folder (fatal: unable to repair): "
      const advice = '. Run this in a terminal to fix them: '
      expect(warning.startsWith(lead)).toBe(true)
      const [named, command] = warning.slice(lead.length).split(advice)
      // Every worktree is named, in the order git lists them.
      expect(named.split(', ').sort()).toEqual([...places].sort())
      expect(command.startsWith(`git -C ${repo.toPath} worktree repair `)).toBe(true)
      expect(db.readPendingDevFolderMove()).toBeNull()
      expect(() => git(repo.nested?.to ?? '', 'status', '--porcelain')).toThrow()

      // Nothing pruned the worktrees git could not find: the command of the warning, run as
      // it is written, brings every one of them back.
      execFileSync('/bin/sh', ['-c', command], { env: GIT_ENV, stdio: 'pipe' })
      await app.service.resumePendingDevFolderMove(deps)
      expectFinished(repo, history)
    }, 120_000)

    /**
     * A move of a project one of whose worktrees lost its `.git` file, and what git answered to
     * the repair, as the move heard it. git exits with an error over that worktree after it
     * re-linked every other one it was handed.
     */
    const moveWithBrokenWorktree = async (
      repo: Repo,
      inside: boolean
    ): Promise<{ brokenTo: string; result: DevFolderMoveResult; complaint: string | null }> => {
      const brokenFrom = inside
        ? join(repo.fromReal, '.claude', 'worktrees', 'stale')
        : join(home, '.hive-worktrees', repo.name, 'stale')
      const brokenTo = inside ? join(repo.toPath, '.claude', 'worktrees', 'stale') : brokenFrom
      git(repo.fromReal, 'worktree', 'add', '-q', '-b', 'stale', brokenFrom)
      db.createWorktree({
        project_id: repo.project.id,
        name: 'stale',
        branch_name: 'stale',
        path: brokenFrom
      })
      rmSync(join(brokenFrom, '.git'))
      let complaint: string | null = null
      const listening: MoveProjectsDeps = {
        ...deps,
        git: {
          ...deps.git,
          repairWorktrees: async (repoPath, worktreePaths) => {
            try {
              await deps.git.repairWorktrees(repoPath, worktreePaths)
            } catch (error) {
              complaint = error instanceof Error ? error.message : String(error)
              throw error
            }
          }
        }
      }
      const result = await move(repo, listening)
      return { brokenTo, result, complaint }
    }

    // The worktree did not move, so the repository still finds its folder and writes the file
    // anew: git reports the error first and mends it afterwards. What git says is not what
    // decides, every worktree is looked at again after the repair.
    it('is not what a repair that complains and mends everything leaves either: nothing is said', async () => {
      const folders = makeFolders('g4')
      const repo = makeRepo('g4-app', folders, { worktrees: true })
      const history = seedHistory(repo)
      useFolders(folders.devFolder, [folders.oldFolder])

      const { brokenTo, result, complaint } = await moveWithBrokenWorktree(repo, false)

      expect(result).toMatchObject({ action: 'moved', toPath: repo.toPath })
      expect(complaint).toContain('.git file broken')
      expect(result.warnings).toEqual([])
      // The rows were brought up to date, which only happens once the links are known good.
      expectGitWorks(repo.toPath, [...placesAfter(repo), brokenTo])
      expect(worktreePaths(repo.project.id)).toEqual({
        main: `active:${repo.toPath}`,
        nested: `active:${repo.nested?.to}`,
        teleport: `active:${repo.sibling?.to}`,
        outside: `active:${repo.outside?.path}`,
        stale: `active:${brokenTo}`
      })
      expect(db.readPendingDevFolderMove()).toBeNull()
      expect(existsSync(history)).toBe(false)
    }, 120_000)

    // The worktree moved with the checkout: without its file nothing says which worktree of the
    // repository that folder is, and git cannot mend it. Only that one is named.
    it('names only the worktree that is still not linked after a repair that complains', async () => {
      const folders = makeFolders('g5')
      const repo = makeRepo('g5-app', folders, { worktrees: true })
      useFolders(folders.devFolder, [folders.oldFolder])

      const { brokenTo, result, complaint } = await moveWithBrokenWorktree(repo, true)

      expect(result).toMatchObject({ action: 'moved', toPath: repo.toPath })
      expect(complaint).toContain('.git file broken')
      expect(result.warnings).toEqual([
        `Git could not re-link this worktree to the project's new folder (${complaint}): ${brokenTo}. ` +
          `Run this in a terminal to fix it: git -C ${repo.toPath} worktree repair ${brokenTo}`
      ])
      // Every other worktree works from where it is now. The one git lost is still registered
      // (nothing pruned it), and the rows were left as they are.
      const listed = git(repo.toPath, 'worktree', 'list', '--porcelain')
      for (const place of placesAfter(repo)) {
        expect(listed).toContain(`worktree ${place}\n`)
        expect(git(place, 'status', '--porcelain')).toBe('')
      }
      expect(listed.match(/^prunable /gm)).toHaveLength(1)
      expect(listed).toMatch(
        /worktrees\/stale\nHEAD [0-9a-f]+\nbranch refs\/heads\/stale\nprunable /
      )
      expect(worktreePaths(repo.project.id)).toEqual({
        main: `active:${repo.toPath}`,
        nested: `active:${repo.nested?.to}`,
        teleport: `active:${repo.sibling?.to}`,
        outside: `active:${repo.outside?.path}`,
        stale: `active:${brokenTo}`
      })
      expect(db.readPendingDevFolderMove()).toBeNull()
    }, 120_000)

    it('waits for the moved folder when the disk that holds it is away at the next start', async () => {
      const folders = makeFolders('g6')
      const repo = makeRepo('g6-app', folders, { worktrees: true })
      const other = makeRepo('g6-other', folders)
      const history = seedHistory(repo)
      useFolders(folders.devFolder, [folders.oldFolder])

      await moveUntilQuit(repo)
      expectInterrupted(repo)

      // The next start, and the dev folder is on a disk that is not connected.
      const away = join(sandbox, 'g6', 'disk-not-connected')
      renameSync(folders.devFolder, away)
      const restarted = await liveDeps()
      const logged: { message: string; detail?: Record<string, unknown> }[] = []
      const start = (): Promise<void> =>
        app.service.resumePendingDevFolderMove({
          ...restarted,
          log: (message, detail) => {
            logged.push({ message, detail })
          }
        })
      await start()

      // Nothing ran against a folder that is not there, and what is owed is still written down.
      expect(logged).toEqual([
        {
          message:
            'dev folder: the folder of an interrupted move cannot be reached, its steps stay owed',
          detail: { projectId: repo.project.id, toPath: repo.toPath }
        }
      ])
      expect(db.readPendingDevFolderMove()).toMatchObject({
        projectId: repo.project.id,
        toPath: repo.toPath
      })
      expect(existsSync(history)).toBe(true)

      // No other project moves meanwhile: its move would write over that note.
      const detail = `The move of g6-app was interrupted and its folder ${repo.toPath} cannot be reached now. Reconnect the disk that holds it, or remove g6-app from Hive, then check again.`
      const blocked = await app.service.planDevFolderMove(restarted)
      expect(blocked.candidates).toEqual([
        expect.objectContaining({ projectId: other.project.id, skipReason: 'busy', detail })
      ])
      const before = snapshot(other, { ...folders, devFolder: away })
      expect(await move(other, restarted)).toMatchObject({
        action: 'skipped',
        skipReason: 'busy',
        detail,
        warnings: [],
        movedPaths: []
      })
      expect(snapshot(other, { ...folders, devFolder: away })).toEqual(before)
      expect(existsSync(folders.devFolder)).toBe(false)

      // The disk is connected again. The worktrees still name the repository's old place.
      renameSync(away, folders.devFolder)
      expectInterrupted(repo)
      const plan = await app.service.planDevFolderMove(restarted)
      expect(plan.candidates).toEqual([
        expect.objectContaining({ projectId: other.project.id, skipReason: null, detail: null })
      ])

      // The next move finishes what was owed before it begins, then moves its own project.
      const result = await move(other, restarted)

      expect(result).toMatchObject({ action: 'moved', toPath: other.toPath, warnings: [] })
      expectFinished(repo, history)
      expectGitWorks(other.toPath, [other.toPath])
      expect(db.getProject(other.project.id)?.path).toBe(other.toPath)
    }, 120_000)

    it('says where the old copies are when a move to another volume was interrupted', async () => {
      const folders = makeFolders('g7')
      const repo = makeRepo('g7-app', folders, { worktrees: true })
      const history = seedHistory(repo)
      useFolders(folders.devFolder, [folders.oldFolder])
      const { sibling } = repo
      if (!sibling) throw new Error('the fixture has no worktrees')

      // Every folder is taken for one on another volume: it is copied, and the old one stays
      // until the last step of the move, which this move never gets to.
      await moveUntilQuit(repo, {
        fs: app.fsPorts.createMoveProjectsFs({ isSameVolume: () => false })
      })
      expect(db.getProject(repo.project.id)?.path).toBe(repo.toPath)
      expect(db.readPendingDevFolderMove()).toMatchObject({
        projectId: repo.project.id,
        toPath: repo.toPath,
        copiedFrom: [repo.fromPath, sibling.from]
      })
      expect(readdirSync(folders.oldReal).sort()).toEqual(['g7-app', 'g7-app-teleport'])

      const restarted = await liveDeps()
      const logged: { message: string; detail?: Record<string, unknown> }[] = []
      await app.service.resumePendingDevFolderMove({
        ...restarted,
        log: (message, detail) => {
          logged.push({ message, detail })
        }
      })

      expect(logged).toContainEqual({
        message: 'dev folder: finished the steps of an interrupted move',
        detail: {
          projectId: repo.project.id,
          toPath: repo.toPath,
          warnings: [
            `An old copy of g7-app is still at ${repo.fromPath}: Hive quit before it was removed. The project is at ${repo.toPath} now. Compare the two, then delete the old copy yourself.`,
            `An old copy of the worktree g7-app-teleport of g7-app is still at ${sibling.from}: Hive quit before it was removed. The worktree is at ${sibling.to} now. Compare the two, then delete the old copy yourself.`
          ]
        }
      })
      // The project works from its new folder, and both old copies are as they were.
      expectFinished(repo, history)
      expect(readdirSync(folders.oldReal).sort()).toEqual(['g7-app', 'g7-app-teleport'])
      expect(readFileSync(join(repo.fromReal, 'README.md'), 'utf8')).toBe('g7-app\n')
      expect(existsSync(join(sibling.fromReal, 'README.md'))).toBe(true)
    }, 120_000)
  })

  // ── j ───────────────────────────────────────────────────────────────────────────────────

  // A disk that stopped answering leaves git waiting for it. The move does not wait with it:
  // git is stopped, the links are judged by what is on disk, and whatever was asked for next
  // gets its turn.
  it('j. is not held up by a git that does not return from the repair', async () => {
    const folders = makeFolders('j')
    const repo = makeRepo('j-app', folders, { worktrees: true })
    const next = makeRepo('j-next', folders)
    useFolders(folders.devFolder, [folders.oldFolder])
    // One worktree inside the checkout lost its `.git` file: nothing but git could say which
    // worktree of the repository that folder is.
    const lostFrom = join(repo.fromReal, '.claude', 'worktrees', 'lost')
    const lostTo = join(repo.toPath, '.claude', 'worktrees', 'lost')
    git(repo.fromReal, 'worktree', 'add', '-q', '-b', 'lost', lostFrom)
    rmSync(join(lostFrom, '.git'))

    // A `git` found before the real one: it stays in `worktree repair` far longer than the move
    // waits, does nothing there, and is the real one for everything else.
    const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
    const bin = join(sandbox, 'j', 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = repair ]; then exec sleep 20; fi\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 }
    )
    const pathBefore = process.env.PATH
    process.env.PATH = `${bin}:${pathBefore ?? ''}`
    let first: DevFolderMoveResult
    let second: DevFolderMoveResult
    const started = Date.now()
    try {
      const impatient: MoveProjectsDeps = {
        ...deps,
        git: app.gitPorts.createMoveProjectsGit({ timeoutMs: 3000 })
      }
      // Queued one behind the other, as the server queues what the window asks for.
      ;[first, second] = await Promise.all([
        app.exclusive.runDevFolderExclusive(() => move(repo, impatient)),
        app.exclusive.runDevFolderExclusive(() => move(next, impatient))
      ])
    } finally {
      if (pathBefore === undefined) delete process.env.PATH
      else process.env.PATH = pathBefore
    }

    expect(Date.now() - started).toBeLessThan(15_000)
    // The worktrees that moved or stayed were re-linked without git. Only the one nobody
    // could re-link is named, with what became of git.
    expect(first).toMatchObject({ action: 'moved', toPath: repo.toPath })
    expect(first.warnings).toEqual([
      `Git could not re-link this worktree to the project's new folder (git did not finish within 3 seconds and was stopped): ${lostTo}. ` +
        `Run this in a terminal to fix it: git -C ${repo.toPath} worktree repair ${lostTo}`
    ])
    for (const place of placesAfter(repo)) {
      expect(git(place, 'status', '--porcelain')).toBe('')
    }
    expect(db.getProject(repo.project.id)?.path).toBe(repo.toPath)
    // The move that waited behind it ran.
    expect(second).toMatchObject({ action: 'moved', toPath: next.toPath, warnings: [] })
    expect(db.readPendingDevFolderMove()).toBeNull()
  }, 120_000)

  // ── h ───────────────────────────────────────────────────────────────────────────────────

  it('h. changes the dev folder, moves what the default folder held, and forgets it once empty', async () => {
    const root = join(sandbox, 'h')
    const devB = join(root, 'dev-b')
    const devC = join(root, 'dev-c')
    mkdirSync(defaultDevFolder, { recursive: true })
    db.deleteSetting(DEV_FOLDER_SETTING_KEY)
    const repo = makeRepo('h-app', {
      oldFolder: defaultDevFolder,
      oldReal: defaultDevFolder,
      devFolder: devB
    })
    const { settings, service, query } = app
    const setDeps = settings.createLiveSetDevFolderDeps(db, { home, env: { ...process.env } })
    const count = (): { count: number; folders: string[] } =>
      service.countLeftBehind(query.createLiveMoveQueryDeps(db, { homeDir: home }))

    expect(settings.readDevFolderState(db, home)).toEqual({
      path: defaultDevFolder,
      isDefault: true,
      defaultPath: defaultDevFolder,
      exists: true,
      previousPaths: []
    })
    expect(count()).toEqual({ count: 0, folders: [] })

    // Default → B: the folder is created, and the default one becomes a folder used before.
    expect(settings.setDevFolder(devB, setDeps)).toEqual({ success: true })
    expect(settings.readDevFolderState(db, home)).toEqual({
      path: devB,
      isDefault: false,
      defaultPath: defaultDevFolder,
      exists: true,
      previousPaths: [defaultDevFolder]
    })
    expect(deps.folders()).toEqual({ devFolder: devB, previousFolders: [defaultDevFolder] })
    expect(count()).toEqual({ count: 1, folders: [defaultDevFolder] })

    const plan = await service.planDevFolderMove(deps)
    expect(plan).toEqual({
      devFolder: devB,
      sources: [defaultDevFolder],
      candidates: [
        {
          projectId: repo.project.id,
          projectName: 'h-app',
          source: defaultDevFolder,
          fromPath: repo.fromPath,
          toPath: join(devB, 'h-app'),
          skipReason: null,
          detail: null
        }
      ]
    })

    const result = await move(repo, deps, plan.candidates[0].toPath)
    expect(result).toMatchObject({ action: 'moved', toPath: join(devB, 'h-app'), warnings: [] })
    expectGitWorks(join(devB, 'h-app'), [join(devB, 'h-app')])
    expect(count()).toEqual({ count: 0, folders: [] })
    // Still remembered: a folder is only forgotten when the dev folder changes again.
    expect(settings.previousDevFolders(db, home)).toEqual([defaultDevFolder])

    // B → C: B was just left and is remembered; the default folder holds nothing and is not.
    expect(settings.setDevFolder(devC, setDeps)).toEqual({ success: true })
    expect(settings.readDevFolderState(db, home)).toEqual({
      path: devC,
      isDefault: false,
      defaultPath: defaultDevFolder,
      exists: true,
      previousPaths: [devB]
    })
    expect(count()).toEqual({ count: 1, folders: [devB] })

    // A dev folder inside a project is refused, and nothing is created for it.
    const inside = join(devB, 'h-app', 'nested-dev')
    expect(settings.setDevFolder(inside, setDeps)).toEqual({
      success: false,
      error: `The dev folder cannot be inside the project "h-app" (${join(devB, 'h-app')}).`
    })
    expect(existsSync(inside)).toBe(false)
    expect(settings.resolveDevFolder(db, home)).toBe(devC)
  }, 120_000)

  // ── The same, as the window asks for it ─────────────────────────────────────────────────

  it('i. answers the four calls of the window: get, set, plan and move', async () => {
    const root = join(sandbox, 'i')
    const devFolder = join(root, 'dev')
    mkdirSync(defaultDevFolder, { recursive: true })
    db.deleteSetting(DEV_FOLDER_SETTING_KEY)
    const repo = makeRepo(
      'i-app',
      { oldFolder: defaultDevFolder, oldReal: defaultDevFolder, devFolder },
      { worktrees: true }
    )
    // The live service as the server builds it: the process's own database, home directory
    // and environment, all of which point into the temp directory here.
    expect(homedir()).toBe(home)
    expect(db.getDbPath()).toBe(join(sandbox, 'db', 'state.sqlite'))
    const handlers: ReadonlyMap<string, RpcHandler> = app.settingsOps.makeSettingsOpsRpcHandlers(
      app.settingsOps.makeLiveSettingsOpsRpcService({ activity })
    )
    const call = <T>(method: string, params: unknown): Promise<T> => {
      const handler = handlers.get(method)
      if (!handler) throw new Error(`no handler for ${method}`)
      return Effect.runPromise(handler(params, app.rpcContext)) as Promise<T>
    }

    expect(await call<DevFolderState>(DEV_FOLDER_RPC.get, {})).toEqual({
      path: defaultDevFolder,
      isDefault: true,
      defaultPath: defaultDevFolder,
      exists: true,
      previousPaths: [],
      leftBehind: { count: 0, folders: [] }
    })

    const changed = await call<SetDevFolderResult>(DEV_FOLDER_RPC.set, { path: devFolder })
    expect(changed).toEqual({
      success: true,
      state: {
        path: devFolder,
        isDefault: false,
        defaultPath: defaultDevFolder,
        exists: true,
        previousPaths: [defaultDevFolder],
        leftBehind: { count: 1, folders: [defaultDevFolder] }
      }
    })

    const plan = await call<DevFolderMovePlan>(DEV_FOLDER_RPC.planMove, {})
    expect(plan.devFolder).toBe(devFolder)
    expect(plan.candidates).toEqual([
      expect.objectContaining({
        projectId: repo.project.id,
        source: defaultDevFolder,
        toPath: repo.toPath,
        skipReason: null
      })
    ])

    // The window sends the row's `toPath` back, and nothing else.
    const params = { projectId: repo.project.id, expectedToPath: plan.candidates[0].toPath }
    await expect(call(DEV_FOLDER_RPC.moveProject, { ...params, force: true })).rejects.toBeDefined()
    expect(db.getProject(repo.project.id)?.path).toBe(repo.fromPath)

    const result = await call<DevFolderMoveResult>(DEV_FOLDER_RPC.moveProject, params)
    expect(result).toMatchObject({
      projectId: repo.project.id,
      action: 'moved',
      toPath: repo.toPath,
      warnings: []
    })
    expectGitWorks(repo.toPath, placesAfter(repo))
    expect(db.getProject(repo.project.id)?.path).toBe(repo.toPath)

    expect((await call<DevFolderState>(DEV_FOLDER_RPC.get, {})).leftBehind).toEqual({
      count: 0,
      folders: []
    })
    // A second call for the same row finds the project where it now is.
    expect(await call<DevFolderMoveResult>(DEV_FOLDER_RPC.moveProject, params)).toMatchObject({
      action: 'skipped',
      skipReason: 'not-in-source'
    })

    const refused = await call<SetDevFolderResult>(DEV_FOLDER_RPC.set, { path: repo.toPath })
    expect(refused).toEqual({
      success: false,
      error: `The dev folder cannot be the folder of the project "i-app" (${repo.toPath}).`
    })
    expect(await call<SetDevFolderResult>(DEV_FOLDER_RPC.set, { path: null })).toMatchObject({
      success: true,
      state: { path: defaultDevFolder, isDefault: true, previousPaths: [devFolder] }
    })
  }, 120_000)
})
