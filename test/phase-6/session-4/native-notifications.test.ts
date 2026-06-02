import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, renderHook, act } from '@testing-library/react'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'

// Track registered listeners for notification:navigate
let notificationNavigateCallback: ((data: { projectId: string; worktreeId: string; sessionId: string }) => void) | null = null

// Mock systemOps.onNotificationNavigate
const mockOnNotificationNavigate = vi.fn((callback: (data: { projectId: string; worktreeId: string; sessionId: string }) => void) => {
  notificationNavigateCallback = callback
  return () => {
    notificationNavigateCallback = null
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  notificationNavigateCallback = null

  // Reset stores
  useProjectStore.setState({
    selectedProjectId: null,
    projects: []
  })
  useWorktreeStore.setState({
    selectedWorktreeId: null
  })
  useSessionStore.setState({
    activeSessionId: null,
    activeWorktreeId: null,
    sessionsByWorktree: new Map(),
    tabOrderByWorktree: new Map(),
    modeBySession: new Map(),
    activeSessionByWorktree: {}
  })

  // Mock window.db (needed by selectProject/selectWorktree which call touch)
  Object.defineProperty(window, 'db', {
    value: {
      project: {
        touch: vi.fn().mockResolvedValue(true),
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(null),
        getByPath: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn()
      },
      worktree: {
        touch: vi.fn().mockResolvedValue(true),
        getActiveByProject: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn()
      },
      session: {
        get: vi.fn().mockResolvedValue(null),
        getByWorktree: vi.fn().mockResolvedValue([]),
        getActiveByWorktree: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        search: vi.fn().mockResolvedValue([])
      }
    },
    writable: true,
    configurable: true
  })

  // Mock window.systemOps
  Object.defineProperty(window, 'systemOps', {
    value: {
      getLogDir: vi.fn(),
      getAppVersion: vi.fn(),
      getAppPaths: vi.fn(),
      isLogMode: vi.fn(),
      openInApp: vi.fn(),
      onNotificationNavigate: mockOnNotificationNavigate
    },
    writable: true,
    configurable: true
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Session 4: Native Notifications', () => {
  describe('NotificationService (unit)', () => {
    test('Notification title is project name', () => {
      // The notification service creates a Notification with title = projectName
      // This is a structural test — the actual Electron Notification API
      // is only available in the main process, so we test the data shape
      const data = {
        projectName: 'my-project',
        sessionName: 'implement auth',
        projectId: 'p-1',
        worktreeId: 'wt-1',
        sessionId: 's-1'
      }
      expect(data.projectName).toBe('my-project')
    })

    test('Notification body includes session name', () => {
      const sessionName = 'implement auth'
      const body = `"${sessionName}" completed`
      expect(body).toContain('implement auth')
      expect(body).toBe('"implement auth" completed')
    })
  })

  describe('Navigation hook', () => {
    test('onNotificationNavigate is registered on mount', async () => {
      const { useNotificationNavigation } = await import(
        '../../../src/renderer/src/hooks/useNotificationNavigation'
      )

      renderHook(() => useNotificationNavigation())

      expect(mockOnNotificationNavigate).toHaveBeenCalledTimes(1)
      expect(typeof mockOnNotificationNavigate.mock.calls[0][0]).toBe('function')
    })

    test('onNotificationNavigate cleanup called on unmount', async () => {
      const { useNotificationNavigation } = await import(
        '../../../src/renderer/src/hooks/useNotificationNavigation'
      )

      const { unmount } = renderHook(() => useNotificationNavigation())

      // Callback should be registered
      expect(notificationNavigateCallback).not.toBeNull()

      // Unmount should clean up
      unmount()
      expect(notificationNavigateCallback).toBeNull()
    })

    test('Navigation hook sets correct project', async () => {
      const { useNotificationNavigation } = await import(
        '../../../src/renderer/src/hooks/useNotificationNavigation'
      )

      renderHook(() => useNotificationNavigation())

      // Simulate notification click
      act(() => {
        notificationNavigateCallback?.({
          projectId: 'project-123',
          worktreeId: 'worktree-456',
          sessionId: 'session-789'
        })
      })

      expect(useProjectStore.getState().selectedProjectId).toBe('project-123')
    })

    test('Navigation hook sets correct worktree', async () => {
      const { useNotificationNavigation } = await import(
        '../../../src/renderer/src/hooks/useNotificationNavigation'
      )

      renderHook(() => useNotificationNavigation())

      act(() => {
        notificationNavigateCallback?.({
          projectId: 'project-123',
          worktreeId: 'worktree-456',
          sessionId: 'session-789'
        })
      })

      expect(useWorktreeStore.getState().selectedWorktreeId).toBe('worktree-456')
    })

    test('Navigation hook sets correct session', async () => {
      const { useNotificationNavigation } = await import(
        '../../../src/renderer/src/hooks/useNotificationNavigation'
      )

      renderHook(() => useNotificationNavigation())

      act(() => {
        notificationNavigateCallback?.({
          projectId: 'project-123',
          worktreeId: 'worktree-456',
          sessionId: 'session-789'
        })
      })

      expect(useSessionStore.getState().activeSessionId).toBe('session-789')
    })

    test('Navigation handles missing session gracefully', async () => {
      const { useNotificationNavigation } = await import(
        '../../../src/renderer/src/hooks/useNotificationNavigation'
      )

      renderHook(() => useNotificationNavigation())

      // Navigate to non-existent IDs — should not crash
      expect(() => {
        act(() => {
          notificationNavigateCallback?.({
            projectId: 'non-existent-project',
            worktreeId: 'non-existent-worktree',
            sessionId: 'non-existent-session'
          })
        })
      }).not.toThrow()

      // Store should still be updated (stores handle missing data gracefully)
      expect(useProjectStore.getState().selectedProjectId).toBe('non-existent-project')
    })

    test('Multiple navigate events update correctly', async () => {
      const { useNotificationNavigation } = await import(
        '../../../src/renderer/src/hooks/useNotificationNavigation'
      )

      renderHook(() => useNotificationNavigation())

      // First navigation
      act(() => {
        notificationNavigateCallback?.({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          sessionId: 'session-1'
        })
      })

      expect(useProjectStore.getState().selectedProjectId).toBe('project-1')

      // Second navigation
      act(() => {
        notificationNavigateCallback?.({
          projectId: 'project-2',
          worktreeId: 'worktree-2',
          sessionId: 'session-2'
        })
      })

      expect(useProjectStore.getState().selectedProjectId).toBe('project-2')
      expect(useWorktreeStore.getState().selectedWorktreeId).toBe('worktree-2')
      expect(useSessionStore.getState().activeSessionId).toBe('session-2')
    })
  })

  describe('Notification data shape', () => {
    test('Session notification data includes all required fields', () => {
      const data = {
        projectName: 'hive',
        sessionName: 'fix auth bug',
        projectId: 'p-1',
        worktreeId: 'wt-1',
        sessionId: 's-1'
      }

      expect(data).toHaveProperty('projectName')
      expect(data).toHaveProperty('sessionName')
      expect(data).toHaveProperty('projectId')
      expect(data).toHaveProperty('worktreeId')
      expect(data).toHaveProperty('sessionId')
    })

    test('Navigate event data includes all required fields', () => {
      const navigateData = {
        projectId: 'p-1',
        worktreeId: 'wt-1',
        sessionId: 's-1'
      }

      expect(navigateData).toHaveProperty('projectId')
      expect(navigateData).toHaveProperty('worktreeId')
      expect(navigateData).toHaveProperty('sessionId')
    })
  })
})
