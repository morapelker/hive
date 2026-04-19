import { useEffect } from 'react'
import { useVimModeStore } from '@/stores/useVimModeStore'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useHintStore } from '@/stores/useHintStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { dispatchHintAction } from '@/lib/hint-utils'

const SIDEBAR_SCROLL_STEP = 80
const TABS_SCROLL_STEP = 150
const SCROLL_AFTER_NAVIGATE_DELAY = 50

function isInputElement(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  if ((el as HTMLElement).isContentEditable) return true
  return false
}

function isInsideRadixOverlay(el: Element | null): boolean {
  if (!el) return false
  if (el.closest('[data-radix-dialog-content]')) return true
  if (el.closest('[cmdk-root]')) return true
  return false
}

export function useVimNavigation(): void {
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)

  useEffect(() => {
    if (!vimModeEnabled) return

    // --- Scroll helpers ---

    function scrollSidebar(delta: number): void {
      const container = document.querySelector('[data-testid="sidebar-scroll-container"]')
      if (!container) return
      container.scrollBy({ top: delta * SIDEBAR_SCROLL_STEP, behavior: 'smooth' })
    }

    function scrollSessionTabs(delta: number): void {
      const container = document.querySelector('[data-testid="session-tabs-scroll-container"]')
      if (!container) return
      container.scrollBy({ left: delta * TABS_SCROLL_STEP, behavior: 'smooth' })
    }

    function navigateFileTab(delta: number): void {
      const { openFiles, activeFilePath, setActiveFile } = useFileViewerStore.getState()
      const keys = Array.from(openFiles.keys())
      if (keys.length === 0) return

      const currentIndex = keys.indexOf(activeFilePath || '')
      const newIndex = currentIndex + delta

      // Clamp — do nothing if already at boundary
      if (newIndex < 0 || newIndex >= keys.length) return

      setActiveFile(keys[newIndex])
    }

    // --- Plan FAB helper: click a plan action button by vim key ---

    function clickPlanFabButton(key: string): boolean {
      const keyToTestId: Record<string, string> = {
        m: 'plan-ready-implement-fab',
        a: 'plan-ready-handoff-fab',
        A: 'plan-ready-handoff-chevron',
        u: 'plan-ready-supercharge-fab',
        o: 'plan-ready-supercharge-local-fab',
        s: 'plan-ready-save-ticket-fab'
      }
      const testId = keyToTestId[key]
      if (!testId) return false
      const btn = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      if (!btn) return false
      const container = btn.parentElement
      if (!container || container.className.includes('pointer-events-none')) return false
      btn.click()
      return true
    }

    // --- Key handler ---

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const vim = useVimModeStore.getState()
      const { isOpen: commandPaletteOpen } = useCommandPaletteStore.getState()
      const hint = useHintStore.getState()

      if (vim.mode === 'insert' && event.key !== 'Escape') return
      if (document.querySelector('[data-radix-dialog-content]')) return
      if (commandPaletteOpen) return

      if (event.key === 'Escape') {
        if (hint.mode === 'pending') {
          hint.exitPending()
          event.preventDefault()
          return
        }
        if (vim.mode === 'insert') {
          vim.enterNormalMode()
          event.preventDefault()
          return
        }
        if (vim.helpOverlayOpen) {
          vim.setHelpOverlayOpen(false)
          event.preventDefault()
          return
        }
        return
      }

      // --- Hint dispatch: pending mode (second char) ---
      // Must come before I/? handlers so pending state is resolved first
      if (hint.mode === 'pending' && hint.pendingChar) {
        // Ignore bare modifier keys (Shift, Control, etc.) so the user can
        // release the first-char key and then press Shift+P / Shift+D.
        if (
          event.key === 'Shift' ||
          event.key === 'Control' ||
          event.key === 'Alt' ||
          event.key === 'Meta'
        ) {
          return
        }

        if (event.key === 'P' || event.key === 'p') {
          hint.setActionMode(hint.actionMode === 'pin' ? 'select' : 'pin')
          event.preventDefault()
          return
        }
        if (event.key === 'D' || event.key === 'd') {
          hint.setActionMode(hint.actionMode === 'archive' ? 'select' : 'archive')
          event.preventDefault()
          return
        }

        const isUppercase = /^[A-Z]$/.test(event.key)

        // Another uppercase → restart pending with the new char
        if (isUppercase) {
          hint.enterPending(event.key)
          event.preventDefault()
          return
        }

        const code = hint.pendingChar + event.key

        // Check worktree/project hintMap (value→key reverse lookup)
        for (const [key, value] of hint.hintMap.entries()) {
          if (value === code) {
            dispatchHintAction(key, hint.actionMode)
            hint.exitPending()
            event.preventDefault()
            return
          }
        }

        // Check session hints (code→sessionId direct lookup)
        const sessionId = hint.sessionHintTargetMap.get(code)
        if (sessionId) {
          if (hint.actionMode !== 'select') {
            hint.exitPending()
            event.preventDefault()
            return
          }
          useSessionStore.getState().setActiveSession(sessionId)
          useFileViewerStore.getState().setActiveFile(null)
          hint.exitPending()
          setTimeout(() => {
            const tab = document.querySelector(`[data-testid="session-tab-${sessionId}"]`)
            tab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          }, SCROLL_AFTER_NAVIGATE_DELAY)
          event.preventDefault()
          return
        }

        // No match → exit pending
        hint.exitPending()
        event.preventDefault()
        return
      }

      // --- Plan FAB shortcuts: activate plan action buttons ---
      if (
        event.key === 'm' ||
        event.key === 'u' ||
        event.key === 'o' ||
        event.key === 'a' ||
        event.key === 'A' ||
        event.key === 's'
      ) {
        if (clickPlanFabButton(event.key)) {
          event.preventDefault()
          return
        }
      }

      if (event.key === 'i' || event.key === 'I') {
        vim.enterInsertMode()
        const messageInput = document.querySelector<HTMLElement>('[data-testid="message-input"]')
        messageInput?.focus()
        event.preventDefault()
        return
      }

      if (event.key === '?') {
        vim.toggleHelpOverlay()
        event.preventDefault()
        return
      }

      // --- hjkl scroll: sidebar vertical ---
      if (event.key === 'j' || event.key === 'ArrowDown') {
        scrollSidebar(1)
        event.preventDefault()
        return
      }

      if (event.key === 'k' || event.key === 'ArrowUp') {
        scrollSidebar(-1)
        event.preventDefault()
        return
      }

      // --- hjkl scroll: session tabs horizontal ---
      if (event.key === 'l' || event.key === 'ArrowRight') {
        scrollSessionTabs(1)
        event.preventDefault()
        return
      }

      if (event.key === 'h' || event.key === 'ArrowLeft') {
        scrollSessionTabs(-1)
        event.preventDefault()
        return
      }

      // --- Panel shortcuts: right sidebar tabs ---
      if (event.key === 'c' || event.key === 'f' || event.key === 'd') {
        const layout = useLayoutStore.getState()
        if (layout.rightSidebarCollapsed) {
          layout.setRightSidebarCollapsed(false)
        }
        const tabMap: Record<string, string> = { c: 'changes', f: 'files', d: 'diffs' }
        window.dispatchEvent(
          new CustomEvent('hive:right-sidebar-tab', { detail: { tab: tabMap[event.key] } })
        )
        event.preventDefault()
        return
      }

      // --- Panel shortcuts: bottom panel tabs ---
      if (event.key === 's' || event.key === 'u') {
        const layout = useLayoutStore.getState()
        if (layout.rightSidebarCollapsed) {
          layout.setRightSidebarCollapsed(false)
        }
        const tabMap: Record<string, 'setup' | 'run'> = {
          s: 'setup',
          u: 'run'
        }
        layout.setBottomPanelTab(tabMap[event.key])
        event.preventDefault()
        return
      }

      // Terminal shortcut: respects terminalPosition setting
      if (event.key === 't') {
        const terminalPosition = useSettingsStore.getState().terminalPosition
        if (terminalPosition === 'bottom') {
          useLayoutStore.getState().toggleBottomTerminal()
        } else {
          const layout = useLayoutStore.getState()
          if (layout.rightSidebarCollapsed) {
            layout.setRightSidebarCollapsed(false)
          }
          layout.setBottomPanelTab('terminal')
        }
        event.preventDefault()
        return
      }

      // --- File tab navigation ---
      if (event.key === '[') {
        navigateFileTab(-1)
        event.preventDefault()
        return
      }

      if (event.key === ']') {
        navigateFileTab(1)
        event.preventDefault()
        return
      }

      // --- Header action shortcuts ---
      if (event.key === 'r') {
        const btn = document.querySelector<HTMLElement>('[data-testid="review-button"]')
        if (btn) {
          btn.click()
          event.preventDefault()
          return
        }
      }
      if (event.key === 'p') {
        const btn = document.querySelector<HTMLElement>('[data-testid="pr-button"]')
        if (btn) {
          btn.click()
          event.preventDefault()
          return
        }
      }
      if (event.key === 'm') {
        const btn = document.querySelector<HTMLElement>('[data-testid="pr-merge-button"]')
        if (btn) {
          btn.click()
          event.preventDefault()
          return
        }
      }
      if (event.key === 'a') {
        const btn = document.querySelector<HTMLElement>('[data-testid="pr-archive-button"]')
        if (btn) {
          btn.click()
          event.preventDefault()
          return
        }
      }

      // --- Hint dispatch: idle mode → uppercase starts pending ---
      if (hint.mode === 'idle' && /^[A-Z]$/.test(event.key)) {
        hint.enterPending(event.key)
        event.preventDefault()
        return
      }
    }

    const handleFocusIn = (event: FocusEvent): void => {
      const target = event.target as Element | null
      if (!target) return
      if (!isInputElement(target)) return
      if (isInsideRadixOverlay(target)) return
      useVimModeStore.getState().enterInsertMode()
    }

    const handleFocusOut = (event: FocusEvent): void => {
      const related = event.relatedTarget as Element | null
      if (related && isInputElement(related)) return
      const vim = useVimModeStore.getState()
      if (vim.mode !== 'insert') return
      vim.enterNormalMode()
    }

    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('focusin', handleFocusIn, true)
    document.addEventListener('focusout', handleFocusOut, true)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('focusin', handleFocusIn, true)
      document.removeEventListener('focusout', handleFocusOut, true)
    }
  }, [vimModeEnabled])
}
