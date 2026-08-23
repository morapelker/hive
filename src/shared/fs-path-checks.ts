import { existsSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Sync fs checks shared by main and server project code. Kept Electron-free so the
 * server (browser/headless) build can import them statically: main/services/project-ops
 * imports Electron's `app` at module scope, so anything in that file needs a lazy
 * `await import(...)` from server code instead of a static import.
 */

export function isValidDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isGitRepository(path: string): boolean {
  try {
    const gitPath = join(path, '.git')
    return existsSync(gitPath) && statSync(gitPath).isDirectory()
  } catch {
    return false
  }
}

/**
 * The one spelling of a path we compare and store, or null when the filesystem
 * cannot resolve it. realpath rather than resolve, because the filesystem follows a
 * symlink before a "..", so resolving lexically can land on a different directory.
 */
export function tryCanonicalPath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * Canonical path, falling back to the lexical form when the filesystem cannot
 * resolve it. Only for comparing two paths, where a best effort beats nothing.
 * Anything that stores or opens the result should use tryCanonicalPath and handle
 * the null, because the lexical form can name a different directory.
 */
export function canonicalPath(path: string): string {
  return tryCanonicalPath(path) ?? resolve(path)
}
