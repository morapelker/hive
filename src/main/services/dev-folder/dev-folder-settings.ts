// The dev folder setting: which folder is in effect, which folders were used before it, and
// the one place it is changed.
//
// Every clone destination asks `resolveDevFolder` at the moment it needs the folder, so a
// change in Settings applies to the next clone without a restart. `setDevFolder` is the gate:
// whatever it lets through is a folder the app may clone into and move projects to, so it
// refuses the places where that would do damage and stores one spelling per folder (the real
// path), which is why a symlinked dev folder that is retargeted later is not followed.
//
// Loaded by the main process and by the server child: nothing here may import `electron`.
import { mkdirSync, mkdtempSync, rmdirSync, statSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import {
  DEFAULT_DEV_FOLDER,
  DEV_FOLDER_MAX_PREVIOUS,
  DEV_FOLDER_SETTING_KEY,
  parseStoredDevFolder,
  serializeStoredDevFolder,
  type DevFolderState,
  type StoredDevFolder
} from '@shared/types/dev-folder'
import { getDatabase, type DatabaseService } from '../../db'
import { isSameOrAncestorPath } from '../path-utils'
import { canonicalFolderPath, isSameFolder } from './folder-identity'

export interface DevFolderStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

/** `~` and `~/x` become the home directory and a path inside it. `~user` is left alone. */
export const expandHomeDir = (path: string, home: string = homedir()): string => {
  if (path === '~') return home
  if (path.startsWith('~/') || (sep === '\\' && path.startsWith('~\\'))) {
    return join(home, path.slice(2))
  }
  return path
}

/** The folder used while nothing is set, on this machine. */
export const defaultDevFolder = (home: string = homedir()): string =>
  resolve(expandHomeDir(DEFAULT_DEV_FOLDER, home))

const isFilesystemRoot = (resolved: string): boolean => parse(resolved).root === resolved

/**
 * A stored path as the running platform can use it, or null. The shared parser only checks
 * that a value looks absolute on some platform; a Windows path read on a Mac is relative for
 * node and would resolve under the working directory.
 */
const usableFolder = (value: string | null): string | null => {
  if (value === null || !isAbsolute(value)) return null
  const resolved = resolve(value)
  return isFilesystemRoot(resolved) ? null : resolved
}

/**
 * The row as stored; a row that cannot be read is the default folder with nothing before it.
 * The database is looked up here, inside the guard, so that one that cannot be opened reads
 * as the default too.
 */
const readStored = (store: Pick<DevFolderStore, 'getSetting'> | undefined): StoredDevFolder => {
  try {
    return parseStoredDevFolder((store ?? getDatabase()).getSetting(DEV_FOLDER_SETTING_KEY))
  } catch {
    return { path: null, previousPaths: [] }
  }
}

/**
 * The folders used before, without the folder in effect and without a second spelling of one
 * already listed. The parser cannot do this: it compares strings, and it does not know which
 * folder a null path stands for.
 */
const previousFoldersOf = (stored: StoredDevFolder, inEffect: string): string[] => {
  const previous: string[] = []
  for (const entry of stored.previousPaths) {
    const folder = usableFolder(entry)
    if (folder === null || isSameFolder(folder, inEffect)) continue
    if (previous.some((kept) => isSameFolder(kept, folder))) continue
    previous.push(folder)
  }
  return previous
}

/**
 * The folder in effect. Read from the store on every call (never cached) and never throws: a
 * row that cannot be read, or that holds a relative path or a bare root, reads as the default
 * folder. Without a store, the process's own database is used.
 */
export const resolveDevFolder = (
  store?: Pick<DevFolderStore, 'getSetting'>,
  home: string = homedir()
): string => usableFolder(readStored(store).path) ?? defaultDevFolder(home)

/** Folders used before (absolute), most recent first; never the folder in effect. */
export const previousDevFolders = (
  store?: Pick<DevFolderStore, 'getSetting'>,
  home: string = homedir()
): string[] => {
  const stored = readStored(store)
  return previousFoldersOf(stored, usableFolder(stored.path) ?? defaultDevFolder(home))
}

const statOrNull = (path: string): Stats | null => {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** Everything in `DevFolderState` except `leftBehind`, which needs the project rows. */
export const readDevFolderState = (
  store?: Pick<DevFolderStore, 'getSetting'>,
  home: string = homedir()
): Omit<DevFolderState, 'leftBehind'> => {
  const stored = readStored(store)
  const defaultPath = defaultDevFolder(home)
  const storedPath = usableFolder(stored.path)
  const path = storedPath ?? defaultPath
  return {
    path,
    isDefault: storedPath === null,
    defaultPath,
    exists: statOrNull(path)?.isDirectory() === true,
    previousPaths: previousFoldersOf(stored, path)
  }
}

export interface SetDevFolderDeps {
  store: DevFolderStore
  home: string
  /**
   * Folders a dev folder may not be, or be inside: the app's own (~/.hive, ~/.hive-worktrees,
   * ~/.claude, $CLAUDE_CONFIG_DIR, the app data dir).
   */
  reservedFolders: readonly string[]
  /** Every project path, worktree path and connection path, with a name for the error sentence. */
  registeredFolders: () => readonly { path: string; label: string }[]
  /** Does this folder (a previous one) still hold a registered project as a direct child? */
  holdsProjects: (folder: string) => boolean
}

type SetDevFolderOutcome = { success: true } | { success: false; error: string }

const refused = (error: string): SetDevFolderOutcome => ({ success: false, error })

/** Why the filesystem said no, short enough to end a sentence. */
const reasonOf = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied'
  if (code === 'EROFS') return 'the disk is read-only'
  if (code === 'ENOTDIR' || code === 'EEXIST') return 'a file is in the way'
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[.\s]+$/, '')
}

/**
 * The real path of a folder that may not be on disk yet: the real path of its nearest ancestor
 * that is, then the rest as spelled. This is what `mkdir -p` would create, so the rules can be
 * read before anything is created.
 */
const canonicalOrNearest = (path: string): string => {
  const resolved = resolve(path)
  const notOnDisk: string[] = []
  let current = resolved
  for (;;) {
    const canonical = canonicalFolderPath(current)
    if (canonical !== null) {
      return notOnDisk.length === 0 ? canonical : join(canonical, ...notOnDisk)
    }
    const parent = dirname(current)
    if (parent === current) return resolved
    notOnDisk.unshift(basename(current))
    current = parent
  }
}

/**
 * Why `folder` (a real path, see `canonicalOrNearest`) may not be the dev folder, or null.
 * - The top of a disk, the home directory and anything above it: clone folder names come from
 *   a repository URL, and a folder named `bin` or `.config` must not land in the home folder.
 * - The app's own folders: worktree cleanup and the connection folders assume nobody else's
 *   checkout lives there.
 * - A registered folder: a clone inside another project's checkout would be part of it.
 */
const refusalFor = (folder: string, deps: SetDevFolderDeps): string | null => {
  if (isFilesystemRoot(folder)) return `The dev folder cannot be the top of a disk (${folder}).`
  const home = canonicalOrNearest(deps.home)
  if (folder === home) {
    return `The dev folder cannot be your home folder: choose a folder inside it, such as ${join('~', 'Dev')}.`
  }
  if (isSameOrAncestorPath(folder, home)) {
    return `The dev folder cannot be ${folder}, because your home folder is inside it.`
  }
  for (const reserved of deps.reservedFolders) {
    if (!isAbsolute(reserved)) continue
    if (isSameOrAncestorPath(canonicalOrNearest(reserved), folder)) {
      return `The dev folder cannot be ${reserved} or a folder inside it: Hive and its agents keep their own files there.`
    }
  }
  for (const registered of deps.registeredFolders()) {
    if (!isAbsolute(registered.path)) continue
    const real = canonicalOrNearest(registered.path)
    if (folder === real) {
      return `The dev folder cannot be the folder of ${registered.label} (${registered.path}).`
    }
    if (isSameOrAncestorPath(real, folder)) {
      return `The dev folder cannot be inside ${registered.label} (${registered.path}).`
    }
  }
  return null
}

/** The directories on the way to `folder` that are not on disk, deepest first. */
const foldersNotOnDisk = (folder: string): string[] => {
  const missing: string[] = []
  let current = folder
  while (statOrNull(current) === null) {
    missing.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return missing
}

/** Take back directories this call created, deepest first. `rmdir` only: never one with content. */
const removeEmptyFolders = (deepestFirst: readonly string[]): void => {
  for (const folder of deepestFirst) {
    try {
      rmdirSync(folder)
    } catch {
      return
    }
  }
}

/** Create and remove an entry, the way a clone would have to. Null when that works. */
const whyNotWritable = (folder: string): string | null => {
  try {
    rmdirSync(mkdtempSync(join(folder, '.hive-dev-folder-')))
    return null
  } catch (error) {
    return reasonOf(error)
  }
}

/**
 * What a person typed or picked, as the folder to store: checked against the rules, created
 * when it is not on disk, and resolved to its real path.
 */
const checkedFolder = (
  input: string,
  deps: SetDevFolderDeps
): { folder: string } | { error: string } => {
  if (input.includes('\0')) {
    return { error: 'The path has a character that no folder name can contain.' }
  }
  const expanded = expandHomeDir(input, deps.home)
  if (!isAbsolute(expanded)) {
    const start = sep === '\\' ? 'a drive letter or ~\\' : '/ or ~/'
    return { error: `"${input}" is not a full path: start it with ${start}.` }
  }
  const resolved = resolve(expanded)
  const refusal = refusalFor(canonicalOrNearest(resolved), deps)
  if (refusal !== null) return { error: refusal }

  // Only a folder that passed the rules is created: never a directory inside a project's
  // checkout or one of the app's own folders, not even for a moment.
  const found = statOrNull(resolved)
  if (found !== null && !found.isDirectory()) {
    return { error: `${resolved} is ${found.isFile() ? 'a file, ' : ''}not a folder.` }
  }
  const notOnDisk = found === null ? foldersNotOnDisk(resolved) : []
  let created: string | undefined
  try {
    created = mkdirSync(resolved, { recursive: true })
  } catch (error) {
    return { error: `${resolved} could not be created: ${reasonOf(error)}.` }
  }
  const canonical = statOrNull(resolved)?.isDirectory() ? canonicalFolderPath(resolved) : null
  if (canonical === null) return { error: `${resolved} could not be opened as a folder.` }
  if (created !== undefined) {
    // A folder that was not on disk can turn out to be one of the refused ones once it is: on
    // a volume that ignores letter case, a registered folder that is missing from disk and
    // was typed in another case resolves to the directory just created.
    const late = refusalFor(canonical, deps)
    if (late !== null) {
      removeEmptyFolders(notOnDisk)
      return { error: late }
    }
  }
  const notWritable = whyNotWritable(resolved)
  if (notWritable !== null) {
    return { error: `Hive cannot write to ${resolved}: ${notWritable}.` }
  }
  return { folder: canonical }
}

/**
 * The folders used before, once `left` has been left for `entered`: the folder just left
 * first, then the older ones that still hold a project. An older folder with nothing left in
 * it is forgotten here, so a folder set by mistake does not stay a source of "Move projects"
 * for ever. `older` is already without `left` and without repeats.
 */
const previousAfterLeaving = (
  left: string,
  entered: string,
  older: readonly string[],
  holdsProjects: (folder: string) => boolean
): string[] => {
  const previous = [left]
  for (const folder of older) {
    if (isSameFolder(folder, entered) || !holdsProjects(folder)) continue
    previous.push(folder)
  }
  return previous.slice(0, DEV_FOLDER_MAX_PREVIOUS)
}

const applyDevFolder = (input: string | null, deps: SetDevFolderDeps): SetDevFolderOutcome => {
  const stored = parseStoredDevFolder(deps.store.getSetting(DEV_FOLDER_SETTING_KEY))
  const defaultPath = defaultDevFolder(deps.home)
  const inEffect = usableFolder(stored.path) ?? defaultPath

  // What the row will hold: null stands for the default folder.
  let next: string | null = null
  if (input === null) {
    // Going back to the default is always possible, whatever is on disk.
    if (stored.path === null) return { success: true }
  } else {
    const checked = checkedFolder(input, deps)
    if ('error' in checked) return refused(checked.error)
    // Another spelling of the folder in effect (a symlink, another letter case) is no change.
    if (isSameFolder(checked.folder, inEffect)) return { success: true }
    next = isSameFolder(checked.folder, defaultPath) ? null : checked.folder
  }

  const entered = next ?? defaultPath
  const older = previousFoldersOf(stored, inEffect)
  const previousPaths = isSameFolder(entered, inEffect)
    ? older
    : previousAfterLeaving(inEffect, entered, older, (folder) => deps.holdsProjects(folder))
  deps.store.setSetting(
    DEV_FOLDER_SETTING_KEY,
    serializeStoredDevFolder({ path: next, previousPaths })
  )
  return { success: true }
}

/**
 * Change the dev folder; `null` goes back to the default. A refusal is one sentence for the
 * person who asked. Never throws.
 *
 * In this order: expand `~` and require a full path; refuse the top of a disk, the home
 * directory and its ancestors, the app's own folders and every registered project, worktree
 * and connection folder; only then create the folder and check that it can be written to;
 * store its real path, or null when it is the default folder. The folder just left goes to
 * the front of the folders used before; the folder entered leaves that list.
 */
export const setDevFolder = (
  input: string | null,
  deps: SetDevFolderDeps
): { success: true } | { success: false; error: string } => {
  try {
    return applyDevFolder(input, deps)
  } catch (error) {
    return refused(`The dev folder could not be changed: ${reasonOf(error)}.`)
  }
}

/**
 * The directory that holds the database file. Null for a database that is not a file (in
 * memory) or that cannot say where it is: nothing more is reserved then.
 */
const databaseFolder = (db: DatabaseService): string | null => {
  try {
    const path = db.getDbPath()
    return isAbsolute(path) ? dirname(path) : null
  } catch {
    return null
  }
}

/**
 * The app's own folders. The data directory is known without Electron: the desktop app hands
 * it to the server child as HIVE_SERVER_BASE_DIR (the env vault of synced projects is
 * in it), and run logs and pasted images sit in the directory of the database file.
 */
const liveReservedFolders = (
  db: DatabaseService,
  home: string,
  env: NodeJS.ProcessEnv
): string[] => {
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR ?? ''
  const fromEnvironment = [
    // One directory for the Claude CLI; a comma-separated list for the usage reader.
    claudeConfigDir,
    ...claudeConfigDir.split(','),
    env.HIVE_SERVER_BASE_DIR ?? ''
  ].map((value) => expandHomeDir(value.trim(), home))
  const candidates = [
    join(home, '.hive'),
    join(home, '.hive-worktrees'),
    join(home, '.claude'),
    ...fromEnvironment,
    databaseFolder(db) ?? ''
  ]
  const realHome = canonicalOrNearest(home)
  const reserved: string[] = []
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue
    const folder = resolve(candidate)
    // A variable that names the home folder, or a database kept loose in it, does not make
    // the whole home folder the app's: that would refuse every folder a person could pick.
    const real = canonicalOrNearest(folder)
    if (isFilesystemRoot(real) || isSameOrAncestorPath(real, realHome)) continue
    if (!reserved.includes(folder)) reserved.push(folder)
  }
  return reserved
}

const liveRegisteredFolders = (db: DatabaseService): { path: string; label: string }[] => {
  const folders: { path: string; label: string }[] = []
  const projects = db.getAllProjects()
  // Projects first: a project's default worktree has the project's own path, and the sentence
  // should name the project.
  for (const project of projects) {
    const kind = project.kind === 'connection' ? 'connection project' : 'project'
    folders.push({ path: project.path, label: `the ${kind} "${project.name}"` })
  }
  for (const project of projects) {
    // Archived rows too: a move rewrites the path of every worktree row, whatever its status.
    for (const worktree of db.getWorktreesByProject(project.id)) {
      if (worktree.path === project.path) continue
      folders.push({
        path: worktree.path,
        label: `the worktree "${worktree.name}" of "${project.name}"`
      })
    }
  }
  for (const connection of db.getAllConnections()) {
    folders.push({
      path: connection.path,
      label: `the connection "${connection.custom_name ?? connection.name}"`
    })
  }
  return folders
}

/**
 * `setDevFolder` over the real database. `home` and `env` default to the process's own; a
 * caller that wants a CLAUDE_CONFIG_DIR set in the app's environment variables reserved as
 * well passes an `env` that includes them.
 */
export const createLiveSetDevFolderDeps = (
  db: DatabaseService,
  options: { readonly home?: string; readonly env?: NodeJS.ProcessEnv } = {}
): SetDevFolderDeps => {
  const home = options.home ?? homedir()
  return {
    store: db,
    home,
    reservedFolders: liveReservedFolders(db, home, options.env ?? process.env),
    registeredFolders: () => liveRegisteredFolders(db),
    holdsProjects: (folder) => {
      // Hundreds of projects share a handful of parent folders: compare each parent once.
      const parents = new Set<string>()
      for (const project of db.getAllProjects()) {
        if (project.kind === 'connection' || !isAbsolute(project.path)) continue
        parents.add(dirname(resolve(project.path)))
      }
      for (const parent of parents) {
        if (isSameFolder(parent, folder)) return true
      }
      return false
    }
  }
}
