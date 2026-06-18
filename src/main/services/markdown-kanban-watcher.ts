import * as chokidar from 'chokidar'
import { basename, normalize } from 'node:path'

import { MARKDOWN_KANBAN_CHANGED_CHANNEL } from '../../shared/kanban-events'
import { getDatabase } from '../db'
import {
  configuredFolders,
  isMarkdownCandidate,
  parseMarkdownConfig
} from './kanban-markdown-paths'
import { createLogger } from './logger'

const log = createLogger({ component: 'MarkdownKanbanWatcher' })

const DEBOUNCE_MS = 300
const SELF_WRITE_SUPPRESSION_MS = 2_000

type MarkdownKanbanWatchEventType = 'add' | 'change' | 'unlink'
type MarkdownKanbanEventPublisher = (channel: string, payload: unknown) => void | Promise<void>

let markdownKanbanEventPublisher: MarkdownKanbanEventPublisher | null = null

export const setMarkdownKanbanEventPublisher = (
  publisher: MarkdownKanbanEventPublisher | null
): void => {
  markdownKanbanEventPublisher = publisher
}

export interface MarkdownKanbanChangedEvent {
  projectId: string
  paths: string[]
  eventTypes: MarkdownKanbanWatchEventType[]
}

interface WatchEntry {
  watcher: chokidar.FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
  pendingPaths: Set<string>
  pendingEventTypes: Set<MarkdownKanbanWatchEventType>
}

const watchers = new Map<string, WatchEntry>()
const interestedProjectRefCounts = new Map<string, number>()
const suppressedPathsByProject = new Map<string, Map<string, number>>()
const projectWatchOperations = new Map<string, Promise<void>>()

export function initMarkdownKanbanWatcher(): void {
  log.info('Markdown Kanban watcher initialized')
}

export function suppressMarkdownKanbanWatch(
  projectId: string,
  paths: string | string[],
  durationMs: number = SELF_WRITE_SUPPRESSION_MS
): void {
  const pathList = Array.isArray(paths) ? paths : [paths]
  const normalizedPaths = pathList.map(normalizeWatchPath).filter(Boolean)
  if (normalizedPaths.length === 0) return

  const suppressedPaths = suppressedPathsByProject.get(projectId) ?? new Map<string, number>()
  const suppressUntil = Date.now() + durationMs
  for (const path of normalizedPaths) {
    suppressedPaths.set(path, suppressUntil)
  }
  suppressedPathsByProject.set(projectId, suppressedPaths)
}

export async function startMarkdownKanbanProjectWatch(
  projectId: string
): Promise<{ success: boolean; error?: string }> {
  return runProjectWatchOperation(
    projectId,
    async () => {
      const project = getDatabase().getProject(projectId)
      if (!project) return { success: false, error: `Project not found: ${projectId}` }

      interestedProjectRefCounts.set(
        projectId,
        (interestedProjectRefCounts.get(projectId) ?? 0) + 1
      )

      if (project.kanban_storage_mode !== 'markdown') {
        return { success: true }
      }

      if (!watchers.has(projectId)) await replaceProjectWatch(projectId)
      return { success: true }
    },
    'start'
  )
}

async function runProjectWatchOperation<T>(
  projectId: string,
  operation: () => Promise<T>,
  operationName: string
): Promise<T | { success: boolean; error?: string }> {
  const previous = projectWatchOperations.get(projectId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  const tracked = current.then(
    () => undefined,
    () => undefined
  )
  projectWatchOperations.set(projectId, tracked)
  try {
    return await current
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(
      `Failed to ${operationName} markdown Kanban watcher`,
      error instanceof Error ? error : new Error(message),
      {
        projectId
      }
    )
    return { success: false, error: message }
  } finally {
    if (projectWatchOperations.get(projectId) === tracked) {
      projectWatchOperations.delete(projectId)
    }
  }
}

export async function stopMarkdownKanbanProjectWatch(
  projectId: string,
  options: { force?: boolean } = {}
): Promise<{ success: boolean; error?: string }> {
  return runProjectWatchOperation(
    projectId,
    async () => {
      if (options.force) {
        interestedProjectRefCounts.delete(projectId)
        const entry = watchers.get(projectId)
        if (entry) await closeEntry(projectId, entry)
        return { success: true }
      }

      const nextRefCount = Math.max(0, (interestedProjectRefCounts.get(projectId) ?? 0) - 1)
      if (nextRefCount > 0) {
        interestedProjectRefCounts.set(projectId, nextRefCount)
        return { success: true }
      }

      interestedProjectRefCounts.delete(projectId)
      const entry = watchers.get(projectId)
      if (entry) await closeEntry(projectId, entry)
      return { success: true }
    },
    'stop'
  ) as Promise<{ success: boolean; error?: string }>
}

export async function deactivateMarkdownKanbanProjectWatch(projectId: string): Promise<void> {
  await runProjectWatchOperation(
    projectId,
    async () => {
      const entry = watchers.get(projectId)
      if (entry) await closeEntry(projectId, entry)
    },
    'deactivate'
  )
}

export async function restartMarkdownKanbanProjectWatch(projectId: string): Promise<void> {
  await runProjectWatchOperation(
    projectId,
    async () => {
      const existing = watchers.get(projectId)
      if (existing) await closeEntry(projectId, existing)

      const project = getDatabase().getProject(projectId)
      if (!project || project.kanban_storage_mode !== 'markdown') return
      if ((interestedProjectRefCounts.get(projectId) ?? 0) === 0) return
      await replaceProjectWatch(projectId)
    },
    'restart'
  )
}

export function getMarkdownKanbanWatcherCount(): number {
  return watchers.size
}

export async function cleanupMarkdownKanbanWatchers(): Promise<void> {
  await Promise.allSettled([...projectWatchOperations.values()])
  for (const [projectId, entry] of watchers) {
    await closeEntry(projectId, entry)
  }
  interestedProjectRefCounts.clear()
  suppressedPathsByProject.clear()
  projectWatchOperations.clear()
}

async function replaceProjectWatch(projectId: string): Promise<void> {
  const project = getDatabase().getProject(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)
  if (project.kanban_storage_mode !== 'markdown') return

  const folders = await configuredFolders(project, parseMarkdownConfig(project), false)
  const watcher = chokidar.watch(folders, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    followSymlinks: false,
    useFsEvents: false,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 50
    }
  })

  const entry: WatchEntry = {
    watcher,
    debounceTimer: null,
    pendingPaths: new Set(),
    pendingEventTypes: new Set()
  }

  watcher.on('add', (changedPath) => enqueueChange(projectId, entry, 'add', changedPath))
  watcher.on('change', (changedPath) => enqueueChange(projectId, entry, 'change', changedPath))
  watcher.on('unlink', (changedPath) => enqueueChange(projectId, entry, 'unlink', changedPath))
  watcher.on('error', (error) => {
    log.error(
      'Markdown Kanban watcher error',
      error instanceof Error ? error : new Error(String(error)),
      {
        projectId
      }
    )
  })

  const latestProject = getDatabase().getProject(projectId)
  if (
    !latestProject ||
    latestProject.kanban_storage_mode !== 'markdown' ||
    (interestedProjectRefCounts.get(projectId) ?? 0) === 0
  ) {
    await closeEntry(projectId, entry)
    return
  }

  const existing = watchers.get(projectId)
  if (existing) await closeEntry(projectId, existing)

  watchers.set(projectId, entry)
  log.info('Markdown Kanban watcher started', {
    projectId,
    folders,
    refCount: interestedProjectRefCounts.get(projectId) ?? 0
  })
}

function enqueueChange(
  projectId: string,
  entry: WatchEntry,
  eventType: MarkdownKanbanWatchEventType,
  changedPath: string
): void {
  if (!isMarkdownCandidate(basename(changedPath))) return
  if (isSuppressed(projectId, changedPath)) return

  entry.pendingPaths.add(changedPath)
  entry.pendingEventTypes.add(eventType)

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null
    flushChange(projectId, entry)
  }, DEBOUNCE_MS)
}

function flushChange(projectId: string, entry: WatchEntry): void {
  if (watchers.get(projectId) !== entry) return
  if (entry.pendingPaths.size === 0) return
  const paths = [...entry.pendingPaths]
  const eventTypes = [...entry.pendingEventTypes]
  entry.pendingPaths.clear()
  entry.pendingEventTypes.clear()

  const payload: MarkdownKanbanChangedEvent = { projectId, paths, eventTypes }
  void publishMarkdownKanbanChange(projectId, entry, payload)
}

async function publishMarkdownKanbanChange(
  projectId: string,
  entry: WatchEntry,
  payload: MarkdownKanbanChangedEvent
): Promise<void> {
  if (watchers.get(projectId) !== entry) return
  if (markdownKanbanEventPublisher) {
    await Promise.resolve(markdownKanbanEventPublisher(MARKDOWN_KANBAN_CHANGED_CHANNEL, payload))
    return
  }

  const { publishDesktopBackendEvent } = await import('../desktop/backend-event-publisher')
  if (watchers.get(projectId) !== entry) return
  await publishDesktopBackendEvent(MARKDOWN_KANBAN_CHANGED_CHANNEL, payload)
}

function isSuppressed(projectId: string, changedPath: string): boolean {
  const suppressedPaths = suppressedPathsByProject.get(projectId)
  if (!suppressedPaths) return false

  const now = Date.now()
  for (const [path, suppressUntil] of suppressedPaths) {
    if (now > suppressUntil) suppressedPaths.delete(path)
  }
  if (suppressedPaths.size === 0) {
    suppressedPathsByProject.delete(projectId)
    return false
  }

  const path = normalizeWatchPath(changedPath)
  const suppressUntil = suppressedPaths.get(path)
  return suppressUntil !== undefined && now <= suppressUntil
}

function normalizeWatchPath(path: string): string {
  return normalize(path)
}

async function closeEntry(projectId: string, entry: WatchEntry): Promise<void> {
  watchers.delete(projectId)
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  entry.pendingPaths.clear()
  entry.pendingEventTypes.clear()
  await entry.watcher.close()
  log.info('Markdown Kanban watcher stopped', { projectId })
}
