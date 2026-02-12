import { describe, test, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Mock electron's app module so importing git-service doesn't crash in jsdom
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/mock-home')
  }
}))

// Mock simple-git so the module can load without real git
vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue({
    branch: vi.fn(),
    raw: vi.fn()
  })
}))

// Import the pure function and breed/legacy city names after mocks are in place
import { canonicalizeBranchName } from '../../../src/main/services/git-service'
import { BREED_NAMES, LEGACY_CITY_NAMES } from '../../../src/main/services/breed-names'

describe('Session 4: Auto-Rename Branch on First Title', () => {
  describe('auto-rename logic in opencode-service', () => {
    test('session.updated handler includes auto-rename branch logic', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'opencode-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')

      // Verify auto-rename logic is present
      expect(content).toContain('Auto-rename branch if still an auto-generated name')
      expect(content).toContain('getWorktreeBySessionId')
      expect(content).toContain('ALL_BREED_NAMES.some')
      expect(content).toContain('canonicalizeBranchName')
      expect(content).toContain("'worktree:branchRenamed'")
    })

    test('imports ALL_BREED_NAMES, LEGACY_CITY_NAMES and canonicalizeBranchName', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'opencode-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')

      expect(content).toContain(
        "import { ALL_BREED_NAMES, LEGACY_CITY_NAMES } from './breed-names'"
      )
      expect(content).toContain(
        "import { canonicalizeBranchName, createGitService } from './git-service'"
      )
    })

    test('checks branch_renamed flag before renaming', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'opencode-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')

      // Must check the flag to prevent re-renaming
      expect(content).toContain('!worktree.branch_renamed')
    })

    test('sets branch_renamed to 1 after successful rename', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'opencode-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')

      // Must set the flag to prevent future auto-renames
      expect(content).toContain('branch_renamed: 1')
    })

    test('notifies renderer via sendToRenderer after rename', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'opencode-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')

      expect(content).toContain("this.sendToRenderer('worktree:branchRenamed'")
      expect(content).toContain('worktreeId: worktree.id')
      expect(content).toContain('newBranch')
    })

    test('deduplicates branch name with -2, -3 suffix when target exists', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'opencode-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')

      // Must check if branch exists before renaming
      expect(content).toContain('branchExists(targetBranch)')
      // Must try suffixed variants
      expect(content).toContain('`${baseBranch}-${suffix}`')
      // Must iterate suffixes starting at 2
      expect(content).toContain('let suffix = 2')
      expect(content).toContain('while (suffix <= maxSuffix)')
    })

    test('sets branch_renamed=1 on failure to stop retrying', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'opencode-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')

      // On all-suffixes-taken failure
      expect(content).toContain('all branch name variants taken')
      // On hard rename failure (git error)
      expect(content).toContain('Hard failure')
      // On unexpected error
      expect(content).toContain('Unexpected error')
      // All three paths must set branch_renamed: 1
      // Count occurrences of branch_renamed: 1 in the auto-rename block
      const autoRenameBlock = content.slice(
        content.indexOf('Auto-rename branch if still an auto-generated name'),
        content.indexOf('Only persist events from the parent session')
      )
      const flagSetCount = (autoRenameBlock.match(/branch_renamed: 1/g) || []).length
      // At least 3: success path, all-taken path, hard-failure path (+ catch block)
      expect(flagSetCount).toBeGreaterThanOrEqual(3)
    })
  })

  describe('DB helper: getWorktreeBySessionId', () => {
    test('database.ts contains getWorktreeBySessionId method', () => {
      const dbPath = path.join(__dirname, '..', '..', '..', 'src', 'main', 'db', 'database.ts')
      const content = fs.readFileSync(dbPath, 'utf-8')

      expect(content).toContain('getWorktreeBySessionId(sessionId: string)')
      expect(content).toContain('this.getSession(sessionId)')
      expect(content).toContain('this.getWorktree(session.worktree_id)')
    })
  })

  describe('preload: onBranchRenamed listener', () => {
    test('preload exposes onBranchRenamed on worktreeOps', () => {
      const preloadPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.ts')
      const content = fs.readFileSync(preloadPath, 'utf-8')

      expect(content).toContain('onBranchRenamed')
      expect(content).toContain("ipcRenderer.on('worktree:branchRenamed'")
      expect(content).toContain("ipcRenderer.removeListener('worktree:branchRenamed'")
    })

    test('preload type declarations include onBranchRenamed', () => {
      const dtsPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.d.ts')
      const content = fs.readFileSync(dtsPath, 'utf-8')

      expect(content).toContain('onBranchRenamed')
      expect(content).toContain('worktreeId: string; newBranch: string')
    })
  })

  describe('renderer: global listener handles branchRenamed', () => {
    test('useOpenCodeGlobalListener subscribes to worktree:branchRenamed', () => {
      const hookPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'hooks',
        'useOpenCodeGlobalListener.ts'
      )
      const content = fs.readFileSync(hookPath, 'utf-8')

      expect(content).toContain('onBranchRenamed')
      expect(content).toContain('updateWorktreeBranch')
    })

    test('imports useWorktreeStore in global listener', () => {
      const hookPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'hooks',
        'useOpenCodeGlobalListener.ts'
      )
      const content = fs.readFileSync(hookPath, 'utf-8')

      expect(content).toContain('import { useWorktreeStore }')
    })
  })

  describe('auto-name detection logic', () => {
    test('BREED_NAMES contains expected breeds', () => {
      expect(BREED_NAMES).toContain('golden-retriever')
      expect(BREED_NAMES).toContain('beagle')
      expect(BREED_NAMES).toContain('pembroke-corgi')
    })

    test('LEGACY_CITY_NAMES contains expected cities', () => {
      expect(LEGACY_CITY_NAMES).toContain('tokyo')
      expect(LEGACY_CITY_NAMES).toContain('oslo')
      expect(LEGACY_CITY_NAMES).toContain('lima')
    })

    test('breed name matching is case-insensitive', () => {
      const branch = 'Golden-Retriever'
      const isAutoName = BREED_NAMES.some((b) => b.toLowerCase() === branch.toLowerCase())
      expect(isAutoName).toBe(true)
    })

    test('non-auto branch names are not matched', () => {
      const branch = 'my-feature'
      const isAutoName =
        BREED_NAMES.some((b) => b.toLowerCase() === branch.toLowerCase()) ||
        LEGACY_CITY_NAMES.some((c) => c.toLowerCase() === branch.toLowerCase())
      expect(isAutoName).toBe(false)
    })
  })

  describe('auto-rename integration logic', () => {
    test('canonicalized title produces valid branch name from session title', () => {
      const title = 'Auth Setup Guide'
      const branch = canonicalizeBranchName(title)
      expect(branch).toBe('auth-setup-guide')
    })

    test('empty title does not produce a branch rename', () => {
      const title = ''
      const branch = canonicalizeBranchName(title)
      expect(branch).toBe('')
      // Empty branch should be falsy, preventing rename
      expect(!branch).toBe(true)
    })

    test('title that canonicalizes to same as city name is skipped', () => {
      // If the title canonicalizes to 'tokyo' (same as branch), no rename needed
      const title = 'Tokyo'
      const branch = canonicalizeBranchName(title)
      const currentBranch = 'tokyo'
      expect(branch).toBe(currentBranch.toLowerCase())
      // This condition should prevent rename: newBranch !== worktree.branch_name.toLowerCase()
    })

    test('title produces different branch name from city name', () => {
      const title = 'Debug Authentication Module'
      const branch = canonicalizeBranchName(title)
      const currentBranch = 'tokyo'
      expect(branch).not.toBe(currentBranch)
      expect(branch).toBe('debug-authentication-module')
    })
  })
})
