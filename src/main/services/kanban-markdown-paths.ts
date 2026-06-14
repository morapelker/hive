import { mkdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'

import type { KanbanMarkdownConfig, KanbanTicketColumn, Project } from '../db'

const DEFAULT_MARKDOWN_CONFIG: KanbanMarkdownConfig = {
  layout: 'single-folder',
  singleFolder: 'docs/kanban',
  statusFolders: {
    todo: 'docs/kanban/todo',
    in_progress: 'docs/kanban/in-progress',
    review: 'docs/kanban/review',
    done: 'docs/kanban/done'
  }
}

export function getDefaultMarkdownConfig(): KanbanMarkdownConfig {
  return {
    ...DEFAULT_MARKDOWN_CONFIG,
    statusFolders: { ...DEFAULT_MARKDOWN_CONFIG.statusFolders! }
  }
}

export function parseMarkdownConfig(project: Project): KanbanMarkdownConfig {
  return parseMarkdownConfigResult(project).config
}

export function parseMarkdownConfigResult(project: Project): {
  config: KanbanMarkdownConfig
  repaired: boolean
} {
  if (!project.kanban_markdown_config) {
    return { config: getDefaultMarkdownConfig(), repaired: true }
  }
  try {
    const parsed = JSON.parse(project.kanban_markdown_config) as KanbanMarkdownConfig
    validateMarkdownConfigShape(parsed)
    return { config: parsed, repaired: false }
  } catch {
    return { config: getDefaultMarkdownConfig(), repaired: true }
  }
}

export function validateMarkdownConfigShape(config: KanbanMarkdownConfig): void {
  if (config.layout === 'single-folder') {
    if (!config.singleFolder?.trim()) throw new Error('A markdown folder is required')
    return
  }
  if (config.layout === 'status-folders') {
    if (
      !config.statusFolders?.todo ||
      !config.statusFolders.in_progress ||
      !config.statusFolders.review ||
      !config.statusFolders.done
    ) {
      throw new Error('Todo, in-progress, review, and done folders are required')
    }
    return
  }
  throw new Error('Invalid markdown Kanban folder layout')
}

export async function validateConfiguredFolders(
  project: Project,
  config: KanbanMarkdownConfig
): Promise<void> {
  const folders = await configuredFolders(project, config, false)
  const canonical = await Promise.all(folders.map((folder) => realpath(folder)))
  const stats = await Promise.all(canonical.map((folder) => stat(folder)))
  for (let index = 0; index < stats.length; index++) {
    if (!stats[index].isDirectory()) {
      throw new Error(`Configured Kanban path is not a directory: ${canonical[index]}`)
    }
  }
  const unique = new Set(canonical)
  if (unique.size !== canonical.length)
    throw new Error('Configured Kanban folders must be distinct')
  for (const a of canonical) {
    for (const b of canonical) {
      if (a !== b && relative(a, b) && !relative(a, b).startsWith('..')) {
        throw new Error('Configured Kanban folders cannot be nested inside each other')
      }
    }
  }
}

export async function configuredFolders(
  project: Project,
  config: KanbanMarkdownConfig,
  createMissing: boolean
): Promise<string[]> {
  const paths =
    config.layout === 'single-folder'
      ? [config.singleFolder]
      : [
          config.statusFolders.todo,
          config.statusFolders.in_progress,
          config.statusFolders.review,
          config.statusFolders.done
        ]
  const folders = paths.map((folder) => resolveProjectPath(project.path, folder))
  if (createMissing) {
    for (const folder of folders) await mkdir(folder, { recursive: true })
  }
  return folders
}

export async function ensureFolder(
  project: Project,
  config: KanbanMarkdownConfig,
  column: KanbanTicketColumn
): Promise<string> {
  const folder =
    config.layout === 'single-folder'
      ? config.singleFolder
      : config.statusFolders[column]
  const resolved = resolveProjectPath(project.path, folder)
  await mkdir(resolved, { recursive: true })
  return resolved
}

export function resolveProjectPath(projectPath: string, configuredPath: string): string {
  return isAbsolute(configuredPath) ? configuredPath : join(projectPath, configuredPath)
}

export function isMarkdownCandidate(name: string): boolean {
  if (name.startsWith('.')) return false
  if (
    name.endsWith('~') ||
    name.endsWith('.tmp') ||
    name.endsWith('.swp') ||
    name.endsWith('.bak')
  ) {
    return false
  }
  const ext = extname(name).toLowerCase()
  return ext === '.md' || ext === '.markdown'
}
