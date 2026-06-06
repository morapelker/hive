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

export function isSafeGitRemoteUrl(url: string): boolean {
  if (!url || url.startsWith('-')) return false
  if (/[\s\x00-\x1f\x7f]/.test(url)) return false
  if (/^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(url)) return false

  if (/^https?:\/\//i.test(url)) return true
  if (/^ssh:\/\//i.test(url)) return true
  if (/^git:\/\//i.test(url)) return true
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(url)) return true

  return false
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
  if (!isSafeGitRemoteUrl(sshUrl)) {
    return {
      success: false,
      error: 'Refusing to clone unsupported/unsafe git URL'
    }
  }

  try {
    log.info('Cloning git repository', { sshUrl, destDir })
    await simpleGit()
      .env({ ...process.env, GIT_ALLOW_PROTOCOL: 'https:http:ssh:git' })
      .clone(sshUrl, destDir, ['--'])
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
