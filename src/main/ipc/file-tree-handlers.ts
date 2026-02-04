import { ipcMain, BrowserWindow } from 'electron'
import * as chokidar from 'chokidar'
import { promises as fs, existsSync, statSync } from 'fs'
import { join, extname, relative } from 'path'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'FileTreeHandlers' })

// File tree node structure
export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  extension: string | null
  children?: FileTreeNode[]
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
async function scanDirectory(
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

    // Sort entries: directories first, then files, both alphabetically
    const sortedEntries = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    for (const entry of sortedEntries) {
      const entryPath = join(dirPath, entry.name)
      const relativePath = relative(rootPath, entryPath)

      // Skip ignored directories and files
      if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) {
        continue
      }
      if (!entry.isDirectory() && IGNORE_FILES.has(entry.name)) {
        continue
      }

      // Skip hidden files/folders (starting with .) except important ones
      if (entry.name.startsWith('.') && ![''].includes(entry.name)) {
        continue
      }

      if (entry.isDirectory()) {
        // Lazy loading: only get children for first level initially
        const children =
          currentDepth < 1 ? await scanDirectory(entryPath, rootPath, maxDepth, currentDepth + 1) : undefined

        nodes.push({
          name: entry.name,
          path: entryPath,
          relativePath,
          isDirectory: true,
          extension: null,
          children
        })
      } else {
        nodes.push({
          name: entry.name,
          path: entryPath,
          relativePath,
          isDirectory: false,
          extension: extname(entry.name).toLowerCase() || null
        })
      }
    }

    return nodes
  } catch (error) {
    log.error('Failed to scan directory', error instanceof Error ? error : new Error(String(error)), { dirPath })
    return []
  }
}

/**
 * Scan a single directory for lazy loading
 */
async function scanSingleDirectory(dirPath: string, rootPath: string): Promise<FileTreeNode[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const nodes: FileTreeNode[] = []

    const sortedEntries = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    for (const entry of sortedEntries) {
      const entryPath = join(dirPath, entry.name)
      const relativePath = relative(rootPath, entryPath)

      if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) {
        continue
      }
      if (!entry.isDirectory() && IGNORE_FILES.has(entry.name)) {
        continue
      }
      if (entry.name.startsWith('.')) {
        continue
      }

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: entryPath,
          relativePath,
          isDirectory: true,
          extension: null,
          children: undefined // Will be loaded lazily
        })
      } else {
        nodes.push({
          name: entry.name,
          path: entryPath,
          relativePath,
          isDirectory: false,
          extension: extname(entry.name).toLowerCase() || null
        })
      }
    }

    return nodes
  } catch (error) {
    log.error('Failed to scan single directory', error instanceof Error ? error : new Error(String(error)), { dirPath })
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
        log.error('Failed to scan directory', error instanceof Error ? error : new Error(message), { dirPath })
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
        log.error('Failed to start file watcher', error instanceof Error ? error : new Error(message), { worktreePath })
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
      log.error('Failed to close watcher', error instanceof Error ? error : new Error(String(error)), { path })
    }
  }
  watchers.clear()

  // Clear all debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
}
