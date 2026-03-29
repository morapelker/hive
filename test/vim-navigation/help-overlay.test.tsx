import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock stores with complex side effects (must be before component import)
// ---------------------------------------------------------------------------

const mockWorktreesByProject = new Map<
  string,
  Array<{ id: string; name: string; project_id: string }>
>()

vi.mock('@/stores/useWorktreeStore', () => {
  const useWorktreeStore = vi.fn(
    (selector: (s: { worktreesByProject: typeof mockWorktreesByProject }) => unknown) =>
      selector({ worktreesByProject: mockWorktreesByProject })
  )
  useWorktreeStore.getState = vi.fn(() => ({
    worktreesByProject: mockWorktreesByProject
  }))
  useWorktreeStore.subscribe = vi.fn(() => () => {})
  return { useWorktreeStore }
})

const mockSessionsByWorktree = new Map<
  string,
  Array<{ id: string; name: string | null }>
>()

vi.mock('@/stores/useSessionStore', () => {
  const useSessionStore = vi.fn(
    (selector: (s: { sessionsByWorktree: typeof mockSessionsByWorktree }) => unknown) =>
      selector({ sessionsByWorktree: mockSessionsByWorktree })
  )
  useSessionStore.getState = vi.fn(() => ({
    sessionsByWorktree: mockSessionsByWorktree
  }))
  useSessionStore.subscribe = vi.fn(() => () => {})
  return { useSessionStore }
})

const mockProjects: Array<{ id: string; name: string }> = []

vi.mock('@/stores/useProjectStore', () => {
  const useProjectStore = vi.fn(
    (selector: (s: { projects: typeof mockProjects }) => unknown) =>
      selector({ projects: mockProjects })
  )
  useProjectStore.getState = vi.fn(() => ({
    projects: mockProjects
  }))
  useProjectStore.subscribe = vi.fn(() => () => {})
  return { useProjectStore }
})

// ---------------------------------------------------------------------------
// Real stores (simple, no problematic side effects)
// ---------------------------------------------------------------------------

import { useVimModeStore } from '@/stores/useVimModeStore'
import { useHintStore } from '@/stores/useHintStore'
import type { HintTarget } from '@/lib/hint-utils'

// ---------------------------------------------------------------------------
// Import component under test AFTER mocks
// ---------------------------------------------------------------------------

import { HelpOverlay } from '@/components/ui/HelpOverlay'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStores(): void {
  useVimModeStore.setState({
    mode: 'normal',
    helpOverlayOpen: false
  })
  useHintStore.setState({
    hintMap: new Map(),
    hintTargetMap: new Map(),
    sessionHintMap: new Map(),
    sessionHintTargetMap: new Map(),
    mode: 'idle',
    pendingChar: null,
    filterActive: false,
    inputFocused: false
  })
  mockWorktreesByProject.clear()
  mockSessionsByWorktree.clear()
  mockProjects.length = 0
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HelpOverlay', () => {
  beforeEach(() => {
    resetStores()
  })

  afterEach(() => {
    cleanup()
  })

  // =========================================================================
  // Visibility
  // =========================================================================

  describe('visibility', () => {
    it('renders nothing when helpOverlayOpen is false', () => {
      useVimModeStore.setState({ helpOverlayOpen: false })

      const { container } = render(<HelpOverlay />)
      expect(container.innerHTML).toBe('')
    })

    it('renders content when helpOverlayOpen is true', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)
      expect(screen.getByTestId('help-overlay')).toBeInTheDocument()
    })
  })

  // =========================================================================
  // Mode pill
  // =========================================================================

  describe('mode pill', () => {
    it('shows NORMAL mode pill when in normal mode', () => {
      useVimModeStore.setState({ helpOverlayOpen: true, mode: 'normal' })

      render(<HelpOverlay />)
      expect(screen.getByText('NORMAL')).toBeInTheDocument()
    })

    it('shows INSERT mode pill when in insert mode', () => {
      useVimModeStore.setState({ helpOverlayOpen: true, mode: 'insert' })

      render(<HelpOverlay />)
      expect(screen.getByText('INSERT')).toBeInTheDocument()
    })
  })

  // =========================================================================
  // Static navigation keys
  // =========================================================================

  describe('static navigation keys', () => {
    it('displays j/k/h/l navigation keys', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)

      // Check that the vim nav keys section exists with expected keys
      const overlay = screen.getByTestId('help-overlay')
      expect(overlay.textContent).toContain('j')
      expect(overlay.textContent).toContain('k')
      expect(overlay.textContent).toContain('h')
      expect(overlay.textContent).toContain('l')
    })

    it('displays I key for filter mode', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)
      const overlay = screen.getByTestId('help-overlay')
      expect(overlay.textContent).toContain('I')
      expect(overlay.textContent).toContain('Filter')
    })

    it('displays Esc key', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)
      const overlay = screen.getByTestId('help-overlay')
      expect(overlay.textContent).toContain('Esc')
    })

    it('displays ? key for help toggle', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)
      const overlay = screen.getByTestId('help-overlay')
      expect(overlay.textContent).toContain('?')
    })
  })

  // =========================================================================
  // Panel mnemonics
  // =========================================================================

  describe('panel mnemonics', () => {
    it('displays panel shortcut keys c/f/d/s/r/t', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)
      const overlay = screen.getByTestId('help-overlay')

      // Right sidebar shortcuts
      expect(overlay.textContent).toContain('Changes')
      expect(overlay.textContent).toContain('Files')
      expect(overlay.textContent).toContain('Diffs')

      // Bottom panel shortcuts
      expect(overlay.textContent).toContain('Setup')
      expect(overlay.textContent).toContain('Run')
      expect(overlay.textContent).toContain('Terminal')
    })

    it('displays file tab navigation keys [ and ]', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)
      const overlay = screen.getByTestId('help-overlay')
      expect(overlay.textContent).toContain('[')
      expect(overlay.textContent).toContain(']')
    })

    it('highlights mnemonic letters in panel labels', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)

      // Each mnemonic label should have a highlighted first letter
      // e.g., <span class="text-primary font-bold">C</span><span>hanges</span>
      const highlightedLetters = screen.getByTestId('help-overlay')
        .querySelectorAll('.text-primary.font-bold')

      // Should have at least 6 highlighted mnemonics (C, F, D, S, R, T)
      expect(highlightedLetters.length).toBeGreaterThanOrEqual(6)

      const highlightedTexts = Array.from(highlightedLetters).map(
        (el) => el.textContent
      )
      expect(highlightedTexts).toContain('C')
      expect(highlightedTexts).toContain('F')
      expect(highlightedTexts).toContain('D')
      expect(highlightedTexts).toContain('S')
      expect(highlightedTexts).toContain('R')
      expect(highlightedTexts).toContain('T')
    })
  })

  // =========================================================================
  // Dynamic worktree hints
  // =========================================================================

  describe('dynamic worktree hints', () => {
    it('displays worktree hints from hintMap', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      // Set up mock worktree data
      mockWorktreesByProject.set('p1', [
        { id: 'w1', name: 'feature-auth', project_id: 'p1' },
        { id: 'w2', name: 'fix-bug-123', project_id: 'p1' }
      ])

      // Set up hint maps
      const hintMap = new Map<string, string>([
        ['w1', 'Aa'],
        ['w2', 'Ab']
      ])
      const hintTargetMap = new Map<string, HintTarget>([
        ['w1', { kind: 'worktree', worktreeId: 'w1', projectId: 'p1' }],
        ['w2', { kind: 'worktree', worktreeId: 'w2', projectId: 'p1' }]
      ])
      useHintStore.setState({ hintMap, hintTargetMap })

      render(<HelpOverlay />)
      const overlay = screen.getByTestId('help-overlay')

      // Should show hint codes and worktree names
      expect(overlay.textContent).toContain('Aa')
      expect(overlay.textContent).toContain('feature-auth')
      expect(overlay.textContent).toContain('Ab')
      expect(overlay.textContent).toContain('fix-bug-123')
    })

    it('shows empty state when no worktree hints exist', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)
      // Should still render the overlay without crashing
      expect(screen.getByTestId('help-overlay')).toBeInTheDocument()
    })
  })

  // =========================================================================
  // Dynamic session hints
  // =========================================================================

  describe('dynamic session hints', () => {
    it('displays session hints from sessionHintMap', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      // Set up mock session data
      mockSessionsByWorktree.set('w1', [
        { id: 's1', name: 'Implement login' },
        { id: 's2', name: 'Add tests' },
        { id: 's3', name: null }
      ])

      // Set up session hint maps
      const sessionHintMap = new Map<string, string>([
        ['s1', 'Sa'],
        ['s2', 'Sb'],
        ['s3', 'Sc']
      ])
      const sessionHintTargetMap = new Map<string, string>([
        ['Sa', 's1'],
        ['Sb', 's2'],
        ['Sc', 's3']
      ])
      useHintStore.setState({ sessionHintMap, sessionHintTargetMap })

      render(<HelpOverlay />)
      const overlay = screen.getByTestId('help-overlay')

      // Should show session hint codes and session names
      expect(overlay.textContent).toContain('Sa')
      expect(overlay.textContent).toContain('Implement login')
      expect(overlay.textContent).toContain('Sb')
      expect(overlay.textContent).toContain('Add tests')
      expect(overlay.textContent).toContain('Sc')
    })

    it('shows empty state when no session hints exist', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)
      // Should render without crashing
      expect(screen.getByTestId('help-overlay')).toBeInTheDocument()
    })
  })

  // =========================================================================
  // Backdrop click
  // =========================================================================

  describe('backdrop interaction', () => {
    it('closes overlay on backdrop click', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)
      const backdrop = screen.getByTestId('help-overlay-backdrop')
      fireEvent.click(backdrop)

      // After clicking backdrop, helpOverlayOpen should be false
      expect(useVimModeStore.getState().helpOverlayOpen).toBe(false)
    })
  })

  // =========================================================================
  // System shortcuts section
  // =========================================================================

  describe('system shortcuts', () => {
    it('displays system shortcuts from DEFAULT_SHORTCUTS', () => {
      useVimModeStore.setState({ helpOverlayOpen: true })

      render(<HelpOverlay />)
      const overlay = screen.getByTestId('help-overlay')

      // Should show some well-known shortcuts
      expect(overlay.textContent).toContain('New Session')
      expect(overlay.textContent).toContain('Command Palette')
    })
  })
})
