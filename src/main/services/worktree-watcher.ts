import * as chokidar from 'chokidar'
import { join } from 'path'
import { existsSync, statSync, readFileSync } from 'fs'
import { createLogger } from './logger'
import { emitGitStatusChanged } from './git-events'
import { GIT_STATUS_CHANGED_CHANNEL } from '../../shared/git-events'
import type { GitStatusChangedEvent } from '../../shared/types/git'

const log = createLogger({ component: 'WorktreeWatcher' })

type GitStatusChangedPublisher = (
  channel: typeof GIT_STATUS_CHANGED_CHANNEL,
  payload: GitStatusChangedEvent
) => void | Promise<void>

export interface WatchWorktreeOptions {
  readonly publishGitEvent?: GitStatusChangedPublisher
}

/**
 * WorktreeWatcherService
 *
 * Watches both working tree files AND key .git metadata files to detect
 * external changes (from AI agents, terminals, other editors, etc.).
 *
 * This runs in the main process, independent of any React component lifecycle.
 * It emits 'git:statusChanged' backend events whenever changes are detected.
 *
 * Watched paths:
 * - .git/index       -> stage/unstage/commit/stash/reset/checkout
 * - .git/HEAD        -> branch switch, commit, rebase, detached HEAD
 * - .git/refs/       -> push, pull, fetch, new branches, tags
 * - .git/MERGE_HEAD  -> merge in progress
 * - .git/REBASE_HEAD -> rebase in progress
 * - Working tree     -> file modifications, creates, deletes
 */

// Debounce config: .git events are bursty (commit touches index+HEAD+refs)
const GIT_DEBOUNCE_MS = 300
const WORKTREE_DEBOUNCE_MS = 500

interface WatcherEntry {
  gitWatcher: chokidar.FSWatcher | null
  worktreeWatcher: chokidar.FSWatcher
  gitDebounceTimer: ReturnType<typeof setTimeout> | null
  worktreeDebounceTimer: ReturnType<typeof setTimeout> | null
  refCount: number
  publishGitEvent?: GitStatusChangedPublisher
}

// Active watchers keyed by worktree path
const watchers = new Map<string, WatcherEntry>()

/**
 * Resolve the .git directory for a worktree path.
 * For linked worktrees, .git is a file containing "gitdir: /path/to/actual/.git/worktrees/name".
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
    // It's a file (linked worktree) - read the gitdir pointer
    const content = readFileSync(dotGit, 'utf-8').trim()
    const match = content.match(/^gitdir:\s*(.+)$/)
    if (match) {
      const gitdir = match[1]
      // For linked worktrees, the gitdir points to .git/worktrees/<name>
      // We want the parent .git directory for watching refs/HEAD
      // But we also need the worktree-specific gitdir for index
      return gitdir
    }
  } catch {
    // Fall through
  }
  return null
}

/**
 * Get the common .git dir (for refs, HEAD) from a worktree gitdir.
 * Linked worktrees have gitdir like /repo/.git/worktrees/branch-name
 * The common dir is /repo/.git
 */
function resolveCommonGitDir(gitDir: string): string {
  // Check if this is inside a worktrees subdirectory
  const worktreesIdx = gitDir.indexOf('.git/worktrees/')
  if (worktreesIdx !== -1) {
    return gitDir.substring(0, worktreesIdx + 4) // up to and including .git
  }
  return gitDir
}

function scheduleGitRefresh(entry: WatcherEntry, worktreePath: string): void {
  if (entry.gitDebounceTimer) {
    clearTimeout(entry.gitDebounceTimer)
  }
  entry.gitDebounceTimer = setTimeout(() => {
    entry.gitDebounceTimer = null
    publishGitStatusChanged(entry, { worktreePath })
  }, GIT_DEBOUNCE_MS)
}

function scheduleWorktreeRefresh(entry: WatcherEntry, worktreePath: string): void {
  if (entry.worktreeDebounceTimer) {
    clearTimeout(entry.worktreeDebounceTimer)
  }
  entry.worktreeDebounceTimer = setTimeout(() => {
    entry.worktreeDebounceTimer = null
    publishGitStatusChanged(entry, { worktreePath })
  }, WORKTREE_DEBOUNCE_MS)
}

function publishGitStatusChanged(entry: WatcherEntry, payload: GitStatusChangedEvent): void {
  if (entry.publishGitEvent) {
    void Promise.resolve(entry.publishGitEvent(GIT_STATUS_CHANGED_CHANNEL, payload)).catch(
      (error) => {
        log.error(
          'Failed to publish git status changed event',
          error instanceof Error ? error : new Error(String(error)),
          payload
        )
      }
    )
    return
  }

  emitGitStatusChanged(payload)
}

// Ignore patterns for working tree watcher (same as file-tree-watcher)
const WORKTREE_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/build/**',
  '**/dist/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/tmp/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/*.log'
]

export async function watchWorktree(
  worktreePath: string,
  options: WatchWorktreeOptions = {}
): Promise<void> {
  // If already watching, just bump the reference count
  const existing = watchers.get(worktreePath)
  if (existing) {
    existing.refCount++
    if (options.publishGitEvent) {
      existing.publishGitEvent = options.publishGitEvent
    }
    log.info('Incremented watcher refCount', { worktreePath, refCount: existing.refCount })
    return
  }

  log.info('Starting worktree watcher', { worktreePath })

  const gitDir = resolveGitDir(worktreePath)
  let gitWatcher: chokidar.FSWatcher | null = null

  if (gitDir) {
    const commonGitDir = resolveCommonGitDir(gitDir)

    // Build list of .git paths to watch
    const gitPaths: string[] = []

    // Watch index file (in worktree-specific gitdir for linked worktrees)
    const indexPath = join(gitDir, 'index')
    if (existsSync(indexPath)) {
      gitPaths.push(indexPath)
    }

    // Watch HEAD (worktree-specific HEAD for linked worktrees)
    const headPath = join(gitDir, 'HEAD')
    if (existsSync(headPath)) {
      gitPaths.push(headPath)
    }

    // Watch refs directory (always in common git dir)
    const refsPath = join(commonGitDir, 'refs')
    if (existsSync(refsPath)) {
      gitPaths.push(refsPath)
    }

    // Watch MERGE_HEAD, REBASE_HEAD, CHERRY_PICK_HEAD (in worktree gitdir).
    // These rarely exist when the watcher starts — chokidar watches the
    // not-yet-existing path via the gitdir and emits 'add' when a merge/rebase
    // begins and 'unlink' when it ends, so in-progress states reflect live.
    for (const specialFile of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
      gitPaths.push(join(gitDir, specialFile))
    }

    if (gitPaths.length > 0) {
      gitWatcher = chokidar.watch(gitPaths, {
        persistent: true,
        ignoreInitial: true,
        // Don't use awaitWriteFinish for .git files - they're written atomically
        depth: 3, // refs/heads/*, refs/tags/*, refs/remotes/*/*
        // The native fsevents backend deadlocks during process teardown — never use it
        useFsEvents: false
      })
    }
  }

  // Working tree watcher (for file modifications before staging)
  const worktreeWatcher = chokidar.watch(worktreePath, {
    ignored: WORKTREE_IGNORE_PATTERNS,
    persistent: true,
    ignoreInitial: true,
    depth: 10,
    // The native fsevents backend deadlocks during process teardown — never use it
    useFsEvents: false
  })

  const entry: WatcherEntry = {
    gitWatcher,
    worktreeWatcher,
    gitDebounceTimer: null,
    worktreeDebounceTimer: null,
    refCount: 1,
    publishGitEvent: options.publishGitEvent
  }

  // Attach git watcher handlers after entry is initialized
  if (gitWatcher) {
    gitWatcher.on('change', (path) => {
      log.info('Git metadata changed', { path, worktreePath })
      scheduleGitRefresh(entry, worktreePath)
    })
    gitWatcher.on('add', (path) => {
      log.info('Git metadata added', { path, worktreePath })
      scheduleGitRefresh(entry, worktreePath)
    })
    gitWatcher.on('unlink', (path) => {
      log.info('Git metadata removed', { path, worktreePath })
      scheduleGitRefresh(entry, worktreePath)
    })
    gitWatcher.on('error', (error) => {
      log.error('Git watcher error', error, { worktreePath })
    })
  }

  worktreeWatcher.on('add', () => scheduleWorktreeRefresh(entry, worktreePath))
  worktreeWatcher.on('change', () => scheduleWorktreeRefresh(entry, worktreePath))
  worktreeWatcher.on('unlink', () => scheduleWorktreeRefresh(entry, worktreePath))
  worktreeWatcher.on('addDir', () => scheduleWorktreeRefresh(entry, worktreePath))
  worktreeWatcher.on('unlinkDir', () => scheduleWorktreeRefresh(entry, worktreePath))
  worktreeWatcher.on('error', (error) => {
    log.error('Worktree watcher error', error, { worktreePath })
  })

  watchers.set(worktreePath, entry)
  log.info('Worktree watcher started', {
    worktreePath,
    hasGitWatcher: !!gitWatcher,
    gitDir: gitDir || 'not found'
  })
}

export async function unwatchWorktree(worktreePath: string): Promise<void> {
  const entry = watchers.get(worktreePath)
  if (!entry) return

  // Decrement refCount — if other consumers still need this watcher, keep it alive
  entry.refCount = Math.max(0, entry.refCount - 1)
  if (entry.refCount > 0) {
    log.info('Decremented watcher refCount', { worktreePath, refCount: entry.refCount })
    return
  }

  log.info('Stopping worktree watcher (refCount reached 0)', { worktreePath })

  // Clear debounce timers BEFORE map deletion — prevents a timer firing
  // between delete and clearTimeout from emitting a spurious status event.
  if (entry.gitDebounceTimer) clearTimeout(entry.gitDebounceTimer)
  if (entry.worktreeDebounceTimer) clearTimeout(entry.worktreeDebounceTimer)

  // Delete from map SYNCHRONOUSLY before async cleanup.
  // This prevents the race where a concurrent watchWorktree() sees the stale
  // entry via watchers.has(), returns early, then this delete removes it —
  // leaving no watcher at all.
  watchers.delete(worktreePath)

  // Close watchers (async, but map is already updated)
  try {
    if (entry.gitWatcher) await entry.gitWatcher.close()
  } catch (error) {
    log.error(
      'Failed to close git watcher',
      error instanceof Error ? error : new Error(String(error)),
      { worktreePath }
    )
  }

  try {
    await entry.worktreeWatcher.close()
  } catch (error) {
    log.error(
      'Failed to close worktree watcher',
      error instanceof Error ? error : new Error(String(error)),
      { worktreePath }
    )
  }

  log.info('Worktree watcher stopped', { worktreePath })
}

export function getWorktreeWatcherCount(): number {
  return watchers.size
}

export async function cleanupWorktreeWatchers(): Promise<void> {
  log.info('Cleaning up all worktree watchers', { count: watchers.size })
  const paths = Array.from(watchers.keys())
  for (const path of paths) {
    // Force refCount to 1 so the watcher is fully closed regardless of
    // how many consumers still hold a reference — we're shutting down.
    const entry = watchers.get(path)
    if (entry) entry.refCount = 1
    await unwatchWorktree(path)
  }
}
