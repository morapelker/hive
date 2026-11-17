import * as chokidar from 'chokidar'
import { join } from 'path'
import { existsSync, statSync, readFileSync } from 'fs'
import { createLogger } from './logger'
import { emitGitBranchChanged } from './git-events'

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
 * Emits 'git:branchChanged' backend events.
 */

const DEBOUNCE_MS = 300

interface PathEntry {
  worktreePath: string
  gitDir: string
  debounceTimer: ReturnType<typeof setTimeout> | null
  refCount: number
}

// Single shared watcher — created lazily on first watchBranch, destroyed when last path is unwatched
let sharedWatcher: chokidar.FSWatcher | null = null

// Per-path metadata, keyed by the resolved HEAD file path
const watchedPaths = new Map<string, PathEntry>()

// Reverse lookup: worktreePath → headPath (for unwatchBranch which receives worktreePath)
const worktreeToHead = new Map<string, string>()

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
  emitGitBranchChanged({ worktreePath })
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
      ignoreInitial: true,
      // Every path added to this watcher is a gitdir directory; only its direct
      // children matter (we filter to HEAD below).
      depth: 0,
      // The native fsevents backend deadlocks during process teardown — never use it
      useFsEvents: false
    })

    // Git rewrites HEAD via lockfile-rename (HEAD.lock → rename over HEAD). A watch
    // on the HEAD file itself goes permanently stale on macOS once the inode is
    // replaced, so we watch the gitdir directory instead and filter events down to
    // HEAD. The rename can surface as change OR unlink+add — handle all three.
    const handleEvent = (changedPath: string): void => {
      const entry = watchedPaths.get(changedPath)
      if (!entry) return

      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null
        emitBranchChanged(entry.worktreePath)
      }, DEBOUNCE_MS)
    }

    sharedWatcher.on('change', handleEvent)
    sharedWatcher.on('add', handleEvent)
    sharedWatcher.on('unlink', handleEvent)

    sharedWatcher.on('error', (error) => {
      log.error('Branch watcher error', error)
    })

    log.info('Shared branch watcher created')
  }

  // Watch the gitdir directory; events are filtered to HEAD via watchedPaths
  sharedWatcher.add(gitDir)
  watchedPaths.set(headPath, { worktreePath, gitDir, debounceTimer: null, refCount: 1 })
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
    sharedWatcher.unwatch(entry.gitDir)
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

/**
 * Point the watch of a worktree at its git dir again after that git dir moved.
 *
 * A linked worktree's HEAD lives in the main checkout (`<checkout>/.git/worktrees/<name>`).
 * When the checkout is moved, the worktree stays where it is and `git worktree repair` rewrites
 * its `.git` pointer, but the watch is still on the old directory and never fires again.
 *
 * The same entry is watched under the new HEAD path, so its refCount (how many consumers asked
 * for this worktree) is untouched. Returns false, changing nothing, when the worktree is not
 * watched, when its git dir cannot be resolved or has no HEAD, or when it resolves to a
 * directory that is already watched (nothing moved, or the pointer was not repaired). Otherwise
 * ends with one `git:branchChanged`, so the sidebar re-reads the branch from the new place.
 */
export function rebindBranchWatch(worktreePath: string): boolean {
  const oldHead = worktreeToHead.get(worktreePath)
  if (!oldHead) return false
  const entry = watchedPaths.get(oldHead)
  if (!entry) return false

  const gitDir = resolveGitDir(worktreePath)
  if (!gitDir) return false
  const headPath = join(gitDir, 'HEAD')
  if (watchedPaths.has(headPath) || !existsSync(headPath)) return false

  // The move itself made chokidar report HEAD as removed; the refresh below replaces that one.
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
  }

  sharedWatcher?.unwatch(entry.gitDir)
  watchedPaths.delete(oldHead)
  entry.gitDir = gitDir
  watchedPaths.set(headPath, entry)
  // Every spelling of this worktree that was watched through the old HEAD follows it.
  for (const [watchedWorktree, head] of worktreeToHead) {
    if (head === oldHead) worktreeToHead.set(watchedWorktree, headPath)
  }
  sharedWatcher?.add(gitDir)

  log.info('Branch watcher rebound', { worktreePath, headPath })
  emitBranchChanged(worktreePath)
  return true
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
