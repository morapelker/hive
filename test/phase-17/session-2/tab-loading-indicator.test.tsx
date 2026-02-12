import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'

/**
 * Session 2: Tab Loading Indicator Fix — Tests
 *
 * These tests verify:
 * 1. Spinner shows for working status (blue-500)
 * 2. Spinner shows for planning status with different color (blue-400)
 * 3. AlertCircle shows for answering status (amber-500)
 * 4. Check shows for completed status (green-500)
 * 5. Blue dot shows for unread on inactive tab
 * 6. No indicator for null status
 */

// Store state we control from tests
let mockSessionStatuses: Record<string, { status: string; timestamp: number } | null> = {}
let mockActiveSessionId = 'session-1'

/**
 * Helper: create a mock zustand store that handles both
 * `useStore()` (no args → return full state) and `useStore(selector)` patterns.
 */
function createMockStore(getStateFn: () => Record<string, unknown>) {
  const store = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = getStateFn()
    return selector ? selector(state) : state
  }
  store.getState = getStateFn
  store.setState = vi.fn()
  store.subscribe = vi.fn(() => vi.fn())
  return store
}

// Mock useWorktreeStatusStore
vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: createMockStore(() => ({
    sessionStatuses: mockSessionStatuses,
    clearSessionStatus: vi.fn(),
    setSessionStatus: vi.fn(),
    clearWorktreeUnread: vi.fn(),
    getWorktreeStatus: vi.fn()
  }))
}))

// Mock useSessionStore
vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: createMockStore(() => ({
    activeWorktreeId: 'wt-1',
    activeSessionId: mockActiveSessionId,
    sessionsByWorktree: new Map([
      ['wt-1', [{ id: 'session-1', name: 'Test Session', worktree_id: 'wt-1' }]]
    ]),
    tabOrderByWorktree: new Map([['wt-1', ['session-1']]]),
    loadSessions: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    setActiveSession: vi.fn(),
    setActiveWorktree: vi.fn(),
    reorderTabs: vi.fn(),
    updateSessionName: vi.fn()
  }))
}))

// Mock useFileViewerStore
vi.mock('@/stores/useFileViewerStore', () => ({
  useFileViewerStore: createMockStore(() => ({
    openFiles: new Map(),
    activeFilePath: null,
    setActiveFile: vi.fn(),
    closeFile: vi.fn()
  }))
}))

// Mock useWorktreeStore
vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: createMockStore(() => ({
    selectedWorktreeId: 'wt-1',
    worktreesByProject: new Map([
      ['proj-1', [{ id: 'wt-1', project_id: 'proj-1', path: '/test', branch: 'main' }]]
    ])
  }))
}))

// Mock useProjectStore
vi.mock('@/stores/useProjectStore', () => ({
  useProjectStore: createMockStore(() => ({
    projects: [{ id: 'proj-1', name: 'Test Project' }]
  }))
}))

// Mock useSettingsStore
vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: createMockStore(() => ({
    autoStartSession: false
  }))
}))

// Mock sonner
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

import { SessionTabs } from '@/components/sessions/SessionTabs'

describe('Session 2: Tab Loading Indicator Fix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionStatuses = {}
    mockActiveSessionId = 'session-1'
    cleanup()
  })

  test('spinner shows for working status with text-blue-500', () => {
    mockSessionStatuses = {
      'session-1': { status: 'working', timestamp: Date.now() }
    }

    render(<SessionTabs />)

    const spinner = screen.getByTestId('tab-spinner-session-1')
    expect(spinner).toBeInTheDocument()
    expect(spinner).toHaveClass('text-blue-500')
    expect(spinner).toHaveClass('animate-spin')
  })

  test('spinner shows for planning status with text-blue-400', () => {
    mockSessionStatuses = {
      'session-1': { status: 'planning', timestamp: Date.now() }
    }

    render(<SessionTabs />)

    const spinner = screen.getByTestId('tab-spinner-session-1')
    expect(spinner).toBeInTheDocument()
    expect(spinner).toHaveClass('text-blue-400')
    expect(spinner).toHaveClass('animate-spin')
  })

  test('AlertCircle shows for answering status with text-amber-500', () => {
    mockSessionStatuses = {
      'session-1': { status: 'answering', timestamp: Date.now() }
    }

    render(<SessionTabs />)

    const indicator = screen.getByTestId('tab-answering-session-1')
    expect(indicator).toBeInTheDocument()
    expect(indicator).toHaveClass('text-amber-500')
  })

  test('Check shows for completed status with text-green-500', () => {
    mockSessionStatuses = {
      'session-1': { status: 'completed', timestamp: Date.now() }
    }

    render(<SessionTabs />)

    const indicator = screen.getByTestId('tab-completed-session-1')
    expect(indicator).toBeInTheDocument()
    expect(indicator).toHaveClass('text-green-500')
  })

  test('blue dot shows for unread on inactive tab', () => {
    // Make session-1 inactive by having a different active session
    mockActiveSessionId = 'session-other'
    mockSessionStatuses = {
      'session-1': { status: 'unread', timestamp: Date.now() }
    }

    render(<SessionTabs />)

    const dot = screen.getByTestId('tab-unread-session-1')
    expect(dot).toBeInTheDocument()
    expect(dot).toHaveClass('bg-blue-500')
    expect(dot).toHaveClass('rounded-full')
  })

  test('no indicator for null status', () => {
    mockSessionStatuses = {}

    render(<SessionTabs />)

    expect(screen.queryByTestId('tab-spinner-session-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tab-answering-session-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tab-completed-session-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tab-unread-session-1')).not.toBeInTheDocument()
  })

  test('no unread dot for active tab with unread status', () => {
    // session-1 is the active session (matches mockActiveSessionId)
    mockActiveSessionId = 'session-1'
    mockSessionStatuses = {
      'session-1': { status: 'unread', timestamp: Date.now() }
    }

    render(<SessionTabs />)

    // Active tab should NOT show unread dot
    expect(screen.queryByTestId('tab-unread-session-1')).not.toBeInTheDocument()
  })
})
