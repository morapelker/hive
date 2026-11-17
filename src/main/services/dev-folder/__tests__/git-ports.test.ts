// Real git in temp directories. The developer's own git configuration is switched off for
// the whole file, for the commands the tests run and for the ones the port runs.
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { diskFs as fs } from '../fs-ports'
import { createMoveProjectsGit } from '../git-ports'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

/** `git <args>` in `cwd`; throws with git's own words when it fails. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...IDENTITY },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()

/** What git says when it fails in `cwd`, or null when it works. */
const gitFailure = (cwd: string, ...args: string[]): string | null => {
  try {
    git(cwd, ...args)
    return null
  } catch (error) {
    return String((error as { stderr?: unknown }).stderr ?? error)
  }
}

const gitVersion = ((): number[] => {
  try {
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(
      execFileSync('git', ['--version'], { encoding: 'utf8' })
    )
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : [0, 0, 0]
  } catch {
    return [0, 0, 0]
  }
})()
const gitAtLeast = (major: number, minor: number): boolean =>
  gitVersion[0] > major || (gitVersion[0] === major && gitVersion[1] >= minor)

const write = (path: string, text: string): void => {
  fs.mkdirSync(join(path, '..'), { recursive: true })
  fs.writeFileSync(path, text)
}

const read = (path: string): string => fs.readFileSync(path, 'utf8')

/** `git <args>` in `cwd`, output exactly as git wrote it. */
const gitRaw = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Every file below `dir` whose name is `name`, in path order. */
const filesNamed = (dir: string, name: string): string[] => {
  const found: string[] = []
  const pending = [dir]
  while (pending.length > 0) {
    const folder = pending.pop() as string
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.name === name) found.push(path)
    }
  }
  return found.sort()
}

/** A repository with one commit on `main`. */
const initRepo = (path: string): void => {
  fs.mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  write(join(path, 'a.txt'), 'a\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'init')
}

const port = createMoveProjectsGit()
let root: string

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'dev-folder-git-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('listLinkedWorktrees', () => {
  it('lists every linked worktree by its exact path, with its state, and not the main checkout', async () => {
    const app = join(root, 'app')
    initRepo(app)
    const nested = join(app, 'nested')
    const outside = join(root, 'elsewhere', 'out')
    const locked = join(root, 'locked one')
    const gone = join(root, 'gone')
    const spaced = join(root, ' two  spaces ')
    const multiline = join(root, 'with\nnewline')
    git(app, 'worktree', 'add', '-q', nested, '-b', 'nested')
    git(app, 'worktree', 'add', '-q', outside, '-b', 'out')
    git(app, 'worktree', 'add', '-q', locked, '-b', 'locked')
    git(app, 'worktree', 'lock', '--reason', 'kept\nfor later', locked)
    git(app, 'worktree', 'add', '-q', gone, '-b', 'gone')
    fs.rmSync(gone, { recursive: true, force: true })
    git(app, 'worktree', 'add', '-q', spaced, '-b', 'spaced')
    git(app, 'worktree', 'add', '-q', multiline, '-b', 'multiline')

    const listed = await port.listLinkedWorktrees(app)

    const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : 1)
    expect([...(listed ?? [])].sort(byPath)).toEqual(
      [
        { path: nested, prunable: false, locked: false },
        { path: outside, prunable: false, locked: false },
        { path: locked, prunable: false, locked: true },
        { path: gone, prunable: true, locked: false },
        { path: spaced, prunable: false, locked: false },
        { path: multiline, prunable: false, locked: false }
      ].sort(byPath)
    )
  })

  it('is empty for a repository without linked worktrees', async () => {
    const app = join(root, 'app')
    initRepo(app)
    expect(await port.listLinkedWorktrees(app)).toEqual([])
  })

  it('is null for a folder that is not a repository, also one inside a repository', async () => {
    const app = join(root, 'app')
    initRepo(app)
    git(app, 'worktree', 'add', '-q', join(root, 'wt'), '-b', 'wt')
    fs.mkdirSync(join(app, 'packages', 'plain'), { recursive: true })
    fs.mkdirSync(join(root, 'plain'))

    expect(await port.listLinkedWorktrees(join(root, 'plain'))).toBeNull()
    expect(await port.listLinkedWorktrees(join(app, 'packages', 'plain'))).toBeNull()
    expect(await port.listLinkedWorktrees(join(root, 'missing'))).toBeNull()
  })

  describe('with a git that has no -z for the listing (before 2.36)', { timeout: 60_000 }, () => {
    /** What such a git says to `-z`; everything else is answered by the real git. */
    const withoutNul = (
      calls: string[][],
      answer: (cwd: string, args: string[]) => string = (cwd, args) => gitRaw(cwd, ...args)
    ): ReturnType<typeof createMoveProjectsGit> =>
      createMoveProjectsGit({
        run: async (cwd, args) => {
          calls.push(args)
          if (args.includes('-z')) {
            throw Object.assign(new Error('Command failed: git worktree list --porcelain -z'), {
              code: 129,
              stderr: "error: unknown switch `z'\nusage: git worktree list [<options>]\n"
            })
          }
          return answer(cwd, args)
        }
      })

    it('reads the listing by lines and comes to the same answer', async () => {
      const app = join(root, 'app')
      initRepo(app)
      const locked = join(root, 'locked one')
      const lockedGone = join(root, 'locked-gone')
      const gone = join(root, 'gone')
      git(app, 'worktree', 'add', '-q', join(app, 'nested'), '-b', 'nested')
      git(app, 'worktree', 'add', '-q', join(root, 'elsewhere', 'out'), '-b', 'out')
      git(app, 'worktree', 'add', '-q', locked, '-b', 'locked')
      git(app, 'worktree', 'lock', '--reason', 'kept\nfor later', locked)
      git(app, 'worktree', 'add', '-q', lockedGone, '-b', 'locked-gone')
      git(app, 'worktree', 'lock', lockedGone)
      fs.rmSync(lockedGone, { recursive: true, force: true })
      git(app, 'worktree', 'add', '-q', gone, '-b', 'gone')
      fs.rmSync(gone, { recursive: true, force: true })
      git(app, 'worktree', 'add', '-q', join(root, ' two  spaces '), '-b', 'spaced')
      git(app, 'worktree', 'add', '-q', '--detach', join(root, 'detached'))
      const calls: string[][] = []

      const listed = await withoutNul(calls).listLinkedWorktrees(app)

      expect(calls).toEqual([
        ['worktree', 'list', '--porcelain', '-z'],
        ['worktree', 'list', '--porcelain']
      ])
      expect(listed).toHaveLength(7)
      expect(listed).toEqual(await port.listLinkedWorktrees(app))
    })

    it('is empty for a repository without linked worktrees, and null where git fails again', async () => {
      const app = join(root, 'app')
      initRepo(app)
      fs.mkdirSync(join(root, 'plain'))

      expect(await withoutNul([]).listLinkedWorktrees(app)).toEqual([])
      expect(await withoutNul([]).listLinkedWorktrees(join(root, 'plain'))).toBeNull()
    })

    // The second line of the path reads like nothing git writes, or like something it does.
    it.each(['with\nnewline', 'sly\nlocked', `sly\nHEAD ${'0'.repeat(40)}`])(
      'is null when a path holds a line break, which lines cannot show (%j)',
      async (name) => {
        const app = join(root, 'app')
        initRepo(app)
        git(app, 'worktree', 'add', '-q', join(root, 'plain'), '-b', 'plain')
        expect(await withoutNul([]).listLinkedWorktrees(app)).toHaveLength(1)

        git(app, 'worktree', 'add', '-q', join(root, name), '-b', 'multiline')

        expect(await withoutNul([]).listLinkedWorktrees(app)).toBeNull()
        expect(await port.listLinkedWorktrees(app)).toHaveLength(2)
      }
    )

    it('tells from the disk which worktrees are gone when git does not say (before 2.31)', async () => {
      const app = join(root, 'app')
      initRepo(app)
      const here = join(root, 'here')
      const gone = join(root, 'gone')
      git(app, 'worktree', 'add', '-q', here, '-b', 'here')
      git(app, 'worktree', 'add', '-q', gone, '-b', 'gone')
      fs.rmSync(gone, { recursive: true, force: true })
      const unmarked = (cwd: string, args: string[]): string =>
        gitRaw(cwd, ...args)
          .split('\n')
          .filter((line) => !line.startsWith('prunable'))
          .join('\n')
      expect(unmarked(app, ['worktree', 'list', '--porcelain'])).not.toContain('prunable')

      const listed = await withoutNul([], unmarked).listLinkedWorktrees(app)

      expect([...(listed ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
        { path: gone, prunable: true, locked: false },
        { path: here, prunable: false, locked: false }
      ])
    })

    it('does not ask a second time when git failed for another reason', async () => {
      const calls: string[][] = []
      const failing = createMoveProjectsGit({
        run: async (_cwd, args) => {
          calls.push(args)
          throw Object.assign(new Error('Command failed'), {
            code: 128,
            stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
          })
        }
      })

      expect(await failing.listLinkedWorktrees(root)).toBeNull()
      expect(calls).toHaveLength(1)
    })
  })
})

describe('repairWorktrees', () => {
  const layout = (
    relative: boolean
  ): { app: string; moved: string; outside: string; nested: string; sibling: string } => {
    const app = join(root, 'old', 'app')
    initRepo(app)
    if (relative) git(app, 'config', 'worktree.useRelativePaths', 'true')
    const outside = join(root, 'elsewhere', 'out side')
    git(app, 'worktree', 'add', '-q', outside, '-b', 'out')
    git(app, 'worktree', 'add', '-q', join(app, 'nested'), '-b', 'nested')
    git(app, 'worktree', 'add', '-q', join(root, 'old', 'app-feat'), '-b', 'feat')
    // Work that only exists in the worktrees' private part of the repository.
    write(join(outside, 'staged.txt'), 'staged\n')
    git(outside, 'add', 'staged.txt')

    // The checkout moves somewhere deeper, the worktree next to it moves along.
    const moved = join(root, 'new', 'deeper', 'app')
    fs.mkdirSync(join(root, 'new', 'deeper'), { recursive: true })
    fs.renameSync(app, moved)
    const sibling = join(root, 'new', 'deeper', 'app-feat')
    fs.renameSync(join(root, 'old', 'app-feat'), sibling)
    return { app, moved, outside, nested: join(moved, 'nested'), sibling }
  }

  const expectAllLinked = async (moved: string, paths: string[]): Promise<void> => {
    for (const path of paths) expect(gitFailure(path, 'status', '--short')).toBeNull()
    const listed = await port.listLinkedWorktrees(moved)
    expect(
      listed
        ?.filter((worktree) => !worktree.prunable)
        .map((worktree) => worktree.path)
        .sort()
    ).toEqual([...paths].sort())
  }

  it('re-links worktrees outside, inside and moved together with the checkout', async () => {
    const { moved, outside, nested, sibling } = layout(false)
    expect(gitFailure(outside, 'status')).toContain('not a git repository')
    expect(gitFailure(nested, 'status')).toContain('not a git repository')
    expect(gitFailure(sibling, 'status')).toContain('not a git repository')

    await port.repairWorktrees(moved, [outside, nested, sibling])

    await expectAllLinked(moved, [outside, nested, sibling])
    expect(git(outside, 'status', '--short')).toBe('A  staged.txt')
    expect(git(nested, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('nested')
    expect(git(sibling, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat')
    // Running it again changes nothing.
    await port.repairWorktrees(moved, [outside, nested, sibling])
    await expectAllLinked(moved, [outside, nested, sibling])
  })

  it.skipIf(!gitAtLeast(2, 48))(
    're-links worktrees of a repository that keeps relative links',
    async () => {
      const { moved, outside, nested, sibling } = layout(true)
      expect(fs.readFileSync(join(outside, '.git'), 'utf8')).toMatch(/^gitdir: \.\.\//)
      expect(gitFailure(outside, 'status')).toContain('not a git repository')

      await port.repairWorktrees(moved, [outside, nested, sibling])

      await expectAllLinked(moved, [outside, nested, sibling])
      expect(git(outside, 'status', '--short')).toBe('A  staged.txt')
      // Still relative, as the repository asks for.
      expect(fs.readFileSync(join(outside, '.git'), 'utf8')).toMatch(/^gitdir: \.\.\//)
    }
  )

  it.skipIf(!gitAtLeast(2, 48))(
    'shows why every worktree is named: without names git leaves relative links broken and exits 0',
    async () => {
      const { moved, outside } = layout(true)

      await port.repairWorktrees(moved, [])

      expect(gitFailure(outside, 'status')).toContain('not a git repository')
      const listed = await port.listLinkedWorktrees(moved)
      expect(listed?.some((worktree) => worktree.path === outside && !worktree.prunable)).toBe(
        false
      )
    }
  )

  it('leaves out paths that are not on disk, which git would refuse', async () => {
    const { moved, outside, nested, sibling } = layout(false)
    expect(gitFailure(moved, 'worktree', 'repair', join(root, 'missing'))).not.toBeNull()

    await port.repairWorktrees(moved, [join(root, 'missing'), outside, nested, sibling])

    await expectAllLinked(moved, [outside, nested, sibling])
  })

  it('rejects with what git said when git refuses', async () => {
    fs.mkdirSync(join(root, 'plain'))
    await expect(port.repairWorktrees(join(root, 'plain'), [])).rejects.toThrow(
      /not a git repository/
    )
  })

  describe(
    'in a copy of the project whose old folder is still on disk',
    { timeout: 60_000 },
    () => {
      /**
       * A project with a worktree inside it, one next to it and one elsewhere, copied the way a
       * move to another volume copies it: the checkout and the worktree next to it. Every link
       * in the copy still names the old folder, which is there and works.
       */
      const copied = (): {
        app: string
        moved: string
        nested: string
        sibling: string
        outside: string
        /** The link files of the old folder, by path. */
        oldLinks: () => Record<string, string>
      } => {
        const app = join(root, 'old', 'app')
        initRepo(app)
        const outside = join(root, 'elsewhere', 'out side')
        git(app, 'worktree', 'add', '-q', outside, '-b', 'out')
        git(app, 'worktree', 'add', '-q', join(app, '.claude', 'worktrees', 'x'), '-b', 'nested')
        git(app, 'worktree', 'add', '-q', join(root, 'old', 'app-feat'), '-b', 'feat')
        const moved = join(root, 'new', 'app')
        const sibling = join(root, 'new', 'app-feat')
        fs.mkdirSync(join(root, 'new'))
        fs.cpSync(app, moved, { recursive: true, verbatimSymlinks: true })
        fs.cpSync(join(root, 'old', 'app-feat'), sibling, {
          recursive: true,
          verbatimSymlinks: true
        })
        const oldLinks = (): Record<string, string> =>
          Object.fromEntries(
            [
              ...filesNamed(join(app, '.git', 'worktrees'), 'gitdir'),
              join(app, '.claude', 'worktrees', 'x', '.git'),
              join(root, 'old', 'app-feat', '.git')
            ].map((file) => [file, read(file)])
          )
        return {
          app,
          moved,
          nested: join(moved, '.claude', 'worktrees', 'x'),
          sibling,
          outside,
          oldLinks
        }
      }

      /** The name a worktree goes by in its repository: what its `.git` file ends with. */
      const idOf = (place: string): string => basename(read(join(place, '.git')).trim())

      const expectLinkedTo = (repo: string, place: string, id: string): void => {
        const admin = join(repo, '.git', 'worktrees', id)
        expect(read(join(place, '.git'))).toBe(`gitdir: ${admin}\n`)
        expect(read(join(admin, 'gitdir'))).toBe(`${join(place, '.git')}\n`)
        expect(port.linksBack?.(repo, place)).toBe(true)
      }

      // git before 2.48 links the OLD folder to the new one here and leaves the copy as it was.
      // The links must come out right with a git that does nothing at all, and with one that fails.
      it.each([
        ['does nothing', (): Promise<string> => Promise.resolve('')],
        [
          'fails',
          (): Promise<string> =>
            Promise.reject(
              Object.assign(new Error('Command failed'), { stderr: 'fatal: this git is broken\n' })
            )
        ]
      ])('links every worktree to the copy itself, also when git %s', async (_what, answer) => {
        const { app, moved, nested, sibling, outside, oldLinks } = copied()
        const ids = [nested, sibling, outside].map(idOf)
        const before = oldLinks()
        expect(port.linksBack?.(moved, nested)).toBe(false)
        expect(port.linksBack?.(app, nested)).toBe(true)
        const calls: string[][] = []
        const double = createMoveProjectsGit({
          run: (_cwd, args) => {
            calls.push(args)
            return answer()
          }
        })

        const repaired = double.repairWorktrees(moved, [nested, sibling, outside])
        if (_what === 'fails') await expect(repaired).rejects.toThrow(/this git is broken/)
        else await repaired

        expect(calls).toEqual([['worktree', 'repair', nested, sibling, outside]])
        expectLinkedTo(moved, nested, ids[0])
        expectLinkedTo(moved, sibling, ids[1])
        expectLinkedTo(moved, outside, ids[2])
        expect(filesNamed(root, '.git.relinking')).toEqual([])
        expect(filesNamed(root, 'gitdir.relinking')).toEqual([])
        // Nothing in the old folder was written.
        expect(oldLinks()).toEqual(before)
        // The real git agrees.
        await expectAllLinked(moved, [nested, sibling, outside])
        expect(git(nested, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('nested')

        // Work done in the copy stays in the copy.
        write(join(nested, 'work.txt'), 'work\n')
        git(nested, 'add', 'work.txt')
        git(nested, 'commit', '-q', '-m', 'work after the move')
        const commit = git(nested, 'rev-parse', 'HEAD')
        expect(git(moved, 'cat-file', '-t', commit)).toBe('commit')
        expect(gitFailure(app, 'cat-file', '-t', commit)).not.toBeNull()
        expect(git(app, 'log', '-1', '--format=%s', 'nested')).toBe('init')

        // The old folder goes last: nothing of the copy depended on it.
        fs.rmSync(join(root, 'old'), { recursive: true, force: true })
        await expectAllLinked(moved, [nested, sibling, outside])
        expect(git(moved, 'worktree', 'prune', '-n', '-v')).toBe('')
      })

      it('writes nothing when the links are right already', async () => {
        const { moved, nested, sibling, outside } = copied()
        await port.repairWorktrees(moved, [nested, sibling, outside])
        const files = [nested, sibling, outside].flatMap((place) => [
          join(place, '.git'),
          join(moved, '.git', 'worktrees', idOf(place), 'gitdir')
        ])
        const before = files.map((file) => [read(file), fs.statSync(file).ino])
        const quiet = createMoveProjectsGit({ run: () => Promise.resolve('') })

        await quiet.repairWorktrees(moved, [nested, sibling, outside])

        expect(files.map((file) => [read(file), fs.statSync(file).ino])).toEqual(before)
      })

      it('leaves relative links as they are: they hold in a copy', async () => {
        const { moved, nested, sibling, outside } = copied()
        const admin = join(moved, '.git', 'worktrees', idOf(nested))
        const gitFile = `gitdir: ${relative(nested, admin)}\n`
        const backFile = `${relative(admin, join(nested, '.git'))}\n`
        fs.writeFileSync(join(nested, '.git'), gitFile)
        fs.writeFileSync(join(admin, 'gitdir'), backFile)
        const siblingId = idOf(sibling)
        const quiet = createMoveProjectsGit({ run: () => Promise.resolve('') })

        await quiet.repairWorktrees(moved, [nested, sibling, outside])

        expect(read(join(nested, '.git'))).toBe(gitFile)
        expect(read(join(admin, 'gitdir'))).toBe(backFile)
        expect(port.linksBack?.(moved, nested)).toBe(true)
        expect(gitFailure(nested, 'status', '--short')).toBeNull()
        // The one with absolute links is still mended.
        expectLinkedTo(moved, sibling, siblingId)
      })

      it('leaves alone what is not a worktree the repository knows by that name', async () => {
        const { moved, nested } = copied()
        // A repository of its own, a worktree of another repository, a submodule, a plain folder.
        const separate = join(root, 'separate')
        initRepo(separate)
        const other = join(root, 'other')
        initRepo(other)
        const foreign = join(root, 'foreign')
        git(other, 'worktree', 'add', '-q', foreign, '-b', 'foreign')
        const submodule = join(root, 'submodule')
        write(join(submodule, '.git'), `gitdir: ${join(moved, '.git', 'modules', 'x')}\n`)
        const plain = join(root, 'plain')
        fs.mkdirSync(plain)
        const unreadable = join(root, 'unreadable')
        write(join(unreadable, '.git'), 'not a link\n')
        const files = [
          join(foreign, '.git'),
          join(other, '.git', 'worktrees', 'foreign', 'gitdir'),
          join(submodule, '.git'),
          join(unreadable, '.git')
        ]
        const before = files.map(read)
        const quiet = createMoveProjectsGit({ run: () => Promise.resolve('') })

        await quiet.repairWorktrees(moved, [
          separate,
          foreign,
          submodule,
          plain,
          unreadable,
          nested
        ])

        expect(files.map(read)).toEqual(before)
        expect(fs.statSync(join(separate, '.git')).isDirectory()).toBe(true)
        expect(fs.readdirSync(plain)).toEqual([])
        expect(gitFailure(foreign, 'status', '--short')).toBeNull()
        expect(git(foreign, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('foreign')
        // The one that is this repository's was mended all the same.
        expect(port.linksBack?.(moved, nested)).toBe(true)
      })
    }
  )
})

describe('linksBack', { timeout: 60_000 }, () => {
  it('is true for a worktree of the repository, however the two are spelled', () => {
    const app = join(root, 'app')
    initRepo(app)
    const worktree = join(root, 'wts', 'feat')
    git(app, 'worktree', 'add', '-q', worktree, '-b', 'feat')
    fs.symlinkSync(root, join(root, 'link'))

    expect(port.linksBack?.(app, worktree)).toBe(true)
    expect(port.linksBack?.(join(root, 'link', 'app'), worktree)).toBe(true)
    expect(port.linksBack?.(app, join(root, 'link', 'wts', 'feat'))).toBe(true)
    expect(port.linksBack?.(`${app}/./`, `${worktree}/`)).toBe(true)
  })

  it('is false for a worktree that names another repository, also one that exists', () => {
    const app = join(root, 'app')
    initRepo(app)
    const worktree = join(root, 'wts', 'feat')
    git(app, 'worktree', 'add', '-q', worktree, '-b', 'feat')
    const copy = join(root, 'copy')
    fs.cpSync(app, copy, { recursive: true, verbatimSymlinks: true })

    // The copy lists the worktree and git calls it fine; the worktree itself names the original.
    expect(git(copy, 'worktree', 'list', '--porcelain')).not.toContain('prunable')
    expect(port.linksBack?.(copy, worktree)).toBe(false)
    expect(port.linksBack?.(app, worktree)).toBe(true)
  })

  it('follows the checkout through a move and its repair', async () => {
    const app = join(root, 'old', 'app')
    initRepo(app)
    const worktree = join(root, 'wts', 'feat')
    git(app, 'worktree', 'add', '-q', worktree, '-b', 'feat')
    const moved = join(root, 'new', 'app')
    fs.mkdirSync(join(root, 'new'))
    fs.renameSync(app, moved)

    // It names a folder that is gone.
    expect(port.linksBack?.(moved, worktree)).toBe(false)
    await port.repairWorktrees(moved, [worktree])
    expect(port.linksBack?.(moved, worktree)).toBe(true)
  })

  it('reads a relative link from where the worktree really is', () => {
    const app = join(root, 'app')
    initRepo(app)
    const worktree = join(root, 'wts', 'feat')
    git(app, 'worktree', 'add', '-q', worktree, '-b', 'feat')
    const admin = join(app, '.git', 'worktrees', 'feat')
    fs.writeFileSync(join(worktree, '.git'), `gitdir: ${relative(worktree, admin)}\n`)
    // Reached through a link from a folder at another depth.
    fs.mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
    fs.symlinkSync(worktree, join(root, 'a', 'b', 'c', 'feat'))

    expect(port.linksBack?.(app, worktree)).toBe(true)
    expect(port.linksBack?.(app, join(root, 'a', 'b', 'c', 'feat'))).toBe(true)
  })

  it('is false, and does not throw, for anything else', () => {
    const app = join(root, 'app')
    initRepo(app)
    const worktree = join(root, 'wts', 'feat')
    git(app, 'worktree', 'add', '-q', worktree, '-b', 'feat')
    const admin = join(app, '.git', 'worktrees', 'feat')
    const linked = (target: string): string => {
      const folder = fs.mkdtempSync(join(root, 'case-'))
      fs.writeFileSync(join(folder, '.git'), target)
      return folder
    }
    fs.mkdirSync(join(root, 'plain'))
    fs.mkdirSync(join(admin, 'logs'), { recursive: true })
    fs.mkdirSync(join(app, '.git', 'modules', 'lib'), { recursive: true })

    // The repository itself, a folder without git, nothing at all.
    expect(port.linksBack?.(app, app)).toBe(false)
    expect(port.linksBack?.(app, join(root, 'plain'))).toBe(false)
    expect(port.linksBack?.(app, join(root, 'missing'))).toBe(false)
    expect(port.linksBack?.(join(root, 'missing'), worktree)).toBe(false)
    expect(port.linksBack?.(join(root, 'plain'), worktree)).toBe(false)
    // A link to a folder that is not there, to one deeper or elsewhere in `.git`, and no link.
    expect(
      port.linksBack?.(app, linked(`gitdir: ${join(app, '.git', 'worktrees', 'gone')}\n`))
    ).toBe(false)
    expect(port.linksBack?.(app, linked(`gitdir: ${join(admin, 'logs')}\n`))).toBe(false)
    expect(port.linksBack?.(app, linked(`gitdir: ${join(app, '.git', 'modules', 'lib')}\n`))).toBe(
      false
    )
    expect(port.linksBack?.(app, linked(`gitdir: ${join(app, '.git')}\n`))).toBe(false)
    expect(port.linksBack?.(app, linked('gitdir: \n'))).toBe(false)
    expect(port.linksBack?.(app, linked('not a link\n'))).toBe(false)
    expect(port.linksBack?.(app, linked(''))).toBe(false)
    // The same link, whole, is one.
    expect(port.linksBack?.(app, linked(`gitdir: ${admin}\n`))).toBe(true)
    expect(port.linksBack?.(app, linked(`gitdir: ${admin}`))).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('a git that does not return', () => {
  it('is stopped, so that what waits for the answer gets one', { timeout: 30_000 }, async () => {
    const app = join(root, 'app')
    initRepo(app)
    git(app, 'worktree', 'add', '-q', join(root, 'wt'), '-b', 'wt')
    // A `git` that sleeps, found before the real one.
    const bin = join(root, 'bin')
    write(join(bin, 'git'), '#!/bin/sh\nexec sleep 120\n')
    fs.chmodSync(join(bin, 'git'), 0o755)
    const path = process.env.PATH ?? ''
    vi.stubEnv('PATH', `${bin}:${path}`)
    try {
      const hasty = createMoveProjectsGit({ timeoutMs: 300 })
      const started = Date.now()

      await expect(hasty.repairWorktrees(app, [join(root, 'wt')])).rejects.toThrow(
        /^git did not finish within 0\.3 seconds and was stopped$/
      )
      expect(await hasty.listLinkedWorktrees(app)).toBeNull()

      expect(Date.now() - started).toBeLessThan(15_000)
    } finally {
      vi.stubEnv('PATH', path)
    }
    // The real git is back, and nothing was left half-done.
    expect(await port.listLinkedWorktrees(app)).toEqual([
      { path: join(root, 'wt'), prunable: false, locked: false }
    ])
  })
})

describe('repairLinkedSubmodules', () => {
  /**
   * A repository with a submodule, a linked worktree outside the checkout and one inside it,
   * the submodule checked out in both, and a commit in the outside worktree's submodule that
   * exists nowhere else.
   */
  const withSubmodules = (): {
    app: string
    feat: string
    featLib: string
    unpushed: string
  } => {
    const upstream = join(root, 'upstream', 'lib')
    initRepo(upstream)
    const app = join(root, 'old', 'app')
    initRepo(app)
    git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'vendor/lib')
    git(app, 'commit', '-q', '-m', 'add submodule')

    const feat = join(root, 'wts', 'feat')
    git(app, 'worktree', 'add', '-q', feat, '-b', 'feat')
    git(feat, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    git(app, 'worktree', 'add', '-q', join(app, 'nested'), '-b', 'nested')
    git(
      join(app, 'nested'),
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '-q',
      '--init'
    )

    const featLib = join(feat, 'vendor', 'lib')
    write(join(featLib, 'local.txt'), 'only here\n')
    git(featLib, 'add', '.')
    git(featLib, 'commit', '-q', '-m', 'unpushed work')
    return { app, feat, featLib, unpushed: git(featLib, 'rev-parse', 'HEAD') }
  }

  it(
    'makes a linked worktree with a submodule work again after the main checkout moved',
    { timeout: 60_000 },
    async () => {
      const { app, feat, featLib, unpushed } = withSubmodules()
      const moved = join(root, 'new', 'deeper', 'x', 'app')
      fs.mkdirSync(join(moved, '..'), { recursive: true })
      fs.renameSync(app, moved)
      const nested = join(moved, 'nested')
      await port.repairWorktrees(moved, [feat, nested])
      // What `git worktree repair` leaves behind: the worktree is linked, its submodule is not.
      expect(gitFailure(feat, 'status')).toContain('not a git repository')
      expect(gitFailure(featLib, 'status')).toContain('not a git repository')

      expect(await port.repairLinkedSubmodules(moved, app)).toEqual([])

      expect(gitFailure(feat, 'status', '--short')).toBeNull()
      expect(gitFailure(featLib, 'status', '--short')).toBeNull()
      expect(git(featLib, 'rev-parse', 'HEAD')).toBe(unpushed)
      expect(git(featLib, 'log', '-1', '--format=%s')).toBe('unpushed work')
      expect(git(feat, 'submodule', 'status')).toContain(unpushed)
      // Stored in the moved repository, reached through the mended links.
      const moduleDir = join(moved, '.git', 'worktrees', 'feat', 'modules', 'vendor', 'lib')
      expect(fs.realpathSync(git(featLib, 'rev-parse', '--absolute-git-dir'))).toBe(moduleDir)
      expect(fs.realpathSync(git(featLib, 'rev-parse', '--show-toplevel'))).toBe(featLib)
      // The worktree inside the checkout and the checkout itself moved with their submodules.
      expect(gitFailure(nested, 'status', '--short')).toBeNull()
      expect(gitFailure(join(nested, 'vendor', 'lib'), 'status', '--short')).toBeNull()
      expect(gitFailure(join(moved, 'vendor', 'lib'), 'status', '--short')).toBeNull()

      // Safe to run twice: nothing is rewritten the second time.
      const gitFile = fs.readFileSync(join(featLib, '.git'), 'utf8')
      const config = fs.readFileSync(join(moduleDir, 'config'), 'utf8')
      expect(await port.repairLinkedSubmodules(moved, app)).toEqual([])
      expect(fs.readFileSync(join(featLib, '.git'), 'utf8')).toBe(gitFile)
      expect(fs.readFileSync(join(moduleDir, 'config'), 'utf8')).toBe(config)
    }
  )

  it(
    'mends a submodule inside a submodule too, and leaves a worktree that moved along as it is',
    { timeout: 60_000 },
    async () => {
      const allow = ['-c', 'protocol.file.allow=always']
      const inner = join(root, 'upstream', 'inner')
      initRepo(inner)
      const lib = join(root, 'upstream', 'lib')
      initRepo(lib)
      git(lib, ...allow, 'submodule', 'add', '-q', inner, 'inner')
      git(lib, 'commit', '-q', '-m', 'add inner')
      const app = join(root, 'old', 'app')
      initRepo(app)
      git(app, ...allow, 'submodule', 'add', '-q', lib, 'vendor/lib')
      git(app, 'commit', '-q', '-m', 'add lib')
      const feat = join(root, 'wts', 'feat')
      git(app, 'worktree', 'add', '-q', feat, '-b', 'feat')
      git(feat, ...allow, 'submodule', 'update', '-q', '--init', '--recursive')
      git(app, 'worktree', 'add', '-q', join(root, 'old', 'app-side'), '-b', 'side')
      git(
        join(root, 'old', 'app-side'),
        ...allow,
        'submodule',
        'update',
        '-q',
        '--init',
        '--recursive'
      )

      // The checkout and the worktree next to it move together; the other worktree stays.
      const moved = join(root, 'new', 'app')
      const side = join(root, 'new', 'app-side')
      fs.mkdirSync(join(root, 'new'))
      fs.renameSync(app, moved)
      fs.renameSync(join(root, 'old', 'app-side'), side)
      await port.repairWorktrees(moved, [feat, side])
      const featInner = join(feat, 'vendor', 'lib', 'inner')
      expect(gitFailure(featInner, 'status')).toContain('not a git repository')
      // Next to the checkout as before, so its relative links still hold.
      expect(gitFailure(join(side, 'vendor', 'lib', 'inner'), 'status', '--short')).toBeNull()
      const sideFiles = [
        join(side, 'vendor', 'lib', '.git'),
        join(side, 'vendor', 'lib', 'inner', '.git'),
        join(moved, '.git', 'worktrees', 'app-side', 'modules', 'vendor', 'lib', 'config')
      ]
      const sideBefore = sideFiles.map((file) => fs.readFileSync(file, 'utf8'))

      expect(await port.repairLinkedSubmodules(moved, app)).toEqual([])

      expect(gitFailure(feat, 'status', '--short')).toBeNull()
      expect(gitFailure(join(feat, 'vendor', 'lib'), 'status', '--short')).toBeNull()
      expect(gitFailure(featInner, 'status', '--short')).toBeNull()
      expect(gitFailure(feat, 'submodule', 'status', '--recursive')).toBeNull()
      expect(fs.realpathSync(git(featInner, 'rev-parse', '--absolute-git-dir'))).toBe(
        join(moved, '.git', 'worktrees', 'feat', 'modules', 'vendor', 'lib', 'modules', 'inner')
      )
      expect(gitFailure(side, 'submodule', 'status', '--recursive')).toBeNull()
      expect(sideFiles.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(sideBefore)
    }
  )

  it(
    'leaves the old folder alone while it is still on disk (a move to another volume)',
    { timeout: 60_000 },
    async () => {
      const { app, feat, featLib, unpushed } = withSubmodules()
      const moved = join(root, 'new', 'app')
      fs.mkdirSync(join(root, 'new'))
      fs.cpSync(app, moved, { recursive: true, verbatimSymlinks: true })
      const nested = join(moved, 'nested')
      await port.repairWorktrees(moved, [feat, nested])
      const oldNestedGitFile = fs.readFileSync(join(app, 'nested', 'vendor', 'lib', '.git'), 'utf8')
      const oldNestedConfig = fs.readFileSync(
        join(app, '.git', 'worktrees', 'nested', 'modules', 'vendor', 'lib', 'config'),
        'utf8'
      )
      const oldFeatConfig = fs.readFileSync(
        join(app, '.git', 'worktrees', 'feat', 'modules', 'vendor', 'lib', 'config'),
        'utf8'
      )

      expect(await port.repairLinkedSubmodules(moved, app)).toEqual([])

      // The outside worktree's submodule now lives in the new repository.
      expect(fs.realpathSync(git(featLib, 'rev-parse', '--absolute-git-dir'))).toBe(
        join(moved, '.git', 'worktrees', 'feat', 'modules', 'vendor', 'lib')
      )
      expect(git(featLib, 'rev-parse', 'HEAD')).toBe(unpushed)
      expect(gitFailure(feat, 'status', '--short')).toBeNull()
      expect(gitFailure(join(nested, 'vendor', 'lib'), 'status', '--short')).toBeNull()
      // Nothing in the old folder was written.
      expect(fs.readFileSync(join(app, 'nested', 'vendor', 'lib', '.git'), 'utf8')).toBe(
        oldNestedGitFile
      )
      expect(
        fs.readFileSync(
          join(app, '.git', 'worktrees', 'nested', 'modules', 'vendor', 'lib', 'config'),
          'utf8'
        )
      ).toBe(oldNestedConfig)
      expect(
        fs.readFileSync(
          join(app, '.git', 'worktrees', 'feat', 'modules', 'vendor', 'lib', 'config'),
          'utf8'
        )
      ).toBe(oldFeatConfig)
    }
  )

  it(
    'answers with one sentence naming the worktree it could not mend, and does not reject',
    { timeout: 60_000 },
    async () => {
      const { app, feat, featLib } = withSubmodules()
      const moved = join(root, 'new', 'app')
      fs.mkdirSync(join(root, 'new'))
      fs.renameSync(app, moved)
      await port.repairWorktrees(moved, [feat, join(moved, 'nested')])
      // The submodule's folder cannot be written to.
      fs.chmodSync(featLib, 0o555)
      try {
        const warnings = await port.repairLinkedSubmodules(moved, app)

        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain(feat)
        expect(warnings[0]).toMatch(/^The submodules in the worktree at /)
        expect(gitFailure(feat, 'status')).toContain('not a git repository')
      } finally {
        fs.chmodSync(featLib, 0o755)
      }
      // Mended once the folder can be written again.
      expect(await port.repairLinkedSubmodules(moved, app)).toEqual([])
      expect(gitFailure(feat, 'status', '--short')).toBeNull()
    }
  )

  it('has nothing to say for a repository without linked worktrees, or a folder without git', async () => {
    const app = join(root, 'app')
    initRepo(app)
    fs.mkdirSync(join(root, 'plain'))
    expect(await port.repairLinkedSubmodules(app, join(root, 'old-app'))).toEqual([])
    expect(await port.repairLinkedSubmodules(join(root, 'plain'), join(root, 'old-plain'))).toEqual(
      []
    )
  })
})

describe('operationInProgress', () => {
  let app: string

  beforeEach(() => {
    app = join(root, 'app')
    initRepo(app)
    git(app, 'worktree', 'add', '-q', join(root, 'wt'), '-b', 'wt')
  })

  it('is null for a repository at rest', () => {
    expect(port.operationInProgress(app)).toBeNull()
  })

  it.each([
    ['index.lock', 'another git command'],
    ['HEAD.lock', 'another git command'],
    ['packed-refs.lock', 'another git command'],
    ['config.lock', 'another git command'],
    ['worktrees/wt/index.lock', 'another git command'],
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['BISECT_LOG', 'a bisect']
  ])('reads %s as %s', (marker, what) => {
    write(join(app, '.git', marker), '')
    expect(port.operationInProgress(app)).toBe(what)
  })

  it.each(['rebase-merge', 'rebase-apply'])('reads the folder %s as a rebase', (marker) => {
    fs.mkdirSync(join(app, '.git', marker))
    expect(port.operationInProgress(app)).toBe('a rebase')
  })

  it('names a running git command before anything unfinished', () => {
    write(join(app, '.git', 'MERGE_HEAD'), '')
    write(join(app, '.git', 'worktrees', 'wt', 'index.lock'), '')
    expect(port.operationInProgress(app)).toBe('another git command')
  })

  it('reads a real merge that stopped on a conflict', () => {
    git(app, 'checkout', '-q', '-b', 'other')
    write(join(app, 'a.txt'), 'other\n')
    git(app, 'commit', '-q', '-am', 'other')
    git(app, 'checkout', '-q', 'main')
    write(join(app, 'a.txt'), 'main\n')
    git(app, 'commit', '-q', '-am', 'main')
    expect(gitFailure(app, 'merge', 'other')).not.toBeNull()

    expect(port.operationInProgress(app)).toBe('a merge')
    git(app, 'merge', '--abort')
    expect(port.operationInProgress(app)).toBeNull()
  })

  it('is null where there is no git directory to read', () => {
    fs.mkdirSync(join(root, 'plain'))
    expect(port.operationInProgress(join(root, 'plain'))).toBeNull()
    expect(port.operationInProgress(join(root, 'missing'))).toBeNull()
    // A linked worktree keeps a `.git` file, not a directory.
    expect(port.operationInProgress(join(root, 'wt'))).toBeNull()
  })
})
