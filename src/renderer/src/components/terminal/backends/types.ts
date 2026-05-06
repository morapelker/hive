/**
 * Terminal backend abstraction layer.
 * Allows switching between xterm.js (cross-platform) and native Ghostty (macOS).
 */

export type TerminalBackendType = 'xterm' | 'ghostty'

export interface TerminalOpts {
  terminalId: string
  cwd: string
  fontFamily?: string
  fontSize?: number
  cursorStyle?: 'block' | 'bar' | 'underline'
  scrollback?: number
  theme?: Record<string, string>
  shell?: string
  /**
   * Whether the terminal is visible at the moment of mount.
   *
   * Critical for Ghostty: the native NSView is positioned exclusively from JS
   * via setFrame IPC. When the host (TerminalView) recreates the backend
   * — e.g. after `cwd` change, font-size change, backend setting change, or
   * React StrictMode double-mount — the visibility useEffect does NOT re-fire
   * unless `effectiveVisible` itself changes. If the panel is already
   * collapsed at recreation time and we default `this.visible = true`,
   * ensureSurface() will run the on-screen syncFrame branch and the NSView
   * will be positioned at the (still-measurable) container's rect — which
   * during a collapse CSS transition is a shrinking on-screen rect that no
   * later setVisible call can move. Pass the current `effectiveVisible` so
   * mount() seeds the backend's visible flag correctly.
   *
   * Defaults to `true` for back-compat; the xterm backend ignores it.
   */
  initialVisible?: boolean
}

/**
 * Callbacks the backend uses to communicate state changes to the host component.
 */
export interface TerminalBackendCallbacks {
  onStatusChange: (status: 'creating' | 'running' | 'exited', exitCode?: number) => void
  onTitleChange?: (title: string) => void
  onBell?: () => void
}

/**
 * Abstraction over different terminal rendering backends.
 * Both xterm.js and Ghostty implement this interface.
 */
export interface TerminalBackend {
  /** The type of this backend */
  readonly type: TerminalBackendType

  /** Mount the terminal into the given container element */
  mount(container: HTMLDivElement, opts: TerminalOpts, callbacks: TerminalBackendCallbacks): void

  /** Write data to the terminal (xterm only — Ghostty handles its own I/O) */
  write?(data: string): void

  /** Resize the terminal grid */
  resize(cols: number, rows: number): void

  /** Focus the terminal */
  focus(): void

  /** Clear the terminal scrollback */
  clear(): void

  /** Update the terminal theme at runtime (re-reads CSS variables) */
  updateTheme?(): void

  /** Toggle backend visibility while keeping session state alive */
  setVisible?(visible: boolean): void

  /** Search within terminal output */
  searchOpen?(): void
  searchClose?(): void
  searchNext?(query: string): void
  searchPrevious?(query: string): void

  /** Get whether the backend supports search */
  readonly supportsSearch: boolean

  /** Dispose of the terminal and clean up all resources */
  dispose(): void
}
