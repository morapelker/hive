// The rules every flow that clones a repository on its own shares: a Teleport or
// launch-on-cloud receive and Discord /add-project both clone into the dev folder without
// asking where. They need the same answers to four
// questions: which folder name is safe, which path is free, is the repository here already,
// and may a folder that a failed clone left behind be deleted. Kept apart from all of them so
// that none has to import another to get the answers.
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { Project } from '../db/types'
import { isSameFolder } from './dev-folder/folder-identity'
import { normalizeGitRemoteUrl } from './git-repository'

/**
 * `.git` in every letter case (the usual volume of a Mac takes them all for one name), also
 * with dots and spaces after it: Windows and the disks formatted for it drop those from the
 * end of a name, so `.git.` is the folder `.git` there.
 */
const GIT_DIR_NAME = /^\.git[. ]*$/i

/**
 * The names the app keeps for itself in the dev folder: the temporary folder of a project that
 * is being moved there (`.hive-moving-…`) and the one made to see that the folder can be
 * written (`.hive-dev-folder-…`). A move deletes such a folder when it finds one left over.
 */
const APP_OWNED_NAME = /^\.hive-/i

/**
 * The zero-width and direction marks a Mac OS Extended volume leaves out when it compares two
 * names: with one of them anywhere in it, `.git` is still the folder `.git` there.
 */
const IGNORED_BY_SOME_VOLUMES = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g

/**
 * The directory name a clone may use: a plain name with no separator and no control
 * character. Null when the candidate gives none (the caller tries its next candidate).
 *
 * The candidates come from a URL or from another machine. A path collapses to its last
 * segment, so nothing can point outside the folder the clone goes into. Three kinds of plain
 * name are refused all the same: `.` and `..`, which are no folder of their own; `.git` (also
 * `.git.`), because a clone there would make the folder it is in a repository run by the
 * cloned configuration; and the names the app keeps for itself, because a clone there would be
 * deleted by the next move. Any other name that starts with a dot is the name of an ordinary
 * repository (`.github`, `.dotfiles`).
 *
 * A name is judged as a volume that ignores zero-width and direction marks would read it. A
 * name that passes keeps them: some scripts need them to spell a word.
 */
export function safeCloneDirName(name: string | null | undefined): string | null {
  if (!name) return null
  // eslint-disable-next-line no-control-regex
  const controlChars = /[\u0000-\u001f\u007f]/g
  const cleaned = basename(name.trim()).replace(controlChars, '').trim()
  const read = cleaned.replace(IGNORED_BY_SOME_VOLUMES, '')
  if (!read || read === '.' || read === '..') return null
  if (GIT_DIR_NAME.test(read) || APP_OWNED_NAME.test(read)) return null
  if (cleaned.includes('/') || cleaned.includes('\\') || basename(cleaned) !== cleaned) return null
  return cleaned
}

/** The first free of `<base>`, `<base>-2`, … `<base>-99`. */
export function uniquePath(
  basePath: string,
  exists: (path: string) => boolean = existsSync
): string {
  if (!exists(basePath)) return basePath
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${basePath}-${index}`
    if (!exists(candidate)) return candidate
  }
  throw new Error(`Could not choose a free path for ${basePath}`)
}

/** How an error names the dev folder, so the person reading it knows which setting it is. */
export function describeDevFolder(path: string): string {
  return `the dev folder set in Settings › General (${path})`
}

export interface FindProjectByOriginDeps {
  readonly db: { getAllProjects(): Project[]; getProject(id: string): Project | null }
  /** The `origin` remote URL of the repository at `path`; null when it has none or git failed. */
  readonly git: { getRemoteUrl(path: string): Promise<string | null> }
  /**
   * Makes a project's remote URL comparable with `origin`: the rule the caller normalised
   * `origin` with. `normalizeGitRemoteUrl` when absent.
   */
  readonly normalize?: (url: string) => string | null
}

/**
 * The first git project whose `origin` remote is `origin`, which the caller has already
 * normalised. Never a connection project: that is a folder of links, not a repository.
 *
 * The rows are read once and git is then asked about one project after another, which takes
 * seconds with a few hundred projects. A project moved to the dev folder meanwhile is renamed
 * on disk and in its row in one step, so git fails at the path this loop still holds. When git
 * has no answer for a candidate its row is therefore read again, and if the path changed git
 * is asked once more there. Without that the project would look absent and be cloned a second
 * time.
 */
export async function findProjectByOrigin(
  origin: string,
  deps: FindProjectByOriginDeps
): Promise<Project | null> {
  const normalize = deps.normalize ?? normalizeGitRemoteUrl
  const originAt = async (path: string): Promise<string | null> => {
    try {
      const remote = await deps.git.getRemoteUrl(path)
      return remote ? normalize(remote) : null
    } catch {
      return null
    }
  }
  for (const candidate of deps.db.getAllProjects()) {
    if (candidate.kind === 'connection') continue
    const found = await originAt(candidate.path)
    if (found === origin) return candidate
    if (found !== null) continue
    const current = deps.db.getProject(candidate.id)
    if (!current || current.path === candidate.path) continue
    if ((await originAt(current.path)) === origin) return current
  }
  return null
}

/**
 * Whether a project is registered at this folder: a row with exactly this path, or one whose
 * path is the same folder under another spelling (through a symlink, or in another letter case
 * on a volume that ignores it).
 *
 * Asked before a folder that a failed clone left behind is deleted. The folder was free when
 * the clone chose it, so a project registered there now arrived meanwhile: moving a project to
 * the dev folder renames it and rewrites its row in one step. It is not the clone's to delete.
 * When the rows cannot be read the answer is true, because a folder left behind costs one
 * retry and a deleted project cannot be brought back.
 */
export function isRegisteredProjectFolder(
  db: { getAllProjects(): Project[] },
  path: string
): boolean {
  try {
    return db
      .getAllProjects()
      .some((project) => project.path === path || isSameFolder(project.path, path))
  } catch {
    return true
  }
}
