// The git half of moving a project to the dev folder (`MoveProjectsGit`): which linked
// worktrees a repository has, mending the links between them and a main checkout that moved,
// and telling whether git is in the middle of something. Runs in the server child: no
// `electron` import.
import { execFile } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { isSameFolder } from './folder-identity'
import { diskFs } from './fs-ports'
import type { LinkedWorktree, MoveProjectsGit } from './types'

const execFileAsync = promisify(execFile)
const fsp = diskFs.promises

/** How long one git command may take. None of the commands run here reads a work tree. */
const GIT_TIMEOUT_MS = 60_000

/** `git <args>` in `cwd`: resolves with what git wrote, rejects (with `stderr`) when it fails. */
type GitRunner = (cwd: string, args: string[]) => Promise<string>

export interface MoveProjectsGitOverrides {
  /** Stands in for git. */
  readonly run?: GitRunner
  /** How long the real git may take before it is stopped. */
  readonly timeoutMs?: number
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** What git itself said when a command failed, on one line; else the error's own text. */
const gitReason = (error: unknown): string => {
  const stderr = (error as { stderr?: unknown } | null | undefined)?.stderr
  const said =
    typeof stderr === 'string'
      ? stderr
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .join('; ')
      : ''
  return said.length > 0 ? said : reasonOf(error)
}

/**
 * `git <args>` in `cwd`, output exactly as git wrote it (paths may begin or end with a space
 * or a newline). git looks no higher than `cwd` for a repository: a folder that is not one
 * must not answer for a repository it happens to sit in. A git that does not return (a disk
 * that stopped answering) is stopped: everything that waits for a move would wait with it.
 */
const gitOutput = async (
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)) }
    })
    return stdout
  } catch (error) {
    const stopped = error as { killed?: unknown; signal?: unknown } | null | undefined
    if (stopped?.killed === true && stopped.signal === 'SIGKILL') {
      throw new Error(`git did not finish within ${timeoutMs / 1000} seconds and was stopped`)
    }
    throw error
  }
}

const isThere = (path: string): boolean => {
  try {
    diskFs.lstatSync(path)
    return true
  } catch {
    return false
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return diskFs.statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ── Listing ──────────────────────────────────────────────────────────────────────────────

/**
 * `git worktree list --porcelain -z`: fields end with NUL, an empty field ends a worktree.
 * Never read line by line and never trimmed: a path may hold newlines and spaces anywhere.
 * git lists the main checkout first; it is not a linked worktree and is left out.
 */
const parseWorktreeList = (output: string): LinkedWorktree[] => {
  const listed: { path: string; prunable: boolean; locked: boolean }[] = []
  let current: { path: string; prunable: boolean; locked: boolean } | null = null
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: field.slice('worktree '.length), prunable: false, locked: false }
      listed.push(current)
    } else if (field === '') {
      current = null
    } else if (current !== null) {
      // Both come bare or followed by a reason.
      if (field === 'locked' || field.startsWith('locked ')) current.locked = true
      if (field === 'prunable' || field.startsWith('prunable ')) current.prunable = true
    }
  }
  return listed.slice(1)
}

/** git before 2.36 has no `-z` for the listing and says so as a usage error (exit code 129). */
const lacksNulListing = (error: unknown): boolean => {
  const failed = error as { code?: unknown; stderr?: unknown } | null | undefined
  return (
    failed?.code === 129 ||
    (typeof failed?.stderr === 'string' && failed.stderr.includes('unknown switch'))
  )
}

/**
 * `git worktree list --porcelain` without `-z`, for a git that has none: a block of lines per
 * worktree, an empty line after each. A path is written as it is, so one that holds a line
 * break cannot be told from two lines: a block that is not exactly what git writes for one
 * worktree means the listing cannot be trusted (null). git before 2.31 does not say which
 * worktrees it cannot find, so that is read from the disk by git's own rule: not locked, and
 * the `.git` file of the worktree is gone.
 */
const parseWorktreeLines = (output: string): LinkedWorktree[] | null => {
  const listed: LinkedWorktree[] = []
  const marks = (line: string | undefined, word: string): boolean =>
    line !== undefined && (line === word || line.startsWith(`${word} `))
  for (const block of output.split('\n\n')) {
    // What follows the empty line of the last worktree.
    if (block === '') continue
    const lines = block.split('\n')
    const path = lines[0].startsWith('worktree ') ? lines[0].slice('worktree '.length) : ''
    if (path.length === 0) return null
    let next = 1
    if (lines[next] === 'bare') next += 1
    else if (/^HEAD [0-9a-f]{40,64}$/.test(lines[next] ?? '')) {
      next += 1
      if (lines[next] === 'detached' || marks(lines[next], 'branch')) next += 1
    } else return null
    const locked = marks(lines[next], 'locked')
    if (locked) next += 1
    const prunable = marks(lines[next], 'prunable')
    if (prunable) next += 1
    if (next !== lines.length) return null
    listed.push({ path, prunable, locked })
  }
  return listed
    .slice(1)
    .map((worktree) =>
      worktree.prunable || worktree.locked || isThere(join(worktree.path, '.git'))
        ? worktree
        : { ...worktree, prunable: true }
    )
}

// ── Links between a repository and its worktrees ─────────────────────────────────────────

/**
 * What the `.git` FILE of `folder` names, as it is written there (absolute or relative); null
 * when the folder has no such file. Read the way git reads it, up to the line break that ends
 * the file: a path that holds a line break is not cut short.
 */
const gitFileLink = (folder: string): string | null => {
  let text: string
  try {
    text = diskFs.readFileSync(join(folder, '.git'), 'utf8')
  } catch {
    return null
  }
  if (!text.startsWith('gitdir: ')) return null
  const link = text.slice('gitdir: '.length).replace(/[\r\n]+$/, '')
  return link.length > 0 ? link : null
}

/** A path the way git writes it into its link files: with forward slashes, on Windows too. */
const asGitWrites = (path: string): string => (sep === '/' ? path : path.split(sep).join('/'))

/** Written next to the file and renamed over it: a link is never half-written. */
const writeLink = async (file: string, text: string): Promise<void> => {
  const draft = `${file}.relinking`
  try {
    await fsp.writeFile(draft, text)
    await fsp.rename(draft, file)
  } catch (error) {
    await fsp.rm(draft, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Points each worktree at `places` at this repository, and the repository at it, before git is
 * asked to. A worktree is found by its id (the name of its folder in `.git/worktrees`, which
 * its `.git` file ends with), as git 2.48 and later find it.
 *
 * It matters for a project that went to another volume: it was copied, and the old folder is
 * still on disk while the links are mended. A worktree that came along still names the old
 * repository, which is there and looks right to git before 2.48: that git then re-links the
 * OLD repository and the OLD worktree to the new ones, and what is committed in the new
 * worktree lands in the folder that is about to be removed. Written here first, the links are
 * right whatever git makes of them afterwards.
 *
 * Absolute links only: relative ones still hold in a copy, and only a git that mends a copy
 * itself writes them. A folder that is not a worktree this repository knows by that id is left
 * to git, which says what is wrong with it.
 */
const linkById = async (repoPath: string, places: readonly string[]): Promise<void> => {
  let worktreesDir: string
  try {
    worktreesDir = join(await fsp.realpath(repoPath), '.git', 'worktrees')
  } catch {
    return
  }
  for (const place of places) {
    try {
      const target = gitFileLink(place)
      if (target === null || !isAbsolute(target)) continue
      if (basename(dirname(target)) !== 'worktrees') continue
      const admin = join(worktreesDir, basename(target))
      if (!isThere(join(admin, 'HEAD'))) continue

      const realPlace = await fsp.realpath(place)
      const back = join(realPlace, '.git')
      const backFile = join(admin, 'gitdir')
      const recorded = (await fsp.readFile(backFile, 'utf8').catch(() => '')).replace(
        /[\r\n]+$/,
        ''
      )
      // Another spelling of the same folder is not another folder.
      if (
        isAbsolute(recorded) &&
        recorded !== back &&
        !(basename(recorded) === '.git' && isSameFolder(dirname(recorded), realPlace))
      ) {
        await writeLink(backFile, `${asGitWrites(back)}\n`)
      }
      if (target !== admin && !isSameFolder(target, admin)) {
        await writeLink(join(place, '.git'), `gitdir: ${asGitWrites(admin)}\n`)
      }
    } catch {
      // Left to git.
    }
  }
}

/**
 * Whether the worktree folder points back at this repository: its `.git` file names a folder
 * that exists, directly in the repository's `.git/worktrees`. Told by what the folders are,
 * not by how their paths are spelled. Never throws.
 */
const linksBack = (repoPath: string, worktreePath: string): boolean => {
  try {
    const link = gitFileLink(worktreePath)
    if (link === null) return false
    // git reads a relative link from where the worktree really is.
    const target = isAbsolute(link)
      ? resolve(link)
      : resolve(diskFs.realpathSync.native(worktreePath), link)
    return isDirectory(target) && isSameFolder(dirname(target), join(repoPath, '.git', 'worktrees'))
  } catch {
    return false
  }
}

// ── Submodules of linked worktrees ───────────────────────────────────────────────────────

/** The git directories of submodules below a `modules` folder, nested ones included. */
const moduleGitDirs = async (modules: string): Promise<string[]> => {
  const found: string[] = []
  const pending = [modules]
  while (pending.length > 0) {
    const dir = pending.pop() as string
    let entries: { name: string; isDirectory: () => boolean }[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.some((entry) => entry.name === 'HEAD')) {
      found.push(dir)
      // A submodule's own submodules.
      pending.push(join(dir, 'modules'))
      continue
    }
    // A submodule name may hold slashes: its git directory is then that many folders down.
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(dir, entry.name))
    }
  }
  return found.sort()
}

/** Where the `.git` FILE of `folder` points (absolute), or null when it has none. */
const gitFileTarget = async (folder: string): Promise<string | null> => {
  let text: string
  try {
    text = await fsp.readFile(join(folder, '.git'), 'utf8')
  } catch {
    return null
  }
  const line = text.split('\n')[0].replace(/\r$/, '')
  return line.startsWith('gitdir: ') ? resolve(folder, line.slice('gitdir: '.length)) : null
}

/**
 * Re-links one submodule of a linked worktree to its git directory `moduleDir`, which moved
 * with the main checkout. The two point at each other by relative paths: the `.git` file in
 * the submodule's folder, and `core.worktree` in the git directory's config. Does nothing when
 * they still agree: a worktree that moved together with the checkout keeps working, and its
 * old folder (still on disk until a copy to another volume is finished) must not be touched.
 */
const relinkModule = async (
  moduleDir: string,
  repoPath: string,
  oldRepoPath: string,
  run: GitRunner
): Promise<void> => {
  const config = join(moduleDir, 'config')
  let recorded: string
  try {
    recorded = (
      await run(repoPath, ['config', '--file', config, '-z', '--get', 'core.worktree'])
    ).split('\0')[0]
  } catch {
    // No work tree recorded: the submodule is not checked out anywhere.
    return
  }
  if (recorded.length === 0) return

  const fromHere = resolve(moduleDir, recorded)
  const hereTarget = await gitFileTarget(fromHere)
  if (hereTarget !== null && isSameFolder(hereTarget, moduleDir)) return

  // Where the git directory was before the move, and the folder it pointed at from there.
  const tail = relative(repoPath, moduleDir)
  const oldModuleDir = join(oldRepoPath, tail)
  const submodule = resolve(oldModuleDir, recorded)
  const target = await gitFileTarget(submodule)
  if (target === null) return
  const pointsHere = isSameFolder(target, moduleDir)
  const pointsAtOldPlace =
    isSameFolder(target, oldModuleDir) || (!isThere(target) && target.endsWith(sep + tail))
  // Linked to some other git directory: not this one's work tree any more.
  if (!pointsHere && !pointsAtOldPlace) return

  const realSubmodule = await fsp.realpath(submodule)
  const realModuleDir = await fsp.realpath(moduleDir)
  if (!pointsHere) {
    // Written next to it and renamed over it: never a half-written `.git` file.
    const gitFile = join(submodule, '.git')
    const draft = `${gitFile}.relinking`
    try {
      await fsp.writeFile(draft, `gitdir: ${relative(realSubmodule, realModuleDir)}\n`)
      await fsp.rename(draft, gitFile)
    } catch (error) {
      await fsp.rm(draft, { force: true }).catch(() => undefined)
      throw error
    }
  }
  try {
    await run(repoPath, [
      'config',
      '--file',
      config,
      'core.worktree',
      relative(realModuleDir, realSubmodule)
    ])
  } catch (error) {
    throw new Error(gitReason(error))
  }
}

/** The folder of the linked worktree `id`, as the repository records it; its id when it does not. */
const worktreePlace = async (worktreeDir: string, id: string): Promise<string> => {
  try {
    const recorded = (await fsp.readFile(join(worktreeDir, 'gitdir'), 'utf8')).replace(/\r?\n$/, '')
    if (recorded.length > 0) return dirname(resolve(worktreeDir, recorded))
  } catch {
    // Named by its id below.
  }
  return id
}

// ── What git is in the middle of ─────────────────────────────────────────────────────────

/** A lock file is there for as long as a git command that writes is running. */
const LOCKS = ['index.lock', 'HEAD.lock', 'packed-refs.lock', 'config.lock'] as const

/** What git leaves in the git directory while something is unfinished, and what to call it. */
const UNFINISHED: readonly (readonly [marker: string, what: string])[] = [
  ['MERGE_HEAD', 'a merge'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['BISECT_LOG', 'a bisect']
]

const operationInProgress = (repoPath: string): string | null => {
  const gitDir = join(repoPath, '.git')
  if (!isDirectory(gitDir)) return null
  if (LOCKS.some((lock) => isThere(join(gitDir, lock)))) return 'another git command'
  let worktrees: string[] = []
  try {
    worktrees = diskFs.readdirSync(join(gitDir, 'worktrees'))
  } catch {
    // No linked worktrees.
  }
  if (worktrees.some((id) => isThere(join(gitDir, 'worktrees', id, 'index.lock')))) {
    return 'another git command'
  }
  return UNFINISHED.find(([marker]) => isThere(join(gitDir, marker)))?.[1] ?? null
}

// ── The port ─────────────────────────────────────────────────────────────────────────────

export const createMoveProjectsGit = (
  overrides: MoveProjectsGitOverrides = {}
): MoveProjectsGit => {
  const run: GitRunner = overrides.run ?? ((cwd, args) => gitOutput(cwd, args, overrides.timeoutMs))

  return {
    listLinkedWorktrees: async (repoPath) => {
      try {
        return parseWorktreeList(await run(repoPath, ['worktree', 'list', '--porcelain', '-z']))
      } catch (error) {
        if (!lacksNulListing(error)) return null
      }
      try {
        return parseWorktreeLines(await run(repoPath, ['worktree', 'list', '--porcelain']))
      } catch {
        return null
      }
    },

    /**
     * Every linked worktree is named, not only the ones that moved. With none named git mends
     * only what it can still find from the repository's side, and a repository that keeps
     * relative links (`worktree.useRelativePaths`, git 2.48 and later) finds none of its
     * worktrees once it has moved: git then exits 0 and leaves them broken. Named, each is
     * re-linked from its own side, in the form (relative or absolute) the repository is set to.
     * A path that is not on disk makes git fail the whole command, so those are left out.
     *
     * The links of the named worktrees are written before git runs (`linkById`): git alone gets
     * a project that was copied wrong for as long as its old folder is still there.
     */
    repairWorktrees: async (repoPath, worktreePaths) => {
      const onDisk = worktreePaths.map((path) => resolve(path)).filter(isDirectory)
      await linkById(repoPath, onDisk)
      try {
        await run(repoPath, ['worktree', 'repair', ...onDisk])
      } catch (error) {
        throw new Error(gitReason(error))
      }
    },

    repairLinkedSubmodules: async (repoPath, oldRepoPath) => {
      const warnings: string[] = []
      try {
        const worktreesDir = join(repoPath, '.git', 'worktrees')
        let ids: string[]
        try {
          ids = (await fsp.readdir(worktreesDir)).sort()
        } catch {
          return warnings
        }
        for (const id of ids) {
          const worktreeDir = join(worktreesDir, id)
          const failures: string[] = []
          for (const moduleDir of await moduleGitDirs(join(worktreeDir, 'modules'))) {
            try {
              await relinkModule(moduleDir, repoPath, oldRepoPath, run)
            } catch (error) {
              failures.push(reasonOf(error))
            }
          }
          if (failures.length > 0) {
            warnings.push(
              `The submodules in the worktree at ${await worktreePlace(worktreeDir, id)} could not be re-linked to the project's new folder (${failures[0].trim().replace(/\.+$/, '')}). Git commands in that worktree fail until the .git file in each submodule folder points into the project's new folder.`
            )
          }
        }
      } catch (error) {
        warnings.push(
          `The submodules in the worktrees of ${repoPath} could not be checked (${reasonOf(error).trim().replace(/\.+$/, '')}). Run git status in a worktree that has submodules to see whether it still works.`
        )
      }
      return warnings
    },

    operationInProgress,
    linksBack
  }
}
