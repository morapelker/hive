import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { getDatabase } from '../db'
import type { Project } from '../db/types'
import { gitService } from '../effect/git/facade'
import {
  describeDevFolder,
  findProjectByOrigin,
  safeCloneDirName,
  uniquePath
} from './clone-destination'
import { resolveDevFolder } from './dev-folder/dev-folder-settings'
import { execGit } from './git-exec'
import { cloneRepository, deriveProjectNameFromGitUrl } from './git-repository'
import { createProjectWithDefaultWorktree } from './project-ops'
import { syncWorktreesOp } from './worktree-ops'
import { requireSuccess } from '@shared/operation-result'

/**
 * Normalize a git remote URL to `host/path` for equivalence comparison, so
 * `git@github.com:org/repo.git`, `ssh://git@github.com/org/repo` and
 * `https://github.com/org/repo.git` all match the same repo instead of
 * cloning a second copy into the dev folder.
 */
export function normalizeGitUrl(url: string): string {
  let u = url.trim()
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.*)$/.exec(u)
  if (scp) {
    // scp-like syntax: [user@]host:path
    u = `${scp[1]}/${scp[2]}`
  } else {
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme
    u = u.replace(/^[^@/]+@/, '') // userinfo
  }
  return u
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
}

/**
 * Ensure a remote-side project exists for the given git URL, cloning it into
 * `<dev folder>/<name>` if no existing project's `origin` remote already
 * matches. Reused by teleport receive and by launch-on-cloud.
 *
 * The dev folder is read when the clone is about to start, so a change in
 * Settings › General applies to the next call. The folder name comes from the
 * URL, else from the project name the caller gave; both arrive from another
 * machine, so each is reduced to a plain name first and the call is refused
 * when neither gives one.
 */
export async function ensureRemoteProject(gitUrl: string, projectName: string): Promise<Project> {
  const db = getDatabase()

  const existing = await findProjectByOrigin(normalizeGitUrl(gitUrl), {
    db,
    git: {
      getRemoteUrl: async (path) => {
        const remote = await gitService.getRemoteUrl(path, 'origin')
        return remote.success && remote.url ? remote.url : null
      }
    },
    normalize: normalizeGitUrl
  })
  if (existing) {
    // Best-effort refresh: a fetch failure (offline, transient auth) must
    // not disqualify the matched project — callers that need fresh refs
    // fetch again themselves and surface their own error.
    try {
      await execGit(existing.path, ['fetch', 'origin'])
    } catch {
      // Reuse the matched project with possibly stale refs.
    }
    return existing
  }

  const dirName =
    safeCloneDirName(deriveProjectNameFromGitUrl(gitUrl)) ?? safeCloneDirName(projectName)
  if (!dirName) {
    // The address is left out of the sentence: it can carry a token.
    throw new Error(
      `Cannot choose a folder for the clone of "${projectName}": neither the repository ` +
        'address nor that name can be used as a folder name.'
    )
  }
  const devFolder = resolveDevFolder(db)
  const destDir = uniquePath(join(devFolder, dirName))
  try {
    mkdirSync(devFolder, { recursive: true })
  } catch (error) {
    throw new Error(
      `Could not create ${describeDevFolder(devFolder)}: ` +
        (error instanceof Error ? error.message : String(error))
    )
  }
  const cloneResult = await cloneRepository(gitUrl, destDir)
  requireSuccess(cloneResult, 'Failed to clone remote project')
  const project = createProjectWithDefaultWorktree(db, { name: dirName, path: destDir })
  requireSuccess(
    await syncWorktreesOp({ projectId: project.id, projectPath: destDir }),
    'Failed to sync cloned project worktrees'
  )
  return project
}
