import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  symlinkSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Module-scoped state for the mock -- must use vi.hoisted so it's available
// in the vi.mock factory which gets hoisted above all other code.
const { getTestHomeDir, setTestHomeDir } = vi.hoisted(() => {
  let _dir = ''
  return {
    getTestHomeDir: () => _dir,
    setTestHomeDir: (d: string) => {
      _dir = d
    }
  }
})

// Mock electron's app module before importing the service
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'home') return getTestHomeDir()
      return tmpdir()
    })
  }
}))

import {
  getConnectionsBaseDir,
  ensureConnectionsDir,
  createConnectionDir,
  deleteConnectionDir,
  createSymlink,
  removeSymlink,
  renameConnectionDir,
  deriveSymlinkName,
  generateAgentsMd
} from '../../../src/main/services/connection-service'

describe('Session 2: Connection Service', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hive-test-'))
    setTestHomeDir(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('getConnectionsBaseDir', () => {
    test('returns path under ~/.hive/connections', () => {
      const baseDir = getConnectionsBaseDir()
      expect(baseDir).toBe(join(tempDir, '.hive', 'connections'))
    })
  })

  describe('ensureConnectionsDir', () => {
    test('creates the connections base directory if it does not exist', () => {
      const baseDir = getConnectionsBaseDir()
      expect(existsSync(baseDir)).toBe(false)

      ensureConnectionsDir()

      expect(existsSync(baseDir)).toBe(true)
    })

    test('does not throw if directory already exists', () => {
      ensureConnectionsDir()
      expect(() => ensureConnectionsDir()).not.toThrow()
    })
  })

  describe('createConnectionDir', () => {
    test('creates a named subdirectory under connections base', () => {
      const dirPath = createConnectionDir('golden-retriever')
      expect(existsSync(dirPath)).toBe(true)
      expect(dirPath).toBe(join(getConnectionsBaseDir(), 'golden-retriever'))
    })

    test('creates parent directories if they do not exist', () => {
      const baseDir = getConnectionsBaseDir()
      expect(existsSync(baseDir)).toBe(false)

      createConnectionDir('labrador')

      expect(existsSync(baseDir)).toBe(true)
    })

    test('does not throw if directory already exists', () => {
      createConnectionDir('poodle')
      expect(() => createConnectionDir('poodle')).not.toThrow()
    })
  })

  describe('deleteConnectionDir', () => {
    test('removes the entire connection folder', () => {
      const dirPath = createConnectionDir('beagle')
      expect(existsSync(dirPath)).toBe(true)

      deleteConnectionDir(dirPath)

      expect(existsSync(dirPath)).toBe(false)
    })

    test('does not throw if directory does not exist', () => {
      const fakePath = join(tempDir, 'nonexistent')
      expect(() => deleteConnectionDir(fakePath)).not.toThrow()
    })

    test('removes directory with nested contents', () => {
      const dirPath = createConnectionDir('corgi')
      mkdirSync(join(dirPath, 'subdir'))

      deleteConnectionDir(dirPath)

      expect(existsSync(dirPath)).toBe(false)
    })
  })

  describe('createSymlink', () => {
    test('creates a working directory symlink', () => {
      const targetDir = join(tempDir, 'target-repo')
      mkdirSync(targetDir, { recursive: true })
      const linkPath = join(tempDir, 'my-link')

      createSymlink(targetDir, linkPath)

      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    })

    test('symlink resolves to the target directory', () => {
      const targetDir = join(tempDir, 'target-repo')
      mkdirSync(targetDir, { recursive: true })
      const markerFile = join(targetDir, 'marker.txt')
      writeFileSync(markerFile, 'hello')
      const linkPath = join(tempDir, 'my-link')

      createSymlink(targetDir, linkPath)

      expect(readFileSync(join(linkPath, 'marker.txt'), 'utf-8')).toBe('hello')
    })
  })

  describe('removeSymlink', () => {
    test('removes an existing symlink', () => {
      const targetDir = join(tempDir, 'target')
      mkdirSync(targetDir, { recursive: true })
      const linkPath = join(tempDir, 'link-to-remove')
      symlinkSync(targetDir, linkPath, 'dir')

      removeSymlink(linkPath)

      expect(() => lstatSync(linkPath)).toThrow()
    })

    test('handles broken symlinks (target deleted)', () => {
      const targetDir = join(tempDir, 'disappearing-target')
      mkdirSync(targetDir, { recursive: true })
      const linkPath = join(tempDir, 'broken-link')
      symlinkSync(targetDir, linkPath, 'dir')
      rmSync(targetDir, { recursive: true, force: true })

      // Symlink is now broken -- verify it exists as symlink
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)

      // Should not throw
      removeSymlink(linkPath)

      // Should be gone
      expect(() => lstatSync(linkPath)).toThrow()
    })

    test('does not throw if path does not exist at all', () => {
      expect(() => removeSymlink(join(tempDir, 'nothing-here'))).not.toThrow()
    })
  })

  describe('renameConnectionDir', () => {
    test('renames a directory on disk', () => {
      const oldPath = createConnectionDir('old-name')
      const newPath = join(getConnectionsBaseDir(), 'new-name')

      renameConnectionDir(oldPath, newPath)

      expect(existsSync(oldPath)).toBe(false)
      expect(existsSync(newPath)).toBe(true)
    })
  })

  describe('deriveSymlinkName', () => {
    test('returns lowercase hyphenated project name', () => {
      expect(deriveSymlinkName('My Frontend', [])).toBe('my-frontend')
    })

    test('replaces special characters with hyphens', () => {
      expect(deriveSymlinkName('Project @#$ Name!', [])).toBe('project-----name-')
    })

    test('returns base name when no collision', () => {
      expect(deriveSymlinkName('backend', [])).toBe('backend')
    })

    test('appends -2 suffix on first collision', () => {
      expect(deriveSymlinkName('backend', ['backend'])).toBe('backend-2')
    })

    test('increments suffix on multiple collisions', () => {
      expect(deriveSymlinkName('backend', ['backend', 'backend-2'])).toBe('backend-3')
    })

    test('finds first available suffix', () => {
      expect(deriveSymlinkName('api', ['api', 'api-2', 'api-3', 'api-4'])).toBe('api-5')
    })

    test('handles already-lowercased names', () => {
      expect(deriveSymlinkName('simple', [])).toBe('simple')
    })

    test('handles names with numbers', () => {
      expect(deriveSymlinkName('Project V2', [])).toBe('project-v2')
    })
  })

  describe('generateAgentsMd', () => {
    test('writes a valid AGENTS.md with member sections', () => {
      const connDir = createConnectionDir('test-agents')
      const members = [
        {
          symlinkName: 'frontend',
          projectName: 'My Frontend',
          branchName: 'main',
          worktreePath: '/home/user/repos/frontend'
        },
        {
          symlinkName: 'backend',
          projectName: 'My Backend',
          branchName: 'feature/api',
          worktreePath: '/home/user/repos/backend'
        }
      ]

      generateAgentsMd(connDir, members)

      const content = readFileSync(join(connDir, 'AGENTS.md'), 'utf-8')

      // Verify header
      expect(content).toContain('# Connected Worktrees')
      expect(content).toContain('symlinked worktrees from multiple projects')

      // Verify project sections
      expect(content).toContain('### frontend/')
      expect(content).toContain('- **Project:** My Frontend')
      expect(content).toContain('- **Branch:** main')
      expect(content).toContain('- **Path:** /home/user/repos/frontend')

      expect(content).toContain('### backend/')
      expect(content).toContain('- **Project:** My Backend')
      expect(content).toContain('- **Branch:** feature/api')
      expect(content).toContain('- **Path:** /home/user/repos/backend')

      // Verify working instructions
      expect(content).toContain('## Working in this workspace')
      expect(content).toContain('Each subdirectory is a fully independent git repo')
    })

    test('handles a single member', () => {
      const connDir = createConnectionDir('single-member')
      const members = [
        {
          symlinkName: 'solo',
          projectName: 'Solo Project',
          branchName: 'develop',
          worktreePath: '/repos/solo'
        }
      ]

      generateAgentsMd(connDir, members)

      const content = readFileSync(join(connDir, 'AGENTS.md'), 'utf-8')
      expect(content).toContain('### solo/')
      expect(content).toContain('- **Project:** Solo Project')
    })

    test('overwrites existing AGENTS.md on regeneration', () => {
      const connDir = createConnectionDir('overwrite-test')
      const members1 = [
        {
          symlinkName: 'first',
          projectName: 'First',
          branchName: 'main',
          worktreePath: '/repos/first'
        }
      ]
      const members2 = [
        {
          symlinkName: 'first',
          projectName: 'First',
          branchName: 'main',
          worktreePath: '/repos/first'
        },
        {
          symlinkName: 'second',
          projectName: 'Second',
          branchName: 'develop',
          worktreePath: '/repos/second'
        }
      ]

      generateAgentsMd(connDir, members1)
      let content = readFileSync(join(connDir, 'AGENTS.md'), 'utf-8')
      expect(content).not.toContain('### second/')

      generateAgentsMd(connDir, members2)
      content = readFileSync(join(connDir, 'AGENTS.md'), 'utf-8')
      expect(content).toContain('### first/')
      expect(content).toContain('### second/')
    })
  })
})
