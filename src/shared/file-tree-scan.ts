import { Dirent, promises as fs } from 'fs'
import { basename, extname, join, relative } from 'path'
import simpleGit from 'simple-git'

import type { FileTreeNode, FlatFile } from './types/file-tree'

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

async function isDirectoryEntry(entry: Dirent, entryPath: string): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink()) {
    try {
      const stat = await fs.stat(entryPath)
      return stat.isDirectory()
    } catch {
      return false
    }
  }
  return false
}

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
        const children = isSymlink
          ? undefined
          : currentDepth < 1
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
  } catch {
    return []
  }
}

export async function scanSingleDirectory(
  dirPath: string,
  rootPath: string
): Promise<FileTreeNode[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const nodes: FileTreeNode[] = []

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
          children: undefined
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
  } catch {
    return []
  }
}

export async function scanFlat(dirPath: string): Promise<FlatFile[]> {
  const git = simpleGit(dirPath)
  const raw = await git.raw(['ls-files', '--cached', '--others', '--exclude-standard'])
  const lines = raw.trim().split('\n').filter(Boolean)

  return lines.map((relativePath) => ({
    name: basename(relativePath),
    path: join(dirPath, relativePath),
    relativePath,
    extension: extname(relativePath).toLowerCase() || null
  }))
}
