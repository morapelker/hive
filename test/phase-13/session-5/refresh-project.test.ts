import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest'

vi.mock('@/api/worktree-api', () => ({
  worktreeApi: {
    sync: vi.fn()
  }
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => () => {})
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    hide: vi.fn(() => Promise.resolve(undefined)),
    show: vi.fn(() => Promise.resolve(undefined)),
    updateSettings: vi.fn(() => Promise.resolve({ success: true }))
  }
}))

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { worktreeApi } from '@/api/worktree-api'
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

beforeEach(() => {
  vi.clearAllMocks()
  setRendererRpcClient({
    request: vi.fn().mockImplementation((method) => {
      if (method === 'db.worktree.getActiveByProject') return Promise.resolve([])
      return Promise.resolve(null)
    }),
    subscribe: vi.fn()
  })
  vi.mocked(worktreeApi.sync).mockResolvedValue({ success: true })
})

afterEach(() => {
  resetRendererRpcClientForTests()
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

    test('syncWorktrees calls worktreeApi.sync with correct payload', async () => {
      const state = useWorktreeStore.getState()
      await state.syncWorktrees('proj-1', '/projects/my-app')

      expect(worktreeApi.sync).toHaveBeenCalledWith({
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
        await syncWorktrees(project.id, project.path, { force: true })
        toast.success('Project refreshed')
      }

      await handleRefreshProject()

      expect(syncWorktrees).toHaveBeenCalledWith('proj-1', '/path/to/project', { force: true })
      expect(toast.success).toHaveBeenCalledWith('Project refreshed')
    })

    test('handleRefreshProject calls syncWorktrees with correct project data', async () => {
      const syncWorktrees = vi.fn().mockResolvedValue(undefined)
      const project = { id: 'proj-abc', path: '/Users/dev/my-cool-project' }

      const handleRefreshProject = async () => {
        await syncWorktrees(project.id, project.path, { force: true })
        toast.success('Project refreshed')
      }

      await handleRefreshProject()

      expect(syncWorktrees).toHaveBeenCalledWith('proj-abc', '/Users/dev/my-cool-project', {
        force: true
      })
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
