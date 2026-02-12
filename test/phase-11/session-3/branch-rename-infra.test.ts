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

// Import the pure function after mocks are in place
import { canonicalizeBranchName } from '../../../src/main/services/git-service'

describe('Session 3: Branch Rename Infrastructure', () => {
  describe('canonicalizeBranchName', () => {
    test('converts spaces to dashes and lowercases', () => {
      expect(canonicalizeBranchName('Auth Refresh Token')).toBe('auth-refresh-token')
    })

    test('removes special characters', () => {
      expect(canonicalizeBranchName('Fix #123: Bug!')).toBe('fix-123-bug')
    })

    test('collapses consecutive dashes', () => {
      expect(canonicalizeBranchName('fix -- double  spaces')).toBe('fix-double')
    })

    test('truncates to 50 characters', () => {
      const long = 'a'.repeat(60)
      expect(canonicalizeBranchName(long).length).toBeLessThanOrEqual(50)
    })

    test('strips trailing dashes after truncation', () => {
      const input = 'a'.repeat(49) + '-b'
      const result = canonicalizeBranchName(input)
      expect(result.endsWith('-')).toBe(false)
    })

    test('returns empty string for empty input', () => {
      expect(canonicalizeBranchName('')).toBe('')
    })

    test('preserves dots and slashes', () => {
      expect(canonicalizeBranchName('feature/auth.v2')).toBe('feature/auth.v2')
    })

    test('converts underscores to dashes', () => {
      expect(canonicalizeBranchName('fix_the_bug')).toBe('fix-the-bug')
    })

    test('uses only the first 3 words for long titles', () => {
      expect(canonicalizeBranchName('Auth Refresh Token Support')).toBe('auth-refresh-token')
    })

    test('handles leading/trailing spaces and dashes', () => {
      expect(canonicalizeBranchName('  -hello world-  ')).toBe('hello-world')
    })

    test('handles only special characters', () => {
      expect(canonicalizeBranchName('!@#$%^&*()')).toBe('')
    })
  })

  describe('renameBranch IPC infrastructure', () => {
    test('worktree:renameBranch handler exists in worktree-handlers', () => {
      const handlersPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'ipc',
        'worktree-handlers.ts'
      )
      const content = fs.readFileSync(handlersPath, 'utf-8')
      expect(content).toContain("'worktree:renameBranch'")
      expect(content).toContain('gitService.renameBranch')
    })

    test('preload exposes renameBranch on worktreeOps', () => {
      const preloadPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.ts')
      const content = fs.readFileSync(preloadPath, 'utf-8')
      expect(content).toContain('renameBranch')
      expect(content).toContain("'worktree:renameBranch'")
    })

    test('preload type declarations include renameBranch', () => {
      const dtsPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.d.ts')
      const content = fs.readFileSync(dtsPath, 'utf-8')
      expect(content).toContain('renameBranch')
    })
  })

  describe('branch_renamed DB migration', () => {
    test('schema version bumped to 7', () => {
      const schemaPath = path.join(__dirname, '..', '..', '..', 'src', 'main', 'db', 'schema.ts')
      const content = fs.readFileSync(schemaPath, 'utf-8')
      expect(content).toContain('CURRENT_SCHEMA_VERSION = 7')
    })

    test('migration adds branch_renamed column', () => {
      const schemaPath = path.join(__dirname, '..', '..', '..', 'src', 'main', 'db', 'schema.ts')
      const content = fs.readFileSync(schemaPath, 'utf-8')
      expect(content).toContain('add_worktree_branch_renamed')
      expect(content).toContain('branch_renamed INTEGER NOT NULL DEFAULT 0')
    })

    test('Worktree type includes branch_renamed', () => {
      const typesPath = path.join(__dirname, '..', '..', '..', 'src', 'main', 'db', 'types.ts')
      const content = fs.readFileSync(typesPath, 'utf-8')
      expect(content).toContain('branch_renamed: number')
    })

    test('WorktreeUpdate type includes branch_name and branch_renamed', () => {
      const typesPath = path.join(__dirname, '..', '..', '..', 'src', 'main', 'db', 'types.ts')
      const content = fs.readFileSync(typesPath, 'utf-8')
      expect(content).toMatch(/interface WorktreeUpdate[\s\S]*branch_name\?: string/)
      expect(content).toMatch(/interface WorktreeUpdate[\s\S]*branch_renamed\?: number/)
    })
  })

  describe('renameBranch method exists on GitService', () => {
    test('git-service exports renameBranch method', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'git-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')
      expect(content).toContain('async renameBranch(')
      expect(content).toContain("git.branch(['-m', oldBranch, newBranch])")
    })
  })

  describe('updateWorktreeBranch store method', () => {
    test('useWorktreeStore includes updateWorktreeBranch', () => {
      const storePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'stores',
        'useWorktreeStore.ts'
      )
      const content = fs.readFileSync(storePath, 'utf-8')
      expect(content).toContain('updateWorktreeBranch')
      expect(content).toContain('branch_name: newBranch')
    })
  })

  describe('DOG_BREEDS export', () => {
    test('breed-names.ts exports DOG_BREEDS array', () => {
      const breedNamesPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'breed-names.ts'
      )
      const content = fs.readFileSync(breedNamesPath, 'utf-8')
      expect(content).toContain('export const DOG_BREEDS')
    })
  })
})
