// @vitest-environment node
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock Electron and logger before importing the module under test
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn()
}))
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  })
}))

import { scanDirectory, scanSingleDirectory } from '../../../src/main/ipc/file-tree-handlers'

describe('Session 2: Hidden Files', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'hive-hidden-files-'))

    // Create dotfiles
    await fs.writeFile(join(tempDir, '.env'), 'SECRET=123')
    await fs.writeFile(join(tempDir, '.gitignore'), 'node_modules/')
    await fs.writeFile(join(tempDir, '.prettierrc'), '{}')
    await fs.writeFile(join(tempDir, '.eslintrc'), '{}')

    // Create dot-directories with children
    await fs.mkdir(join(tempDir, '.vscode'))
    await fs.writeFile(join(tempDir, '.vscode', 'settings.json'), '{}')
    await fs.mkdir(join(tempDir, '.github'))
    await fs.writeFile(join(tempDir, '.github', 'CODEOWNERS'), '* @owner')

    // Create ignored entries that should stay hidden
    await fs.mkdir(join(tempDir, '.git'))
    await fs.writeFile(join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/main')
    await fs.writeFile(join(tempDir, '.DS_Store'), '')

    // Create normal files/dirs for comparison
    await fs.writeFile(join(tempDir, 'README.md'), '# Hello')
    await fs.mkdir(join(tempDir, 'src'))
    await fs.writeFile(join(tempDir, 'src', 'index.ts'), 'console.log("hi")')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('scanDirectory includes dotfiles', async () => {
    const nodes = await scanDirectory(tempDir, tempDir)
    const names = nodes.map((n) => n.name)

    // Dotfiles should be present
    expect(names).toContain('.env')
    expect(names).toContain('.gitignore')
    expect(names).toContain('.prettierrc')
    expect(names).toContain('.eslintrc')
  })

  test('scanDirectory includes dot-directories', async () => {
    const nodes = await scanDirectory(tempDir, tempDir)
    const names = nodes.map((n) => n.name)

    expect(names).toContain('.vscode')
    expect(names).toContain('.github')
  })

  test('scanDirectory excludes .git (IGNORE_DIRS)', async () => {
    const nodes = await scanDirectory(tempDir, tempDir)
    const names = nodes.map((n) => n.name)

    expect(names).not.toContain('.git')
  })

  test('scanDirectory excludes .DS_Store (IGNORE_FILES)', async () => {
    const nodes = await scanDirectory(tempDir, tempDir)
    const names = nodes.map((n) => n.name)

    expect(names).not.toContain('.DS_Store')
  })

  test('scanDirectory still includes normal files', async () => {
    const nodes = await scanDirectory(tempDir, tempDir)
    const names = nodes.map((n) => n.name)

    expect(names).toContain('README.md')
    expect(names).toContain('src')
  })

  test('scanSingleDirectory includes dotfiles', async () => {
    const nodes = await scanSingleDirectory(tempDir, tempDir)
    const names = nodes.map((n) => n.name)

    expect(names).toContain('.env')
    expect(names).toContain('.gitignore')
    expect(names).toContain('.prettierrc')
    expect(names).toContain('.eslintrc')
  })

  test('scanSingleDirectory includes dot-directories', async () => {
    const nodes = await scanSingleDirectory(tempDir, tempDir)
    const names = nodes.map((n) => n.name)

    expect(names).toContain('.vscode')
    expect(names).toContain('.github')
  })

  test('scanSingleDirectory excludes .git and .DS_Store', async () => {
    const nodes = await scanSingleDirectory(tempDir, tempDir)
    const names = nodes.map((n) => n.name)

    expect(names).not.toContain('.git')
    expect(names).not.toContain('.DS_Store')
  })

  test('dotfiles are sorted correctly (directories first, then files, alphabetically)', async () => {
    const nodes = await scanDirectory(tempDir, tempDir)

    const dirs = nodes.filter((n) => n.isDirectory)
    const files = nodes.filter((n) => !n.isDirectory)

    // All directories come before all files
    // Find last directory index manually for compatibility
    let lastDirIdx = -1
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].isDirectory) {
        lastDirIdx = i
        break
      }
    }
    const firstFileIdx = nodes.findIndex((n) => !n.isDirectory)
    if (dirs.length > 0 && files.length > 0) {
      expect(lastDirIdx).toBeLessThan(firstFileIdx)
    }

    // Directories are alphabetically sorted (case-insensitive)
    const dirNames = dirs.map((d) => d.name)
    const sortedDirNames = [...dirNames].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    )
    expect(dirNames).toEqual(sortedDirNames)

    // Files are alphabetically sorted (case-insensitive)
    const fileNames = files.map((f) => f.name)
    const sortedFileNames = [...fileNames].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    )
    expect(fileNames).toEqual(sortedFileNames)
  })

  test('dot-directory children load correctly via scanSingleDirectory', async () => {
    const children = await scanSingleDirectory(join(tempDir, '.vscode'), tempDir)
    const names = children.map((n) => n.name)

    expect(names).toContain('settings.json')
  })
})
