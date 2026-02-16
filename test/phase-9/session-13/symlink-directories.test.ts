// @vitest-environment node
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, symlinkSync } from 'fs'
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

describe('Symlink directory handling', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'hive-symlink-test-'))

    // Create real directories
    await fs.mkdir(join(tempDir, 'real-dir'))
    await fs.writeFile(join(tempDir, 'real-dir', 'child.txt'), 'hello')
    await fs.mkdir(join(tempDir, 'real-dir', 'nested'))
    await fs.writeFile(join(tempDir, 'real-dir', 'nested', 'deep.txt'), 'deep')

    // Create a real file
    await fs.writeFile(join(tempDir, 'real-file.txt'), 'content')

    // Create symlink to directory
    symlinkSync(join(tempDir, 'real-dir'), join(tempDir, 'linked-dir'), 'dir')

    // Create symlink to file
    symlinkSync(join(tempDir, 'real-file.txt'), join(tempDir, 'linked-file.txt'))

    // Create broken symlink
    symlinkSync('/nonexistent/path', join(tempDir, 'broken-link'), 'dir')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('scanDirectory', () => {
    test('symlinked directory appears as isDirectory: true', async () => {
      const nodes = await scanDirectory(tempDir, tempDir)
      const linked = nodes.find((n) => n.name === 'linked-dir')

      expect(linked).toBeDefined()
      expect(linked!.isDirectory).toBe(true)
    })

    test('symlinked directory is marked with isSymlink: true', async () => {
      const nodes = await scanDirectory(tempDir, tempDir)
      const linked = nodes.find((n) => n.name === 'linked-dir')

      expect(linked).toBeDefined()
      expect(linked!.isSymlink).toBe(true)
    })

    test('real directory is not marked as symlink', async () => {
      const nodes = await scanDirectory(tempDir, tempDir)
      const real = nodes.find((n) => n.name === 'real-dir')

      expect(real).toBeDefined()
      expect(real!.isDirectory).toBe(true)
      expect(real!.isSymlink).toBeUndefined()
    })

    test('symlinked file appears as isDirectory: false', async () => {
      const nodes = await scanDirectory(tempDir, tempDir)
      const linked = nodes.find((n) => n.name === 'linked-file.txt')

      expect(linked).toBeDefined()
      expect(linked!.isDirectory).toBe(false)
    })

    test('symlinked file is marked with isSymlink: true', async () => {
      const nodes = await scanDirectory(tempDir, tempDir)
      const linked = nodes.find((n) => n.name === 'linked-file.txt')

      expect(linked).toBeDefined()
      expect(linked!.isSymlink).toBe(true)
    })

    test('broken symlink does not crash and is treated as file', async () => {
      const nodes = await scanDirectory(tempDir, tempDir)
      const broken = nodes.find((n) => n.name === 'broken-link')

      expect(broken).toBeDefined()
      expect(broken!.isDirectory).toBe(false)
      expect(broken!.isSymlink).toBe(true)
    })

    test('symlinked directories sort with regular directories', async () => {
      const nodes = await scanDirectory(tempDir, tempDir)

      const dirs = nodes.filter((n) => n.isDirectory)
      const files = nodes.filter((n) => !n.isDirectory)

      // linked-dir should be in the directories group
      const linkedDir = dirs.find((n) => n.name === 'linked-dir')
      expect(linkedDir).toBeDefined()

      // All directories should come before files
      if (dirs.length > 0 && files.length > 0) {
        let lastDirIdx = -1
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (nodes[i].isDirectory) {
            lastDirIdx = i
            break
          }
        }
        const firstFileIdx = nodes.findIndex((n) => !n.isDirectory)
        expect(lastDirIdx).toBeLessThan(firstFileIdx)
      }
    })

    test('symlinked directory children are accessible', async () => {
      const nodes = await scanDirectory(tempDir, tempDir, 10, 0)
      const linked = nodes.find((n) => n.name === 'linked-dir')

      expect(linked).toBeDefined()
      expect(linked!.children).toBeDefined()
      expect(linked!.children!.length).toBeGreaterThan(0)

      const childNames = linked!.children!.map((c) => c.name)
      expect(childNames).toContain('child.txt')
      expect(childNames).toContain('nested')
    })
  })

  describe('scanSingleDirectory', () => {
    test('symlinked directory appears as isDirectory: true', async () => {
      const nodes = await scanSingleDirectory(tempDir, tempDir)
      const linked = nodes.find((n) => n.name === 'linked-dir')

      expect(linked).toBeDefined()
      expect(linked!.isDirectory).toBe(true)
      expect(linked!.isSymlink).toBe(true)
    })

    test('can lazy-load children of a symlinked directory', async () => {
      const children = await scanSingleDirectory(join(tempDir, 'linked-dir'), tempDir)
      const names = children.map((n) => n.name)

      expect(names).toContain('child.txt')
      expect(names).toContain('nested')
    })

    test('broken symlink does not crash', async () => {
      const nodes = await scanSingleDirectory(tempDir, tempDir)
      const broken = nodes.find((n) => n.name === 'broken-link')

      expect(broken).toBeDefined()
      expect(broken!.isDirectory).toBe(false)
      expect(broken!.isSymlink).toBe(true)
    })

    test('symlinked directories sort with regular directories', async () => {
      const nodes = await scanSingleDirectory(tempDir, tempDir)

      const dirs = nodes.filter((n) => n.isDirectory)
      const linkedDir = dirs.find((n) => n.name === 'linked-dir')
      expect(linkedDir).toBeDefined()
    })
  })

  describe('connection-like folder structure', () => {
    let connectionDir: string

    beforeEach(async () => {
      // Simulate a connection folder with symlinked worktrees
      connectionDir = await fs.mkdtemp(join(tmpdir(), 'hive-connection-'))

      // Create "worktree" directories to symlink into the connection
      const wt1 = join(connectionDir, '_real_wt1')
      const wt2 = join(connectionDir, '_real_wt2')
      await fs.mkdir(wt1)
      await fs.mkdir(wt2)
      await fs.writeFile(join(wt1, 'package.json'), '{}')
      await fs.writeFile(join(wt2, 'main.py'), 'print("hi")')
      await fs.mkdir(join(wt1, 'src'))
      await fs.writeFile(join(wt1, 'src', 'index.ts'), '')

      // Symlink them with friendly names (like connections do)
      symlinkSync(wt1, join(connectionDir, 'project-a'), 'dir')
      symlinkSync(wt2, join(connectionDir, 'project-b'), 'dir')

      // Add an AGENTS.md like the real connection service does
      await fs.writeFile(join(connectionDir, 'AGENTS.md'), '# Connected Worktrees')
    })

    afterEach(async () => {
      await fs.rm(connectionDir, { recursive: true, force: true })
    })

    test('connection folder shows symlinked worktrees as directories', async () => {
      const nodes = await scanDirectory(connectionDir, connectionDir)
      const names = nodes.map((n) => n.name)

      expect(names).toContain('project-a')
      expect(names).toContain('project-b')

      const projA = nodes.find((n) => n.name === 'project-a')!
      const projB = nodes.find((n) => n.name === 'project-b')!

      expect(projA.isDirectory).toBe(true)
      expect(projA.isSymlink).toBe(true)
      expect(projB.isDirectory).toBe(true)
      expect(projB.isSymlink).toBe(true)
    })

    test('connection folder symlinked worktree children are accessible', async () => {
      const nodes = await scanDirectory(connectionDir, connectionDir, 10, 0)
      const projA = nodes.find((n) => n.name === 'project-a')!

      expect(projA.children).toBeDefined()
      const childNames = projA.children!.map((c) => c.name)
      expect(childNames).toContain('package.json')
      expect(childNames).toContain('src')
    })

    test('AGENTS.md appears as a regular file', async () => {
      const nodes = await scanDirectory(connectionDir, connectionDir)
      const agentsMd = nodes.find((n) => n.name === 'AGENTS.md')

      expect(agentsMd).toBeDefined()
      expect(agentsMd!.isDirectory).toBe(false)
      expect(agentsMd!.isSymlink).toBeUndefined()
    })
  })
})
