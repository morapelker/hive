import { Terminal, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import type { TerminalBackend, TerminalOpts, TerminalBackendCallbacks } from './types'
import { DEFAULT_XTERM_FONT_STACK } from './terminal-fonts'
import { projectApi } from '@/api/project-api'
import { terminalApi } from '@/api/terminal-api'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { copyTextToClipboard } from '@/lib/clipboard'
import type { GhosttyTerminalConfig } from '@shared/types/terminal'

/** Default neutral theme (Ghostty default-style dark palette) used when no
    Ghostty config is found — background/foreground get overridden by app tokens */
const DEFAULT_TERMINAL_THEME: ITheme = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  cursor: '#a1a1a1',
  selectionBackground: '#7373734d',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea'
}

/** ANSI color index to xterm.js theme key mapping (0-15) */
const PALETTE_KEYS: (keyof ITheme)[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

/**
 * Resolve a CSS custom property from the :root element.
 */
function getCSSVar(name: string): string | undefined {
  const val = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()
  return val || undefined
}

/**
 * Map app theme + Ghostty config to an xterm.js ITheme.
 */
function buildTheme(ghosttyConfig: GhosttyTerminalConfig): ITheme {
  const theme: ITheme = { ...DEFAULT_TERMINAL_THEME }

  if (ghosttyConfig.palette) {
    for (const [indexStr, color] of Object.entries(ghosttyConfig.palette)) {
      const index = parseInt(indexStr, 10)
      if (index >= 0 && index < 16 && PALETTE_KEYS[index]) {
        ;(theme as Record<string, string>)[PALETTE_KEYS[index] as string] = String(color)
      }
    }
  }

  if (ghosttyConfig.foreground) theme.foreground = ghosttyConfig.foreground
  if (ghosttyConfig.cursorColor) theme.cursor = ghosttyConfig.cursorColor
  if (ghosttyConfig.selectionBackground)
    theme.selectionBackground = ghosttyConfig.selectionBackground
  if (ghosttyConfig.selectionForeground)
    theme.selectionForeground = ghosttyConfig.selectionForeground

  const bg = getCSSVar('background')
  const fg = getCSSVar('foreground')
  const mutedFg = getCSSVar('muted-foreground')

  if (bg) theme.background = bg
  if (fg && !ghosttyConfig.foreground) theme.foreground = fg
  if (!ghosttyConfig.selectionBackground) {
    // Translucent grey selection stays legible over any glyph color in both
    // light and dark themes — an opaque token (--accent) would mask text.
    theme.selectionBackground = '#7373734d'
  }
  if (mutedFg && !ghosttyConfig.cursorColor) {
    theme.cursor = mutedFg
  }

  return theme
}

/**
 * Shortcuts that should pass through to Electron / the app, not be consumed by xterm.
 */
function isAppShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey && !e.ctrlKey) return false

  if (e.metaKey && e.key === ',') return true
  if (e.metaKey && e.key === 'q') return true
  if (e.metaKey && e.key === 'w') return true
  if (e.metaKey && e.key === 'h' && !e.shiftKey) return true
  if (e.metaKey && e.key === 'm') return true
  if (e.metaKey && e.key === 'n') return true
  if (e.metaKey && e.key === 'o') return true
  if (e.metaKey && e.key === 'p') return true
  if (e.metaKey && e.shiftKey && e.key === 'P') return true
  if (e.metaKey && (e.key === '[' || e.key === ']')) return true

  // Ctrl+Tab / Ctrl+Shift+Tab — terminal tab cycling handled by the app
  if (e.ctrlKey && e.key === 'Tab') return true

  return false
}

/**
 * xterm.js-based terminal backend. Cross-platform.
 * Uses node-pty on the main process side for shell I/O.
 */
export class XtermBackend implements TerminalBackend {
  readonly type = 'xterm' as const
  readonly supportsSearch = true

  private terminal: Terminal | null = null
  private fitAddon: FitAddon | null = null
  private searchAddon: SearchAddon | null = null
  private resizeObserver: ResizeObserver | null = null
  private removeDataListener: (() => void) | null = null
  private removeExitListener: (() => void) | null = null
  private inputDisposable: { dispose: () => void } | null = null
  private container: HTMLDivElement | null = null
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private lastSyncedCols = 0
  private lastSyncedRows = 0
  private rendererKind: 'webgl' | 'dom' = 'dom'
  private terminalId: string = ''
  private lastReportedStatus: 'creating' | 'running' | 'exited' | null = null
  private shiftEnterAsNewline = false
  private ghosttyConfig: GhosttyTerminalConfig = {}

  /** Callback for the host to wire Cmd+F search toggling */
  onSearchToggle?: () => void
  /** Callback for the host to wire Cmd+K clear */
  onClearRequest?: () => void

  mount(container: HTMLDivElement, opts: TerminalOpts, callbacks: TerminalBackendCallbacks): void {
    this.terminalId = opts.terminalId
    this.shiftEnterAsNewline = opts.shiftEnterAsNewline ?? false
    this.container = container
    container.innerHTML = ''

    // Store config for theme rebuilding
    this.ghosttyConfig = {
      fontFamily: opts.fontFamily,
      fontSize: opts.fontSize,
      cursorStyle: opts.cursorStyle,
      scrollbackLimit: opts.scrollback,
      shell: opts.shell
    }

    const terminal = new Terminal({
      fontFamily: opts.fontFamily || DEFAULT_XTERM_FONT_STACK,
      fontSize: opts.fontSize || 13,
      lineHeight: 1.2,
      cursorStyle: opts.cursorStyle || 'block',
      cursorBlink: true,
      scrollback: opts.scrollback ?? 10000,
      allowProposedApi: true,
      theme: buildTheme(this.ghosttyConfig)
    })

    // Custom key event handler
    terminal.attachCustomKeyEventHandler((e) => {
      if (
        this.shiftEnterAsNewline &&
        e.type === 'keydown' &&
        (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        terminal.input('\x1b\r', true)
        return false
      }

      if (isAppShortcut(e)) return false

      if (e.metaKey && e.key === 'f' && e.type === 'keydown') {
        this.onSearchToggle?.()
        return false
      }

      if (e.metaKey && e.key === 'k' && e.type === 'keydown') {
        terminal.clear()
        this.onClearRequest?.()
        return false
      }

      // Cmd+C — copy if selection, otherwise SIGINT
      if (e.metaKey && e.key === 'c' && !e.shiftKey && e.type === 'keydown') {
        if (terminal.hasSelection()) {
          void copyTextToClipboard(terminal.getSelection())
          terminal.clearSelection()
          return false
        }
        return true
      }

      // Cmd+Shift+C — always copy
      if (e.metaKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
        if (terminal.hasSelection()) {
          void copyTextToClipboard(terminal.getSelection())
          terminal.clearSelection()
        }
        return false
      }

      // Cmd+Shift+V — always paste
      if (e.metaKey && e.shiftKey && e.key === 'V' && e.type === 'keydown') {
        navigator.clipboard
          .readText()
          .catch(() => projectApi.readFromClipboard())
          .then((text) => {
            if (text) terminalApi.write(this.terminalId, text)
          })
          .catch((err) => console.error('Terminal paste failed:', err))
        return false
      }

      return true
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    const searchAddon = new SearchAddon()
    terminal.loadAddon(searchAddon)
    this.searchAddon = searchAddon

    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      projectApi.openPath(uri).catch(console.error)
    })
    terminal.loadAddon(webLinksAddon)

    terminal.open(container)

    // Try WebGL renderer, fall back to xterm's DOM renderer
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon.dispose()
        this.rendererKind = 'dom'
        console.warn('[terminal-font] WebGL context lost, falling back to DOM renderer')
        terminalApi.logClientDiagnostics('xterm-renderer-fallback', {
          terminalId: this.terminalId,
          reason: 'context-loss'
        })
      })
      terminal.loadAddon(webglAddon)
      this.rendererKind = 'webgl'
    } catch (err) {
      // WebGL not available (GPU blocklist, VM, remote session) — xterm falls
      // back to its DOM renderer, which renders fonts noticeably differently.
      console.warn('[terminal-font] WebGL addon failed, falling back to DOM renderer', err)
      terminalApi.logClientDiagnostics('xterm-renderer-fallback', {
        terminalId: this.terminalId,
        reason: 'load-failed',
        error: err instanceof Error ? err.message : String(err)
      })
    }

    try {
      fitAddon.fit()
    } catch {
      // Container might not be visible yet
    }

    this.terminal = terminal
    this.fitAddon = fitAddon

    const reportStatus = (status: 'creating' | 'running' | 'exited', code?: number): void => {
      this.lastReportedStatus = status
      callbacks.onStatusChange(status, code)
    }

    // Wire user input -> PTY
    this.inputDisposable = terminal.onData((data) => {
      terminalApi.write(this.terminalId, data)
    })

    // Wire PTY output -> terminal display
    this.removeDataListener = terminalApi.onData(this.terminalId, (data) => {
      // Output only ever comes from a live PTY (the bridge drops its buffers
      // on exit, so nothing is delivered after `terminal:exit`). The PTY can
      // be respawned outside this backend's createTerminal path — followup
      // prompts and pending-message delivery funnel through
      // createClaudeCliTerminal in the main process — which reuses this
      // terminalId without any status callback. Data arriving after we
      // reported 'exited' therefore means a new live process: clear the
      // exited state (ended overlay, tab pill) or the UI stays greyed out
      // over a running session.
      if (this.lastReportedStatus === 'exited') {
        reportStatus('running')
      }
      terminal.write(data)
    })

    // Wire PTY exit -> status change
    this.removeExitListener = terminalApi.onExit(this.terminalId, (code) => {
      terminal.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`)
      reportStatus('exited', code)
    })

    // Create the PTY
    reportStatus('creating')
    const createTerminal = opts.createTerminal ?? terminalApi.create
    createTerminal(this.terminalId, opts.cwd, opts.shell)
      .then(unwrapEnvelope)
      .then((result) => {
        if (result.success) {
          reportStatus('running')

          // Immediately sync PTY size with xterm.js's actual dimensions.
          // The PTY is created with default 80×24, but xterm.js was already fit
          // to the container (which may be much wider/taller). The ResizeObserver
          // initial callback likely fired BEFORE the PTY existed, so its resize
          // was silently dropped. Without this, zsh uses 80-col cursor positioning
          // while xterm.js renders at the actual width, causing visual mismatches
          // (e.g. auto-suggest redraws writing text at wrong positions).
          // Must run immediately (not debounced) so the initial size is correct.
          this.syncSizeToPty()

          terminalApi.logClientDiagnostics('xterm-terminal-created', {
            terminalId: this.terminalId,
            renderer: this.rendererKind,
            cols: this.lastSyncedCols,
            rows: this.lastSyncedRows,
            fontFamily: terminal.options.fontFamily,
            fontSize: terminal.options.fontSize
          })
        } else {
          terminal.write(`\x1b[31mFailed to create terminal: ${result.error}\x1b[0m\r\n`)
          reportStatus('exited')
        }
      })

    // ResizeObserver for auto-fit. Debounced (trailing) so a storm of width
    // changes — e.g. when the single session view is reparented between the
    // main tab and the ticket modal, or during a modal open/close animation —
    // collapses into one fit + one PTY resize at the final settled width.
    // Without this, each intermediate width fires a resize whose SIGWINCH redraw
    // arrives slowly over the multi-hop transport, so xterm reflows stale content
    // at a width the PTY hasn't caught up to yet (garbled rendering).
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer)
      this.resizeDebounceTimer = setTimeout(() => {
        this.resizeDebounceTimer = null
        this.syncSizeToPty()
      }, 100)
    })
    this.resizeObserver.observe(container)
  }

  /**
   * Fit xterm.js to its container and, only if the resulting dimensions differ
   * from the last value we sent, push the new size to the PTY. The
   * changed-dimensions guard avoids spurious reflows/resizes when the container
   * is reparented between two equal-width targets or the observer fires at an
   * unchanged size.
   */
  private syncSizeToPty(): void {
    try {
      if (!this.fitAddon || !this.container?.offsetWidth) return
      this.fitAddon.fit()
      const dims = this.fitAddon.proposeDimensions()
      if (!dims) return
      if (dims.cols === this.lastSyncedCols && dims.rows === this.lastSyncedRows) return
      this.lastSyncedCols = dims.cols
      this.lastSyncedRows = dims.rows
      terminalApi.resize(this.terminalId, dims.cols, dims.rows).then(unwrapEnvelope)
    } catch {
      // Ignore fit/resize errors during setup or teardown
    }
  }

  setShiftEnterAsNewline(enabled: boolean): void {
    this.shiftEnterAsNewline = enabled
  }

  write(data: string): void {
    this.terminal?.write(data)
  }

  resize(cols: number, rows: number): void {
    terminalApi.resize(this.terminalId, cols, rows).then(unwrapEnvelope)
  }

  focus(): void {
    this.terminal?.focus()
  }

  clear(): void {
    this.terminal?.clear()
  }

  updateTheme(): void {
    if (this.terminal) {
      this.terminal.options.theme = buildTheme(this.ghosttyConfig)
    }
  }

  /**
   * Apply a new font size without recreating the terminal. xterm.js re-measures
   * cells when `options.fontSize` changes, so a re-fit is enough to push the
   * new grid size to the PTY. The last-synced guard is reset so the resize
   * goes out even if the grid happens to land on the same cols/rows.
   */
  setFontSize(size: number): void {
    if (!this.terminal) return
    if (this.terminal.options.fontSize === size) return
    this.ghosttyConfig.fontSize = size
    this.terminal.options.fontSize = size
    this.lastSyncedCols = 0
    this.lastSyncedRows = 0
    this.syncSizeToPty()
  }

  /** Re-fit after visibility change */
  fit(): void {
    this.syncSizeToPty()
  }

  searchOpen(): void {
    // Search is handled at UI level; addon is accessed here
  }

  searchClose(): void {
    this.searchAddon?.clearDecorations()
  }

  searchNext(query: string): void {
    if (this.searchAddon && query) {
      this.searchAddon.findNext(query, { regex: false, caseSensitive: false })
    }
  }

  searchPrevious(query: string): void {
    if (this.searchAddon && query) {
      this.searchAddon.findPrevious(query, { regex: false, caseSensitive: false })
    }
  }

  dispose(): void {
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer)
      this.resizeDebounceTimer = null
    }
    this.resizeObserver?.disconnect()
    this.inputDisposable?.dispose()
    this.removeDataListener?.()
    this.removeExitListener?.()
    this.searchAddon = null
    this.terminal?.dispose()
    this.terminal = null
    this.fitAddon = null
    this.container = null
    this.resizeObserver = null
    this.removeDataListener = null
    this.removeExitListener = null
    this.inputDisposable = null
  }
}
