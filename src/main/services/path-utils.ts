import { realpathSync } from 'fs'
import { resolve } from 'path'

export function normalizeWorktreePath(worktreePath: string): string {
  try {
    return realpathSync(worktreePath)
  } catch {
    return resolve(worktreePath)
  }
}
