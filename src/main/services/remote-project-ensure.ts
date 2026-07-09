import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { getDatabase } from '../db'
import type { Project } from '../db/types'
import { gitService } from '../effect/git/facade'
import { cloneRepository, deriveProjectNameFromGitUrl } from './git-repository'
import { createProjectWithDefaultWorktree } from './project-ops'
import { syncWorktreesOp } from './worktree-ops'

const execFileAsync = promisify(execFile)

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' })
  return stdout.trim()
}

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
 * Ensure a remote-side project exists for the given git URL, cloning it into
 * `~/hive-projects/<name>` if no existing project's `origin` remote already
 * matches. Reused by teleport receive and by launch-on-cloud.
 */
export async function ensureRemoteProject(gitUrl: string, projectName: string): Promise<Project> {
  const db = getDatabase()

  for (const candidate of db.getAllProjects()) {
    const remote = await gitService.getRemoteUrl(candidate.path, 'origin')
    if (remote.success && remote.url?.trim() === gitUrl.trim()) {
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
