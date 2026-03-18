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
            dispatchHintAction(key)
            hint.exitPending()
            event.preventDefault()
            return
          }
        }

        // Check session hints (code→sessionId direct lookup)
        const sessionId = hint.sessionHintTargetMap.get(code)
        if (sessionId) {
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

      if (event.key === 'i' || event.key === 'I') {
        vim.enterInsertMode()
        const messageInput = document.querySelector<HTMLElement>(
          '[data-testid="message-input"]'
        )
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
      if (event.key === 's' || event.key === 'r' || event.key === 't') {
        const layout = useLayoutStore.getState()
        if (layout.rightSidebarCollapsed) {
          layout.setRightSidebarCollapsed(false)
        }
        const tabMap: Record<string, 'setup' | 'run' | 'terminal'> = {
          s: 'setup',
          r: 'run',
          t: 'terminal'
        }
        layout.setBottomPanelTab(tabMap[event.key])
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
