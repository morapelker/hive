// The rules every clone of the app shares: the folder name, the free path, the match by
// origin and the question asked before a leftover is deleted. Fakes for the rows and for git;
// the filesystem is a temporary directory, real because "the same folder" is a question for it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '../db/types'
import {
  describeDevFolder,
  findProjectByOrigin,
  isRegisteredProjectFolder,
  safeCloneDirName,
  uniquePath,
  type FindProjectByOriginDeps
} from './clone-destination'

const project = (overrides: Partial<Project> & { id: string; path: string }): Project => ({
  name: overrides.id,
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-11-17T00:00:00.000Z',
  last_accessed_at: '2026-11-17T00:00:00.000Z',
  ...overrides
})

describe('safeCloneDirName', () => {
  it('keeps a plain name', () => {
    expect(safeCloneDirName('api')).toBe('api')
    expect(safeCloneDirName('acme-os_website.v2')).toBe('acme-os_website.v2')
    expect(safeCloneDirName('My Project')).toBe('My Project')
    expect(safeCloneDirName('  api.git ')).toBe('api.git')
  })

  it('gives none for an empty candidate', () => {
    for (const empty of ['', '   ', null, undefined, '\u0000', '\u001f\u007f']) {
      expect(safeCloneDirName(empty), JSON.stringify(empty)).toBeNull()
    }
  })

  it('refuses the folder itself and its parent', () => {
    for (const name of ['.', '..', ' .. ', '/', '//', 'a/..', 'a/.']) {
      expect(safeCloneDirName(name), name).toBeNull()
    }
  })

  it('refuses .git in any letter case', () => {
    for (const name of ['.git', '.GIT', '.Git', '.gIt', ' .git ', 'a/.git', 'a/.GIT/']) {
      expect(safeCloneDirName(name), name).toBeNull()
    }
    // The name can hide behind a character that is dropped.
    expect(safeCloneDirName('\u0000.git')).toBeNull()
    expect(safeCloneDirName('.\u0000git')).toBeNull()
    expect(safeCloneDirName('.GIT\u007f')).toBeNull()
  })

  it('refuses a name that a volume dropping dots and spaces from its end reads as .git', () => {
    for (const name of ['.git.', '.GIT..', '.git .', '.git. .', 'a/.git.']) {
      expect(safeCloneDirName(name), name).toBeNull()
    }
    // A dot at the end of any other name stays: the folder is still the repository's own.
    expect(safeCloneDirName('api.')).toBe('api.')
    expect(safeCloneDirName('.github.')).toBe('.github.')
  })

  it('refuses the names the app keeps for its own temporary folders', () => {
    for (const name of [
      '.hive-moving-1-abc',
      '.hive-moving-48213-a1B2c3',
      '.hive-dev-folder-Xy12Ab',
      '.hive-',
      '.hive-anything-else',
      '.HIVE-MOVING-1-ABC',
      '.Hive-moving-1-abc',
      ' .hive-moving-1-abc ',
      'a/.hive-moving-1-abc',
      '.\u0000hive-moving-1-abc'
    ]) {
      expect(safeCloneDirName(name), name).toBeNull()
    }
    // Only that beginning is kept: a repository may have the app's name in its own.
    expect(safeCloneDirName('hive-moving-1-abc')).toBe('hive-moving-1-abc')
    expect(safeCloneDirName('.hive')).toBe('.hive')
    expect(safeCloneDirName('.hive.github')).toBe('.hive.github')
    expect(safeCloneDirName('hive')).toBe('hive')
  })

  it('keeps every other name that starts with a dot', () => {
    for (const name of ['.github', '.dotfiles', '.config', '.ssh', '.vim', '.GitHub', '...']) {
      expect(safeCloneDirName(name), name).toBe(name)
    }
    expect(safeCloneDirName(' .github ')).toBe('.github')
    expect(safeCloneDirName('org/.github')).toBe('.github')
    // A name that only begins or ends like `.git` is another name.
    for (const name of ['.gitignore', '.git-hooks', '.github.git', '.git.git', 'x.git', 'git']) {
      expect(safeCloneDirName(name), name).toBe(name)
    }
    // A dot anywhere else is an ordinary character.
    expect(safeCloneDirName('a.b')).toBe('a.b')
    expect(safeCloneDirName('git.')).toBe('git.')
  })

  it('refuses a name that a volume ignoring zero-width and direction marks reads as a refused one', () => {
    // On a Mac OS Extended volume each of these is the folder `.git`, `..` or a temporary one.
    for (const name of [
      '.g\u200cit',
      '.git\u200d',
      '\u200e.git',
      '.\u200fGIT',
      '.gi\u202et',
      '.g\u206fit',
      '.g\ufeffit',
      '.\u200c.',
      '\u200d',
      '.h\u200cive-moving-1-abc',
      'a/.g\u200cit'
    ]) {
      expect(safeCloneDirName(name), JSON.stringify(name)).toBeNull()
    }
    // A name that passes is kept as it was given: the marks are part of how it is spelled.
    expect(safeCloneDirName('a\u200cb')).toBe('a\u200cb')
    expect(safeCloneDirName('.git\u200chub')).toBe('.git\u200chub')
  })

  it('reduces a path to its last segment, never a path', () => {
    expect(safeCloneDirName('a/b')).toBe('b')
    expect(safeCloneDirName('../../etc')).toBe('etc')
    expect(safeCloneDirName('/abs/olute/name')).toBe('name')
    expect(safeCloneDirName('a/b/')).toBe('b')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a backslash, which another system reads as a separator',
    () => {
      expect(safeCloneDirName('a\\b')).toBeNull()
      expect(safeCloneDirName('..\\..\\etc')).toBeNull()
    }
  )

  it('drops control characters', () => {
    expect(safeCloneDirName('a\u0000b\u001fc\u007f')).toBe('abc')
    expect(safeCloneDirName('api\n')).toBe('api')
  })
})

describe('uniquePath', () => {
  it('is the path itself when it is free, else the first free numbered one', () => {
    const taken = new Set(['/p/api', '/p/api-2'])
    expect(uniquePath('/p/web', (path) => taken.has(path))).toBe('/p/web')
    expect(uniquePath('/p/api', (path) => taken.has(path))).toBe('/p/api-3')
  })

  it('gives up after 99 taken names', () => {
    expect(() => uniquePath('/p/api', () => true)).toThrow('Could not choose a free path')
  })

  it('asks the filesystem when it is given nothing to ask', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-clone-destination-'))
    try {
      mkdirSync(join(root, 'api'))
      expect(uniquePath(join(root, 'web'))).toBe(join(root, 'web'))
      expect(uniquePath(join(root, 'api'))).toBe(join(root, 'api-2'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('describeDevFolder', () => {
  it('names the setting and the folder', () => {
    expect(describeDevFolder('/Users/me/Dev')).toBe(
      'the dev folder set in Settings › General (/Users/me/Dev)'
    )
  })
})

describe('findProjectByOrigin', () => {
  interface World {
    rows: Project[]
    /** What `git remote get-url origin` says per path; a missing path makes git fail. */
    remotes: Record<string, string | null>
    asked: string[]
    reread: string[]
  }

  const makeWorld = (rows: Project[], remotes: World['remotes']): World => ({
    rows,
    remotes,
    asked: [],
    reread: []
  })

  const depsOf = (
    world: World,
    overrides: Partial<FindProjectByOriginDeps> = {}
  ): FindProjectByOriginDeps => ({
    db: {
      getAllProjects: () => world.rows.map((row) => ({ ...row })),
      getProject: (id) => {
        world.reread.push(id)
        const row = world.rows.find((candidate) => candidate.id === id)
        return row ? { ...row } : null
      }
    },
    git: {
      getRemoteUrl: async (path) => {
        world.asked.push(path)
        if (!(path in world.remotes)) throw new Error(`not a git repository: ${path}`)
        return world.remotes[path]
      }
    },
    ...overrides
  })

  it('finds the project whose origin is the one asked for, in any spelling of the address', async () => {
    const world = makeWorld(
      [project({ id: 'web', path: '/code/web' }), project({ id: 'api', path: '/code/api' })],
      { '/code/web': 'git@github.com:org/web.git', '/code/api': 'https://github.com/org/api.git' }
    )

    const found = await findProjectByOrigin('github.com/org/api', depsOf(world))

    expect(found).toMatchObject({ id: 'api', path: '/code/api' })
    expect(world.asked).toEqual(['/code/web', '/code/api'])
  })

  it('answers null when no project has that origin', async () => {
    const world = makeWorld([project({ id: 'web', path: '/code/web' })], {
      '/code/web': 'git@github.com:org/web.git'
    })

    expect(await findProjectByOrigin('github.com/org/api', depsOf(world))).toBeNull()
  })

  it('returns the first of two projects of one repository', async () => {
    const world = makeWorld(
      [project({ id: 'first', path: '/code/a' }), project({ id: 'second', path: '/code/b' })],
      { '/code/a': 'git@github.com:org/api.git', '/code/b': 'git@github.com:org/api.git' }
    )

    expect((await findProjectByOrigin('github.com/org/api', depsOf(world)))?.id).toBe('first')
    expect(world.asked).toEqual(['/code/a'])
  })

  it('never asks about a connection project, and never returns one', async () => {
    const world = makeWorld(
      [
        project({ id: 'links', path: '/hive/connection-projects/x', kind: 'connection' }),
        project({ id: 'api', path: '/code/api' })
      ],
      {
        '/hive/connection-projects/x': 'git@github.com:org/api.git',
        '/code/api': 'git@github.com:org/api.git'
      }
    )

    expect((await findProjectByOrigin('github.com/org/api', depsOf(world)))?.id).toBe('api')
    expect(world.asked).toEqual(['/code/api'])
  })

  it('compares with the rule the caller normalised the origin with', async () => {
    const world = makeWorld([project({ id: 'api', path: '/code/api' })], {
      '/code/api': 'https://GitHub.com/Org/API.git'
    })
    const lowerCased = (url: string): string =>
      url
        .replace(/^https:\/\//i, '')
        .replace(/\.git$/i, '')
        .toLowerCase()

    // The default rule keeps the letter case of the path: these are two repositories for it.
    expect(await findProjectByOrigin('github.com/org/api', depsOf(world))).toBeNull()
    expect(
      (await findProjectByOrigin('github.com/org/api', depsOf(world, { normalize: lowerCased })))
        ?.id
    ).toBe('api')
  })

  it('goes on to the next project when git fails or has no origin for one', async () => {
    const world = makeWorld(
      [
        project({ id: 'gone', path: '/code/gone' }),
        project({ id: 'local', path: '/code/local' }),
        project({ id: 'api', path: '/code/api' })
      ],
      { '/code/local': null, '/code/api': 'git@github.com:org/api.git' }
    )

    expect((await findProjectByOrigin('github.com/org/api', depsOf(world)))?.id).toBe('api')
    expect(world.asked).toEqual(['/code/gone', '/code/local', '/code/api'])
  })

  it('asks again at the new path when a project was moved while it was looking', async () => {
    const world = makeWorld(
      [project({ id: 'web', path: '/old/web' }), project({ id: 'api', path: '/old/api' })],
      { '/old/web': 'git@github.com:org/web.git', '/new/api': 'git@github.com:org/api.git' }
    )
    const deps = depsOf(world)
    // The rows are read once, before the first question to git. The move happens while git
    // answers for the first project: the folder and the row change together.
    const getRemoteUrl = deps.git.getRemoteUrl
    const moving: FindProjectByOriginDeps = {
      ...deps,
      git: {
        getRemoteUrl: async (path) => {
          if (path === '/old/web') {
            world.rows = world.rows.map((row) =>
              row.id === 'api' ? { ...row, path: '/new/api' } : row
            )
          }
          return getRemoteUrl(path)
        }
      }
    }

    const found = await findProjectByOrigin('github.com/org/api', moving)

    // The row as it is now, so the caller goes on in the folder that exists.
    expect(found).toMatchObject({ id: 'api', path: '/new/api' })
    expect(world.asked).toEqual(['/old/web', '/old/api', '/new/api'])
  })

  it('does the same when git answers "no origin" for a folder that is gone', async () => {
    const world = makeWorld([project({ id: 'api', path: '/old/api' })], {
      '/old/api': null,
      '/new/api': 'git@github.com:org/api.git'
    })
    const deps = depsOf(world)
    const rows = deps.db.getAllProjects()
    world.rows = [project({ id: 'api', path: '/new/api' })]

    const found = await findProjectByOrigin('github.com/org/api', {
      ...deps,
      db: { ...deps.db, getAllProjects: () => rows }
    })

    expect(found).toMatchObject({ id: 'api', path: '/new/api' })
  })

  it('asks once more only, and only when the path changed', async () => {
    const world = makeWorld(
      [project({ id: 'gone', path: '/code/gone' }), project({ id: 'local', path: '/code/local' })],
      { '/code/local': null }
    )

    expect(await findProjectByOrigin('github.com/org/api', depsOf(world))).toBeNull()

    // Each row was read again, found where it was, and git was not asked a second time.
    expect(world.reread).toEqual(['gone', 'local'])
    expect(world.asked).toEqual(['/code/gone', '/code/local'])
  })

  it('does not read the row again when git answered with another origin', async () => {
    const world = makeWorld([project({ id: 'web', path: '/code/web' })], {
      '/code/web': 'git@github.com:org/web.git'
    })

    await findProjectByOrigin('github.com/org/api', depsOf(world))

    expect(world.reread).toEqual([])
  })

  it('skips a project that was deleted while it was looking', async () => {
    const world = makeWorld([project({ id: 'api', path: '/old/api' })], {})
    const deps = depsOf(world)
    const rows = deps.db.getAllProjects()
    world.rows = []

    expect(
      await findProjectByOrigin('github.com/org/api', {
        ...deps,
        db: { ...deps.db, getAllProjects: () => rows }
      })
    ).toBeNull()
    expect(world.asked).toEqual(['/old/api'])
  })

  it('answers null when the moved project is another repository after all', async () => {
    const world = makeWorld([project({ id: 'web', path: '/old/web' })], {
      '/new/web': 'git@github.com:org/web.git'
    })
    const deps = depsOf(world)
    const rows = deps.db.getAllProjects()
    world.rows = [project({ id: 'web', path: '/new/web' })]

    expect(
      await findProjectByOrigin('github.com/org/api', {
        ...deps,
        db: { ...deps.db, getAllProjects: () => rows }
      })
    ).toBeNull()
    expect(world.asked).toEqual(['/old/web', '/new/web'])
  })
})

describe('isRegisteredProjectFolder', () => {
  let root: string

  beforeEach(() => {
    // The real path: macOS keeps its temporary directory behind a link.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-clone-destination-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const dbOf = (...paths: string[]): { getAllProjects(): Project[] } => ({
    getAllProjects: () => paths.map((path, index) => project({ id: `p${index}`, path }))
  })

  it('is true for the exact path of a project, on disk or not', () => {
    mkdirSync(join(root, 'api'))

    expect(isRegisteredProjectFolder(dbOf(join(root, 'api')), join(root, 'api'))).toBe(true)
    expect(isRegisteredProjectFolder(dbOf('/not/on/disk/api'), '/not/on/disk/api')).toBe(true)
  })

  it('is false for a folder no project is at', () => {
    mkdirSync(join(root, 'api'))
    mkdirSync(join(root, 'api-2'))
    mkdirSync(join(root, 'api', 'packages'))
    const db = dbOf(join(root, 'api'))

    expect(isRegisteredProjectFolder(db, join(root, 'api-2'))).toBe(false)
    expect(isRegisteredProjectFolder(db, join(root, 'not-there'))).toBe(false)
    // Neither the folder a project is in, nor a folder inside a project.
    expect(isRegisteredProjectFolder(db, root)).toBe(false)
    expect(isRegisteredProjectFolder(db, join(root, 'api', 'packages'))).toBe(false)
    expect(isRegisteredProjectFolder(dbOf(), join(root, 'api'))).toBe(false)
  })

  it('is true when the path reaches the project through a symbolic link', () => {
    mkdirSync(join(root, 'real'))
    mkdirSync(join(root, 'real', 'api'))
    symlinkSync(join(root, 'real'), join(root, 'link'))

    expect(
      isRegisteredProjectFolder(dbOf(join(root, 'real', 'api')), join(root, 'link', 'api'))
    ).toBe(true)
  })

  it('is true when the project is the one registered through a symbolic link', () => {
    mkdirSync(join(root, 'real'))
    mkdirSync(join(root, 'real', 'api'))
    symlinkSync(join(root, 'real'), join(root, 'link'))
    symlinkSync(join(root, 'real', 'api'), join(root, 'shortcut'))

    expect(
      isRegisteredProjectFolder(dbOf(join(root, 'link', 'api')), join(root, 'real', 'api'))
    ).toBe(true)
    expect(isRegisteredProjectFolder(dbOf(join(root, 'shortcut')), join(root, 'real', 'api'))).toBe(
      true
    )
  })

  it('is true for another spelling of the same path', () => {
    mkdirSync(join(root, 'api'))
    const db = dbOf(join(root, 'api'))

    expect(isRegisteredProjectFolder(db, `${join(root, 'api')}/`)).toBe(true)
    expect(isRegisteredProjectFolder(db, join(root, 'other', '..', 'api'))).toBe(true)
  })

  it('is true in another letter case on a volume that ignores it', (context) => {
    mkdirSync(join(root, 'Api'))
    let ignoresCase = false
    try {
      ignoresCase = realpathSync.native(join(root, 'api')) === join(root, 'Api')
    } catch {
      ignoresCase = false
    }
    if (!ignoresCase) context.skip()

    expect(isRegisteredProjectFolder(dbOf(join(root, 'Api')), join(root, 'api'))).toBe(true)
  })

  it('is true when the rows cannot be read, so that nothing is deleted on a guess', () => {
    const broken = {
      getAllProjects: (): Project[] => {
        throw new Error('the database is closed')
      }
    }

    expect(isRegisteredProjectFolder(broken, join(root, 'api'))).toBe(true)
  })
})
