import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { getDatabase } from '../db'
import type { Project } from '../db/types'
import { gitService } from '../effect/git/facade'
import { execGit } from './git-exec'
import { cloneRepository, deriveProjectNameFromGitUrl } from './git-repository'
import { createProjectWithDefaultWorktree } from './project-ops'
import { syncWorktreesOp } from './worktree-ops'

function requireSuccess(result: { success: boolean; error?: string }, fallback: string): void {
  if (!result.success) throw new Error(result.error || fallback)
}

function uniquePath(basePath: string): string {
  if (!existsSync(basePath)) return basePath
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${basePath}-${i}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`Could not choose a free path for ${basePath}`)
}

/**
 * Normalize a git remote URL to `host/path` for equivalence comparison, so
 * `git@github.com:org/repo.git`, `ssh://git@github.com/org/repo` and
 * `https://github.com/org/repo.git` all match the same repo instead of
 * cloning a duplicate copy under ~/hive-projects.
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
 * `~/hive-projects/<name>` if no existing project's `origin` remote already
 * matches. Reused by teleport receive and by launch-on-cloud.
 */
export async function ensureRemoteProject(gitUrl: string, projectName: string): Promise<Project> {
  const db = getDatabase()

  for (const candidate of db.getAllProjects()) {
    const remote = await gitService.getRemoteUrl(candidate.path, 'origin')
    if (remote.success && remote.url && normalizeGitUrl(remote.url) === normalizeGitUrl(gitUrl)) {
      await execGit(candidate.path, ['fetch', 'origin'])
      return candidate
    }
  }

  const derivedName = deriveProjectNameFromGitUrl(gitUrl) ?? projectName
  const destDir = uniquePath(join(homedir(), 'hive-projects', derivedName))
  mkdirSync(dirname(destDir), { recursive: true })
  const cloneResult = await cloneRepository(gitUrl, destDir)
  requireSuccess(cloneResult, 'Failed to clone remote project')
  const project = createProjectWithDefaultWorktree(db, { name: derivedName, path: destDir })
  requireSuccess(
    await syncWorktreesOp({ projectId: project.id, projectPath: destDir }),
    'Failed to sync cloned project worktrees'
  )
  return project
}
