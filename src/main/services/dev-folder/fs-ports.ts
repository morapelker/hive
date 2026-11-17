// The filesystem half of moving a project to the dev folder (`MoveProjectsFs`).
//
// On one volume a folder moves with a single rename. To another volume it has to be copied, and
// the old folder stays usable for as long as that takes, so a copy is only handed out once it
// has been shown to hold what the source holds, and the old folder is only removed once it has
// been shown not to have changed since. Runs in the server child: no `electron` import.
import { createHash, type Hash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { canonicalFolderPath, isSameFolder } from './folder-identity'
import type { LeftoverSource, MoveProjectsFs, PathKind, PreparedMove } from './types'

/**
 * `fs` as Node ships it. Inside the app `fs` is Electron's, which shows every `.asar` file as a
 * folder of what is packed in it: copying, listing or removing a project that holds one (any
 * project with Electron installed does) fails or changes it. Electron keeps the real module
 * under this name; plain Node has no such module, and its `fs` is the real one already.
 */
export const diskFs: typeof nodeFs =
  (process.getBuiltinModule?.('original-fs') as typeof nodeFs | undefined) ?? nodeFs

const fsp = diskFs.promises

/** The hidden folder a copy is built in, next to where it will go: prefix, owner's pid, random part. */
const TEMP_PREFIX = '.hive-moving-'
const TEMP_NAME = /^\.hive-moving-(\d+)-[A-Za-z0-9]+$/
/** How often a copy is compared with a source that keeps changing before giving up. */
const VERIFY_PASSES = 3
/** Filesystem calls in flight at once while walking or copying one folder's entries. */
const PARALLEL = 16
const CHANGED = 'the project changed while it was being copied; try again'
/** How many folders an old copy that was kept is said to differ in, by name. */
const NAMED_CHANGES = 3

export interface MoveProjectsFsOverrides {
  /** Whether `from` and the folder that will hold the destination are on one volume. */
  readonly isSameVolume?: (from: string, toParent: string) => boolean
  /** The rename that puts a folder in place and takes it back. */
  readonly renameSync?: (from: string, to: string) => void
  /** The process that owns the temp folders made here. */
  readonly pid?: number
  /** Whether the process that owns a temp folder found next to a destination still runs. */
  readonly isPidAlive?: (pid: number) => boolean
  /** Whether the volume that holds `dir` (a folder made for the copy) keeps file permissions. */
  readonly keepsPermissions?: (dir: string) => boolean
  /** The first, whole copy of `from` into `copy` (which does not exist yet). */
  readonly copyTree?: (from: string, copy: string) => Promise<void>
  /**
   * Runs before each comparison of the copy with the source; pass 1 comes right after the
   * first copy. For tests that change the source while it is being moved.
   */
  readonly beforeVerifyPass?: (pass: number, from: string, copy: string) => void | Promise<void>
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────

const codeOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : null
}

/** The path, or a folder on the way to it, is not there. */
const isGone = (error: unknown): boolean =>
  codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR'

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * An error worded here, to follow "This project was not moved: " (no capital, no full stop).
 * `code` is set where a caller may want to tell the cases apart: 'EEXIST' when something is
 * already at the destination, 'EXDEV' when a rename was refused across volumes.
 */
class MoveFailure extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

const failure = (message: string, code?: string): MoveFailure => new MoveFailure(message, code)

const ignore = (): void => undefined

const permissions = (stat: nodeFs.Stats): number => stat.mode & 0o7777

const kindOf = (stat: nodeFs.Stats): PathKind => {
  if (stat.isSymbolicLink()) return 'symlink'
  if (stat.isDirectory()) return 'dir'
  return stat.isFile() ? 'file' : 'other'
}

const kindAt = (path: string): PathKind | null => {
  try {
    return kindOf(diskFs.lstatSync(path))
  } catch (error) {
    // Unreadable is not the same as absent: something may be there, so it counts as taken.
    return isGone(error) ? null : 'other'
  }
}

const lstatOrNull = async (path: string): Promise<nodeFs.Stats | null> => {
  try {
    return await fsp.lstat(path)
  } catch (error) {
    if (isGone(error)) return null
    throw error
  }
}

/**
 * `task` for every item, at most `PARALLEL` at a time, results in the order of `items`. Waits
 * for every task it started before rejecting with the first failure, so nothing is still
 * writing when the caller cleans up.
 */
const inParallel = async <T, R>(
  items: readonly T[],
  task: (item: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  const failures: unknown[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (failures.length === 0 && next < items.length) {
      const index = next
      next += 1
      try {
        results[index] = await task(items[index])
      } catch (error) {
        failures.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker))
  if (failures.length > 0) throw failures[0]
  return results
}

// ── Removing a tree ──────────────────────────────────────────────────────────────────────

const isRefusal = (error: unknown): boolean =>
  codeOf(error) === 'EACCES' || codeOf(error) === 'EPERM'

/** Removes one entry that is not a folder. */
const removeEntry = async (path: string): Promise<void> => {
  try {
    await fsp.unlink(path)
  } catch (error) {
    // Windows does not remove a read-only file (git's objects are), and removes a link to a
    // folder as a folder. Elsewhere a file's own mode does not matter for removing it.
    if (process.platform !== 'win32' || !isRefusal(error)) throw error
    await fsp.chmod(path, 0o666).catch(ignore)
    try {
      await fsp.unlink(path)
    } catch {
      await fsp.rmdir(path)
    }
  }
}

/**
 * Removes a file, a link or a whole folder; a link is removed, never followed. A folder its
 * owner may not write to is opened first: its entries could not be removed otherwise. Goes on
 * past what it cannot remove and resolves with the reason once the rest is gone, or with null
 * when nothing is left. Never rejects.
 *
 * Not `fs.rm`: that starts removing every entry of a folder at once, however many there are,
 * and when one fails it returns while the others are still being removed.
 */
const removeTree = async (root: string): Promise<string | null> => {
  // The first thing that could not be removed, in words; the others are counted.
  const reasons: string[] = []
  let more = 0
  const note = (error: unknown): void => {
    if (isGone(error)) return
    if (reasons.length === 0) reasons.push(reasonOf(error))
    else more += 1
  }
  try {
    const stat = await lstatOrNull(root)
    if (stat === null) return null
    if (!stat.isDirectory()) {
      await removeEntry(root)
      return null
    }
  } catch (error) {
    return isGone(error) ? null : reasonOf(error)
  }

  // Folders still to remove, the one being emptied last. A folder is removed once the folders
  // found in it have been.
  const pending: { readonly dir: string; emptied: boolean }[] = [{ dir: root, emptied: false }]
  while (pending.length > 0) {
    const folder = pending[pending.length - 1]
    if (!folder.emptied) {
      folder.emptied = true
      try {
        const mode = permissions(await fsp.lstat(folder.dir))
        if ((mode & 0o700) !== 0o700) await fsp.chmod(folder.dir, mode | 0o700).catch(ignore)
        const inside: string[] = []
        const others: string[] = []
        for (const entry of await fsp.readdir(folder.dir, { withFileTypes: true })) {
          ;(entry.isDirectory() ? inside : others).push(join(folder.dir, entry.name))
        }
        await inParallel(others, (path) => removeEntry(path).catch(note))
        if (inside.length > 0) {
          for (const dir of inside) pending.push({ dir, emptied: false })
          continue
        }
      } catch (error) {
        note(error)
      }
    }
    pending.pop()
    try {
      await fsp.rmdir(folder.dir)
    } catch (error) {
      // Not empty because of what could not be removed from it: that is noted already.
      if (codeOf(error) !== 'ENOTEMPTY' || reasons.length === 0) note(error)
    }
  }
  if (reasons.length === 0) return null
  return more === 0 ? reasons[0] : `${reasons[0]} (and ${more} more)`
}

// ── Reading a tree ───────────────────────────────────────────────────────────────────────

interface TreeEntry {
  readonly name: string
  readonly kind: PathKind
  readonly stat: nodeFs.Stats
  /** Where a symlink points, as it is written. */
  readonly link: string | null
}

interface TreeFolder {
  /** Path below the root; '' is the root itself. */
  readonly rel: string
  /** In name order. */
  readonly entries: readonly TreeEntry[]
  /** Stands for the entries as they were when the folder was read: see `entryLine`. */
  readonly signature: string
}

interface TreeScan {
  /** Stands for the whole tree: equal digests mean nothing in it was written, added or removed. */
  readonly digest: string
  /** The signature of every folder, by its path below the root. */
  readonly signatures: ReadonlyMap<string, string>
  /** Something was listed and gone a moment later: the tree was changing while it was read. */
  readonly unsettled: boolean
}

/**
 * What identifies an entry for telling "written since": name and kind, plus size, modification
 * time and mode of a file, the target of a link, the mode of a folder. Never the contents (too
 * slow), never access or change times (reading and copying move those), and not a folder's own
 * modification time: it moves when a lock file or a socket comes and goes, and an entry that is
 * added or removed changes the tree's digest through its own line anyway. Sockets and pipes are
 * not copied, so they do not count. Neither does `.DS_Store`, which Finder writes into a folder
 * that is merely looked at: it is copied like any file, but it is not the project changing.
 */
const entryLine = (entry: TreeEntry): string | null => {
  const { name, kind, stat } = entry
  if (kind === 'file') {
    if (name === '.DS_Store') return null
    return JSON.stringify([name, kind, stat.size, stat.mtimeMs, permissions(stat)])
  }
  if (kind === 'symlink') return JSON.stringify([name, kind, entry.link])
  if (kind === 'dir') return JSON.stringify([name, kind, permissions(stat)])
  return null
}

/**
 * Reads every folder of a tree, a folder at a time and in name order, never through a symlink.
 * Kept flat (a list of folders still to read instead of recursion) and bounded (`PARALLEL`
 * calls at once), so the depth and size of a project do not matter. `visit` runs for each
 * folder before the folders inside it are read.
 */
const walkTree = async (
  root: string,
  visit?: (folder: TreeFolder) => Promise<void>
): Promise<TreeScan> => {
  const digest = createHash('sha256')
  const signatures = new Map<string, string>()
  let unsettled = false
  const pending = ['']
  while (pending.length > 0) {
    const rel = pending.pop() as string
    const dir = join(root, rel)
    let names: string[]
    try {
      names = await fsp.readdir(dir)
    } catch (error) {
      if (rel === '' || !isGone(error)) throw error
      unsettled = true
      continue
    }
    names.sort()
    const read = await inParallel(names, async (name): Promise<TreeEntry | null> => {
      const path = join(dir, name)
      try {
        const stat = await fsp.lstat(path)
        const kind = kindOf(stat)
        return { name, kind, stat, link: kind === 'symlink' ? await fsp.readlink(path) : null }
      } catch (error) {
        if (!isGone(error)) throw error
        unsettled = true
        return null
      }
    })
    const entries = read.filter((entry): entry is TreeEntry => entry !== null)
    const lines = createHash('sha256')
    for (const entry of entries) {
      const line = entryLine(entry)
      if (line !== null) lines.update(`${line}\n`)
    }
    const signature = lines.digest('base64')
    signatures.set(rel, signature)
    digest.update(`${JSON.stringify([rel, signature])}\n`)
    if (visit) await visit({ rel, entries, signature })
    // Pushed last name first, so that they are read in name order.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].kind === 'dir') pending.push(join(rel, entries[index].name))
    }
  }
  return { digest: digest.digest('hex'), signatures, unsettled }
}

/**
 * Where two readings of one tree differ, for the person who is told to compare an old copy
 * with the new one: the first folders (in the order they are read) whose entries are not what
 * they were, by their path below the root. A folder that was added or removed shows as a
 * change of the folder it is in. Null when no folder differs.
 */
const whatChanged = (
  before: ReadonlyMap<string, string>,
  now: ReadonlyMap<string, string>
): string | null => {
  const changed: string[] = []
  for (const [rel, signature] of now) {
    const was = before.get(rel)
    if (was !== undefined && was !== signature) changed.push(rel === '' ? 'the folder itself' : rel)
  }
  if (changed.length === 0) return null
  const more = changed.length - NAMED_CHANGES
  return (
    `what changed is in ${changed.slice(0, NAMED_CHANGES).join(', ')}` +
    (more > 0 ? ` and ${more} more ${more === 1 ? 'folder' : 'folders'}` : '')
  )
}

// ── What git state a repository is in ────────────────────────────────────────────────────

const listSorted = (dir: string): nodeFs.Dirent[] => {
  try {
    return diskFs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch {
    return []
  }
}

const addFile = (hash: Hash, path: string, label: string): void => {
  try {
    const stat = diskFs.lstatSync(path)
    hash.update(`${JSON.stringify([label, stat.size, stat.mtimeMs])}\n`)
  } catch {
    hash.update(`${JSON.stringify([label, null])}\n`)
  }
}

const addFilesUnder = (hash: Hash, top: string, topLabel: string): void => {
  const pending: [string, string][] = [[top, topLabel]]
  while (pending.length > 0) {
    const [dir, label] = pending.pop() as [string, string]
    for (const entry of listSorted(dir)) {
      if (entry.isDirectory()) pending.push([join(dir, entry.name), `${label}/${entry.name}`])
      else if (entry.isFile()) addFile(hash, join(dir, entry.name), `${label}/${entry.name}`)
    }
  }
}

/** New loose objects move the time of their two-letter folder; packs are listed by name. */
const addObjects = (hash: Hash, objects: string, label: string): void => {
  for (const entry of listSorted(objects)) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'pack') addFilesUnder(hash, join(objects, 'pack'), `${label}/pack`)
    else if (/^[0-9a-f]{2}$/.test(entry.name)) {
      try {
        const stat = diskFs.lstatSync(join(objects, entry.name))
        hash.update(`${JSON.stringify([`${label}/${entry.name}`, stat.mtimeMs])}\n`)
      } catch {
        hash.update(`${JSON.stringify([`${label}/${entry.name}`, null])}\n`)
      }
    }
  }
}

/** The git directories of submodules below a `modules` folder (their names may hold slashes). */
const moduleGitDirs = (modules: string, label: string): string[] => {
  const found: string[] = []
  const pending: [string, string][] = [[modules, label]]
  while (pending.length > 0) {
    const [dir, dirLabel] = pending.pop() as [string, string]
    const entries = listSorted(dir)
    if (entries.some((entry) => entry.name === 'HEAD' && entry.isFile())) {
      found.push(dirLabel)
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push([join(dir, entry.name), `${dirLabel}/${entry.name}`])
    }
  }
  return found
}

/**
 * A cheap stand-in for "what the repository holds", read synchronously so it can be compared in
 * the same tick as the rename that puts a copy in place: size and time of every file directly
 * in the git directory (HEAD, index, packed-refs, …), of every file under refs/ and logs/, the
 * time of each objects/xx folder and the list of packs; the same for the private part of each
 * linked worktree (worktrees/<id>) and for each submodule (modules/…). A commit, a stash, a
 * staged file, a fetch or a new worktree changes it; reading the repository does not. Null when
 * `gitDir` is not a directory.
 */
const gitFingerprint = (gitDir: string): string | null => {
  if (kindAt(gitDir) !== 'dir') return null
  const hash = createHash('sha256')
  const pending = ['.']
  while (pending.length > 0) {
    const label = pending.pop() as string
    const dir = join(gitDir, label)
    for (const entry of listSorted(dir)) {
      const path = join(dir, entry.name)
      const entryLabel = `${label}/${entry.name}`
      if (entry.isFile()) addFile(hash, path, entryLabel)
      else if (!entry.isDirectory()) continue
      else if (entry.name === 'refs' || entry.name === 'logs' || entry.name === 'reftable') {
        addFilesUnder(hash, path, entryLabel)
      } else if (entry.name === 'objects') addObjects(hash, path, entryLabel)
      else if (entry.name === 'worktrees') {
        for (const worktree of listSorted(path)) {
          if (worktree.isDirectory()) pending.push(`${entryLabel}/${worktree.name}`)
        }
      } else if (entry.name === 'modules') pending.push(...moduleGitDirs(path, entryLabel))
    }
  }
  return hash.digest('hex')
}

// ── Making a copy hold what the source holds ─────────────────────────────────────────────

/** What a folder of the copy is given once everything inside it is in place. */
interface FolderRecord {
  readonly mode: number
  readonly atimeMs: number
  readonly mtimeMs: number
  /** Its mode or times are not the source's (or entries were added to it or removed from it). */
  settle: boolean
}

const recordOf = (source: nodeFs.Stats, have: nodeFs.Stats | null): FolderRecord => ({
  mode: permissions(source),
  atimeMs: source.atimeMs,
  mtimeMs: source.mtimeMs,
  settle:
    have === null ||
    permissions(have) !== permissions(source) ||
    Math.abs(have.mtimeMs - source.mtimeMs) >= 1
})

const namesCollide = (folder: string): Error =>
  failure(
    `the destination volume cannot hold two names in ${folder} that differ only by letter case or accents`
  )

/**
 * One comparison of the copy with the source, mending the copy on the way: entries the copy
 * lacks are copied, entries the source no longer has are removed, and the files of every
 * folder whose entries are not what `known` (the previous reading of the source) recorded are
 * copied again. `differences` is how much had to be mended: zero means the copy held, when this
 * pass read it, exactly what the source held from the previous reading to this one.
 *
 * Source and copy are never compared by modification time: volumes keep times at different
 * precisions. Whether a file was written is told from two readings of the source instead.
 */
const settleCopy = async (
  from: string,
  copy: string,
  known: ReadonlyMap<string, string>
): Promise<{ scan: TreeScan; differences: number }> => {
  let differences = 0
  const records = new Map<string, FolderRecord>()

  const rootStat = await fsp.lstat(from)
  if (!rootStat.isDirectory()) throw failure(`${from} is not a folder any more`)
  let rootCopy = await lstatOrNull(copy)
  if (rootCopy !== null && !rootCopy.isDirectory()) {
    const left = await removeTree(copy)
    if (left !== null) throw failure(`the copy could not be put right (${left})`)
    rootCopy = null
  }
  if (rootCopy === null) {
    differences += 1
    await fsp.mkdir(copy)
  }
  records.set('', recordOf(rootStat, rootCopy))

  const settleFolder = async (folder: TreeFolder): Promise<void> => {
    const sourceDir = join(from, folder.rel)
    const copyDir = join(copy, folder.rel)
    const record = records.get(folder.rel)
    if (record === undefined) throw failure(`the copy of ${sourceDir} was never started`)
    // Its entries changed between two readings: any of its files may have been written to
    // after it was copied, so all of them are copied again.
    const stale = known.get(folder.rel) !== folder.signature
    if (stale) differences += 1
    const wanted = folder.entries.filter((entry) => entry.kind !== 'other')
    const present = await fsp.readdir(copyDir)

    // A folder copied from a read-only one is read-only too: open it before changing what is
    // in it. Its mode and times are put right at the end of the pass.
    let unlocking: Promise<void> | null = null
    const unlock = (): Promise<void> => {
      unlocking ??= (async (): Promise<void> => {
        record.settle = true
        // Best effort: where it did not help, what follows fails and says why.
        await fsp.chmod(copyDir, record.mode | 0o700).catch(ignore)
      })()
      return unlocking
    }
    const clear = async (path: string): Promise<void> => {
      await unlock()
      const left = await removeTree(path)
      if (left !== null) throw failure(`the copy could not be put right (${left})`)
    }
    const create = async (make: () => Promise<unknown>): Promise<void> => {
      await unlock()
      try {
        await make()
      } catch (error) {
        // Nothing was at this name a moment ago: a name the volume takes for the same one was.
        throw codeOf(error) === 'EEXIST' ? namesCollide(sourceDir) : error
      }
    }

    // What the source no longer has. A volume may hand a name back in another Unicode form
    // than it was given, so a name that is not there letter for letter is matched by form.
    const exact = new Set(present)
    const names = new Set(wanted.map((entry) => entry.name))
    const byForm = new Set(
      wanted.filter((entry) => !exact.has(entry.name)).map((entry) => entry.name.normalize('NFC'))
    )
    const extras = present.filter((name) => !names.has(name) && !byForm.has(name.normalize('NFC')))
    for (const name of extras) {
      differences += 1
      await clear(join(copyDir, name))
    }

    let added = 0
    let dropped = 0
    let lost = 0
    await inParallel(wanted, async (entry): Promise<void> => {
      const source = join(sourceDir, entry.name)
      const target = join(copyDir, entry.name)
      const have = await lstatOrNull(target)

      if (entry.kind === 'dir') {
        const usable = have !== null && have.isDirectory() ? have : null
        if (usable === null) {
          differences += 1
          if (have !== null) await clear(target)
          await create(() => fsp.mkdir(target))
          if (have === null) added += 1
        }
        records.set(join(folder.rel, entry.name), recordOf(entry.stat, usable))
        return
      }

      if (entry.kind === 'symlink') {
        if (have?.isSymbolicLink() && (await fsp.readlink(target)) === entry.link) return
        differences += 1
        if (have !== null) await clear(target)
        await create(() => fsp.symlink(entry.link as string, target))
        if (have === null) added += 1
        return
      }

      if (!stale && have?.isFile() && have.size === entry.stat.size) {
        // Best effort: not every volume keeps permissions.
        if (permissions(have) !== permissions(entry.stat)) {
          await fsp.chmod(target, permissions(entry.stat)).catch(ignore)
        }
        return
      }
      differences += 1
      if (have !== null) await clear(target)
      try {
        await create(() => fsp.copyFile(source, target, diskFs.constants.COPYFILE_EXCL))
      } catch (error) {
        if (!isGone(error)) throw error
        // Removed from the source since the folder was listed: the next pass sees it gone.
        lost += 1
        if (have !== null) dropped += 1
        return
      }
      if (have === null) added += 1
      await fsp.chmod(target, permissions(entry.stat)).catch(ignore)
      await fsp.utimes(target, entry.stat.atimeMs / 1000, entry.stat.mtimeMs / 1000).catch(ignore)
    })

    // Every name was found or made in the copy, yet the copy holds fewer entries than names:
    // the volume took two of them for one, and one file now stands for both.
    if (present.length - extras.length + added - dropped < wanted.length - lost) {
      throw namesCollide(sourceDir)
    }
  }

  const scan = await walkTree(from, settleFolder)

  // Folders last, deepest first: adding to a folder moves its time, and a folder that is
  // read-only in the source can only become read-only once it is full.
  for (const [rel, record] of [...records].reverse()) {
    if (!record.settle) continue
    const path = join(copy, rel)
    await fsp.utimes(path, record.atimeMs / 1000, record.mtimeMs / 1000).catch(ignore)
    await fsp.chmod(path, record.mode).catch(ignore)
  }
  return { scan, differences }
}

// ── The port ─────────────────────────────────────────────────────────────────────────────

/**
 * The temp folders this process made and has not removed. Any other folder that carries this
 * process's pid was left by an earlier process that had the same number (pids start over after
 * a restart of the machine), so it is as stale as one whose process is gone.
 */
const ownTemps = new Set<string>()

/**
 * Pairs of parent folders between which a rename was refused although both report the same
 * device: a move between them is copied from then on, so trying again gets somewhere.
 */
const refusedRenames = new Set<string>()
const parentsKey = (from: string, to: string): string =>
  JSON.stringify([dirname(from), dirname(to)])

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // No such process. Anything else (not ours to signal) means it is there.
    return codeOf(error) !== 'ESRCH'
  }
}

/**
 * Whether the volume that holds `dir` keeps the permissions a file is given. exFAT and FAT do
 * not: every file reads as one fixed mode there, and macOS keeps what such a volume cannot
 * store in a hidden file next to each entry, which it writes again whenever a mode or a time is
 * set. A copy onto such a volume never comes out equal to its source, however often it is
 * mended. Two modes are tried: one fixed mode cannot be both.
 */
const volumeKeepsPermissions = (dir: string): boolean => {
  // Windows has no such permissions on any volume, and none of the above happens there.
  if (process.platform === 'win32') return true
  const probe = join(dir, '.permissions')
  try {
    diskFs.writeFileSync(probe, '')
  } catch {
    // Says nothing about permissions: the copy fails next, and says why.
    return true
  }
  try {
    for (const mode of [0o644, 0o600]) {
      diskFs.chmodSync(probe, mode)
      if (permissions(diskFs.lstatSync(probe)) !== mode) return false
    }
    return true
  } catch (error) {
    // A volume may also refuse the change outright.
    return !isRefusal(error) && codeOf(error) !== 'ENOTSUP'
  } finally {
    try {
      diskFs.unlinkSync(probe)
    } catch {
      // Goes with the folder it is in.
    }
  }
}

export const createMoveProjectsFs = (overrides: MoveProjectsFsOverrides = {}): MoveProjectsFs => {
  const pid = overrides.pid ?? process.pid
  const isPidAlive = overrides.isPidAlive ?? isProcessAlive
  const renameSync = overrides.renameSync ?? diskFs.renameSync
  const isSameVolume =
    overrides.isSameVolume ??
    ((from: string, toParent: string): boolean =>
      diskFs.statSync(from).dev === diskFs.statSync(toParent).dev)
  const keepsPermissions = overrides.keepsPermissions ?? volumeKeepsPermissions

  /** Whether `from` gets to `to` by a rename; `above` is the folder that decides for `to`. */
  const renames = (from: string, to: string, above: string): boolean =>
    !refusedRenames.has(parentsKey(from, to)) && isSameVolume(from, above)

  /**
   * The first, whole copy. Links are copied as written (never followed, never made absolute),
   * modes and file times are kept, sockets and pipes are skipped (they cannot be copied and
   * mean nothing in another place). Hard links become separate files and extended attributes
   * are not kept. `errorOnExist` matters on a volume that folds letter case: without it the
   * app's Node writes two names that differ only by case into one file and reports success.
   */
  const copyTree =
    overrides.copyTree ??
    ((from: string, copy: string): Promise<void> =>
      fsp.cp(from, copy, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        force: false,
        errorOnExist: true,
        filter: async (source) => kindOf(await fsp.lstat(source)) !== 'other'
      }))

  /** Throws unless nothing at all is at `path`: a rename silently replaces an empty folder. */
  const assertFree = (path: string): void => {
    try {
      diskFs.lstatSync(path)
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return
      throw error
    }
    throw failure(`something is already at ${path}`, 'EEXIST')
  }

  /**
   * Temp folders that a process which no longer runs left next to a destination (the app quit
   * or crashed in the middle of a copy). Only folders named the way they are named here, never
   * one this process made (a second folder of the same project may be waiting to be placed)
   * and never one whose process is alive (another app instance may be building its copy).
   */
  const removeStaleTemps = async (parent: string): Promise<void> => {
    let names: string[]
    try {
      names = await fsp.readdir(parent)
    } catch {
      return
    }
    for (const name of names) {
      const match = TEMP_NAME.exec(name)
      if (match === null) continue
      const owner = Number(match[1])
      if (!Number.isSafeInteger(owner) || owner <= 0) continue
      const path = join(parent, name)
      if (ownTemps.has(path) || (owner !== pid && isPidAlive(owner))) continue
      try {
        if (!(await fsp.lstat(path)).isDirectory()) continue
      } catch {
        continue
      }
      await removeTree(path)
    }
  }

  const prepareRename = (from: string, to: string): PreparedMove => {
    let placed = false
    return {
      from,
      to,
      copied: false,
      place: () => {
        if (placed) throw failure(`${from} was already moved to ${to}`)
        assertFree(to)
        try {
          renameSync(from, to)
        } catch (error) {
          if (codeOf(error) !== 'EXDEV') throw error
          // The next attempt copies instead of renaming.
          refusedRenames.add(parentsKey(from, to))
          throw failure(
            `${dirname(to)} turned out to be on another volume than ${from}, so the folder has to be copied; nothing was moved, try again`,
            'EXDEV'
          )
        }
        placed = true
      },
      undo: () => {
        if (!placed) return
        assertFree(from)
        renameSync(to, from)
        placed = false
      },
      abort: async () => undefined,
      discardSource: async () => null
    }
  }

  const prepareCopy = async (from: string, to: string): Promise<PreparedMove> => {
    const parent = dirname(to)
    const temp = diskFs.mkdtempSync(join(parent, `${TEMP_PREFIX}${pid}-`))
    ownTemps.add(temp)
    const copy = join(temp, basename(to))
    /** Removes the temp folder and what is in it; resolves with what stopped it, or null. */
    const removeTemp = async (): Promise<string | null> => {
      const left = await removeTree(temp)
      if (left === null) ownTemps.delete(temp)
      return left
    }

    // Asked before a byte is copied: on such a volume the whole project would be copied only
    // to be found different from its source, every time it is tried.
    if (!keepsPermissions(temp)) {
      await removeTemp()
      throw failure(
        `the disk that holds ${parent} does not keep file permissions (exFAT or FAT), so a project cannot be moved there; choose a dev folder on a Mac-formatted disk`
      )
    }

    let verified: {
      digest: string
      signatures: ReadonlyMap<string, string>
      fingerprint: string | null
    } | null = null
    try {
      // Read before the first byte is copied: a file that is written to between this reading
      // and the next one was possibly copied half-way, whatever its size says.
      let known = (await walkTree(from)).signatures
      try {
        await copyTree(from, copy)
      } catch (error) {
        // An entry that went away while the tree was being copied stops the copy where it
        // was; the passes below copy the rest. Anything else cannot be mended.
        if (codeOf(error) !== 'ENOENT') {
          if (codeOf(error) !== 'ERR_FS_CP_EEXIST' && codeOf(error) !== 'EEXIST') throw error
          throw failure(
            `the destination volume cannot hold two names of this project that differ only by letter case or accents (${reasonOf(error)})`
          )
        }
      }
      for (let pass = 1; pass <= VERIFY_PASSES && verified === null; pass += 1) {
        await overrides.beforeVerifyPass?.(pass, from, copy)
        // Taken before the pass reads anything: what git writes from here on either makes
        // this pass find a difference or makes the fingerprint differ when the copy is placed.
        const fingerprint = gitFingerprint(join(from, '.git'))
        const { scan, differences } = await settleCopy(from, copy, known)
        known = scan.signatures
        if (differences === 0 && !scan.unsettled) {
          verified = { digest: scan.digest, signatures: scan.signatures, fingerprint }
        }
      }
      if (verified === null) throw failure(CHANGED)
    } catch (error) {
      // Not worded here: the filesystem's own words, about a file or folder of the project.
      const reason =
        error instanceof MoveFailure
          ? error.message
          : `the folder could not be copied: ${reasonOf(error)}`
      const left = await removeTemp()
      throw failure(
        left === null ? reason : `${reason}; what was copied is still at ${temp} (${left})`
      )
    }
    const { digest, signatures, fingerprint } = verified

    let state: 'ready' | 'placed' | 'aborted' = 'ready'
    return {
      from,
      to,
      copied: true,
      place: () => {
        if (state !== 'ready') {
          throw failure(
            state === 'placed'
              ? `${from} was already moved to ${to}`
              : `the copy of ${from} was removed`
          )
        }
        if (gitFingerprint(join(from, '.git')) !== fingerprint) throw failure(CHANGED)
        assertFree(to)
        renameSync(copy, to)
        state = 'placed'
      },
      undo: () => {
        if (state !== 'placed') return
        assertFree(copy)
        renameSync(to, copy)
        state = 'ready'
      },
      abort: async () => {
        // A copy that is in place is the project now and is out of the temp folder: only the
        // folder it was built in goes then. What cannot be removed is removed before the
        // next copy into this folder once this process has ended.
        if (state !== 'placed') state = 'aborted'
        await removeTemp()
      },
      discardSource: async (): Promise<LeftoverSource | null> => {
        try {
          if (state !== 'placed') return null
          // Kept, as after a change, whenever it cannot be shown to be a spare: the new copy
          // has to be where it was put, and the old one readable from end to end.
          if (kindAt(to) !== 'dir') {
            return {
              path: from,
              reason: 'changed',
              detail: `the new copy is not at ${to} any more`
            }
          }
          let now: TreeScan
          try {
            now = await walkTree(from)
          } catch (error) {
            // Somebody removed it already.
            if (isGone(error) && kindAt(from) === null) return null
            return {
              path: from,
              reason: 'changed',
              detail: `it could not be read: ${reasonOf(error)}`
            }
          }
          if (now.unsettled || now.digest !== digest) {
            return {
              path: from,
              reason: 'changed',
              detail: whatChanged(signatures, now.signatures)
            }
          }
          const left = await removeTree(from)
          return left === null ? null : { path: from, reason: 'failed', detail: left }
        } catch (error) {
          return { path: from, reason: 'failed', detail: reasonOf(error) }
        } finally {
          // The copy left it when it was placed.
          if (state === 'placed') await removeTemp()
        }
      }
    }
  }

  return {
    kind: kindAt,
    canonical: canonicalFolderPath,
    sameFolder: isSameFolder,
    mkdirp: async (dir) => {
      await fsp.mkdir(dir, { recursive: true })
    },
    prepareMove: async (from, to) => {
      if (kindAt(from) !== 'dir') throw failure(`${from} is not a folder`)
      if (kindAt(to) !== null) throw failure(`something is already at ${to}`, 'EEXIST')
      const parent = dirname(to)
      if (kindAt(parent) === null) throw failure(`${parent} does not exist`)
      // Whichever way this folder goes: nothing else finds what a copy that was cut short left
      // in the folder it was going to.
      await removeStaleTemps(parent)
      return renames(from, to, parent) ? prepareRename(from, to) : prepareCopy(from, to)
    },
    copies: (from, to) => {
      try {
        // `to` may be several folders deep in what is not made yet.
        let above = dirname(to)
        while (kindAt(above) === null) {
          const higher = dirname(above)
          if (higher === above) return false
          above = higher
        }
        return !renames(from, to, above)
      } catch {
        return false
      }
    }
  }
}
