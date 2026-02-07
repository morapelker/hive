import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModeToggle } from '../../../src/renderer/src/components/sessions/ModeToggle'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

// Mock window.db
const mockSessionUpdate = vi.fn().mockResolvedValue({})
const mockSessionCreate = vi.fn().mockResolvedValue({
  id: 'session-1',
  worktree_id: 'wt-1',
  project_id: 'proj-1',
  name: 'Session 14:30',
  status: 'active',
  opencode_session_id: null,
  mode: 'build',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  completed_at: null
})
const mockGetActiveByWorktree = vi.fn().mockResolvedValue([])

beforeEach(() => {
  vi.clearAllMocks()

  // Reset store state
  useSessionStore.setState({
    sessionsByWorktree: new Map(),
    tabOrderByWorktree: new Map(),
    modeBySession: new Map(),
    isLoading: false,
    error: null,
    activeSessionId: null,
    activeWorktreeId: null
  })

  // Mock window.db
  Object.defineProperty(window, 'db', {
    value: {
      session: {
        update: mockSessionUpdate,
        create: mockSessionCreate,
        getActiveByWorktree: mockGetActiveByWorktree,
        get: vi.fn(),
        getByWorktree: vi.fn(),
        getByProject: vi.fn(),
        delete: vi.fn(),
        search: vi.fn()
      },
      setting: {
        get: vi.fn(),
        set: vi.fn()
      }
    },
    writable: true,
    configurable: true
  })
})

afterEach(() => {
  cleanup()
})

describe('Session 11: Build/Plan Mode & Auto-Start', () => {
  describe('ModeToggle Component', () => {
    test('Mode toggle visible in session header', () => {
      // Set up session with build mode
      useSessionStore.setState({
        modeBySession: new Map([['session-1', 'build']])
      })

      render(<ModeToggle sessionId="session-1" />)
      expect(screen.getByTestId('mode-toggle')).toBeInTheDocument()
    })

    test('Mode toggle shows Build by default', () => {
      useSessionStore.setState({
        modeBySession: new Map([['session-1', 'build']])
      })

      render(<ModeToggle sessionId="session-1" />)
      expect(screen.getByText('Build')).toBeInTheDocument()
      expect(screen.getByTestId('mode-toggle')).toHaveAttribute('data-mode', 'build')
    })

    test('Mode toggle shows Plan when set', () => {
      useSessionStore.setState({
        modeBySession: new Map([['session-1', 'plan']])
      })

      render(<ModeToggle sessionId="session-1" />)
      expect(screen.getByText('Plan')).toBeInTheDocument()
      expect(screen.getByTestId('mode-toggle')).toHaveAttribute('data-mode', 'plan')
    })

    test('Clicking toggle switches from Build to Plan', async () => {
      const user = userEvent.setup()

      useSessionStore.setState({
        modeBySession: new Map([['session-1', 'build']])
      })

      render(<ModeToggle sessionId="session-1" />)
      expect(screen.getByText('Build')).toBeInTheDocument()

      await user.click(screen.getByTestId('mode-toggle'))

      // After toggle, mode should be plan
      expect(screen.getByText('Plan')).toBeInTheDocument()
      expect(screen.getByTestId('mode-toggle')).toHaveAttribute('data-mode', 'plan')
    })

    test('Clicking toggle switches from Plan to Build', async () => {
      const user = userEvent.setup()

      useSessionStore.setState({
        modeBySession: new Map([['session-1', 'plan']])
      })

      render(<ModeToggle sessionId="session-1" />)
      expect(screen.getByText('Plan')).toBeInTheDocument()

      await user.click(screen.getByTestId('mode-toggle'))

      expect(screen.getByText('Build')).toBeInTheDocument()
      expect(screen.getByTestId('mode-toggle')).toHaveAttribute('data-mode', 'build')
    })

    test('Mode toggle persists to database', async () => {
      const user = userEvent.setup()

      useSessionStore.setState({
        modeBySession: new Map([['session-1', 'build']])
      })

      render(<ModeToggle sessionId="session-1" />)
      await user.click(screen.getByTestId('mode-toggle'))

      expect(mockSessionUpdate).toHaveBeenCalledWith('session-1', { mode: 'plan' })
    })

    test('Mode defaults to build for unknown session', () => {
      useSessionStore.setState({
        modeBySession: new Map()
      })

      render(<ModeToggle sessionId="unknown-session" />)
      expect(screen.getByText('Build')).toBeInTheDocument()
    })
  })

  describe('Session Store Mode Management', () => {
    test('getSessionMode returns build by default', () => {
      const mode = useSessionStore.getState().getSessionMode('nonexistent')
      expect(mode).toBe('build')
    })

    test('toggleSessionMode switches build to plan', async () => {
      useSessionStore.setState({
        modeBySession: new Map([['s1', 'build']])
      })

      await useSessionStore.getState().toggleSessionMode('s1')
      expect(useSessionStore.getState().modeBySession.get('s1')).toBe('plan')
    })

    test('toggleSessionMode switches plan to build', async () => {
      useSessionStore.setState({
        modeBySession: new Map([['s1', 'plan']])
      })

      await useSessionStore.getState().toggleSessionMode('s1')
      expect(useSessionStore.getState().modeBySession.get('s1')).toBe('build')
    })

    test('setSessionMode sets mode explicitly', async () => {
      useSessionStore.setState({
        modeBySession: new Map([['s1', 'build']])
      })

      await useSessionStore.getState().setSessionMode('s1', 'plan')
      expect(useSessionStore.getState().modeBySession.get('s1')).toBe('plan')
    })

    test('Mode persists per session independently', async () => {
      useSessionStore.setState({
        modeBySession: new Map([
          ['s1', 'build'],
          ['s2', 'build']
        ])
      })

      await useSessionStore.getState().toggleSessionMode('s1')

      expect(useSessionStore.getState().modeBySession.get('s1')).toBe('plan')
      expect(useSessionStore.getState().modeBySession.get('s2')).toBe('build')
    })

    test('loadSessions populates mode from database', async () => {
      mockGetActiveByWorktree.mockResolvedValueOnce([
        {
          id: 's1',
          worktree_id: 'wt-1',
          project_id: 'p1',
          name: 'Session 1',
          status: 'active',
          opencode_session_id: null,
          mode: 'plan',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null
        }
      ])

      useSessionStore.setState({ activeWorktreeId: 'wt-1' })
      await useSessionStore.getState().loadSessions('wt-1', 'p1')

      expect(useSessionStore.getState().modeBySession.get('s1')).toBe('plan')
    })
  })

  describe('Mode Toggle Response Time', () => {
    test('Mode toggle responds under 100ms', async () => {
      useSessionStore.setState({
        modeBySession: new Map([['session-1', 'build']])
      })

      render(<ModeToggle sessionId="session-1" />)

      const start = performance.now()
      await act(async () => {
        screen.getByTestId('mode-toggle').click()
      })
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(100)
    })
  })

  describe('Build vs Plan Mode Visual Distinction', () => {
    test('Build mode has primary color styling', () => {
      useSessionStore.setState({
        modeBySession: new Map([['s1', 'build']])
      })

      render(<ModeToggle sessionId="s1" />)
      const toggle = screen.getByTestId('mode-toggle')
      expect(toggle.className).toContain('text-primary')
    })

    test('Plan mode has violet color styling', () => {
      useSessionStore.setState({
        modeBySession: new Map([['s1', 'plan']])
      })

      render(<ModeToggle sessionId="s1" />)
      const toggle = screen.getByTestId('mode-toggle')
      expect(toggle.className).toContain('text-violet')
    })
  })
})
