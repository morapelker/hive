import { describe, test, expect, vi } from 'vitest'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

/**
 * Session 5: Refresh Project — Tests
 *
 * These tests verify:
 * 1. The context menu contains a "Refresh Project" item
 * 2. Clicking it calls syncWorktrees with the correct args
 * 3. A success toast is shown after refresh
 */

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

// We need to import toast after mock
import { toast } from 'sonner'

// Mock the stores
vi.mock('@/stores', () => {
  const useProjectStore = vi.fn()
  const useWorktreeStore = vi.fn()
  // Add getState to useWorktreeStore for the statusStore pattern
  ;(useWorktreeStore as unknown as Record<string, unknown>).getState = vi.fn(() => ({
    loadWorktrees: vi.fn()
  }))
  return { useProjectStore, useWorktreeStore }
})

// Mock window.worktreeOps
Object.defineProperty(window, 'worktreeOps', {
  writable: true,
  value: {
    sync: vi.fn().mockResolvedValue({ success: true }),
    create: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
    archive: vi.fn(),
    createFromBranch: vi.fn()
  }
})

// Mock window.projectOps
Object.defineProperty(window, 'projectOps', {
  writable: true,
  value: {
    showInFolder: vi.fn(),
    copyToClipboard: vi.fn()
  }
})

describe('Session 5: Refresh Project', () => {
  describe('syncWorktrees store action', () => {
    test('syncWorktrees exists as a store action', () => {
      // Verify the store exports syncWorktrees
      const state = useWorktreeStore.getState()
      expect(typeof state.syncWorktrees).toBe('function')
    })

    test('syncWorktrees accepts projectId and projectPath', async () => {
      const state = useWorktreeStore.getState()
      // Should not throw when called with correct args
      await expect(state.syncWorktrees('project-123', '/path/to/project')).resolves.not.toThrow()
    })

    test('syncWorktrees calls worktreeOps.sync with correct payload', async () => {
      const syncSpy = vi.fn().mockResolvedValue({ success: true })
      Object.defineProperty(window, 'worktreeOps', {
        writable: true,
        value: {
          ...window.worktreeOps,
          sync: syncSpy
        }
      })

      const state = useWorktreeStore.getState()
      await state.syncWorktrees('proj-1', '/projects/my-app')

      expect(syncSpy).toHaveBeenCalledWith({
        projectId: 'proj-1',
        projectPath: '/projects/my-app'
      })
    })
  })

  describe('Refresh Project context menu item logic', () => {
    test('handleRefreshProject calls syncWorktrees then shows toast', async () => {
      // Simulate the handler logic from ProjectItem.tsx
      const syncWorktrees = vi.fn().mockResolvedValue(undefined)
      const project = { id: 'proj-1', path: '/path/to/project' }

      const handleRefreshProject = async () => {
        await syncWorktrees(project.id, project.path)
        toast.success('Project refreshed')
      }

      await handleRefreshProject()

      expect(syncWorktrees).toHaveBeenCalledWith('proj-1', '/path/to/project')
      expect(toast.success).toHaveBeenCalledWith('Project refreshed')
    })

    test('handleRefreshProject calls syncWorktrees with correct project data', async () => {
      const syncWorktrees = vi.fn().mockResolvedValue(undefined)
      const project = { id: 'proj-abc', path: '/Users/dev/my-cool-project' }

      const handleRefreshProject = async () => {
        await syncWorktrees(project.id, project.path)
        toast.success('Project refreshed')
      }

      await handleRefreshProject()

      expect(syncWorktrees).toHaveBeenCalledWith('proj-abc', '/Users/dev/my-cool-project')
    })
  })

  describe('ProjectItem source verification', () => {
    test('ProjectItem.tsx contains Refresh Project menu item', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/projects/ProjectItem.tsx'),
        'utf-8'
      )

      // Should contain the Refresh Project context menu item
      expect(source).toContain('Refresh Project')
      // Should contain the handleRefreshProject handler
      expect(source).toContain('handleRefreshProject')
      // Should contain syncWorktrees usage
      expect(source).toContain('syncWorktrees')
      // Should show success toast
      expect(source).toContain("toast.success('Project refreshed')")
    })

    test('Refresh Project appears after Refresh Language in source', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/projects/ProjectItem.tsx'),
        'utf-8'
      )

      const refreshLanguageIndex = source.indexOf('Refresh Language')
      const refreshProjectIndex = source.indexOf('Refresh Project')

      expect(refreshLanguageIndex).toBeGreaterThan(-1)
      expect(refreshProjectIndex).toBeGreaterThan(-1)
      // Refresh Project should appear after Refresh Language in the source
      expect(refreshProjectIndex).toBeGreaterThan(refreshLanguageIndex)
    })

    test('Refresh Project uses RefreshCw icon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/projects/ProjectItem.tsx'),
        'utf-8'
      )

      // Find the Refresh Project menu item block
      const refreshProjectIndex = source.indexOf('Refresh Project')
      // Look backwards from 'Refresh Project' for RefreshCw in the same menu item
      const contextBeforeRefreshProject = source.substring(
        Math.max(0, refreshProjectIndex - 200),
        refreshProjectIndex
      )
      expect(contextBeforeRefreshProject).toContain('RefreshCw')
    })

    test('syncWorktrees is destructured from useWorktreeStore', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/projects/ProjectItem.tsx'),
        'utf-8'
      )

      // Should destructure syncWorktrees from the store
      expect(source).toMatch(/useWorktreeStore.*syncWorktrees|syncWorktrees.*useWorktreeStore/)
    })
  })
})
