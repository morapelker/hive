import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef, useState } from 'react'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useTerminalTabStore } from '@/stores/useTerminalTabStore'
import { useSettingsStore, type EmbeddedTerminalBackend } from '@/stores/useSettingsStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useThemeStore } from '@/stores/useThemeStore'
import { TerminalToolbar } from './TerminalToolbar'
import { XtermBackend } from './backends/XtermBackend'
import { GhosttyBackend } from './backends/GhosttyBackend'
import type { TerminalBackend as ITerminalBackend, TerminalBackendType } from './backends/types'
import '@xterm/xterm/css/xterm.css'
import '@/styles/xterm.css'

interface TerminalViewProps {
  terminalId: string
  cwd: string
  isVisible?: boolean
}

/** Imperative handle exposed to parent (TerminalManager) */
export interface TerminalViewHandle {
  fit: () => void
  focus: () => void
  clear: () => void
}

/**
 * Create the appropriate backend instance based on the selected type.
 */
function createBackend(type: TerminalBackendType): ITerminalBackend {
  if (type === 'ghostty') {
    return new GhosttyBackend()
  }
  return new XtermBackend()
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  { terminalId, cwd, isVisible = true },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const backendRef = useRef<ITerminalBackend | null>(null)
  const initializedRef = useRef<string | null>(null)
  /** Track which backend type is currently mounted */
  const activeBackendTypeRef = useRef<TerminalBackendType | null>(null)

  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [terminalStatus, setTerminalStatus] = useState<'creating' | 'running' | 'exited'>(
    'creating'
  )
  const [exitCode, setExitCode] = useState<number | undefined>(undefined)

  const restartTerminal = useTerminalStore((s) => s.restartTerminal)
  const destroyTerminal = useTerminalStore((s) => s.destroyTerminal)
  const themeId = useThemeStore((s) => s.themeId)
  const embeddedTerminalBackend = useSettingsStore(
    (s) => s.embeddedTerminalBackend
  ) as EmbeddedTerminalBackend
  const ghosttyFontSize = useSettingsStore((s) => s.ghosttyFontSize)
  const ghosttyOverlaySuppressed = useLayoutStore((s) => s.ghosttyOverlaySuppressed)

  const effectiveVisible = isVisible && !ghosttyOverlaySuppressed

  // Expose imperative methods to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      fit: () => {
        const backend = backendRef.current
        if (backend && backend.type === 'xterm') {
          ;(backend as XtermBackend).fit()
        }
      },
      focus: () => {
        backendRef.current?.focus()
      },
      clear: () => {
        backendRef.current?.clear()
      }
    }),
    []
  )

  // React to app theme changes — update the terminal's theme in real-time
  useEffect(() => {
    if (!backendRef.current) return

    const timer = setTimeout(() => {
      backendRef.current?.updateTheme?.()
    }, 50)
    return () => clearTimeout(timer)
  }, [themeId])

  // Re-fit and focus when becoming visible.
  // Note: GhosttyBackend.setVisible(true) already restores macOS first responder
  // directly; the focus() call below is a belt-and-suspenders backup for Ghostty
  // and the primary focus path for xterm. The xterm fit() requires the delayed
  // call because layout dimensions need a frame to settle.
  useEffect(() => {
    if (!backendRef.current) return

    backendRef.current.setVisible?.(effectiveVisible)

    if (!effectiveVisible) return

    const timer = setTimeout(() => {
      const backend = backendRef.current
      if (backend && backend.type === 'xterm') {
        ;(backend as XtermBackend).fit()
      }
      backend?.focus()
    }, 50)
    return () => clearTimeout(timer)
  }, [effectiveVisible])

  // Paste fallback: the Cmd+V menu accelerator intercepts the keystroke at the
  // macOS application-menu level before it reaches any view. The menu handler
  // uses a three-tier routing strategy:
  //   Tier 1: Ghostty surface has macOS first responder → direct native paste
  //   Tier 2: Neither Ghostty nor web content has focus (stale focus state) →
  //           sends 'edit:paste' IPC here so we can route to the active backend
  //   Tier 3: Web content has focus → webContents.paste() (xterm, inputs, etc.)
  // This listener handles Tier 2 — it fires when the native focus detection
  // failed but the terminal is still the intended paste target.
  // Note: 'edit:paste' is an IPC broadcast — all registered listeners receive it.
  // Only one TerminalView should have effectiveVisible=true at a time (enforced
  // by TerminalManager's single-active invariant), so only one listener fires.
  useEffect(() => {
    if (!effectiveVisible) return
    if (!window.systemOps?.onEditPaste) return

    const cleanup = window.systemOps.onEditPaste((text) => {
      if (activeBackendTypeRef.current === 'ghostty') {
        window.terminalOps.ghosttyPasteText(terminalId, text)
      } else if (activeBackendTypeRef.current === 'xterm') {
        window.terminalOps.write(terminalId, text)
      }
    })

    return cleanup
    // embeddedTerminalBackend in deps ensures re-evaluation when the user switches backends,
    // since activeBackendTypeRef is a ref and doesn't trigger re-renders on its own.
  }, [effectiveVisible, terminalId, embeddedTerminalBackend])

  // Search helpers (only for xterm backend)
  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query)
    backendRef.current?.searchNext?.(query)
  }, [])

  const handleSearchNext = useCallback(() => {
    backendRef.current?.searchNext?.(searchQuery)
  }, [searchQuery])

  const handleSearchPrev = useCallback(() => {
    backendRef.current?.searchPrevious?.(searchQuery)
  }, [searchQuery])

  const handleSearchClose = useCallback(() => {
    setSearchVisible(false)
    setSearchQuery('')
    backendRef.current?.searchClose?.()
    backendRef.current?.focus()
  }, [])

  const handleToggleSearch = useCallback(() => {
    setSearchVisible((prev) => !prev)
    if (searchVisible) {
      setSearchQuery('')
      backendRef.current?.searchClose?.()
      backendRef.current?.focus()
    }
  }, [searchVisible])

  /**
   * Set up the terminal with the given backend type.
   */
  const setupTerminal = useCallback(
    async (backendType: TerminalBackendType) => {
      const container = containerRef.current
      if (!container) return

      // Prevent re-initializing for the same terminal+backend combo
      if (initializedRef.current === terminalId && activeBackendTypeRef.current === backendType) {
        return
      }

      // Clean up any previous backend
      if (backendRef.current) {
        backendRef.current.dispose()
        backendRef.current = null
      }

      // If switching backends on an existing terminal, destroy the old PTY
      if (initializedRef.current === terminalId && activeBackendTypeRef.current !== backendType) {
        await destroyTerminal(terminalId)
      }

      initializedRef.current = terminalId
      activeBackendTypeRef.current = backendType

      container.innerHTML = ''

      // Fetch Ghostty config for theming and shell preferences
      let config: GhosttyTerminalConfig = {}
      try {
        config = await window.terminalOps.getConfig()
      } catch {
        // Failed to fetch config, use defaults
      }

      const backend = createBackend(backendType)

      // Wire search toggle for xterm backend
      if (backend instanceof XtermBackend) {
        backend.onSearchToggle = () => setSearchVisible(true)
      }

      backend.mount(
        container,
        {
          terminalId,
          cwd,
          fontFamily: config.fontFamily,
          fontSize: config.fontSize,
          cursorStyle: config.cursorStyle,
          scrollback: config.scrollbackLimit,
          shell: config.shell
        },
        {
          onStatusChange: (status, code) => {
            setTerminalStatus(status)
            if (code !== undefined) setExitCode(code)
            useTerminalTabStore.getState().setTabStatus(terminalId, status, code)
          }
        }
      )

      backendRef.current = backend
    },
    [terminalId, cwd, destroyTerminal]
  )

  // Handle restart — destroy old PTY and re-create terminal
  const handleRestart = useCallback(async () => {
    if (backendRef.current) {
      backendRef.current.dispose()
      backendRef.current = null
    }
    initializedRef.current = null
    activeBackendTypeRef.current = null
    setTerminalStatus('creating')
    setExitCode(undefined)

    // Get the current config for shell preference
    let shell: string | undefined
    try {
      const config = await window.terminalOps.getConfig()
      shell = config.shell
    } catch {
      // Use default shell
    }

    await restartTerminal(terminalId, cwd, shell)
    setupTerminal(embeddedTerminalBackend || 'xterm')
  }, [terminalId, cwd, restartTerminal, setupTerminal, embeddedTerminalBackend])

  // Initialize terminal on mount, and re-create when backend setting changes
  useEffect(() => {
    setupTerminal(embeddedTerminalBackend || 'xterm')

    return () => {
      if (backendRef.current) {
        backendRef.current.dispose()
        backendRef.current = null
      }
      initializedRef.current = null
      activeBackendTypeRef.current = null
    }
  }, [setupTerminal, embeddedTerminalBackend])

  // Restart the Ghostty terminal when font size changes so the new size takes effect.
  // We track the previous value so the effect only fires on actual changes, not on mount.
  const prevGhosttyFontSizeRef = useRef(ghosttyFontSize)
  useEffect(() => {
    if (prevGhosttyFontSizeRef.current === ghosttyFontSize) return
    prevGhosttyFontSizeRef.current = ghosttyFontSize

    if (activeBackendTypeRef.current !== 'ghostty') return

    // Recreate the surface with the new font size
    const restart = async (): Promise<void> => {
      if (backendRef.current) {
        backendRef.current.dispose()
        backendRef.current = null
      }
      initializedRef.current = null
      activeBackendTypeRef.current = null
      setTerminalStatus('creating')
      setExitCode(undefined)

      await destroyTerminal(terminalId)
      await restartTerminal(terminalId, cwd)
      setupTerminal('ghostty')
    }
    restart()
  }, [ghosttyFontSize, terminalId, cwd, destroyTerminal, restartTerminal, setupTerminal])

  // Focus terminal on click
  const handleClick = useCallback(() => {
    backendRef.current?.focus()
  }, [])

  const isGhostty = activeBackendTypeRef.current === 'ghostty'

  return (
    <div className="flex flex-col h-full w-full" data-testid="terminal-view">
      <TerminalToolbar
        status={terminalStatus}
        exitCode={exitCode}
        searchVisible={searchVisible && !isGhostty}
        searchQuery={searchQuery}
        onToggleSearch={handleToggleSearch}
        onSearchChange={handleSearch}
        onSearchNext={handleSearchNext}
        onSearchPrev={handleSearchPrev}
        onSearchClose={handleSearchClose}
        onRestart={handleRestart}
        onClear={() => backendRef.current?.clear()}
        backendType={activeBackendTypeRef.current || 'xterm'}
      />
      <div
        ref={containerRef}
        className="terminal-view-container flex-1 min-h-0"
        onClick={handleClick}
        data-testid="terminal-view-container"
      />
    </div>
  )
})
