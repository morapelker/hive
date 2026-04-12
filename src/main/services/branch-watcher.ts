import * as chokidar from 'chokidar'
import { join } from 'path'
import { existsSync, statSync, readFileSync } from 'fs'
import { BrowserWindow } from 'electron'
import { createLogger } from './logger'

const log = createLogger({ component: 'BranchWatcher' })

/**
 * BranchWatcher — lightweight HEAD-only watcher for sidebar branch display.
 *
 * Unlike the full WorktreeWatcher (which watches the entire working tree + all
 * .git metadata), this only watches .git/HEAD per worktree. This is sufficient
 * to detect branch switches and uses negligible resources.
 *
 * Emits 'git:branchChanged' events to the renderer.
 */

const DEBOUNCE_MS = 300

interface BranchWatcherEntry {
  watcher: chokidar.FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, BranchWatcherEntry>()
let mainWindow: BrowserWindow | null = null

/**
 * Resolve the git dir for a worktree path.
 * For linked worktrees, .git is a file containing "gitdir: /path/to/.git/worktrees/name".
 * For main worktrees, .git is a directory.
 */
function resolveGitDir(worktreePath: string): string | null {
  const dotGit = join(worktreePath, '.git')
  if (!existsSync(dotGit)) return null

  try {
    const stat = statSync(dotGit)
    if (stat.isDirectory()) {
      return dotGit
    }
    const content = readFileSync(dotGit, 'utf-8').trim()
    const match = content.match(/^gitdir:\s*(.+)$/)
    if (match) {
      return match[1]
    }
  } catch {
    // Fall through
  }
  return null
}

function emitBranchChanged(worktreePath: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('git:branchChanged', { worktreePath })
}

export function initBranchWatcher(window: BrowserWindow): void {
  mainWindow = window
  log.info('BranchWatcher initialized')
}

export async function watchBranch(worktreePath: string): Promise<void> {
  if (watchers.has(worktreePath)) return

  const gitDir = resolveGitDir(worktreePath)
  if (!gitDir) {
    log.warn('Cannot watch branch — no .git dir found', { worktreePath })
    return
  }

  const headPath = join(gitDir, 'HEAD')
  if (!existsSync(headPath)) {
    log.warn('Cannot watch branch — HEAD not found', { worktreePath, headPath })
    return
  }

  const watcher = chokidar.watch(headPath, {
    persistent: true,
    ignoreInitial: true
  })

  const entry: BranchWatcherEntry = { watcher, debounceTimer: null }

  watcher.on('change', () => {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      emitBranchChanged(worktreePath)
    }, DEBOUNCE_MS)
  })

  watcher.on('error', (error) => {
    log.error('Branch watcher error', error, { worktreePath })
  })

  watchers.set(worktreePath, entry)
  log.info('Branch watcher started', { worktreePath, headPath })
}

export async function unwatchBranch(worktreePath: string): Promise<void> {
  const entry = watchers.get(worktreePath)
  if (!entry) return

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)

  try {
    await entry.watcher.close()
  } catch (error) {
    log.error(
      'Failed to close branch watcher',
      error instanceof Error ? error : new Error(String(error)),
      { worktreePath }
    )
  }

  watchers.delete(worktreePath)
}

export async function cleanupBranchWatchers(): Promise<void> {
  log.info('Cleaning up all branch watchers', { count: watchers.size })
  const paths = Array.from(watchers.keys())
  for (const path of paths) {
    await unwatchBranch(path)
  }
}
