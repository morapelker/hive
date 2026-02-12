import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

// ---------------------------------------------------------------------------
// Version naming logic tests (unit tests for the naming algorithm)
// ---------------------------------------------------------------------------
describe('Session 3: Branch Duplication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
  })

  describe('Version naming', () => {
    // Extract the naming logic so we can test it independently
    function getBaseName(sourceBranch: string): string {
      return sourceBranch.replace(/-v\d+$/, '')
    }

    function getNextVersionName(sourceBranch: string, existingBranches: string[]): string {
      const baseName = getBaseName(sourceBranch)
      const versionPattern = new RegExp(
        `^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-v(\\d+)$`
      )
      let maxVersion = 1
      for (const branch of existingBranches) {
        const match = branch.match(versionPattern)
        if (match) {
          maxVersion = Math.max(maxVersion, parseInt(match[1], 10))
        }
      }
      return `${baseName}-v${maxVersion + 1}`
    }

    test('first duplication creates -v2', () => {
      const result = getNextVersionName('feature-auth', ['feature-auth', 'main'])
      expect(result).toBe('feature-auth-v2')
    })

    test('second duplication creates -v3', () => {
      const result = getNextVersionName('feature-auth', ['feature-auth', 'feature-auth-v2', 'main'])
      expect(result).toBe('feature-auth-v3')
    })

    test('duplication from versioned branch increments globally', () => {
      const result = getNextVersionName('feature-auth-v2', [
        'feature-auth',
        'feature-auth-v2',
        'main'
      ])
      expect(result).toBe('feature-auth-v3')
    })

    test('base name extraction strips -vN suffix', () => {
      expect(getBaseName('feature-auth-v2')).toBe('feature-auth')
      expect(getBaseName('feature-auth-v10')).toBe('feature-auth')
      expect(getBaseName('my-v2-project')).toBe('my-v2-project') // v2 not at end
    })

    test('handles branch names with special regex chars', () => {
      // Should not throw a regex error
      expect(() => getNextVersionName('fix/auth+login', ['fix/auth+login', 'main'])).not.toThrow()
      const result = getNextVersionName('fix/auth+login', ['fix/auth+login', 'main'])
      expect(result).toBe('fix/auth+login-v2')
    })

    test('handles multiple high version numbers', () => {
      const result = getNextVersionName('feature-auth', [
        'feature-auth',
        'feature-auth-v2',
        'feature-auth-v5',
        'feature-auth-v10',
        'main'
      ])
      expect(result).toBe('feature-auth-v11')
    })

    test('does not confuse similar branch names', () => {
      const result = getNextVersionName('feature', [
        'feature',
        'feature-auth-v2',
        'feature-v3',
        'main'
      ])
      // feature-auth-v2 should NOT match the pattern for 'feature'
      expect(result).toBe('feature-v4')
    })
  })

  // ---------------------------------------------------------------------------
  // UI tests for WorktreeItem Duplicate menu
  // ---------------------------------------------------------------------------
  describe('UI', () => {
    const mockWorktreeOps = {
      create: vi.fn(),
      delete: vi.fn(),
      sync: vi.fn(),
      exists: vi.fn(),
      openInTerminal: vi.fn().mockResolvedValue({ success: true }),
      openInEditor: vi.fn().mockResolvedValue({ success: true }),
      getBranches: vi.fn(),
      branchExists: vi.fn(),
      duplicate: vi.fn().mockResolvedValue({
        success: true,
        worktree: {
          id: 'new-wt-id',
          project_id: 'proj-1',
          name: 'feature-auth-v2',
          branch_name: 'feature-auth-v2',
          path: '/path/to/worktree',
          status: 'active',
          is_default: false,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      })
    }

    const mockProjectOps = {
      openDirectoryDialog: vi.fn(),
      isGitRepository: vi.fn(),
      validateProject: vi.fn(),
      showInFolder: vi.fn(),
      openPath: vi.fn(),
      copyToClipboard: vi.fn().mockResolvedValue(undefined),
      readFromClipboard: vi.fn(),
      detectLanguage: vi.fn(),
      loadLanguageIcons: vi.fn()
    }

    const mockDb = {
      worktree: {
        getActiveByProject: vi.fn().mockResolvedValue([]),
        touch: vi.fn().mockResolvedValue(true),
        create: vi.fn(),
        get: vi.fn(),
        getByProject: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        archive: vi.fn()
      },
      setting: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getAll: vi.fn() },
      project: {
        create: vi.fn(),
        get: vi.fn(),
        getByPath: vi.fn(),
        getAll: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
        delete: vi.fn(),
        touch: vi.fn()
      },
      session: {
        create: vi.fn(),
        get: vi.fn(),
        getByWorktree: vi.fn(),
        getByProject: vi.fn(),
        getActiveByWorktree: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        search: vi.fn()
      },
      schemaVersion: vi.fn(),
      tableExists: vi.fn(),
      getIndexes: vi.fn()
    }

    beforeEach(() => {
      Object.defineProperty(window, 'worktreeOps', {
        writable: true,
        value: mockWorktreeOps
      })
      Object.defineProperty(window, 'projectOps', {
        writable: true,
        value: mockProjectOps
      })
      Object.defineProperty(window, 'db', {
        writable: true,
        value: mockDb
      })
    })

    test('Duplicate shown in context menu for non-default worktree', async () => {
      const { WorktreeItem } =
        await import('../../../src/renderer/src/components/worktrees/WorktreeItem')

      const worktree = {
        id: 'wt-1',
        project_id: 'proj-1',
        name: 'feature-auth',
        branch_name: 'feature-auth',
        path: '/path/to/worktree',
        status: 'active' as const,
        is_default: false,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      }

      render(
        React.createElement(WorktreeItem, {
          worktree,
          projectPath: '/path/to/project'
        })
      )

      // Trigger context menu
      const item = screen.getByTestId('worktree-item-wt-1')
      fireEvent.contextMenu(item)

      // Verify "Duplicate" appears in context menu
      const duplicateItems = screen.getAllByText('Duplicate')
      expect(duplicateItems.length).toBeGreaterThanOrEqual(1)
    })

    test('Duplicate NOT shown for default worktree', async () => {
      const { WorktreeItem } =
        await import('../../../src/renderer/src/components/worktrees/WorktreeItem')

      const worktree = {
        id: 'wt-default',
        project_id: 'proj-1',
        name: 'main',
        branch_name: 'main',
        path: '/path/to/project',
        status: 'active' as const,
        is_default: true,
        created_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString()
      }

      render(
        React.createElement(WorktreeItem, {
          worktree,
          projectPath: '/path/to/project'
        })
      )

      // Trigger context menu
      const item = screen.getByTestId('worktree-item-wt-default')
      fireEvent.contextMenu(item)

      // "Duplicate" should not appear for default worktree
      const duplicateItems = screen.queryAllByText('Duplicate')
      expect(duplicateItems.length).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Store action tests
  // ---------------------------------------------------------------------------
  describe('Worktree store action', () => {
    test('duplicateWorktree calls window.worktreeOps.duplicate', async () => {
      const mockDuplicate = vi.fn().mockResolvedValue({
        success: true,
        worktree: {
          id: 'new-id',
          project_id: 'proj-1',
          name: 'feature-v2',
          branch_name: 'feature-v2',
          path: '/path',
          status: 'active',
          is_default: false,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      })

      Object.defineProperty(window, 'worktreeOps', {
        writable: true,
        value: {
          create: vi.fn(),
          delete: vi.fn(),
          sync: vi.fn(),
          exists: vi.fn(),
          openInTerminal: vi.fn(),
          openInEditor: vi.fn(),
          getBranches: vi.fn(),
          branchExists: vi.fn(),
          duplicate: mockDuplicate
        }
      })

      Object.defineProperty(window, 'db', {
        writable: true,
        value: {
          worktree: {
            getActiveByProject: vi.fn().mockResolvedValue([]),
            touch: vi.fn()
          }
        }
      })

      const { useWorktreeStore } = await import('../../../src/renderer/src/stores/useWorktreeStore')

      const result = await useWorktreeStore
        .getState()
        .duplicateWorktree('proj-1', '/project/path', 'my-project', 'feature', '/worktree/path')

      expect(mockDuplicate).toHaveBeenCalledWith({
        projectId: 'proj-1',
        projectPath: '/project/path',
        projectName: 'my-project',
        sourceBranch: 'feature',
        sourceWorktreePath: '/worktree/path'
      })

      expect(result.success).toBe(true)
    })
  })
})
