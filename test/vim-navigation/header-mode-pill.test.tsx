import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock ALL stores Header.tsx imports (must be before component import)
// ---------------------------------------------------------------------------

const layoutState = {
  rightSidebarCollapsed: false,
  toggleRightSidebar: vi.fn()
}

vi.mock('@/stores/useLayoutStore', () => {
  const useLayoutStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof layoutState) => unknown)(layoutState)
      : layoutState
  )
  useLayoutStore.getState = vi.fn(() => layoutState)
  useLayoutStore.subscribe = vi.fn(() => () => {})
  return { useLayoutStore }
})

const sessionHistoryState = { openPanel: vi.fn() }

vi.mock('@/stores/useSessionHistoryStore', () => {
  const useSessionHistoryStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof sessionHistoryState) => unknown)(sessionHistoryState)
      : sessionHistoryState
  )
  useSessionHistoryStore.getState = vi.fn(() => sessionHistoryState)
  useSessionHistoryStore.subscribe = vi.fn(() => () => {})
  return { useSessionHistoryStore }
})

const settingsState = { openSettings: vi.fn() }

vi.mock('@/stores/useSettingsStore', () => {
  const useSettingsStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof settingsState) => unknown)(settingsState)
      : settingsState
  )
  useSettingsStore.getState = vi.fn(() => settingsState)
  useSettingsStore.subscribe = vi.fn(() => () => {})
  return { useSettingsStore }
})

const projectState = { selectedProjectId: null, projects: [] as unknown[] }

vi.mock('@/stores/useProjectStore', () => {
  const useProjectStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof projectState) => unknown)(projectState)
      : projectState
  )
  useProjectStore.getState = vi.fn(() => projectState)
  useProjectStore.subscribe = vi.fn(() => () => {})
  return { useProjectStore }
})

const worktreeState = {
  selectedWorktreeId: null,
  worktreesByProject: new Map()
}

vi.mock('@/stores/useWorktreeStore', () => {
  const useWorktreeStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof worktreeState) => unknown)(worktreeState)
      : worktreeState
  )
  useWorktreeStore.getState = vi.fn(() => worktreeState)
  useWorktreeStore.subscribe = vi.fn(() => () => {})
  return { useWorktreeStore }
})

const connectionState = {
  selectedConnectionId: null,
  connections: [] as unknown[]
}

vi.mock('@/stores/useConnectionStore', () => {
  const useConnectionStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof connectionState) => unknown)(connectionState)
      : connectionState
  )
  useConnectionStore.getState = vi.fn(() => connectionState)
  useConnectionStore.subscribe = vi.fn(() => () => {})
  return { useConnectionStore }
})

const sessionState = {
  createSession: vi.fn(),
  updateSessionName: vi.fn(),
  setPendingMessage: vi.fn(),
  setActiveSession: vi.fn()
}

vi.mock('@/stores/useSessionStore', () => {
  const useSessionStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof sessionState) => unknown)(sessionState)
      : sessionState
  )
  useSessionStore.getState = vi.fn(() => sessionState)
  useSessionStore.subscribe = vi.fn(() => () => {})
  return { useSessionStore }
})

const gitState = {
  conflictsByWorktree: {},
  remoteInfo: new Map(),
  prTargetBranch: new Map(),
  setPrTargetBranch: vi.fn(),
  reviewTargetBranch: new Map(),
  setReviewTargetBranch: vi.fn(),
  branchInfoByWorktree: new Map(),
  isPushing: false,
  isPulling: false,
  prInfo: new Map(),
  fileStatusesByWorktree: new Map(),
  refreshStatuses: vi.fn()
}

vi.mock('@/stores/useGitStore', () => {
  const useGitStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof gitState) => unknown)(gitState)
      : gitState
  )
  useGitStore.getState = vi.fn(() => gitState)
  useGitStore.subscribe = vi.fn(() => () => {})
  return { useGitStore }
})

const worktreeStatusState = { sessionStatuses: {} }

vi.mock('@/stores/useWorktreeStatusStore', () => {
  const useWorktreeStatusStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof worktreeStatusState) => unknown)(worktreeStatusState)
      : worktreeStatusState
  )
  useWorktreeStatusStore.getState = vi.fn(() => worktreeStatusState)
  useWorktreeStatusStore.subscribe = vi.fn(() => () => {})
  return { useWorktreeStatusStore }
})

// ---------------------------------------------------------------------------
// Mock non-store dependencies
// ---------------------------------------------------------------------------

vi.mock('@/hooks/usePRDetection', () => ({
  usePRDetection: vi.fn()
}))

vi.mock('@/assets/icon.png', () => ({
  default: 'test-icon.png'
}))

vi.mock('@/components/layout/QuickActions', () => ({
  QuickActions: () => <div data-testid="quick-actions" />
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

// ---------------------------------------------------------------------------
// Real store (what we're testing)
// ---------------------------------------------------------------------------

import { useVimModeStore } from '@/stores/useVimModeStore'

// ---------------------------------------------------------------------------
// Import component under test AFTER mocks
// ---------------------------------------------------------------------------

import { Header } from '@/components/layout/Header'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStores(): void {
  useVimModeStore.setState({
    mode: 'normal',
    helpOverlayOpen: false
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Header mode pill', () => {
  beforeEach(() => {
    resetStores()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders NORMAL pill when vim mode is normal', () => {
    useVimModeStore.setState({ mode: 'normal' })

    render(<Header />)

    const pill = screen.getByTestId('vim-mode-pill')
    expect(pill).toBeInTheDocument()
    expect(pill.textContent).toBe('NORMAL')
  })

  it('renders INSERT pill when vim mode is insert', () => {
    useVimModeStore.setState({ mode: 'insert' })

    render(<Header />)

    const pill = screen.getByTestId('vim-mode-pill')
    expect(pill).toBeInTheDocument()
    expect(pill.textContent).toBe('INSERT')
  })

  it('has muted styling classes in normal mode', () => {
    useVimModeStore.setState({ mode: 'normal' })

    render(<Header />)

    const pill = screen.getByTestId('vim-mode-pill')
    expect(pill.className).toContain('text-muted-foreground')
    expect(pill.className).toContain('bg-muted/50')
    expect(pill.className).toContain('border-border/50')
  })

  it('has primary styling classes in insert mode', () => {
    useVimModeStore.setState({ mode: 'insert' })

    render(<Header />)

    const pill = screen.getByTestId('vim-mode-pill')
    expect(pill.className).toContain('text-primary')
    expect(pill.className).toContain('bg-primary/10')
    expect(pill.className).toContain('border-primary/30')
  })
})
