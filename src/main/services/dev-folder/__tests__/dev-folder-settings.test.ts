import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_FOLDER_MAX_PREVIOUS,
  DEV_FOLDER_SETTING_KEY,
  parseStoredDevFolder,
  serializeStoredDevFolder,
  type StoredDevFolder
} from '@shared/types/dev-folder'
import type { DatabaseService } from '../../../db'

// Every test hands the module a store and a home directory of its own. The process database
// is replaced so that a test that forgets to cannot open the developer's real one.
const getDatabaseMock = vi.hoisted(() => vi.fn())
vi.mock('../../../db', () => ({ getDatabase: getDatabaseMock }))

import {
  createLiveSetDevFolderDeps,
  defaultDevFolder,
  expandHomeDir,
  previousDevFolders,
  readDevFolderState,
  resolveDevFolder,
  setDevFolder,
  type DevFolderStore,
  type SetDevFolderDeps
} from '../dev-folder-settings'

const databaseLookupsWhileLoading = getDatabaseMock.mock.calls.length

const isWindows = process.platform === 'win32'
const isRoot = process.getuid?.() === 0

/** Whether the volume the temp directory is on treats `Dev` and `dev` as one folder. */
const volumeIgnoresCase = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'dev-folder-case-'))
  try {
    mkdirSync(join(probe, 'CaseProbe'))
    return existsSync(join(probe, 'caseprobe'))
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

interface MemoryStore extends DevFolderStore {
  /** Every value written, oldest first. */
  readonly writes: string[]
  readonly stored: () => StoredDevFolder
}

const memoryStore = (initial: string | null = null): MemoryStore => {
  let value = initial
  const writes: string[] = []
  return {
    getSetting: (key) => (key === DEV_FOLDER_SETTING_KEY ? value : null),
    setSetting: (key, next) => {
      if (key !== DEV_FOLDER_SETTING_KEY) throw new Error(`unexpected settings key ${key}`)
      value = next
      writes.push(next)
    },
    writes,
    stored: () => parseStoredDevFolder(value)
  }
}

const rowOf = (path: string | null, previousPaths: string[] = []): string =>
  serializeStoredDevFolder({ path, previousPaths })

/** The temp directory of the test (a real path: /var is /private/var on macOS). */
let root: string
let home: string
let defaultFolder: string
let store: MemoryStore

const makeDeps = (overrides: Partial<SetDevFolderDeps> = {}): SetDevFolderDeps => ({
  store,
  home,
  reservedFolders: [join(home, '.hive'), join(home, '.hive-worktrees'), join(home, '.claude')],
  registeredFolders: () => [],
  holdsProjects: () => true,
  ...overrides
})

const errorOf = (result: ReturnType<typeof setDevFolder>): string => {
  if (result.success) throw new Error('expected the change to be refused')
  return result.error
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dev-folder-settings-')))
  home = join(root, 'home')
  mkdirSync(home)
  defaultFolder = join(home, 'hive-projects')
  store = memoryStore()
  getDatabaseMock.mockReset()
  getDatabaseMock.mockImplementation(() => {
    throw new Error('a test must not open the process database')
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('expandHomeDir', () => {
  it('expands ~ and ~/x only', () => {
    expect(expandHomeDir('~', home)).toBe(home)
    expect(expandHomeDir('~/', home)).toBe(home)
    expect(expandHomeDir('~/Dev/work', home)).toBe(join(home, 'Dev', 'work'))
    expect(expandHomeDir('~someone/Dev', home)).toBe('~someone/Dev')
    expect(expandHomeDir('~Dev', home)).toBe('~Dev')
    expect(expandHomeDir('Dev/~/x', home)).toBe('Dev/~/x')
    expect(expandHomeDir(join(root, 'elsewhere'), home)).toBe(join(root, 'elsewhere'))
    expect(expandHomeDir('', home)).toBe('')
  })

  it('uses the home directory of the process when none is given', () => {
    expect(expandHomeDir('~')).toBe(homedir())
  })
})

describe('defaultDevFolder', () => {
  it('is hive-projects in the home directory', () => {
    expect(defaultDevFolder(home)).toBe(join(home, 'hive-projects'))
    expect(defaultDevFolder()).toBe(resolve(homedir(), 'hive-projects'))
  })
})

describe('resolveDevFolder', () => {
  it('is the default folder while nothing is stored', () => {
    expect(resolveDevFolder(store, home)).toBe(defaultFolder)
  })

  it('is the stored folder, resolved', () => {
    const folder = join(root, 'Dev')
    expect(resolveDevFolder(memoryStore(rowOf(folder)), home)).toBe(folder)
    expect(resolveDevFolder(memoryStore(rowOf(`${root}/a/../Dev/./`)), home)).toBe(folder)
  })

  it('reads the store on every call', () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    store.setSetting(DEV_FOLDER_SETTING_KEY, rowOf(first))
    expect(resolveDevFolder(store, home)).toBe(first)
    store.setSetting(DEV_FOLDER_SETTING_KEY, rowOf(second))
    expect(resolveDevFolder(store, home)).toBe(second)
    store.setSetting(DEV_FOLDER_SETTING_KEY, rowOf(null))
    expect(resolveDevFolder(store, home)).toBe(defaultFolder)
  })

  it('reads as the default when the store throws', () => {
    const broken = {
      getSetting: (): string | null => {
        throw new Error('database is locked')
      }
    }
    expect(resolveDevFolder(broken, home)).toBe(defaultFolder)
  })

  it.each([
    ['text that is not JSON', '{nope'],
    ['a JSON string', '"/Users/x/Dev"'],
    ['an array', '["/Users/x/Dev"]'],
    ['a path that is not a string', '{"path":42}'],
    ['a relative path', '{"path":"Dev/projects"}'],
    ['a path under ~', '{"path":"~/Dev"}'],
    ['the root', '{"path":"/"}'],
    ['a doubled root', '{"path":"//"}'],
    // The shared parser only refuses a root that is spelled as one.
    ['a path that climbs back to the root', '{"path":"/Users/.."}'],
    ['the root with a dot segment', '{"path":"/."}'],
    ['an empty path', '{"path":""}']
  ])('reads as the default for %s', (_name, raw) => {
    expect(resolveDevFolder(memoryStore(raw), home)).toBe(defaultFolder)
    expect(readDevFolderState(memoryStore(raw), home).isDefault).toBe(true)
  })

  it('leaves out a folder used before that resolves to the root', () => {
    const row = rowOf(join(root, 'now'), ['/Users/..', join(root, 'before')])
    expect(previousDevFolders(memoryStore(row), home)).toEqual([join(root, 'before')])
  })

  it.skipIf(isWindows)('reads as the default for a path of another platform', () => {
    // The shared parser lets a Windows path through; for node on a Mac it is relative.
    expect(resolveDevFolder(memoryStore(rowOf('C:\\Dev')), home)).toBe(defaultFolder)
    expect(resolveDevFolder(memoryStore(rowOf('\\\\server\\share')), home)).toBe(defaultFolder)
  })

  it('does not look the process database up while the module loads', () => {
    expect(databaseLookupsWhileLoading).toBe(0)
  })

  it('reads the process database when no store is given', () => {
    const folder = join(root, 'from-database')
    getDatabaseMock.mockImplementation(() => memoryStore(rowOf(folder)))
    expect(resolveDevFolder(undefined, home)).toBe(folder)
    expect(getDatabaseMock).toHaveBeenCalledTimes(1)
    expect(resolveDevFolder(undefined, home)).toBe(folder)
    expect(getDatabaseMock).toHaveBeenCalledTimes(2)
  })

  it('reads as the default when the process database cannot be opened', () => {
    expect(resolveDevFolder(undefined, home)).toBe(defaultFolder)
    expect(previousDevFolders(undefined, home)).toEqual([])
    expect(readDevFolderState(undefined, home)).toEqual({
      path: defaultFolder,
      isDefault: true,
      defaultPath: defaultFolder,
      exists: false,
      previousPaths: []
    })
    expect(getDatabaseMock).toHaveBeenCalledTimes(3)
  })
})

describe('previousDevFolders', () => {
  it('lists the folders used before, most recent first', () => {
    const row = rowOf(join(root, 'now'), [join(root, 'before'), join(root, 'long-ago')])
    expect(previousDevFolders(memoryStore(row), home)).toEqual([
      join(root, 'before'),
      join(root, 'long-ago')
    ])
  })

  it('leaves out the folder in effect, however it is spelled', () => {
    const now = join(root, 'now')
    mkdirSync(now)
    symlinkSync(now, join(root, 'alias'))
    const row = rowOf(now, [join(root, 'alias'), `${root}/x/../now`, join(root, 'before')])
    expect(previousDevFolders(memoryStore(row), home)).toEqual([join(root, 'before')])
  })

  it('leaves out the default folder while the default is in effect', () => {
    // The parser cannot do this: a null path does not tell it the home directory.
    const row = rowOf(null, [defaultFolder, join(root, 'before')])
    expect(parseStoredDevFolder(row).previousPaths).toContain(defaultFolder)
    expect(previousDevFolders(memoryStore(row), home)).toEqual([join(root, 'before')])
  })

  it('lists a folder once when it is stored under two spellings', () => {
    const before = join(root, 'before')
    mkdirSync(before)
    symlinkSync(before, join(root, 'alias'))
    const row = rowOf(join(root, 'now'), [join(root, 'alias'), before, `${before}/sub/..`])
    expect(previousDevFolders(memoryStore(row), home)).toEqual([join(root, 'alias')])
  })

  it.skipIf(isWindows)('leaves out entries the platform cannot use', () => {
    const row = rowOf(join(root, 'now'), ['C:\\Old', join(root, 'before')])
    expect(previousDevFolders(memoryStore(row), home)).toEqual([join(root, 'before')])
  })

  it('is empty when the store throws', () => {
    const broken = {
      getSetting: (): string | null => {
        throw new Error('database is locked')
      }
    }
    expect(previousDevFolders(broken, home)).toEqual([])
  })
})

describe('readDevFolderState', () => {
  it('describes the default folder while nothing is stored', () => {
    expect(readDevFolderState(store, home)).toEqual({
      path: defaultFolder,
      isDefault: true,
      defaultPath: defaultFolder,
      exists: false,
      previousPaths: []
    })
    mkdirSync(defaultFolder)
    expect(readDevFolderState(store, home).exists).toBe(true)
  })

  it('describes a stored folder and the folders before it', () => {
    const folder = join(root, 'Dev')
    const row = rowOf(folder, [defaultFolder, folder])
    expect(readDevFolderState(memoryStore(row), home)).toEqual({
      path: folder,
      isDefault: false,
      defaultPath: defaultFolder,
      exists: false,
      previousPaths: [defaultFolder]
    })
    mkdirSync(folder)
    expect(readDevFolderState(memoryStore(row), home).exists).toBe(true)
  })

  it('says a file is not an existing folder', () => {
    const file = join(root, 'notes.txt')
    writeFileSync(file, 'x')
    expect(readDevFolderState(memoryStore(rowOf(file)), home).exists).toBe(false)
  })

  it('has no leftBehind: the RPC layer adds it', () => {
    expect(Object.keys(readDevFolderState(store, home)).sort()).toEqual([
      'defaultPath',
      'exists',
      'isDefault',
      'path',
      'previousPaths'
    ])
  })
})

describe('setDevFolder: what it refuses', () => {
  const expectNothingChanged = (): void => {
    expect(store.writes).toEqual([])
    expect(readdirSync(home)).toEqual([])
  }

  it.each([['Dev/projects'], ['./Dev'], ['Dev'], [''], [' '], ['~someone/Dev']])(
    'refuses the relative path %j',
    (input) => {
      expect(errorOf(setDevFolder(input, makeDeps()))).toMatch(/is not a full path/)
      expectNothingChanged()
    }
  )

  it.skipIf(isWindows)('refuses a path of another platform', () => {
    expect(errorOf(setDevFolder('C:\\Dev', makeDeps()))).toMatch(/is not a full path/)
    expectNothingChanged()
  })

  it('refuses a path with a NUL character', () => {
    expect(errorOf(setDevFolder(`${root}/a\0b`, makeDeps()))).toMatch(/character/)
    expectNothingChanged()
  })

  it('refuses the top of the disk', () => {
    const top = parse(root).root
    expect(errorOf(setDevFolder(top, makeDeps()))).toMatch(/top of a disk/)
    const climbing = join(root, ...Array.from({ length: 40 }, () => '..'))
    expect(errorOf(setDevFolder(climbing, makeDeps()))).toMatch(/top of a disk/)
    expectNothingChanged()
  })

  it.skipIf(isWindows)('refuses a doubled root', () => {
    expect(errorOf(setDevFolder('//', makeDeps()))).toMatch(/top of a disk/)
  })

  it('refuses the home directory, however it is spelled', () => {
    symlinkSync(home, join(root, 'home-alias'))
    for (const input of ['~', '~/', home, `${home}/`, `${home}/x/..`, join(root, 'home-alias')]) {
      expect(errorOf(setDevFolder(input, makeDeps()))).toMatch(/cannot be your home folder/)
    }
    expectNothingChanged()
  })

  it('refuses a folder that contains the home directory', () => {
    expect(errorOf(setDevFolder(root, makeDeps()))).toBe(
      `The dev folder cannot be ${root}, because your home folder is inside it.`
    )
    expect(errorOf(setDevFolder(dirname(root), makeDeps()))).toMatch(
      /your home folder is inside it/
    )
    expectNothingChanged()
  })

  it('refuses a file', () => {
    const file = join(root, 'notes.txt')
    writeFileSync(file, 'x')
    expect(errorOf(setDevFolder(file, makeDeps()))).toBe(`${file} is a file, not a folder.`)
    expect(errorOf(setDevFolder(join(file, 'sub'), makeDeps()))).toBe(
      `${join(file, 'sub')} could not be created: a file is in the way.`
    )
    expectNothingChanged()
  })

  it('refuses a reserved folder and anything inside one, creating nothing', () => {
    const deps = makeDeps()
    for (const input of [
      join(home, '.hive'),
      '~/.hive',
      join(home, '.hive', 'connections', 'x'),
      join(home, '.hive-worktrees', 'repo', 'branch'),
      '~/.claude/projects'
    ]) {
      expect(errorOf(setDevFolder(input, deps))).toMatch(
        /^The dev folder cannot be .+ or a folder inside it: Hive and its agents keep/
      )
    }
    expect(errorOf(setDevFolder('~/.hive-worktrees/x', deps))).toContain(
      join(home, '.hive-worktrees')
    )
    expectNothingChanged()
  })

  it('refuses a symlink that leads into a reserved folder', () => {
    const transcripts = join(home, '.claude', 'projects')
    mkdirSync(transcripts, { recursive: true })
    symlinkSync(transcripts, join(root, 'shortcut'))
    expect(errorOf(setDevFolder(join(root, 'shortcut'), makeDeps()))).toContain(
      join(home, '.claude')
    )
    expect(errorOf(setDevFolder(join(root, 'shortcut', 'new'), makeDeps()))).toContain(
      join(home, '.claude')
    )
    expect(readdirSync(transcripts)).toEqual([])
    expect(store.writes).toEqual([])
  })

  it('refuses a registered project folder and anything inside it', () => {
    const project = join(root, 'code', 'app')
    mkdirSync(join(project, 'src'), { recursive: true })
    const deps = makeDeps({
      registeredFolders: () => [{ path: project, label: 'the project "app"' }]
    })
    expect(errorOf(setDevFolder(project, deps))).toBe(
      `The dev folder cannot be the folder of the project "app" (${project}).`
    )
    expect(errorOf(setDevFolder(join(project, 'src'), deps))).toBe(
      `The dev folder cannot be inside the project "app" (${project}).`
    )
    expect(errorOf(setDevFolder(join(project, 'vendor', 'clones'), deps))).toBe(
      `The dev folder cannot be inside the project "app" (${project}).`
    )
    expect(readdirSync(project)).toEqual(['src'])
    expect(store.writes).toEqual([])
  })

  it('refuses a worktree folder and a connection folder, naming them', () => {
    const worktree = join(root, 'trees', 'app-feature')
    const connection = join(root, 'links', 'app-and-api')
    mkdirSync(worktree, { recursive: true })
    mkdirSync(connection, { recursive: true })
    const deps = makeDeps({
      registeredFolders: () => [
        { path: worktree, label: 'the worktree "feature" of "app"' },
        { path: connection, label: 'the connection "app and api"' }
      ]
    })
    expect(errorOf(setDevFolder(join(worktree, 'x'), deps))).toBe(
      `The dev folder cannot be inside the worktree "feature" of "app" (${worktree}).`
    )
    expect(errorOf(setDevFolder(connection, deps))).toBe(
      `The dev folder cannot be the folder of the connection "app and api" (${connection}).`
    )
    expect(existsSync(join(worktree, 'x'))).toBe(false)
    expect(store.writes).toEqual([])
  })

  it('refuses a folder inside a project that is registered through a symlink', () => {
    const project = join(root, 'code', 'app')
    mkdirSync(project, { recursive: true })
    symlinkSync(join(root, 'code'), join(root, 'code-alias'))
    const registered = join(root, 'code-alias', 'app')
    const deps = makeDeps({
      registeredFolders: () => [{ path: registered, label: 'the project "app"' }]
    })
    expect(errorOf(setDevFolder(join(project, 'x'), deps))).toBe(
      `The dev folder cannot be inside the project "app" (${registered}).`
    )
    expect(existsSync(join(project, 'x'))).toBe(false)
  })

  it('refuses a folder inside a registered project whose folder is not on disk', () => {
    const gone = join(root, 'unplugged', 'app')
    const deps = makeDeps({
      registeredFolders: () => [{ path: gone, label: 'the project "app"' }]
    })
    expect(errorOf(setDevFolder(gone, deps))).toMatch(/the folder of the project "app"/)
    expect(errorOf(setDevFolder(join(gone, 'x'), deps))).toMatch(/inside the project "app"/)
    expect(existsSync(join(root, 'unplugged'))).toBe(false)
    expect(store.writes).toEqual([])
  })

  it.skipIf(!volumeIgnoresCase)(
    'refuses another letter case of a registered folder that is not on disk, and removes what it created',
    () => {
      const gone = join(root, 'Unplugged', 'App')
      const deps = makeDeps({
        registeredFolders: () => [{ path: gone, label: 'the project "App"' }]
      })
      expect(errorOf(setDevFolder(join(root, 'unplugged', 'app', 'clones'), deps))).toBe(
        `The dev folder cannot be inside the project "App" (${gone}).`
      )
      expect(existsSync(join(root, 'unplugged'))).toBe(false)
      expect(store.writes).toEqual([])
    }
  )

  it.skipIf(isWindows || isRoot)('refuses a folder it cannot write to', () => {
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    try {
      expect(errorOf(setDevFolder(locked, makeDeps()))).toBe(
        `Hive cannot write to ${locked}: permission denied.`
      )
      expect(errorOf(setDevFolder(join(locked, 'inside'), makeDeps()))).toBe(
        `${join(locked, 'inside')} could not be created: permission denied.`
      )
    } finally {
      chmodSync(locked, 0o755)
    }
    expect(readdirSync(locked)).toEqual([])
    expect(store.writes).toEqual([])
  })

  it('reports a store that cannot be read or written, without throwing', () => {
    const unreadable = makeDeps({
      store: {
        getSetting: () => {
          throw new Error('database is locked')
        },
        setSetting: () => undefined
      }
    })
    expect(errorOf(setDevFolder(join(root, 'Dev'), unreadable))).toBe(
      'The dev folder could not be changed: database is locked.'
    )
    const unwritable = makeDeps({
      store: {
        getSetting: () => null,
        setSetting: () => {
          throw new Error('disk I/O error.')
        }
      }
    })
    expect(errorOf(setDevFolder(join(root, 'Dev'), unwritable))).toBe(
      'The dev folder could not be changed: disk I/O error.'
    )
    expect(errorOf(setDevFolder(null, unreadable))).toMatch(/could not be changed/)
  })

  it('reports a project list that cannot be read, without throwing', () => {
    const deps = makeDeps({
      registeredFolders: () => {
        throw new Error('no such table: projects')
      }
    })
    expect(errorOf(setDevFolder(join(root, 'Dev'), deps))).toBe(
      'The dev folder could not be changed: no such table: projects.'
    )
    expect(existsSync(join(root, 'Dev'))).toBe(false)
    expect(store.writes).toEqual([])
  })
})

describe('setDevFolder: what it stores', () => {
  it('expands ~/x, creates the folder and records the default as the folder before', () => {
    expect(setDevFolder('~/Dev/work', makeDeps())).toEqual({ success: true })
    const folder = join(home, 'Dev', 'work')
    expect(existsSync(folder)).toBe(true)
    expect(readdirSync(folder)).toEqual([])
    expect(store.stored()).toEqual({ path: folder, previousPaths: [defaultFolder] })
    expect(readDevFolderState(store, home)).toEqual({
      path: folder,
      isDefault: false,
      defaultPath: defaultFolder,
      exists: true,
      previousPaths: [defaultFolder]
    })
  })

  it('stores one spelling: no trailing slash, no dot segments', () => {
    const folder = join(root, 'Dev')
    expect(setDevFolder(`${root}/x/../Dev//`, makeDeps())).toEqual({ success: true })
    expect(store.stored().path).toBe(folder)
    expect(existsSync(join(root, 'x'))).toBe(false)
  })

  it('accepts the folder that holds registered projects', () => {
    const project = join(root, 'code', 'app')
    mkdirSync(project, { recursive: true })
    const deps = makeDeps({
      registeredFolders: () => [{ path: project, label: 'the project "app"' }]
    })
    expect(setDevFolder(join(root, 'code'), deps)).toEqual({ success: true })
    expect(store.stored().path).toBe(join(root, 'code'))
  })

  it('stores the real path of a symlink to a folder', () => {
    const real = join(root, 'volume', 'projects')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, join(root, 'shortcut'))
    expect(setDevFolder(join(root, 'shortcut'), makeDeps())).toEqual({ success: true })
    expect(store.stored().path).toBe(real)
  })

  it('stores the real path of a new folder below a symlink', () => {
    const real = join(root, 'volume')
    mkdirSync(real)
    symlinkSync(real, join(root, 'shortcut'))
    expect(setDevFolder(join(root, 'shortcut', 'projects'), makeDeps())).toEqual({ success: true })
    expect(store.stored().path).toBe(join(real, 'projects'))
    expect(existsSync(join(real, 'projects'))).toBe(true)
  })

  it.skipIf(!volumeIgnoresCase)('stores the letter case the folder has on disk', () => {
    mkdirSync(join(root, 'Dev'))
    expect(setDevFolder(join(root, 'dev'), makeDeps())).toEqual({ success: true })
    expect(store.stored().path).toBe(join(root, 'Dev'))
  })

  it('writes nothing for another spelling of the folder in effect', () => {
    const folder = join(root, 'Dev')
    expect(setDevFolder(folder, makeDeps())).toEqual({ success: true })
    symlinkSync(folder, join(root, 'shortcut'))
    for (const input of [
      folder,
      `${folder}/`,
      join(root, 'x', '..', basename(folder)),
      join(root, 'shortcut')
    ]) {
      expect(setDevFolder(input, makeDeps())).toEqual({ success: true })
    }
    expect(store.writes).toHaveLength(1)
    expect(store.stored()).toEqual({ path: folder, previousPaths: [defaultFolder] })
  })

  it.skipIf(!volumeIgnoresCase)(
    'writes nothing for another letter case of the folder in effect',
    () => {
      const folder = join(root, 'Dev')
      expect(setDevFolder(folder, makeDeps())).toEqual({ success: true })
      expect(setDevFolder(join(root, 'DEV'), makeDeps())).toEqual({ success: true })
      expect(store.writes).toHaveLength(1)
      expect(store.stored()).toEqual({ path: folder, previousPaths: [defaultFolder] })
    }
  )

  it('stores null when the default folder is chosen by its path', () => {
    const other = join(root, 'Dev')
    expect(setDevFolder(other, makeDeps())).toEqual({ success: true })
    expect(setDevFolder(defaultFolder, makeDeps())).toEqual({ success: true })
    expect(store.stored()).toEqual({ path: null, previousPaths: [other] })
    expect(readDevFolderState(store, home).isDefault).toBe(true)

    expect(setDevFolder(other, makeDeps())).toEqual({ success: true })
    expect(setDevFolder('~/hive-projects/', makeDeps())).toEqual({ success: true })
    expect(store.stored()).toEqual({ path: null, previousPaths: [other] })

    expect(setDevFolder(other, makeDeps())).toEqual({ success: true })
    symlinkSync(defaultFolder, join(root, 'shortcut'))
    expect(setDevFolder(join(root, 'shortcut'), makeDeps())).toEqual({ success: true })
    expect(store.stored()).toEqual({ path: null, previousPaths: [other] })
  })

  it('writes nothing when the default folder is chosen by its path while it is in effect', () => {
    expect(setDevFolder(defaultFolder, makeDeps())).toEqual({ success: true })
    expect(setDevFolder('~/hive-projects', makeDeps())).toEqual({ success: true })
    expect(store.writes).toEqual([])
  })

  it('writes nothing for null while the default is in effect', () => {
    expect(setDevFolder(null, makeDeps())).toEqual({ success: true })
    expect(store.writes).toEqual([])
    expect(existsSync(defaultFolder)).toBe(false)
  })

  it('goes back to the default for null', () => {
    const other = join(root, 'Dev')
    expect(setDevFolder(other, makeDeps())).toEqual({ success: true })
    expect(setDevFolder(null, makeDeps())).toEqual({ success: true })
    expect(store.stored()).toEqual({ path: null, previousPaths: [other] })
  })

  it('accepts null without looking at the disk or the project list', () => {
    store = memoryStore(rowOf(join(root, 'Dev')))
    const deps = makeDeps({
      // Even a default folder that would be refused by path can be gone back to.
      reservedFolders: [home, defaultFolder],
      registeredFolders: () => {
        throw new Error('not consulted')
      }
    })
    expect(setDevFolder(null, deps)).toEqual({ success: true })
    expect(store.stored()).toEqual({ path: null, previousPaths: [join(root, 'Dev')] })
    expect(existsSync(defaultFolder)).toBe(false)
    expect(existsSync(join(root, 'Dev'))).toBe(false)
  })

  it.skipIf(isWindows)('cleans a row whose path the platform cannot use, for null', () => {
    const before = join(root, 'before')
    store = memoryStore(rowOf('C:\\Dev', [before, defaultFolder]))
    const holdsProjects = vi.fn(() => false)
    expect(readDevFolderState(store, home).isDefault).toBe(true)
    expect(setDevFolder(null, makeDeps({ holdsProjects }))).toEqual({ success: true })
    expect(store.stored()).toEqual({ path: null, previousPaths: [before] })
    // The folder in effect did not change, so no folder is forgotten.
    expect(holdsProjects).not.toHaveBeenCalled()
  })
})

describe('setDevFolder: the folders used before', () => {
  /** Folders that still hold a registered project, by the spelling the row stores. */
  let holding: Set<string>
  let deps: SetDevFolderDeps
  let b: string
  let c: string
  let d: string

  beforeEach(() => {
    holding = new Set()
    deps = makeDeps({ holdsProjects: (folder) => holding.has(folder) })
    b = join(root, 'B')
    c = join(root, 'C')
    d = join(root, 'D')
  })

  const change = (input: string | null): StoredDevFolder => {
    expect(setDevFolder(input, deps)).toEqual({ success: true })
    return store.stored()
  }

  it('default, then B, then C: projects still in the default stay reachable', () => {
    holding.add(defaultFolder)
    expect(change(b)).toEqual({ path: b, previousPaths: [defaultFolder] })
    expect(change(c)).toEqual({ path: c, previousPaths: [b, defaultFolder] })
  })

  it('default, then B, then C: an empty default is forgotten, the folder just left is kept', () => {
    expect(change(b)).toEqual({ path: b, previousPaths: [defaultFolder] })
    expect(change(c)).toEqual({ path: c, previousPaths: [b] })
  })

  it('B, then back to the default', () => {
    holding.add(defaultFolder)
    change(b)
    expect(change(null)).toEqual({ path: null, previousPaths: [b] })
    expect(previousDevFolders(store, home)).toEqual([b])
  })

  it('set, use default, set again', () => {
    holding.add(b)
    expect(change(b)).toEqual({ path: b, previousPaths: [defaultFolder] })
    expect(change(null)).toEqual({ path: null, previousPaths: [b] })
    expect(change(b)).toEqual({ path: b, previousPaths: [defaultFolder] })
  })

  it('set, use default, set another: the first folder stays while it holds projects', () => {
    holding.add(b)
    change(b)
    change(null)
    expect(change(c)).toEqual({ path: c, previousPaths: [defaultFolder, b] })
    holding.delete(b)
    expect(change(d)).toEqual({ path: d, previousPaths: [c] })
  })

  it('going back to a folder used before takes it off the list', () => {
    holding.add(defaultFolder).add(b)
    change(b)
    expect(change(c)).toEqual({ path: c, previousPaths: [b, defaultFolder] })
    expect(change(b)).toEqual({ path: b, previousPaths: [c, defaultFolder] })
  })

  it('forgets a folder at the next change once no project is left in it', () => {
    holding.add(defaultFolder).add(b)
    change(b)
    expect(change(c)).toEqual({ path: c, previousPaths: [b, defaultFolder] })
    // "Move projects" emptied B. Nothing changes until the folder does.
    holding.delete(b)
    expect(previousDevFolders(store, home)).toEqual([b, defaultFolder])
    expect(change(d)).toEqual({ path: d, previousPaths: [c, defaultFolder] })
  })

  it('does not ask whether the folder just left or the folder entered hold projects', () => {
    const holdsProjects = vi.fn(() => true)
    deps = makeDeps({ holdsProjects })
    change(b)
    expect(holdsProjects).not.toHaveBeenCalled()
    change(c)
    expect(holdsProjects.mock.calls).toEqual([[defaultFolder]])
    holdsProjects.mockClear()
    change(b)
    expect(holdsProjects.mock.calls).toEqual([[defaultFolder]])
  })

  it('keeps a folder once when the row holds it under two spellings', () => {
    mkdirSync(defaultFolder)
    symlinkSync(defaultFolder, join(root, 'default-alias'))
    store = memoryStore(rowOf(b, [join(root, 'default-alias'), defaultFolder, `${c}/x/..`]))
    deps = makeDeps()
    mkdirSync(c)
    expect(change(c)).toEqual({ path: c, previousPaths: [b, join(root, 'default-alias')] })
  })

  it(`keeps at most ${DEV_FOLDER_MAX_PREVIOUS} folders, the most recent first`, () => {
    deps = makeDeps()
    const folders = Array.from({ length: DEV_FOLDER_MAX_PREVIOUS + 5 }, (_, index) =>
      join(root, `folder-${index}`)
    )
    for (const folder of folders) change(folder)
    const expected = folders.slice(0, -1).reverse().slice(0, DEV_FOLDER_MAX_PREVIOUS)
    // The row as written, not as the parser reads it back (the parser has a cap of its own).
    const written = JSON.parse(store.writes[store.writes.length - 1]) as StoredDevFolder
    expect(written.previousPaths).toEqual(expected)
    expect(written.previousPaths).not.toContain(defaultFolder)
    expect(previousDevFolders(store, home)).toEqual(expected)
  })
})

describe('createLiveSetDevFolderDeps', () => {
  interface FakeRows {
    readonly projects?: { id: string; name: string; path: string; kind?: 'git' | 'connection' }[]
    readonly worktrees?: {
      project_id: string
      name: string
      path: string
      status: 'active' | 'archived'
    }[]
    readonly connections?: { name: string; custom_name: string | null; path: string }[]
    readonly dbPath?: string
  }

  const fakeDatabase = (rows: FakeRows = {}): DatabaseService =>
    ({
      getSetting: store.getSetting,
      setSetting: store.setSetting,
      getAllProjects: () => rows.projects ?? [],
      getWorktreesByProject: (projectId: string) =>
        (rows.worktrees ?? []).filter((worktree) => worktree.project_id === projectId),
      getAllConnections: () => rows.connections ?? [],
      getDbPath: () => rows.dbPath ?? ':memory:'
    }) as unknown as DatabaseService

  it('reserves the folders of the app and of Claude in the home directory', () => {
    const deps = createLiveSetDevFolderDeps(fakeDatabase(), { home, env: {} })
    expect(deps.home).toBe(home)
    expect(deps.reservedFolders).toEqual([
      join(home, '.hive'),
      join(home, '.hive-worktrees'),
      join(home, '.claude')
    ])
  })

  it('reserves the Claude config directory, the server base directory and the database folder', () => {
    const deps = createLiveSetDevFolderDeps(
      fakeDatabase({ dbPath: join(root, 'data', 'userdata', 'state.sqlite') }),
      {
        home,
        env: {
          CLAUDE_CONFIG_DIR: ` ${join(root, 'claude-work')} , ~/claude-personal`,
          HIVE_SERVER_BASE_DIR: join(root, 'data')
        }
      }
    )
    expect(deps.reservedFolders).toEqual(
      expect.arrayContaining([
        join(home, '.hive'),
        join(home, '.hive-worktrees'),
        join(home, '.claude'),
        join(root, 'claude-work'),
        join(home, 'claude-personal'),
        join(root, 'data'),
        join(root, 'data', 'userdata')
      ])
    )
    expect(errorOf(setDevFolder(join(root, 'data', 'projects'), deps))).toContain(
      join(root, 'data')
    )
    expect(errorOf(setDevFolder(join(root, 'claude-work'), deps))).toContain(
      join(root, 'claude-work')
    )
    expect(existsSync(join(root, 'data'))).toBe(false)
  })

  it('does not reserve the home directory or anything above it', () => {
    const deps = createLiveSetDevFolderDeps(fakeDatabase({ dbPath: join(home, 'hive.db') }), {
      home,
      env: {
        CLAUDE_CONFIG_DIR: home,
        HIVE_SERVER_BASE_DIR: root
      }
    })
    expect(deps.reservedFolders).toEqual([
      join(home, '.hive'),
      join(home, '.hive-worktrees'),
      join(home, '.claude')
    ])
    expect(setDevFolder('~/Dev', deps)).toEqual({ success: true })
  })

  it('lists every project, worktree and connection folder with a name', () => {
    const deps = createLiveSetDevFolderDeps(
      fakeDatabase({
        projects: [
          { id: 'p1', name: 'app', path: join(root, 'code', 'app') },
          { id: 'p2', name: 'app + api', path: join(root, 'saved', 'app-api'), kind: 'connection' }
        ],
        worktrees: [
          { project_id: 'p1', name: 'main', path: join(root, 'code', 'app'), status: 'active' },
          { project_id: 'p1', name: 'feature', path: join(root, 'trees', 'f'), status: 'active' },
          { project_id: 'p1', name: 'old', path: join(root, 'trees', 'old'), status: 'archived' }
        ],
        connections: [
          { name: 'app-api', custom_name: null, path: join(root, 'links', 'one') },
          { name: 'app-api-2', custom_name: 'Release', path: join(root, 'links', 'two') }
        ]
      }),
      { home, env: {} }
    )
    expect(deps.registeredFolders()).toEqual([
      { path: join(root, 'code', 'app'), label: 'the project "app"' },
      { path: join(root, 'saved', 'app-api'), label: 'the connection project "app + api"' },
      { path: join(root, 'trees', 'f'), label: 'the worktree "feature" of "app"' },
      { path: join(root, 'trees', 'old'), label: 'the worktree "old" of "app"' },
      { path: join(root, 'links', 'one'), label: 'the connection "app-api"' },
      { path: join(root, 'links', 'two'), label: 'the connection "Release"' }
    ])
  })

  it('says a folder holds projects when a git project sits directly in it', () => {
    mkdirSync(join(root, 'old', 'app'), { recursive: true })
    symlinkSync(join(root, 'old'), join(root, 'old-alias'))
    const deps = createLiveSetDevFolderDeps(
      fakeDatabase({
        projects: [
          { id: 'p1', name: 'app', path: join(root, 'old-alias', 'app') },
          { id: 'p2', name: 'saved', path: join(root, 'saved', 'x'), kind: 'connection' },
          { id: 'p3', name: 'deep', path: join(root, 'nested', 'group', 'deep'), kind: 'git' },
          { id: 'p4', name: 'odd', path: 'relative-project' }
        ]
      }),
      { home, env: {} }
    )
    expect(deps.holdsProjects(join(root, 'old'))).toBe(true)
    expect(deps.holdsProjects(join(root, 'old-alias'))).toBe(true)
    expect(deps.holdsProjects(join(root, 'nested', 'group'))).toBe(true)
    expect(deps.holdsProjects(join(root, 'nested'))).toBe(false)
    expect(deps.holdsProjects(join(root, 'saved'))).toBe(false)
    expect(deps.holdsProjects(root)).toBe(false)
    expect(deps.holdsProjects(process.cwd())).toBe(false)
  })

  it('changes the folder through the database it was given', () => {
    const project = join(root, 'old', 'app')
    mkdirSync(project, { recursive: true })
    const rows: FakeRows = { projects: [{ id: 'p1', name: 'app', path: project }] }
    const deps = createLiveSetDevFolderDeps(fakeDatabase(rows), { home, env: {} })

    expect(errorOf(setDevFolder(join(project, 'clones'), deps))).toBe(
      `The dev folder cannot be inside the project "app" (${project}).`
    )
    expect(errorOf(setDevFolder('~/.hive-worktrees/app', deps))).toContain(
      join(home, '.hive-worktrees')
    )
    expect(store.writes).toEqual([])

    expect(setDevFolder(join(root, 'old'), deps)).toEqual({ success: true })
    expect(setDevFolder(join(root, 'new'), deps)).toEqual({ success: true })
    expect(store.stored()).toEqual({ path: join(root, 'new'), previousPaths: [join(root, 'old')] })
    expect(setDevFolder(join(root, 'newer'), deps)).toEqual({ success: true })
    // The default folder never held a project and was forgotten; `old` still holds one.
    expect(store.stored()).toEqual({
      path: join(root, 'newer'),
      previousPaths: [join(root, 'new'), join(root, 'old')]
    })
  })
})
