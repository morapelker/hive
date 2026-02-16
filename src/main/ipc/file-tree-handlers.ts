import { ipcMain, BrowserWindow } from 'electron'
import * as chokidar from 'chokidar'
import { Dirent, promises as fs, existsSync, statSync } from 'fs'
import { join, extname, relative } from 'path'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'FileTreeHandlers' })

// File tree node structure
export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  extension: string | null
  children?: FileTreeNode[]
}

/**
 * Determine whether a directory entry is a directory, following symlinks.
 * `Dirent.isDirectory()` returns false for symlinks even when the target is a directory,
 * so we need to `fs.stat` the resolved path for symlink entries.
 */
async function isDirectoryEntry(entry: Dirent, entryPath: string): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink()) {
    try {
      const stat = await fs.stat(entryPath) // fs.stat follows symlinks
      return stat.isDirectory()
    } catch {
      return false // Broken symlink -- treat as file
    }
  }
  return false
}

// Ignore patterns for file watching
const IGNORE_PATTERNS = [
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

// Ignore check function for directory scanning
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  'dist',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  'tmp'
])

const IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db'])

// Map of active watchers by worktree path
const watchers = new Map<string, chokidar.FSWatcher>()

// Debounce timers by worktree path
const debounceTimers = new Map<string, NodeJS.Timeout>()

// Main window reference for sending events
let mainWindow: BrowserWindow | null = null

/**
 * Recursively scan a directory and build a file tree
 */
export async function scanDirectory(
  dirPath: string,
  rootPath: string,
  maxDepth: number = 10,
  currentDepth: number = 0
): Promise<FileTreeNode[]> {
  if (currentDepth >= maxDepth) {
    return []
  }

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const nodes: FileTreeNode[] = []

    // Pre-resolve symlink targets so sorting and classification are correct
    const resolved = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(dirPath, entry.name)
        const isSymlink = entry.isSymbolicLink()
        const isDir = await isDirectoryEntry(entry, entryPath)
        return { entry, entryPath, isDir, isSymlink }
      })
    )

    // Sort entries: directories first, then files, both alphabetically
    const sorted = resolved.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1
      if (!a.isDir && b.isDir) return 1
      return a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: 'base' })
    })

    for (const { entry, entryPath, isDir, isSymlink } of sorted) {
      const relativePath = relative(rootPath, entryPath)

      // Skip ignored directories and files
      if (isDir && IGNORE_DIRS.has(entry.name)) {
        continue
      }
      if (!isDir && IGNORE_FILES.has(entry.name)) {
        continue
      }

      if (isDir) {
        // Lazy loading: only get children for first level initially
        const children =
          currentDepth < 1
            ? await scanDirectory(entryPath, rootPath, maxDepth, currentDepth + 1)
            : undefined

        nodes.push({
          name: entry.name,
          path: entryPath,
          relativePath,
          isDirectory: true,
          ...(isSymlink && { isSymlink: true }),
          extension: null,
          children
        })
      } else {
        nodes.push({
          name: entry.name,
          path: entryPath,
          relativePath,
          isDirectory: false,
          ...(isSymlink && { isSymlink: true }),
          extension: extname(entry.name).toLowerCase() || null
        })
      }
    }

    return nodes
  } catch (error) {
    log.error(
      'Failed to scan directory',
      error instanceof Error ? error : new Error(String(error)),
      { dirPath }
    )
    return []
  }
}

/**
 * Scan a single directory for lazy loading
 */
export async function scanSingleDirectory(
  dirPath: string,
  rootPath: string
): Promise<FileTreeNode[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const nodes: FileTreeNode[] = []

    // Pre-resolve symlink targets so sorting and classification are correct
    const resolved = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(dirPath, entry.name)
        const isSymlink = entry.isSymbolicLink()
        const isDir = await isDirectoryEntry(entry, entryPath)
        return { entry, entryPath, isDir, isSymlink }
      })
    )

    const sorted = resolved.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1
      if (!a.isDir && b.isDir) return 1
      return a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: 'base' })
    })

    for (const { entry, entryPath, isDir, isSymlink } of sorted) {
      const relativePath = relative(rootPath, entryPath)

      if (isDir && IGNORE_DIRS.has(entry.name)) {
        continue
      }
      if (!isDir && IGNORE_FILES.has(entry.name)) {
        continue
      }
      if (isDir) {
        nodes.push({
          name: entry.name,
          path: entryPath,
          relativePath,
          isDirectory: true,
          ...(isSymlink && { isSymlink: true }),
          extension: null,
          children: undefined // Will be loaded lazily
        })
      } else {
        nodes.push({
          name: entry.name,
          path: entryPath,
          relativePath,
          isDirectory: false,
          ...(isSymlink && { isSymlink: true }),
          extension: extname(entry.name).toLowerCase() || null
        })
      }
    }

    return nodes
  } catch (error) {
    log.error(
      'Failed to scan single directory',
      error instanceof Error ? error : new Error(String(error)),
      { dirPath }
    )
    return []
  }
}

/**
 * Emit debounced file tree change event to renderer
 */
function emitFileTreeChange(worktreePath: string, eventType: string, changedPath: string): void {
  if (!mainWindow) return

  // Clear existing debounce timer
  const existingTimer = debounceTimers.get(worktreePath)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  // Set new debounce timer (100ms as per requirements)
  const timer = setTimeout(() => {
    debounceTimers.delete(worktreePath)
    mainWindow?.webContents.send('file-tree:change', {
      worktreePath,
      eventType,
      changedPath,
      relativePath: relative(worktreePath, changedPath)
    })
  }, 100)

  debounceTimers.set(worktreePath, timer)
}

export function registerFileTreeHandlers(window: BrowserWindow): void {
  mainWindow = window
  log.info('Registering file tree handlers')

  // Scan a directory and return the file tree
  ipcMain.handle(
    'file-tree:scan',
    async (
      _event,
      dirPath: string
    ): Promise<{
      success: boolean
      tree?: FileTreeNode[]
      error?: string
    }> => {
      log.info('Scanning directory', { dirPath })
      try {
        if (!existsSync(dirPath)) {
          return {
            success: false,
            error: 'Directory does not exist'
          }
        }

        const stat = statSync(dirPath)
        if (!stat.isDirectory()) {
          return {
            success: false,
            error: 'Path is not a directory'
          }
        }

        const tree = await scanDirectory(dirPath, dirPath)
        return {
          success: true,
          tree
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to scan directory', error instanceof Error ? error : new Error(message), {
          dirPath
        })
        return {
          success: false,
          error: message
        }
      }
    }
  )

  // Lazy load children for a directory
  ipcMain.handle(
    'file-tree:loadChildren',
    async (
      _event,
      dirPath: string,
      rootPath: string
    ): Promise<{
      success: boolean
      children?: FileTreeNode[]
      error?: string
    }> => {
      try {
        if (!existsSync(dirPath)) {
          return {
            success: false,
            error: 'Directory does not exist'
          }
        }

        const children = await scanSingleDirectory(dirPath, rootPath)
        return {
          success: true,
          children
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return {
          success: false,
          error: message
        }
      }
    }
  )

  // Start watching a directory for changes
  ipcMain.handle(
    'file-tree:watch',
    async (
      _event,
      worktreePath: string
    ): Promise<{
      success: boolean
      error?: string
    }> => {
      log.info('Starting file watcher', { worktreePath })
      try {
        // If already watching, return success
        if (watchers.has(worktreePath)) {
          return { success: true }
        }

        const watcher = chokidar.watch(worktreePath, {
          ignored: IGNORE_PATTERNS,
          persistent: true,
          ignoreInitial: true,
          depth: 10,
          awaitWriteFinish: {
            stabilityThreshold: 100,
            pollInterval: 50
          }
        })

        watcher.on('add', (path) => {
          emitFileTreeChange(worktreePath, 'add', path)
        })

        watcher.on('addDir', (path) => {
          emitFileTreeChange(worktreePath, 'addDir', path)
        })

        watcher.on('unlink', (path) => {
          emitFileTreeChange(worktreePath, 'unlink', path)
        })

        watcher.on('unlinkDir', (path) => {
          emitFileTreeChange(worktreePath, 'unlinkDir', path)
        })

        watcher.on('change', (path) => {
          emitFileTreeChange(worktreePath, 'change', path)
        })

        watcher.on('error', (error) => {
          log.error('File watcher error', error, { worktreePath })
        })

        watchers.set(worktreePath, watcher)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to start file watcher',
          error instanceof Error ? error : new Error(message),
          { worktreePath }
        )
        return {
          success: false,
          error: message
        }
      }
    }
  )

  // Stop watching a directory
  ipcMain.handle(
    'file-tree:unwatch',
    async (
      _event,
      worktreePath: string
    ): Promise<{
      success: boolean
      error?: string
    }> => {
      log.info('Stopping file watcher', { worktreePath })
      try {
        const watcher = watchers.get(worktreePath)
        if (watcher) {
          await watcher.close()
          watchers.delete(worktreePath)
        }

        // Clear any pending debounce timer
        const timer = debounceTimers.get(worktreePath)
        if (timer) {
          clearTimeout(timer)
          debounceTimers.delete(worktreePath)
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return {
          success: false,
          error: message
        }
      }
    }
  )
}

// Cleanup all watchers (called on app quit)
export async function cleanupFileTreeWatchers(): Promise<void> {
  log.info('Cleaning up file tree watchers', { count: watchers.size })
  for (const [path, watcher] of watchers) {
    try {
      await watcher.close()
      log.info('Closed watcher', { path })
    } catch (error) {
      log.error(
        'Failed to close watcher',
        error instanceof Error ? error : new Error(String(error)),
        { path }
      )
    }
  }
  watchers.clear()

  // Clear all debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
}
