// Telling whether two paths are the same folder. Spelling is not enough: a symlink, a `..`,
// or another letter case on a case-insensitive volume all name a folder a second way, and the
// dev folder, the folders used before it and project parents are compared constantly.
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The real path in its on-disk spelling, or null when the filesystem cannot resolve it. The
 * native realpath, not the JS one: on a case-insensitive volume the JS one keeps the letter
 * case the caller typed.
 */
export const canonicalFolderPath = (path: string): string | null => {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/**
 * Whether two paths are the same directory: by device and inode when both exist, by canonical
 * (else resolved) spelling otherwise.
 */
export const isSameFolder = (a: string, b: string): boolean => {
  const left = resolve(a)
  const right = resolve(b)
  if (left === right) return true
  try {
    const leftStat = statSync(left, { bigint: true })
    const rightStat = statSync(right, { bigint: true })
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  } catch {
    // One of them is not on disk: fall through to spelling.
  }
  return (canonicalFolderPath(left) ?? left) === (canonicalFolderPath(right) ?? right)
}
