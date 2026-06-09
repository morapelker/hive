import * as chokidar from 'chokidar'
import { relative } from 'path'

import { FILE_TREE_CHANGE_CHANNEL } from '../../shared/file-tree-events'
import type { FileEventType } from '../../shared/types/file-tree'
import { createLogger } from './logger'

const log = createLogger({ component: 'FileTreeWatcher' })

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

const watchers = new Map<string, chokidar.FSWatcher>()
const debounceTimers = new Map<string, NodeJS.Timeout>()
const pendingEvents = new Map<string, Array<{ eventType: FileEventType; changedPath: string }>>()

function isAddLike(eventType: FileEventType): boolean {
  return eventType === 'add' || eventType === 'addDir'
}

function isUnlinkLike(eventType: FileEventType): boolean {
  return eventType === 'unlink' || eventType === 'unlinkDir'
}

function deduplicateEvents(
  events: Array<{ eventType: FileEventType; changedPath: string }>
): Array<{ eventType: FileEventType; changedPath: string }> {
  const byPath = new Map<string, FileEventType>()
  const order: string[] = []

  for (const { eventType, changedPath } of events) {
    const existing = byPath.get(changedPath)

    if (existing === undefined) {
      byPath.set(changedPath, eventType)
      order.push(changedPath)
      continue
    }

    if (isAddLike(existing) && eventType === 'change') continue

    if (isAddLike(existing) && isUnlinkLike(eventType)) {
      byPath.delete(changedPath)
      continue
    }

    if (isUnlinkLike(existing) && isAddLike(eventType)) {
      byPath.set(changedPath, eventType)
      continue
    }

    if (existing === 'change' && eventType === 'change') continue

    byPath.set(changedPath, eventType)
  }

  const result: Array<{ eventType: FileEventType; changedPath: string }> = []
  for (const changedPath of order) {
    const eventType = byPath.get(changedPath)
    if (eventType !== undefined) {
      result.push({ eventType, changedPath })
    }
  }
  return result
}

function emitFileTreeChange(
  worktreePath: string,
  eventType: FileEventType,
  changedPath: string
): void {
  let queue = pendingEvents.get(worktreePath)
  if (!queue) {
    queue = []
    pendingEvents.set(worktreePath, queue)
  }
  queue.push({ eventType, changedPath })

  const existingTimer = debounceTimers.get(worktreePath)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(worktreePath)
    const raw = pendingEvents.get(worktreePath) ?? []
    pendingEvents.delete(worktreePath)

    const deduped = deduplicateEvents(raw)
    if (deduped.length === 0) return

    const events = deduped.map(({ eventType: et, changedPath: cp }) => ({
      eventType: et,
      changedPath: cp,
      relativePath: relative(worktreePath, cp)
    }))

    const payload = { worktreePath, events }
    void import('../desktop/backend-event-publisher').then(({ publishDesktopBackendEvent }) =>
      publishDesktopBackendEvent(FILE_TREE_CHANGE_CHANNEL, payload)
    )
  }, 100)

  debounceTimers.set(worktreePath, timer)
}

export function startFileTreeWatcher(worktreePath: string): { success: boolean } {
  log.info('Starting file watcher', { worktreePath })
  if (watchers.has(worktreePath)) {
    return { success: true }
  }

  const watcher = chokidar.watch(worktreePath, {
    ignored: IGNORE_PATTERNS,
    persistent: true,
    ignoreInitial: true,
    depth: 10,
    followSymlinks: false,
    // The native fsevents backend deadlocks the main thread during app quit
    // (fse_instance_destroy → uv_mutex_lock) — never use it
    useFsEvents: false
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
}

export async function stopFileTreeWatcher(worktreePath: string): Promise<{ success: boolean }> {
  log.info('Stopping file watcher', { worktreePath })
  const watcher = watchers.get(worktreePath)
  if (watcher) {
    await watcher.close()
    watchers.delete(worktreePath)
  }

  const timer = debounceTimers.get(worktreePath)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(worktreePath)
  }
  pendingEvents.delete(worktreePath)

  return { success: true }
}

export function getFileTreeWatcherCount(): number {
  return watchers.size
}

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

  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
  pendingEvents.clear()
}
