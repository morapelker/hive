import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock stores — each vi.mock call provides a controllable getState()
// ---------------------------------------------------------------------------

const mockEnterNormalMode = vi.fn()
const mockEnterInsertMode = vi.fn()
const mockToggleHelpOverlay = vi.fn()
const mockSetHelpOverlayOpen = vi.fn()

const vimModeState = {
  mode: 'normal' as 'normal' | 'insert',
  helpOverlayOpen: false,
  enterNormalMode: mockEnterNormalMode,
  enterInsertMode: mockEnterInsertMode,
  toggleHelpOverlay: mockToggleHelpOverlay,
  setHelpOverlayOpen: mockSetHelpOverlayOpen
}

vi.mock('@/stores/useVimModeStore', () => ({
  useVimModeStore: {
    getState: () => vimModeState
  }
}))

const commandPaletteState = {
  isOpen: false
}

vi.mock('@/stores/useCommandPaletteStore', () => ({
  useCommandPaletteStore: {
    getState: () => commandPaletteState
  }
}))

const mockSetLeftSidebarCollapsed = vi.fn()
const mockSetRightSidebarCollapsed = vi.fn()
const mockSetBottomPanelTab = vi.fn()

const layoutState = {
  leftSidebarCollapsed: false,
  setLeftSidebarCollapsed: mockSetLeftSidebarCollapsed,
  rightSidebarCollapsed: false,
  setRightSidebarCollapsed: mockSetRightSidebarCollapsed,
  setBottomPanelTab: mockSetBottomPanelTab
}

vi.mock('@/stores/useLayoutStore', () => ({
  useLayoutStore: {
    getState: () => layoutState
  }
}))

const mockEnterPending = vi.fn()
const mockExitPending = vi.fn()

const hintState = {
  mode: 'idle' as 'idle' | 'pending',
  pendingChar: null as string | null,
  hintMap: new Map<string, string>(),
  sessionHintMap: new Map<string, string>(),
  sessionHintTargetMap: new Map<string, string>(),
  enterPending: mockEnterPending,
  exitPending: mockExitPending
}

vi.mock('@/stores/useHintStore', () => ({
  useHintStore: {
    getState: () => hintState
  }
}))

// Session 4 — mock dispatchHintAction from hint-utils

const mockDispatchHintAction = vi.fn()

vi.mock('@/lib/hint-utils', () => ({
  dispatchHintAction: (...args: unknown[]) => mockDispatchHintAction(...args)
}))

// Session 4 — mock useSessionStore

const mockSetActiveSession = vi.fn()

const sessionState = {
  setActiveSession: mockSetActiveSession
}

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: {
    getState: () => sessionState
  }
}))

// Session 3 — additional store mocks for panel + file tab navigation

const mockSetActiveFile = vi.fn()

const fileViewerState = {
  openFiles: new Map<string, { type: string; path?: string }>(),
  activeFilePath: null as string | null,
  setActiveFile: mockSetActiveFile
}

vi.mock('@/stores/useFileViewerStore', () => ({
  useFileViewerStore: {
    getState: () => fileViewerState
  }
}))

// ---------------------------------------------------------------------------
// Import the hook under test
// ---------------------------------------------------------------------------
import { useVimNavigation } from '@/hooks/useVimNavigation'

// ---------------------------------------------------------------------------
// fireKey() helper — dispatches a KeyboardEvent on document and reports
// whether preventDefault() was called (i.e. the event was "consumed").
// ---------------------------------------------------------------------------
function fireKey(
  key: string,
  opts?: Partial<KeyboardEventInit>
): boolean {
  let defaultPrevented = false
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts
  })
  // Spy on preventDefault to detect consumption
  const origPreventDefault = event.preventDefault.bind(event)
  event.preventDefault = () => {
    defaultPrevented = true
    origPreventDefault()
  }
  document.dispatchEvent(event)
  return defaultPrevented
}

// ---------------------------------------------------------------------------
// Setup & teardown
// ---------------------------------------------------------------------------
describe('useVimNavigation', () => {
  beforeEach(() => {
    // Reset all mock functions
    vi.clearAllMocks()

    // Reset vim mode state to defaults
    vimModeState.mode = 'normal'
    vimModeState.helpOverlayOpen = false

    // Reset command palette state
    commandPaletteState.isOpen = false

    // Reset layout state
    layoutState.leftSidebarCollapsed = false
    layoutState.rightSidebarCollapsed = false

    // Reset hint state
    hintState.mode = 'idle'
    hintState.pendingChar = null
    hintState.hintMap = new Map()
    hintState.sessionHintMap = new Map()
    hintState.sessionHintTargetMap = new Map()

    // Reset file viewer state
    fileViewerState.openFiles = new Map()
    fileViewerState.activeFilePath = null
  })

  afterEach(() => {
    cleanup()
    // Remove any leftover Radix dialog elements
    document
      .querySelectorAll('[data-radix-dialog-content]')
      .forEach((el) => el.remove())
    // Remove any leftover message-input elements from insert mode tests
    document
      .querySelectorAll('[data-testid="message-input"]')
      .forEach((el) => el.remove())
  })

  // =========================================================================
  // 2.2 — Guard condition tests
  // =========================================================================
  describe('guard conditions', () => {
    it('metaKey=true is not consumed (passes through)', () => {
      renderHook(() => useVimNavigation())
      const consumed = fireKey('j', { metaKey: true })
      expect(consumed).toBe(false)
    })

    it('ctrlKey=true is not consumed', () => {
      renderHook(() => useVimNavigation())
      const consumed = fireKey('j', { ctrlKey: true })
      expect(consumed).toBe(false)
    })

    it('altKey=true is not consumed', () => {
      renderHook(() => useVimNavigation())
      const consumed = fireKey('j', { altKey: true })
      expect(consumed).toBe(false)
    })

    it('insert mode + key !== Escape is not consumed', () => {
      vimModeState.mode = 'insert'
      renderHook(() => useVimNavigation())
      const consumed = fireKey('j')
      expect(consumed).toBe(false)
    })

    it('Radix dialog present means key is not consumed', () => {
      renderHook(() => useVimNavigation())
      const dialog = document.createElement('div')
      dialog.setAttribute('data-radix-dialog-content', '')
      document.body.appendChild(dialog)

      const consumed = fireKey('j')
      expect(consumed).toBe(false)
    })

    it('command palette open means key is not consumed', () => {
      commandPaletteState.isOpen = true
      renderHook(() => useVimNavigation())
      const consumed = fireKey('j')
      expect(consumed).toBe(false)
    })
  })

  // =========================================================================
  // 2.3 — Mode transition tests
  // =========================================================================
  describe('mode transitions', () => {
    it('Escape in insert mode calls enterNormalMode()', () => {
      vimModeState.mode = 'insert'
      renderHook(() => useVimNavigation())

      fireKey('Escape')

      expect(mockEnterNormalMode).toHaveBeenCalledTimes(1)
    })

    it('Escape in normal mode with helpOverlayOpen calls setHelpOverlayOpen(false)', () => {
      vimModeState.mode = 'normal'
      vimModeState.helpOverlayOpen = true
      renderHook(() => useVimNavigation())

      fireKey('Escape')

      expect(mockSetHelpOverlayOpen).toHaveBeenCalledWith(false)
    })

    it('Escape in normal mode without overlay does NOT preventDefault (propagates)', () => {
      vimModeState.mode = 'normal'
      vimModeState.helpOverlayOpen = false
      renderHook(() => useVimNavigation())

      const consumed = fireKey('Escape')

      expect(consumed).toBe(false)
    })

    it('i in normal mode calls enterInsertMode and focuses the session chat input', () => {
      // Create a mock message-input element to verify focus
      const messageInput = document.createElement('textarea')
      messageInput.setAttribute('data-testid', 'message-input')
      document.body.appendChild(messageInput)
      const focusSpy = vi.spyOn(messageInput, 'focus')

      renderHook(() => useVimNavigation())

      fireKey('i')

      // enterInsertMode called by handler (and again by focusin on the textarea)
      expect(mockEnterInsertMode).toHaveBeenCalled()
      expect(focusSpy).toHaveBeenCalled()

      focusSpy.mockRestore()
    })

    it('I (Shift+I) in normal mode also calls enterInsertMode and focuses the session chat input', () => {
      const messageInput = document.createElement('textarea')
      messageInput.setAttribute('data-testid', 'message-input')
      document.body.appendChild(messageInput)
      const focusSpy = vi.spyOn(messageInput, 'focus')

      renderHook(() => useVimNavigation())

      fireKey('I', { shiftKey: true })

      expect(mockEnterInsertMode).toHaveBeenCalled()
      expect(focusSpy).toHaveBeenCalled()

      focusSpy.mockRestore()
    })

    it('i/I does not open the left sidebar (focuses session input instead)', () => {
      layoutState.leftSidebarCollapsed = true
      renderHook(() => useVimNavigation())

      fireKey('i')

      expect(mockEnterInsertMode).toHaveBeenCalled()
      expect(mockSetLeftSidebarCollapsed).not.toHaveBeenCalled()
    })

    it('? toggles help overlay', () => {
      renderHook(() => useVimNavigation())

      fireKey('?')

      expect(mockToggleHelpOverlay).toHaveBeenCalledTimes(1)
    })
  })

  // =========================================================================
  // 2.4 — focusin / focusout tests
  // =========================================================================
  describe('focus tracking', () => {
    it('focusin on INPUT outside Radix calls enterInsertMode()', () => {
      renderHook(() => useVimNavigation())

      const input = document.createElement('input')
      document.body.appendChild(input)

      const event = new FocusEvent('focusin', {
        bubbles: true,
        relatedTarget: null
      })
      Object.defineProperty(event, 'target', { value: input })
      document.dispatchEvent(event)

      expect(mockEnterInsertMode).toHaveBeenCalledTimes(1)

      input.remove()
    })

    it('focusin on INPUT inside [data-radix-dialog-content] does NOT switch mode', () => {
      renderHook(() => useVimNavigation())

      const dialog = document.createElement('div')
      dialog.setAttribute('data-radix-dialog-content', '')
      const input = document.createElement('input')
      dialog.appendChild(input)
      document.body.appendChild(dialog)

      const event = new FocusEvent('focusin', {
        bubbles: true,
        relatedTarget: null
      })
      Object.defineProperty(event, 'target', { value: input })
      document.dispatchEvent(event)

      expect(mockEnterInsertMode).not.toHaveBeenCalled()

      dialog.remove()
    })

    it('focusin on INPUT inside [cmdk-root] does NOT switch mode', () => {
      renderHook(() => useVimNavigation())

      const cmdkRoot = document.createElement('div')
      cmdkRoot.setAttribute('cmdk-root', '')
      const input = document.createElement('input')
      cmdkRoot.appendChild(input)
      document.body.appendChild(cmdkRoot)

      const event = new FocusEvent('focusin', {
        bubbles: true,
        relatedTarget: null
      })
      Object.defineProperty(event, 'target', { value: input })
      document.dispatchEvent(event)

      expect(mockEnterInsertMode).not.toHaveBeenCalled()

      cmdkRoot.remove()
    })

    it('focusout where new activeElement is body calls enterNormalMode()', () => {
      vimModeState.mode = 'insert'
      renderHook(() => useVimNavigation())

      const input = document.createElement('input')
      document.body.appendChild(input)

      const event = new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: null
      })
      Object.defineProperty(event, 'target', { value: input })
      // After focusout with no relatedTarget, activeElement falls back to body
      document.dispatchEvent(event)

      expect(mockEnterNormalMode).toHaveBeenCalledTimes(1)

      input.remove()
    })

    it('focusout where new activeElement is another INPUT does NOT call enterNormalMode', () => {
      vimModeState.mode = 'insert'
      renderHook(() => useVimNavigation())

      const input1 = document.createElement('input')
      const input2 = document.createElement('input')
      document.body.appendChild(input1)
      document.body.appendChild(input2)

      const event = new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: input2
      })
      Object.defineProperty(event, 'target', { value: input1 })
      document.dispatchEvent(event)

      expect(mockEnterNormalMode).not.toHaveBeenCalled()

      input1.remove()
      input2.remove()
    })
  })

  // =========================================================================
  // 3.1 — hjkl scroll tests (scroll only, no selection changes)
  // =========================================================================
  describe('hjkl sidebar scrolling', () => {
    let sidebarContainer: HTMLDivElement
    let mockScrollBy: ReturnType<typeof vi.fn>

    beforeEach(() => {
      sidebarContainer = document.createElement('div')
      sidebarContainer.setAttribute('data-testid', 'sidebar-scroll-container')
      mockScrollBy = vi.fn()
      sidebarContainer.scrollBy = mockScrollBy
      document.body.appendChild(sidebarContainer)
    })

    afterEach(() => {
      sidebarContainer.remove()
    })

    it('j scrolls sidebar down', () => {
      renderHook(() => useVimNavigation())
      fireKey('j')
      expect(mockScrollBy).toHaveBeenCalledWith({ top: 80, behavior: 'smooth' })
    })

    it('k scrolls sidebar up', () => {
      renderHook(() => useVimNavigation())
      fireKey('k')
      expect(mockScrollBy).toHaveBeenCalledWith({ top: -80, behavior: 'smooth' })
    })

    it('ArrowDown scrolls sidebar down', () => {
      renderHook(() => useVimNavigation())
      fireKey('ArrowDown')
      expect(mockScrollBy).toHaveBeenCalledWith({ top: 80, behavior: 'smooth' })
    })

    it('ArrowUp scrolls sidebar up', () => {
      renderHook(() => useVimNavigation())
      fireKey('ArrowUp')
      expect(mockScrollBy).toHaveBeenCalledWith({ top: -80, behavior: 'smooth' })
    })

    it('j with no sidebar container is a no-op (no crash)', () => {
      sidebarContainer.remove()
      renderHook(() => useVimNavigation())
      fireKey('j')
      // Should not crash — scrollBy never called
      expect(mockScrollBy).not.toHaveBeenCalled()
    })
  })

  describe('hjkl session tab scrolling', () => {
    let tabsContainer: HTMLDivElement
    let mockScrollBy: ReturnType<typeof vi.fn>

    beforeEach(() => {
      tabsContainer = document.createElement('div')
      tabsContainer.setAttribute('data-testid', 'session-tabs-scroll-container')
      mockScrollBy = vi.fn()
      tabsContainer.scrollBy = mockScrollBy
      document.body.appendChild(tabsContainer)
    })

    afterEach(() => {
      tabsContainer.remove()
    })

    it('l scrolls tabs right', () => {
      renderHook(() => useVimNavigation())
      fireKey('l')
      expect(mockScrollBy).toHaveBeenCalledWith({ left: 150, behavior: 'smooth' })
    })

    it('h scrolls tabs left', () => {
      renderHook(() => useVimNavigation())
      fireKey('h')
      expect(mockScrollBy).toHaveBeenCalledWith({ left: -150, behavior: 'smooth' })
    })

    it('ArrowRight scrolls tabs right', () => {
      renderHook(() => useVimNavigation())
      fireKey('ArrowRight')
      expect(mockScrollBy).toHaveBeenCalledWith({ left: 150, behavior: 'smooth' })
    })

    it('ArrowLeft scrolls tabs left', () => {
      renderHook(() => useVimNavigation())
      fireKey('ArrowLeft')
      expect(mockScrollBy).toHaveBeenCalledWith({ left: -150, behavior: 'smooth' })
    })

    it('l with no tabs container is a no-op (no crash)', () => {
      tabsContainer.remove()
      renderHook(() => useVimNavigation())
      fireKey('l')
      expect(mockScrollBy).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 3.2 — Panel navigation tests
  // =========================================================================
  describe('panel navigation', () => {
    it('c opens right sidebar if collapsed and dispatches hive:right-sidebar-tab with changes', () => {
      layoutState.rightSidebarCollapsed = true
      renderHook(() => useVimNavigation())

      const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

      fireKey('c')

      expect(mockSetRightSidebarCollapsed).toHaveBeenCalledWith(false)
      const tabEvent = dispatchSpy.mock.calls.find(
        ([evt]) => evt instanceof Event && evt.type === 'hive:right-sidebar-tab'
      )
      expect(tabEvent).toBeDefined()
      expect((tabEvent![0] as CustomEvent).detail?.tab).toBe('changes')

      dispatchSpy.mockRestore()
    })

    it('f dispatches hive:right-sidebar-tab with files', () => {
      renderHook(() => useVimNavigation())

      const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

      fireKey('f')

      const tabEvent = dispatchSpy.mock.calls.find(
        ([evt]) => evt instanceof Event && evt.type === 'hive:right-sidebar-tab'
      )
      expect(tabEvent).toBeDefined()
      expect((tabEvent![0] as CustomEvent).detail?.tab).toBe('files')

      dispatchSpy.mockRestore()
    })

    it('d dispatches hive:right-sidebar-tab with diffs', () => {
      renderHook(() => useVimNavigation())

      const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

      fireKey('d')

      const tabEvent = dispatchSpy.mock.calls.find(
        ([evt]) => evt instanceof Event && evt.type === 'hive:right-sidebar-tab'
      )
      expect(tabEvent).toBeDefined()
      expect((tabEvent![0] as CustomEvent).detail?.tab).toBe('diffs')

      dispatchSpy.mockRestore()
    })

    it('s sets bottom panel tab to setup and opens right sidebar if collapsed', () => {
      layoutState.rightSidebarCollapsed = true
      renderHook(() => useVimNavigation())

      fireKey('s')

      expect(mockSetBottomPanelTab).toHaveBeenCalledWith('setup')
      expect(mockSetRightSidebarCollapsed).toHaveBeenCalledWith(false)
    })

    it('r sets bottom panel tab to run and opens right sidebar', () => {
      layoutState.rightSidebarCollapsed = true
      renderHook(() => useVimNavigation())

      fireKey('r')

      expect(mockSetBottomPanelTab).toHaveBeenCalledWith('run')
      expect(mockSetRightSidebarCollapsed).toHaveBeenCalledWith(false)
    })

    it('t sets bottom panel tab to terminal and opens right sidebar', () => {
      layoutState.rightSidebarCollapsed = true
      renderHook(() => useVimNavigation())

      fireKey('t')

      expect(mockSetBottomPanelTab).toHaveBeenCalledWith('terminal')
      expect(mockSetRightSidebarCollapsed).toHaveBeenCalledWith(false)
    })
  })

  // =========================================================================
  // 3.3 — File tab navigation tests
  // =========================================================================
  describe('file tab navigation', () => {
    it('[ switches to previous file tab', () => {
      fileViewerState.openFiles = new Map([
        ['file1.ts', { type: 'file', path: 'file1.ts' }],
        ['file2.ts', { type: 'file', path: 'file2.ts' }],
        ['file3.ts', { type: 'file', path: 'file3.ts' }]
      ])
      fileViewerState.activeFilePath = 'file2.ts'
      renderHook(() => useVimNavigation())

      fireKey('[')

      expect(mockSetActiveFile).toHaveBeenCalledWith('file1.ts')
    })

    it('] switches to next file tab', () => {
      fileViewerState.openFiles = new Map([
        ['file1.ts', { type: 'file', path: 'file1.ts' }],
        ['file2.ts', { type: 'file', path: 'file2.ts' }],
        ['file3.ts', { type: 'file', path: 'file3.ts' }]
      ])
      fileViewerState.activeFilePath = 'file2.ts'
      renderHook(() => useVimNavigation())

      fireKey(']')

      expect(mockSetActiveFile).toHaveBeenCalledWith('file3.ts')
    })

    it('[ at first tab is clamped', () => {
      fileViewerState.openFiles = new Map([
        ['file1.ts', { type: 'file', path: 'file1.ts' }],
        ['file2.ts', { type: 'file', path: 'file2.ts' }]
      ])
      fileViewerState.activeFilePath = 'file1.ts'
      renderHook(() => useVimNavigation())

      fireKey('[')

      expect(mockSetActiveFile).not.toHaveBeenCalled()
    })

    it('] at last tab is clamped', () => {
      fileViewerState.openFiles = new Map([
        ['file1.ts', { type: 'file', path: 'file1.ts' }],
        ['file2.ts', { type: 'file', path: 'file2.ts' }]
      ])
      fileViewerState.activeFilePath = 'file2.ts'
      renderHook(() => useVimNavigation())

      fireKey(']')

      expect(mockSetActiveFile).not.toHaveBeenCalled()
    })

    it('with no open files, [ is a no-op', () => {
      fileViewerState.openFiles = new Map()
      fileViewerState.activeFilePath = null
      renderHook(() => useVimNavigation())

      fireKey('[')

      expect(mockSetActiveFile).not.toHaveBeenCalled()
    })

    it('with no open files, ] is a no-op', () => {
      fileViewerState.openFiles = new Map()
      fileViewerState.activeFilePath = null
      renderHook(() => useVimNavigation())

      fireKey(']')

      expect(mockSetActiveFile).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 4.1 — Hint dispatch tests
  // =========================================================================
  describe('hint dispatch', () => {
    it('uppercase A in idle mode calls enterPending(A)', () => {
      hintState.mode = 'idle'
      renderHook(() => useVimNavigation())

      fireKey('A')

      expect(mockEnterPending).toHaveBeenCalledWith('A')
    })

    it('second char a with pending A + hintMap has Aa calls dispatchHintAction', () => {
      hintState.mode = 'pending'
      hintState.pendingChar = 'A'
      hintState.hintMap = new Map([['w1', 'Aa']])
      renderHook(() => useVimNavigation())

      fireKey('a')

      expect(mockDispatchHintAction).toHaveBeenCalledWith('w1')
      expect(mockExitPending).toHaveBeenCalled()
    })

    it('second char matching session hint calls setActiveSession + setActiveFile(null) + scrollIntoView', () => {
      vi.useFakeTimers()
      const tab = document.createElement('div')
      tab.setAttribute('data-testid', 'session-tab-sess-123')
      tab.scrollIntoView = vi.fn()
      document.body.appendChild(tab)

      try {
        hintState.mode = 'pending'
        hintState.pendingChar = 'S'
        hintState.sessionHintTargetMap = new Map([['Sa', 'sess-123']])

        renderHook(() => useVimNavigation())

        fireKey('a')

        expect(mockSetActiveSession).toHaveBeenCalledWith('sess-123')
        expect(mockSetActiveFile).toHaveBeenCalledWith(null)
        expect(mockExitPending).toHaveBeenCalled()

        vi.advanceTimersByTime(50)

        expect(tab.scrollIntoView).toHaveBeenCalledWith({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest'
        })
      } finally {
        tab.remove()
        vi.useRealTimers()
      }
    })

    it('second uppercase letter restarts pending with new char', () => {
      hintState.mode = 'pending'
      hintState.pendingChar = 'A'
      renderHook(() => useVimNavigation())

      fireKey('B')

      expect(mockEnterPending).toHaveBeenCalledWith('B')
      expect(mockExitPending).not.toHaveBeenCalled()
    })

    it('I in pending mode restarts pending instead of entering insert mode', () => {
      hintState.mode = 'pending'
      hintState.pendingChar = 'A'
      renderHook(() => useVimNavigation())

      fireKey('I')

      expect(mockEnterPending).toHaveBeenCalledWith('I')
      expect(mockEnterInsertMode).not.toHaveBeenCalled()
      expect(mockExitPending).not.toHaveBeenCalled()
    })

    it('non-matching second char calls exitPending()', () => {
      hintState.mode = 'pending'
      hintState.pendingChar = 'A'
      hintState.hintMap = new Map([['w1', 'Ab']])
      hintState.sessionHintTargetMap = new Map()
      renderHook(() => useVimNavigation())

      fireKey('z')

      expect(mockExitPending).toHaveBeenCalled()
      expect(mockDispatchHintAction).not.toHaveBeenCalled()
    })

    it('project hint match (key starts with project:) calls toggleProjectExpanded via dispatchHintAction', () => {
      hintState.mode = 'pending'
      hintState.pendingChar = 'A'
      hintState.hintMap = new Map([['project:p1', 'Aa']])
      renderHook(() => useVimNavigation())

      fireKey('a')

      expect(mockDispatchHintAction).toHaveBeenCalledWith('project:p1')
      expect(mockExitPending).toHaveBeenCalled()
    })
  })
})
