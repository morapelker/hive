import * as chokidar from 'chokidar'
import { join } from 'path'
import { existsSync, statSync, readFileSync } from 'fs'
import { BrowserWindow } from 'electron'
import { createLogger } from './logger'

const log = createLogger({ component: 'BranchWatcher' })

/**
 * BranchWatcher — lightweight HEAD-only watcher for sidebar branch display.
 *
 * Uses a SINGLE shared chokidar FSWatcher instance to watch all .git/HEAD files,
 * rather than creating a separate watcher per worktree. On macOS, each chokidar
 * instance creates its own FSEvents stream — the kernel sends ALL filesystem events
 * to every stream. Consolidating into one watcher eliminates O(N) amplification
 * for N worktrees.
 *
 * Includes refcounting so multiple renderer components can watch/unwatch the same
 * path without premature teardown.
 *
 * Emits 'git:branchChanged' events to the renderer.
 */

const DEBOUNCE_MS = 300

interface PathEntry {
  worktreePath: string
  debounceTimer: ReturnType<typeof setTimeout> | null
  refCount: number
}

// Single shared watcher — created lazily on first watchBranch, destroyed when last path is unwatched
let sharedWatcher: chokidar.FSWatcher | null = null

// Per-path metadata, keyed by the resolved HEAD file path
const watchedPaths = new Map<string, PathEntry>()

// Reverse lookup: worktreePath → headPath (for unwatchBranch which receives worktreePath)
const worktreeToHead = new Map<string, string>()

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
  // Check if already watching this worktree — bump refCount
  const existingHead = worktreeToHead.get(worktreePath)
  if (existingHead) {
    const entry = watchedPaths.get(existingHead)
    if (entry) {
      entry.refCount++
      log.info('Incremented branch watcher refCount', { worktreePath, refCount: entry.refCount })
      return
    }
  }

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

  // Create shared watcher lazily on first path
  if (!sharedWatcher) {
    sharedWatcher = chokidar.watch([], {
      persistent: true,
      ignoreInitial: true
    })

    sharedWatcher.on('change', (changedPath) => {
      const entry = watchedPaths.get(changedPath)
      if (!entry) return

      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null
        emitBranchChanged(entry.worktreePath)
      }, DEBOUNCE_MS)
    })

    sharedWatcher.on('error', (error) => {
      log.error('Branch watcher error', error)
    })

    log.info('Shared branch watcher created')
  }

  // Add this HEAD path to the shared watcher
  sharedWatcher.add(headPath)
  watchedPaths.set(headPath, { worktreePath, debounceTimer: null, refCount: 1 })
  worktreeToHead.set(worktreePath, headPath)

  log.info('Branch watcher started', { worktreePath, headPath, totalPaths: watchedPaths.size })
}

export async function unwatchBranch(worktreePath: string): Promise<void> {
  const headPath = worktreeToHead.get(worktreePath)
  if (!headPath) return

  const entry = watchedPaths.get(headPath)
  if (!entry) return

  // Decrement refCount — keep watching if other consumers still need it
  entry.refCount = Math.max(0, entry.refCount - 1)
  if (entry.refCount > 0) {
    log.info('Decremented branch watcher refCount', { worktreePath, refCount: entry.refCount })
    return
  }

  log.info('Stopping branch watcher (refCount reached 0)', { worktreePath })

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)

  // Remove path from shared watcher
  if (sharedWatcher) {
    sharedWatcher.unwatch(headPath)
  }

  watchedPaths.delete(headPath)
  worktreeToHead.delete(worktreePath)

  // If no more paths, close the shared watcher entirely
  if (watchedPaths.size === 0 && sharedWatcher) {
    log.info('Closing shared branch watcher (no more paths)')
    try {
      await sharedWatcher.close()
    } catch (error) {
      log.error(
        'Failed to close shared branch watcher',
        error instanceof Error ? error : new Error(String(error))
      )
    }
    sharedWatcher = null
  }
}

export function getBranchWatcherCount(): number {
  return watchedPaths.size
}

export async function cleanupBranchWatchers(): Promise<void> {
  log.info('Cleaning up all branch watchers', { count: watchedPaths.size })

  // Clear all debounce timers
  for (const entry of watchedPaths.values()) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  }

  watchedPaths.clear()
  worktreeToHead.clear()

  if (sharedWatcher) {
    try {
      await sharedWatcher.close()
    } catch (error) {
      log.error(
        'Failed to close shared branch watcher during cleanup',
        error instanceof Error ? error : new Error(String(error))
      )
    }
    sharedWatcher = null
  }
}
