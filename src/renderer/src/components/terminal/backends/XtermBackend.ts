import { Terminal, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import type { TerminalBackend, TerminalOpts, TerminalBackendCallbacks } from './types'

/** Default Catppuccin Mocha theme used when no Ghostty config is found */
const DEFAULT_TERMINAL_THEME: ITheme = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b7066',
  selectionForeground: '#cdd6f4',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8'
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
    const accent = getCSSVar('accent')
    if (accent) theme.selectionBackground = accent
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
  if (e.metaKey && e.key === 'p') return true
  if (e.metaKey && e.shiftKey && e.key === 'P') return true
  if (e.metaKey && (e.key === '[' || e.key === ']')) return true

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
  private worktreeId: string = ''
  private ghosttyConfig: GhosttyTerminalConfig = {}

  /** Callback for the host to wire Cmd+F search toggling */
  onSearchToggle?: () => void
  /** Callback for the host to wire Cmd+K clear */
  onClearRequest?: () => void

  mount(container: HTMLDivElement, opts: TerminalOpts, callbacks: TerminalBackendCallbacks): void {
    this.worktreeId = opts.worktreeId
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
      fontFamily: opts.fontFamily || 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
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
          navigator.clipboard.writeText(terminal.getSelection())
          terminal.clearSelection()
          return false
        }
        return true
      }

      // Cmd+V — paste
      if (e.metaKey && e.key === 'v' && !e.shiftKey && e.type === 'keydown') {
        navigator.clipboard.readText().then((text) => {
          window.terminalOps.write(this.worktreeId, text)
        })
        return false
      }

      // Cmd+Shift+C — always copy
      if (e.metaKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
        if (terminal.hasSelection()) {
          navigator.clipboard.writeText(terminal.getSelection())
          terminal.clearSelection()
        }
        return false
      }

      // Cmd+Shift+V — always paste
      if (e.metaKey && e.shiftKey && e.key === 'V' && e.type === 'keydown') {
        navigator.clipboard.readText().then((text) => {
          window.terminalOps.write(this.worktreeId, text)
        })
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
      window.projectOps.openPath(uri)
    })
    terminal.loadAddon(webLinksAddon)

    terminal.open(container)

    // Try WebGL renderer, fall back to canvas
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon.dispose()
      })
      terminal.loadAddon(webglAddon)
    } catch {
      // WebGL not available, canvas renderer is the default
    }

    try {
      fitAddon.fit()
    } catch {
      // Container might not be visible yet
    }

    this.terminal = terminal
    this.fitAddon = fitAddon

    // Wire user input -> PTY
    this.inputDisposable = terminal.onData((data) => {
      window.terminalOps.write(this.worktreeId, data)
    })

    // Wire PTY output -> terminal display
    this.removeDataListener = window.terminalOps.onData(this.worktreeId, (data) => {
      terminal.write(data)
    })

    // Wire PTY exit -> status change
    this.removeExitListener = window.terminalOps.onExit(this.worktreeId, (code) => {
      terminal.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`)
      callbacks.onStatusChange('exited', code)
    })

    // Create the PTY
    callbacks.onStatusChange('creating')
    window.terminalOps.create(this.worktreeId, opts.cwd, opts.shell).then((result) => {
      if (result.success) {
        callbacks.onStatusChange('running')

        // Immediately sync PTY size with xterm.js's actual dimensions.
        // The PTY is created with default 80×24, but xterm.js was already fit
        // to the container (which may be much wider/taller). The ResizeObserver
        // initial callback likely fired BEFORE the PTY existed, so its resize
        // was silently dropped. Without this, zsh uses 80-col cursor positioning
        // while xterm.js renders at the actual width, causing visual mismatches
        // (e.g. auto-suggest redraws writing text at wrong positions).
        try {
          if (this.fitAddon) {
            this.fitAddon.fit()
            const dims = this.fitAddon.proposeDimensions()
            if (dims) {
              window.terminalOps.resize(this.worktreeId, dims.cols, dims.rows)
            }
          }
        } catch {
          // Ignore fit errors during setup
        }
      } else {
        terminal.write(`\x1b[31mFailed to create terminal: ${result.error}\x1b[0m\r\n`)
        callbacks.onStatusChange('exited')
      }
    })

    // ResizeObserver for auto-fit
    this.resizeObserver = new ResizeObserver(() => {
      try {
        if (this.fitAddon && container.offsetWidth) {
          this.fitAddon.fit()
          const dims = this.fitAddon.proposeDimensions()
          if (dims) {
            window.terminalOps.resize(this.worktreeId, dims.cols, dims.rows)
          }
        }
      } catch {
        // Ignore resize errors during teardown
      }
    })
    this.resizeObserver.observe(container)
  }

  write(data: string): void {
    this.terminal?.write(data)
  }

  resize(cols: number, rows: number): void {
    window.terminalOps.resize(this.worktreeId, cols, rows)
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

  /** Re-fit after visibility change */
  fit(): void {
    try {
      this.fitAddon?.fit()
      const dims = this.fitAddon?.proposeDimensions()
      if (dims) {
        window.terminalOps.resize(this.worktreeId, dims.cols, dims.rows)
      }
    } catch {
      // Ignore fit errors
    }
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
    this.resizeObserver?.disconnect()
    this.inputDisposable?.dispose()
    this.removeDataListener?.()
    this.removeExitListener?.()
    this.searchAddon = null
    this.terminal?.dispose()
    this.terminal = null
    this.fitAddon = null
    this.resizeObserver = null
    this.removeDataListener = null
    this.removeExitListener = null
    this.inputDisposable = null
  }
}
