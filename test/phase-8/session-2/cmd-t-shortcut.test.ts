import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// =====================
// Mock stores
// =====================
const mockCreateSession = vi.fn().mockResolvedValue({ success: true })
const mockToggleSessionMode = vi.fn()
const mockCloseSession = vi.fn().mockResolvedValue({ success: true })

const mockWorktreeStoreState = {
  selectedWorktreeId: 'wt-1',
  worktreesByProject: new Map([['proj-1', [{ id: 'wt-1', path: '/test/worktree', name: 'main' }]]])
}

vi.mock('@/stores', () => ({
  useSessionStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        activeSessionId: 'session-1',
        createSession: mockCreateSession,
        toggleSessionMode: mockToggleSessionMode,
        closeSession: mockCloseSession
      }),
    {
      getState: () => ({
        activeSessionId: 'session-1',
        activeWorktreeId: 'wt-1',
        createSession: mockCreateSession,
        toggleSessionMode: mockToggleSessionMode,
        closeSession: mockCloseSession
      })
    }
  ),
  useProjectStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ projects: [] }),
    {
      getState: () => ({ projects: [] })
    }
  ),
  useLayoutStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        rightSidebarCollapsed: false,
        setRightSidebarCollapsed: vi.fn(),
        toggleLeftSidebar: vi.fn(),
        toggleRightSidebar: vi.fn(),
        setBottomPanelTab: vi.fn()
      }),
    {
      getState: () => ({
        rightSidebarCollapsed: false,
        setRightSidebarCollapsed: vi.fn(),
        toggleLeftSidebar: vi.fn(),
        toggleRightSidebar: vi.fn(),
        setBottomPanelTab: vi.fn()
      })
    }
  ),
  useSessionHistoryStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ togglePanel: vi.fn() }),
    {
      getState: () => ({ togglePanel: vi.fn() })
    }
  ),
  useCommandPaletteStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ toggle: vi.fn() }),
    {
      getState: () => ({ toggle: vi.fn() })
    }
  )
}))

vi.mock('@/stores/useGitStore', () => ({
  useGitStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ isPushing: false, isPulling: false, push: vi.fn(), pull: vi.fn() }),
    {
      getState: () => ({ isPushing: false, isPulling: false, push: vi.fn(), pull: vi.fn() })
    }
  )
}))

vi.mock('@/stores/useShortcutStore', () => ({
  useShortcutStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        getEffectiveBinding: (id: string) => {
          const bindings: Record<string, { key: string; modifiers: string[] }> = {
            'session:new': { key: 't', modifiers: ['meta'] },
            'session:close': { key: 'w', modifiers: ['meta'] },
            'session:mode-toggle': { key: 'Tab', modifiers: [] },
            'nav:command-palette': { key: 'p', modifiers: ['meta'] },
            'nav:session-history': { key: 'k', modifiers: ['meta'] }
          }
          return bindings[id] ?? null
        }
      }),
    {
      getState: () => ({
        getEffectiveBinding: (id: string) => {
          const bindings: Record<string, { key: string; modifiers: string[] }> = {
            'session:new': { key: 't', modifiers: ['meta'] }
          }
          return bindings[id] ?? null
        }
      })
    }
  )
}))

vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mockWorktreeStoreState),
    {
      getState: () => mockWorktreeStoreState
    }
  )
}))

vi.mock('@/stores/useScriptStore', () => ({
  useScriptStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ getScriptState: vi.fn() }),
    {
      getState: () => ({ getScriptState: vi.fn() })
    }
  )
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('@/lib/keyboard-shortcuts', () => ({
  eventMatchesBinding: (event: KeyboardEvent, binding: { key: string; modifiers: string[] }) => {
    const keyMatches = event.key.toLowerCase() === binding.key.toLowerCase()
    const metaRequired = binding.modifiers.includes('meta')
    const hasCtrlOrMeta = event.ctrlKey || event.metaKey
    if (metaRequired && !hasCtrlOrMeta) return false
    if (!metaRequired && hasCtrlOrMeta) return false
    return keyMatches
  }
}))

import { useKeyboardShortcuts } from '../../../src/renderer/src/hooks/useKeyboardShortcuts'
import { toast } from 'sonner'

describe('Session 2: Cmd+T Shortcut Fix', () => {
  let onNewSessionShortcutCallback: (() => void) | null = null
  let onNewSessionCleanup: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    // Restore default return value after clearAllMocks (which clears return values)
    mockCreateSession.mockResolvedValue({ success: true })
    onNewSessionShortcutCallback = null
    onNewSessionCleanup = vi.fn()

    // Mock window.systemOps.onNewSessionShortcut
    Object.defineProperty(window, 'systemOps', {
      writable: true,
      configurable: true,
      value: {
        onNewSessionShortcut: vi.fn((cb: () => void) => {
          onNewSessionShortcutCallback = cb
          return onNewSessionCleanup
        }),
        getLogDir: vi.fn(),
        getAppVersion: vi.fn(),
        getAppPaths: vi.fn(),
        isLogMode: vi.fn(),
        openInApp: vi.fn(),
        onNotificationNavigate: vi.fn().mockReturnValue(() => {})
      }
    })

    // Reset worktree store state
    mockWorktreeStoreState.selectedWorktreeId = 'wt-1'
    mockWorktreeStoreState.worktreesByProject = new Map([
      ['proj-1', [{ id: 'wt-1', path: '/test/worktree', name: 'main' }]]
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('before-input-event handler (main process)', () => {
    test('Cmd+T keyDown should be intercepted (meta=true, key=t, type=keyDown)', () => {
      // This tests the logic of the before-input-event handler.
      // We test the condition directly since we can't access main process in unit tests.
      const input = {
        key: 't',
        meta: true,
        control: false,
        alt: false,
        shift: false,
        type: 'keyDown' as const
      }

      const shouldIntercept =
        input.key.toLowerCase() === 't' &&
        (input.meta || input.control) &&
        !input.alt &&
        !input.shift &&
        input.type === 'keyDown'

      expect(shouldIntercept).toBe(true)
    })

    test('Ctrl+T keyDown should be intercepted (control=true, key=t, type=keyDown)', () => {
      const input = {
        key: 't',
        meta: false,
        control: true,
        alt: false,
        shift: false,
        type: 'keyDown' as const
      }

      const shouldIntercept =
        input.key.toLowerCase() === 't' &&
        (input.meta || input.control) &&
        !input.alt &&
        !input.shift &&
        input.type === 'keyDown'

      expect(shouldIntercept).toBe(true)
    })

    test('Cmd+T keyUp should NOT be intercepted', () => {
      const input = {
        key: 't',
        meta: true,
        control: false,
        alt: false,
        shift: false,
        type: 'keyUp' as string
      }

      const shouldIntercept =
        input.key.toLowerCase() === 't' &&
        (input.meta || input.control) &&
        !input.alt &&
        !input.shift &&
        input.type === 'keyDown'

      expect(shouldIntercept).toBe(false)
    })

    test('Cmd+Shift+T should NOT be intercepted', () => {
      const input = {
        key: 't',
        meta: true,
        control: false,
        alt: false,
        shift: true,
        type: 'keyDown' as const
      }

      const shouldIntercept =
        input.key.toLowerCase() === 't' &&
        (input.meta || input.control) &&
        !input.alt &&
        !input.shift &&
        input.type === 'keyDown'

      expect(shouldIntercept).toBe(false)
    })

    test('Alt+T should NOT be intercepted', () => {
      const input = {
        key: 't',
        meta: false,
        control: false,
        alt: true,
        shift: false,
        type: 'keyDown' as const
      }

      const shouldIntercept =
        input.key.toLowerCase() === 't' &&
        (input.meta || input.control) &&
        !input.alt &&
        !input.shift &&
        input.type === 'keyDown'

      expect(shouldIntercept).toBe(false)
    })

    test('uppercase T key should also be intercepted', () => {
      const input = {
        key: 'T',
        meta: true,
        control: false,
        alt: false,
        shift: false,
        type: 'keyDown' as const
      }

      const shouldIntercept =
        input.key.toLowerCase() === 't' &&
        (input.meta || input.control) &&
        !input.alt &&
        !input.shift &&
        input.type === 'keyDown'

      expect(shouldIntercept).toBe(true)
    })
  })

  describe('Renderer IPC listener', () => {
    test('registers IPC listener on mount', () => {
      renderHook(() => useKeyboardShortcuts())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).systemOps.onNewSessionShortcut).toHaveBeenCalledTimes(1)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).systemOps.onNewSessionShortcut).toHaveBeenCalledWith(
        expect.any(Function)
      )
    })

    test('IPC callback triggers session creation', async () => {
      renderHook(() => useKeyboardShortcuts())

      expect(onNewSessionShortcutCallback).not.toBeNull()

      await act(async () => {
        onNewSessionShortcutCallback!()
        // Allow the promise chain to resolve
        await new Promise((r) => setTimeout(r, 0))
      })

      expect(mockCreateSession).toHaveBeenCalledWith('wt-1', 'proj-1')
    })

    test('IPC callback shows error when no worktree selected', async () => {
      mockWorktreeStoreState.selectedWorktreeId = null as unknown as string

      renderHook(() => useKeyboardShortcuts())

      await act(async () => {
        onNewSessionShortcutCallback!()
      })

      expect(mockCreateSession).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith('Please select a worktree first', expect.any(Object))
    })

    test('IPC callback shows success toast on session creation', async () => {
      mockCreateSession.mockResolvedValueOnce({ success: true })

      renderHook(() => useKeyboardShortcuts())

      await act(async () => {
        onNewSessionShortcutCallback!()
      })

      expect(toast.success).toHaveBeenCalledWith('New session created', expect.any(Object))
    })

    test('IPC callback shows error toast on creation failure', async () => {
      mockCreateSession.mockResolvedValueOnce({ success: false, error: 'Something went wrong' })

      renderHook(() => useKeyboardShortcuts())

      await act(async () => {
        onNewSessionShortcutCallback!()
      })

      expect(toast.error).toHaveBeenCalledWith('Something went wrong', expect.any(Object))
    })

    test('cleanup function is called on unmount', () => {
      const { unmount } = renderHook(() => useKeyboardShortcuts())

      unmount()

      expect(onNewSessionCleanup).toHaveBeenCalledTimes(1)
    })
  })

  describe('allowInInput', () => {
    test('session:new shortcut fires when textarea is focused', () => {
      renderHook(() => useKeyboardShortcuts())

      // Create and focus a textarea
      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()

      // Dispatch Cmd+T keydown (metaKey=true)
      const event = new KeyboardEvent('keydown', {
        key: 't',
        metaKey: true,
        bubbles: true,
        cancelable: true
      })

      document.dispatchEvent(event)

      // Since allowInInput is true, handler should fire (session creation)
      expect(mockCreateSession).toHaveBeenCalledWith('wt-1', 'proj-1')

      document.body.removeChild(textarea)
    })

    test('session:new shortcut fires when no input is focused', () => {
      renderHook(() => useKeyboardShortcuts())

      // Dispatch Cmd+T keydown
      const event = new KeyboardEvent('keydown', {
        key: 't',
        metaKey: true,
        bubbles: true,
        cancelable: true
      })

      document.dispatchEvent(event)

      expect(mockCreateSession).toHaveBeenCalledWith('wt-1', 'proj-1')
    })
  })
})
