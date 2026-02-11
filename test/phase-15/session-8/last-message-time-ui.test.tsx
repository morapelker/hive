import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WorktreeItem } from '@/components/worktrees/WorktreeItem'

/**
 * Session 8: Last Message Time UI — Tests
 *
 * These tests verify:
 * 1. Relative time renders when lastMessageTime exists
 * 2. No time displayed when no lastMessageTime
 * 3. Time element has tooltip with full date
 * 4. Status text and time are in a flex row
 */

// Mock stores
const mockGetWorktreeStatus = vi.fn().mockReturnValue(null)
const mockLastMessageTimeByWorktree: Record<string, number> = {}

vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        getWorktreeStatus: mockGetWorktreeStatus,
        lastMessageTimeByWorktree: mockLastMessageTimeByWorktree
      }),
    {
      getState: () => ({
        clearWorktreeUnread: vi.fn(),
        getWorktreeStatus: mockGetWorktreeStatus,
        lastMessageTimeByWorktree: mockLastMessageTimeByWorktree
      })
    }
  )
}))

const worktreeStoreState = {
  selectedWorktreeId: 'wt-other',
  selectWorktree: vi.fn(),
  archiveWorktree: vi.fn(),
  unbranchWorktree: vi.fn(),
  archivingWorktreeIds: new Set(),
  updateWorktreeBranch: vi.fn()
}

const projectStoreState = {
  selectProject: vi.fn(),
  projects: []
}

vi.mock('@/stores', () => ({
  useWorktreeStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(worktreeStoreState) : worktreeStoreState,
    {
      getState: () => worktreeStoreState
    }
  ),
  useProjectStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(projectStoreState) : projectStoreState,
    {
      getState: () => projectStoreState
    }
  )
}))

vi.mock('@/stores/useScriptStore', () => ({
  useScriptStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      scriptStates: {}
    })
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  gitToast: { worktreeArchived: vi.fn(), operationFailed: vi.fn() },
  clipboardToast: { copied: vi.fn() }
}))

const mockWorktree = {
  id: 'wt-1',
  project_id: 'proj-1',
  name: 'feature/auth',
  branch_name: 'feature/auth',
  path: '/path/to/worktree',
  status: 'active' as const,
  is_default: false,
  created_at: '2025-01-01T00:00:00Z',
  last_accessed_at: '2025-01-01T00:00:00Z'
}

describe('Session 8: Last Message Time UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Clear the mock timestamp map
    for (const key of Object.keys(mockLastMessageTimeByWorktree)) {
      delete mockLastMessageTimeByWorktree[key]
    }
  })

  test('renders relative time when lastMessageTime exists', () => {
    // Set timestamp to 2 minutes ago
    mockLastMessageTimeByWorktree['wt-1'] = Date.now() - 120000

    render(<WorktreeItem worktree={mockWorktree} projectPath="/project" />)

    const timeEl = screen.getByTestId('worktree-last-message-time')
    expect(timeEl).toBeDefined()
    expect(timeEl.textContent).toBe('2m')
  })

  test('does not render time when no lastMessageTime', () => {
    // No timestamp set for wt-1
    render(<WorktreeItem worktree={mockWorktree} projectPath="/project" />)

    expect(screen.queryByTestId('worktree-last-message-time')).toBeNull()
  })

  test('time element has tooltip with full date', () => {
    const timestamp = Date.now() - 3600000 // 1 hour ago
    mockLastMessageTimeByWorktree['wt-1'] = timestamp

    render(<WorktreeItem worktree={mockWorktree} projectPath="/project" />)

    const timeEl = screen.getByTestId('worktree-last-message-time')
    const title = timeEl.getAttribute('title')
    expect(title).toBeTruthy()
    // Title should be a locale date string
    expect(title).toBe(new Date(timestamp).toLocaleString())
  })

  test('renders "now" for very recent messages', () => {
    mockLastMessageTimeByWorktree['wt-1'] = Date.now() - 5000 // 5 seconds ago

    render(<WorktreeItem worktree={mockWorktree} projectPath="/project" />)

    const timeEl = screen.getByTestId('worktree-last-message-time')
    expect(timeEl.textContent).toBe('now')
  })

  test('renders hours correctly', () => {
    mockLastMessageTimeByWorktree['wt-1'] = Date.now() - 3 * 3600000 // 3 hours ago

    render(<WorktreeItem worktree={mockWorktree} projectPath="/project" />)

    const timeEl = screen.getByTestId('worktree-last-message-time')
    expect(timeEl.textContent).toBe('3h')
  })

  test('status text still renders alongside time', () => {
    mockLastMessageTimeByWorktree['wt-1'] = Date.now() - 60000

    render(<WorktreeItem worktree={mockWorktree} projectPath="/project" />)

    const statusEl = screen.getByTestId('worktree-status-text')
    expect(statusEl).toBeDefined()
    expect(statusEl.textContent).toBe('Ready')

    const timeEl = screen.getByTestId('worktree-last-message-time')
    expect(timeEl).toBeDefined()
    expect(timeEl.textContent).toBe('1m')
  })
})
