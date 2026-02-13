import * as chokidar from 'chokidar'
import { join } from 'path'
import { existsSync, statSync, readFileSync } from 'fs'
import { BrowserWindow } from 'electron'
import { createLogger } from './logger'

const log = createLogger({ component: 'WorktreeWatcher' })

/**
 * WorktreeWatcherService
 *
 * Watches both working tree files AND key .git metadata files to detect
 * external changes (from AI agents, terminals, other editors, etc.).
 *
 * This runs in the main process, independent of any React component lifecycle.
 * It emits 'git:statusChanged' events to the renderer whenever changes are detected.
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
}

// Active watchers keyed by worktree path
const watchers = new Map<string, WatcherEntry>()

// Main window reference
let mainWindow: BrowserWindow | null = null

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

function emitGitStatusChanged(worktreePath: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('git:statusChanged', { worktreePath })
}

function scheduleGitRefresh(entry: WatcherEntry, worktreePath: string): void {
  if (entry.gitDebounceTimer) {
    clearTimeout(entry.gitDebounceTimer)
  }
  entry.gitDebounceTimer = setTimeout(() => {
    entry.gitDebounceTimer = null
    emitGitStatusChanged(worktreePath)
  }, GIT_DEBOUNCE_MS)
}

function scheduleWorktreeRefresh(entry: WatcherEntry, worktreePath: string): void {
  if (entry.worktreeDebounceTimer) {
    clearTimeout(entry.worktreeDebounceTimer)
  }
  entry.worktreeDebounceTimer = setTimeout(() => {
    entry.worktreeDebounceTimer = null
    emitGitStatusChanged(worktreePath)
  }, WORKTREE_DEBOUNCE_MS)
}

// Ignore patterns for working tree watcher (same as file-tree-handlers)
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

export function initWorktreeWatcher(window: BrowserWindow): void {
  mainWindow = window
  log.info('WorktreeWatcher initialized')
}

export async function watchWorktree(worktreePath: string): Promise<void> {
  // Already watching this path
  if (watchers.has(worktreePath)) {
    log.info('Already watching worktree', { worktreePath })
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

    // Optionally watch MERGE_HEAD, REBASE_HEAD (in worktree gitdir)
    for (const specialFile of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
      const path = join(gitDir, specialFile)
      if (existsSync(path)) {
        gitPaths.push(path)
      }
    }

    if (gitPaths.length > 0) {
      gitWatcher = chokidar.watch(gitPaths, {
        persistent: true,
        ignoreInitial: true,
        // Don't use awaitWriteFinish for .git files - they're written atomically
        depth: 3 // refs/heads/*, refs/tags/*, refs/remotes/*/*
      })

      const entry = {
        gitWatcher,
        worktreeWatcher: null as unknown as chokidar.FSWatcher,
        gitDebounceTimer: null,
        worktreeDebounceTimer: null
      }

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
  }

  // Working tree watcher (for file modifications before staging)
  const worktreeWatcher = chokidar.watch(worktreePath, {
    ignored: WORKTREE_IGNORE_PATTERNS,
    persistent: true,
    ignoreInitial: true,
    depth: 10,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50
    }
  })

  const entry: WatcherEntry = {
    gitWatcher,
    worktreeWatcher,
    gitDebounceTimer: null,
    worktreeDebounceTimer: null
  }

  // If gitWatcher was created before the entry object, link it now
  if (gitWatcher) {
    // Re-attach handlers with the real entry reference
    gitWatcher.removeAllListeners()
    gitWatcher.on('change', () => scheduleGitRefresh(entry, worktreePath))
    gitWatcher.on('add', () => scheduleGitRefresh(entry, worktreePath))
    gitWatcher.on('unlink', () => scheduleGitRefresh(entry, worktreePath))
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

  log.info('Stopping worktree watcher', { worktreePath })

  // Clear debounce timers
  if (entry.gitDebounceTimer) clearTimeout(entry.gitDebounceTimer)
  if (entry.worktreeDebounceTimer) clearTimeout(entry.worktreeDebounceTimer)

  // Close watchers
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

  watchers.delete(worktreePath)
  log.info('Worktree watcher stopped', { worktreePath })
}

export async function cleanupWorktreeWatchers(): Promise<void> {
  log.info('Cleaning up all worktree watchers', { count: watchers.size })
  const paths = Array.from(watchers.keys())
  for (const path of paths) {
    await unwatchWorktree(path)
  }
}
