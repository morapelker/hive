// Real files in temp directories. A move to another volume is forced on one volume through
// `isSameVolume`; on macOS some tests also use a throwaway disk image as a real second volume.
//
// The file is meant to pass under plain Node and under the app's own runtime
// (ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run …):
// the two differ in what `fs.cp` keeps and in how `fs` sees `.asar` files. The tests use the
// same unpatched `fs` as the port, or Electron's `fs` would misread the trees they build.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMoveProjectsFs, diskFs as fs, type MoveProjectsFsOverrides } from '../fs-ports'

const isDarwin = process.platform === 'darwin'
/** Permissions do not stop root. */
const isRoot = process.getuid?.() === 0
const hasPipes = process.platform !== 'win32'
const CHANGED = /the project changed while it was being copied; try again/

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...IDENTITY },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()

const write = (path: string, text: string, mode?: number): void => {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, text)
  if (mode !== undefined) fs.chmodSync(path, mode)
}

/** Removes a test tree whatever the test left in it: read-only folders, files that refuse removal. */
const wipe = (path: string): void => {
  if (!fs.existsSync(path)) return
  if (isDarwin) spawnSync('chflags', ['-R', 'nouchg', path])
  spawnSync('chmod', ['-R', 'u+rwx', path])
  fs.rmSync(path, { recursive: true, force: true })
}

interface Snapshot {
  /** Path below the root → what is there: kind, mode, and contents or link target. */
  readonly entries: Record<string, string>
  /** Path below the root → modification time, of files and folders. */
  readonly times: Record<string, number>
}

/** Everything in a tree that a copy has to keep. Pipes and sockets are listed without detail. */
const snapshot = (root: string): Snapshot => {
  const entries: Record<string, string> = {}
  const times: Record<string, number> = {}
  const pending = ['']
  while (pending.length > 0) {
    const rel = pending.pop() as string
    for (const name of fs.readdirSync(join(root, rel)).sort()) {
      const path = join(root, rel, name)
      const key = join(rel, name)
      const stat = fs.lstatSync(path)
      const mode = (stat.mode & 0o7777).toString(8)
      if (stat.isSymbolicLink()) entries[key] = `link -> ${fs.readlinkSync(path)}`
      else if (stat.isDirectory()) {
        entries[key] = `dir ${mode}`
        times[key] = stat.mtimeMs
        pending.push(key)
      } else if (stat.isFile()) {
        const sha = createHash('sha1').update(fs.readFileSync(path)).digest('hex')
        entries[key] = `file ${mode} ${stat.size} ${sha}`
        times[key] = stat.mtimeMs
      } else entries[key] = 'special'
    }
  }
  return { entries, times }
}

const withoutSpecial = (entries: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== 'special'))

/** Times survive a copy to the millisecond, not beyond. */
const expectSameTimes = (copy: Snapshot, source: Snapshot): void => {
  for (const [key, time] of Object.entries(copy.times)) {
    expect(Math.abs(time - source.times[key]), `modification time of ${key}`).toBeLessThan(2)
  }
}

const tempFolders = (parent: string): string[] =>
  fs.readdirSync(parent).filter((name) => name.startsWith('.hive-moving-'))

const OLD = new Date('2020-01-02T03:04:05.678Z')

/** A project with everything a copy can get wrong. */
const buildProject = (dir: string): void => {
  write(join(dir, 'README.md'), '# project\n')
  write(join(dir, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n', 0o755)
  write(join(dir, 'src', 'deep', 'a', 'b', 'c.txt'), 'deep\n')
  write(join(dir, 'src', 'with space.txt'), 'space\n')
  write(join(dir, 'src', 'naïve café.txt'), 'accents\n')
  write(join(dir, 'src', '-dash.txt'), 'dash\n')
  // Electron's `fs` reads a file with this ending as a folder.
  write(join(dir, 'vendor', 'packed.asar'), 'not really an archive\n')
  fs.mkdirSync(join(dir, 'empty'))
  fs.mkdirSync(join(dir, 'empty-outer', 'empty-inner'), { recursive: true })
  write(join(dir, 'locked', 'sub', 'x.txt'), 'x\n')
  write(join(dir, 'locked', 'readonly.txt'), 'read only\n', 0o444)
  fs.mkdirSync(join(dir, 'links'))
  fs.symlinkSync('../README.md', join(dir, 'links', 'relative'))
  fs.symlinkSync(join(dir, 'bin', 'run.sh'), join(dir, 'links', 'absolute'))
  fs.symlinkSync('nowhere/at/all', join(dir, 'links', 'dangling'))
  fs.symlinkSync('../src', join(dir, 'links', 'folder'))
  fs.symlinkSync(tmpdir(), join(dir, 'links', 'outside'))
  if (hasPipes) execFileSync('mkfifo', [join(dir, 'pipe')])
  fs.utimesSync(join(dir, 'src', 'deep', 'a', 'b', 'c.txt'), OLD, OLD)
  fs.utimesSync(join(dir, 'empty'), OLD, OLD)
  fs.utimesSync(join(dir, 'locked', 'sub'), OLD, OLD)
  fs.chmodSync(join(dir, 'locked', 'sub'), 0o555)
  fs.chmodSync(join(dir, 'locked'), 0o555)
}

const otherVolume = (
  overrides: MoveProjectsFsOverrides = {}
): ReturnType<typeof createMoveProjectsFs> =>
  createMoveProjectsFs({ isSameVolume: () => false, ...overrides })

let root: string
let from: string
let devFolder: string
let to: string

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'dev-folder-fs-')))
  from = join(root, 'old', 'project')
  devFolder = join(root, 'dev')
  to = join(devFolder, 'project')
  fs.mkdirSync(join(root, 'old'))
  fs.mkdirSync(devFolder)
})

afterEach(() => {
  wipe(root)
})

describe('kind, canonical, sameFolder, mkdirp', () => {
  it('tells what is at a path without following links', () => {
    const port = createMoveProjectsFs()
    write(join(root, 'file.txt'), 'x')
    fs.symlinkSync('nowhere', join(root, 'dangling'))
    fs.symlinkSync(devFolder, join(root, 'to-folder'))
    expect(port.kind(devFolder)).toBe('dir')
    expect(port.kind(join(root, 'file.txt'))).toBe('file')
    expect(port.kind(join(root, 'dangling'))).toBe('symlink')
    expect(port.kind(join(root, 'to-folder'))).toBe('symlink')
    expect(port.kind(join(root, 'missing'))).toBeNull()
    expect(port.kind(join(root, 'file.txt', 'below-a-file'))).toBeNull()
    // A file Electron's `fs` would call a folder.
    write(join(root, 'packed.asar'), 'not an archive')
    expect(port.kind(join(root, 'packed.asar'))).toBe('file')
  })

  it.skipIf(isRoot)('does not call a path free when it cannot look', () => {
    write(join(root, 'closed', 'inside.txt'), 'x')
    fs.chmodSync(join(root, 'closed'), 0o000)
    expect(createMoveProjectsFs().kind(join(root, 'closed', 'inside.txt'))).toBe('other')
  })

  it.skipIf(!hasPipes)('calls a pipe "other"', () => {
    execFileSync('mkfifo', [join(root, 'pipe')])
    expect(createMoveProjectsFs().kind(join(root, 'pipe'))).toBe('other')
  })

  it('resolves real paths and compares folders through links', () => {
    const port = createMoveProjectsFs()
    fs.symlinkSync(devFolder, join(root, 'link'))
    expect(port.canonical(join(root, 'link'))).toBe(devFolder)
    expect(port.canonical(join(root, 'missing'))).toBeNull()
    expect(port.sameFolder(join(root, 'link'), devFolder)).toBe(true)
    expect(port.sameFolder(join(root, 'old'), devFolder)).toBe(false)
  })

  it('makes a folder with its parents, and accepts one that is there', async () => {
    const port = createMoveProjectsFs()
    await port.mkdirp(join(root, 'a', 'b', 'c'))
    await port.mkdirp(join(root, 'a', 'b', 'c'))
    expect(port.kind(join(root, 'a', 'b', 'c'))).toBe('dir')
  })
})

describe('prepareMove on one volume', () => {
  it('places the folder with one rename and can take it back', async () => {
    buildProject(from)
    const before = snapshot(from)
    const inode = fs.statSync(from).ino
    const prepared = await createMoveProjectsFs().prepareMove(from, to)

    expect(prepared).toMatchObject({ from, to, copied: false })
    // Nothing happened yet.
    expect(fs.existsSync(to)).toBe(false)
    expect(fs.readdirSync(devFolder)).toEqual([])

    prepared.place()
    expect(fs.existsSync(from)).toBe(false)
    expect(fs.statSync(to).ino).toBe(inode)
    expect(snapshot(to)).toEqual(before)

    prepared.undo()
    expect(fs.existsSync(to)).toBe(false)
    expect(fs.statSync(from).ino).toBe(inode)
    expect(snapshot(from)).toEqual(before)

    prepared.place()
    await prepared.abort()
    expect(await prepared.discardSource()).toBeNull()
    expect(snapshot(to)).toEqual(before)
    expect(fs.readdirSync(devFolder)).toEqual(['project'])
  })

  it('refuses to place onto something that appeared since, even an empty folder', async () => {
    write(join(from, 'a.txt'), 'a')
    const port = createMoveProjectsFs()

    const overFolder = await port.prepareMove(from, to)
    fs.mkdirSync(to)
    expect(() => overFolder.place()).toThrow(/something is already at/)
    expect(fs.readdirSync(to)).toEqual([])
    expect(fs.readFileSync(join(from, 'a.txt'), 'utf8')).toBe('a')
    fs.rmdirSync(to)

    const overLink = await port.prepareMove(from, to)
    fs.symlinkSync('nowhere', to)
    let thrown: unknown
    try {
      overLink.place()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'EEXIST' })
    expect(fs.readlinkSync(to)).toBe('nowhere')
    expect(fs.readFileSync(join(from, 'a.txt'), 'utf8')).toBe('a')
    fs.unlinkSync(to)

    // Free again: the same prepared move still works.
    overLink.place()
    expect(fs.readFileSync(join(to, 'a.txt'), 'utf8')).toBe('a')
  })

  it('rejects what cannot be a move at all', async () => {
    const port = createMoveProjectsFs()
    write(join(from, 'a.txt'), 'a')
    fs.symlinkSync(from, join(root, 'old', 'linked'))

    await expect(port.prepareMove(join(root, 'old', 'missing'), to)).rejects.toThrow(
      /is not a folder/
    )
    await expect(port.prepareMove(join(root, 'old', 'linked'), to)).rejects.toThrow(
      /is not a folder/
    )
    await expect(port.prepareMove(join(from, 'a.txt'), to)).rejects.toThrow(/is not a folder/)
    await expect(port.prepareMove(from, join(root, 'no-such-parent', 'project'))).rejects.toThrow(
      /does not exist/
    )
    fs.mkdirSync(to)
    await expect(port.prepareMove(from, to)).rejects.toThrow(/something is already at/)
    expect(fs.readdirSync(devFolder)).toEqual(['project'])
  })

  it('does not take a move back onto something that appeared where the folder was', async () => {
    write(join(from, 'a.txt'), 'a')
    const prepared = await createMoveProjectsFs().prepareMove(from, to)
    prepared.place()
    fs.mkdirSync(from)

    expect(() => prepared.undo()).toThrow(/something is already at/)
    expect(fs.readFileSync(join(to, 'a.txt'), 'utf8')).toBe('a')
    expect(fs.readdirSync(from)).toEqual([])
  })

  it('says so when the rename is refused across volumes, and copies on the next attempt', async () => {
    buildProject(from)
    const before = snapshot(from)
    let refuse = true
    const port = createMoveProjectsFs({
      renameSync: (source, target) => {
        if (refuse)
          throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
            code: 'EXDEV'
          })
        fs.renameSync(source, target)
      }
    })

    const renamed = await port.prepareMove(from, to)
    expect(renamed.copied).toBe(false)
    let thrown: unknown
    try {
      renamed.place()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'EXDEV' })
    expect(String((thrown as Error).message)).toMatch(/another volume/)
    expect(fs.existsSync(to)).toBe(false)
    expect(snapshot(from)).toEqual(before)

    // Remembered by the process, not by the port: the live one may be built per request.
    refuse = false
    const copied = await createMoveProjectsFs().prepareMove(from, to)
    expect(copied.copied).toBe(true)
    copied.place()
    expect(snapshot(to).entries).toEqual(withoutSpecial(before.entries))
  })

  it('removes what a copy that was cut short left in the folder, also when it only renames', async () => {
    write(join(from, 'a.txt'), 'a')
    const dead = spawnSync('git', ['--version']).pid
    const stale = [`.hive-moving-${dead}-AbC123`, `.hive-moving-${process.pid}-zzzzzz`]
    for (const name of stale) write(join(devFolder, name, 'project', 'half.txt'), 'half a copy')
    // A process that runs (this test's parent), and a folder that is somebody's.
    const kept = [`.hive-moving-${process.ppid}-yyyyyy`, 'someone-elses-project']
    for (const name of kept) write(join(devFolder, name, 'keep.txt'), 'keep')

    const prepared = await createMoveProjectsFs().prepareMove(from, to)

    expect(prepared.copied).toBe(false)
    expect(fs.readdirSync(devFolder).sort()).toEqual([...kept].sort())
    prepared.place()
    expect(fs.readdirSync(devFolder).sort()).toEqual([...kept, 'project'].sort())
  })
})

describe('copies', () => {
  it('says what prepareMove is going to do', async () => {
    write(join(from, 'a.txt'), 'a')
    const same = createMoveProjectsFs()
    const other = otherVolume()

    expect(same.copies?.(from, to)).toBe(false)
    expect(other.copies?.(from, to)).toBe(true)
    // Nothing was made or moved by asking.
    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(fs.existsSync(from)).toBe(true)

    const renamed = await same.prepareMove(from, to)
    expect(renamed.copied).toBe(false)
    const copied = await other.prepareMove(from, to)
    expect(copied.copied).toBe(true)
    await copied.abort()
  })

  it('goes by the nearest folder that exists when the destination is not made yet', () => {
    write(join(from, 'a.txt'), 'a')
    const asked: [string, string][] = []
    const port = createMoveProjectsFs({
      isSameVolume: (source, above) => {
        asked.push([source, above])
        return above !== devFolder
      }
    })
    const deep = join(devFolder, 'not', 'made', 'yet', 'project')

    expect(port.copies?.(from, deep)).toBe(true)
    expect(port.copies?.(from, to)).toBe(true)
    expect(port.copies?.(from, join(root, 'elsewhere', 'project'))).toBe(false)

    expect(asked).toEqual([
      [from, devFolder],
      [from, devFolder],
      [from, root]
    ])
    expect(fs.existsSync(join(devFolder, 'not'))).toBe(false)
    // Unforced, one volume is one volume however deep the destination is.
    expect(createMoveProjectsFs().copies?.(from, deep)).toBe(false)
  })

  it('remembers a rename that was refused between two folders, as prepareMove does', async () => {
    write(join(from, 'a.txt'), 'a')
    const port = createMoveProjectsFs({
      renameSync: () => {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      }
    })
    expect(port.copies?.(from, to)).toBe(false)
    const renamed = await port.prepareMove(from, to)
    expect(() => renamed.place()).toThrow(/another volume/)

    expect(port.copies?.(from, to)).toBe(true)
    // Another port of the same process, and another project between the same two folders.
    expect(createMoveProjectsFs().copies?.(from, to)).toBe(true)
    expect(createMoveProjectsFs().copies?.(join(root, 'old', 'other'), join(devFolder, 'x'))).toBe(
      true
    )
    // Not between other folders.
    fs.mkdirSync(join(root, 'dev2'))
    expect(createMoveProjectsFs().copies?.(from, join(root, 'dev2', 'project'))).toBe(false)
  })

  it('is false, and does not throw, when it cannot tell', () => {
    const port = createMoveProjectsFs()
    expect(port.copies?.(join(root, 'old', 'missing'), to)).toBe(false)
    expect(port.copies?.('', '')).toBe(false)
    const throwing = createMoveProjectsFs({
      isSameVolume: () => {
        throw new Error('cannot look')
      }
    })
    write(join(from, 'a.txt'), 'a')
    expect(throwing.copies?.(from, to)).toBe(false)
  })
})

describe('prepareMove to another volume', () => {
  it('copies everything, places the copy, and removes the source last', async () => {
    buildProject(from)
    const before = snapshot(from)
    const prepared = await otherVolume().prepareMove(from, to)

    expect(prepared).toMatchObject({ from, to, copied: true })
    // The copy waits in a hidden folder next to the destination; the source is as it was.
    expect(fs.existsSync(to)).toBe(false)
    const temps = tempFolders(devFolder)
    expect(temps).toHaveLength(1)
    expect(temps[0]).toMatch(new RegExp(`^\\.hive-moving-${process.pid}-[A-Za-z0-9]{6}$`))
    expect(fs.readdirSync(join(devFolder, temps[0]))).toEqual(['project'])
    expect(snapshot(from)).toEqual(before)

    prepared.place()
    const placed = snapshot(to)
    expect(placed.entries).toEqual(withoutSpecial(before.entries))
    expectSameTimes(placed, before)
    // Spot checks of what the comparison above stands for.
    expect(fs.readlinkSync(join(to, 'links', 'relative'))).toBe('../README.md')
    expect(fs.readlinkSync(join(to, 'links', 'absolute'))).toBe(join(from, 'bin', 'run.sh'))
    expect(fs.readlinkSync(join(to, 'links', 'dangling'))).toBe('nowhere/at/all')
    expect(fs.lstatSync(join(to, 'links', 'outside')).isSymbolicLink()).toBe(true)
    expect(fs.statSync(join(to, 'bin', 'run.sh')).mode & 0o777).toBe(0o755)
    expect(fs.statSync(join(to, 'locked')).mode & 0o777).toBe(0o555)
    expect(fs.statSync(join(to, 'locked', 'readonly.txt')).mode & 0o777).toBe(0o444)
    expect(fs.readdirSync(join(to, 'empty'))).toEqual([])
    expect(fs.readdirSync(join(to, 'empty-outer', 'empty-inner'))).toEqual([])
    expect(fs.lstatSync(join(to, 'vendor', 'packed.asar')).isFile()).toBe(true)
    expect(fs.existsSync(join(to, 'pipe'))).toBe(false)
    expect(fs.statSync(join(to, 'empty')).mtimeMs).toBe(OLD.getTime())
    expect(fs.statSync(join(to, 'locked', 'sub')).mtimeMs).toBe(OLD.getTime())
    expect(fs.statSync(join(to, 'src', 'deep', 'a', 'b', 'c.txt')).mtimeMs).toBe(OLD.getTime())
    // Still nothing written to the source.
    expect(snapshot(from)).toEqual(before)

    expect(await prepared.discardSource()).toBeNull()
    expect(fs.existsSync(from)).toBe(false)
    expect(fs.readdirSync(devFolder)).toEqual(['project'])
    expect(snapshot(to).entries).toEqual(placed.entries)
  })

  it('builds the whole copy itself when the first copy stops at an entry that went away', async () => {
    buildProject(from)
    const before = snapshot(from)
    const gone = (): Error => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })

    // Stopped before anything was copied.
    const nothing = await otherVolume({ copyTree: () => Promise.reject(gone()) }).prepareMove(
      from,
      to
    )
    nothing.place()
    const built = snapshot(to)
    expect(built.entries).toEqual(withoutSpecial(before.entries))
    expectSameTimes(built, before)
    expect(snapshot(from)).toEqual(before)
    wipe(to)

    // Stopped half-way: one subtree is there, the root's mode and the rest are not.
    const half = await otherVolume({
      copyTree: async (source, copy) => {
        await fs.promises.cp(join(source, 'src'), join(copy, 'src'), {
          recursive: true,
          preserveTimestamps: true
        })
        throw gone()
      }
    }).prepareMove(from, to)
    half.place()
    const mended = snapshot(to)
    expect(mended.entries).toEqual(withoutSpecial(before.entries))
    expectSameTimes(mended, before)
    expect(tempFolders(devFolder)).toHaveLength(2)
    await nothing.abort()
    await half.abort()
    expect(tempFolders(devFolder)).toEqual([])
  })

  it('copies again what was written, added, removed or replaced while it was copying', async () => {
    buildProject(from)
    const passes: number[] = []
    const prepared = await otherVolume({
      beforeVerifyPass: (pass) => {
        passes.push(pass)
        if (pass !== 1) return
        // Same size, other contents: only a second reading of the source can tell.
        fs.writeFileSync(join(from, 'README.md'), '# PROJECT\n')
        write(join(from, 'src', 'added.txt'), 'added\n')
        write(join(from, 'added', 'folder', 'file.txt'), 'added folder\n')
        fs.rmSync(join(from, 'bin', 'run.sh'))
        fs.rmSync(join(from, 'empty-outer'), { recursive: true })
        fs.unlinkSync(join(from, 'links', 'relative'))
        fs.symlinkSync('../src/added.txt', join(from, 'links', 'relative'))
        // A file becomes a folder, a folder becomes a file, a link becomes a file.
        fs.rmSync(join(from, 'src', 'with space.txt'))
        write(join(from, 'src', 'with space.txt', 'inside.txt'), 'inside\n')
        fs.rmdirSync(join(from, 'empty'))
        write(join(from, 'empty'), 'a file now\n')
        fs.unlinkSync(join(from, 'links', 'dangling'))
        write(join(from, 'links', 'dangling'), 'a file now\n')
        // Inside a read-only folder.
        fs.chmodSync(join(from, 'locked'), 0o755)
        fs.chmodSync(join(from, 'locked', 'readonly.txt'), 0o644)
        fs.writeFileSync(join(from, 'locked', 'readonly.txt'), 'READ ONLY\n')
        fs.chmodSync(join(from, 'locked', 'readonly.txt'), 0o444)
        write(join(from, 'locked', 'new.txt'), 'new\n')
        fs.chmodSync(join(from, 'locked'), 0o555)
      }
    }).prepareMove(from, to)
    const after = snapshot(from)

    // The pass that mended the copy does not count as proof; the next one found nothing.
    expect(passes).toEqual([1, 2])
    prepared.place()
    const placed = snapshot(to)
    expect(placed.entries).toEqual(withoutSpecial(after.entries))
    expectSameTimes(placed, after)
    expect(fs.readFileSync(join(to, 'README.md'), 'utf8')).toBe('# PROJECT\n')
    expect(fs.readFileSync(join(to, 'locked', 'readonly.txt'), 'utf8')).toBe('READ ONLY\n')
    expect(await prepared.discardSource()).toBeNull()
    expect(fs.existsSync(from)).toBe(false)
  })

  it('gives up on a source that keeps changing, and leaves nothing behind', async () => {
    buildProject(from)
    const passes: number[] = []
    const port = otherVolume({
      beforeVerifyPass: (pass) => {
        passes.push(pass)
        fs.writeFileSync(join(from, 'README.md'), `# pass ${pass}\n`)
      }
    })

    await expect(port.prepareMove(from, to)).rejects.toThrow(CHANGED)

    expect(passes).toEqual([1, 2, 3])
    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(fs.readFileSync(join(from, 'README.md'), 'utf8')).toBe('# pass 3\n')
    expect(fs.statSync(join(from, 'locked')).mode & 0o777).toBe(0o555)
  })

  it('rejects, leaving nothing behind, when the folder cannot be copied', async () => {
    buildProject(from)
    const before = snapshot(from)
    const port = otherVolume({
      copyTree: async (source, copy) => {
        // A read-only folder is in the part that was copied before the failure.
        await fs.promises.cp(join(source, 'locked'), join(copy, 'locked'), { recursive: true })
        fs.chmodSync(join(copy, 'locked'), 0o555)
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
    })

    await expect(port.prepareMove(from, to)).rejects.toThrow(
      /the folder could not be copied: ENOSPC: no space left on device/
    )

    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(snapshot(from)).toEqual(before)
  })

  it.skipIf(isRoot)('rejects when a file or a folder of the source cannot be read', async () => {
    write(join(from, 'a.txt'), 'a')
    write(join(from, 'secret.txt'), 'secret', 0o000)

    await expect(otherVolume().prepareMove(from, to)).rejects.toThrow(
      /the folder could not be copied: EACCES.*secret\.txt/
    )
    expect(fs.readdirSync(devFolder)).toEqual([])

    fs.rmSync(join(from, 'secret.txt'))
    write(join(from, 'secret', 'inside.txt'), 'secret')
    fs.chmodSync(join(from, 'secret'), 0o000)

    await expect(otherVolume().prepareMove(from, to)).rejects.toThrow(
      /the folder could not be copied: EACCES.*secret/
    )
    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(fs.readFileSync(join(from, 'a.txt'), 'utf8')).toBe('a')
  })

  it('refuses to place onto something that appeared since; abort then removes the copy', async () => {
    buildProject(from)
    const before = snapshot(from)
    const prepared = await otherVolume().prepareMove(from, to)
    fs.mkdirSync(to)

    expect(() => prepared.place()).toThrow(/something is already at/)
    expect(fs.readdirSync(to)).toEqual([])
    expect(tempFolders(devFolder)).toHaveLength(1)

    await prepared.abort()
    expect(fs.readdirSync(devFolder)).toEqual(['project'])
    expect(snapshot(from)).toEqual(before)
    expect(() => prepared.place()).toThrow(/was removed/)
  })

  it('takes a placed copy back into its hidden folder, in one step each way', async () => {
    buildProject(from)
    const before = snapshot(from)
    const prepared = await otherVolume().prepareMove(from, to)
    const temp = join(devFolder, tempFolders(devFolder)[0])

    prepared.place()
    expect(fs.readdirSync(temp)).toEqual([])
    prepared.undo()
    expect(fs.existsSync(to)).toBe(false)
    expect(snapshot(join(temp, 'project')).entries).toEqual(withoutSpecial(before.entries))
    // Undone twice is undone once.
    prepared.undo()

    prepared.place()
    expect(snapshot(to).entries).toEqual(withoutSpecial(before.entries))
    prepared.undo()
    await prepared.abort()
    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(snapshot(from)).toEqual(before)
  })

  it('never removes a copy that is in place, and never the source of one that is not', async () => {
    buildProject(from)
    const before = snapshot(from)
    const prepared = await otherVolume().prepareMove(from, to)

    // Not placed: there is no old copy to discard, the source is the project.
    expect(await prepared.discardSource()).toBeNull()
    expect(snapshot(from)).toEqual(before)
    expect(tempFolders(devFolder)).toHaveLength(1)

    prepared.place()
    await prepared.abort()
    expect(snapshot(to).entries).toEqual(withoutSpecial(before.entries))
    expect(fs.readdirSync(devFolder)).toEqual(['project'])
    expect(snapshot(from)).toEqual(before)
  })

  it(
    'keeps a source that was written to after it was copied, and says where',
    { timeout: 60_000 },
    async () => {
      const changes: [string, (dir: string) => void, string][] = [
        [
          'a file rewritten',
          (dir) => fs.writeFileSync(join(dir, 'README.md'), '# PROJECT\n'),
          'the folder itself'
        ],
        ['a file added', (dir) => write(join(dir, 'src', 'late.txt'), 'late\n'), 'src'],
        ['a file removed', (dir) => fs.rmSync(join(dir, 'src', '-dash.txt')), 'src'],
        ['an empty folder added', (dir) => fs.mkdirSync(join(dir, 'src', 'late')), 'src'],
        [
          'a folder removed',
          (dir) => fs.rmSync(join(dir, 'empty-outer', 'empty-inner'), { recursive: true }),
          'empty-outer'
        ],
        [
          'a link pointed elsewhere',
          (dir) => {
            fs.unlinkSync(join(dir, 'links', 'relative'))
            fs.symlinkSync('../bin/run.sh', join(dir, 'links', 'relative'))
          },
          'links'
        ],
        [
          'a file made executable',
          (dir) => fs.chmodSync(join(dir, 'README.md'), 0o755),
          'the folder itself'
        ],
        [
          'a file written deep down',
          (dir) => fs.writeFileSync(join(dir, 'src', 'deep', 'a', 'b', 'c.txt'), 'DEEP\n'),
          join('src', 'deep', 'a', 'b')
        ]
      ]
      for (const [what, change, where] of changes) {
        const source = join(root, 'old', `project ${what}`)
        const target = join(devFolder, basename(source))
        buildProject(source)
        const prepared = await otherVolume().prepareMove(source, target)
        prepared.place()
        change(source)
        const kept = snapshot(source)

        expect(await prepared.discardSource(), what).toEqual({
          path: source,
          reason: 'changed',
          detail: `what changed is in ${where}`
        })

        expect(snapshot(source), what).toEqual(kept)
        expect(tempFolders(devFolder), what).toEqual([])
      }
    }
  )

  it('names the first three folders that differ and counts the rest', async () => {
    buildProject(from)
    const prepared = await otherVolume().prepareMove(from, to)
    prepared.place()
    write(join(from, 'late.txt'), 'late\n')
    write(join(from, 'bin', 'late.txt'), 'late\n')
    write(join(from, 'empty', 'late.txt'), 'late\n')
    write(join(from, 'src', 'late.txt'), 'late\n')

    expect(await prepared.discardSource()).toEqual({
      path: from,
      reason: 'changed',
      detail: 'what changed is in the folder itself, bin, empty and 1 more folder'
    })

    write(join(from, 'vendor', 'late.txt'), 'late\n')
    expect((await prepared.discardSource())?.detail).toBe(
      'what changed is in the folder itself, bin, empty and 2 more folders'
    )
    expect(fs.readFileSync(join(from, 'README.md'), 'utf8')).toBe('# project\n')
  })

  it('does not keep a source for a .DS_Store that Finder wrote into it', async () => {
    buildProject(from)
    // One that was there all along is copied like any other file.
    write(join(from, 'bin', '.DS_Store'), 'as it was')
    const prepared = await otherVolume().prepareMove(from, to)
    prepared.place()
    expect(fs.readFileSync(join(to, 'bin', '.DS_Store'), 'utf8')).toBe('as it was')
    // The old folder is looked at in Finder while the move finishes.
    write(join(from, '.DS_Store'), 'written by Finder')
    write(join(from, 'src', 'deep', '.DS_Store'), 'written by Finder')
    fs.writeFileSync(join(from, 'bin', '.DS_Store'), 'written again, longer')

    expect(await prepared.discardSource()).toBeNull()

    expect(fs.existsSync(from)).toBe(false)
    expect(fs.readdirSync(devFolder)).toEqual(['project'])
  })

  it('still keeps a source for anything else by that name, or with a name like it', async () => {
    const changes: [string, (dir: string) => void][] = [
      ['a folder named .DS_Store', (dir) => fs.mkdirSync(join(dir, 'src', '.DS_Store'))],
      ['a link named .DS_Store', (dir) => fs.symlinkSync('README.md', join(dir, '.DS_Store'))],
      ['a file named .DS_Store2', (dir) => write(join(dir, '.DS_Store2'), 'x')]
    ]
    for (const [what, change] of changes) {
      const source = join(root, 'old', `project ${what}`)
      const target = join(devFolder, basename(source))
      write(join(source, 'README.md'), '# project\n')
      write(join(source, 'src', 'a.txt'), 'a\n')
      const prepared = await otherVolume().prepareMove(source, target)
      prepared.place()
      change(source)

      expect(await prepared.discardSource(), what).toMatchObject({ reason: 'changed' })
      expect(fs.existsSync(join(source, 'README.md')), what).toBe(true)
    }
  })

  it('keeps the source when the new copy is gone or the source cannot be read any more', async () => {
    write(join(from, 'a.txt'), 'a')
    const vanished = await otherVolume().prepareMove(from, to)
    vanished.place()
    fs.renameSync(to, join(root, 'taken-away'))

    expect(await vanished.discardSource()).toMatchObject({ path: from, reason: 'changed' })
    expect(fs.readFileSync(join(from, 'a.txt'), 'utf8')).toBe('a')

    if (isRoot) return
    write(join(from, 'sub', 'b.txt'), 'b')
    const unreadable = await otherVolume().prepareMove(from, to)
    unreadable.place()
    fs.chmodSync(join(from, 'sub'), 0o000)

    expect(await unreadable.discardSource()).toMatchObject({ path: from, reason: 'changed' })
    fs.chmodSync(join(from, 'sub'), 0o755)
    expect(fs.readFileSync(join(from, 'sub', 'b.txt'), 'utf8')).toBe('b')
    expect(tempFolders(devFolder)).toEqual([])
  })

  it('does not take reading the source, or a lock file that came and went, for a change', async () => {
    buildProject(from)
    const prepared = await otherVolume().prepareMove(from, to)
    prepared.place()
    // Read everything, and let something appear and disappear in a folder.
    snapshot(from)
    write(join(from, 'src', 'index.lock'), '')
    fs.rmSync(join(from, 'src', 'index.lock'))

    expect(await prepared.discardSource()).toBeNull()
    expect(fs.existsSync(from)).toBe(false)
  })

  it.skipIf(!isDarwin)(
    'reports what is left when part of the source cannot be removed',
    async () => {
      buildProject(from)
      const prepared = await otherVolume().prepareMove(from, to)
      prepared.place()
      // A file that refuses removal whatever its folder's mode is.
      execFileSync('chflags', ['uchg', join(from, 'src', 'deep', 'a', 'b', 'c.txt')])

      const left = await prepared.discardSource()

      expect(left).toMatchObject({ path: from, reason: 'failed' })
      // It names what is left, and everything that could be removed is gone.
      expect(left?.detail).toMatch(/EPERM/)
      expect(left?.detail).toContain(join(from, 'src', 'deep', 'a', 'b', 'c.txt'))
      expect(snapshot(from).entries).toEqual({
        src: 'dir 755',
        'src/deep': 'dir 755',
        'src/deep/a': 'dir 755',
        'src/deep/a/b': 'dir 755',
        'src/deep/a/b/c.txt': expect.stringMatching(/^file 644 5 /)
      })
      expect(fs.readFileSync(join(to, 'src', 'deep', 'a', 'b', 'c.txt'), 'utf8')).toBe('deep\n')
      expect(tempFolders(devFolder)).toEqual([])
    }
  )

  it('removes temp folders of processes that are gone, and nothing else', async () => {
    write(join(from, 'a.txt'), 'a')
    const dead = spawnSync('git', ['--version']).pid
    const stale = [
      `.hive-moving-${dead}-AbC123`,
      // Left by an earlier process that had this process's number.
      `.hive-moving-${process.pid}-zzzzzz`
    ]
    for (const name of stale) {
      write(join(devFolder, name, 'project', 'locked', 'half.txt'), 'half a copy')
      fs.chmodSync(join(devFolder, name, 'project', 'locked'), 0o555)
    }
    const untouched = [
      // A process that runs (this test's parent).
      `.hive-moving-${process.ppid}-yyyyyy`,
      '.hive-moving-notapid-xxxxxx',
      '.hive-moving-0-xxxxxx',
      `.hive-moving-${dead}`,
      '.hive-other',
      'moving',
      'someone-elses-project'
    ]
    for (const name of untouched) write(join(devFolder, name, 'keep.txt'), 'keep')
    // Named like a stale temp folder, but a file.
    write(join(devFolder, `.hive-moving-${dead}-File00`), 'a file')

    const prepared = await otherVolume().prepareMove(from, to)

    const now = fs.readdirSync(devFolder)
    for (const name of stale) expect(now).not.toContain(name)
    for (const name of untouched) {
      expect(fs.readFileSync(join(devFolder, name, 'keep.txt'), 'utf8')).toBe('keep')
    }
    expect(now).toContain(`.hive-moving-${dead}-File00`)
    // What was there and is kept, the file, and the temp folder of this move.
    expect(now).toHaveLength(untouched.length + 2)
    await prepared.abort()
    expect(fs.readdirSync(devFolder)).toHaveLength(untouched.length + 1)
  })

  it('keeps the temp folder of a move that is still waiting to be placed', async () => {
    // Two folders of one project: the checkout, and a worktree next to it.
    const worktree = join(root, 'old', 'project-feat')
    write(join(from, 'a.txt'), 'a')
    write(join(worktree, 'b.txt'), 'b')
    const port = otherVolume()

    const first = await port.prepareMove(from, to)
    const second = await port.prepareMove(worktree, join(devFolder, 'project-feat'))
    // Another port of the same process (the live one is built per request) keeps it too.
    const third = await otherVolume().prepareMove(from, join(devFolder, 'project-again'))

    expect(tempFolders(devFolder)).toHaveLength(3)
    first.place()
    second.place()
    third.place()
    expect(fs.readFileSync(join(to, 'a.txt'), 'utf8')).toBe('a')
    expect(fs.readFileSync(join(devFolder, 'project-feat', 'b.txt'), 'utf8')).toBe('b')
    expect(fs.readFileSync(join(devFolder, 'project-again', 'a.txt'), 'utf8')).toBe('a')
    await first.abort()
    await second.abort()
    await third.abort()
    expect(fs.readdirSync(devFolder).sort()).toEqual(['project', 'project-again', 'project-feat'])
  })

  it('asks the injected check which processes are alive', async () => {
    write(join(from, 'a.txt'), 'a')
    for (const name of [
      '.hive-moving-4242-AAAAAA',
      '.hive-moving-4243-BBBBBB',
      '.hive-moving-99-CCCCCC'
    ]) {
      write(join(devFolder, name, 'x.txt'), 'x')
    }
    const asked: number[] = []
    const port = otherVolume({
      pid: 99,
      isPidAlive: (pid) => {
        asked.push(pid)
        return pid === 4243
      }
    })

    const prepared = await port.prepareMove(from, to)

    // Its own number is never asked about: what it did not make itself under it is stale.
    expect(asked.sort()).toEqual([4242, 4243])
    const names = fs.readdirSync(devFolder).sort()
    expect(names).toHaveLength(2)
    expect(names[0]).toBe('.hive-moving-4243-BBBBBB')
    expect(names[1]).toMatch(/^\.hive-moving-99-[A-Za-z0-9]{6}$/)
    expect(names[1]).not.toBe('.hive-moving-99-CCCCCC')
    await prepared.abort()
    expect(fs.readdirSync(devFolder)).toEqual(['.hive-moving-4243-BBBBBB'])
  })

  it('refuses, before anything is copied, a volume that does not keep file permissions', async () => {
    buildProject(from)
    const before = snapshot(from)
    const asked: string[] = []
    let copies = 0
    const port = otherVolume({
      keepsPermissions: (dir) => {
        asked.push(dir)
        // It is asked about the folder the copy would be built in, which is there by now.
        expect(fs.statSync(dir).isDirectory()).toBe(true)
        return false
      },
      copyTree: async () => {
        copies += 1
      }
    })

    await expect(port.prepareMove(from, to)).rejects.toThrow(
      `the disk that holds ${devFolder} does not keep file permissions (exFAT or FAT), so a project cannot be moved there; choose a dev folder on a Mac-formatted disk`
    )

    expect(asked).toHaveLength(1)
    expect(dirname(asked[0])).toBe(devFolder)
    expect(basename(asked[0])).toMatch(/^\.hive-moving-\d+-[A-Za-z0-9]{6}$/)
    expect(copies).toBe(0)
    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(snapshot(from)).toEqual(before)
  })

  it('asks the volume itself, and leaves nothing of the question behind', async () => {
    write(join(from, 'a.txt'), 'a')
    let inside: string[] | null = null
    const prepared = await otherVolume({
      // The first thing that runs once the volume has answered.
      copyTree: async (source, copy) => {
        inside = fs.readdirSync(dirname(copy))
        await fs.promises.cp(source, copy, { recursive: true })
      }
    }).prepareMove(from, to)

    // This volume keeps permissions: the copy went ahead, into a folder that held nothing.
    expect(inside).toEqual([])
    expect(prepared.copied).toBe(true)
    await prepared.abort()
    expect(fs.readdirSync(devFolder)).toEqual([])
  })

  it('copes with a deep tree and a wide folder', { timeout: 120_000 }, async () => {
    let deepest = from
    for (let depth = 0; depth < 150; depth += 1) deepest = join(deepest, 'd')
    write(join(deepest, 'bottom.txt'), 'bottom\n')
    for (let index = 0; index < 1500; index += 1)
      write(join(from, 'wide', `file-${index}.txt`), `${index}\n`)
    const before = snapshot(from)

    const prepared = await otherVolume().prepareMove(from, to)
    prepared.place()

    expect(snapshot(to).entries).toEqual(before.entries)
    expect(Object.keys(before.entries)).toHaveLength(150 + 1 + 1 + 1500)
    expect(await prepared.discardSource()).toBeNull()
    expect(fs.existsSync(from)).toBe(false)
  })
})

describe('the repository while its folder is being copied', () => {
  /** A repository with a commit, a linked worktree elsewhere and a hand-made submodule store. */
  const buildRepository = (): string => {
    fs.mkdirSync(from)
    git(from, 'init', '-q', '-b', 'main')
    write(join(from, 'a.txt'), 'a\n')
    git(from, 'add', '.')
    git(from, 'commit', '-q', '-m', 'init')
    const worktree = join(root, 'elsewhere', 'wt')
    git(from, 'worktree', 'add', '-q', worktree, '-b', 'wt')
    write(join(from, '.git', 'modules', 'vendor', 'lib', 'HEAD'), 'ref: refs/heads/main\n')
    write(
      join(from, '.git', 'modules', 'vendor', 'lib', 'refs', 'heads', 'main'),
      `${'1'.repeat(40)}\n`
    )
    return worktree
  }

  it('places a copy of a repository nobody wrote to, and git works in it', async () => {
    buildRepository()
    const head = git(from, 'rev-parse', 'HEAD')
    const prepared = await otherVolume().prepareMove(from, to)
    // Reading does not count as writing.
    git(from, 'log', '--oneline')
    git(from, 'worktree', 'list', '--porcelain')
    git(from, 'rev-parse', 'HEAD')

    prepared.place()

    expect(git(to, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(to, 'status', '--short')).toBe('')
    expect(await prepared.discardSource()).toBeNull()
    expect(fs.existsSync(from)).toBe(false)
  })

  const later = new Date(Date.now() + 5000)
  const writes: [string, (gitDir: string) => void][] = [
    [
      'a branch moved',
      (gitDir) => fs.writeFileSync(join(gitDir, 'refs', 'heads', 'main'), `${'2'.repeat(40)}\n`)
    ],
    [
      'a branch added',
      (gitDir) => write(join(gitDir, 'refs', 'heads', 'feature', 'x'), `${'3'.repeat(40)}\n`)
    ],
    [
      'HEAD rewritten',
      (gitDir) => fs.writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/next\n')
    ],
    [
      'the index written again with the same size',
      (gitDir) => fs.utimesSync(join(gitDir, 'index'), later, later)
    ],
    ['refs packed', (gitDir) => write(join(gitDir, 'packed-refs'), '# pack-refs with: peeled\n')],
    ['a reflog line added', (gitDir) => fs.appendFileSync(join(gitDir, 'logs', 'HEAD'), 'more\n')],
    ['an object stored', (gitDir) => write(join(gitDir, 'objects', 'ff', 'e'.repeat(38)), 'x')],
    ['a pack added', (gitDir) => write(join(gitDir, 'objects', 'pack', 'pack-new.pack'), 'PACK')],
    [
      'HEAD of a linked worktree moved',
      (gitDir) => fs.writeFileSync(join(gitDir, 'worktrees', 'wt', 'HEAD'), `${'4'.repeat(40)}\n`)
    ],
    [
      'a worktree registered',
      (gitDir) => write(join(gitDir, 'worktrees', 'late', 'HEAD'), 'ref: refs/heads/late\n')
    ],
    [
      'a submodule branch moved',
      (gitDir) =>
        fs.writeFileSync(
          join(gitDir, 'modules', 'vendor', 'lib', 'refs', 'heads', 'main'),
          `${'5'.repeat(40)}\n`
        )
    ],
    ['a merge started', (gitDir) => write(join(gitDir, 'MERGE_HEAD'), `${'6'.repeat(40)}\n`)]
  ]

  it.each(writes)('refuses to place the copy after %s', async (_what, change) => {
    buildRepository()
    const prepared = await otherVolume().prepareMove(from, to)
    change(join(from, '.git'))
    const kept = snapshot(from)

    expect(() => prepared.place()).toThrow(CHANGED)

    // Nothing moved; the copy can be thrown away.
    expect(fs.existsSync(to)).toBe(false)
    expect(tempFolders(devFolder)).toHaveLength(1)
    await prepared.abort()
    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(snapshot(from)).toEqual(kept)
  })

  it('refuses to place the copy after a commit in a linked worktree elsewhere', async () => {
    const worktree = buildRepository()
    const prepared = await otherVolume().prepareMove(from, to)
    write(join(worktree, 'b.txt'), 'b\n')
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-q', '-m', 'work in the worktree')

    expect(() => prepared.place()).toThrow(CHANGED)
    await prepared.abort()
    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(git(from, 'log', '-1', '--format=%s', 'wt')).toBe('work in the worktree')
  })

  it('copies a commit made while the folder was being copied', async () => {
    const worktree = buildRepository()
    const prepared = await otherVolume({
      beforeVerifyPass: (pass) => {
        if (pass !== 1) return
        write(join(worktree, 'b.txt'), 'b\n')
        git(worktree, 'add', '.')
        git(worktree, 'commit', '-q', '-m', 'work during the copy')
      }
    }).prepareMove(from, to)

    prepared.place()

    expect(git(to, 'log', '-1', '--format=%s', 'wt')).toBe('work during the copy')
    expect(git(to, 'fsck', '--connectivity-only')).toBe('')
  })

  it('refuses to place a copy of a folder that became a repository since', async () => {
    write(join(from, 'a.txt'), 'a\n')
    const prepared = await otherVolume().prepareMove(from, to)
    git(from, 'init', '-q')

    expect(() => prepared.place()).toThrow(CHANGED)
    await prepared.abort()
  })
})

describe.skipIf(!isDarwin)('a real second volume (a throwaway disk image)', () => {
  let home: string
  let volume: string | null = null
  const ignoresCase = ((): boolean => {
    const probe = fs.mkdtempSync(join(tmpdir(), 'dev-folder-case-'))
    try {
      fs.mkdirSync(join(probe, 'CaseProbe'))
      return fs.existsSync(join(probe, 'caseprobe'))
    } finally {
      fs.rmSync(probe, { recursive: true, force: true })
    }
  })()

  beforeAll(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'dev-folder-volume-')))
    const image = join(home, 'disk.dmg')
    const mount = join(home, 'mount')
    fs.mkdirSync(mount)
    try {
      const quiet = { stdio: 'ignore' as const, timeout: 60_000 }
      execFileSync(
        'hdiutil',
        [
          'create',
          '-size',
          '32m',
          '-fs',
          'Case-sensitive APFS',
          '-volname',
          'dev-folder-test',
          image
        ],
        quiet
      )
      execFileSync('hdiutil', ['attach', image, '-nobrowse', '-mountpoint', mount], quiet)
      volume = fs.realpathSync.native(mount)
    } catch {
      // No disk images here (a sandbox, a CI machine): the tests below skip themselves.
      volume = null
    }
  }, 120_000)

  afterAll(() => {
    if (volume !== null) spawnSync('hdiutil', ['detach', volume, '-force'], { stdio: 'ignore' })
    wipe(home)
  }, 120_000)

  it('copies where a rename is refused, with nothing forced', async (context) => {
    if (volume === null) return context.skip()
    buildProject(from)
    const before = snapshot(from)
    const target = join(volume, 'project')
    expect(() => fs.renameSync(from, target)).toThrow(/EXDEV/)
    expect(createMoveProjectsFs().copies?.(from, target)).toBe(true)
    expect(createMoveProjectsFs().copies?.(from, join(volume, 'not', 'made', 'project'))).toBe(true)
    expect(createMoveProjectsFs().copies?.(from, to)).toBe(false)

    const prepared = await createMoveProjectsFs().prepareMove(from, target)

    expect(prepared.copied).toBe(true)
    expect(tempFolders(volume)).toHaveLength(1)
    prepared.place()
    const placed = snapshot(target)
    expect(placed.entries).toEqual(withoutSpecial(before.entries))
    expectSameTimes(placed, before)
    expect(await prepared.discardSource()).toBeNull()
    expect(fs.existsSync(from)).toBe(false)
    expect(tempFolders(volume)).toEqual([])
    wipe(target)
  })

  it('refuses a project whose names the destination volume would merge', async (context) => {
    if (volume === null || !ignoresCase) return context.skip()
    const source = join(volume, 'cased')
    // Same sizes: what is lost would not show in a count of bytes.
    write(join(source, 'Makefile'), 'UPPER\n')
    write(join(source, 'makefile'), 'lower\n')
    write(join(source, 'src', 'ok.txt'), 'ok\n')
    const before = snapshot(source)

    await expect(createMoveProjectsFs().prepareMove(source, to)).rejects.toThrow(
      /differ only by letter case or accents/
    )

    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(snapshot(source)).toEqual(before)
    wipe(source)
  })

  it('refuses a project with two folders the destination volume would merge', async (context) => {
    if (volume === null || !ignoresCase) return context.skip()
    const source = join(volume, 'cased-folders')
    // No two files collide: a copy that merges the folders loses nothing it can see.
    write(join(source, 'Docs', 'upper.md'), 'UPPER\n')
    write(join(source, 'docs', 'lower.md'), 'lower\n')
    const before = snapshot(source)

    await expect(createMoveProjectsFs().prepareMove(source, to)).rejects.toThrow(
      /differ only by letter case or accents/
    )

    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(snapshot(source)).toEqual(before)
    wipe(source)
  })

  it('refuses it also when the first copy merged the names without a word', async (context) => {
    if (volume === null || !ignoresCase) return context.skip()
    const source = join(volume, 'cased-quietly')
    write(join(source, 'docs', 'Guide.md'), 'UPPER\n')
    write(join(source, 'docs', 'guide.md'), 'lower\n')
    write(join(source, 'Lib', 'a.txt'), 'a\n')
    write(join(source, 'lib', 'b.txt'), 'b\n')
    const before = snapshot(source)
    // What a copy without `errorOnExist` does under the app's Node: the later name wins.
    const mergingCopy = async (sourceDir: string, copyDir: string): Promise<void> => {
      fs.mkdirSync(copyDir, { recursive: true })
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (entry.isDirectory())
          await mergingCopy(join(sourceDir, entry.name), join(copyDir, entry.name))
        else fs.copyFileSync(join(sourceDir, entry.name), join(copyDir, entry.name))
      }
    }

    await expect(
      createMoveProjectsFs({ copyTree: mergingCopy }).prepareMove(source, to)
    ).rejects.toThrow(/differ only by letter case or accents/)

    expect(fs.readdirSync(devFolder)).toEqual([])
    expect(snapshot(source)).toEqual(before)
    wipe(source)
  })
})

describe.skipIf(!isDarwin)(
  'a real volume that keeps no permissions (a throwaway exFAT image)',
  () => {
    let home: string
    let volume: string | null = null

    beforeAll(() => {
      home = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'dev-folder-exfat-')))
      const image = join(home, 'disk.dmg')
      const mount = join(home, 'mount')
      fs.mkdirSync(mount)
      try {
        const quiet = { stdio: 'ignore' as const, timeout: 60_000 }
        // The name of such a volume holds eleven letters at most.
        execFileSync(
          'hdiutil',
          ['create', '-size', '8m', '-fs', 'ExFAT', '-volname', 'dev-exfat', image],
          quiet
        )
        execFileSync('hdiutil', ['attach', image, '-nobrowse', '-mountpoint', mount], quiet)
        volume = fs.realpathSync.native(mount)
      } catch {
        // No disk images here (a sandbox, a CI machine): the test below skips itself.
        volume = null
      }
    }, 120_000)

    afterAll(() => {
      if (volume !== null) spawnSync('hdiutil', ['detach', volume, '-force'], { stdio: 'ignore' })
      wipe(home)
    }, 120_000)

    it('is refused for what it is before anything is copied, with nothing forced', async (context) => {
      if (volume === null) return context.skip()
      buildProject(from)
      const before = snapshot(from)
      const target = join(volume, 'project')
      let copies = 0
      const port = createMoveProjectsFs({
        copyTree: async () => {
          copies += 1
        }
      })
      expect(port.copies?.(from, target)).toBe(true)

      await expect(port.prepareMove(from, target)).rejects.toThrow(
        `the disk that holds ${volume} does not keep file permissions (exFAT or FAT), so a project cannot be moved there; choose a dev folder on a Mac-formatted disk`
      )

      expect(copies).toBe(0)
      // Nothing of the attempt is left on the volume, hidden or not.
      expect(
        fs.readdirSync(volume).filter((name) => /hive|permissions|project/.test(name))
      ).toEqual([])
      expect(snapshot(from)).toEqual(before)
    })
  }
)
