import { realpathSync } from 'fs'
import { resolve, sep } from 'path'

export function normalizeWorktreePath(worktreePath: string): string {
  try {
    return realpathSync(worktreePath)
  } catch {
    return resolve(worktreePath)
  }
}

/**
 * True when `ancestorPath` equals `path` or contains it at any depth. Both
 * arguments must already be absolute, normalized paths (see
 * `normalizeWorktreePath`) — no normalization is applied here.
 */
export function isSameOrAncestorPath(ancestorPath: string, path: string): boolean {
  if (ancestorPath === path) return true
  const prefix = ancestorPath.endsWith(sep) ? ancestorPath : ancestorPath + sep
  return path.startsWith(prefix)
}
