// Where a Teleport or launch-on-cloud receive clones a repository that is not on this machine
// yet, and under which name. The database, git and the app's operations are doubles; the home
// directory and the dev folders are temporary directories, so nothing of the machine the tests
// run on is read or written.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEV_FOLDER_SETTING_KEY } from '@shared/types/dev-folder'
import type { Project } from '../../db/types'
import { ensureRemoteProject } from '../remote-project-ensure'

const live = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  projects: [] as Array<{ id: string; name: string; path: string; kind?: string }>,
  /** What `git remote get-url origin` says per path; a path that is not here makes git fail. */
  remotes: new Map<string, string>(),
  asked: [] as string[],
  clones: [] as Array<{ url: string; destDir: string }>,
  fetched: [] as string[],
  synced: [] as Array<{ projectId: string; projectPath: string }>,
  /** Runs while git is asked about a path: a move that happens during the lookup. */
  whileAsking: null as ((path: string) => void) | null
}))

vi.mock('../../db', () => ({
  getDatabase: () => ({
    getSetting: (key: string) => live.settings.get(key) ?? null,
    getAllProjects: () => live.projects.map((project) => ({ ...project })),
    getProject: (id: string) => {
      const row = live.projects.find((project) => project.id === id)
      return row ? { ...row } : null
    }
  })
}))
vi.mock('../../effect/git/facade', () => ({
  gitService: {
    getRemoteUrl: async (repoPath: string) => {
      live.asked.push(repoPath)
      live.whileAsking?.(repoPath)
      const url = live.remotes.get(repoPath)
      return url ? { success: true, url } : { success: false, error: 'not a git repository' }
    }
  }
}))
vi.mock('../git-exec', () => ({
  execGit: async (cwd: string) => {
    live.fetched.push(cwd)
    return { stdout: '', stderr: '' }
  }
}))
vi.mock('../git-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git-repository')>()),
  cloneRepository: async (url: string, destDir: string) => {
    live.clones.push({ url, destDir })
    return { success: true }
  }
}))
vi.mock('../project-ops', () => ({
  createProjectWithDefaultWorktree: (_db: unknown, data: { name: string; path: string }) => {
    const created = { id: `p-${live.projects.length + 1}`, name: data.name, path: data.path }
    live.projects.push(created)
    return created as unknown as Project
  }
}))
vi.mock('../worktree-ops', () => ({
  syncWorktreesOp: async (params: { projectId: string; projectPath: string }) => {
    live.synced.push(params)
    return { success: true }
  }
}))
vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const setDevFolder = (path: string | null): void => {
  live.settings.set(DEV_FOLDER_SETTING_KEY, JSON.stringify({ path, previousPaths: [] }))
}

let root: string
let home: string

beforeEach(() => {
  // The real path: macOS keeps its temporary directory behind a link.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-remote-ensure-')))
  home = join(root, 'home')
  mkdirSync(home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  live.settings.clear()
  live.projects.length = 0
  live.remotes.clear()
  live.asked.length = 0
  live.clones.length = 0
  live.fetched.length = 0
  live.synced.length = 0
  live.whileAsking = null
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('ensureRemoteProject, where it clones', () => {
  it('is the default folder in the home directory while nothing is set', async () => {
    const project = await ensureRemoteProject('git@github.com:org/api.git', 'API')

    const expected = join(home, 'hive-projects', 'api')
    expect(live.clones).toEqual([{ url: 'git@github.com:org/api.git', destDir: expected }])
    expect(project).toMatchObject({ name: 'api', path: expected })
    expect(live.synced).toEqual([{ projectId: project.id, projectPath: expected }])
    // The folder is made for the clone, as it always was.
    expect(existsSync(join(home, 'hive-projects'))).toBe(true)
  })

  it('is the dev folder that is set', async () => {
    const devFolder = join(root, 'Dev')
    setDevFolder(devFolder)

    const project = await ensureRemoteProject('https://github.com/org/api.git', 'API')

    expect(project.path).toBe(join(devFolder, 'api'))
    expect(live.clones).toEqual([
      { url: 'https://github.com/org/api.git', destDir: join(devFolder, 'api') }
    ])
    expect(existsSync(devFolder)).toBe(true)
    expect(existsSync(join(home, 'hive-projects'))).toBe(false)
  })

  it('follows a change of the setting from one call to the next, with no restart', async () => {
    const first = join(root, 'Dev')
    const second = join(root, 'Code')

    setDevFolder(first)
    await ensureRemoteProject('git@github.com:org/api.git', 'api')
    setDevFolder(second)
    await ensureRemoteProject('git@github.com:org/web.git', 'web')
    setDevFolder(null)
    await ensureRemoteProject('git@github.com:org/docs.git', 'docs')

    expect(live.clones.map((clone) => clone.destDir)).toEqual([
      join(first, 'api'),
      join(second, 'web'),
      join(home, 'hive-projects', 'docs')
    ])
  })

  it('gives the next free name when the folder is taken', async () => {
    const devFolder = join(root, 'Dev')
    setDevFolder(devFolder)
    mkdirSync(join(devFolder, 'api'), { recursive: true })
    mkdirSync(join(devFolder, 'api-2'))

    const project = await ensureRemoteProject('git@github.com:org/api.git', 'api')

    expect(project.path).toBe(join(devFolder, 'api-3'))
  })

  it('names the dev folder and the setting when the folder cannot be created', async () => {
    // A file where a folder of the path should be: nothing can be created under it.
    writeFileSync(join(root, 'a-file'), 'not a folder\n')
    const devFolder = join(root, 'a-file', 'Dev')
    setDevFolder(devFolder)

    await expect(ensureRemoteProject('git@github.com:org/api.git', 'api')).rejects.toThrow(
      `Could not create the dev folder set in Settings › General (${devFolder}): `
    )
    expect(live.clones).toEqual([])
    expect(live.projects).toEqual([])
  })
})

describe('ensureRemoteProject, the folder name', () => {
  beforeEach(() => {
    setDevFolder(join(root, 'Dev', 'work'))
  })

  it('takes the name of the repository from its address', async () => {
    const project = await ensureRemoteProject('https://github.com/org/api.git', 'Something Else')

    expect(project).toMatchObject({ name: 'api', path: join(root, 'Dev', 'work', 'api') })
  })

  it('takes the given project name when the address names the parent folder', async () => {
    // `..` would lead out of the dev folder, into the folder it is in.
    const project = await ensureRemoteProject('https://github.com/org/..', 'api')

    expect(project).toMatchObject({ name: 'api', path: join(root, 'Dev', 'work', 'api') })
    expect(existsSync(join(root, 'Dev-2'))).toBe(false)
  })

  it('takes the given project name when the address names .git or a folder the app keeps', async () => {
    // A clone at `<dev folder>/.git` would make the dev folder a repository run by the cloned
    // configuration, and a move deletes what is named like its own temporary folder.
    for (const [index, url] of [
      'https://evil.example/a/.git.git',
      'https://evil.example/a/.GIT.git',
      'https://evil.example/a/.Git',
      'https://evil.example/a/..git',
      'https://evil.example/a/.hive-moving-1-abc.git',
      'https://evil.example/a/.HIVE-dev-folder-Xy12Ab'
    ].entries()) {
      const project = await ensureRemoteProject(url, `tools-${index}`)
      expect(project.path, url).toBe(join(root, 'Dev', 'work', `tools-${index}`))
    }
  })

  it('clones a repository whose name starts with a dot under that name', async () => {
    for (const [url, name] of [
      ['git@github.com:acme/.github.git', '.github'],
      ['https://github.com/acme/.dotfiles.git', '.dotfiles'],
      ['https://github.com/acme/.config', '.config'],
      ['git@github.com:acme/.ssh.git', '.ssh']
    ]) {
      const project = await ensureRemoteProject(url, 'Org defaults')
      expect(project, url).toMatchObject({ name, path: join(root, 'Dev', 'work', name) })
    }

    expect(live.clones.map((clone) => clone.destDir)).toEqual(
      ['.github', '.dotfiles', '.config', '.ssh'].map((name) => join(root, 'Dev', 'work', name))
    )
  })

  it('takes a given project name that starts with a dot when the address gives none', async () => {
    const project = await ensureRemoteProject('https://github.com/org/..', '.ssh')

    expect(project).toMatchObject({ name: '.ssh', path: join(root, 'Dev', 'work', '.ssh') })
  })

  it('reduces a given name that is a path to its last part', async () => {
    const project = await ensureRemoteProject('https://github.com/org/repo/', '../../etc')

    expect(project).toMatchObject({ name: 'etc', path: join(root, 'Dev', 'work', 'etc') })
  })

  it('refuses when neither the address nor the given name is a usable folder name', async () => {
    for (const [url, name] of [
      ['https://github.com/org/..', '..'],
      ['https://github.com/org/.git.git', '.git'],
      ['https://github.com/org/.git.git', '.GIT'],
      ['https://github.com/org/repo/', '.'],
      ['https://github.com/org/repo/', ''],
      ['https://github.com/org/..', '.hive-moving-1-abc'],
      ['https://github.com/org/.hive-moving-1-abc.git', '.Hive-moving-2-def'],
      // What a volume that ignores zero-width marks reads as `.git`.
      ['https://evil.example/org/.g\u200cit.git', '.gi\u200dt']
    ]) {
      await expect(ensureRemoteProject(url, name), `${url} + ${name}`).rejects.toThrow(
        `Cannot choose a folder for the clone of "${name}": neither the repository address ` +
          'nor that name can be used as a folder name.'
      )
    }

    expect(live.clones).toEqual([])
    expect(live.projects).toEqual([])
    // Not even the dev folder was made.
    expect(existsSync(join(root, 'Dev'))).toBe(false)
  })

  it('leaves the address out of the refusal: it can carry a token', async () => {
    const refused = await ensureRemoteProject(
      'https://x-access-token:ghp_secret@github.com/org/..',
      '..'
    ).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).not.toContain('ghp_secret')
    expect((refused as Error).message).toContain('".."')
  })
})

describe('ensureRemoteProject, a repository that is here already', () => {
  beforeEach(() => {
    setDevFolder(join(root, 'Dev'))
  })

  it('returns the project whose origin is the repository, in any spelling of the address', async () => {
    live.projects.push({ id: 'web', name: 'web', path: '/code/web' })
    live.projects.push({ id: 'api', name: 'api', path: '/code/api' })
    live.remotes.set('/code/web', 'git@github.com:org/web.git')
    live.remotes.set('/code/api', 'https://GitHub.com/Org/API.git')

    const project = await ensureRemoteProject('git@github.com:org/api.git', 'api')

    expect(project).toMatchObject({ id: 'api', path: '/code/api' })
    expect(live.clones).toEqual([])
    expect(live.fetched).toEqual(['/code/api'])
    expect(existsSync(join(root, 'Dev'))).toBe(false)
  })

  it('finds a project still in a folder used before, and does not clone it a second time', async () => {
    const before = join(root, 'Before')
    live.projects.push({ id: 'api', name: 'api', path: join(before, 'api') })
    live.remotes.set(join(before, 'api'), 'git@github.com:org/api.git')

    const project = await ensureRemoteProject('https://github.com/org/api', 'api')

    expect(project.path).toBe(join(before, 'api'))
    expect(live.clones).toEqual([])
  })

  it('finds a project that was moved while it was looking', async () => {
    live.projects.push({ id: 'web', name: 'web', path: '/old/web' })
    live.projects.push({ id: 'api', name: 'api', path: '/old/api' })
    live.remotes.set('/old/web', 'git@github.com:org/web.git')
    live.remotes.set('/new/api', 'git@github.com:org/api.git')
    // The move renames the folder and rewrites the row in one step, while git answers for
    // another project.
    live.whileAsking = (path) => {
      if (path !== '/old/web') return
      const moved = live.projects.find((project) => project.id === 'api')
      if (moved) moved.path = '/new/api'
    }

    const project = await ensureRemoteProject('git@github.com:org/api.git', 'api')

    expect(project).toMatchObject({ id: 'api', path: '/new/api' })
    expect(live.asked).toEqual(['/old/web', '/old/api', '/new/api'])
    expect(live.clones).toEqual([])
    expect(live.fetched).toEqual(['/new/api'])
  })

  it('does not ask git about a connection project', async () => {
    live.projects.push({
      id: 'links',
      name: 'links',
      path: '/hive/connection-projects/x',
      kind: 'connection'
    })
    live.remotes.set('/hive/connection-projects/x', 'git@github.com:org/api.git')

    const project = await ensureRemoteProject('git@github.com:org/api.git', 'api')

    expect(live.asked).toEqual([])
    expect(project.path).toBe(join(root, 'Dev', 'api'))
  })
})
