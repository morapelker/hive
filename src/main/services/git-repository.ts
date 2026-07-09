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

const STANDARD_PORTS_BY_SCHEME: Record<string, string> = {
  ssh: '22',
  https: '443',
  http: '80',
  git: '9418'
}

/**
 * Normalize a git remote URL so that ssh/https/scp-like forms of the same
 * repository compare equal. Returns null for null/undefined/empty input and
 * never throws, even for unparseable garbage.
 */
export function normalizeGitRemoteUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null
  const trimmed = url.trim()
  if (!trimmed) return null

  try {
    // scp-like syntax: user@host:org/repo(.git) — but not a URL scheme like ssh://
    const scpMatch = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
    if (scpMatch && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
      const host = scpMatch[1].toLowerCase()
      const path = stripPathDecorations(scpMatch[2])
      return `${host}/${path}`
    }

    const schemeMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.+)$/)
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase()
      const rest = schemeMatch[2]

      // Strip userinfo (user@ or user:pass@) before the host.
      const afterAuth = rest.replace(/^[^/@]+@/, '')

      const hostMatch = afterAuth.match(/^([^/]+)(\/.*)?$/)
      if (!hostMatch) return trimmed

      let hostPort = hostMatch[1]
      const pathPart = hostMatch[2] ?? ''

      let port: string | null = null
      const portMatch = hostPort.match(/^(.+):(\d+)$/)
      if (portMatch) {
        hostPort = portMatch[1]
        port = portMatch[2]
      }

      const host = hostPort.toLowerCase()
      const standardPort = STANDARD_PORTS_BY_SCHEME[scheme]
      const keepPort = port && port !== standardPort ? port : null

      const path = stripPathDecorations(pathPart.replace(/^\//, ''))
      const hostWithPort = keepPort ? `${host}:${keepPort}` : host
      return path ? `${hostWithPort}/${path}` : hostWithPort
    }

    return trimmed
  } catch {
    return trimmed
  }
}

function stripPathDecorations(path: string): string {
  return path.replace(/\/+$/, '').replace(/\.git$/i, '')
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
