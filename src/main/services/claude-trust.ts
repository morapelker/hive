import { existsSync } from 'fs'
import { lstat, readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { Project } from '../db/types'
import { atomicWriteJson } from './atomic-json'
import { withClaudeConfigLock } from './claude-config-lock'
import { getUserEnvironmentVariables } from './env-vars'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeTrust' })

/** The slice of DatabaseService the trust pre-flight needs (kept narrow for tests). */
interface TrustCheckDb {
  getProject(id: string): Project | null
  updateProjectTrustCheck(projectId: string, done: boolean): void
  getSetting(key: string): string | null
}

/** Mirror the claude CLI's own config resolution — `$CLAUDE_CONFIG_DIR/.claude.json`
 * when the variable is set, else `~/.claude.json`. `env` must be the environment
 * the spawned CLI will actually see, or the trust write lands in a file the CLI
 * never reads. */
export function resolveClaudeConfigPath(env: Record<string, string | undefined>): string {
  return join(env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
}

// Serializes read-modify-write cycles on the config file so concurrent session
// launches (e.g. a multi-model ticket launching several sessions at once)
// can't interleave and drop each other's writes.
let writeChain: Promise<unknown> = Promise.resolve()

/** Read-back attempts after a write before giving up on confirming it landed. */
const VERIFY_ATTEMPTS = 3

/**
 * Ensure `projects[folderPath].hasTrustDialogAccepted === true` in the claude
 * CLI config at `configPath`, creating the file or the entry as needed while
 * preserving everything else. Returns false without touching the file when it
 * exists but can't be parsed — it also holds oauth state, so clobbering it is
 * far worse than letting the CLI show its trust dialog.
 */
export async function ensureFolderTrustedInClaudeConfig(
  configPath: string,
  folderPath: string
): Promise<boolean> {
  return ensureFoldersTrustedInClaudeConfig(configPath, [folderPath])
}

/** Multi-folder form of `ensureFolderTrustedInClaudeConfig`: one read-modify-write
 * for all `folderPaths`, so a launch that needs both the repo root and its
 * worktree trusted costs a single config rewrite. */
export async function ensureFoldersTrustedInClaudeConfig(
  configPath: string,
  folderPaths: string[]
): Promise<boolean> {
  return (await trustFoldersInClaudeConfig(configPath, folderPaths)).ok
}

export interface TrustFoldersResult {
  /** False when the config could not be read or the write could not be confirmed. */
  ok: boolean
  /** Folders that were not trusted before this call and have been written now. */
  newlyTrusted: string[]
}

/**
 * Like `ensureFoldersTrustedInClaudeConfig`, and also reports which folders
 * had to be written. Callers use that to tell a routine pre-flight from a
 * repair: an entry that has to be written again for a folder that was trusted
 * at launch time was lost to a concurrent writer.
 */
export async function trustFoldersInClaudeConfig(
  configPath: string,
  folderPaths: string[]
): Promise<TrustFoldersResult> {
  const run = writeChain.then(() =>
    withClaudeConfigLock(configPath, () => ensureFoldersTrusted(configPath, folderPaths))
  )
  writeChain = run.catch(() => undefined)
  return run
}

type ConfigRead = { kind: 'ok'; config: Record<string, unknown> } | { kind: 'unreadable' }

async function readClaudeConfig(configPath: string): Promise<ConfigRead> {
  if (!existsSync(configPath)) return { kind: 'ok', config: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf-8'))
  } catch (error) {
    log.warn('Claude config exists but is unparseable; leaving it untouched', {
      configPath,
      error: error instanceof Error ? error.message : String(error)
    })
    return { kind: 'unreadable' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn('Claude config is not a JSON object; leaving it untouched', { configPath })
    return { kind: 'unreadable' }
  }
  return { kind: 'ok', config: parsed as Record<string, unknown> }
}

function projectsOf(config: Record<string, unknown>): Record<string, unknown> {
  return typeof config.projects === 'object' &&
    config.projects !== null &&
    !Array.isArray(config.projects)
    ? (config.projects as Record<string, unknown>)
    : {}
}

function isFolderTrusted(config: Record<string, unknown>, folderPath: string): boolean {
  const entry = projectsOf(config)[folderPath]
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as Record<string, unknown>).hasTrustDialogAccepted === true
  )
}

async function ensureFoldersTrusted(
  configPath: string,
  folderPaths: string[]
): Promise<TrustFoldersResult> {
  const folders = [...new Set(folderPaths)]
  const newlyTrusted: string[] = []
  // Write, then read back. The lock keeps cooperating writers out, but a
  // process that writes from a stale in-memory copy without taking it can
  // still land its write on top of ours; a missing entry on read-back is
  // exactly that, and the write is simply repeated.
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    const read = await readClaudeConfig(configPath)
    if (read.kind !== 'ok') return { ok: false, newlyTrusted }
    const config = read.config
    const projects = projectsOf(config)
    const missing = folders.filter((folderPath) => !isFolderTrusted(config, folderPath))
    if (missing.length === 0) return { ok: true, newlyTrusted }

    for (const folderPath of missing) {
      const entry =
        typeof projects[folderPath] === 'object' && projects[folderPath] !== null
          ? (projects[folderPath] as Record<string, unknown>)
          : {}
      projects[folderPath] = { ...entry, hasTrustDialogAccepted: true }
      if (!newlyTrusted.includes(folderPath)) newlyTrusted.push(folderPath)
    }
    config.projects = projects
    await atomicWriteJson(configPath, config, { pretty: true })
    log.info('Marked folders trusted in claude config', {
      configPath,
      folderPaths: missing,
      ...(attempt > 1 ? { attempt } : {})
    })

    const verify = await readClaudeConfig(configPath)
    if (verify.kind !== 'ok') return { ok: false, newlyTrusted }
    const lost = folders.filter((folderPath) => !isFolderTrusted(verify.config, folderPath))
    if (lost.length === 0) return { ok: true, newlyTrusted }
    log.warn('Trust entries missing right after the write (concurrent writer); retrying', {
      configPath,
      folderPaths: lost,
      attempt
    })
  }
  log.warn('Could not confirm trust entries in claude config', { configPath, folderPaths: folders })
  return { ok: false, newlyTrusted }
}

export interface MoveFolderEntryResult {
  /** False when the config could not be read or written; it is then as it was. */
  ok: boolean
  /**
   * The new folder's entry took something from the old folder's: all of it when the new
   * folder had no entry, otherwise the values its own entry left open.
   */
  copied: boolean
  /** The old folder's entry was removed. */
  removed: boolean
}

/**
 * A folder the CLI has an entry for was moved: carry the entry (trust, allowed tools, MCP
 * servers, last-run counters) over to the new path, so the CLI treats the folder there as
 * the one it knows.
 *
 * When the new path has no entry, the old one is copied whole. When it has one, the two are
 * merged key by key: a value the new path's entry holds is never replaced, and a key it
 * lacks or holds empty (`[]`, `{}`, `false`, `null`, `''`, `0`) takes the old entry's value.
 * An entry is at the new path already when the same folder was known by two spellings (the
 * app trusts it under the path it stores, the CLI keeps everything else under the real
 * path), or when a CLI that was still open in a worktree wrote its defaults there, every key
 * present and empty.
 *
 * `projects[fromFolder]` is removed once nothing is at the old path any more, so that a
 * different repository put there later does not inherit its trust; while the old folder is
 * still on disk the entry stays. `removeOld: 'always'` removes it while the old folder is
 * on disk too. That is for a folder that was copied to another volume: its old copy is
 * deleted only later (or kept, when it changed in the meantime), nothing comes back to
 * remove the entry then, and the old copy is not the project's folder any more either way.
 *
 * Same discipline as `trustFoldersInClaudeConfig`: queued behind this process's other
 * writes, under the config lock, written atomically, and only when something changes (a
 * second run changes nothing). A missing file is not created and an unparseable one is left
 * untouched. Never rejects.
 */
export async function moveFolderEntryInClaudeConfig(
  configPath: string,
  fromFolder: string,
  toFolder: string,
  options?: { removeOld?: 'always' | 'when-gone' }
): Promise<MoveFolderEntryResult> {
  const removeOld = options?.removeOld ?? 'when-gone'
  const run = writeChain.then(() =>
    withClaudeConfigLock(configPath, () =>
      moveFolderEntry(configPath, fromFolder, toFolder, removeOld)
    )
  )
  writeChain = run.catch(() => undefined)
  try {
    return await run
  } catch (error) {
    log.warn('Failed to move a folder entry in claude config', {
      configPath,
      fromFolder,
      toFolder,
      error: error instanceof Error ? error.message : String(error)
    })
    return { ok: false, copied: false, removed: false }
  }
}

async function isGoneFromDisk(folderPath: string): Promise<boolean> {
  try {
    await lstat(folderPath)
    return false
  } catch (error) {
    // Only "nothing is there" counts: a folder that cannot be looked at may still exist.
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A value that says nothing: what the CLI writes for a key nobody has set. */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (value === false || value === '' || value === 0) return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'object' && Object.keys(value).length === 0
}

/**
 * Give `entry` every value of `oldEntry` that it leaves open: a key it does not have, or
 * one it holds empty while the old entry holds something. Returns whether anything was
 * taken. Two empty values are left alone, so a second run takes nothing.
 */
function fillOpenKeys(entry: Record<string, unknown>, oldEntry: Record<string, unknown>): boolean {
  let taken = false
  for (const [key, oldValue] of Object.entries(oldEntry)) {
    if (Object.hasOwn(entry, key) && (!isEmptyValue(entry[key]) || isEmptyValue(oldValue))) {
      continue
    }
    entry[key] = structuredClone(oldValue)
    taken = true
  }
  return taken
}

async function moveFolderEntry(
  configPath: string,
  fromFolder: string,
  toFolder: string,
  removeOld: 'always' | 'when-gone'
): Promise<MoveFolderEntryResult> {
  if (fromFolder === toFolder) return { ok: true, copied: false, removed: false }
  const read = await readClaudeConfig(configPath)
  if (read.kind !== 'ok') return { ok: false, copied: false, removed: false }
  const config = read.config
  const projects = projectsOf(config)
  const entry = projects[fromFolder]
  if (entry === undefined) return { ok: true, copied: false, removed: false }

  const existing = projects[toFolder]
  let copied = false
  if (existing === undefined) {
    copied = typeof entry === 'object' && entry !== null
    if (copied) projects[toFolder] = structuredClone(entry)
  } else if (isPlainObject(existing) && isPlainObject(entry)) {
    copied = fillOpenKeys(existing, entry)
  }
  const removed = removeOld === 'always' || (await isGoneFromDisk(fromFolder))
  if (removed) delete projects[fromFolder]
  if (!copied && !removed) return { ok: true, copied: false, removed: false }

  config.projects = projects
  await atomicWriteJson(configPath, config, { pretty: true })
  log.info('Moved a folder entry in claude config', {
    configPath,
    fromFolder,
    toFolder,
    copied,
    removed
  })
  return { ok: true, copied, removed }
}

/**
 * Called when a spawned CLI is seen sitting on its folder-trust dialog, i.e.
 * the pre-flight's entry did not reach the CLI. Writes the session folder's
 * entry again (a `true` here means it had indeed gone missing) so the next
 * launch, or a relaunch of this one, does not stall again. Never throws.
 */
export async function reassertSessionFolderTrust(
  db: Pick<TrustCheckDb, 'getSetting'>,
  folderPath: string,
  opts?: { configPath?: string }
): Promise<{ wasMissing: boolean }> {
  try {
    const configPath =
      opts?.configPath ??
      resolveClaudeConfigPath({ ...process.env, ...getUserEnvironmentVariables(db) })
    const result = await trustFoldersInClaudeConfig(configPath, [folderPath])
    const wasMissing = result.newlyTrusted.includes(folderPath)
    if (wasMissing) {
      log.warn('Trust entry was missing while the CLI showed its trust dialog; written again', {
        configPath,
        folderPath
      })
    } else {
      log.warn(
        'CLI shows its trust dialog although the folder is trusted in the config it should read',
        { configPath, folderPath }
      )
    }
    return { wasMissing }
  } catch (error) {
    log.warn('Failed to re-assert folder trust', {
      folderPath,
      error: error instanceof Error ? error.message : String(error)
    })
    return { wasMissing: false }
  }
}

/**
 * Pre-flight before spawning a claude CLI session: make sure every folder the
 * CLI could resolve trust from is trusted in ~/.claude.json, so it doesn't
 * stall on the folder-trust dialog (which would swallow an argv prompt behind
 * an interactive question).
 *
 * The CLI keys trust by cwd and inherits it from ancestor directories only.
 * Sessions run inside `~/.hive-worktrees/<project>/<branch>`, which is *not*
 * under the repo root, so trusting the root alone still leaves the dialog up
 * for every worktree (unless the user happens to have trusted `~` itself).
 * The worktree path is therefore trusted on every launch — an already-trusted
 * entry is a single config read with no rewrite. The repo root is checked once
 * per project and then stamped `trust_check_done`.
 *
 * Connection projects (and ad-hoc connections launched from a git project)
 * run their sessions in a local symlink directory under `~/.hive/connections`,
 * which is likewise outside every repo root, so that directory arrives here as
 * `worktreePath` and is trusted the same way. A connection project's own
 * `path` (`~/.hive/connection-projects/<id>`) is never a session cwd, so the
 * root check is skipped for it. Never throws: a failed pre-flight must not
 * block the session launch.
 */
export async function ensureProjectTrustCheck(
  db: TrustCheckDb,
  projectId: string,
  opts?: { configPath?: string; worktreePath?: string | null }
): Promise<void> {
  try {
    const project = db.getProject(projectId)
    if (!project) return

    const isConnectionProject = (project.kind ?? 'git') === 'connection'
    const needsRootCheck = !isConnectionProject && !project.trust_check_done
    const folders: string[] = []
    if (needsRootCheck) folders.push(project.path)
    if (opts?.worktreePath && opts.worktreePath !== project.path) {
      folders.push(opts.worktreePath)
    }
    if (folders.length === 0) return

    // The spawned CLI's env is process.env with the user's settings env vars
    // assigned on top (see pty-service/claude-cli-spawner) — resolve the config
    // path from that same view.
    const configPath =
      opts?.configPath ??
      resolveClaudeConfigPath({ ...process.env, ...getUserEnvironmentVariables(db) })
    const trusted = await ensureFoldersTrustedInClaudeConfig(configPath, folders)
    if (trusted && needsRootCheck) {
      db.updateProjectTrustCheck(project.id, true)
    }
  } catch (error) {
    log.warn('Claude trust pre-flight failed; continuing session launch', {
      projectId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
