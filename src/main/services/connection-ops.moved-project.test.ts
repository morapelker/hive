/**
 * What connection folders need after a member project moved on disk:
 * relinkConnectionSymlinksForMovedProject repoints the member links, and
 * regenerateConnectionInstructionsForProject rewrites AGENTS.md / CLAUDE.md. The last suite
 * covers addConnectionProjectMemberOp, which builds its member list with the same helper.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { DatabaseService } from '../db/database'
import type { Project, Worktree } from '../db/types'
import type { RelocationMove } from './dev-folder/types'
import {
  addConnectionProjectMemberOp,
  createConnectionOp,
  regenerateConnectionInstructionsForProject,
  relinkConnectionSymlinksForMovedProject,
  saveConnectionAsProjectOp
} from './connection-ops'

const sandboxes: string[] = []
const openDatabases: DatabaseService[] = []
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

/** Permission bits do not stop root, so the tests that rely on them are skipped for root. */
const isRoot = process.getuid?.() === 0

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

interface Fixture {
  db: DatabaseService
  /** A path as the app stored it: through `link`, a symlink to the folder everything is in. */
  stored: (...parts: string[]) => string
  /** The same path as git reports it: the real one. */
  real: (...parts: string[]) => string
  projectA: Project
  projectB: Project
  /** In no connection project. */
  projectC: Project
  /** Connections that have a worktree of project A: its checkout, a worktree inside it, one next to it, one elsewhere. */
  checkoutConnection: string
  nestedConnection: string
  siblingConnection: string
  outsideConnection: string
  /** A connection without project A. */
  unrelatedConnection: string
  /** The connection project saved from the checkout connection (members A and B), and its folder. */
  connectionProjectId: string
  connectionProject: string
  /** Rename the folders and point the rows at them, as a finished move leaves them. */
  move: () => RelocationMove[]
}

/**
 * Project A (`old/proja`) with a worktree inside it, one next to it (`old/proja-feature`) and
 * one elsewhere; projects B and C that stay put. A is stored through a symlinked parent, its
 * extra worktrees by real path, so both spellings of the old folder occur in link targets.
 */
const makeFixture = async (): Promise<Fixture> => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'hive-moved-project-')))
  sandboxes.push(sandbox)
  const home = join(sandbox, 'home')
  mkdirSync(home)
  vi.stubEnv('HOME', home)

  mkdirSync(join(sandbox, 'real'))
  symlinkSync(join(sandbox, 'real'), join(sandbox, 'link'), 'dir')
  const stored = (...parts: string[]): string => join(sandbox, 'link', ...parts)
  const real = (...parts: string[]): string => join(sandbox, 'real', ...parts)
  for (const dir of [
    real('old', 'proja', '.claude', 'worktrees', 'nested'),
    real('old', 'proja-feature'),
    real('old', 'proja-other'),
    real('new'),
    real('elsewhere', 'projb'),
    real('elsewhere', 'projc'),
    real('wt', 'proja-outside')
  ]) {
    mkdirSync(dir, { recursive: true })
  }

  const db = new DatabaseService(join(sandbox, 'state.sqlite'))
  db.init()
  openDatabases.push(db)

  const worktree = (project: Project, name: string, path: string, isDefault = false): Worktree =>
    db.createWorktree({
      project_id: project.id,
      name,
      branch_name: name,
      path,
      is_default: isDefault
    })

  const projectA = db.createProject({ name: 'proja', path: stored('old', 'proja') })
  const projectB = db.createProject({ name: 'projb', path: stored('elsewhere', 'projb') })
  const projectC = db.createProject({ name: 'projc', path: stored('elsewhere', 'projc') })
  const checkoutA = worktree(projectA, 'main', projectA.path, true)
  const nestedA = worktree(
    projectA,
    'nested',
    real('old', 'proja', '.claude', 'worktrees', 'nested')
  )
  const siblingA = worktree(projectA, 'feature', real('old', 'proja-feature'))
  const outsideA = worktree(projectA, 'outside', real('wt', 'proja-outside'))
  const checkoutB = worktree(projectB, 'main', projectB.path, true)
  const checkoutC = worktree(projectC, 'main', projectC.path, true)

  const connect = async (worktreeIds: string[]): Promise<string> => {
    const created = await createConnectionOp(db, worktreeIds)
    expect(created.success).toBe(true)
    return created.connection!.id
  }
  const checkoutConnectionId = await connect([checkoutA.id, checkoutB.id])
  const nestedConnectionId = await connect([nestedA.id, checkoutB.id])
  const siblingConnectionId = await connect([siblingA.id, checkoutB.id])
  const outsideConnectionId = await connect([outsideA.id, checkoutB.id])
  const unrelatedConnectionId = await connect([checkoutB.id, checkoutC.id])
  const saved = await saveConnectionAsProjectOp(db, checkoutConnectionId)
  expect(saved.success).toBe(true)

  // Every folder made above must be inside the stubbed home, never the real one.
  const folderOf = (connectionId: string): string => {
    const path = db.getConnection(connectionId)!.path
    expect(path.startsWith(home)).toBe(true)
    return path
  }
  expect(saved.project!.path.startsWith(home)).toBe(true)

  const move = (): RelocationMove[] => {
    renameSync(real('old', 'proja'), real('new', 'proja'))
    renameSync(real('old', 'proja-feature'), real('new', 'proja-feature'))
    const raw = db.getRawDb()
    raw.prepare('UPDATE projects SET path = ? WHERE id = ?').run(real('new', 'proja'), projectA.id)
    const repoint = raw.prepare('UPDATE worktrees SET path = ? WHERE id = ?')
    repoint.run(real('new', 'proja'), checkoutA.id)
    repoint.run(real('new', 'proja', '.claude', 'worktrees', 'nested'), nestedA.id)
    repoint.run(real('new', 'proja-feature'), siblingA.id)
    return [
      { from: [stored('old', 'proja'), real('old', 'proja')], to: real('new', 'proja') },
      {
        from: [stored('old', 'proja-feature'), real('old', 'proja-feature')],
        to: real('new', 'proja-feature')
      }
    ]
  }

  return {
    db,
    stored,
    real,
    projectA,
    projectB,
    projectC,
    checkoutConnection: folderOf(checkoutConnectionId),
    nestedConnection: folderOf(nestedConnectionId),
    siblingConnection: folderOf(siblingConnectionId),
    outsideConnection: folderOf(outsideConnectionId),
    unrelatedConnection: folderOf(unrelatedConnectionId),
    connectionProjectId: saved.project!.id,
    connectionProject: saved.project!.path,
    move
  }
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try {
      db.close()
    } catch {
      // Closed by the test.
    }
  }
  vi.unstubAllEnvs()
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true })
})

describeIf('relinkConnectionSymlinksForMovedProject', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  it('repoints every link into the moved folders and nothing else', async () => {
    const fixture = await makeFixture()
    const { db, stored, real, projectA, connectionProject } = fixture

    // The project is renamed after its links were made: the name a link would be given today
    // ("renamed-app") is no longer the name it has ("proja").
    db.updateProject(projectA.id, { name: 'Renamed App' })
    // Other things a connection project folder can hold. None of them is a link into project A.
    mkdirSync(join(connectionProject, 'renamed-app'))
    writeFileSync(join(connectionProject, 'renamed-app', 'keep.txt'), 'not a link')
    symlinkSync(join(real(), 'nowhere'), join(connectionProject, 'gone'), 'dir')
    symlinkSync(stored('old', 'proja-other'), join(connectionProject, 'neighbour'), 'dir')
    symlinkSync('proja', join(connectionProject, 'relative'), 'dir')
    // A link into project A in a connection that does not have project A as a member.
    symlinkSync(stored('old', 'proja'), join(fixture.unrelatedConnection, 'stray'), 'dir')
    const projectFolderBefore = readdirSync(connectionProject).sort()
    const agentsMdBefore = readFileSync(join(connectionProject, 'AGENTS.md'), 'utf8')

    const relocations = fixture.move()
    // Until they are repointed, the links into the project dangle.
    expect(existsSync(join(fixture.checkoutConnection, 'proja'))).toBe(false)

    const result = relinkConnectionSymlinksForMovedProject(db, projectA.id, relocations)

    expect(result).toEqual({ relinked: 4, warnings: [] })
    // Stored through the symlinked parent (the checkout), in a connection and in the project.
    expect(readlinkSync(join(fixture.checkoutConnection, 'proja'))).toBe(real('new', 'proja'))
    expect(readlinkSync(join(connectionProject, 'proja'))).toBe(real('new', 'proja'))
    // Stored by real path, under the checkout: the rest of the path is kept.
    expect(readlinkSync(join(fixture.nestedConnection, 'proja'))).toBe(
      real('new', 'proja', '.claude', 'worktrees', 'nested')
    )
    // The worktree next to the checkout moved as a folder of its own.
    expect(readlinkSync(join(fixture.siblingConnection, 'proja'))).toBe(
      real('new', 'proja-feature')
    )
    for (const folder of [
      fixture.checkoutConnection,
      fixture.nestedConnection,
      fixture.siblingConnection,
      connectionProject
    ]) {
      expect(isSymlink(join(folder, 'proja'))).toBe(true)
      expect(existsSync(join(folder, 'proja'))).toBe(true)
    }

    // Links to what did not move: the other member, the worktree elsewhere.
    expect(readlinkSync(join(fixture.checkoutConnection, 'projb'))).toBe(
      stored('elsewhere', 'projb')
    )
    expect(readlinkSync(join(connectionProject, 'projb'))).toBe(stored('elsewhere', 'projb'))
    expect(readlinkSync(join(fixture.outsideConnection, 'proja'))).toBe(real('wt', 'proja-outside'))

    // The connection project folder: same entries, the link kept its name, and what is not a
    // link into the project is as it was (the folder with the derived name included).
    expect(readdirSync(connectionProject).sort()).toEqual(projectFolderBefore)
    expect(lstatSync(join(connectionProject, 'renamed-app')).isDirectory()).toBe(true)
    expect(readFileSync(join(connectionProject, 'renamed-app', 'keep.txt'), 'utf8')).toBe(
      'not a link'
    )
    expect(readlinkSync(join(connectionProject, 'gone'))).toBe(join(real(), 'nowhere'))
    expect(readlinkSync(join(connectionProject, 'neighbour'))).toBe(stored('old', 'proja-other'))
    expect(readlinkSync(join(connectionProject, 'relative'))).toBe('proja')
    expect(readFileSync(join(connectionProject, 'AGENTS.md'), 'utf8')).toBe(agentsMdBefore)

    // A folder that does not have the project as a member is not looked at.
    expect(readlinkSync(join(fixture.unrelatedConnection, 'stray'))).toBe(stored('old', 'proja'))
  })

  it('changes nothing when it runs a second time', async () => {
    const fixture = await makeFixture()
    const relocations = fixture.move()
    const first = relinkConnectionSymlinksForMovedProject(
      fixture.db,
      fixture.projectA.id,
      relocations
    )
    expect(first).toEqual({ relinked: 4, warnings: [] })
    const linkBefore = lstatSync(join(fixture.checkoutConnection, 'proja'))

    const second = relinkConnectionSymlinksForMovedProject(
      fixture.db,
      fixture.projectA.id,
      relocations
    )

    expect(second).toEqual({ relinked: 0, warnings: [] })
    // The very same link: it was not removed and made again.
    expect(lstatSync(join(fixture.checkoutConnection, 'proja')).ino).toBe(linkBefore.ino)
    expect(readlinkSync(join(fixture.checkoutConnection, 'proja'))).toBe(
      fixture.real('new', 'proja')
    )
  })

  it('repoints only the links spelled the way the move names the old folder', async () => {
    const fixture = await makeFixture()
    const [checkout] = fixture.move()

    // Only the stored spelling of the checkout: the links made from git's real paths (the
    // nested and the sibling worktree) are not recognised, which is why a move passes both.
    const result = relinkConnectionSymlinksForMovedProject(fixture.db, fixture.projectA.id, [
      { from: [checkout.from[0]], to: checkout.to }
    ])

    expect(result).toEqual({ relinked: 2, warnings: [] })
    expect(readlinkSync(join(fixture.checkoutConnection, 'proja'))).toBe(
      fixture.real('new', 'proja')
    )
    expect(readlinkSync(join(fixture.nestedConnection, 'proja'))).toBe(
      fixture.real('old', 'proja', '.claude', 'worktrees', 'nested')
    )
    expect(readlinkSync(join(fixture.siblingConnection, 'proja'))).toBe(
      fixture.real('old', 'proja-feature')
    )
  })

  it('skips a connection whose folder is gone', async () => {
    const fixture = await makeFixture()
    const relocations = fixture.move()
    rmSync(fixture.nestedConnection, { recursive: true, force: true })

    const result = relinkConnectionSymlinksForMovedProject(
      fixture.db,
      fixture.projectA.id,
      relocations
    )

    expect(result).toEqual({ relinked: 3, warnings: [] })
    expect(existsSync(fixture.nestedConnection)).toBe(false)
  })

  it.skipIf(isRoot)('says which link it could not replace, and replaces the others', async () => {
    const fixture = await makeFixture()
    const relocations = fixture.move()
    // Entries of a folder that cannot be written cannot be removed.
    chmodSync(fixture.checkoutConnection, 0o555)

    try {
      const result = relinkConnectionSymlinksForMovedProject(
        fixture.db,
        fixture.projectA.id,
        relocations
      )

      expect(result.relinked).toBe(3)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain(join(fixture.checkoutConnection, 'proja'))
      expect(result.warnings[0]).toContain(`still points at ${fixture.stored('old', 'proja')}`)
      expect(readlinkSync(join(fixture.checkoutConnection, 'proja'))).toBe(
        fixture.stored('old', 'proja')
      )
      expect(readlinkSync(join(fixture.connectionProject, 'proja'))).toBe(
        fixture.real('new', 'proja')
      )
    } finally {
      chmodSync(fixture.checkoutConnection, 0o755)
    }
  })

  it('returns a sentence instead of throwing when the database cannot be read', async () => {
    const fixture = await makeFixture()
    const relocations = fixture.move()
    fixture.db.close()

    const result = relinkConnectionSymlinksForMovedProject(
      fixture.db,
      fixture.projectA.id,
      relocations
    )

    expect(result.relinked).toBe(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/^Could not look up the connections/)
    expect(readlinkSync(join(fixture.checkoutConnection, 'proja'))).toBe(
      fixture.stored('old', 'proja')
    )
  })

  it('finds nothing for a project that is in no connection', async () => {
    const fixture = await makeFixture()
    const loner = fixture.db.createProject({ name: 'loner', path: fixture.stored('loner') })

    expect(
      relinkConnectionSymlinksForMovedProject(fixture.db, loner.id, [
        { from: [fixture.stored('old', 'proja')], to: fixture.real('new', 'proja') }
      ])
    ).toEqual({ relinked: 0, warnings: [] })
    expect(readlinkSync(join(fixture.checkoutConnection, 'proja'))).toBe(
      fixture.stored('old', 'proja')
    )
  })
})

describeIf('regenerateConnectionInstructionsForProject', () => {
  const realPathLine = (path: string): string => `- **Real path:** ${path}\n`

  it('rewrites AGENTS.md and CLAUDE.md with the paths the project has now', async () => {
    const fixture = await makeFixture()
    const { db, real, projectA, connectionProject } = fixture
    db.updateProject(projectA.id, { name: 'Renamed App' })
    writeFileSync(join(fixture.unrelatedConnection, 'AGENTS.md'), 'left alone')
    for (const folder of [fixture.checkoutConnection, connectionProject]) {
      expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toContain(
        realPathLine(fixture.stored('old', 'proja'))
      )
    }

    const relocations = fixture.move()
    relinkConnectionSymlinksForMovedProject(db, projectA.id, relocations)
    const warnings = regenerateConnectionInstructionsForProject(db, projectA.id)

    expect(warnings).toEqual([])
    const expectPath = (folder: string, path: string): void => {
      const agentsMd = readFileSync(join(folder, 'AGENTS.md'), 'utf8')
      expect(agentsMd).toContain(realPathLine(path))
      expect(agentsMd).not.toContain(join('old', 'proja'))
      expect(agentsMd).toContain('- **Project:** Renamed App\n')
      expect(readFileSync(join(folder, 'CLAUDE.md'), 'utf8')).toBe(agentsMd)
    }
    expectPath(fixture.checkoutConnection, real('new', 'proja'))
    expectPath(fixture.nestedConnection, real('new', 'proja', '.claude', 'worktrees', 'nested'))
    expectPath(fixture.siblingConnection, real('new', 'proja-feature'))
    expectPath(fixture.outsideConnection, real('wt', 'proja-outside'))
    expectPath(connectionProject, real('new', 'proja'))

    // The connection project lists the member under the name its link has in the folder, not
    // under the name the renamed project would be given today.
    const projectAgentsMd = readFileSync(join(connectionProject, 'AGENTS.md'), 'utf8')
    expect(projectAgentsMd).toContain('### proja/\n')
    expect(projectAgentsMd).not.toContain('renamed-app')
    expect(projectAgentsMd).toContain('### projb/\n')
    expect(projectAgentsMd).toContain(realPathLine(fixture.stored('elsewhere', 'projb')))

    expect(readFileSync(join(fixture.unrelatedConnection, 'AGENTS.md'), 'utf8')).toBe('left alone')

    // Running it again writes the same files.
    expect(regenerateConnectionInstructionsForProject(db, projectA.id)).toEqual([])
    expect(readFileSync(join(connectionProject, 'AGENTS.md'), 'utf8')).toBe(projectAgentsMd)
  })

  it('lists a member under its derived name when no link points at it', async () => {
    const fixture = await makeFixture()
    fixture.db.updateProject(fixture.projectB.id, { name: 'Project B' })
    rmSync(join(fixture.connectionProject, 'projb'))

    expect(regenerateConnectionInstructionsForProject(fixture.db, fixture.projectA.id)).toEqual([])

    const agentsMd = readFileSync(join(fixture.connectionProject, 'AGENTS.md'), 'utf8')
    expect(agentsMd).toContain('### proja/\n')
    expect(agentsMd).toContain('### project-b/\n')
  })

  it('says which folder it could not write, writes the others and skips one that is gone', async () => {
    const fixture = await makeFixture()
    const relocations = fixture.move()
    relinkConnectionSymlinksForMovedProject(fixture.db, fixture.projectA.id, relocations)
    // A folder where AGENTS.md should be: the file cannot be written.
    rmSync(join(fixture.siblingConnection, 'AGENTS.md'))
    mkdirSync(join(fixture.siblingConnection, 'AGENTS.md'))
    rmSync(fixture.outsideConnection, { recursive: true, force: true })

    const warnings = regenerateConnectionInstructionsForProject(fixture.db, fixture.projectA.id)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(fixture.siblingConnection)
    expect(warnings[0]).toMatch(/^Could not rewrite AGENTS\.md and CLAUDE\.md of the connection "/)
    expect(readFileSync(join(fixture.checkoutConnection, 'AGENTS.md'), 'utf8')).toContain(
      realPathLine(fixture.real('new', 'proja'))
    )
    expect(readFileSync(join(fixture.connectionProject, 'AGENTS.md'), 'utf8')).toContain(
      realPathLine(fixture.real('new', 'proja'))
    )
    expect(existsSync(fixture.outsideConnection)).toBe(false)
  })

  it('returns a sentence instead of throwing when the database cannot be read', async () => {
    const fixture = await makeFixture()
    const before = readFileSync(join(fixture.checkoutConnection, 'AGENTS.md'), 'utf8')
    fixture.db.close()

    const warnings = regenerateConnectionInstructionsForProject(fixture.db, fixture.projectA.id)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^Could not look up the connections/)
    expect(readFileSync(join(fixture.checkoutConnection, 'AGENTS.md'), 'utf8')).toBe(before)
  })
})

describeIf('addConnectionProjectMemberOp', () => {
  it('links the new member under a free name and lists every member in AGENTS.md', async () => {
    const fixture = await makeFixture()
    const { db, stored, connectionProject } = fixture
    // Named like a member that is already linked: its link gets the next free name.
    db.updateProject(fixture.projectC.id, { name: 'ProjA' })

    const result = await addConnectionProjectMemberOp(
      db,
      fixture.connectionProjectId,
      fixture.projectC.id
    )

    expect(result.success).toBe(true)
    expect(readlinkSync(join(connectionProject, 'proja-2'))).toBe(stored('elsewhere', 'projc'))
    expect(readlinkSync(join(connectionProject, 'proja'))).toBe(stored('old', 'proja'))
    expect(readlinkSync(join(connectionProject, 'projb'))).toBe(stored('elsewhere', 'projb'))
    const agentsMd = readFileSync(join(connectionProject, 'AGENTS.md'), 'utf8')
    expect(agentsMd).toContain(
      [
        '### proja/',
        '- **Project:** proja',
        '- **Branch:** main',
        `- **Real path:** ${stored('old', 'proja')}`,
        '',
        '### projb/',
        '- **Project:** projb',
        '- **Branch:** main',
        `- **Real path:** ${stored('elsewhere', 'projb')}`,
        '',
        '### proja-2/',
        '- **Project:** ProjA',
        '- **Branch:** main',
        `- **Real path:** ${stored('elsewhere', 'projc')}`
      ].join('\n')
    )
    expect(readFileSync(join(connectionProject, 'CLAUDE.md'), 'utf8')).toBe(agentsMd)
  })
})
