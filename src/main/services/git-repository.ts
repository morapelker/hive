import { execSync } from 'child_process'
import simpleGit from 'simple-git'
import { createLogger } from './logger'

const log = createLogger({ component: 'GitRepository' })

export interface InitRepositoryResult {
  readonly success: boolean
  readonly error?: string
}

export type CloneRepositoryResult = InitRepositoryResult

export function deriveProjectNameFromGitUrl(url: string): string | null {
  const raw = url.trim()
  if (!raw) return null

  const withoutQuery = raw.replace(/[?#].*$/, '')
  const hasTrailingSlash = /\/+$/.test(withoutQuery)
  if (hasTrailingSlash && !/\.git\/+$/i.test(withoutQuery)) return null

  const normalized = withoutQuery.replace(/\/+$/, '').replace(/\.git$/i, '')
  if (!normalized || /[/:]$/.test(normalized)) return null

  const match = normalized.match(/([^/:]+)$/)
  const name = match?.[1]?.trim()
  return name ? name : null
}

/**
 * Initialize a new git repository with main as the default branch.
 */
export function initRepository(path: string): InitRepositoryResult {
  try {
    log.info('Initializing git repository', { path })
    execSync('git init --initial-branch=main', { cwd: path, encoding: 'utf-8' })
    log.info('Git repository initialized successfully', { path })
    return { success: true }
  } catch (error) {
    log.error(
      'Failed to initialize git repository',
      error instanceof Error ? error : new Error(String(error)),
      { path }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function cloneRepository(
  sshUrl: string,
  destDir: string
): Promise<CloneRepositoryResult> {
  try {
    log.info('Cloning git repository', { sshUrl, destDir })
    await simpleGit().clone(sshUrl, destDir)
    log.info('Git repository cloned successfully', { sshUrl, destDir })
    return { success: true }
  } catch (error) {
    log.error(
      'Failed to clone git repository',
      error instanceof Error ? error : new Error(String(error)),
      { sshUrl, destDir }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
